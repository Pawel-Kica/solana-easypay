use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::EasypayError,
    state::{Offer, Period, Pool},
};

#[derive(Accounts)]
#[instruction(employee: Pubkey)]
pub struct Propose<'info> {
    /// The pool's employer or the worker the offer is for, the handler checks. Pays the offer's rent and gets it
    /// back when the offer closes.
    #[account(mut)]
    pub proposer: Signer<'info>,

    /// The pool's employer. The same key as the proposer when the company proposes.
    pub employer: SystemAccount<'info>,

    /// The employer's pool: the seeds tie it to the employer.
    #[account(seeds = [POOL_SEED, employer.key().as_ref()], bump = pool.bump)]
    // Boxed, keeps the pool off the 4 KB stack (see create_pool).
    pub pool: Box<Account<'info, Pool>>,

    /// The address comes from the pool and the worker, so a second pending offer to the same worker
    /// fails because this account already exists.
    #[account(
        init,
        payer = proposer,
        space = 8 + Offer::INIT_SPACE,
        seeds = [OFFER_SEED, pool.key().as_ref(), employee.as_ref()],
        bump
    )]
    pub offer: Account<'info, Offer>,

    pub system_program: Program<'info, System>,
}

// Anchor already created the offer account. Here we check the terms and fill it in.
#[allow(clippy::too_many_arguments)]
pub fn handle_propose(
    ctx: Context<Propose>,
    employee: Pubkey,
    rate: u64,
    period: Period,
    weekdays_only: bool,
    start: i64,
    end: Option<i64>,
    title: String,
    notice: u16,
) -> Result<()> {
    require!(title.len() <= MAX_NAME_LEN, EasypayError::NameTooLong);
    require!(start % DAY == 0, EasypayError::StartNotMidnight);
    if let Some(end) = end {
        require!(end % DAY == 0 && end > start, EasypayError::BadEnd);
    }
    require!(
        !(weekdays_only && period == Period::Hour),
        EasypayError::WeekdaysHourly
    );
    let pool_period = ctx.accounts.pool.period().unwrap_or(period);
    require!(pool_period == period, EasypayError::PeriodMismatch);
    // Otherwise the employer would be both sides of the contract.
    let employer = ctx.accounts.employer.key();
    require_keys_neq!(employee, employer, EasypayError::OfferToSelf);
    let proposer = ctx.accounts.proposer.key();
    require!(
        proposer == employer || proposer == employee,
        EasypayError::NotAParty
    );

    *ctx.accounts.offer = Offer {
        pool: ctx.accounts.pool.key(),
        employee,
        proposer,
        rate,
        period,
        weekdays_only,
        start,
        end,
        bump: ctx.bumps.offer,
        title,
        notice,
    };
    Ok(())
}
