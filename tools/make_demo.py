#!/usr/bin/env python3
"""Generate a clearly-labelled demo dataset so the UI can be developed offline.

This is NOT real UBCO availability. It uses plausible course codes, buildings and
rooms only so that search, sorting and timetable rendering can be exercised.
"""

from __future__ import annotations

import json
import random
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "schedule.json"

TERMS = {
    "2026W1": {
        "label": "2026-27 Winter Term 1",
        "start": date(2026, 9, 8),
        "end": date(2026, 12, 9),
    },
    "2026W2": {
        "label": "2026-27 Winter Term 2",
        "start": date(2027, 1, 5),
        "end": date(2027, 4, 9),
    },
}

BUILDINGS = {
    "ADM": ("Campus Administration Building", "M-F 06:00-23:00; Sa-Su 07:00-22:00"),
    "ART": ("Arts Building", "M-F 06:00-23:00; Sa-Su 07:00-22:00"),
    "ASC": ("Arts and Sciences Centre", "M-F 06:00-23:00; Sa-Su 07:00-22:00"),
    "CCS": ("Creative and Critical Studies Building", "M-F 06:00-23:00; Sa-Su 07:00-22:00"),
    "COM": ("The Commons", "M-Su 06:00-01:00"),
    "EME": ("Engineering, Management and Education", "M-F 06:00-23:00; Sa-Su 07:00-22:00"),
    "FIP": ("Fipke Centre for Innovative Research", "M-F 07:30-22:00; Sa-Su closed"),
    "LIB": ("Library", "M-Su 07:00-23:00"),
    "RHS": ("Reichwald Health Sciences Centre", "M-F 08:00-16:30; Sa-Su closed"),
    "SCI": ("Science Building", "M-F 07:30-22:00; Sa-Su closed"),
    "UNC": ("University Centre", "M-F 07:00-23:00; Sa-Su 08:00-22:00"),
}

ROOMS = [
    # (building, number, capacity, layout, features)
    ("ADM", "026", 200, "Tiered classroom", ["projector", "av"]),
    ("ADM", "101", 28, "Meeting room", ["projector"]),
    ("ART", "204", 48, "Classroom", ["projector", "whiteboard"]),
    ("ART", "366", 36, "Classroom", ["projector", "whiteboard", "natural light"]),
    ("ART", "376", 30, "Seminar room", ["whiteboard"]),
    ("ASC", "130", 72, "Tiered classroom", ["projector", "av"]),
    ("ASC", "140", 66, "Tiered classroom", ["projector", "av"]),
    ("ASC", "168", 54, "Classroom", ["projector", "whiteboard"]),
    ("ASC", "176", 48, "Classroom", ["projector", "whiteboard"]),
    ("CCS", "150", 40, "Studio", ["whiteboard", "natural light"]),
    ("CCS", "200", 32, "Seminar room", ["projector", "whiteboard"]),
    ("COM", "113", 60, "Flexible classroom", ["projector", "whiteboard", "natural light"]),
    ("COM", "201", 400, "Tiered classroom", ["projector", "av", "power"]),
    ("EME", "0050", 192, "Tiered classroom", ["projector", "av", "power"]),
    ("EME", "1101", 80, "Tiered classroom", ["projector", "av", "power"]),
    ("EME", "1121", 60, "Classroom", ["projector", "whiteboard"]),
    ("EME", "1151", 72, "Tiered classroom", ["projector", "av"]),
    ("EME", "1201", 48, "Classroom", ["projector", "whiteboard"]),
    ("EME", "1215", 40, "Classroom", ["projector", "whiteboard"]),
    ("EME", "2181", 56, "Classroom", ["projector", "whiteboard"]),
    ("EME", "2201", 64, "Tiered classroom", ["projector", "av"]),
    ("EME", "2212", 44, "Classroom", ["projector", "whiteboard"]),
    ("EME", "2224", 36, "Seminar room", ["whiteboard"]),
    ("EME", "2241", 30, "Seminar room", ["whiteboard"]),
    ("EME", "2251", 54, "Classroom", ["projector", "whiteboard"]),
    ("EME", "2261", 40, "Classroom", ["projector"]),
    ("EME", "2281", 32, "Seminar room", ["whiteboard", "natural light"]),
    ("EME", "3111", 48, "Classroom", ["projector", "whiteboard"]),
    ("EME", "3211", 36, "Seminar room", ["whiteboard"]),
    ("EME", "4211", 30, "Seminar room", ["whiteboard", "natural light"]),
    ("FIP", "121", 70, "Tiered classroom", ["projector", "av"]),
    ("FIP", "139", 40, "Classroom", ["projector", "whiteboard"]),
    ("FIP", "204", 30, "Seminar room", ["whiteboard"]),
    ("LIB", "305", 150, "Classroom", ["projector", "whiteboard"]),
    ("LIB", "312", 48, "Classroom", ["projector", "whiteboard"]),
    ("LIB", "317", 30, "Seminar room", ["whiteboard", "natural light"]),
    ("RHS", "257", 75, "Tiered classroom", ["projector", "av"]),
    ("RHS", "260", 125, "Tiered classroom", ["projector", "av"]),
    ("SCI", "236", 32, "Classroom", ["projector", "whiteboard"]),
    ("SCI", "247", 81, "Tiered classroom", ["projector", "av"]),
    ("SCI", "333", 109, "Tiered classroom", ["projector", "av"]),
    ("SCI", "337", 104, "Tiered classroom", ["projector", "av"]),
    ("UNC", "200", 60, "Classroom", ["projector", "whiteboard"]),
    ("UNC", "334", 27, "Meeting room", ["projector", "whiteboard"]),
]

