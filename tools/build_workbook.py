#!/usr/bin/env python3
"""Build the Excel workbook and a small data-quality report from schedule.json."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import datetime
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = ROOT / "data" / "schedule.json"
DEFAULT_OUT = ROOT / "exports" / "ubco-2026-27.xlsx"

NAVY = "002145"
TEAL = "0D7C6B"
HEAD_FILL = PatternFill("solid", fgColor=NAVY)
HEAD_FONT = Font(color="FFFFFF", bold=True, size=10)
TITLE_FONT = Font(color=NAVY, bold=True, size=16)
SUB_FONT = Font(color="4A5B70", size=10)


def clean(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Yes" if value else "No"
    return value


def add_table(ws, name: str, headers: list[str], rows: list[list], widths: list[int] | None = None):
    ws.append(headers)
    for cell in ws[1]:
        cell.fill = HEAD_FILL
        cell.font = HEAD_FONT
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    ws.row_dimensions[1].height = 28

    for row in rows:
        ws.append([clean(v) for v in row])

    if rows:
        ref = f"A1:{get_column_letter(len(headers))}{len(rows) + 1}"
        table = Table(displayName=name, ref=ref)
        table.tableStyleInfo = TableStyleInfo(
            name="TableStyleMedium2", showRowStripes=True, showFirstColumn=False
        )
        ws.add_table(table)

    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{len(rows) + 1}"
    if widths:
        for i, width in enumerate(widths, start=1):
            ws.column_dimensions[get_column_letter(i)].width = width
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = Alignment(vertical="top", wrap_text=False)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    payload = json.loads(args.data.read_text())
    meta = payload["meta"]
    rooms = payload["rooms"]
    sections = payload["sections"]
    meetings = payload["meetings"]

    room_by_id = {r["id"]: r for r in rooms}
    section_by_id = {s["id"]: s for s in sections}
    meetings_by_section: dict[str, list[dict]] = {}
    for m in meetings:
        meetings_by_section.setdefault(m["sectionId"], []).append(m)

    term_label = {t["key"]: t["label"] for t in meta.get("terms", [])}

    wb = Workbook()

    # ---------- README ----------
    ws = wb.active
    ws.title = "Read Me"
    ws.sheet_view.showGridLines = False
    ws["A1"] = "UBCO Room Finder — course and room dataset"
    ws["A1"].font = TITLE_FONT
    ws["A2"] = "Generated from the project's normalized schedule.json"
    ws["A2"].font = SUB_FONT
    ws["A4"] = "Academic year"
    ws["B4"] = meta.get("academicYear", "")
    ws["A5"] = "Campus"
    ws["B5"] = meta.get("campus", "")
    ws["A6"] = "Source"
    ws["B6"] = meta.get("source", "")
    ws["A7"] = "Generated at"
    ws["B7"] = meta.get("generatedAt", "")
    ws["A8"] = "Demo fixture"
    ws["B8"] = "YES — not real availability" if meta.get("demo") else "No"
    ws["A10"] = "Important"
    ws["A10"].font = Font(bold=True, color="A83232")
    notes = [
        "“No scheduled class” does not mean a room is free for reservation. Exams, events, maintenance and private bookings are not included.",
        "Sections without a room are kept in the Sections sheet but excluded from room recommendations.",
        "Use the Meetings sheet for one row per meeting pattern; use Sections for one row per section.",
        "Confirm every result with UBCO room booking and posted signage.",
    ]
    for i, note in enumerate(notes + list(meta.get("warnings", [])), start=11):
        ws.cell(row=i, column=1, value=f"• {note}")
        ws.cell(row=i, column=1).alignment = Alignment(wrap_text=True, vertical="top")
        ws.merge_cells(start_row=i, start_column=1, end_row=i, end_column=6)
        ws.row_dimensions[i].height = 34
    ws.column_dimensions["A"].width = 24
    ws.column_dimensions["B"].width = 70

    # ---------- SECTIONS ----------
    ws = wb.create_sheet("Sections")
    section_rows = []
    for s in sorted(sections, key=lambda x: (x.get("term", ""), x.get("subject", ""), x.get("courseNumber", ""), x.get("section", ""))):
        ms = meetings_by_section.get(s["id"], [])
        days = sorted({d for m in ms for d in m.get("days", [])})
        times = sorted({f"{m.get('start','')}–{m.get('end','')}" for m in ms})
        room_names = sorted({room_by_id[m["roomId"]]["name"] for m in ms if m.get("roomId") in room_by_id})
        section_rows.append(
            [
                term_label.get(s.get("term"), s.get("term", "")),
                s.get("level", ""),
                s.get("subject", ""),
                s.get("courseNumber", ""),
                s.get("section", ""),
                s.get("title", ""),
                s.get("activity", ""),
                s.get("credits", ""),
                s.get("delivery", ""),
                s.get("status", ""),
                " ".join(days),
                " · ".join(times),
                " · ".join(room_names) if room_names else ("Online" if s.get("delivery") == "Online" else "Not listed"),
                s.get("id", ""),
            ]
        )
    add_table(
        ws,
        "SectionsTable",
        ["Term", "Level", "Subject", "Course", "Section", "Title", "Activity", "Credits", "Delivery", "Status", "Days", "Times", "Room(s)", "Section ID"],
        section_rows,
        [26, 14, 9, 8, 9, 42, 14, 8, 14, 11, 16, 22, 20, 34],
    )

    # ---------- MEETINGS ----------
    ws = wb.create_sheet("Meetings")
    meeting_rows = []
    for m in sorted(meetings, key=lambda x: (x.get("startDate") or "", x.get("start") or "", x.get("roomId") or "")):
        s = section_by_id.get(m["sectionId"], {})
        room = room_by_id.get(m.get("roomId")) if m.get("roomId") else None
        meeting_rows.append(
            [
                term_label.get(s.get("term"), s.get("term", "")),
                s.get("level", ""),
                s.get("subject", ""),
                s.get("courseNumber", ""),
                s.get("section", ""),
                s.get("title", ""),
                s.get("activity", ""),
                " ".join(m.get("days", [])),
                m.get("start", ""),
                m.get("end", ""),
                m.get("startDate", ""),
                m.get("endDate", ""),
                room.get("buildingCode", "") if room else "",
                room.get("number", "") if room else "",
                room.get("name", "") if room else "Not listed",
                room.get("capacity", "") if room else "",
                m.get("id", ""),
                m.get("sectionId", ""),
            ]
        )
    add_table(
        ws,
        "MeetingsTable",
        ["Term", "Level", "Subject", "Course", "Section", "Title", "Activity", "Days", "Start", "End", "Start date", "End date", "Building", "Room", "Room name", "Capacity", "Meeting ID", "Section ID"],
        meeting_rows,
        [26, 14, 9, 8, 9, 40, 14, 16, 8, 8, 12, 12, 10, 8, 12, 9, 12, 34],
    )

    # ---------- ROOMS ----------
    ws = wb.create_sheet("Rooms")
    used = Counter(m.get("roomId") for m in meetings if m.get("roomId"))
    room_rows = []
    for r in sorted(rooms, key=lambda x: (x.get("buildingCode", ""), x.get("number", ""))):
        room_rows.append(
            [
                r.get("buildingCode", ""),
                r.get("buildingName", ""),
                r.get("number", ""),
                r.get("name", ""),
                r.get("capacity", ""),
                r.get("layout", ""),
                ", ".join(r.get("features", [])),
                r.get("hours", ""),
                used.get(r.get("id"), 0),
                r.get("sourceUrl", ""),
            ]
        )
    add_table(
        ws,
        "RoomsTable",
        ["Building code", "Building name", "Room number", "Room name", "Capacity", "Layout", "Features", "Hours", "Scheduled meetings", "Source"],
        room_rows,
        [12, 42, 12, 12, 10, 24, 34, 38, 18, 46],
    )

    # ---------- ROOM GRID ----------
    ws = wb.create_sheet("Room grid")
    ws.sheet_view.showGridLines = False
    slot_start = 7 * 60
    slot_end = 23 * 60
    slot_minutes = 30
    slots = list(range(slot_start, slot_end, slot_minutes))
    headers = ["Room", "Day"] + [f"{s // 60:02d}:{s % 60:02d}" for s in slots]
    ws.append(headers)
    for cell in ws[1]:
        cell.fill = HEAD_FILL
        cell.font = HEAD_FONT
        cell.alignment = Alignment(horizontal="center", vertical="center", text_rotation=90)
    ws.row_dimensions[1].height = 44

    course_short = {}
    for s in sections:
        course_short[s["id"]] = f"{s.get('subject','')} {s.get('courseNumber','')} {s.get('section','')}".strip()

    day_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    occupied_fill = PatternFill("solid", fgColor="D9EEE9")
    for r in sorted(rooms, key=lambda x: (x.get("buildingCode", ""), x.get("number", ""))):
        for day in day_names:
            cells = [""] * len(slots)
            for m in meetings:
                if m.get("roomId") != r["id"] or day not in m.get("days", []):
                    continue
                start = int(m["start"].split(":")[0]) * 60 + int(m["start"].split(":")[1])
                end = int(m["end"].split(":")[0]) * 60 + int(m["end"].split(":")[1])
                code = course_short.get(m["sectionId"], m["sectionId"])
                for idx, slot in enumerate(slots):
                    if start < slot + slot_minutes and end > slot:
                        cells[idx] = f"{cells[idx]} / {code}" if cells[idx] else code
            ws.append([r["name"], day] + cells)

    for row in ws.iter_rows(min_row=2, min_col=3):
        for cell in row:
            if cell.value:
                cell.fill = occupied_fill
                cell.font = Font(size=8)
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

    ws.freeze_panes = "C2"
    ws.column_dimensions["A"].width = 12
    ws.column_dimensions["B"].width = 8
    for i in range(3, len(headers) + 1):
        ws.column_dimensions[get_column_letter(i)].width = 7

    # ---------- QUALITY ----------
    ws = wb.create_sheet("Data quality")
    ws.sheet_view.showGridLines = False
    ws["A1"] = "Data quality summary"
    ws["A1"].font = TITLE_FONT
    total_sections = len(sections)
    with_room = sum(1 for s in sections if any(m.get("roomId") for m in meetings_by_section.get(s["id"], [])))
    no_room = total_sections - with_room
    missing_room_meetings = sum(1 for m in meetings if not m.get("roomId"))
    unknown_rooms = sorted({m.get("roomId") for m in meetings if m.get("roomId") and m.get("roomId") not in room_by_id})
    rows = [
        ("Sections", total_sections),
        ("Sections with at least one room", with_room),
        ("Sections with no room", no_room),
        ("Meeting patterns", len(meetings)),
        ("Meeting patterns without a room", missing_room_meetings),
        ("Rooms in directory", len(rooms)),
        ("Rooms referenced by a meeting", len([r for r in rooms if used.get(r["id"])])),
        ("Unknown room references", len(unknown_rooms)),
        ("Terms", len(meta.get("terms", []))),
        ("Generated at", meta.get("generatedAt", "")),
    ]
    for i, (label, value) in enumerate(rows, start=3):
        ws.cell(row=i, column=1, value=label).font = Font(bold=True)
        ws.cell(row=i, column=2, value=value)
    ws.column_dimensions["A"].width = 38
    ws.column_dimensions["B"].width = 46

    args.out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(args.out)
    print(
        f"Wrote {args.out} · {total_sections} sections, {len(meetings)} meeting patterns, "
        f"{len(rooms)} rooms, {no_room} sections without a room"
    )
    if unknown_rooms:
        print("WARNING: unknown room IDs:", ", ".join(map(str, unknown_rooms[:10])))


if __name__ == "__main__":
    main()
