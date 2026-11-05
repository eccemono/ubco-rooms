# Workday capture helper

This folder contains a **local, user-driven** capture helper. It exists because Workday’s student records sit behind CWL + MFA, and this project deliberately does not ask for your password, store session cookies in the repository, or try to bypass access controls.

## What it does

1. Opens a normal Chromium window with a persistent profile in `.workday-profile/` (git-ignored).
2. Waits for **you** to sign in and run four Find Course Sections searches.
3. After each search, tries Workday’s **Export to Excel** control.
4. If no export is available, saves the visible page’s table data, page text, and HTML to `../data/raw/` for parser tuning.

## What it does not do

- It does not handle your CWL password or MFA.
- It does not run unattended.
- It does not access any account other than the one you sign into.
- It does not send data anywhere.

## Reliable path: capture by course level

Workday may hide or disable the Excel icon for large reports. This captures the report as text in five slices instead:

```bash
node capture_levels.mjs
```

It signs in with the saved profile (the owner approved this), selects both terms and both levels, then scrolls through `100 Level` to `500 Level` and writes `../data/raw/level-*.json`.

Then run `../tools/import_levels.sh`.

## Run it

```bash
cd collector
npm install
npx playwright install chromium
npm run collect
```

The terminal will ask you to set:

| Term | Academic Level |
|---|---|
| 2026-27 Winter Term 1 (UBC-O) | Undergraduate |
| 2026-27 Winter Term 1 (UBC-O) | Graduate |
| 2026-27 Winter Term 2 (UBC-O) | Undergraduate |
| 2026-27 Winter Term 2 (UBC-O) | Graduate |

For each one:

1. In Workday: **Academics → Registration & Courses → Find Course Sections**.
2. Set **Start Date within** to the requested term.
3. Set **Academic Level** to the requested level.
4. Do **not** select **Academic Level Not Applicable**.
5. Click OK and wait for the results table.
6. Press Enter in the terminal.

You can skip a combination by typing `s` at the prompt.

## If the export button is not found

Workday tenants differ. If the script says “No Excel export found”, you can:

- Use the spreadsheet icon in the report toolbar manually, then save the file into `../data/raw/`.
- Keep the saved HTML/DOM snapshot and send it back so the parser can be adjusted.
- Run `npm run collect` again with `--only=2026W1-ug` to capture one combination at a time.

## Output

```text
data/raw/
  2026W1-ug-<name>.xlsx         Workday export, if available
  2026W1-ug-page.json           DOM snapshot fallback
  2026W1-ug-page.html           page HTML fallback
```

`data/raw/` is git-ignored. Do not publish it: it may contain account chrome, session state, or other students’ information depending on the report.

## Privacy

Use your own account and follow UBC’s computing policies. Only collect what you need for the room finder: course section identifiers, meeting times, rooms, and dates. Do not collect enrolment, grades, student names, or instructor personal information.


## SWS room timetable overlay

`collect_sws.mjs` opens a local headed Chromium window at the UBC SWS room timetable and keeps the authenticated profile outside the repository.

```bash
node collect_sws.mjs
```

You sign in yourself with CWL and complete Duo. The profile is stored at `~/.ubco-sws-profile`; it contains session cookies, so treat it as sensitive and delete it to sign out. Session duration is controlled by UBC SSO/BIG-IP and may require re-login after hours or days.

Once the SWS home page is visible, `collect_sws.mjs` writes an authenticated cookie snapshot to `.sws-storage-state.json` (mode 0600, git-ignored). It also updates it every 30 seconds while the window is open.

### Capture and parse

```bash
# full year, all rooms: about 2 minutes and 12 MB raw
node capture_sws.mjs --scope=all

# current week only: about 6 seconds
node capture_sws.mjs --scope=current --output=../data/raw/sws-current.txt

# normalize into ../data/sws-2026-27.json
python3 ../tools/parse_sws.py
```

The `List Timetable` export is the useful format. It contains course meetings, room-booking events, DRC exams and `University Closed` rows. The parser deduplicates repeated closure rows, maps SWS room codes to the app’s room IDs, converts week numbers to date ranges, and drops `WRB-CANCELLED` records.

### Daily timer

The units in `systemd/` run `refresh_sws.sh` daily. They are installed as user units on this machine:

```bash
systemctl --user list-timers ubco-rooms-sws.timer
systemctl --user start ubco-rooms-sws.service
journalctl --user -u ubco-rooms-sws.service -n 50
```

The timer uses the cookie snapshot, so it does **not** prompt for CWL/Duo. If the SWS session has expired, the service exits with code 2 and keeps the previous `data/sws-2026-27.json`. Re-run the interactive login to refresh the snapshot. `refresh_sws.sh` writes status to `../data/raw/sws-refresh-status.json`.
