# Deployment Guide

## Program Deployment

### Devnet

```bash
cd program
solana config set --url devnet
solana airdrop 5   # Fund deployer
anchor build
anchor deploy
```

### Mainnet

```bash
cd program
solana config set --url mainnet-beta

# Verify program IDs match
anchor build
anchor deploy --provider.cluster mainnet
```

After deployment, initialize the VRF configuration:

```bash
# Via the test suite or a custom script
cd program
anchor test --skip-build -- --grep "initialize"
```

## Backend Deployment

### Local / Direct

```bash
cd backend
cp .env.example .env
# Edit .env with production values
cargo build --release
./target/release/vrf-backend
```

### Docker

```bash
cd backend
docker build -t vrf-backend .
docker run -d \
  --name vrf-backend \
  --env-file .env \
  -p 8080:8080 \
  -v /path/to/authority-keypair.json:/keys/authority.json:ro \
  vrf-backend
```

### Systemd

Create `/etc/systemd/system/vrf-backend.service`:

```ini
[Unit]
Description=Solana VRF Oracle Backend
After=network.target

[Service]
Type=simple
User=vrf
EnvironmentFile=/etc/vrf-backend/env
ExecStart=/usr/local/bin/vrf-backend
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable vrf-backend
sudo systemctl start vrf-backend
sudo journalctl -u vrf-backend -f
```

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | No | `http://127.0.0.1:8899` | Solana JSON-RPC endpoint |
| `WS_URL` | No | `ws://127.0.0.1:8900` | Solana WebSocket endpoint |
| `AUTHORITY_KEYPAIR_PATH` | No | `~/.config/solana/id.json` | Oracle authority Ed25519 keypair |
| `HMAC_SECRET` | **Yes** | — | HMAC-SHA256 secret for randomness derivation |
| `PROGRAM_ID` | **Yes** | — | Deployed VRF program ID (base58) |
| `CLUSTER` | No | `devnet` | Cluster name for Solscan URLs |
| `HTTP_PORT` | No | `8080` | HTTP server port |
| `MAX_RETRIES` | No | `5` | Max retry attempts per fulfillment |
| `INITIAL_RETRY_DELAY_MS` | No | `500` | Initial retry delay (doubles each attempt) |
| `PRIORITY_FEE_MICRO_LAMPORTS` | No | `0` | Priority fee per compute unit |
| `FULFILLMENT_CONCURRENCY` | No | `4` | Max concurrent fulfillment tasks |

## Monitoring

### Health Check

```bash
curl http://localhost:8080/health
# {"status":"ok"}
```

### Status

```bash
curl http://localhost:8080/status
# {"status":"running","pending_fulfillments":0}
```

### Metrics

```bash
curl http://localhost:8080/metrics
# {
#   "requests_received": 150,
#   "requests_fulfilled": 148,
#   "requests_failed": 2,
#   "avg_fulfillment_latency_ms": 1200,
#   "total_fulfillment_latency_ms": 177600,
#   "fulfillment_count": 148,
#   "pending_fulfillments": 0
# }
```

### Log Levels

Control via `RUST_LOG` environment variable:

```bash
# Default (info for app, warn for Solana client noise)
RUST_LOG="info,solana_client=warn,solana_rpc_client=warn,hyper=warn,reqwest=warn"

# Debug all
RUST_LOG=debug

# Trace fulfiller only
RUST_LOG="info,vrf_backend::fulfiller=trace"
```

## Production Checklist

- [ ] Generate a strong HMAC secret: `openssl rand -hex 32`
- [ ] Use a dedicated authority keypair (not your main wallet)
- [ ] Fund the authority account with enough SOL for transaction fees
- [ ] Set `CLUSTER=mainnet-beta` for production Solscan URLs
- [ ] Configure `PRIORITY_FEE_MICRO_LAMPORTS` for congested periods
- [ ] Set up monitoring alerts on `/metrics` (failed count, latency)
- [ ] Run behind a reverse proxy (nginx/caddy) if exposing HTTP externally
- [ ] Back up the authority keypair securely
- [ ] Back up the HMAC secret securely
- [ ] Test failover: stop backend, verify catch-up scan works on restart
