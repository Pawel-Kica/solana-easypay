use anchor_lang::prelude::*;

/// Seed of the pool PDA: [POOL_SEED, employer].
#[constant]
pub const POOL_SEED: &[u8] = b"pool";

/// Seed of an offer PDA: [OFFER_SEED, pool, employee]. One pending offer per pool and worker.
#[constant]
pub const OFFER_SEED: &[u8] = b"offer";

/// Seed of a worker's split PDA: [SPLIT_SEED, employee]. One split per worker, for all their contracts.
#[constant]
pub const SPLIT_SEED: &[u8] = b"split";

/// Other addresses a split can pay besides the worker's own wallet.
pub const MAX_RECIPIENTS: usize = 3;

/// Bytes of a split's encrypted labels blob. The app encrypts it, the program only stores it.
pub const LABELS_LEN: usize = 128;

/// Contracts a pool holds at once. They live inline in the pool account.
pub const MAX_SLOTS: usize = 16;

/// Max bytes of a pool name and a contract title. The program rejects longer ones.
pub const MAX_NAME_LEN: usize = 32;

/// Seconds in a UTC day. Contract starts sit on a multiple of this: a midnight UTC.
pub const DAY: i64 = 86_400;

/// Seconds in a week. Weekdays contracts count Monday to Friday of each one.
pub const WEEK: i64 = 7 * DAY;

/// How far past the last full period end_contract can set an end, in seconds: 366 days.
pub const MAX_END_AHEAD: i64 = 366 * DAY;

/// Seconds in an hour. A short pool pays every contract up to the same full hour.
pub const HOUR: i64 = 3_600;

/// Seed of the exchange PDA: [EXCHANGE_SEED]. One exchange per program. It also holds the SOL reserve.
#[constant]
pub const EXCHANGE_SEED: &[u8] = b"exchange";

/// Seeds of the test BTC and ETH mints, PDAs whose mint authority is the exchange.
#[constant]
pub const BTC_SEED: &[u8] = b"btc";
#[constant]
pub const ETH_SEED: &[u8] = b"eth";

/// Decimals of the test BTC and ETH mints. SOL has 9 (lamports).
pub const ASSET_DECIMALS: u8 = 8;

/// A Pyth price older than this, in seconds, is stale and the swap falls back to USDC. Feeds update every 55 s.
pub const MAX_PRICE_AGE: u64 = 120;

/// The Pyth receiver program, owner of every price account. Same on devnet and mainnet.
pub const PYTH_RECEIVER: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

/// Pyth push feed accounts (PriceUpdateV2), same addresses on devnet and mainnet.
pub const SOL_USD_FEED: Pubkey = pubkey!("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
pub const BTC_USD_FEED: Pubkey = pubkey!("4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo");
pub const ETH_USD_FEED: Pubkey = pubkey!("42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC");
