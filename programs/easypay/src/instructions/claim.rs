use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token_interface::{
        mint_to, transfer_checked, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked,
    },
};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::{
    constants::*,
    error::EasypayError,
    events::{Claimed, RecipientPaid},
    state::{Asset, Exchange, Pool, Slot, Split},
};

#[derive(Accounts)]
pub struct Claim<'info> {
    /// Who sends the claim: the worker, or the auto-claim key the worker put in `split.claimer`. The handler
    /// checks. Pays the fee.
    pub signer: Signer<'info>,

    /// The worker of the slot. The handler checks the slot holds this key. Not a signer: auto-claim claims for them.
    pub employee: SystemAccount<'info>,

    /// Any pool. Account<Pool> already checks our program owns it and that it is a Pool,
    /// and only create_pool makes those, always at the employer's PDA.
    #[account(mut, has_one = mint)]
    // Boxed, keeps the pool off the 4 KB stack (see create_pool).
    pub pool: Box<Account<'info, Pool>>,

    /// The pool's vault. The money comes from here.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = pool,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// The worker's own USDC account. The app creates it in the same transaction if it is missing.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = employee,
        associated_token::token_program = token_program
    )]
    pub employee_usdc: InterfaceAccount<'info, TokenAccount>,

    /// The worker's Split PDA, read by the handler. Unchecked because it may not exist: a worker who never
    /// saved a split gets everything, as before splits existed.
    /// CHECK: the address is the worker's Split PDA, the handler reads it only if this program owns it.
    #[account(seeds = [SPLIT_SEED, employee.key().as_ref()], bump)]
    pub split: UncheckedAccount<'info>,

    // The exchange accounts for the invest share. All unchecked and validated in the handler: a wrong one must
    // fall back to USDC, not fail the claim. Passed on every claim, even without investing.
    /// CHECK: the exchange PDA, read only if this program owns it. Mutable: the SOL reserve is its lamports.
    #[account(mut, seeds = [EXCHANGE_SEED], bump)]
    pub exchange: UncheckedAccount<'info>,

    /// CHECK: the handler checks it is the exchange's associated token account for its USDC mint.
    #[account(mut)]
    pub exchange_usdc: UncheckedAccount<'info>,

    /// CHECK: the Pyth price account of the split's asset. The handler checks address, owner and age.
    pub price: UncheckedAccount<'info>,

    /// CHECK: the exchange's BTC or ETH mint, checked against the Exchange. None when investing in SOL.
    #[account(mut)]
    pub asset_mint: Option<UncheckedAccount<'info>>,

    /// CHECK: where the asset goes. SOL: the worker's wallet. BTC or ETH: the worker's associated token account
    /// for the asset mint, which the app creates in the same transaction. The handler checks both.
    #[account(mut)]
    pub employee_asset: UncheckedAccount<'info>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

