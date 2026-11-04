#!/usr/bin/env python3
"""Validate schedule.json before building or publishing.

Exit code 1 on structural errors. Warnings do not fail the build.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT = ROOT / "data" / "schedule.json"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("data", nargs="?", type=Path, default=DEFAULT)
    parser.add_argument("--strict", action="store_true", help="Fail on warnings too")
    args = parser.parse_args()

    payload = json.loads(args.data.read_text())
    errors: list[str] = []
    warnings: list[str] = []

    for key in ("meta", "rooms", "sections", "meetings"):
        if key not in payload:
            errors.append(f"missing top-level key: {key}")
    if errors:
        print("\n".join(errors))
        raise SystemExit(1)

    meta = payload["meta"]
    rooms = payload["rooms"]
    sections = payload["sections"]
    meetings = payload["meetings"]

    room_ids = {r.get("id") for r in rooms}
    section_ids = {s.get("id") for s in sections}
    if len(room_ids) != len(rooms):
        errors.append("duplicate room ids")
    if len(section_ids) != len(sections):
        errors.append("duplicate section ids")

    for s in sections:
        for field in ("id", "term", "subject", "courseNumber", "title", "section"):
            if not s.get(field):
                warnings.append(f"section {s.get('id', '?')} missing {field}")

    unknown_rooms = Counter()
    bad_times = 0
    for m in meetings:
        if m.get("sectionId") not in section_ids:
            errors.append(f"meeting {m.get('id')} references unknown section {m.get('sectionId')}")
        if m.get("roomId") and m["roomId"] not in room_ids:
            unknown_rooms[m["roomId"]] += 1
        if not re.fullmatch(r"\d{2}:\d{2}", str(m.get("start", ""))) or not re.fullmatch(
            r"\d{2}:\d{2}", str(m.get("end", ""))
        ):
            bad_times += 1
        if not m.get("days"):
            warnings.append(f"meeting {m.get('id')} has no days")
        if m.get("start") and m.get("end") and m["start"] >= m["end"]:
            bad_times += 1
    if bad_times:
        errors.append(f"{bad_times} meetings have invalid times")
    if unknown_rooms:
        errors.append(f"unknown room references: {dict(unknown_rooms)}")

    no_room = sum(
        1
        for s in sections
        if not any(m.get("sectionId") == s["id"] and m.get("roomId") for m in meetings)
    )
    if no_room:
        warnings.append(f"{no_room} sections have no room")

    term_keys = {t.get("key") for t in meta.get("terms", [])}
    for s in sections:
        if s.get("term") not in term_keys:
            errors.append(f"section {s.get('id')} has term {s.get('term')} not in meta.terms")

    counts = meta.get("counts", {})
    if counts:
        if counts.get("sections") not in (None, len(sections)):
            warnings.append(f"meta.counts.sections={counts.get('sections')} but file has {len(sections)}")
        if counts.get("meetings") not in (None, len(meetings)):
            warnings.append(f"meta.counts.meetings={counts.get('meetings')} but file has {len(meetings)}")

    print(f"{args.data}: {len(sections)} sections, {len(meetings)} meetings, {len(rooms)} rooms")
    print(f"Terms: {', '.join(sorted(term_keys))}")
    for w in warnings:
        print(f"WARN  {w}")
    for e in errors:
        print(f"ERROR {e}")
    if errors or (args.strict and warnings):
        raise SystemExit(1)
    print("OK")


if __name__ == "__main__":
    main()
