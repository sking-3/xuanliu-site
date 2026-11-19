#!/usr/bin/env bash
set -euo pipefail

exchange_files=(
  trader/okx/trades.json
  trader/okx/period-returns.json
  trader/bitget/period-returns.json
)
scope=${1-}
if (( $# == 0 )) && [[ ${REFRESH_MODE-} == positions ]]; then
  scope=--hyperliquid-positions
fi
case "$scope" in
  '') files=(trader/feed.json trader/analytics.json trader/portfolios.json "${exchange_files[@]}") ;;
  --exchange-only) files=("${exchange_files[@]}") ;;
  --hyperliquid-positions) files=(trader/feed.json) ;;
  --period-bundle) files=(trader/feed.json trader/period-samples.json) ;;
  *) echo 'Usage: verify-trader-vps-publication.sh [--exchange-only|--hyperliquid-positions|--period-bundle]' >&2; exit 2 ;;
esac
if (( $# > 1 )); then
  echo 'Usage: verify-trader-vps-publication.sh [--exchange-only|--hyperliquid-positions|--period-bundle]' >&2
  exit 2
fi

root=$(cd "$(dirname -- "$0")/.." && pwd -P)
revision=$(git -C "$root" rev-parse --verify HEAD)
origin=https://45-77-39-98.sslip.io
fills=trader/hyperliquid-fills.json
archive_origin=https://raw.githubusercontent.com/sking-3/xuanliu-site/main
if [[ $scope == --hyperliquid-positions ]] && git -C "$root" cat-file -e "$revision:$fills"; then
  files+=("$fills")
fi
expected=()
for file in "${files[@]}"; do
  digest=$(git -C "$root" show "$revision:$file" | sha256sum)
  expected+=("${digest%% *}")
done

# curl appends the HTTP code after the body. Hash the unmodified body, retaining
# only those three last bytes to test the status without temporary files.
hash_response() {
  python3 -c '
import hashlib
import sys

digest = hashlib.sha256()
tail = b""
for chunk in iter(lambda: sys.stdin.buffer.read(65536), b""):
    data = tail + chunk
    digest.update(data[:-3])
    tail = data[-3:]
if len(tail) != 3 or not tail.isdigit():
    raise SystemExit("Invalid HTTP status from curl")
print(tail.decode("ascii"), digest.hexdigest())
'
}

deadline=$((SECONDS + 420))
attempt=0
echo "Waiting for $origin to publish the trader catalogs from $revision"
while (( SECONDS < deadline )); do
  attempt=$((attempt + 1))
  mismatches=0
  echo "Verification pass $attempt"
  for index in "${!files[@]}"; do
    file=${files[index]}
    file_origin=$origin
    if [[ $file == "$fills" ]]; then file_origin=$archive_origin; fi
    left=$((deadline - SECONDS))
    if (( left <= 0 )); then
      mismatches=$((mismatches + 1))
      echo "  $file: verification deadline reached"
      continue
    fi
    timeout=$((left < 20 ? left : 20))
    cache_key="$revision-$(date +%s)-$attempt"
    if ! result=$(curl --disable --silent --show-error --proto '=https' --tlsv1.2 \
      --connect-timeout 5 --max-time "$timeout" --max-filesize 33554432 \
      --header 'Cache-Control: no-cache' --header 'Accept-Encoding: identity' \
      --write-out '%{http_code}' "$file_origin/$file?verify=$cache_key" | hash_response); then
      echo "  $file: failed to read HTTPS response"
      mismatches=$((mismatches + 1))
      continue
    fi
    read -r status actual <<< "$result"
    if [[ $status != 200 ]]; then
      echo "  $file: HTTP $status"
    elif [[ $actual != "${expected[index]}" ]]; then
      echo "  $file: SHA-256 mismatch (expected ${expected[index]}, received $actual)"
    else
      echo "  $file: verified $actual"
      continue
    fi
    mismatches=$((mismatches + 1))
  done
  if (( mismatches == 0 )); then
    echo "Verified all ${#files[@]} trader catalogs at $origin"
    exit 0
  fi
  left=$((deadline - SECONDS))
  if (( left > 0 )); then
    sleep "$((left < 15 ? left : 15))"
  fi
done

echo 'Formal VPS trader publication did not match the committed catalogs within 7 minutes.' >&2
exit 1
