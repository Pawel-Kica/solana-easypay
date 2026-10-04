use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::*,
    error::EasypayError,
    state::{Period, Pool, Slot},
};

#[derive(Accounts)]
pub struct CreatePool<'info> {
    /// Whoever signs becomes the employer and pays the rent. Any account can, a worker too.
    #[account(mut)]
    pub employer: Signer<'info>,

    /// The address comes from the employer's key, so every account has at most one pool.
    /// A second create_pool fails because this account already exists.
    #[account(
        init,
        payer = employer,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, employer.key().as_ref()],
        bump
    )]
    // Boxed (kept on the heap), so the pool never counts against the program's 4 KB stack.
    pub pool: Box<Account<'info, Pool>>,

    /// The vault: the pool PDA's token account for the mint.
    /// The pool PDA owns it, so only this program can move money out.
    #[account(
        init,
        payer = employer,
        associated_token::mint = mint,
        associated_token::authority = pool,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// Anchor already created both accounts from the constraints above. Here we only fill in the pool.
// With no contracts yet, everything is funded up to the last midnight.
pub fn handle_create_pool(ctx: Context<CreatePool>, name: String) -> Result<()> {
    require!(name.len() <= MAX_NAME_LEN, EasypayError::NameTooLong);
    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.pool.set_inner(Pool {
        employer: ctx.accounts.employer.key(),
        mint: ctx.accounts.mint.key(),
        bump: ctx.bumps.pool,
        funded_until: Period::Day.last_full(now),
        dry: false,
        slots: vec![Slot::default(); MAX_SLOTS],
        contracts_total: 0,
        paid_total: 0,
        ran_dry_count: 0,
        name,
    });
    Ok(())
}
