#!/usr/bin/env python3
"""Convert Workday / spreadsheet exports into the room finder's dataset.

The parser is deliberately defensive: Workday exports vary by tenant and by
report layout. It finds the most likely header row, maps common column names,
forward-fills grouped rows, and reports anything it could not understand
instead of silently inventing classes.

Typical use:
    python tools/import_workday.py data/raw/*.xlsx
    python tools/import_workday.py data/raw/2026W1-ug.xlsx --term 2026W1 --level Undergraduate
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "data" / "schedule.json"

TERMS = {
    "2026W1": {
        "label": "2026-27 Winter Term 1",
        "start": "2026-09-08",
        "end": "2026-12-09",
    },
    "2026W2": {
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

BUILDINGS = {
    "ADM": ("Campus Administration Building", "M-F 06:00-23:00; Sa-Su 07:00-22:00"),
    "ART": ("Arts Building", "M-F 06:00-23:00; Sa-Su 07:00-22:00"),
    "ASC": ("Arts and Sciences Centre", "M-F 06:00-23:00; Sa-Su 07:00-22:00"),
    "CCS": ("Creative and Critical Studies Building", "M-F 06:00-23:00; Sa-Su 07:00-22:00"),
    "COM": ("The Commons", "M-Su 06:00-01:00"),
    "EME": ("Engineering, Management and Education Building", "M-F 06:00-23:00; Sa-Su 07:00-22:00"),
    "FIP": ("Fipke Centre for Innovative Research", "M-F 07:30-22:00; Sa-Su closed"),
    "LIB": ("Library", "M-Su 07:00-23:00"),
    "RHS": ("Reichwald Health Sciences Centre", "M-F 08:00-16:30; Sa-Su closed"),
    "SCI": ("Science Building", "M-F 07:30-22:00; Sa-Su closed"),
    "UNC": ("University Centre", "M-F 07:00-23:00; Sa-Su 08:00-22:00"),
    "ART": ("Arts Building", "M-F 06:00-23:00; Sa-Su 07:00-22:00"),
    "GYM": ("Gymnasium", "M-F 06:00-23:00; Sa-Su 07:00-22:00"),
    "HCA": ("Health Sciences Centre", "M-F 07:30-22:00; Sa-Su closed"),
    "FIN": ("Fipke Centre", "M-F 07:30-22:00; Sa-Su closed"),
    "NEU": ("Neuroscience Building", "M-F 07:30-22:00; Sa-Su closed"),
    "PEN": ("Penticton Centre", "M-F 08:00-18:00; Sa-Su closed"),
}

BUILDING_NAME_TO_CODE = {name.lower(): code for code, (name, _hours) in BUILDINGS.items()}

DAY_ALIASES = {
    "m": "Mon", "mo": "Mon", "mon": "Mon", "monday": "Mon",
    "t": "Tue", "tu": "Tue", "tue": "Tue", "tues": "Tue", "tuesday": "Tue",
    "w": "Wed", "we": "Wed", "wed": "Wed", "weds": "Wed", "wednesday": "Wed",
    "r": "Thu", "th": "Thu", "thu": "Thu", "thur": "Thu", "thurs": "Thu", "thursday": "Thu",
    "f": "Fri", "fr": "Fri", "fri": "Fri", "friday": "Fri",
    "s": "Sat", "sa": "Sat", "sat": "Sat", "saturday": "Sat",
    "u": "Sun", "su": "Sun", "sun": "Sun", "sunday": "Sun",
}

DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

HEADER_ALIASES = {
    "course": ["course", "course listing", "course code", "course section", "course identifier"],
    "section": ["section", "section number", "section code", "section id"],
    "title": ["course title", "title", "section title", "class title"],
    "activity": ["instructional format", "activity", "instructional format description", "component"],
    "meeting": ["meeting patterns", "meeting pattern", "meeting time", "meeting times", "meeting", "time", "schedule"],
    "days": ["scheduled days", "days", "day", "meeting days"],
    "start": ["start time", "start"],
    "end": ["end time", "end"],
    "room": ["room", "room number", "location", "facility", "facility id"],
    "building": ["building", "building name", "building code"],
    "term": ["academic period", "term", "period", "academic term"],
    "level": ["academic level", "level", "career"],
    "status": ["section status", "status"],
    "credits": ["credits", "credit units", "units"],
    "delivery": ["delivery mode", "delivery", "mode of delivery"],
    "instructor": ["instructor", "instructors", "teaching team", "teacher"],
    "start_date": ["start date", "section start date", "class start date"],
    "end_date": ["end date", "section end date", "class end date"],
    "dates": ["dates", "date range", "section dates", "meeting dates"],
}


def normalize_header(value: str) -> str:
    text = (value or "").lower().strip()
    text = re.sub(r"\([^)]*\)", " ", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def header_score(row: list) -> tuple[int, dict[int, str]]:
    mapping: dict[int, str] = {}
    score = 0
    headers = [(idx, normalize_header(str(raw or ""))) for idx, raw in enumerate(row)]
    used: set[str] = set()

    # Exact matches first so "Course Title" does not get claimed by "Course".
    for idx, header in headers:
        if not header:
            continue
        for field, aliases in HEADER_ALIASES.items():
            if field in used:
                continue
            if any(header == alias for alias in aliases):
                mapping[idx] = field
                used.add(field)
                score += 3
                break

    # Then substrings, e.g. "Course Listing" -> course.
    for idx, header in headers:
        if not header or idx in mapping:
            continue
        for field, aliases in HEADER_ALIASES.items():
            if field in used:
                continue
            if any(alias in header for alias in aliases):
                mapping[idx] = field
                used.add(field)
                score += 1
                break
    return score, mapping


def read_rows(path: Path) -> list[list]:
    if path.suffix.lower() in {".xlsx", ".xlsm"}:
        wb = load_workbook(path, data_only=True, read_only=True)
        sheets = []
        for ws in wb.worksheets:
            rows = [list(row) for row in ws.iter_rows(values_only=True)]
            if any(any(str(v or "").strip() for v in row) for row in rows):
                sheets.append((ws.title, rows))
        if not sheets:
            return []
        # Pick the worksheet that looks most like the report, not a cover sheet.
        def sheet_score(entry):
            _title, rows = entry
            return max((header_score(row)[0] for row in rows[:80]), default=0)

        return max(sheets, key=sheet_score)[1]
    if path.suffix.lower() in {".csv", ".tsv"}:
        with path.open(newline="", encoding="utf-8-sig") as fh:
            sample = fh.read(4096)
            fh.seek(0)
            dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|")
            return [list(row) for row in csv.reader(fh, dialect)]
    raise ValueError(f"Unsupported input type: {path.suffix}")


def find_header(rows: list[list]) -> tuple[int, dict[int, str]]:
    best = (-1, 0, {})
    for idx, row in enumerate(rows[:80]):
        score, mapping = header_score(row)
        if score > best[0]:
            best = (score, idx, mapping)
    if best[0] < 2 or not best[2]:
        raise ValueError("Could not find a header row with recognizable course columns.")
    return best[1], best[2]


def cell(row: list, mapping: dict[int, str], field: str) -> str:
    for idx, mapped in mapping.items():
        if mapped == field and idx < len(row):
            value = row[idx]
            if value is None:
                return ""
            if isinstance(value, datetime):
                return value.date().isoformat()
            return str(value).strip()
    return ""


def split_course(raw: str, section_raw: str) -> tuple[str, str, str]:
    text = (raw or "").strip()
    text = re.sub(r"\s+", " ", text)
    # UBC calendar style suffix, e.g. COSC_O 111.
    text = re.sub(r"_O\b", "", text, flags=re.I)

    section = (section_raw or "").strip()
    section = re.sub(r"^section\s*", "", section, flags=re.I).strip()

    m = re.match(r"^([A-Za-z]{2,8})\s*[ _-]*\s*(\d{2,4}[A-Za-z]?)\s*(?:[-/ ]\s*([A-Za-z0-9]{2,5}))?$", text)
    if m:
        subject, number, embedded = m.groups()
        if not section and embedded:
            section = embedded
        return subject.upper(), number.upper(), section or "001"

    # "COSC 111-001 Introduction..." or "COSC-111-001"
    m = re.search(r"([A-Za-z]{2,8})\s*[ _-]*\s*(\d{2,4}[A-Za-z]?)\s*[-/ ]\s*([A-Za-z0-9]{2,5})", text)
    if m:
        subject, number, embedded = m.groups()
        if not section:
            section = embedded
        return subject.upper(), number.upper(), section or "001"

    # Last resort: split the first two tokens.
    tokens = text.replace("-", " ").split()
    if len(tokens) >= 2:
        return tokens[0].upper(), tokens[1].upper(), section or "001"
    return text.upper() or "UNKNOWN", "000", section or "001"


def parse_days(text: str) -> list[str]:
    source = (text or "").strip()
    if not source or re.search(r"\bTBA\b|\bn/?a\b", source, re.I):
        return []

    # Only look before the time and room portions; otherwise "SCI 333" and
    # timezone letters can be mistaken for day tokens.
    cutoff = len(source)
    time_match = TIME_RE.search(source)
    if time_match:
        cutoff = min(cutoff, time_match.start())
    if "|" in source:
        cutoff = min(cutoff, source.index("|"))
    day_part = source[:cutoff]

    tokens = re.findall(r"[A-Za-z]+", day_part)
    found: list[str] = []
    for token in tokens:
        key = token.lower().strip(".")
        if not key:
            continue
        if key in DAY_ALIASES and len(key) != 1:
            day = DAY_ALIASES[key]
            if day not in found:
                found.append(day)
            continue
        # MWF / TR / TTh / MoWeFr style. The two-letter forms are matched
        # before single letters so "Th" is Thursday, not Tuesday + something.
        if re.fullmatch(r"(?:(?:Mo|Tu|We|Th|Fr|Sa|Su)|[MTWRFSAU])+", token, re.I):
            i = 0
            while i < len(token):
                pair = token[i:i + 2].lower()
                single = token[i].lower()
                if pair in DAY_ALIASES and len(pair) == 2:
                    day = DAY_ALIASES[pair]
                    i += 2
                elif single in DAY_ALIASES:
                    day = DAY_ALIASES[single]
                    i += 1
                else:
                    i += 1
                    continue
                if day not in found:
                    found.append(day)
    return sorted(found, key=DAY_ORDER.index)


def to_minutes(hour: str, minute: str | None, meridiem: str | None) -> int | None:
    try:
        h = int(hour)
        m = int(minute) if minute else 0
    except (TypeError, ValueError):
        return None
    if meridiem:
        mer = meridiem.lower().replace(".", "")
        if mer == "pm" and h != 12:
            h += 12
        elif mer == "am" and h == 12:
            h = 0
    if h > 23 or m > 59:
        return None
    return h * 60 + m


TIME_RE = re.compile(
    r"(\d{1,2})(?::(\d{2}))?\s*([AP]\.?M\.?)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*([AP]\.?M\.?)?",
    re.I,
)


def parse_times(text: str) -> list[tuple[int, int]]:
    results = []
    for m in TIME_RE.finditer(text or ""):
        sh, sm, smer, eh, em, emer = m.groups()
        start = to_minutes(sh, sm, smer)
        end = to_minutes(eh, em, emer)
        if start is None or end is None:
            continue
        # If only the end carries AM/PM, apply the same half-day to the start.
        if not smer and emer:
            if emer.lower().startswith("p") and start < 12 * 60:
                start += 12 * 60
            elif emer.lower().startswith("a") and start >= 12 * 60:
                start -= 12 * 60
        if end <= start:
            # Overnight or a 12-hour ambiguity; assume PM for a 1-11 end.
            if end < 12 * 60 and start >= 12 * 60:
                end += 12 * 60
        if end > start:
            results.append((start, end))
    return results


def minutes_to_hm(total: int) -> str:
    return f"{total // 60:02d}:{total % 60:02d}"


ROOM_RE = re.compile(r"\b([A-Z]{2,5})\s*[- ]?\s*(\d{2,4}[A-Z]?)\b")


def parse_room(text: str) -> tuple[str | None, str | None]:
    source = (text or "").strip()
    if not source or re.search(r"\bTBA\b|\bonline\b|\bremote\b|\bn/?a\b", source, re.I):
        return None, None

    # A full building name followed by a room number.
    lower = source.lower()
    for name, code in BUILDING_NAME_TO_CODE.items():
        if name in lower:
            m = re.search(r"\b(\d{2,4}[A-Z]?)\b", source)
            if m:
                return code, m.group(1).upper()

    for m in ROOM_RE.finditer(source.upper()):
        code, number = m.groups()
        if code in BUILDINGS:
            return code, number

    # "Room 333" in a known building column is handled by the caller.
    m = re.search(r"\b(?:room|rm)\s*#?\s*([A-Z]?\d{2,4}[A-Z]?)\b", source, re.I)
    if m:
        return None, m.group(1).upper()
    return None, None


def parse_date_text(text: str) -> tuple[str | None, str | None]:
    source = (text or "").strip()
    if not source:
        return None, None
    # ISO / slash dates first.
    dates = re.findall(r"\b(\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{2,4})\b", source)
    parsed = []
    for value in dates[:2]:
        if "-" in value:
            parsed.append(value)
        else:
            m, d, y = value.split("/")
            if len(y) == 2:
                y = f"20{y}"
            parsed.append(f"{y}-{int(m):02d}-{int(d):02d}")

    # "Sep 8, 2026" / "September 8, 2026" / "8 Sep 2026".
    if len(parsed) < 2:
        month_names = re.findall(
            r"\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
            r"Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
            r"\s+\d{1,2},?\s+\d{4}",
            source,
            re.I,
        )
        for value in month_names[: 2 - len(parsed)]:
            for fmt in ("%b %d, %Y", "%B %d, %Y", "%b %d %Y", "%B %d %Y"):
                try:
                    parsed.append(datetime.strptime(value.replace(",", ""), fmt.replace(",", "")).date().isoformat())
                    break
                except ValueError:
                    continue
    if len(parsed) == 2:
        return parsed[0], parsed[1]
    if len(parsed) == 1:
        return parsed[0], None
    return None, None


def infer_term(filename: str, raw_term: str, fallback: str | None) -> str | None:
    haystack = f"{filename} {raw_term}".lower()
    if re.search(r"winter\s*term\s*1|2026\s*w\s*1|2026w1|2026-27.*term\s*1", haystack):
        return "2026W1"
    if re.search(r"winter\s*term\s*2|2026\s*w\s*2|2026w2|2026-27.*term\s*2", haystack):
        return "2026W2"
    return fallback


def infer_level(filename: str, raw_level: str, fallback: str | None) -> str:
    explicit = (raw_level or "").strip().lower()
    if explicit:
        if "undergrad" in explicit or "undergraduate" in explicit:
            return "Undergraduate"
        if "grad" in explicit:
            return "Graduate"
        if "not applicable" in explicit or explicit in {"n/a", "na"}:
            return "Not applicable"
        return raw_level.strip()
    haystack = filename.lower()
    if "undergrad" in haystack or re.search(r"(^|[^a-z])ug([^a-z]|$)", haystack):
        return "Undergraduate"
    if "grad" in haystack:
        return "Graduate"
    return fallback or "Undergraduate"


def parse_meeting_text(text: str) -> list[dict]:
    """Break a Meeting Patterns cell into one or more meeting dictionaries."""
    source = (text or "").strip()
    if not source:
        return []
    source = re.sub(r"(?i)^meeting patterns?\s*:?\s*", "", source)
    cell_room = parse_room(source)
    chunks = [c.strip() for c in re.split(r"[\n;]+", source) if c.strip()]
    out = []
    for chunk in chunks:
        days = parse_days(chunk)
        times = parse_times(chunk)
        if not days or not times:
            continue
        room_code, room_number = parse_room(chunk)
        if not room_code:
            room_code, room_number = cell_room
        for start, end in times:
            out.append(
                {
                    "days": days,
                    "start": minutes_to_hm(start),
                    "end": minutes_to_hm(end),
                    "text": chunk,
                    "roomCode": room_code,
                    "roomNumber": room_number,
                }
            )
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--term", choices=sorted(TERMS))
    parser.add_argument("--level", choices=["Undergraduate", "Graduate"])
    parser.add_argument("--source", default="Workday Find Course Sections export")
    args = parser.parse_args()

    all_sections: dict[str, dict] = {}
    all_meetings: dict[str, dict] = {}
    rooms: dict[str, dict] = {}
    warnings: list[str] = []
    unparsed_rows = 0
    row_count = 0
    per_file = []

    for path in args.inputs:
        if not path.exists():
            warnings.append(f"Missing input file: {path}")
            continue
        rows = read_rows(path)
        header_index, mapping = find_header(rows)
        data_rows = rows[header_index + 1:]

        # Forward-fill identity columns. Workday grouped exports often leave
        # course/section cells blank on continuation rows.
        fill_fields = ["course", "section", "title", "term", "level", "activity", "status", "credits", "delivery"]
        last_values = {field: "" for field in fill_fields}
        file_sections = 0
        file_meetings = 0

        for row in data_rows:
            if not any(str(v or "").strip() for v in row):
                continue
            row_count += 1
            values = {field: cell(row, mapping, field) for field in HEADER_ALIASES}
            for field in fill_fields:
                if values.get(field):
                    last_values[field] = values[field]
                else:
                    values[field] = last_values[field]

            raw_term = values.get("term", "")
            term = infer_term(path.name, raw_term, args.term)
            level = infer_level(path.name, values.get("level", ""), args.level)
            if not term:
                unparsed_rows += 1
                continue

            subject, number, section_code = split_course(values.get("course", ""), values.get("section", ""))
            if subject == "UNKNOWN":
                unparsed_rows += 1
                continue

            section_id = f"{term}-{subject}{number}-{section_code}"
            if section_id not in all_sections:
                all_sections[section_id] = {
                    "id": section_id,
                    "term": term,
                    "subject": subject,
                    "courseNumber": number,
                    "title": values.get("title", "").strip(),
                    "section": section_code,
                    "activity": values.get("activity", "").strip() or "Lecture",
                    "level": level,
                    "status": values.get("status", "").strip(),
                    "credits": values.get("credits", "").strip(),
                    "delivery": values.get("delivery", "").strip() or "In person",
                    "instructor": values.get("instructor", "").strip(),
                }
                file_sections += 1

            start_date, end_date = parse_date_text(values.get("dates", ""))
            col_start, col_end = parse_date_text(f"{values.get('start_date','')} {values.get('end_date','')}")
            start_date = col_start or start_date or TERMS[term]["start"]
            end_date = col_end or end_date or TERMS[term]["end"]

            day_text = values.get("days", "")
            start_text = values.get("start", "")
            end_text = values.get("end", "")
            room_text = values.get("room", "")
            building_text = values.get("building", "")

            patterns = []
            meeting_text = values.get("meeting", "")
            if meeting_text:
                patterns = parse_meeting_text(meeting_text)
            if not patterns and meeting_text and day_text:
                days = parse_days(day_text)
                for start, end in parse_times(meeting_text):
                    patterns.append(
                        {"days": days, "start": minutes_to_hm(start), "end": minutes_to_hm(end), "text": meeting_text}
                    )
            if not patterns and (day_text or start_text or end_text):
                days = parse_days(day_text)
                times = parse_times(f"{start_text} - {end_text}")
                for start, end in times:
                    patterns.append(
                        {"days": days, "start": minutes_to_hm(start), "end": minutes_to_hm(end), "text": ""}
                    )
            if not patterns:
                # A row with no meeting pattern may still be a valid online or
                # arrangement section. Keep the section, warn once per file.
                continue

            row_building_code, row_room_number = parse_room(room_text)
            if not row_building_code and row_room_number:
                row_building_code, _ = parse_room(building_text)
            if not row_building_code:
                row_building_code, row_room_number = parse_room(building_text + " " + room_text)
            if row_building_code and not row_room_number:
                row_room_number = parse_room(room_text)[1]

            for idx, pattern in enumerate(patterns):
                building_code = row_building_code or pattern.get("roomCode")
                room_number = row_room_number or pattern.get("roomNumber")

                if not building_code or not room_number:
                    room_id = None
                else:
                    room_id = f"{building_code}-{room_number}"
                    if room_id not in rooms:
                        name, hours = BUILDINGS.get(
                            building_code, (building_code, "M-F 07:00-22:00; Sa-Su 08:00-20:00")
                        )
                        rooms[room_id] = {
                            "id": room_id,
                            "buildingCode": building_code,
                            "buildingName": name,
                            "number": room_number,
                            "name": f"{building_code} {room_number}",
                            "capacity": None,
                            "layout": "",
                            "features": [],
                            "hours": hours,
                            "sourceUrl": "https://learningspaces.ok.ubc.ca/",
                        }

                meeting_key = (
                    f"{section_id}-{pattern['days'][0]}-{pattern['start']}-"
                    f"{room_id or 'noroom'}-{start_date}"
                )
                if meeting_key in all_meetings:
                    continue
                all_meetings[meeting_key] = {
                    "id": meeting_key,
                    "sectionId": section_id,
                    "roomId": room_id,
                    "days": pattern["days"],
                    "start": pattern["start"],
                    "end": pattern["end"],
                    "startDate": start_date,
                    "endDate": end_date,
                    "kind": values.get("activity", "").strip() or "Lecture",
                }
                file_meetings += 1

        per_file.append(
            {
                "file": str(path),
                "rows": len(data_rows),
                "headerRow": header_index + 1,
                "columns": mapping,
                "sections": file_sections,
                "meetings": file_meetings,
            }
        )
        print(f"{path.name}: {file_sections} sections, {file_meetings} meetings (header row {header_index + 1})")

    if not all_sections:
        raise SystemExit("No sections were parsed. Check the input and the header row.")

    missing_rooms = len({s["id"] for s in all_sections.values()} - {m["sectionId"] for m in all_meetings.values() if m.get("roomId")})
    if missing_rooms:
        warnings.append(f"{missing_rooms} sections have no room in the source; they remain searchable but are not recommended as study space.")
    if any(r.get("capacity") is None for r in rooms.values()):
        warnings.append("Room capacities are unknown until a room-directory file is merged. Capacity filtering is skipped for those rooms.")
    warnings.append("Building hours are defaults from the public learning-spaces directory and must be verified before relying on them.")
    warnings.append("This dataset only knows scheduled classes. Events, exams and ad-hoc bookings are not included.")
    if unparsed_rows:
        warnings.append(f"{unparsed_rows} rows were skipped because a course, term or meeting pattern could not be parsed.")

    term_keys = sorted({s["term"] for s in all_sections.values()})
    payload = {
        "meta": {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "academicYear": "2026-27",
            "campus": "UBC Okanagan",
            "source": args.source,
            "sourceUrl": "https://wd10.myworkday.com/ubc/",
            "demo": False,
            "terms": [
                {"key": key, "label": TERMS[key]["label"], "start": TERMS[key]["start"], "end": TERMS[key]["end"]}
                for key in term_keys
                if key in TERMS
            ],
            "counts": {
                "sections": len(all_sections),
                "meetings": len(all_meetings),
                "rooms": len(rooms),
                "sectionsWithoutRoom": missing_rooms,
            },
            "nonTeachingPeriods": NON_TEACHING,
            "coverage": {
                "levels": sorted({s["level"] for s in all_sections.values()}),
                "terms": term_keys,
                "collectionMethod": "Workday export parsed locally",
                "rowsRead": row_count,
                "files": per_file,
            },
            "warnings": warnings,
        },
        "rooms": sorted(rooms.values(), key=lambda r: (r["buildingCode"], r["number"])),
        "sections": sorted(all_sections.values(), key=lambda s: (s["term"], s["subject"], s["courseNumber"], s["section"])),
        "meetings": sorted(all_meetings.values(), key=lambda m: (m["startDate"], m["start"], m["roomId"] or "")),
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2) + "\n")
    report_path = args.out.parent / "import-report.json"
    report_path.write_text(json.dumps(payload["meta"]["coverage"], indent=2) + "\n")
    print(f"\nWrote {args.out}")
    print(f"Wrote {report_path}")
    print(f"Total: {len(all_sections)} sections, {len(all_meetings)} meetings, {len(rooms)} rooms")
    if unparsed_rows:
        print(f"WARNING: {unparsed_rows} rows could not be parsed.")


if __name__ == "__main__":
    main()
