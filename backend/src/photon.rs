//! Photon indexer client for ZK Compressed accounts.
//!
//! The Photon indexer (provided by Helius/Light Protocol on devnet) tracks
//! compressed account state in Merkle trees. This client queries it to:
//!
//! 1. Find pending compressed randomness requests (catch-up scan)
//! 2. Fetch current compressed account state for fulfillment
//! 3. Obtain validity proofs for state transitions

use anyhow::{Context, Result};
use serde::Deserialize;
use serde::Serialize;
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use std::time::Duration;
use tracing::{debug, warn};

/// HTTP request timeout for Photon RPC calls.
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// Client for the Photon indexer RPC API.
#[derive(Clone)]
pub struct PhotonClient {
    rpc_url: String,
    http: reqwest::Client,
}

/// Compressed randomness request state (parsed from raw bytes).
#[derive(Debug, Clone)]
pub struct CompressedRandomnessRequest {
    pub request_id: u64,
    pub requester: Pubkey,
    pub seed: [u8; 32],
    pub request_slot: u64,
    pub status: u8,
    pub randomness: [u8; 32],
}

impl CompressedRandomnessRequest {
    pub const STATUS_PENDING: u8 = 0;
    #[allow(dead_code)]
    pub const STATUS_FULFILLED: u8 = 1;

    /// Light Protocol discriminator: SHA256("CompressedRandomnessRequest")[..8]
    pub const LIGHT_DISCRIMINATOR: [u8; 8] = [149, 31, 244, 154, 189, 164, 84, 79];

    /// Serialized size (without discriminator): 8 + 32 + 32 + 8 + 1 + 32 = 113
    pub const DATA_SIZE: usize = 113;

    /// Parse from raw bytes (after discriminator).
    pub fn from_bytes(data: &[u8]) -> Option<Self> {
        if data.len() < Self::DATA_SIZE {
            return None;
        }
        let request_id = u64::from_le_bytes(data[0..8].try_into().ok()?);
        let requester = Pubkey::try_from(&data[8..40]).ok()?;
        let mut seed = [0u8; 32];
        seed.copy_from_slice(&data[40..72]);
        let request_slot = u64::from_le_bytes(data[72..80].try_into().ok()?);
        let status = data[80];
        let mut randomness = [0u8; 32];
        randomness.copy_from_slice(&data[81..113]);
        Some(Self {
            request_id,
            requester,
            seed,
            request_slot,
            status,
            randomness,
        })
    }

    /// Serialize to bytes (Borsh-compatible).
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(Self::DATA_SIZE);
        buf.extend_from_slice(&self.request_id.to_le_bytes());
        buf.extend_from_slice(self.requester.as_ref());
        buf.extend_from_slice(&self.seed);
        buf.extend_from_slice(&self.request_slot.to_le_bytes());
        buf.push(self.status);
        buf.extend_from_slice(&self.randomness);
        buf
    }
}

/// Compressed account info returned by Photon.
#[derive(Debug, Clone)]
pub struct CompressedAccountInfo {
    pub request: CompressedRandomnessRequest,
    pub hash: [u8; 32],
    pub address: [u8; 32],
    pub merkle_tree: Pubkey,
    pub leaf_index: u32,
    pub merkle_tree_index: u8,
    pub nullifier_queue_index: u8,
    pub root_index: u16,
}

// ---------------------------------------------------------------------------
// Photon JSON-RPC request/response types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct JsonRpcRequest<T: Serialize> {
    jsonrpc: &'static str,
    id: &'static str,
    method: &'static str,
    params: T,
}

#[derive(Deserialize, Debug)]
struct JsonRpcResponse<T> {
    result: Option<T>,
    error: Option<JsonRpcError>,
}

#[derive(Deserialize, Debug)]
struct JsonRpcError {
    code: i64,
    message: String,
}

#[derive(Deserialize, Debug)]
struct GetCompressedAccountsByOwnerResult {
    #[allow(dead_code)]
    context: Option<PhotonContext>,
    value: CompressedAccountsByOwnerValue,
}

#[derive(Deserialize, Debug)]
struct PhotonContext {
    #[allow(dead_code)]
    slot: Option<u64>,
}

