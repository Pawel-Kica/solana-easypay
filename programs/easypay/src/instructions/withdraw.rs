use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{constants::*, error::EasypayError, events::Withdrew, state::Pool};

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub employer: Signer<'info>,

    /// The signer's own pool: the seeds tie it to the employer, has_one to the mint. mut for settle.
    #[account(
        mut,
        seeds = [POOL_SEED, employer.key().as_ref()],
        bump = pool.bump,
        has_one = mint
    )]
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

    /// The employer's own USDC account. The money goes here.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = employer,
        associated_token::token_program = token_program
    )]
    pub employer_usdc: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

// Settles, then pays `amount` back to the employer, at most the vault minus `locked`: what workers earned plus
// every contract's notice. This check is where the intermediary disappears: earned pay and the next N periods
// stay in the vault for the workers, so the employer can't leave them with nothing tomorrow.
pub fn handle_withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let vault = ctx.accounts.vault.amount;
    let pool = &mut ctx.accounts.pool;
    pool.settle(vault, now);
    let withdrawable = vault.saturating_sub(pool.locked(now));
    require!(amount <= withdrawable, EasypayError::MoreThanWithdrawable);

    // The pool PDA owns the vault and signs with its seeds, like in claim.
    let employer = pool.employer;
    let signer: &[&[&[u8]]] = &[&[POOL_SEED, employer.as_ref(), &[pool.bump]]];
    let accounts = TransferChecked {
        from: ctx.accounts.vault.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.employer_usdc.to_account_info(),
        authority: pool.to_account_info(),
    };
    let cpi = CpiContext::new_with_signer(ctx.accounts.token_program.key(), accounts, signer);
    transfer_checked(cpi, amount, ctx.accounts.mint.decimals)?;
    emit!(Withdrew {
        pool: pool.key(),
        amount
    });
    Ok(())
}
