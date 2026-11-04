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