#[derive(Deserialize, Debug)]
struct CompressedAccountsByOwnerValue {
    items: Vec<CompressedAccountItem>,
    #[allow(dead_code)]
    cursor: Option<String>,
}

#[derive(Deserialize, Debug)]
struct GetCompressedAccountResult {
    #[allow(dead_code)]
    context: Option<PhotonContext>,
    value: Option<CompressedAccountItem>,
}

#[derive(Deserialize, Debug)]
struct CompressedAccountItem {
    hash: String,
    address: Option<String>,
    data: CompressedAccountDataResp,
    #[serde(rename = "tree")]
    tree: Option<String>,
    #[serde(rename = "leafIndex")]
    leaf_index: Option<u32>,
}

#[derive(Deserialize, Debug)]
struct CompressedAccountDataResp {
    data: String,
    #[serde(rename = "dataHash")]
    #[allow(dead_code)]
    data_hash: Option<String>,
    #[allow(dead_code)]
    discriminator: Option<u64>,
}

#[derive(Deserialize, Debug)]
struct GetValidityProofResult {
    #[allow(dead_code)]
    context: Option<PhotonContext>,
    value: ValidityProofValue,
}

#[derive(Deserialize, Debug)]
struct ValidityProofValue {
    #[serde(rename = "compressedProof")]
    compressed_proof: CompressedProofResp,
    #[serde(rename = "rootIndices")]
    #[allow(dead_code)]
    root_indices: Vec<u32>,
    #[serde(rename = "merkleTrees")]
    #[allow(dead_code)]
    merkle_trees: Option<Vec<String>>,
    #[serde(rename = "nullifierQueues")]
    #[allow(dead_code)]
    nullifier_queues: Option<Vec<String>>,
}

#[derive(Deserialize, Debug)]
struct CompressedProofResp {
    a: Vec<u8>,
    b: Vec<u8>,
    c: Vec<u8>,
}

impl PhotonClient {
    /// Create a new Photon client with request timeout.
    pub fn new(rpc_url: &str) -> Self {
        let http = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .build()
            .expect("failed to build HTTP client");

        Self {
            rpc_url: rpc_url.to_string(),
            http,
        }
    }

    /// Find all pending compressed randomness requests owned by `program_id`.
    pub async fn find_pending_compressed_requests(
        &self,
        program_id: &Pubkey,
    ) -> Result<Vec<CompressedAccountInfo>> {
        let params = serde_json::json!({
            "owner": program_id.to_string(),
            "dataSlice": null,
            "cursor": null,
            "limit": 1000,
        });

        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id: "1",
            method: "getCompressedAccountsByOwner",
            params,
        };

        let resp: JsonRpcResponse<GetCompressedAccountsByOwnerResult> = self
            .http
            .post(&self.rpc_url)
            .json(&req)
            .send()
            .await
            .context("Photon RPC request failed")?
            .json()
            .await
            .context("Failed to parse Photon response")?;

        if let Some(err) = resp.error {
            anyhow::bail!("Photon RPC error {}: {}", err.code, err.message);
        }

        let result = resp.result.context("Photon returned null result without error")?;

        let mut pending = Vec::new();
        for item in result.value.items {
            match self.parse_compressed_account(&item) {
                Ok(Some(info)) if info.request.status == CompressedRandomnessRequest::STATUS_PENDING => {
                    pending.push(info);
                }
                Ok(_) => {} // Not a pending request or not our type
                Err(e) => {
                    warn!(error = %e, "Failed to parse compressed account, skipping");
                }
            }
        }

