use anchor_lang::prelude::*;

use crate::constants::{
    ASSET_DECIMALS, BTC_USD_FEED, DAY, ETH_USD_FEED, HOUR, LABELS_LEN, MAX_END_AHEAD, MAX_NAME_LEN,
    MAX_RECIPIENTS, MAX_SLOTS, SOL_USD_FEED, WEEK,
};

/// One company pool per employer, at the PDA [b"pool", employer].
/// The money sits in the vault: the pool PDA's associated token account for `mint`.
/// Fields get added only when a feature needs them.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub employer: Pubkey,
    /// The token the pool pays in: Circle's devnet USDC (a test mint in mocha).
    pub mint: Pubkey,
    /// Stored PDA bump, so later instructions can sign as the pool without searching for it.
    pub bump: u8,
    /// Every contract is paid up to this moment, always a full hour. `settle` moves it forward.
    pub funded_until: i64,
    /// The last settle could not cover everything earned by the last full period.
    pub dry: bool,
    /// The pool's contracts, always MAX_SLOTS of them. `accept` fills the first free slot, so every instruction
    /// touches one account. A Vec, not an array: deserializing an array builds it on the 4 KB stack, which
    /// overflowed once the pool grew, while a Vec lives on the heap.
    #[max_len(MAX_SLOTS)]
    pub slots: Vec<Slot>,
    // Public history counters. The employer history (BIK) reads them later.
    /// Contracts ever accepted into this pool.
    pub contracts_total: u32,
    /// Base units ever paid out to workers by `claim`.
    pub paid_total: u64,
    /// Times a settle found the pool short after it had covered everything.
    pub ran_dry_count: u32,
    /// The company name, set in create_pool. Whatever the employer typed, nobody verifies it.
    #[max_len(MAX_NAME_LEN)]
    pub name: String,
}

impl Pool {
    /// What the pool owes its workers at `until`: earned minus claimed, summed over contracts. Settle keeps it
    /// covered. Mirrored in app/src/pay.ts.
    pub fn owed(&self, until: i64) -> u64 {
        self.slots
            .iter()
            .filter(|s| s.used)
            .map(|s| s.earned(until).saturating_sub(s.claimed))
            .sum()
    }

    /// What withdraw must leave in the vault at `now`: per contract, earned up to the last full period plus its
    /// notice (or its end, if sooner), minus claimed. Accept also needs the vault to cover it. Mirrored in
    /// app/src/pay.ts.
    pub fn locked(&self, now: i64) -> u64 {
        self.slots
            .iter()
            .filter(|s| s.used)
            .map(|s| s.earned(s.notice_end(now)).saturating_sub(s.claimed))
            .sum()
    }

    /// The period of the pool's contracts, None while it has none. A pool holds contracts of one period only:
    /// in a mixed pool a shortfall could pay a daily contract part of a day, and a refill would take it back.
    pub fn period(&self) -> Option<Period> {
        self.slots.iter().find(|s| s.used).map(|s| s.period)
    }

