# Security

## Trust Model

### What the Oracle Controls

The oracle operator controls:

1. **Liveness** — The oracle must be running to fulfill requests. If it goes down, pending requests will not be fulfilled until it restarts (the catch-up scan handles this).
2. **HMAC Secret** — Whoever knows the secret can predict VRF outputs before they're published on-chain. The secret must be kept confidential.

### What the Oracle Cannot Do

1. **Submit arbitrary randomness** — The on-chain program cryptographically verifies that the randomness was signed by the configured authority key. The oracle must produce a valid Ed25519 signature.
2. **Modify past outputs** — Once a request is fulfilled on-chain, the randomness is immutable.
3. **Double-fulfill** — The program enforces status transitions (Pending → Fulfilled → Consumed → Closed). A request can only be fulfilled once.

### On-Chain Verification

Every fulfillment transaction includes a native Ed25519 signature-verify instruction. The program introspects the Instructions sysvar to verify:

- The instruction at index 0 targets the Ed25519 precompile
- Exactly 1 signature is present
- The public key matches `VrfConfiguration.authority`
- The signed message matches `request_id || randomness`
- All offset indices are self-referencing (`0xFFFF`)

## HMAC Secret Management

The HMAC secret is the most sensitive component. If compromised, an attacker could predict future VRF outputs.

### Generation

```bash
# Generate a 32-byte (256-bit) random secret
openssl rand -hex 32
```

### Storage

- **Never commit the secret to version control**
- Store in a secrets manager (AWS Secrets Manager, HashiCorp Vault, etc.)
- If using environment variables, ensure the `.env` file is excluded from git (it is in our `.gitignore`)
- On production servers, use `EnvironmentFile=` in systemd or Docker secrets

### Rotation

To rotate the HMAC secret:

1. Deploy a new oracle backend instance with the new secret
2. The new oracle will fulfill new requests with the new secret
3. Existing pending requests (created before rotation) will produce different randomness than the old oracle would have — this is acceptable because the randomness is still deterministic and cryptographically verified
4. Decommission the old oracle instance

**Note**: HMAC rotation does not require any on-chain changes. The program only verifies the Ed25519 signature, not the HMAC computation.

## Authority Key Management

The authority keypair signs Ed25519 proofs. If compromised:

- An attacker could fulfill pending requests with arbitrary (but still signed) randomness
- To recover: call `update_config` with a new authority pubkey, then redeploy the backend with the new keypair

### Key Rotation

```bash
# Generate a new keypair
solana-keygen new -o new-authority.json

# Update the on-chain config (requires admin key)
# In your admin script:
# await program.methods.updateConfig(newAuthority, null, null, null).rpc();

# Update backend .env with new keypair path
AUTHORITY_KEYPAIR_PATH=/path/to/new-authority.json
```

## Common Attack Vectors

| Attack | Mitigated? | How |
|--------|-----------|-----|
| Oracle predicts randomness | Yes* | HMAC secret must be kept confidential |
| Oracle submits fake randomness | Yes | Ed25519 signature verified on-chain |
| Oracle refuses to fulfill | Partially | Monitoring + redundancy; no on-chain mitigation |
| Requester manipulates seed | No impact | Seed is mixed into HMAC input alongside slot and ID |
| Request replay | Yes | Each request has a unique monotonic ID |
| Front-running | Minimal | Oracle uses the request_slot (committed on-chain) as HMAC input |

*If the HMAC secret is leaked, the oracle's randomness becomes predictable. However, the Ed25519 signature still prevents unauthorized parties from fulfilling requests.

## Operational Security

- Run the backend on a dedicated, hardened server
- Use firewalls to restrict HTTP endpoints (only expose `/health` and `/status` as needed)
- Monitor `/metrics` for anomalies (sudden failures, increased latency)
- Set up alerts for `requests_failed > 0`
- Keep the authority keypair's SOL balance funded for transaction fees
- Regularly audit access to the HMAC secret and authority keypair