        Ok(pending)
    }

    /// Get the current state and validity proof for a compressed account by address.
    pub async fn get_compressed_account_with_proof(
        &self,
        address: &[u8; 32],
    ) -> Result<(CompressedAccountInfo, [u8; 32], [u8; 64], [u8; 32])> {
        // First, get the compressed account
        let address_b58 = bs58::encode(address).into_string();

        let params = serde_json::json!({
            "address": address_b58,
        });

        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id: "1",
            method: "getCompressedAccount",
            params,
        };

        let resp: JsonRpcResponse<GetCompressedAccountResult> = self
            .http
            .post(&self.rpc_url)
            .json(&req)
            .send()
            .await
            .context("Photon getCompressedAccount request failed")?
            .json()
            .await
            .context("Failed to parse Photon response")?;

        if let Some(err) = resp.error {
            anyhow::bail!("Photon RPC error {}: {}", err.code, err.message);
        }

        let result = resp.result.context("Compressed account not found")?;
        let item = result.value.context("Compressed account value is null")?;
        let info = self
            .parse_compressed_account(&item)?
            .context("Failed to parse compressed account data")?;

        // Now get the validity proof
        let hash_b58 = bs58::encode(&info.hash).into_string();

        let proof_params = serde_json::json!({
            "hashes": [hash_b58],
            "newAddresses": [],
            "newAddressesWithTrees": [],
        });

        let proof_req = JsonRpcRequest {
            jsonrpc: "2.0",
            id: "1",
            method: "getValidityProof",
            params: proof_params,
        };

        let proof_resp: JsonRpcResponse<GetValidityProofResult> = self
            .http
            .post(&self.rpc_url)
            .json(&proof_req)
            .send()
            .await
            .context("Photon getValidityProof request failed")?
            .json()
            .await
            .context("Failed to parse validity proof response")?;

        if let Some(err) = proof_resp.error {
            anyhow::bail!("Photon validity proof error {}: {}", err.code, err.message);
        }

        let proof_result = proof_resp.result.context("Validity proof not found")?;
        let proof = &proof_result.value.compressed_proof;

        // Validate proof component sizes exactly
        anyhow::ensure!(
            proof.a.len() == 32,
            "Validity proof 'a' has wrong size: expected 32, got {}",
            proof.a.len()
        );
        anyhow::ensure!(
            proof.b.len() == 64,
            "Validity proof 'b' has wrong size: expected 64, got {}",
            proof.b.len()
        );
        anyhow::ensure!(
            proof.c.len() == 32,
            "Validity proof 'c' has wrong size: expected 32, got {}",
            proof.c.len()
        );

        let mut a = [0u8; 32];
        let mut b = [0u8; 64];
        let mut c = [0u8; 32];
        a.copy_from_slice(&proof.a);
        b.copy_from_slice(&proof.b);
        c.copy_from_slice(&proof.c);

        Ok((info, a, b, c))
    }

    /// Parse a compressed account item from Photon into our domain type.
    fn parse_compressed_account(
        &self,
        item: &CompressedAccountItem,
    ) -> Result<Option<CompressedAccountInfo>> {
        // Decode the account data from base64
        let data = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            &item.data.data,
        )
        .context("Failed to decode compressed account data")?;

        // Check discriminator
        if data.len() < 8 {
            return Ok(None);
        }
        let disc: [u8; 8] = data[..8]
            .try_into()
            .context("Failed to read discriminator bytes")?;
        if disc != CompressedRandomnessRequest::LIGHT_DISCRIMINATOR {
            debug!("Skipping non-VRF compressed account");
            return Ok(None);
        }

        // Parse from raw bytes (after discriminator)
        let request = CompressedRandomnessRequest::from_bytes(&data[8..])
            .context("Compressed account data too short")?;

        // Parse hash from base58 — must be exactly 32 bytes
        let hash_bytes = bs58::decode(&item.hash)
            .into_vec()
            .context("Invalid hash encoding")?;
        anyhow::ensure!(
            hash_bytes.len() == 32,
            "Hash has wrong length: expected 32, got {}",
            hash_bytes.len()
        );
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&hash_bytes);

        // Parse address — required for fulfillment
        let mut address = [0u8; 32];
        if let Some(ref addr_str) = item.address {
            let addr_key = Pubkey::from_str(addr_str).context("Invalid address")?;
            address = addr_key.to_bytes();
        } else {
            warn!(hash = %item.hash, "Compressed account has no address field");
        }

        // Parse tree
        let merkle_tree = if let Some(ref tree_str) = item.tree {
            Pubkey::from_str(tree_str).context("Invalid tree pubkey")?
        } else {
            Pubkey::default()
        };

        let leaf_index = item.leaf_index.unwrap_or(0);

        Ok(Some(CompressedAccountInfo {
            request,
            hash,
            address,
            merkle_tree,
            leaf_index,
            merkle_tree_index: 0,
            nullifier_queue_index: 0,
            root_index: 0,
        }))
    }
}
