//! Derives consumer-specific callback accounts for the VRF fulfillment CPI.
//!
//! When the coordinator fulfills a request, it CPIs into the consumer program's
//! `fulfill_random_words` instruction. The backend must provide the correct
//! remaining_accounts for the callback.
//!
//! **Generic approach**: The consumer stores its callback accounts in the VRF
//! request PDA at request time. The backend reads them from the request account
//! data and includes them as remaining_accounts in the fulfillment transaction.

use anyhow::{Context, Result};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_commitment_config::CommitmentConfig;
use solana_sdk::instruction::AccountMeta;
use solana_sdk::pubkey::Pubkey;
use tracing::{debug, warn};

/// Maximum callback accounts stored in the request PDA (must match on-chain constant).
const MAX_CALLBACK_ACCOUNTS: usize = 4;

/// Offset of `callback_account_count` in the request account body (after 8-byte discriminator).
///
/// Layout:
/// request_id(8) + subscription_id(8) + consumer_program(32) + requester(32) +
/// num_words(4) + seed(32) + request_slot(8) + callback_compute_limit(4) +
/// status(1) + randomness(32) + fulfilled_slot(8) + bump(1)
/// = 170 bytes before callback fields
const CALLBACK_COUNT_OFFSET: usize = 8 + 170; // 8 (discriminator) + 170 (body)

/// Offset of `callback_account_keys` = CALLBACK_COUNT_OFFSET + 1
const CALLBACK_KEYS_OFFSET: usize = CALLBACK_COUNT_OFFSET + 1;

/// Offset of `callback_writable_bitmap` = CALLBACK_KEYS_OFFSET + 32 * MAX_CALLBACK_ACCOUNTS
const CALLBACK_BITMAP_OFFSET: usize = CALLBACK_KEYS_OFFSET + 32 * MAX_CALLBACK_ACCOUNTS;

/// Minimum account data length to contain callback fields.
const MIN_DATA_LEN_WITH_CALLBACKS: usize = CALLBACK_BITMAP_OFFSET + 1;

/// Read callback accounts from the VRF request PDA on-chain.
///
/// Returns the remaining_accounts that should be appended to the
/// `fulfill_random_words` transaction for the consumer's callback CPI.
pub async fn read_callback_accounts_from_request(
    rpc_client: &RpcClient,
    vrf_program_id: &Pubkey,
    request_id: u64,
) -> Result<Vec<AccountMeta>> {
    let (request_pda, _) = Pubkey::find_program_address(
        &[b"vrf-request", &request_id.to_le_bytes()],
        vrf_program_id,
    );

    let account = rpc_client
        .get_account_with_commitment(&request_pda, CommitmentConfig::confirmed())
        .await
        .context("failed to fetch request PDA")?
        .value
        .context("request PDA not found")?;

    let data = &account.data;

    if data.len() < MIN_DATA_LEN_WITH_CALLBACKS {
        // Old request format without callback accounts — return empty
        debug!(
            request_id,
            data_len = data.len(),
            "Request PDA too short for callback accounts, returning empty"
        );
        return Ok(vec![]);
    }

    let count = data[CALLBACK_COUNT_OFFSET] as usize;
    if count == 0 {
        return Ok(vec![]);
    }
    if count > MAX_CALLBACK_ACCOUNTS {
        warn!(
            request_id,
            count, "callback_account_count exceeds max, clamping"
        );
    }
    let count = count.min(MAX_CALLBACK_ACCOUNTS);

    let bitmap = data[CALLBACK_BITMAP_OFFSET];

    let mut accounts = Vec::with_capacity(count);
    for i in 0..count {
        let start = CALLBACK_KEYS_OFFSET + i * 32;
        let end = start + 32;
        let key = Pubkey::try_from(&data[start..end])
            .map_err(|_| anyhow::anyhow!("invalid pubkey at callback slot {i}"))?;

        let is_writable = (bitmap >> i) & 1 == 1;
        if is_writable {
            accounts.push(AccountMeta::new(key, false));
        } else {
            accounts.push(AccountMeta::new_readonly(key, false));
        }
    }

    debug!(
        request_id,
        count,
        "Read {} callback accounts from request PDA",
        count
    );

    Ok(accounts)
}
