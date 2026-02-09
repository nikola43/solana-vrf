//! Derives consumer-specific callback accounts for known consumer programs.
//!
//! When the coordinator fulfills a request, it CPIs into the consumer program's
//! `fulfill_random_words` instruction. The backend must provide the correct
//! remaining_accounts for each known consumer.

use solana_sdk::instruction::AccountMeta;
use solana_sdk::pubkey::Pubkey;

use crate::listener::RandomWordsRequestedEvent;

/// Derive the callback accounts for the roll-dice consumer program.
///
/// The roll-dice `fulfill_random_words` instruction expects:
/// 1. coordinator_config (signer) — provided automatically by the coordinator
/// 2. game_config — PDA ["game-config"] from the dice program
/// 3. dice_roll — PDA ["dice-result", player, request_id_le_bytes] from the dice program
pub fn derive_dice_callback_accounts(
    dice_program_id: &Pubkey,
    event: &RandomWordsRequestedEvent,
) -> Vec<AccountMeta> {
    let (game_config_pda, _) =
        Pubkey::find_program_address(&[b"game-config"], dice_program_id);

    let (dice_roll_pda, _) = Pubkey::find_program_address(
        &[
            b"dice-result",
            event.requester.as_ref(),
            &event.request_id.to_le_bytes(),
        ],
        dice_program_id,
    );

    vec![
        AccountMeta::new_readonly(game_config_pda, false), // game_config
        AccountMeta::new(dice_roll_pda, false),            // dice_roll (writable)
    ]
}

/// Derive callback accounts for a given consumer program.
///
/// Returns the remaining_accounts that should be appended to the
/// `fulfill_random_words` transaction for the consumer's callback CPI.
pub fn derive_callback_accounts(
    consumer_program: &Pubkey,
    dice_program_id: Option<&Pubkey>,
    event: &RandomWordsRequestedEvent,
) -> Vec<AccountMeta> {
    // Check if the consumer is the roll-dice program
    if let Some(dice_id) = dice_program_id {
        if consumer_program == dice_id {
            return derive_dice_callback_accounts(dice_id, event);
        }
    }

    // Unknown consumer: no remaining accounts (the CPI will likely fail
    // unless the consumer needs no additional accounts beyond coordinator_config).
    vec![]
}