    /// Moves `funded_until` as far as the `vault` balance covers. If it covers everything earned by the last
    /// full period (midnight in a Day pool, full hour in an Hour pool), that moment. If not, the latest full hour
    /// it covers, the same for every contract, so the fastest claimer can't drain the pool. Runs at the start of
    /// withdraw and claim, and at the end of accept. Mirrored in app/src/pay.ts.
    pub fn settle(&mut self, vault: u64, now: i64) {
        let target = self.period().unwrap_or_default().last_full(now);
        if self.owed(target) <= vault {
            self.funded_until = target;
            self.dry = false;
            return;
        }
        // Binary search over full hours. `lo` always fits: owed(funded_until) <= vault after every instruction.
        // `hi` never does. At most 64 rounds of 16 slots, well inside the compute limit.
        let (mut lo, mut hi) = (self.funded_until / HOUR, target / HOUR);
        while hi - lo > 1 {
            let mid = lo + (hi - lo) / 2;
            if self.owed(mid * HOUR) <= vault {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        self.funded_until = lo * HOUR;
        if !self.dry {
            self.ran_dry_count += 1;
        }
        self.dry = true;
    }
}

/// One contract inside a pool, copied from an accepted offer.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default, InitSpace)]
pub struct Slot {
    /// false while the slot is free for the next accepted offer.
    pub used: bool,
    pub employee: Pubkey,
    /// Pay per period in USDC base units (6 decimals).
    pub rate: u64,
    /// How often the rate is earned: every day or every hour.
    pub period: Period,
    /// Pays Monday to Friday UTC only, daily contracts only. Saturday and Sunday earn nothing.
    pub weekdays_only: bool,
    /// Unix time of the midnight UTC the contract starts at. Can be in the past.
    pub start: i64,
    /// Unix time pay stops at, None while open-ended. A midnight UTC from the offer, or the last full period
    /// set by end_contract.
    pub end: Option<i64>,
    /// Base units already paid out by `claim`. What the worker can take is earned minus this.
    pub claimed: u64,
    /// What the contract is for, like "Frontend dev", copied from the offer. Can be empty.
    #[max_len(MAX_NAME_LEN)]
    pub title: String,
    /// Periods pay keeps running after the employer ends the contract. Calendar time: a weekdays contract
    /// with 14 days of notice pays 10 workdays.
    pub notice: u16,
}

impl Slot {
    /// The last full period at `now` plus `notice` periods: the earliest end the employer can set, and how far
    /// ahead the pool keeps pay locked. Not capped by `end`, `earned` already stops there.
    pub fn notice_end(&self, now: i64) -> i64 {
        self.period.last_full(now) + self.notice as i64 * self.period.secs()
    }

    /// Pay earned from `start` up to `until` or the end, whichever comes first, in base units. Zero before the start.
    /// `claim` passes the pool's `funded_until`: the last full period, so only completed days or hours count,
    /// or the shared full hour when the pool ran short. Recomputed from `start`
    /// every time, so it never drifts. The app mirrors this in app/src/pay.ts, keep them in sync.
    pub fn earned(&self, until: i64) -> u64 {
        let until = self.end.map_or(until, |end| end.min(until));
        let secs = self.billable_secs(until);
        // Multiply before dividing, in u128 so rate × seconds can't overflow.
        (self.rate as u128 * secs as u128 / self.period.secs() as u128) as u64
    }

    /// Paid seconds from `start` to `until`, zero when `until` is not later. A weekdays contract skips
    /// Saturday and Sunday UTC.
    fn billable_secs(&self, until: i64) -> i64 {
        if until <= self.start {
            0
        } else if self.weekdays_only {
            weekday_secs(until) - weekday_secs(self.start)
        } else {
            until - self.start
        }
    }

    /// The end `end_contract` stores when `by_employer` or the worker asks for `wanted` at `now` (see there).
    /// Kept here, next to `notice_end`, so unit tests can call it without a transaction.
    pub fn end_at(&self, wanted: Option<i64>, by_employer: bool, now: i64) -> Result<i64> {
        let last_full = self.period.last_full(now);
        let floor = if by_employer {
            self.notice_end(now)
        } else {
            last_full
        };
        let earliest = self.end.map_or(floor, |end| end.min(floor));
        let Some(wanted) = wanted else {
            return Ok(earliest);
        };
        require!(
            wanted % self.period.secs() == 0,
            crate::error::EasypayError::BadEnd
        );
        require!(wanted >= earliest, crate::error::EasypayError::EndTooEarly);
        // Without a cap an employer could store an end near i64::MAX, which overflows weekday_secs and breaks
        // every later claim on the slot.
        require!(
            wanted <= last_full + MAX_END_AHEAD,
            crate::error::EasypayError::EndTooFar
        );
        Ok(self.end.map_or(wanted, |end| end.min(wanted)))
    }

    /// An ended contract whose worker claimed everything it earned. Its slot can be freed.
    pub fn fully_paid(&self) -> bool {
        self.end.is_some_and(|end| self.claimed == self.earned(end))
    }
}

/// How often a contract earns its rate. Hour is the demo mode on devnet: a contract started at midnight has pay
/// to claim by demo time without time travel.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, InitSpace)]
pub enum Period {
    #[default]
    Day,
    Hour,
}

impl Period {
    pub fn secs(self) -> i64 {
        match self {
            Period::Day => DAY,
            Period::Hour => HOUR,
        }
    }

    /// The last full period at or before `now`: the last midnight UTC for Day, the last full hour for Hour.
    /// Pay counts completed periods only.
    pub fn last_full(self, now: i64) -> i64 {
        now - now.rem_euclid(self.secs())
    }
}

/// Monday to Friday seconds between Monday 29 Dec 1969 UTC and `t`. Weekday seconds between two moments
/// are the difference, in O(1). Unix time 0 was a Thursday, so that Monday is 3 days before it.
fn weekday_secs(t: i64) -> i64 {
    let since_monday = t + 3 * DAY;
    since_monday.div_euclid(WEEK) * 5 * DAY + since_monday.rem_euclid(WEEK).min(5 * DAY)
}

/// A contract one side offered and the other has not signed yet, at the PDA [b"offer", pool, employee].
/// `accept` copies it into a pool slot and closes it, `cancel_offer` just closes it. Apps find a worker's offers
/// by reading `employee`.
#[account]
#[derive(InitSpace)]
pub struct Offer {
    pub pool: Pubkey,
    pub employee: Pubkey,
    /// The pool's employer or `employee`, whoever proposed. Paid the rent and gets it back when the offer closes.
    /// Only the other side can accept.
    pub proposer: Pubkey,
    /// Pay per period in USDC base units (6 decimals).
    pub rate: u64,
    pub period: Period,
    /// Pays Monday to Friday UTC only, daily contracts only.
    pub weekdays_only: bool,
    /// Unix time of a midnight UTC. Can be in the past.
    pub start: i64,
    /// Unix time of the midnight UTC after the last working day, None for open-ended.
    pub end: Option<i64>,
    pub bump: u8,
    /// What the contract is for, like "Frontend dev". Can be empty.
    #[max_len(MAX_NAME_LEN)]
    pub title: String,
    /// Periods pay keeps running after the employer ends the contract, 0 allowed.
    pub notice: u16,
}

/// Where a worker's claims go, at the PDA [b"split", employee]. One per worker, it covers all their contracts.
/// Only the worker changes it, through `set_split`. The worker's own wallet is not a row: it gets
/// 100 - sum(recipients) - invest_pct percent, plus every rounding remainder.
#[account]
#[derive(InitSpace)]
pub struct Split {
    pub employee: Pubkey,
    /// Auto-claim server key that may claim for the worker, None = off. Sits before the Vec so the server
    /// can find its workers with a memcmp at a fixed offset.
    pub claimer: Option<Pubkey>,
    /// Percent of every claim swapped into `invest_asset`, 0..=100.
    pub invest_pct: u8,
    pub invest_asset: Asset,
    /// Up to MAX_RECIPIENTS other addresses, each with a whole percent of every claim.
    #[max_len(MAX_RECIPIENTS)]
    pub recipients: Vec<Recipient>,
    pub bump: u8,
    /// Recipient labels like "Mom", encrypted by the app with a key only the worker's wallet can derive.
    /// Opaque to the program, all zeros = no labels.
    pub labels: [u8; LABELS_LEN],
}

/// One split address and its percent of every claim.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub struct Recipient {
    pub owner: Pubkey,
    pub pct: u8,
}

/// What the invest share of a claim is swapped into.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, InitSpace)]
pub enum Asset {
    #[default]
    Sol,
    Btc,
    Eth,
}

impl Asset {
    /// The Pyth push feed account with this asset's USD price.
    pub fn feed(self) -> Pubkey {
        match self {
            Asset::Sol => SOL_USD_FEED,
            Asset::Btc => BTC_USD_FEED,
            Asset::Eth => ETH_USD_FEED,
        }
    }

