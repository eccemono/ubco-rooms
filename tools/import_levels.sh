#!/usr/bin/env bash
# Parse all level-*.json captures and merge them into data/schedule.json.
set -euo pipefail
cd "$(dirname "$0")/.."

shopt -s nullglob
files=(data/raw/level-*.json)
if [ ${#files[@]} -eq 0 ]; then
  echo "No data/raw/level-*.json captures found." >&2
  exit 1
fi

parsed=()
for f in "${files[@]}"; do
  base="$(basename "$f" .json)"
  out="data/raw/parsed-${base}.json"
  .venv/bin/python tools/parse_workday_text.py "$f" --out "$out"
  parsed+=("$out")
done

.venv/bin/python tools/merge_parsed.py "${parsed[@]}"
.venv/bin/python tools/validate_data.py
.venv/bin/python tools/build_workbook.py
node tools/test_engine.mjs
