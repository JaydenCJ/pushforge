#!/usr/bin/env bash
# Smoke test for pushforge: exercises the real CLI end to end — keygen,
# mock subscriber, store, encrypted dry-run send, decrypt round-trip and the
# delivery queue — in a throwaway temp dir. No network, idempotent, runs
# from a clean checkout (after `npm install`). Prints "SMOKE OK" on success.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "SMOKE FAIL: $1" >&2
  exit 1
}

# 1. Build (idempotent).
npm run build >/dev/null 2>&1 || fail "npm run build failed"
PF="node $ROOT/dist/cli.js"
echo "[smoke] build ok"

# 2. --version matches package.json; --help documents the surface.
PKG_VERSION="$(node -p "require('$ROOT/package.json').version")"
CLI_VERSION="$($PF --version)"
[ "$CLI_VERSION" = "$PKG_VERSION" ] || fail "--version mismatch: $CLI_VERSION != $PKG_VERSION"
HELP="$($PF --help)"
for word in keygen mock add list remove send enqueue drain queue-status decrypt --dry-run; do
  echo "$HELP" | grep -q -- "$word" || fail "--help missing $word"
done
echo "[smoke] --help/--version ok ($CLI_VERSION)"

# 3. Usage errors exit 2 (distinct from operational failures' 1).
cd "$WORKDIR"
set +e
$PF --frobnicate >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "unknown flag should exit 2"; }
$PF frobnicate >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "unknown command should exit 2"; }
$PF send "x" --vapid missing.json --all --dry-run >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "missing vapid file should exit 2"; }
set -e
echo "[smoke] usage errors ok (exit 2)"

# 4. keygen: creates the key file, prints the applicationServerKey, refuses overwrite.
KEYGEN_OUT="$($PF keygen --subject mailto:ops@example.test --out vapid.json)"
echo "$KEYGEN_OUT" | grep -q "applicationServerKey" || fail "keygen output missing applicationServerKey"
[ -f vapid.json ] || fail "vapid.json not written"
set +e
$PF keygen --out vapid.json >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "keygen overwrite should exit 2"; }
set -e
echo "[smoke] keygen ok"

# 5. mock: a browser-shaped subscription + separate private secrets file.
$PF mock > sub.json 2>/dev/null
[ -f ua-keys.json ] || fail "ua-keys.json not written"
grep -q '"p256dh"' sub.json || fail "mock subscription missing p256dh"
grep -q '"d"' sub.json && fail "mock subscription leaked a private key"
echo "[smoke] mock subscriber ok"

# 6. add (file + stdin) and list with tag filtering.
ADD_OUT="$($PF add sub.json --tag beta)"
echo "$ADD_OUT" | grep -q "^added " || fail "add from file failed"
$PF mock --keys-out ua2-keys.json 2>/dev/null > sub2.json
$PF add sub2.json --tag ops >/dev/null || fail "add from file 2 failed"
LIST_OUT="$($PF list)"
echo "$LIST_OUT" | grep -q "2 subscriptions" || fail "list should show 2 subscriptions"
$PF list --tag beta | grep -q "1 subscription" || fail "tag filter should show 1 subscription"
echo "$LIST_OUT" | grep -q "/send/" && fail "list must not echo full capability URLs"
echo "[smoke] store ok (2 subscriptions, tag filter works)"

# 7. Encrypted dry-run send: real RFC 8291 encryption, request written to disk.
MESSAGE="Deploy finished: v2.4.1 is live"
SEND_OUT="$($PF send "$MESSAGE" --vapid vapid.json --tag beta --topic deploys --ttl 600 --dry-run --out outbox)"
echo "$SEND_OUT" | grep -q "\[dry-run\]" || fail "dry-run send produced no output"
BODY_FILE="$(ls outbox/*.body)"
HEADERS_FILE="$(ls outbox/*.headers.json)"
grep -q '"Content-Encoding": "aes128gcm"' "$HEADERS_FILE" || fail "missing aes128gcm header"
grep -q '"Authorization": "vapid t=' "$HEADERS_FILE" || fail "missing VAPID authorization"
grep -q '"Topic": "deploys"' "$HEADERS_FILE" || fail "missing Topic header"
grep -q '"TTL": "600"' "$HEADERS_FILE" || fail "missing TTL header"
echo "[smoke] dry-run send ok (headers + body on disk)"

# 8. Decrypt round-trip: the body opens with the subscriber keys, byte-exact.
PLAIN="$($PF decrypt "$BODY_FILE")"
[ "$PLAIN" = "$MESSAGE" ] || fail "decrypt mismatch: got '$PLAIN'"
echo "[smoke] decrypt round-trip ok"

# 9. Wrong subscriber keys must fail with exit 1 (operational, not usage).
set +e
$PF decrypt "$BODY_FILE" --keys ua2-keys.json >/dev/null 2>&1; CODE=$?
set -e
[ "$CODE" -eq 1 ] || fail "decrypt with wrong keys should exit 1, got $CODE"
echo "[smoke] wrong-key decrypt rejected ok (exit 1)"

# 10. Fresh salt + ephemeral keys: same message twice never yields the same body.
$PF send "$MESSAGE" --vapid vapid.json --tag beta --dry-run --out outbox2 >/dev/null
cmp -s "$BODY_FILE" "$(ls outbox2/*.body)" && fail "two encryptions must not be byte-identical"
echo "[smoke] per-message ephemeral encryption ok"

# 11. Queue: enqueue, inspect, dry-run drain.
ENQ_OUT="$($PF enqueue "queued release note" --all --max-attempts 3)"
echo "$ENQ_OUT" | grep -q "enqueued 2 jobs" || fail "enqueue failed"
STATUS_OUT="$($PF queue-status)"
echo "$STATUS_OUT" | grep -q "pending=2" || fail "queue-status should show 2 pending"
DRAIN_OUT="$($PF drain --dry-run)"
echo "$DRAIN_OUT" | grep -q "2 jobs due" || fail "drain --dry-run should list 2 jobs"
echo "[smoke] delivery queue ok (2 jobs pending)"

# 12. remove prunes the store.
ID="$($PF list | head -n 1 | cut -d' ' -f1)"
REMOVE_OUT="$($PF remove "$ID")"
echo "$REMOVE_OUT" | grep -q "removed" || fail "remove failed"
$PF list | grep -q "1 subscription" || fail "store should have 1 subscription left"
echo "[smoke] remove ok"

echo "SMOKE OK"
