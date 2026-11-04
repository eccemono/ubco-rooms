#!/usr/bin/env python3
"""Merge optional room metadata (capacity, layout, features, hours) into schedule.json.

CSV columns:
    room,capacity,layout,features,hours
    SCI 333,109,Tiered classroom,projector;av,M-F 07:30-22:00

`room` must match the room name (e.g. "SCI 333") or id ("SCI-333").
Only supplied fields are changed. Unknown rooms are reported, not created.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = ROOT / "data" / "schedule.json"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("csv", type=Path)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    args = parser.parse_args()

    payload = json.loads(args.data.read_text())
    by_key = {}
    for room in payload["rooms"]:
        by_key[room["id"].lower()] = room
        by_key[room["name"].lower()] = room
        by_key[f"{room['buildingCode']} {room['number']}".lower()] = room

    updated = 0
    missing = []
    with args.csv.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        required = {"room"}
        if not required.issubset({(name or "").strip() for name in (reader.fieldnames or [])}):
            raise SystemExit("CSV must have a 'room' column.")
        for row in reader:
            key = (row.get("room") or "").strip().lower()
            room = by_key.get(key)
            if not room:
                missing.append(row.get("room"))
                continue
            if row.get("capacity"):
                try:
                    room["capacity"] = int(float(row["capacity"]))
                except ValueError:
                    pass
            if row.get("layout"):
                room["layout"] = row["layout"].strip()
            if row.get("features"):
                room["features"] = [x.strip() for x in row["features"].replace(",", ";").split(";") if x.strip()]
            if row.get("hours"):
                room["hours"] = row["hours"].strip()
            if row.get("buildingName"):
                room["buildingName"] = row["buildingName"].strip()
            updated += 1

    args.data.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"Updated {updated} rooms in {args.data}")
    if missing:
        print(f"WARNING: {len(missing)} rooms not found: {', '.join(map(str, missing[:20]))}")


if __name__ == "__main__":
    main()
