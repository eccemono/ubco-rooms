#!/usr/bin/env python3
"""Merge parsed Workday level slices into data/schedule.json."""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "data" / "schedule.json"

TERMS = {
    "2026W1": {
        "key": "2026W1",
        "label": "2026-27 Winter Term 1",
        "start": "2026-09-08",
        "end": "2026-12-09",
    },
    "2026W2": {
        "key": "2026W2",
        "label": "2026-27 Winter Term 2",
        "start": "2027-01-05",
        "end": "2027-04-09",
    },
}

NON_TEACHING = [
    {"start": "2026-09-30", "end": "2026-09-30", "reason": "National Day for Truth and Reconciliation (university closed)"},
    {"start": "2026-10-12", "end": "2026-10-12", "reason": "Thanksgiving Day (university closed)"},
    {"start": "2026-11-09", "end": "2026-11-13", "reason": "Winter Term 1 midterm break"},
    {"start": "2026-11-11", "end": "2026-11-11", "reason": "Remembrance Day (university closed)"},
    {"start": "2026-12-10", "end": "2027-01-04", "reason": "Winter break between terms"},
    {"start": "2027-02-15", "end": "2027-02-19", "reason": "Winter Term 2 midterm break"},
    {"start": "2027-03-26", "end": "2027-03-26", "reason": "Good Friday (university closed)"},
    {"start": "2027-03-29", "end": "2027-03-29", "reason": "Easter Monday (university closed)"},
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    sections: dict[str, dict] = {}
    meetings: dict[str, dict] = {}
    rooms: dict[str, dict] = {}
    warnings: list[str] = []

    for path in args.inputs:
        data = json.loads(path.read_text())
        for section in data.get("sections", []):
            if section.get("term") in TERMS:
                sections[section["id"]] = section
        for meeting in data.get("meetings", []):
            if meeting.get("sectionId") in sections:
                meetings[meeting["id"]] = meeting
        for room in data.get("rooms", []):
            rooms[room["id"]] = room
        warnings.extend(data.get("meta", {}).get("warnings", []))

    missing_rooms = len(
        {s["id"] for s in sections.values()}
        - {m["sectionId"] for m in meetings.values() if m.get("roomId")}
    )

    payload = {
        "meta": {
            "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "academicYear": "2026-27",
            "campus": "UBC Okanagan",
            "source": "Workday Find Course Sections — full text capture by course level",
            "sourceUrl": "https://wd10.myworkday.com/ubc/",
            "demo": False,
            "terms": [TERMS[k] for k in sorted(TERMS)],
            "counts": {
                "sections": len(sections),
                "meetings": len(meetings),
                "rooms": len(rooms),
                "sectionsWithoutRoom": missing_rooms,
            },
            "nonTeachingPeriods": NON_TEACHING,
            "coverage": {
                "levels": ["Graduate", "Undergraduate"],
                "terms": sorted(TERMS),
                "collectionMethod": "Workday report text captured by course level",
                "sourceFiles": [str(p) for p in args.inputs],
            },
            "warnings": [
                "Captured from Workday Find Course Sections in five course-level slices (100–500).",
                "Sections with no dated meeting pattern (work terms, asynchronous online, arranged studies) were skipped.",
                "Room capacities are mostly unknown; building hours are defaults and must be verified.",
                "This dataset only knows scheduled classes. Events, exams and ad-hoc bookings are not included.",
            ]
            + warnings[:50],
        },
        "rooms": sorted(rooms.values(), key=lambda r: (r.get("buildingCode", ""), r.get("number", ""))),
        "sections": sorted(
            sections.values(),
            key=lambda s: (s["term"], s["subject"], s["courseNumber"], s["section"]),
        ),
        "meetings": sorted(
            meetings.values(),
            key=lambda m: (m.get("startDate") or "", m["start"], m.get("roomId") or ""),
        ),
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"Wrote {args.out}")
    print(
        f"{len(sections)} sections, {len(meetings)} meetings, {len(rooms)} rooms, "
        f"{missing_rooms} sections without a room"
    )


if __name__ == "__main__":
    main()
