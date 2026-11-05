#!/usr/bin/env python3
"""Parse the UBC SWS Okanagan 'List Timetable' room export.

Input is the tab-separated text from sws_2026/showtimetable.aspx after selecting
all rooms and all weeks. Output is a compact normalized JSON document that keeps
the original SWS fields, week ranges converted to calendar periods, and room
IDs aligned with data/schedule.json where possible.

Usage:
  python3 tools/parse_sws.py \
      --input data/raw/sws-2026-27-allrooms-allweeks.txt \
      --rooms data/raw/sws-2026-27-rooms.json \
      --schedule data/schedule.json \
      --output data/sws-2026-27.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

WEEK1_START = date(2026, 8, 24)  # SWS week 1 w/c 24 Aug 2026
DAY_INDEX = {"Mon": 1, "Tue": 2, "Wed": 3, "Thu": 4, "Fri": 5, "Sat": 6, "Sun": 0}
BUILDING_ALIASES = {
    "Arts Building": "ART",
    "ASC": "ASC",
    "CCS": "CCS",
    "COM Building": "COM",
    "EDL": "EDL",
    "EME Building": "EME",
    "Fipke Ctr": "FIP",
    "Library": "LIB",
    "Science Building": "SCI",
    "University Theatre": "THE",
}
COURSE_TYPES = {"LEC", "LAB", "DIS", "SEM", "EXP", "WRK", "STD", "IND"}
KIND = {
    "LEC": "Lecture",
    "LAB": "Laboratory",
    "DIS": "Discussion",
    "SEM": "Seminar",
    "EXP": "Experiential",
    "WRK": "Workshop",
    "STD": "Studio",
    "IND": "Independent Study",
}


def clean(value: str | None) -> str:
    return (value or "").replace("\xa0", " ").strip()


def hm(value: str) -> str | None:
    m = re.match(r"^(\d{1,2}):(\d{2})$", clean(value))
    if not m:
        return None
    h, minute = int(m.group(1)), int(m.group(2))
    if h > 23 or minute > 59:
        return None
    return f"{h:02d}:{minute:02d}"


def parse_weeks(value: str) -> list[int]:
    weeks: list[int] = []
    for token in clean(value).split(","):
        token = token.strip()
        if not token:
            continue
        if "-" in token:
            a, b = token.split("-", 1)
            try:
                start, end = int(a.strip()), int(b.strip())
            except ValueError:
                continue
            if start <= end:
                weeks.extend(range(start, end + 1))
        else:
            try:
                weeks.append(int(token))
            except ValueError:
                continue
    return sorted(set(w for w in weeks if 1 <= w <= 53))


def contiguous_ranges(weeks: list[int]) -> list[tuple[int, int]]:
    if not weeks:
        return []
    ranges = []
    start = prev = weeks[0]
    for week in weeks[1:]:
        if week == prev + 1:
            prev = week
            continue
        ranges.append((start, prev))
        start = prev = week
    ranges.append((start, prev))
    return ranges


def week_periods(weeks: list[int]) -> list[dict]:
    periods = []
    for start_week, end_week in contiguous_ranges(weeks):
        start = WEEK1_START + timedelta(days=(start_week - 1) * 7)
        end = WEEK1_START + timedelta(days=(end_week - 1) * 7 + 6)
        periods.append(
            {
                "startWeek": start_week,
                "endWeek": end_week,
                "startDate": start.isoformat(),
                "endDate": end.isoformat(),
            }
        )
    return periods


def parse_days(value: str) -> tuple[list[str], list[int]]:
    days = [d.strip() for d in clean(value).split(",") if d.strip()]
    indexes = sorted(DAY_INDEX[d] for d in days if d in DAY_INDEX)
    return days, indexes


def parse_room_label(label: str) -> dict:
    m = re.match(r"(.+?) - Room (.+?)(?: - (.*))?$", clean(label))
    if not m:
        return {"label": clean(label), "buildingName": "", "number": "", "type": "", "capacityGroup": ""}
    building_name, number, rest = m.groups()
    rest = clean(rest)
    capacity_group = ""
    room_type = rest
    cap = re.search(r"\(([^()]*seats?)\)", rest, re.I)
    if cap:
        capacity_group = cap.group(1).strip()
        room_type = re.sub(r"\s*\([^()]*seats?\)", "", rest, flags=re.I).strip(" -")
    return {
        "label": clean(label),
        "buildingName": clean(building_name),
        "number": clean(number),
        "type": room_type,
        "capacityGroup": capacity_group,
    }


def build_room_lookup(schedule_path: Path | None) -> tuple[dict[tuple[str, str], str], dict[str, dict]]:
    lookup: dict[tuple[str, str], str] = {}
    app_rooms: dict[str, dict] = {}
    if not schedule_path or not schedule_path.exists():
        return lookup, app_rooms
    try:
        schedule = json.loads(schedule_path.read_text(encoding="utf-8"))
    except Exception:
        return lookup, app_rooms
    for room in schedule.get("rooms", []):
        room_id = room.get("id")
        building = clean(room.get("buildingCode"))
        number = clean(room.get("number"))
        if not room_id or not building or not number:
            continue
        app_rooms[room_id] = room
        variants = {number, number.lstrip("0") or number}
        if number.upper().startswith("L") and len(number) > 1:
            variants.add(number[1:])
        for variant in variants:
            lookup[(building.upper(), variant.upper())] = room_id
    return lookup, app_rooms


def canonical_room(location: str, lookup: dict[tuple[str, str], str], building_names: dict[str, str]) -> tuple[str | None, str, str]:
    """Return (app room id, building code, normalized number)."""
    location = clean(location)
    if not location:
        return None, "", ""
    parts = location.split()
    building = parts[0].upper()
    number = " ".join(parts[1:]).strip()
    # Labels sometimes use a full building name rather than a short code.
    for name, code in building_names.items():
        if location.startswith(name):
            building = code
            number = location[len(name) :].strip()
            break
    if not number:
        return None, building, ""
    candidates = {number, number.lstrip("0") or number}
    if number.upper().startswith("L") and len(number) > 1:
        candidates.add(number[1:])
    for candidate in candidates:
        room_id = lookup.get((building, candidate.upper()))
        if room_id:
            return room_id, building, candidate
    return None, building, number


def classify(row: list[str]) -> tuple[str, bool]:
    name = clean(row[0])
    kind = clean(row[2])
    if kind == "WRB-CANCELLED":
        return "cancelled", False
    if kind == "WRB-ACTIVE":
        if name.lower() == "university closed":
            return "closure", True
        if re.search(r"\bexam\b|^DRC\b", name, re.I):
            return "exam", True
        return "event", True
    if kind in COURSE_TYPES:
        return "course", True
    return "other", True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="data/raw/sws-2026-27-allrooms-allweeks.txt")
    parser.add_argument("--rooms", default="data/raw/sws-2026-27-rooms.json")
    parser.add_argument("--schedule", default="data/schedule.json")
    parser.add_argument("--output", default="data/sws-2026-27.json")
    args = parser.parse_args()

    input_path = Path(args.input)
    rooms_path = Path(args.rooms)
    schedule_path = Path(args.schedule)
    output_path = Path(args.output)

    lookup, app_rooms = build_room_lookup(schedule_path)
    building_names = {name: BUILDING_ALIASES.get(name, name) for name in BUILDING_ALIASES}

    # SWS room catalog, with application IDs where they exist.
    catalog = []
    for raw in json.loads(rooms_path.read_text(encoding="utf-8")):
        parsed = parse_room_label(raw.get("label", ""))
        room_id, building, number = canonical_room(
            f"{parsed['buildingName']} {parsed['number']}", lookup, building_names
        )
        room_id = room_id or f"{BUILDING_ALIASES.get(parsed['buildingName'], parsed['buildingName']).replace(' ', '')}-{parsed['number']}"
        catalog.append(
            {
                "id": room_id,
                "swsValue": raw.get("value", ""),
                "label": parsed["label"],
                "buildingName": parsed["buildingName"],
                "buildingCode": BUILDING_ALIASES.get(parsed["buildingName"], building or ""),
                "number": parsed["number"],
                "type": parsed["type"],
                "capacityGroup": parsed["capacityGroup"],
                "knownRoom": room_id in app_rooms,
            }
        )

    records: dict[str, dict] = {}
    closure_keys: set[tuple] = set()
    raw_counts = Counter()
    skipped = Counter()
    unmatched_locations = Counter()

    for line in input_path.read_text(encoding="utf-8").splitlines():
        cols = line.split("\t")
        if len(cols) < 11:
            continue
        row = [clean(c) for c in cols[:11]]
        name, section_id, raw_type, department, weeks_text, location, staff, module, day_text, start_text, end_text = row
        if raw_type == "Type" or weeks_text == "Weeks" or day_text == "Day":
            skipped["header"] += 1
            continue
        category, active = classify(row)
        if category == "cancelled" or not active:
            skipped["cancelled"] += 1
            continue
        weeks = parse_weeks(weeks_text)
        days, day_indexes = parse_days(day_text)
        start, end = hm(start_text), hm(end_text)
        if not weeks or not days or not day_indexes or not start or not end or end <= start:
            skipped["invalid"] += 1
            continue

        room_id, building, number = canonical_room(location, lookup, building_names)
        if not room_id and category != "closure":
            unmatched_locations[location] += 1

        if category == "closure":
            key = (weeks_text, day_text, start, end)
            if key in closure_keys:
                skipped["duplicate_closure"] += 1
                continue
            closure_keys.add(key)

        key = (name, section_id, raw_type, department, weeks_text, location, staff, module, day_text, start, end)
        if key in records:
            skipped["duplicate"] += 1
            continue

        # Extract course metadata from the SWS name/module.
        subject = course = course_section = term = None
        m = re.match(r"^([A-Z]+)_O ([A-Z0-9]+)-([WS])/([^/]+)/(.+)$", name)
        if m:
            subject, course, term, _, course_section = m.groups()
        else:
            m = re.match(r"^([A-Z]+)_O ([A-Z0-9]+)-([WS])$", module)
            if m:
                subject, course, term = m.groups()
        if category == "course":
            course_section = course_section or section_id or None
        else:
            subject = course = term = course_section = None

        record_id = hashlib.sha1(json.dumps(key, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]
        periods = week_periods(weeks)
        record = {
            "id": "sws-" + record_id,
            "category": category,
            "source": "sws",
            "name": name,
            "title": name,
            "type": raw_type,
            "kind": KIND.get(raw_type, "Event" if category in ("event", "exam") else category.title()),
            "department": department,
            "sectionId": section_id or None,
            "subject": subject,
            "courseNumber": course,
            "section": course_section,
            "termLetter": term,
            "module": module or None,
            "staff": staff or None,
            "weeks": weeks,
            "periods": periods,
            "days": days,
            "dayIndexes": day_indexes,
            "start": start,
            "end": end,
            "swsLocation": location,
            "roomId": room_id,
            "buildingCode": building,
            "roomNumber": number,
        }
        records[record_id] = record
        raw_counts[category] += 1

    all_records = sorted(records.values(), key=lambda r: (r["periods"][0]["startDate"], r["start"], r["roomId"] or "", r["name"]))
    closures = [r for r in all_records if r["category"] == "closure"]
    bookings = [r for r in all_records if r["category"] != "closure"]
    output_counts = Counter(r["category"] for r in bookings)

    output = {
        "meta": {
            "source": "UBC SWS Okanagan 2026",
            "sourceUrl": "https://sws-oka.as.it.ubc.ca/sws_2026/",
            "capturedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "academicYear": "2026-27",
            "week1Start": WEEK1_START.isoformat(),
            "exportRange": "2026-08-24 to 2027-08-29",
            "scope": "All rooms, all weeks, List Timetable",
            "counts": {
                "catalogRooms": len(catalog),
                "knownCatalogRooms": sum(1 for r in catalog if r["knownRoom"]),
                "bookings": len(bookings),
                "courses": output_counts["course"],
                "events": output_counts["event"],
                "exams": output_counts["exam"],
                "closures": len(closures),
                "unmatchedBookings": sum(1 for r in bookings if not r["roomId"]),
            },
            "rawCounts": dict(raw_counts),
            "skipped": dict(skipped),
            "unmatchedLocations": dict(unmatched_locations.most_common()),
        },
        "rooms": catalog,
        "bookings": bookings,
        "closures": closures,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps(output["meta"], indent=2))
    print(f"wrote {output_path} ({output_path.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
