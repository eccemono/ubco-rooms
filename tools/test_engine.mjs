#!/usr/bin/env node
/**
 * Lightweight regression checks for the availability engine.
 * Run: node tools/test_engine.mjs
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDataset, weekdayName } from "../assets/data.js";
import { buildCourseRows, roomDayView, searchAvailability } from "../assets/engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(await readFile(path.join(__dirname, "..", "data", "schedule.json"), "utf8"));
const dataset = normalizeDataset(raw);

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log(`Dataset: ${dataset.sections.length} sections, ${dataset.meetings.length} meetings, ${dataset.rooms.length} rooms`);

const rows = buildCourseRows(dataset);
check("one course row per section", rows.length === dataset.sections.length);
check("every row has a term", rows.every((r) => r.term));
check("every meeting has a valid day", dataset.meetings.every((m) => m.dayIndexes.length > 0));

const date = "2026-11-04";
const exact = searchAvailability(dataset, {
  date,
  start: "13:00",
  end: "15:00",
  people: 2,
  building: "",
  allowMoves: true,
});
check("exact search returns matches", exact.exact.length > 0);
check("exact matches actually contain the window", exact.exact.every((r) => r.block.start <= 13 * 60 && r.block.end >= 15 * 60));
check(
  "exact matches have no overlapping event",
  exact.exact.every((r) => r.events.every((ev) => ev.end <= 13 * 60 || ev.start >= 15 * 60))
);

const combo = searchAvailability(dataset, {
  date,
  start: "09:00",
  end: "18:00",
  people: 2,
  building: "SCI",
  allowMoves: true,
});
check("long SCI window needs a combination", combo.exact.length === 0);
check("combination finder returns options", combo.combos.length > 0);
for (const option of combo.combos) {
  check(
    `combo covers window (${option.rooms.map((r) => r.name).join(" → ")})`,
    option.first.start === option.startMin &&
      option.first.end <= option.second.start &&
      option.second.end === option.endMin
  );
  check(
    `combo transfer is honoured (${option.rooms.map((r) => r.name).join(" → ")})`,
    option.second.start - option.first.end >= 10
  );
}

const roomId = dataset.rooms[0].id;
const day = roomDayView(dataset, roomId, date);
check("room day view has hours", Boolean(day?.hours || !day));
if (day?.hours) {
  check("day segments start at opening", day.segments[0].start === day.hours.open);
  check("day segments end at closing", day.segments.at(-1).end === day.hours.close);
  check("segments are ordered", day.segments.every((s, i) => i === 0 || s.start >= day.segments[i - 1].end));
}

const breakSearch = searchAvailability(dataset, {
  date: "2026-11-10",
  start: "10:00",
  end: "12:00",
  people: 2,
});
check("midterm break is not reported as free", breakSearch.issues.length > 0, JSON.stringify(breakSearch.issues));

const outside = searchAvailability(dataset, {
  date: "2027-06-01",
  start: "10:00",
  end: "12:00",
  people: 2,
});
check("summer date is refused", outside.issues.length > 0);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log(`\nAll checks passed for ${weekdayName(date)} ${date}.`);
