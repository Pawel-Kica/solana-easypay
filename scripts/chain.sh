#!/usr/bin/env bash
# The local dev stack: an offline Surfpool chain with our program, the Vite app and the auto-claim server.
# Run from the repo root, on the Mac or in the devcontainer (on the Mac it re-runs itself in the container):
#   bash scripts/chain.sh dev                 foreground, what `pnpm dev` runs, Ctrl+C stops it
#   bash scripts/chain.sh start   [options]   in the background, returns once the program and the app answer
#   bash scripts/chain.sh stop    [options]
#   bash scripts/chain.sh restart [options]   a fresh chain: Surfpool keeps state in memory only
#   bash scripts/chain.sh status  [options]
#   bash scripts/chain.sh smoke   [options]   browser smoke test (app/tests/smoke.mjs) on its own stack, default
#                                             port 38899, stops the stack after
# Options:
#   --port N        RPC port, default 8899. Websocket N+1, Vite 5173+(N-8899), Studio 18488+(N-8899).
#                   Only the 8899 set is published to the Mac. Agents and scripts take their own N so they never touch
#                   the chain someone is clicking on.
#   --no-build      skip anchor build and deploy the .so already in target/deploy
#   --chain-only    start, stop or restart only the chain, not Vite and auto-claim
# The chain runs offline, without a devnet fork. scripts/chain-snapshot.json gives it the USDC mint and the 3 Pyth
# feeds (refresh with node scripts/make-snapshot.mjs). On 8899 Surfpool's runbook deploys the program and --watch
# redeploys it after every anchor build. Other ports deploy once with solana program deploy: Surfpool's runbook
# always deploys to 8899, whatever the port. Background logs and pids: /tmp/easypay-N/ in the container.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v anchor > /dev/null; then
  export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
  container=$(docker ps -q --filter "label=devcontainer.local_folder=$PWD" | head -1)
  [ -n "$container" ] || { echo "Devcontainer is not running. Open the repo in VS Code or start it with the devcontainers CLI."; exit 1; }
  tty=$([ -t 0 ] && echo -t || true)
  exec docker exec -i $tty "$container" bash /workspaces/repo/scripts/chain.sh "$@"
fi

cmd=${1:-}
[ $# -gt 0 ] && shift
port=$([ "$cmd" = smoke ] && echo 38899 || echo 8899) build=1 chain_only=0
while [ $# -gt 0 ]; do
  case $1 in
    --port) port=$2; shift ;;
    --no-build) build=0 ;;
    --chain-only) chain_only=1 ;;
    *) echo "Unknown option $1"; exit 1 ;;
  esac
  shift
done
offset=$((port - 8899))
ws_port=$((port + 1)) web_port=$((5173 + offset)) studio_port=$((18488 + offset))
rpc=http://127.0.0.1:$port
dir=/tmp/easypay-$port
program=$(solana address -k target/deploy/easypay-keypair.json)

rpc_call() {
  curl -s -m 2 "$rpc" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"
}
chain_up() { rpc_call getHealth '[]' | grep -q '"ok"'; }
program_up() { rpc_call getAccountInfo "[\"$program\",{\"encoding\":\"base64\",\"dataSlice\":{\"offset\":0,\"length\":0}}]" | grep -q '"executable":true'; }
web_up() { curl -s -m 2 -o /dev/null "http://127.0.0.1:$web_port"; }

# The three processes. Each runs in the foreground, `dev` runs them under concurrently, `start` under setsid.
run_chain() {
  local flags=(--offline --snapshot scripts/chain-snapshot.json --port "$port" --ws-port "$ws_port"
    --studio-port "$studio_port" --no-tui --host 0.0.0.0)
  if [ "$port" = 8899 ]; then exec surfpool start "${flags[@]}" --watch; fi
  surfpool start "${flags[@]}" --no-deploy &
  local pid=$!
  trap 'kill $pid 2> /dev/null' EXIT
  until chain_up; do sleep 0.5; done
  solana program deploy target/deploy/easypay.so --program-id target/deploy/easypay-keypair.json -u "$rpc"
  wait $pid
}
run_web() {
  # .env.local may point the Mac's browser at a remapped 8899, an explicit env var wins over it.
  [ "$port" = 8899 ] || export VITE_RPC_URL="http://localhost:$port"
  exec pnpm --filter app exec vite --port "$web_port" --strictPort
}
run_auto() { RPC_URL=$rpc exec pnpm --filter app autoclaim; }

services() { if [ $chain_only = 1 ]; then echo chain; else echo chain web auto; fi; }

start() {
  mkdir -p "$dir"
  for s in $(services); do
    if [ -f "$dir/$s.pid" ] && kill -0 "$(cat "$dir/$s.pid")" 2> /dev/null; then echo "$s already runs on $port"; exit 1; fi
  done
  [ $build = 0 ] || anchor build
  for s in $(services); do
    setsid nohup bash scripts/chain.sh "_$s" --port "$port" > "$dir/$s.log" 2>&1 < /dev/null &
    echo $! > "$dir/$s.pid"
  done
  local waited=0
  until program_up && { [ $chain_only = 1 ] || web_up; }; do
    sleep 1
    waited=$((waited + 1))
    [ $waited -lt 120 ] || { echo "Not ready after 120 s, see $dir/*.log"; exit 1; }
  done
  status
}

stop() {
  for s in $(services); do
    [ -f "$dir/$s.pid" ] || continue
    kill -- -"$(cat "$dir/$s.pid")" 2> /dev/null || true
    rm "$dir/$s.pid"
  done
  local waited=0
  while chain_up && [ $waited -lt 20 ]; do sleep 0.5; waited=$((waited + 1)); done
  if chain_up; then echo "Something still serves $port. Not started by chain.sh? Stop it with Ctrl+C where it runs."; exit 1; fi
}

status() {
  echo "chain   $rpc $(chain_up && echo up || echo down), program $(program_up && echo deployed || echo missing)"
  echo "app     http://localhost:$web_port/app $(web_up && echo up || echo down)"
  echo "logs    $dir/"
}

case $cmd in
  dev)
    [ $build = 0 ] || anchor build
    exec pnpm exec concurrently -k -n chain,web,auto -c magenta,cyan,yellow \
      "bash scripts/chain.sh _chain --port $port" "bash scripts/chain.sh _web --port $port" \
      "bash scripts/chain.sh _auto --port $port"
    ;;
  start) start ;;
  stop) stop ;;
  restart) stop && start ;;
  status) status ;;
  smoke)
    # A no-op once the browser is there. Its system libraries come with the devcontainer's postCreateCommand.
    (cd app && pnpm exec playwright install chromium-headless-shell > /dev/null)
    trap stop EXIT
    start
    PORT=$port node app/tests/smoke.mjs
    ;;
  _chain) run_chain ;;
  _web) run_web ;;
  _auto) run_auto ;;
  *) awk 'NR > 1 && !/^#/ { exit } NR > 1' "$0"; exit 1 ;;
esac
