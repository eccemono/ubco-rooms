# UBCO Room Finder

A static website and Excel workbook for answering one question:

> “It’s Wednesday at 1pm — which classrooms have no scheduled class, and is there a room change that would let us study for three hours?”

The project is built for UBC Okanagan’s 2026–27 Winter Terms 1 and 2. It is a personal student project, not an official UBC service.

**The bundled dataset is a demo fixture** until you replace it with a real Workday collection. The site says so prominently.

---

## What is in the box

- **A static website** (`index.html`, `assets/`) that runs entirely in the browser.
  - Date + time room search.
  - “No class listed” results ranked by room size and surrounding free time.
  - Two-room combination finder when no single room covers the whole window.
  - Day timetable for any room.
  - Searchable course/section table.
  - Local JSON import, so you can try a real dataset without redeploying.
- **An Excel workbook** (`exports/ubco-2026-27.xlsx`) with Sections, Meetings, Rooms, and Data Quality sheets.
- **A Workday capture helper** (`collector/`) that opens a local browser, lets you sign in, and saves the results of Find Course Sections. It never handles your password or MFA.
- **A parser** (`tools/import_workday.py`) that converts a Workday Excel/CSV export into the website dataset.
- **A workbook builder** (`tools/build_workbook.py`).

---

## Quick start (see the demo)

```bash
cd Projects/ubco-rooms
python3 -m http.server 8087
# open http://127.0.0.1:8087
```

Do not open `index.html` with `file://`; the browser blocks loading `data/schedule.json`.

You can also serve it with any static host. All URLs are relative, so it works under a GitHub Pages project subpath such as `https://example.com/ubco-rooms/`.

---

## Getting the real data

### 1. Capture from Workday

The collector uses a normal Chromium window and a persistent, local profile. You sign in with CWL + MFA yourself.

```bash
cd collector
npm install
npx playwright install chromium
npm run collect
```

Then follow the terminal prompts for each of these four searches:

| Term | Academic Level |
|---|---|
| 2026-27 Winter Term 1 (UBC-O) | Undergraduate |
| 2026-27 Winter Term 1 (UBC-O) | Graduate |
| 2026-27 Winter Term 2 (UBC-O) | Undergraduate |
| 2026-27 Winter Term 2 (UBC-O) | Graduate |

Do **not** choose “Academic Level Not Applicable” — UBCO’s own instructions note that it errors.

The script tries Workday’s **Export to Excel** button first. If it cannot find one, it saves the visible page’s HTML and table text to `data/raw/` so the parser can be tuned against the real layout.

Workday occasionally changes its DOM. If the DOM fallback produces an empty table, export the report manually with the Excel icon and put the file in `data/raw/`.

### 2. Parse the export

```bash
cd ..
.venv/bin/python tools/import_workday.py data/raw/*.xlsx
```

The parser:
- Finds the header row even when the export starts with title rows.
- Understands common Workday column names and grouped/blank continuation rows.
- Parses compact day strings (`MoWeFr`, `TuTh`, `MWF`, `TTh`) and 12/24-hour time ranges.
- Pulls rooms out of meeting-pattern text (`... | SCI 333`).
- Infers the term and level from the export or filename (`2026W1-ug.xlsx`).
- Writes `data/schedule.json` and `data/import-report.json`.
- Leaves uncertain fields blank and reports them; it does not invent rooms or times.

If your export uses different columns, send one raw file (or the saved HTML) back for a parser adjustment.

### 3. Review before trusting it

Open the site, go to **About the data**, and check:
- Sections and meeting counts.
- Sections with no room.
- Warnings.
- A few known courses and rooms against Workday.

Then rebuild the workbook:

```bash
.venv/bin/python tools/build_workbook.py
```

### 4. Optional: add room capacities

Workday may not export capacities. The site works without them; it simply skips capacity filtering. To add them, create a CSV with:

```csv
room,capacity,layout,features,hours
SCI 333,109,Tiered classroom,projector;av,M-F 07:30-22:00; Sa-Su closed
```

Then merge it (script is intentionally small and reviewable):

