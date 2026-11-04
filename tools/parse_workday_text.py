#!/usr/bin/env python3
"""Parse the text captured from a Workday Find Course Sections page.

This is a fallback for when Workday's Excel button is unavailable or hidden.
It is intentionally line-oriented because Workday's DOM is a set of nested
divs, but the visible report text is stable and readable.

Usage:
    python tools/parse_workday_text.py data/raw/2026W1-ug-page.json
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "data" / "schedule-workday.json"

DAY_MAP = {
    "mon": "Mon", "monday": "Mon",
    "tue": "Tue", "tues": "Tue", "tuesday": "Tue",
    "wed": "Wed", "weds": "Wed", "wednesday": "Wed",
    "thu": "Thu", "thur": "Thu", "thurs": "Thu", "thursday": "Thu",
    "fri": "Fri", "friday": "Fri",
    "sat": "Sat", "saturday": "Sat",
    "sun": "Sun", "sunday": "Sun",
}
DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

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
    "GYM": ("Gymnasium", "M-F 06:00-23:00; Sa-Su 07:00-22:00"),
    "HCA": ("Health Sciences Centre", "M-F 07:30-22:00; Sa-Su closed"),
    "NEU": ("Neuroscience Building", "M-F 07:30-22:00; Sa-Su closed"),
}

TERMS = {
    "2026W1": {"label": "2026-27 Winter Term 1", "start": "2026-09-08", "end": "2026-12-09"},
    "2026W2": {"label": "2026-27 Winter Term 2", "start": "2027-01-05", "end": "2027-04-09"},
}

HEADER_RE = re.compile(
    r"^([A-Z]{2,6})(?:_O)?\s+(\d{3}[A-Z]?)-([A-Z0-9_]{2,6})\s*-\s*(.+)$"
)

TIME_RE = re.compile(
    r"(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.",
    re.I,
)


def parse_days(text: str) -> list[str]:
    found = []
    for token in re.findall(r"[A-Za-z]+", text):
        day = DAY_MAP.get(token.lower())
        if day and day not in found:
            found.append(day)
    return sorted(found, key=DAY_ORDER.index)


def parse_time(text: str) -> tuple[str, str] | None:
    m = TIME_RE.search(text)
    if not m:
        return None
    sh, sm, sap, eh, em, eap = m.groups()
    sh, sm, eh, em = int(sh), int(sm or 0), int(eh), int(em or 0)
    if sap.lower() == "p" and sh != 12:
        sh += 12
    if sap.lower() == "a" and sh == 12:
        sh = 0
    if eap.lower() == "p" and eh != 12:
        eh += 12
    if eap.lower() == "a" and eh == 12:
        eh = 0
    return f"{sh:02d}:{sm:02d}", f"{eh:02d}:{em:02d}"


def term_from_date(start: str | None) -> str | None:
    if not start:
        return None
    if "2026-09-01" <= start <= "2026-12-31":
        return "2026W1"
    if "2027-01-01" <= start <= "2027-05-31":
        return "2026W2"
    return None


def parse_meeting_line(line: str) -> dict | None:
    # In person:
    # UBCO | Library (LIB) | Floor: 3 | Room: 305 | Tue Thu | 5:00 p.m. - 6:30 p.m. | 2026-09-08 - 2026-11-05
    # Online:
    # Mon Wed | 12:30 p.m. - 2:00 p.m. | 2027-01-06 - 2027-02-10
    parts = [p.strip() for p in line.split("|")]
    if len(parts) < 3:
        return None

    is_ubco = parts[0].upper() == "UBCO"
    if is_ubco:
        building_part = parts[1]
        room_part = next((p for p in parts if p.lower().startswith("room:")), "")
        days_part = next((p for p in parts if re.search(r"\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b", p, re.I)), "")
        time_part = next((p for p in parts if TIME_RE.search(p)), "")
        date_part = next((p for p in parts if re.search(r"\d{4}-\d{2}-\d{2}", p)), "")
    else:
        building_part = ""
        room_part = ""
        days_part = parts[0]
        time_part = next((p for p in parts if TIME_RE.search(p)), "")
        date_part = next((p for p in parts if re.search(r"\d{4}-\d{2}-\d{2}", p)), "")

    code_match = re.search(r"\(([A-Z]{2,5})\)", building_part)
    building_code = code_match.group(1) if code_match else None
    building_name = re.sub(r"\s*\([A-Z]{2,5}\)\s*$", "", building_part).strip()
    room_number = re.sub(r"(?i)^room:\s*", "", room_part).strip()
    if room_number.lower() in {"", "tba", "n/a"}:
        room_number = ""

    days = parse_days(days_part)
    times = parse_time(time_part)
    dates = re.findall(r"\d{4}-\d{2}-\d{2}", date_part)
    if not days or not times:
        return None
    return {
        "buildingCode": building_code,
        "buildingName": building_name,
        "roomNumber": room_number,
        "days": days,
        "start": times[0],
        "end": times[1],
        "startDate": dates[0] if dates else None,
        "endDate": dates[1] if len(dates) > 1 else None,
        "raw": line,
    }


def parse_body(text: str) -> tuple[list[dict], list[dict], list[dict], list[str]]:
    lines = [ln.strip() for ln in text.splitlines()]
    sections: list[dict] = []
    meetings: list[dict] = []
    rooms: dict[str, dict] = {}
    warnings: list[str] = []
    seen_meetings: set[tuple] = set()

    i = 0
    current = None
    while i < len(lines):
        line = lines[i]
        m = HEADER_RE.match(line)
        if m:
            subject, number, section_code, title = m.groups()
            title = re.sub(r"\s+", " ", title).strip()
            current = {
                "subject": subject,
                "courseNumber": number,
                "section": section_code,
                "title": title,
                "activity": "Lecture",
                "status": "",
                "delivery": "",
                "credits": "",
                "meetings": [],
                "term": None,
            }

            # Metadata line is usually the next non-empty line.
            j = i + 1
            while j < len(lines) and not lines[j]:
                j += 1
            if j < len(lines):
                meta = [p.strip() for p in lines[j].split("|")]
                if meta:
                    current["activity"] = meta[0] or "Lecture"
                if len(meta) > 1:
                    current["status"] = meta[1]
                if len(meta) > 2:
                    current["delivery"] = meta[2]
                for part in meta:
                    cm = re.match(r"([\d.]+)\s+Credits?", part, re.I)
                    if cm:
                        current["credits"] = cm.group(1)
                        break

            # Meeting lines follow, sometimes after "Section Details".
            k = j + 1
            while k < len(lines):
                nxt = lines[k]
                if not nxt or nxt in {"(empty)", "Section Details", ", +1 more...", "Course Section Definition Public Notes"}:
                    k += 1
                    continue
                if HEADER_RE.match(nxt):
                    break
                if nxt.startswith("UBCO |") or (TIME_RE.search(nxt) and re.search(r"\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b", nxt, re.I)):
                    meeting = parse_meeting_line(nxt)
                    if meeting:
                        current["meetings"].append(meeting)
                    k += 1
                    continue
                # Stop when the next section's metadata/other block begins.
                if nxt.startswith(("Course Section ", "Building External URL", "Reserved Seat Capacity",
                                   "Drop and Withdrawal Deadlines", "Clustered Course Sections")):
                    # These blocks belong to the current section; skip them.
                    k += 1
                    continue
                break

            if not current["meetings"]:
                warnings.append(f"{subject} {number}-{section_code}: no meeting line parsed")
            else:
                first_date = next((mt["startDate"] for mt in current["meetings"] if mt["startDate"]), None)
                current["term"] = term_from_date(first_date)
            if not current["term"]:
                current["term"] = "UNKNOWN"

            if current["term"] == "UNKNOWN" and not current["meetings"]:
                warnings.append(f"{subject} {number}-{section_code}: no dated meeting and no term; skipped")
                i = k
                continue

            level = "Graduate" if int(re.sub(r"\D", "", number) or 0) >= 500 else "Undergraduate"
            section_id = f"{current['term']}-{subject}{number}-{section_code}"
            section = {
                "id": section_id,
                "term": current["term"],
                "subject": subject,
                "courseNumber": number,
                "title": title,
                "section": section_code,
                "activity": current["activity"],
                "level": level,
                "status": current["status"],
                "credits": current["credits"],
                "delivery": current["delivery"],
            }
            sections.append(section)

            for idx, mt in enumerate(current["meetings"]):
                code = mt["buildingCode"]
                room_number = mt["roomNumber"]
                room_id = f"{code}-{room_number}" if code and room_number else None
                if room_id and room_id not in rooms:
                    name, hours = BUILDINGS.get(code, (mt["buildingName"] or code, "M-F 07:00-22:00; Sa-Su 08:00-20:00"))
                    rooms[room_id] = {
                        "id": room_id,
                        "buildingCode": code,
                        "buildingName": name,
                        "number": room_number,
                        "name": f"{code} {room_number}",
                        "capacity": None,
                        "layout": "",
                        "features": [],
                        "hours": hours,
                        "sourceUrl": "https://learningspaces.ok.ubc.ca/",
                    }
                start_date = mt["startDate"] or TERMS.get(current["term"], {}).get("start")
                end_date = mt["endDate"] or TERMS.get(current["term"], {}).get("end")
                dedupe_key = (section_id, tuple(mt["days"]), mt["start"], mt["end"], room_id, start_date, end_date)
                if dedupe_key in seen_meetings:
                    continue
                seen_meetings.add(dedupe_key)
                meetings.append({
                    "id": f"{section_id}-{mt['days'][0]}-{mt['start']}-{room_id or 'noroom'}-{start_date}-{idx}",
                    "sectionId": section_id,
                    "roomId": room_id,
                    "days": mt["days"],
                    "start": mt["start"],
                    "end": mt["end"],
                    "startDate": start_date,
                    "endDate": end_date,
                    "kind": current["activity"],
                })

            i = k
            continue
        i += 1

    return sections, meetings, list(rooms.values()), warnings


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("capture", type=Path)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    payload = json.loads(args.capture.read_text())
    body = payload.get("bodyText", "")
    if not body:
        raise SystemExit("Capture has no bodyText; use the Excel exporter instead.")

    sections, meetings, rooms, warnings = parse_body(body)
    term_keys = sorted({s["term"] for s in sections if s["term"] in TERMS})
    missing_room = len({s["id"] for s in sections} - {m["sectionId"] for m in meetings if m.get("roomId")})

    out = {
        "meta": {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "academicYear": "2026-27",
            "campus": "UBC Okanagan",
            "source": "Workday Find Course Sections (DOM text capture)",
            "sourceUrl": payload.get("url", "https://wd10.myworkday.com/ubc/"),
            "demo": False,
            "terms": [
                {"key": k, "label": TERMS[k]["label"], "start": TERMS[k]["start"], "end": TERMS[k]["end"]}
                for k in term_keys
            ],
            "counts": {
                "sections": len(sections),
                "meetings": len(meetings),
                "rooms": len(rooms),
                "sectionsWithoutRoom": missing_room,
            },
            "coverage": {
                "levels": sorted({s["level"] for s in sections}),
                "terms": term_keys,
                "collectionMethod": "DOM text capture",
                "capturedAt": payload.get("capturedAt"),
                "bodyCharacters": len(body),
            },
            "warnings": [
                "Parsed from the visible Workday page text, not an official export.",
                "Only the rows loaded by the page were captured; use the Excel export for full coverage.",
                "Room capacities are unknown.",
                "Building hours are defaults and must be verified.",
            ] + warnings[:50],
        },
        "rooms": sorted(rooms, key=lambda r: (r["buildingCode"], r["number"])),
        "sections": sorted(sections, key=lambda s: (s["term"], s["subject"], s["courseNumber"], s["section"])),
        "meetings": sorted(meetings, key=lambda m: (m["startDate"] or "", m["start"], m["roomId"] or "")),
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=2) + "\n")
    print(f"Wrote {args.out}")
    print(f"{len(sections)} sections, {len(meetings)} meetings, {len(rooms)} rooms")
    print(f"Terms: {', '.join(term_keys)}")
    if warnings:
        print(f"{len(warnings)} warnings (first 5):")
        for w in warnings[:5]:
            print(" -", w)


if __name__ == "__main__":
    main()