COURSES = [
    ("ANTH", "100", "Introduction to Cultural Anthropology"),
    ("ANTH", "205", "Gender, Sexuality, and the Body"),
    ("APSC", "260", "Mechanics of Materials I"),
    ("APSC", "261", "Theory of Structures"),
    ("BIOL", "116", "Biology for Engineers"),
    ("BIOL", "201", "Introductory Biology I"),
    ("BIOL", "202", "Introductory Biology II"),
    ("BIOC", "309", "Pharmacology II"),
    ("CHEM", "111", "Principles of Chemistry I"),
    ("CHEM", "123", "Principles of Chemistry II"),
    ("COSC", "111", "Computer Programming I"),
    ("COSC", "121", "Computer Programming II"),
    ("COSC", "222", "Data Structures"),
    ("COSC", "304", "Database Systems"),
    ("COSC", "341", "Operating Systems"),
    ("CRWR", "150", "Introduction to Creative Writing"),
    ("ECON", "101", "Principles of Microeconomics"),
    ("ECON", "102", "Principles of Macroeconomics"),
    ("ENGL", "109", "Critical Reading and Writing"),
    ("ENGL", "150", "Introduction to Literary Studies"),
    ("ENGR", "303", "Engineering Economics"),
    ("EESC", "101", "Earth Science"),
    ("FREN", "101", "Beginning French I"),
    ("GEOG", "108", "Physical Geography"),
    ("HEAL", "100", "Health and Society"),
    ("HIST", "105", "History of Canada"),
    ("JPST", "101", "Beginning Japanese I"),
    ("KIN", "100", "Introduction to Kinesiology"),
    ("MATH", "100", "Differential Calculus"),
    ("MATH", "101", "Integral Calculus"),
    ("MATH", "200", "Multivariable Calculus"),
    ("MATH", "221", "Linear Algebra"),
    ("MDST", "100", "Introduction to Media Studies"),
    ("MGMT", "100", "Introduction to Management"),
    ("MGMT", "220", "Financial Accounting"),
    ("NURS", "110", "Professional Nursing Practice"),
    ("PHIL", "110", "Introduction to Philosophy"),
    ("PHYS", "111", "Introductory Physics I"),
    ("PHYS", "121", "Introductory Physics II"),
    ("POLI", "100", "Introduction to Politics"),
    ("PSYC", "101", "Introduction to Psychology I"),
    ("PSYC", "102", "Introduction to Psychology II"),
    ("SOCI", "100", "Introduction to Sociology"),
    ("SPAN", "101", "Beginning Spanish I"),
    ("STAT", "121", "Introductory Statistics"),
    ("VISA", "101", "Introduction to Visual Arts"),
]