    /// Decimals of the asset's base unit: lamports for SOL, the test mints for BTC and ETH.
    pub fn decimals(self) -> u8 {
        match self {
            Asset::Sol => 9,
            Asset::Btc | Asset::Eth => ASSET_DECIMALS,
        }
    }
}

/// The program's own exchange, at the PDA [b"exchange"]. Swaps the invest share of a claim at the Pyth price:
/// mints test BTC and ETH, pays SOL from the lamports on this account (the reserve, topped up once from the
/// faucet). USDC it takes stays in its associated token account for `usdc_mint`. On devnet the swap is simulated.
#[account]
#[derive(InitSpace)]
pub struct Exchange {
    /// The only mint it swaps from. A pool in any other mint gets USDC back, so nobody can swap a token they
    /// mint themselves for SOL, BTC or ETH.
    pub usdc_mint: Pubkey,
    /// Test BTC mint, PDA [b"btc"], 8 decimals, mint authority this exchange.
    pub btc_mint: Pubkey,
    /// Test ETH mint, PDA [b"eth"], the same.
    pub eth_mint: Pubkey,
    pub bump: u8,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::EasypayError;

    // Thursday 1 Oct 2026, 00:00 UTC.
    const OCT1: i64 = 1_790_812_800;
    const USDC: u64 = 1_000_000;

    fn daily(notice: u16) -> Slot {
        Slot {
            used: true,
            rate: 100 * USDC,
            start: OCT1,
            notice,
            ..Slot::default()
        }
    }

    fn pool(slots: Vec<Slot>) -> Pool {
        Pool {
            employer: Pubkey::default(),
            mint: Pubkey::default(),
            bump: 0,
            funded_until: OCT1,
            dry: false,
            slots,
            contracts_total: 0,
            paid_total: 0,
            ran_dry_count: 0,
            name: String::new(),
        }
    }

    fn err(e: EasypayError) -> Result<i64> {
        Err(e.into())
    }

