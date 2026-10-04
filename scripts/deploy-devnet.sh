#!/usr/bin/env bash
# Deploys or upgrades the program on devnet. Run from the repo root, on the Mac or in the devcontainer:
#   bash scripts/deploy-devnet.sh   (or pnpm deploy:devnet in the container)
# On the Mac it re-runs itself in the running devcontainer, where solana and anchor live.
# The deployer key is DEPLOYER_KEYPAIR=[...] in the gitignored .env, the 64 numbers of a solana-keygen JSON file.
# No key yet: the script makes one, saves it to .env and prints its address to fund. The key pays (rent for the
# ~300 KB program plus a deploy buffer that comes back) and is the upgrade authority.
# The program ID is the committed target/deploy/easypay-keypair.json, the same as Local.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v anchor > /dev/null; then
  export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
  container=$(docker ps -q --filter "label=devcontainer.local_folder=$PWD" | head -1)
  [ -n "$container" ] || { echo "Devcontainer is not running. Start it first (pnpm dev or open the repo in VS Code)."; exit 1; }
  tty=$([ -t 0 ] && echo -t || true)
  exec docker exec -i $tty "$container" bash /workspaces/repo/scripts/deploy-devnet.sh
fi

# solana and anchor take a keypair file, so the key sits in a temp file for this run only.
wallet=$(mktemp)
trap 'rm -f "$wallet"' EXIT

DEPLOYER_KEYPAIR=$([ -f .env ] && sed -n 's/^DEPLOYER_KEYPAIR=//p' .env || true)
if [ -z "$DEPLOYER_KEYPAIR" ]; then
  solana-keygen new --no-bip39-passphrase --silent --force -o "$wallet" > /dev/null
  echo "DEPLOYER_KEYPAIR=$(cat "$wallet")" >> .env
  echo "New deployer key saved to .env."
else
  printf '%s' "$DEPLOYER_KEYPAIR" > "$wallet"
fi
address=$(solana address -k "$wallet")

anchor build

# Peak cost. First deploy: the program account plus a buffer of the same size (refunded). Upgrade: only the buffer
# (refunded) plus the rent for growing the program account. On top, the exchange reserve and 0.2 for the IDL and fees.
RESERVE_SOL=${RESERVE_SOL:-0.5}
export RESERVE_SOL
so_size=$(stat -c%s target/deploy/easypay.so)
rent=$(solana rent "$so_size" -u devnet | awk '{print $3}')
program_id=$(solana address -k target/deploy/easypay-keypair.json)
old_size=$(solana program show "$program_id" -u devnet --output json 2>/dev/null | sed -n 's/.*"dataLen": *\([0-9]*\).*/\1/p' || true)
if [ -n "$old_size" ]; then
  old_rent=$(solana rent "$old_size" -u devnet | awk '{print $3}')
  program_cost=$(awk -v r="$rent" -v o="$old_rent" 'BEGIN { g = r - o; print r + (g > 0 ? g : 0) }')
else
  program_cost=$(awk -v r="$rent" 'BEGIN { print r * 2 }')
fi
need=$(awk -v p="$program_cost" -v s="$RESERVE_SOL" 'BEGIN { printf "%.2f", p + s + 0.2 }')
balance=$(solana balance -k "$wallet" -u devnet | awk '{print $1}')
echo "Deployer $address, balance $balance SOL, needs about $need SOL."
if awk -v b="$balance" -v n="$need" 'BEGIN { exit !(b < n) }'; then
  echo "Not enough SOL. Send $need SOL on devnet to $address (from Phantom in testnet mode or https://faucet.solana.com), then run this again."
  exit 1
fi

anchor deploy --provider.cluster devnet --provider.wallet "$wallet"
# The exchange for investing: created once, SOL reserve topped up to RESERVE_SOL from the deployer.
ANCHOR_WALLET="$wallet" node scripts/init-exchange.mjs
echo "Deployed: https://explorer.solana.com/address/$(solana address -k target/deploy/easypay-keypair.json)?cluster=devnet"