// Signed by the worker or their split.claimer. Settles, then pays the worker earned minus claimed, up to the pool's funded_until. Fails with NothingToClaim
// when that is zero, so an empty claim never lands as a "Claimed 0 USDC" transaction.
// With a Split: each recipient gets amount * pct / 100 (rounded down) to the USDC account passed in the remaining
// accounts, in Split order. The invest share goes through the exchange (see `swap`), or to the worker as USDC
// when it can't swap (fell_back). The worker gets the rest, so rounding never loses a base unit.
pub fn handle_claim<'info>(ctx: Context<'info, Claim<'info>>, slot: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let employee = ctx.accounts.employee.key();
    let split = read_split(&ctx.accounts.split)?;
    // Only the worker, or the one key the worker picked for auto-claim. A stranger can't pick the swap moment.
    let signer = ctx.accounts.signer.key();
    require!(
        signer == employee || split.as_ref().and_then(|s| s.claimer) == Some(signer),
        EasypayError::NotAllowedToClaim
    );
    let pool = &mut ctx.accounts.pool;
    pool.settle(ctx.accounts.vault.amount, now);
    let funded_until = pool.funded_until;

    let contract = pool
        .slots
        .get_mut(slot as usize)
        .filter(|s| s.used && s.employee == employee)
        .ok_or(EasypayError::NotYourContract)?;
    let amount = contract.earned(funded_until) - contract.claimed;
    require!(amount > 0, EasypayError::NothingToClaim);
    contract.claimed += amount;
    // The last claim of an ended contract frees its slot for the next one.
    if contract.fully_paid() {
        *contract = Slot::default();
    }
    pool.paid_total += amount;

    let share = |pct: u8| (amount as u128 * pct as u128 / 100) as u64;

    // The vault belongs to the pool PDA. A PDA has no private key, so the program signs for it
    // with the PDA's seeds, and the token program accepts that as the vault owner's signature.
    let employer = pool.employer;
    let bump = pool.bump;
    let mint = ctx.accounts.mint.key();
    let token_program = ctx.accounts.token_program.key();
    let pay = |to: AccountInfo<'info>, value: u64| -> Result<()> {
        if value == 0 {
            return Ok(());
        }
        let signer: &[&[&[u8]]] = &[&[POOL_SEED, employer.as_ref(), &[bump]]];
        let accounts = TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to,
            authority: ctx.accounts.pool.to_account_info(),
        };
        let cpi = CpiContext::new_with_signer(token_program, accounts, signer);
        transfer_checked(cpi, value, ctx.accounts.mint.decimals)
    };

    let mut paid = Vec::new();
    let mut rest = amount;
    let (mut invest_asset, mut invested, mut asset_amount, mut fell_back) =
        (Asset::default(), 0, 0, false);
    if let Some(split) = &split {
        require!(
            ctx.remaining_accounts.len() >= split.recipients.len(),
            EasypayError::RecipientAccountMismatch
        );
        for (r, account) in split.recipients.iter().zip(ctx.remaining_accounts) {
            // The recipient's associated token account for the pool's mint. The token program then checks
            // it really holds that mint.
            let ata = get_associated_token_address_with_program_id(&r.owner, &mint, &token_program);
            require_keys_eq!(account.key(), ata, EasypayError::RecipientAccountMismatch);
            let value = share(r.pct);
            pay(account.clone(), value)?;
            paid.push(RecipientPaid {
                owner: r.owner,
                amount: value,
            });
            rest -= value;
        }
        invest_asset = split.invest_asset;
        let invest = share(split.invest_pct);
        if invest > 0 {
            match swap(ctx.accounts, invest_asset, invest, &pay)? {
                Some(units) => {
                    (invested, asset_amount) = (invest, units);
                    rest -= invest;
                }
                None => fell_back = true,
            }
        }
    }
    pay(ctx.accounts.employee_usdc.to_account_info(), rest)?;

    emit!(Claimed {
        pool: ctx.accounts.pool.key(),
        employee,
        slot,
        amount,
        to_worker: rest,
        recipients: paid,
        invested,
        asset: invest_asset,
        asset_amount,
        fell_back,
    });
    Ok(())
}

/// The worker's Split, or None if they never saved one. The account address is already checked as the PDA, so
/// an account there owned by this program can only be the worker's Split.
fn read_split(info: &AccountInfo) -> Result<Option<Split>> {
    if info.owner != &crate::ID || info.data_is_empty() {
        return Ok(None);
    }
    let data = info.try_borrow_data()?;
    Ok(Some(Split::try_deserialize(&mut &data[..])?))
}

