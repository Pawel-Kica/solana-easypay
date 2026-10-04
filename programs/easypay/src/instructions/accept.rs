use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    constants::*,
    error::EasypayError,
    events::Accepted,
    state::{Offer, Period, Pool, Slot},
};

#[derive(Accounts)]
pub struct Accept<'info> {
    /// The side of the offer that did not propose it: the worker when the company proposed, the company when the
    /// worker did. The handler checks.
    pub signer: Signer<'info>,

    /// The pool's employer.
    pub employer: SystemAccount<'info>,

    /// The worker the offer is for. The offer's address comes from this key.
    pub employee: SystemAccount<'info>,

    /// Whoever proposed the offer. Paid its rent, which comes back here when the offer closes.
    #[account(mut)]
    pub proposer: SystemAccount<'info>,

    /// The seeds tie the pool to the employer above.
    #[account(
        mut,
        seeds = [POOL_SEED, employer.key().as_ref()],
        bump = pool.bump,
        has_one = mint
    )]
    // Boxed, keeps the pool off the 4 KB stack (see create_pool).
    pub pool: Box<Account<'info, Pool>>,

    /// The pool's vault, read to check the pool covers the new contract and every notice.
    #[account(
        associated_token::mint = mint,
        associated_token::authority = pool,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// `close` deletes the offer after the instruction and sends its rent back to the proposer.
    #[account(
        mut,
        seeds = [OFFER_SEED, pool.key().as_ref(), employee.key().as_ref()],
        bump = offer.bump,
        has_one = proposer,
        close = proposer
    )]
    pub offer: Account<'info, Offer>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

// Copies the offer's terms into the first free slot, checks the vault covers what is now locked, then settles.
// Anchor closes the offer afterwards.
#[allow(clippy::too_many_arguments)]
pub fn handle_accept(
    ctx: Context<Accept>,
    rate: u64,
    period: Period,
    weekdays_only: bool,
    start: i64,
    end: Option<i64>,
    title: String,
    notice: u16,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let offer = &ctx.accounts.offer;
    // The proposer can cancel and propose again at the same address with other terms, so the signer passes the
    // terms they saw. Without this a stale screen could accept a bigger rate or an earlier start.
    require!(
        (
            offer.rate,
            offer.period,
            offer.weekdays_only,
            offer.start,
            offer.end,
            &offer.title,
            offer.notice
        ) == (rate, period, weekdays_only, start, end, &title, notice),
        EasypayError::OfferChanged
    );
    // The proposer is the employer or the worker, so a signer that is one of them but not the proposer is the
    // other side. A stranger can never accept.
    let signer = ctx.accounts.signer.key();
    require!(
        signer != offer.proposer
            && (signer == ctx.accounts.employer.key() || signer == offer.employee),
        EasypayError::NotTheReceiver
    );
    let pool = &mut ctx.accounts.pool;
    // The pool may have taken a contract with another period since the offer was made.
    let pool_period = pool.period().unwrap_or(offer.period);
    require!(pool_period == offer.period, EasypayError::PeriodMismatch);
    let index = pool
        .slots
        .iter()
        .position(|slot| !slot.used)
        .ok_or(EasypayError::PoolFull)?;

    pool.slots[index] = Slot {
        used: true,
        employee: offer.employee,
        rate: offer.rate,
        period: offer.period,
        weekdays_only: offer.weekdays_only,
        start: offer.start,
        end: offer.end,
        claimed: 0,
        title: offer.title.clone(),
        notice: offer.notice,
    };

    // The vault must cover every contract's earned pay plus its notice, the new one included. That also covers
    // back pay from a past start, so settle below can't go dry and pay others less than they already claimed.
    let vault = ctx.accounts.vault.amount;
    require!(vault >= pool.locked(now), EasypayError::PoolShort);
    pool.settle(vault, now);
    pool.contracts_total += 1;

    emit!(Accepted {
        pool: pool.key(),
        employee: offer.employee,
        slot: index as u8,
        rate: offer.rate,
        period: offer.period,
        weekdays_only: offer.weekdays_only,
        start: offer.start,
        end: offer.end,
        title: offer.title.clone(),
        notice: offer.notice,
    });
    Ok(())
}
