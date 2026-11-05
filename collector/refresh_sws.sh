#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STATE="${SWS_STORAGE_STATE:-$ROOT/collector/.sws-storage-state.json}"
RAW="$ROOT/data/raw/sws-2026-27-allrooms-allweeks.txt"
OUT="$ROOT/data/sws-2026-27.json"
STATUS="$ROOT/data/raw/sws-refresh-status.json"
STARTED="$(date -Iseconds)"

mkdir -p "$(dirname "$RAW")"
write_status() {
  local code="$1"
  local message="$2"
  printf '{"startedAt":"%s","finishedAt":"%s","exitCode":%s,"message":"%s"}\n' \
    "$STARTED" "$(date -Iseconds)" "$code" "${message//\"/\\\"}" > "$STATUS"
}

if [ ! -f "$STATE" ]; then
  echo "Missing SWS storage state: $STATE" >&2
  echo "Run: node collector/capture_sws.mjs --interactive" >&2
  write_status 2 "missing authenticated session"
  exit 2
fi

if node collector/capture_sws.mjs \
  --storage-state="$STATE" \
  --scope=all \
  --output="$RAW" \
  --timeout=300000; then
  :
else
  code=$?
  write_status "$code" "SWS capture failed; previous data kept"
  exit "$code"
fi

if python3 tools/parse_sws.py --input "$RAW" --output "$OUT"; then
  :
else
  code=$?
  write_status "$code" "SWS parse failed; previous JSON kept"
  exit "$code"
fi

write_status 0 "ok"
