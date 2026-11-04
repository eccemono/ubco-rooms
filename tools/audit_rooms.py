#!/usr/bin/env python3
"""Audit the room directory and meeting references against the raw captures."""

from __future__ import annotations

import argparse
import collections
import glob
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=ROOT / "data" / "schedule.json")
    parser.add_argument("--raw", default=str(ROOT / "data" / "raw" / "level-*.json"))
    args = parser.parse_args()

    payload = json.loads(args.data.read_text())
    rooms = payload["rooms"]
    meetings = payload["meetings"]

    raw_text = ""
    raw_files = sorted(glob.glob(args.raw))
    for path in raw_files:
        raw_text += json.loads(Path(path).read_text()).get("bodyText", "") + "\n"

    raw_rooms = collections.Counter()
    for m in re.finditer(r"\(([A-Z]{2,5})\)\s*\|\s*Floor:[^|]*\|\s*Room:\s*([A-Z0-9]+)", raw_text, re.I):
        raw_rooms[f"{m.group(1).upper()}-{m.group(2).upper()}"] += 1

    room_ids = {r["id"] for r in rooms}
    room_names = collections.Counter(r["name"] for r in rooms)
    refs = collections.Counter(m["roomId"] for m in meetings if m.get("roomId"))
    meeting_keys = collections.Counter(
        (m["sectionId"], tuple(m["days"]), m["start"], m["end"], m.get("roomId"), m.get("startDate"), m.get("endDate"))
        for m in meetings
    )

    print(f"Raw captures: {len(raw_files)} files")
    print(f"Rooms in raw text: {len(raw_rooms)} unique")
    print(f"Rooms in dataset: {len(room_ids)} unique")

    issues = []
    if set(raw_rooms) - room_ids:
        issues.append(f"raw rooms missing from dataset: {sorted(set(raw_rooms) - room_ids)[:20]}")
    if room_ids - set(raw_rooms):
        issues.append(f"dataset rooms not found in raw text: {sorted(room_ids - set(raw_rooms))[:20]}")
    if [n for n, c in room_names.items() if c > 1]:
        issues.append(f"duplicate room names: {[n for n, c in room_names.items() if c > 1][:20]}")
    if [k for k, c in meeting_keys.items() if c > 1]:
        issues.append(f"duplicate meeting patterns: {sum(c - 1 for c in meeting_keys.values() if c > 1)}")
    if set(refs) - room_ids:
        issues.append(f"unknown room references: {sorted(set(refs) - room_ids)[:20]}")
    if room_ids - set(refs):
        issues.append(f"rooms with no meeting: {sorted(room_ids - set(refs))[:20]}")

    # Same room, same day, overlapping actual dates and times.
    by_room_day: dict[tuple, list] = collections.defaultdict(list)
    for m in meetings:
        if m.get("roomId"):
            for day in m.get("days", []):
                by_room_day[(m["roomId"], day)].append(m)
    overlaps = []
    for (room_id, day), rows in by_room_day.items():
        rows = sorted(rows, key=lambda m: m["start"])
        for i, a in enumerate(rows):
            for b in rows[i + 1:]:
                if b["start"] >= a["end"]:
                    break
                latest_start = max(a.get("startDate") or "", b.get("startDate") or "")
                earliest_end = min(a.get("endDate") or "9999-12-31", b.get("endDate") or "9999-12-31")
                if latest_start <= earliest_end:
                    overlaps.append((room_id, day, a["sectionId"], b["sectionId"], a["start"], a["end"]))
    if overlaps:
        # Cross-listed courses legitimately share a room. Report the count but
        # do not fail unless the same section is duplicated.
        same_section = [o for o in overlaps if o[2] == o[3]]
        if same_section:
            issues.append(f"same section overlapping itself: {same_section[:10]}")
        print(f"Cross-listed / shared-room overlaps: {len(overlaps)} (not necessarily errors)")

    for issue in issues:
        print(f"ISSUE {issue}")
    if not issues:
        print("OK: rooms and meeting references are internally consistent.")
    else:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
