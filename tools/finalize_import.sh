#!/usr/bin/env bash
# Import the newest Workday Excel export, validate it, rebuild the workbook,
# run the engine checks, and publish only if the basic sanity checks pass.
set -euo pipefail
cd "$(dirname "$0")/.."

xlsx="$(find data/raw -maxdepth 1 -type f \( -name '*.xlsx' -o -name '*.xlsm' \) -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
if [ -z "${xlsx}" ]; then
  echo "No .xlsx export found in data/raw" >&2
  exit 1
fi

echo "Importing: $xlsx"
tmp="$(mktemp -d)/schedule.json"
.venv/bin/python tools/import_workday.py "$xlsx" --out "$tmp"

.venv/bin/python - "$tmp" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
m = d["meta"]
counts = m["counts"]
terms = {t["key"] for t in m.get("terms", [])}
print(f"Parsed: {counts['sections']} sections, {counts['meetings']} meetings, {counts['rooms']} rooms, terms={sorted(terms)}")
if counts["sections"] < 1000:
    raise SystemExit("Refusing to publish: fewer than 1000 sections parsed. Check the export columns.")
if counts["meetings"] < 1000:
    raise SystemExit("Refusing to publish: fewer than 1000 meetings parsed. Check the meeting-pattern column.")
if not counts["rooms"]:
    raise SystemExit("Refusing to publish: no rooms parsed.")
if len(terms) < 2:
    raise SystemExit("Refusing to publish: expected both 2026W1 and 2026W2.")
PY

cp "$(dirname "$tmp")/import-report.json" data/import-report.json
mv "$tmp" data/schedule.json
.venv/bin/python tools/validate_data.py
.venv/bin/python tools/build_workbook.py
node tools/test_engine.mjs

git add data/schedule.json exports/ubco-2026-27.xlsx data/import-report.json 2>/dev/null || true
if git diff --cached --quiet; then
  echo "No changes to publish."
  exit 0
fi
git -c user.name='Builder' -c user.email='builder@localhost' commit -m "Import real Workday 2026-27 room data"
git push
echo "Published real dataset."
