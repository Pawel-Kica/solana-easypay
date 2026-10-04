use anchor_lang::prelude::*;

use crate::state::{Asset, Period, Recipient};

// Events for later features: the employer history (BIK) and the income certificate read them from the
// transaction logs, where Anchor writes each one as "Program data: <base64>".

/// The employer moved `amount` base units into the pool's vault.
#[event]
pub struct Deposited {
    pub pool: Pubkey,
    pub amount: u64,
}

/// The employer took `amount` base units of unearned money back from the vault.
#[event]
pub struct Withdrew {
    pub pool: Pubkey,
    pub amount: u64,
}

/// An offer became a contract in slot `slot`, with the offer's terms.
#[event]
pub struct Accepted {
    pub pool: Pubkey,
    pub employee: Pubkey,
    pub slot: u8,
    pub rate: u64,
    pub period: Period,
    pub weekdays_only: bool,
    pub start: i64,
    pub end: Option<i64>,
    pub title: String,
    pub notice: u16,
}

/// The worker of slot `slot` claimed `amount` base units, their gross pay. The breakdown says where it went:
/// `to_worker` to their own USDC account, each `recipients` entry to that address, `invested` swapped into
/// `asset_amount` of `asset`. `fell_back` means the swap was skipped and that share went to the worker as USDC,
/// already counted in `to_worker`. Without a split all of it is `to_worker`.
#[event]
pub struct Claimed {
    pub pool: Pubkey,
    pub employee: Pubkey,
    pub slot: u8,
    pub amount: u64,
    pub to_worker: u64,
    pub recipients: Vec<RecipientPaid>,
    pub invested: u64,
    pub asset: Asset,
    pub asset_amount: u64,
    pub fell_back: bool,
}

/// One split address and the base units it got from a claim.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RecipientPaid {
    pub owner: Pubkey,
    pub amount: u64,
}

/// The worker saved a new split.
#[event]
pub struct SplitSet {
    pub employee: Pubkey,
    pub recipients: Vec<Recipient>,
    pub invest_pct: u8,
    pub invest_asset: Asset,
    pub claimer: Option<Pubkey>,
}

/// The contract in slot `slot` was ended. Pay stops at `end`, which can be in the future (notice).
#[event]
pub struct Ended {
    pub pool: Pubkey,
    pub employee: Pubkey,
    pub slot: u8,
    pub end: i64,
}
