pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("BNUCb9cqqaxfVsNiRNofP2RVTjNn6XKnpcfRQWas8FYQ");

#[program]
pub mod easypay {
    use super::*;

    /// Creates the signer's pool and its empty vault for `mint`. One pool per account. `name` is the company
    /// name the app shows, at most 32 bytes and not verified.
    pub fn create_pool(ctx: Context<CreatePool>, name: String) -> Result<()> {
        crate::instructions::create_pool::handle_create_pool(ctx, name)
    }

    /// Moves `amount` (base units, USDC has 6 decimals) from the employer's wallet to the vault.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        crate::instructions::deposit::handle_deposit(ctx, amount)
    }

    /// Moves `amount` from the vault back to the employer: at most the vault minus `locked`, earned and unclaimed
    /// pay plus every contract's notice.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        crate::instructions::withdraw::handle_withdraw(ctx, amount)
    }

    /// The pool's employer offers `employee` a contract, or the worker asks for one: `rate` base units per
    /// `period` (a day or an hour) from `start`, a midnight UTC that can be in the past, up to `end`, the midnight
    /// after the last working day (None for open-ended). With `weekdays_only` (daily only) Saturday and Sunday
    /// UTC earn nothing. `title` says what the contract is for, at most 32 bytes, can be empty. `notice` is how
    /// many periods pay keeps running after the employer ends it, 0 allowed. Fails if the pool holds contracts
    /// with another period. Nothing binds until the other side accepts.
    #[allow(clippy::too_many_arguments)]
    pub fn propose(
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
        crate::instructions::propose::handle_propose(
            ctx,
            employee,
            rate,
            period,
            weekdays_only,
            start,
            end,
            title,
            notice,
        )
    }

    /// The side that did not propose signs the offer: it moves into a free pool slot and closes. The terms are
    /// the ones the signer saw, title and notice included, and accept fails if the offer no longer has them.
    /// Fails with PoolShort unless the vault covers earned pay plus every contract's notice.
    #[allow(clippy::too_many_arguments)]
    pub fn accept(
        ctx: Context<Accept>,
        rate: u64,
        period: Period,
        weekdays_only: bool,
        start: i64,
        end: Option<i64>,
        title: String,
        notice: u16,
    ) -> Result<()> {
        crate::instructions::accept::handle_accept(
            ctx,
            rate,
            period,
            weekdays_only,
            start,
            end,
            title,
            notice,
        )
    }

    /// Whoever proposed a pending offer withdraws it and gets the rent back.
    pub fn cancel_offer(ctx: Context<CancelOffer>) -> Result<()> {
        crate::instructions::cancel_offer::handle_cancel_offer(ctx)
    }

    /// The worker saves where their claims go: up to 3 `recipients` with a whole percent each, `invest_pct`
    /// swapped into `invest_asset`, the rest to their own wallet. `claimer` is the auto-claim server key or
    /// None. `labels` is the app's encrypted blob of recipient labels, stored as is. Creates the worker's Split or
    /// overwrites it.
    pub fn set_split(
        ctx: Context<SetSplit>,
        recipients: Vec<Recipient>,
        invest_pct: u8,
        invest_asset: Asset,
        claimer: Option<Pubkey>,
        labels: [u8; LABELS_LEN],
    ) -> Result<()> {
        crate::instructions::set_split::handle_set_split(
            ctx,
            recipients,
            invest_pct,
            invest_asset,
            claimer,
            labels,
        )
    }

    /// Creates the exchange that swaps the invest share of claims: its PDA, its USDC account and the test BTC and
    /// ETH mints. Anyone, once per chain. `usdc_mint` is the only mint it will swap from.
    pub fn init_exchange(ctx: Context<InitExchange>) -> Result<()> {
        crate::instructions::init_exchange::handle_init_exchange(ctx)
    }

    /// The worker of slot `slot` takes everything earned and not yet claimed from the vault, paid out by their
    /// Split if they have one: each recipient's USDC account comes in the remaining accounts, in Split order.
    /// The invest share is swapped through the exchange, or paid as USDC when it can't swap.
    pub fn claim<'info>(ctx: Context<'info, Claim<'info>>, slot: u8) -> Result<()> {
        crate::instructions::claim::handle_claim(ctx, slot)
    }

    /// The employer or the worker of slot `slot` ends the contract at `end`, a full period (midnight or full
    /// hour), or at the earliest allowed when None: the last full period plus the notice for the employer, the
    /// last full period for the worker. The unfinished day or hour is not paid, earned pay stays claimable.
    pub fn end_contract(ctx: Context<EndContract>, slot: u8, end: Option<i64>) -> Result<()> {
        crate::instructions::end_contract::handle_end_contract(ctx, slot, end)
    }
}
