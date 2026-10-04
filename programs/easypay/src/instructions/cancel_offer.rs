use anchor_lang::prelude::*;

use crate::{error::EasypayError, state::Offer};

#[derive(Accounts)]
pub struct CancelOffer<'info> {
    /// Whoever proposed the offer. Gets its rent back.
    #[account(mut)]
    pub proposer: Signer<'info>,

    /// `has_one` lets only the proposer cancel. `close` deletes the offer and sends its rent to them.
    #[account(mut, has_one = proposer @ EasypayError::NotTheProposer, close = proposer)]
    pub offer: Account<'info, Offer>,
}

// The constraints above do all the work: Anchor closes the offer after the instruction.
pub fn handle_cancel_offer(_ctx: Context<CancelOffer>) -> Result<()> {
    Ok(())
}
