use anchor_lang::prelude::*;

/// Errors our program returns. Anchor logs the message, and the app shows it in the failure toast.
#[error_code]
pub enum EasypayError {
    #[msg("Start must be a midnight UTC")]
    StartNotMidnight,
    #[msg("End must be a full period after the start: midnight UTC, or a full hour for hourly")]
    BadEnd,
    #[msg("You can't offer a contract to yourself")]
    OfferToSelf,
    #[msg("The pool has no free contract slot")]
    PoolFull,
    #[msg("This contract is not yours")]
    NotYourContract,
    #[msg("Nothing to claim yet")]
    NothingToClaim,
    #[msg("You can't withdraw earned pay or the notice reserve")]
    MoreThanWithdrawable,
    #[msg("The pool can't cover earned pay plus every contract's notice. Deposit first")]
    PoolShort,
    #[msg("Only the pool's employer or the worker can propose this contract")]
    NotAParty,
    #[msg("Only the other side of the offer can accept it")]
    NotTheReceiver,
    #[msg("Only whoever proposed the offer can cancel it")]
    NotTheProposer,
    #[msg("The pool holds contracts with another period")]
    PeriodMismatch,
    #[msg("Weekdays only applies to daily contracts")]
    WeekdaysHourly,
    #[msg("The offer changed since you opened it. Check the new terms")]
    OfferChanged,
    #[msg("Name and title can have at most 32 bytes")]
    NameTooLong,
    #[msg("A split pays at most 3 other addresses")]
    TooManyRecipients,
    #[msg("Split addresses must be distinct, not your own wallet, each at least 1%")]
    BadRecipient,
    #[msg("Split and invest shares add up to more than 100%")]
    SplitOver100,
    #[msg("Pass each split address's USDC account, in split order")]
    RecipientAccountMismatch,
    #[msg("Only the worker or their auto-claim key can claim")]
    NotAllowedToClaim,
    #[msg("End is earlier than the notice allows")]
    EndTooEarly,
    #[msg("End can be at most 366 days ahead")]
    EndTooFar,
}
