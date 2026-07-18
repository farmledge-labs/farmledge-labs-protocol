#!/bin/bash
set -e
cargo build -p maize-receipt --target wasm32-unknown-unknown --release
CONTRACT_ID=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/maize_receipt.wasm \
  --source dev-account \
  --network testnet)
echo "Deployed maize-receipt to: $CONTRACT_ID"
stellar contract invoke --id $CONTRACT_ID --source dev-account --network testnet -- init --admin dev-account