```bash
.venv/bin/python tools/merge_rooms.py data/rooms.csv
```

Capacity is a convenience, not a source of truth. Verify against the room before relying on it.

---

## Refresh workflow

```bash
# 1. capture new Workday exports into data/raw/
cd collector && npm run collect && cd ..

# 2. rebuild the dataset
.venv/bin/python tools/import_workday.py data/raw/*.xlsx

# 3. rebuild the Excel workbook
.venv/bin/python tools/build_workbook.py

# 4. check the site locally
python3 -m http.server 8087
```

The site is a snapshot. It has no server, no live Workday connection, and no background refresh. A failed import should not be deployed; keep the previous `schedule.json` until the new one passes review.

---

## Deploying to GitHub Pages

The site is plain static files. Put the contents of this folder in a repository (or a subfolder of an existing Pages site) and publish with Pages.

If using a project site, the URL is normally:

```
https://<user>.github.io/<repo>/
```

If your custom domain is attached to a user/organization site, project repositories are served under:

```
https://<your-domain>/<repo>/
```

This repo includes `.github/workflows/pages.yml`, which publishes the root folder with GitHub Actions. To use it:

1. Push the repo to GitHub.
2. Go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push to `main`.

Recommended settings:
- Publish from the branch/folder that contains `index.html`.
- Keep `.nojekyll` at the publish root.
- Use relative paths (already done).
- Do not commit `.workday-profile/`, `data/raw/` cookies/sessions, or any downloaded page that contains personal account data.

Check whether your Workday export or derived dataset may be redistributed before publishing it. If in doubt, deploy the tool without the data and use the local **import schedule.json** control.

---

## How availability is calculated

1. Each section has one or more meeting patterns: days, start/end time, room, and date range.
2. For a chosen date, the site keeps meetings whose weekday and start/end dates match.
3. It subtracts those meetings from the room’s listed building hours.
4. A room is a match if a free interval contains the requested window.
5. Results prefer rooms that fit the group, are in the selected building, and have useful free time around the session.
6. If no single room covers the window, the combination finder looks for two rooms with a 10-minute transfer.

All calculations use **America/Vancouver** wall-clock times. The site does not currently model alternating-week patterns unless they are represented as separate date-ranged meetings in the source.

## What the site cannot know

- Ad-hoc bookings, exams, events, maintenance closures, and department-controlled rooms.
- Whether a door is unlocked or a room is restricted.
- Changes made in Workday after collection.

The correct reading of a result is:

> **“No scheduled class appears in this dataset.”**

It is not a reservation, a guarantee, or permission to use the room.

---

## Project layout

```text
ubco-rooms/
  index.html                 static app shell
  assets/
    app.js                   UI and rendering
    engine.js                availability + combination search
    data.js                  dataset loading, time and room helpers
    styles.css
  data/
    schedule.json            the dataset the site loads
    raw/                     Workday exports / DOM snapshots (not deployed)
  exports/
    ubco-2026-27.xlsx        generated workbook
  collector/
    collect_workday.mjs      local, user-driven Workday capture
  tools/
    import_workday.py        export -> normalized dataset
    build_workbook.py        dataset -> Excel
    make_demo.py             regenerate the demo fixture
    merge_rooms.py           optional room metadata merge
  samples/
    sample-workday.xlsx      parser fixture
```

---

## Known limitations

- The bundled data is fake. Replace it.
- Workday exports are not a stable public API; the parser may need tuning for your tenant’s exact columns.
- Room capacities and building hours need verification.
- The combination finder supports one room change (two rooms), not arbitrary chains.
- Full-year and alternating-week meetings depend on how the export represents their dates.
- Exam-period availability is intentionally not estimated; dates outside teaching periods return a warning instead of “everything is free”.

## Regenerating the demo

```bash
python3 tools/make_demo.py
.venv/bin/python tools/build_workbook.py
```

The demo is deterministic and clearly marked in `meta.demo`.

---

Personal project. Not affiliated with UBC. Always confirm space use with [UBCO room booking](https://bookspace.ok.ubc.ca/).
