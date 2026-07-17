#!/usr/bin/env bash
set -e
if stellar keys address dev-account >/dev/null 2>&1; then
  echo "Key already exists, skipping generate"
else
  stellar keys generate dev-account --network testnet
fi
stellar keys fund dev-account --network testnet
echo "Account funded. Address:"
stellar keys address dev-account
