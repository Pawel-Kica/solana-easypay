use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{constants::*, state::Exchange};

#[derive(Accounts)]
pub struct InitExchange<'info> {
    /// Anyone, once per chain. Pays the rent. The local app runs it on first load, the devnet deploy script
    /// right after deploy, so nobody else picks the mint first.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// One per program. A second init_exchange fails because this account already exists.
    #[account(init, payer = payer, space = 8 + Exchange::INIT_SPACE, seeds = [EXCHANGE_SEED], bump)]
    pub exchange: Box<Account<'info, Exchange>>,

    /// The only mint the exchange swaps from: Circle's devnet USDC.
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Where the USDC from swaps stays.
    #[account(
        init,
        payer = payer,
        associated_token::mint = usdc_mint,
        associated_token::authority = exchange,
        associated_token::token_program = token_program
    )]
    pub exchange_usdc: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = payer,
        seeds = [BTC_SEED],
        bump,
        mint::decimals = ASSET_DECIMALS,
        mint::authority = exchange,
        mint::token_program = token_program
    )]
    pub btc_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        seeds = [ETH_SEED],
        bump,
        mint::decimals = ASSET_DECIMALS,
        mint::authority = exchange,
        mint::token_program = token_program
    )]
    pub eth_mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// Stores the mints. The SOL reserve is topped up separately, by sending lamports to the exchange PDA.
pub fn handle_init_exchange(ctx: Context<InitExchange>) -> Result<()> {
    ctx.accounts.exchange.set_inner(Exchange {
        usdc_mint: ctx.accounts.usdc_mint.key(),
        btc_mint: ctx.accounts.btc_mint.key(),
        eth_mint: ctx.accounts.eth_mint.key(),
        bump: ctx.bumps.exchange,
    });
    Ok(())
}