/// Swaps `usdc` base units of the claim into `asset` through the exchange, at the Pyth price. Returns the asset
/// units the worker got, or None when the exchange can't swap: no exchange, the pool not in its USDC mint, a wrong
/// account, a price that is wrong, stale (over MAX_PRICE_AGE) or not above zero, or a SOL reserve too small.
/// Then the caller pays that share as USDC. `pay` moves USDC from the vault.
fn swap<'info>(
    accounts: &Claim<'info>,
    asset: Asset,
    usdc: u64,
    pay: &impl Fn(AccountInfo<'info>, u64) -> Result<()>,
) -> Result<Option<u64>> {
    let exchange_info = accounts.exchange.to_account_info();
    if exchange_info.owner != &crate::ID || exchange_info.data_is_empty() {
        return Ok(None);
    }
    let exchange = Exchange::try_deserialize(&mut &exchange_info.try_borrow_data()?[..])?;
    let token_program = accounts.token_program.key();
    let exchange_usdc = get_associated_token_address_with_program_id(
        &exchange_info.key(),
        &exchange.usdc_mint,
        &token_program,
    );
    if accounts.mint.key() != exchange.usdc_mint || accounts.exchange_usdc.key() != exchange_usdc {
        return Ok(None);
    }
    let Some(units) = price_of(&accounts.price, asset).and_then(|(price, expo)| {
        asset_units(usdc, accounts.mint.decimals, asset.decimals(), price, expo)
    }) else {
        return Ok(None);
    };

    let employee = accounts.employee.key();
    let to = accounts.employee_asset.to_account_info();
    if asset == Asset::Sol {
        // SOL comes from the lamports on the exchange PDA, above what keeps it rent exempt. This program owns
        // the PDA, so it can take lamports from it directly.
        let reserve = exchange_info
            .lamports()
            .saturating_sub(Rent::get()?.minimum_balance(exchange_info.data_len()));
        if to.key() != employee || reserve < units {
            return Ok(None);
        }
        pay(accounts.exchange_usdc.to_account_info(), usdc)?;
        **exchange_info.try_borrow_mut_lamports()? -= units;
        **to.try_borrow_mut_lamports()? += units;
        return Ok(Some(units));
    }

    // BTC and ETH: the exchange mints exactly what the price gives, so they never run out.
    let mint = if asset == Asset::Btc {
        exchange.btc_mint
    } else {
        exchange.eth_mint
    };
    let Some(mint_info) = accounts.asset_mint.as_ref().filter(|m| m.key() == mint) else {
        return Ok(None);
    };
    let ata = get_associated_token_address_with_program_id(&employee, &mint, &token_program);
    if to.key() != ata || to.data_is_empty() {
        return Ok(None);
    }
    pay(accounts.exchange_usdc.to_account_info(), usdc)?;
    let signer: &[&[&[u8]]] = &[&[EXCHANGE_SEED, &[exchange.bump]]];
    let accounts = MintTo {
        mint: mint_info.to_account_info(),
        to,
        authority: exchange_info,
    };
    mint_to(
        CpiContext::new_with_signer(token_program, accounts, signer),
        units,
    )?;
    Ok(Some(units))
}

/// The asset's USD price and its exponent from its Pyth push feed, or None if the account is not that feed, not
/// owned by the Pyth receiver, not fully verified or older than MAX_PRICE_AGE.
fn price_of(info: &AccountInfo, asset: Asset) -> Option<(i64, i32)> {
    if info.key() != asset.feed() || info.owner != &PYTH_RECEIVER {
        return None;
    }
    let data = info.try_borrow_data().ok()?;
    let update = PriceUpdateV2::try_deserialize(&mut &data[..]).ok()?;
    let clock = Clock::get().ok()?;
    let feed_id = update.price_message.feed_id;
    let price = update
        .get_price_no_older_than(&clock, MAX_PRICE_AGE, &feed_id)
        .ok()?;
    Some((price.price, price.exponent))
}

/// Asset base units for `usdc` base units at `price` * 10^`expo` USD per asset, rounded down, in u128:
/// usdc * 10^(asset_decimals - usdc_decimals) * 10^(-expo) / price. None for a price at or below zero, an
/// overflow, or a share too small to buy one base unit.
fn asset_units(
    usdc: u64,
    usdc_decimals: u8,
    asset_decimals: u8,
    price: i64,
    expo: i32,
) -> Option<u64> {
    if price <= 0 {
        return None;
    }
    // All the powers of ten in one exponent, then on whichever side of the fraction keeps it whole.
    let pow = asset_decimals as i32 - usdc_decimals as i32 - expo;
    let ten = |p: i32| 10u128.checked_pow(p.unsigned_abs());
    let (num, den) = if pow >= 0 {
        ((usdc as u128).checked_mul(ten(pow)?)?, price as u128)
    } else {
        (usdc as u128, (price as u128).checked_mul(ten(pow)?)?)
    };
    u64::try_from(num / den).ok().filter(|&units| units > 0)
}
