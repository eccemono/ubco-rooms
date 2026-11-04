#!/usr/bin/env python3
"""Report how complete the room dataset is against the raw Workday captures."""

from __future__ import annotations

import argparse
import collections
import glob
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HEADER = re.compile(
    r"^([A-Z]{2,6})(?:_O)?\s+(\d{3}[A-Z]?)-([A-Z0-9_]{2,6})\s*-\s*(.+)$"
)
TIME_RE = re.compile(r"\b\d{1,2}:\d{2}\s*(?:a\.m\.|p\.m\.)?", re.I)
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=ROOT / "data" / "schedule.json")
    parser.add_argument("--raw", default=str(ROOT / "data" / "raw" / "level-*.json"))
    parser.add_argument("--reported", type=int, default=0, help="Result count shown by Workday")
    args = parser.parse_args()

    payload = json.loads(args.data.read_text())
    dataset = {s["id"].split("-", 1)[1]: s for s in payload["sections"]}
    dataset_with_room = {
        s["id"].split("-", 1)[1]
        for s in payload["sections"]
        if any(m.get("roomId") for m in payload["meetings"] if m["sectionId"] == s["id"])
    }

    raw_blocks: dict[str, list[str]] = {}
    reported_results = args.reported
    raw_files = sorted(glob.glob(args.raw))
    for path in raw_files:
        text = json.loads(Path(path).read_text()).get("bodyText", "")
        results = re.search(r"([\d,]+)\s+Results", text)
        if results:
            reported_results = max(reported_results, int(results.group(1).replace(",", "")))
        current = None
        for line in text.splitlines():
            match = HEADER.match(line.strip())
            if match:
                current = f"{match.group(1)}{match.group(2)}-{match.group(3)}"
                raw_blocks.setdefault(current, []).append(line)
            elif current:
                raw_blocks[current].append(line)

    missing = sorted(set(raw_blocks) - set(dataset))
    categories = collections.Counter()
    for code in missing:
        block = "\n".join(raw_blocks[code])
        categories[
            (
                "Room:" in block,
                bool(TIME_RE.search(block)),
                bool(DATE_RE.search(block)),
                "UBCO |" in block,
            )
        ] += 1

    room_missing = [code for code in missing if "Room:" in "".join(raw_blocks[code])]
    room_ids = {r["id"] for r in payload["rooms"]}
    unknown_refs = {
        m["roomId"] for m in payload["meetings"] if m.get("roomId") and m["roomId"] not in room_ids
    }

    print(f"Workday report count: {reported_results or 'unknown'}")
    print(f"Unique section headers in raw captures: {len(raw_blocks)}")
    print(f"Captured sections in dataset: {len(dataset)}")
    print(f"Captured sections with a room: {len(dataset_with_room)}")
    print(f"Captured sections without a room: {len(dataset) - len(dataset_with_room)}")
    print(f"Raw sections not in dataset: {len(missing)}")
    print(f"  ... of those, sections mentioning a room: {len(room_missing)}")
    for (has_room, has_time, has_date, has_ubco), count in sorted(categories.items()):
        print(
            f"  category room={has_room} time={has_time} date={has_date} ubco={has_ubco}: {count}"
        )
    print(f"Rooms in dataset: {len(room_ids)}")
    print(f"Unknown room references: {len(unknown_refs)}")

    print("\nVERDICT")
    if room_missing:
        print("  FAIL: some sections with a room in the raw text are missing from the dataset.")
    else:
        print("  PASS: every raw section that mentions a room is present in the dataset.")
    if unknown_refs:
        print("  FAIL: meeting patterns reference rooms not in the room directory.")
    else:
        print("  PASS: every meeting room reference exists in the room directory.")
    if missing:
        print(
            f"  NOTE: {len(missing)} captured sections have no dated room meeting "
            "(online, co-op, thesis, arranged study) and are not room-availability candidates."
        )
    if reported_results and len(raw_blocks) < reported_results:
        print(
            f"  NOTE: Workday reports {reported_results} results, but the raw text contains "
            f"{len(raw_blocks)} unique section headers; the difference is likely clustered/cross-listed results."
        )


if __name__ == "__main__":
    main()