ACTIVITIES = [
    ("Lecture", 80, ["Mon", "Wed"], ["Tue", "Thu"]),
    ("Lecture", 80, ["Mon", "Wed", "Fri"], ["Tue", "Thu"]),
    ("Lab", 180, ["Tue"], ["Thu"]),
    ("Tutorial", 60, ["Fri"], ["Mon"]),
]

DAY_INDEX = {d: i for i, d in enumerate(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])}


def iso(d: date) -> str:
    return d.isoformat()


def main() -> None:
    rng = random.Random(20261104)

    rooms = []
    for i, (bc, number, cap, layout, feats) in enumerate(ROOMS, start=1):
        building_name, hours = BUILDINGS[bc]
        rooms.append(
            {
                "id": f"{bc}-{number}",
                "buildingCode": bc,
                "buildingName": building_name,
                "number": number,
                "name": f"{bc} {number}",
                "capacity": cap,
                "layout": layout,
                "features": feats,
                "hours": hours,
                "sourceUrl": "https://learningspaces.ok.ubc.ca/",
            }
        )

    sections = []
    meetings = []
    meeting_id = 1
    room_cycle = 0

    for term_key, term in TERMS.items():
        # A stable shuffled room order makes conflicts look organic.
        term_rooms = rooms[:]
        rng.shuffle(term_rooms)

        for ci, (subj, num, title) in enumerate(COURSES):
            # Two lecture sections per course per term, plus a lab/tutorial sometimes.
            n_sections = 2 if ci % 3 else 3
            for s in range(n_sections):
                section_no = f"{s + 1:03d}"
                section_id = f"{term_key}-{subj}{num}-{section_no}"
                is_online = ci % 19 == 0 and s == 0
                sections.append(
                    {
                        "id": section_id,
                        "term": term_key,
                        "subject": subj,
                        "courseNumber": num,
                        "title": title,
                        "section": section_no,
                        "activity": "Lecture",
                        "level": "Undergraduate",
                        "status": "Open",
                        "credits": 3,
                        "delivery": "Online" if is_online else "In person",
                    }
                )

                # Lecture pattern.
                pattern = ACTIVITIES[ci % 2]
                _, duration, days_a, days_b = pattern
                days = days_a if s % 2 == 0 else days_b
                start_min = 8 * 60 + (ci * 37 + s * 83) % (9 * 60)
                # Keep classes on clean 30-minute boundaries.
                start_min = (start_min // 30) * 30
                end_min = start_min + duration
                room = None if is_online or ci == 31 else term_rooms[room_cycle % len(term_rooms)]
                if room is not None:
                    room_cycle += 1
                for day in days:
                    meetings.append(
                        {
                            "id": f"m{meeting_id}",
                            "sectionId": section_id,
                            "roomId": room["id"] if room else None,
                            "days": [day],
                            "start": f"{start_min // 60:02d}:{start_min % 60:02d}",
                            "end": f"{end_min // 60:02d}:{end_min % 60:02d}",
                            "startDate": iso(term["start"]),
                            "endDate": iso(term["end"]),
                            "kind": "Lecture",
                        }
                    )
                    meeting_id += 1

                # A lab or tutorial for some courses.
                if ci % 4 == 0:
                    lab_id = f"{term_key}-{subj}{num}-L{s + 1:02d}"
                    lab_room = term_rooms[room_cycle % len(term_rooms)]
                    room_cycle += 1
                    lab_start = 9 * 60 + (ci * 53 + s * 41) % (8 * 60)
                    lab_start = (lab_start // 30) * 30
                    lab_end = lab_start + 180
                    sections.append(
                        {
                            "id": lab_id,
                            "term": term_key,
                            "subject": subj,
                            "courseNumber": num,
                            "title": title,
                            "section": f"L{s + 1:02d}",
                            "activity": "Laboratory",
                            "level": "Undergraduate",
                            "status": "Open",
                            "credits": 0,
                            "delivery": "In person",
                        }
                    )
                    meetings.append(
                        {
                            "id": f"m{meeting_id}",
                            "sectionId": lab_id,
                            "roomId": lab_room["id"],
                            "days": ["Thu" if s % 2 else "Tue"],
                            "start": f"{lab_start // 60:02d}:{lab_start % 60:02d}",
                            "end": f"{lab_end // 60:02d}:{lab_end % 60:02d}",
                            "startDate": iso(term["start"]),
                            "endDate": iso(term["end"]),
                            "kind": "Laboratory",
                        }
                    )
                    meeting_id += 1

    # A couple of graduate seminars so the level filter is meaningful.
    for term_key, term in TERMS.items():
        for i, (subj, num, title) in enumerate(
            [("COSC", "511", "Advanced Algorithms"), ("BIOL", "501", "Advanced Ecology")]
        ):
            section_id = f"{term_key}-{subj}{num}-001"
            sections.append(
                {
                    "id": section_id,
                    "term": term_key,
                    "subject": subj,
                    "courseNumber": num,
                    "title": title,
                    "section": "001",
                    "activity": "Seminar",
                    "level": "Graduate",
                    "status": "Open",
                    "credits": 3,
                    "delivery": "In person",
                }
            )
            room = rooms[10 + i]
            meetings.append(
                {
                    "id": f"m{meeting_id}",
                    "sectionId": section_id,
                    "roomId": room["id"],
                    "days": ["Wed"],
                    "start": "16:00",
                    "end": "18:00",
                    "startDate": iso(term["start"]),
                    "endDate": iso(term["end"]),
                    "kind": "Seminar",
                }
            )
            meeting_id += 1

    meta = {
        "generatedAt": "2026-11-04T09:00:00-08:00",
        "academicYear": "2026-27",
        "campus": "UBC Okanagan",
        "source": "Demo fixture — not real Workday data",
        "sourceUrl": "https://wd10.myworkday.com/ubc/",
        "demo": True,
        "terms": [
            {
                "key": k,
                "label": v["label"],
                "start": iso(v["start"]),
                "end": iso(v["end"]),
            }
            for k, v in TERMS.items()
        ],
        "counts": {
            "sections": len(sections),
            "meetings": len(meetings),
            "rooms": len(rooms),
            "sectionsWithoutRoom": len({s["id"] for s in sections} - {m["sectionId"] for m in meetings if m["roomId"]}),
        },
        "nonTeachingPeriods": [
            {
                "start": "2026-11-09",
                "end": "2026-11-13",
                "reason": "Winter Term 1 midterm break",
            },
            {
                "start": "2026-11-11",
                "end": "2026-11-11",
                "reason": "Remembrance Day (university closed)",
            },
            {
                "start": "2026-12-10",
                "end": "2027-01-04",
                "reason": "Winter break between terms",
            },
            {
                "start": "2027-02-15",
                "end": "2027-02-19",
                "reason": "Winter Term 2 midterm break",
            },
            {
                "start": "2027-03-26",
                "end": "2027-03-26",
                "reason": "Good Friday (university closed)",
            },
            {
                "start": "2027-03-29",
                "end": "2027-03-29",
                "reason": "Easter Monday (university closed)",
            },
        ],
        "coverage": {
            "levels": ["Undergraduate", "Graduate"],
            "terms": list(TERMS),
            "collectionMethod": "Demo generator",
        },
        "warnings": [
            "This is demo data generated for interface testing. It does not represent real UBCO classes or room availability.",
            "Replace data/schedule.json with a verified Workday collection before relying on results.",
        ],
    }

    payload = {
        "meta": meta,
        "rooms": rooms,
        "sections": sections,
        "meetings": meetings,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"Wrote {OUT} ({len(sections)} sections, {len(meetings)} meetings, {len(rooms)} rooms)")


if __name__ == "__main__":
    main()
