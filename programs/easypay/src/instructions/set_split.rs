use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::EasypayError,
    events::SplitSet,
    state::{Asset, Recipient, Split},
};

#[derive(Accounts)]
pub struct SetSplit<'info> {
    /// The worker. Only their signature changes where their pay goes. Pays the rent the first time.
    #[account(mut)]
    pub employee: Signer<'info>,

    /// Created on the first save, overwritten on every later one.
    #[account(
        init_if_needed,
        payer = employee,
        space = 8 + Split::INIT_SPACE,
        seeds = [SPLIT_SEED, employee.key().as_ref()],
        bump
    )]
    pub split: Account<'info, Split>,

    pub system_program: Program<'info, System>,
}

// Checks the new split and stores it whole. Recipients: at most 3, distinct, not the worker, not the default key,
// each at least 1%. Recipients plus invest_pct at most 100, the worker's wallet gets the rest. `labels` is not checked.
pub fn handle_set_split(
    ctx: Context<SetSplit>,
    recipients: Vec<Recipient>,
    invest_pct: u8,
    invest_asset: Asset,
    claimer: Option<Pubkey>,
    labels: [u8; LABELS_LEN],
) -> Result<()> {
    let employee = ctx.accounts.employee.key();
    require!(
        recipients.len() <= MAX_RECIPIENTS,
        EasypayError::TooManyRecipients
    );
    for (i, r) in recipients.iter().enumerate() {
        let duplicate = recipients[..i].iter().any(|o| o.owner == r.owner);
        let bad = r.owner == employee || r.owner == Pubkey::default() || r.pct == 0 || duplicate;
        require!(!bad, EasypayError::BadRecipient);
    }
    let total: u32 = recipients.iter().map(|r| r.pct as u32).sum::<u32>() + invest_pct as u32;
    require!(total <= 100, EasypayError::SplitOver100);

    ctx.accounts.split.set_inner(Split {
        employee,
        claimer,
        invest_pct,
        invest_asset,
        recipients: recipients.clone(),
        bump: ctx.bumps.split,
        labels,
    });
    emit!(SplitSet {
        employee,
        recipients,
        invest_pct,
        invest_asset,
        claimer,
    });
    Ok(())
}
