use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::EasypayError,
    events::Ended,
    state::{Pool, Slot},
};

#[derive(Accounts)]
pub struct EndContract<'info> {
    /// The employer or the worker of the contract. The handler checks which.
    pub signer: Signer<'info>,

    /// The pool's employer. Listed so both sides find the transaction in their history.
    pub employer: SystemAccount<'info>,

    /// The contract's worker. The handler checks the slot holds this key.
    pub employee: SystemAccount<'info>,

    /// The seeds tie the pool to the employer above.
    #[account(mut, seeds = [POOL_SEED, employer.key().as_ref()], bump = pool.bump)]
    // Boxed, keeps the pool off the 4 KB stack (see create_pool).
    pub pool: Box<Account<'info, Pool>>,
}

// Ends the contract at `end`, or at the earliest allowed end when None. The earliest is the last full period
// (midnight, or full hour for an hourly contract) plus the notice when the employer ends it, plus nothing when the
// worker does, and never later than the current end: notice only shortens a contract. A later `end` must sit on a
// full period, and one after the current end keeps the current end. The unfinished day or hour is not paid.
// Earned pay stays claimable, and the slot is freed once nothing is left to claim.
// No settle needed: ending only lowers what is owed after the end, and funded_until is never later than now.
pub fn handle_end_contract(ctx: Context<EndContract>, slot: u8, end: Option<i64>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let signer = ctx.accounts.signer.key();
    let by_employer = signer == ctx.accounts.employer.key();
    require!(
        by_employer || signer == ctx.accounts.employee.key(),
        EasypayError::NotYourContract
    );

    let employee = ctx.accounts.employee.key();
    let contract = ctx
        .accounts
        .pool
        .slots
        .get_mut(slot as usize)
        .filter(|s| s.used && s.employee == employee)
        .ok_or(EasypayError::NotYourContract)?;
    let end = contract.end_at(end, by_employer, now)?;
    contract.end = Some(end);
    // A contract that has not started, or one claimed in full, frees its slot right away.
    if contract.fully_paid() {
        *contract = Slot::default();
    }

    emit!(Ended {
        pool: ctx.accounts.pool.key(),
        employee,
        slot,
        end
    });
    Ok(())
}
