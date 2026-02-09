use anchor_lang::prelude::*;

/// Error codes for the VRF program.
///
/// Anchor encodes these as `6000 + variant index` in on-chain error responses.
#[error_code]
pub enum VrfError {
    /// The request's status is not `Pending` (expected for fulfillment).
    #[msg("Request is not in pending status")]
    RequestNotPending,
    /// The request's status is not `Fulfilled` (expected for consumption).
    #[msg("Request is not in fulfilled status")]
    RequestNotFulfilled,
    /// The request's status is not `Consumed` (expected for closure).
    #[msg("Request is not in consumed status")]
    RequestNotConsumed,
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
    /// Signer does not have permission for this action (wrong admin, authority, or requester).
    #[msg("Unauthorized")]
    Unauthorized,
    /// A public key argument was the zero address (`11111111111111111111111111111111`).
    #[msg("Zero address not allowed")]
    ZeroAddressNotAllowed,
    /// The request counter would overflow u64 (practically unreachable).
    #[msg("Request counter overflow")]
    CounterOverflow,
    /// The compressed account data passed by the client does not match on-chain expectations.
    #[msg("Compressed account data mismatch")]
    CompressedAccountMismatch,
}
