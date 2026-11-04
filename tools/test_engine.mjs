#!/usr/bin/env node
/**
 * Lightweight regression checks for the availability engine.
 * Run: node tools/test_engine.mjs
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDataset, weekdayName } from "../assets/data.js";
import { buildCourseRows, dayAvailability, roomDayView, searchAvailability } from "../assets/engine.js";

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
let exact = null;
for (const [start, end] of [["13:00", "15:00"], ["08:00", "09:00"], ["19:00", "20:00"], ["10:00", "11:00"]]) {
  const attempt = searchAvailability(dataset, { date, start, end, building: "", allowLabs: true });
  if (attempt.exact.length > 0) {
    exact = attempt;
    break;
  }
}
check("search runs without issues", Boolean(exact), "no free room found in sampled windows");
if (exact) {
  const startMin = exact.startMin;
  const endMin = exact.endMin;
  check("exact matches actually contain the window", exact.exact.every((r) => r.block.start <= startMin && r.block.end >= endMin));
  check(
    "exact matches have no overlapping event",
    exact.exact.every((r) => r.events.every((ev) => ev.end <= startMin || ev.start >= endMin))
  );
}

const combo = searchAvailability(dataset, {
  date,
  start: "09:00",
  end: "18:00",
  building: "SCI",
  allowLabs: true,
});
check("long SCI window is handled", combo.issues.length === 0);
for (const option of combo.combos) {
  check(
    `combo covers window (${option.rooms.map((r) => r.name).join(" → ")})`,
    option.first.start === option.startMin &&
      option.first.end <= option.second.start &&
      option.second.end === option.endMin
  );
  check(
    `combo transfer is honoured (${option.rooms.map((r) => r.name).join(" → ")})`,
    option.second.start - option.first.end >= 15
  );
}

const defaultSearch = searchAvailability(dataset, { date, start: "14:00", end: "16:00" });
check("default search hides lab rooms", defaultSearch.exact.every((r) => !dataset.labRoomIds.has(r.room.id)));
check(
  "default search hides ADM and UCH",
  defaultSearch.exact.every((r) => !["ADM", "UCH"].includes(r.room.buildingCode))
);
check(
  "default search hides CCS studio rooms",
  defaultSearch.exact.every((r) => !dataset.specializedRoomIds.has(r.room.id))
);
const labSearch = searchAvailability(dataset, { date, start: "14:00", end: "16:00", allowLabs: true });
check("allow-labs search still hides restricted buildings", labSearch.exact.every((r) => !["ADM", "UCH"].includes(r.room.buildingCode)));
check("allow-labs search still hides CCS studios", labSearch.exact.every((r) => !dataset.specializedRoomIds.has(r.room.id)));

const overview = dayAvailability(dataset, { date, buildings: ["ASC", "ART", "EME", "FIP", "SCI", "COM"] });
check("day overview has 15-minute slots", overview.slots.length === 60);
check("day overview has some available slots", overview.slots.some((s) => s.count > 0));
check("empty building selection is explicit", dayAvailability(dataset, { date, buildings: [] }).issues.length > 0);

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
