use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{constants::*, events::Deposited, state::Pool};

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub employer: Signer<'info>,

    /// The signer's own pool: the seeds tie it to the employer, has_one to the mint.
    #[account(
        seeds = [POOL_SEED, employer.key().as_ref()],
        bump = pool.bump,
        has_one = mint
    )]
    // Boxed, keeps the pool off the 4 KB stack (see create_pool).
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = pool,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// The employer's own USDC account. The money comes from here.
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

// Asks the token program to move `amount` from the employer to the vault. The employer signed
// this transaction, so the token program accepts them as the authority. transfer_checked also
// checks the mint and its decimals.
pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    let accounts = TransferChecked {
        from: ctx.accounts.employer_usdc.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.employer.to_account_info(),
    };
    let cpi = CpiContext::new(ctx.accounts.token_program.key(), accounts);
    transfer_checked(cpi, amount, ctx.accounts.mint.decimals)?;
    emit!(Deposited {
        pool: ctx.accounts.pool.key(),
        amount
    });
    Ok(())
}