    #[test]
    fn errors_compare_by_code() {
        assert_ne!(err(EasypayError::EndTooEarly), err(EasypayError::BadEnd));
    }

    #[test]
    fn oct1_is_a_thursday_midnight() {
        assert_eq!(OCT1 % DAY, 0);
        assert_eq!((OCT1 / DAY + 3) % 7, 3);
    }

    #[test]
    fn locked_counts_earned_plus_notice_minus_claimed() {
        // Noon on day 3: two full days earned, plus 14 days of notice from the last midnight.
        let now = OCT1 + 2 * DAY + 12 * HOUR;
        let mut s = daily(14);
        s.claimed = 50 * USDC;
        let p = pool(vec![s, daily(0), Slot::default()]);
        assert_eq!(p.locked(now), (16 * 100 - 50 + 2 * 100) * USDC);
        // The current unfinished day sits inside the notice, so it is locked too.
        assert!(p.locked(now) > p.owed(Period::Day.last_full(now)));
    }

    #[test]
    fn locked_stops_at_the_end_and_skips_weekends() {
        let now = OCT1 + 12 * HOUR;
        let mut fixed = daily(14);
        fixed.end = Some(OCT1 + 5 * DAY);
        assert_eq!(pool(vec![fixed]).locked(now), 500 * USDC);
        // 14 calendar days from Thursday midnight are 10 workdays.
        let mut weekdays = daily(14);
        weekdays.weekdays_only = true;
        assert_eq!(pool(vec![weekdays]).locked(now), 1000 * USDC);
    }

    #[test]
    fn locked_is_hours_for_an_hourly_contract() {
        let mut s = daily(2);
        s.period = Period::Hour;
        s.rate = 10 * USDC;
        assert_eq!(pool(vec![s]).locked(OCT1 + 3 * HOUR + 59), 50 * USDC);
    }

    #[test]
    fn employer_end_waits_for_the_notice_worker_end_does_not() {
        let now = OCT1 + 2 * DAY + 12 * HOUR;
        let s = daily(14);
        assert_eq!(s.end_at(None, true, now), Ok(OCT1 + 16 * DAY));
        assert_eq!(s.end_at(None, false, now), Ok(OCT1 + 2 * DAY));
        assert_eq!(
            s.end_at(Some(OCT1 + 15 * DAY), true, now),
            err(EasypayError::EndTooEarly)
        );
        assert_eq!(
            s.end_at(Some(OCT1 + 30 * DAY), true, now),
            Ok(OCT1 + 30 * DAY)
        );
        assert_eq!(
            s.end_at(Some(OCT1 + 5 * DAY), false, now),
            Ok(OCT1 + 5 * DAY)
        );
        assert_eq!(
            s.end_at(Some(OCT1 + DAY), false, now),
            err(EasypayError::EndTooEarly)
        );
    }

    #[test]
    fn notice_never_extends_the_current_end() {
        let now = OCT1 + 2 * DAY;
        let mut s = daily(14);
        s.end = Some(OCT1 + 5 * DAY);
        assert_eq!(s.end_at(None, true, now), Ok(OCT1 + 5 * DAY));
        assert_eq!(
            s.end_at(Some(OCT1 + 20 * DAY), true, now),
            Ok(OCT1 + 5 * DAY)
        );
        // An already ended contract keeps its end.
        s.end = Some(OCT1 + DAY);
        assert_eq!(s.end_at(None, false, now), Ok(OCT1 + DAY));
    }

    #[test]
    fn later_end_sits_on_a_full_period_and_within_366_days() {
        let now = OCT1 + 12 * HOUR;
        let s = daily(0);
        assert_eq!(
            s.end_at(Some(OCT1 + 3 * DAY + HOUR), true, now),
            err(EasypayError::BadEnd)
        );
        assert_eq!(
            s.end_at(Some(OCT1 + MAX_END_AHEAD), true, now),
            Ok(OCT1 + MAX_END_AHEAD)
        );
        assert_eq!(
            s.end_at(Some(OCT1 + MAX_END_AHEAD + DAY), true, now),
            err(EasypayError::EndTooFar)
        );
        assert_eq!(
            s.end_at(Some(i64::MAX - i64::MAX % DAY), true, now),
            err(EasypayError::EndTooFar)
        );
        let mut hourly = daily(2);
        hourly.period = Period::Hour;
        assert_eq!(
            hourly.end_at(None, true, OCT1 + 90 * 60),
            Ok(OCT1 + 3 * HOUR)
        );
        assert_eq!(
            hourly.end_at(Some(OCT1 + 4 * HOUR), true, OCT1 + 90 * 60),
            Ok(OCT1 + 4 * HOUR)
        );
    }
}
