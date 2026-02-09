use anchor_lang::prelude::*;

/// Error codes for the VRF coordinator program.
///
/// Anchor encodes these as `6000 + variant index` in on-chain error responses.
#[error_code]
pub enum VrfError {
    /// The request's status is not `Pending` (expected for fulfillment).
    #[msg("Request is not in pending status")]
    RequestNotPending,
    /// The Ed25519 instruction at index 0 could not be loaded or is malformed.
    #[msg("Invalid Ed25519 instruction")]
    InvalidEd25519Instruction,
    /// The instruction at index 0 does not target the native Ed25519 program.
    #[msg("Invalid Ed25519 program")]
    InvalidEd25519Program,
    /// Expected exactly one signature in the Ed25519 instruction.
    #[msg("Invalid signature count")]
    InvalidSignatureCount,
    /// The public key in the Ed25519 instruction does not match `config.authority`.
    #[msg("Invalid Ed25519 pubkey")]
    InvalidEd25519Pubkey,
    /// The signed message does not match `request_id || randomness`.
    #[msg("Invalid Ed25519 message")]
    InvalidEd25519Message,
    /// Ed25519 instruction offset indices must be self-referencing (0xFFFF).
    #[msg("Invalid Ed25519 instruction index references")]
    InvalidEd25519InstructionIndex,
    /// Signer does not have permission for this action.
    #[msg("Unauthorized")]
    Unauthorized,
    /// A public key argument was the zero address.
    #[msg("Zero address not allowed")]
    ZeroAddressNotAllowed,
    /// The request counter would overflow u64.
    #[msg("Request counter overflow")]
    CounterOverflow,
    /// The requested num_words exceeds the coordinator's max_num_words.
    #[msg("Number of words requested exceeds maximum")]
    NumWordsTooLarge,
    /// The subscription does not have enough balance to cover the fee.
    #[msg("Insufficient subscription balance")]
    InsufficientSubscriptionBalance,
    /// The calling program is not a registered consumer for this subscription.
    #[msg("Invalid consumer program")]
    InvalidConsumerProgram,
    /// Cannot cancel a subscription that still has registered consumers.
    #[msg("Subscription still has registered consumers")]
    SubscriptionHasConsumers,
    /// The callback CPI into the consumer program failed.
    #[msg("Consumer callback failed")]
    CallbackFailed,
}
