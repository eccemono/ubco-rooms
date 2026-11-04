import {
  detectInputIssues,
  eventsForRoomOnDate,
  formatTerm,
  freeIntervalsForRoom,
  getRoomHours,
  hmToMinutes,
  isDateInRange,
  minutesToLabel,
  prettyDate,
  termForDate,
  weekdayName,
} from "./data.js";

const BUILDING_PRIORITY = ["ASC", "ART", "EME", "FIP", "SCI", "COM"];
const NEVER_SHOW_BUILDINGS = new Set(["ADM", "UCH"]);
const TRANSFER_MINUTES = 15;
const TRANSITION_MINUTES = 10;
const MAX_EXACT_RESULTS = 40;
const MAX_COMBO_RESULTS = 5;

function buildingRank(code) {
  const index = BUILDING_PRIORITY.indexOf(code);
  return index === -1 ? BUILDING_PRIORITY.length : index;
}

function findContainingBlock(blocks, start, end) {
  return blocks.find((b) => b.start <= start && b.end >= end) || null;
}

function cushionScore(slackBefore, slackAfter) {
  const usableAfter = slackAfter - TRANSITION_MINUTES;
  const min = Math.min(slackBefore, usableAfter);
  let tier = 3;
  if (min >= 30) tier = 0;
  else if (min >= 15) tier = 1;
  else if (min >= 0) tier = 2;
  return { tier, min, usableAfter };
}

export function searchAvailability(dataset, options) {
  const { date, start, end, building = "", allowLabs = false } = options;

  const startMin = hmToMinutes(start);
  const endMin = hmToMinutes(end);
  const issues = detectInputIssues(dataset.meta, date, startMin, endMin);
  if (issues.length) {
    return { issues, exact: [], combos: [], date, startMin, endMin, transfer: TRANSFER_MINUTES };
  }

  const term = termForDate(dataset.meta, date);
  const rooms = dataset.rooms.filter((r) => {
    if (NEVER_SHOW_BUILDINGS.has(r.buildingCode)) return false;
    if (dataset.specializedRoomIds?.has(r.id)) return false;
    if (building && r.buildingCode !== building) return false;
    if (!allowLabs && dataset.labRoomIds?.has(r.id)) return false;
    return true;
  });
  const candidates = [];

  for (const room of rooms) {
    const { hours, events, blocks } = freeIntervalsForRoom(dataset, room, date);
    if (!hours) continue;
    const block = findContainingBlock(blocks, startMin, endMin);
    if (!block) continue;

    const slackBefore = startMin - block.start;
    const slackAfter = block.end - endMin;
    const cushion = cushionScore(slackBefore, slackAfter);
    const nextEvent = events.find((ev) => ev.start >= endMin) || null;
    const prevEvent = [...events].reverse().find((ev) => ev.end <= startMin) || null;

    candidates.push({
      kind: "exact",
      room,
      block,
      hours,
      events,
      nextEvent,
      prevEvent,
      slackBefore,
      slackAfter,
      usableAfter: Math.max(0, cushion.usableAfter),
      cushion,
      freeDuration: block.end - block.start,
      buildingRank: buildingRank(room.buildingCode),
      sameBuilding: Boolean(building && room.buildingCode === building),
    });
  }

  candidates.sort((a, b) => {
    if (a.cushion.tier !== b.cushion.tier) return a.cushion.tier - b.cushion.tier;
    if (a.buildingRank !== b.buildingRank) return a.buildingRank - b.buildingRank;
    if (a.cushion.min !== b.cushion.min) return b.cushion.min - a.cushion.min;
    if (a.freeDuration !== b.freeDuration) return b.freeDuration - a.freeDuration;
    return a.room.name.localeCompare(b.room.name);
  });

  const exact = candidates.slice(0, MAX_EXACT_RESULTS).map((c) => ({
    ...c,
    term,
    date,
    startMin,
    endMin,
    requestedMinutes: endMin - startMin,
  }));

  let combos = [];
  if (options.includeCombos !== false && exact.length < 10) {
    combos = findCombinations(dataset, {
      date,
      startMin,
      endMin,
      building,
      rooms,
      term,
    });
  }

  return {
    issues: [],
    exact,
    combos,
    date,
    startMin,
    endMin,
    term,
    transfer: TRANSFER_MINUTES,
    allowLabs,
    requestedMinutes: endMin - startMin,
    weekday: weekdayName(date),
  };
}

function findCombinations(dataset, { date, startMin, endMin, building, rooms, term }) {
  const pool = [];
  for (const room of rooms) {
    const { hours, blocks } = freeIntervalsForRoom(dataset, room, date);
    if (!hours) continue;
    const relevant = blocks
      .map((b) => ({ start: Math.max(b.start, startMin), end: Math.min(b.end, endMin), raw: b }))
      .filter((b) => b.end - b.start >= 15);
    if (!relevant.length) continue;
    pool.push({ room, hours, blocks, relevant, buildingRank: buildingRank(room.buildingCode) });
  }

  if (pool.length < 2) return [];

  const minSegment = 20;
  const options = [];

  for (let i = 0; i < pool.length; i += 1) {
    for (let j = 0; j < pool.length; j += 1) {
      if (i === j) continue;
      const a = pool[i];
      const b = pool[j];
      const aBlocks = a.blocks.filter((bl) => bl.start <= startMin && bl.end > startMin + minSegment);
      const bBlocks = b.blocks.filter((bl) => bl.end >= endMin + 5 && bl.start < endMin - minSegment);
      if (!aBlocks.length || !bBlocks.length) continue;

      for (const aBlock of aBlocks) {
        for (const bBlock of bBlocks) {
          const earliest = Math.max(startMin + minSegment, aBlock.start + minSegment);
          const latest = Math.min(
            endMin - minSegment - TRANSFER_MINUTES,
            bBlock.end - minSegment - TRANSFER_MINUTES
          );
          if (latest < earliest) continue;

          const points = new Set();
          points.add(earliest);
          points.add(latest);
          points.add(Math.round((earliest + latest) / 2));
          for (let t = Math.ceil(earliest / 30) * 30; t <= latest; t += 30) points.add(t);

          for (const point of points) {
            const split = Math.round(point / 15) * 15;
            if (split < aBlock.start || split > aBlock.end) continue;
            const secondStart = split + TRANSFER_MINUTES;
            if (secondStart < bBlock.start || secondStart > bBlock.end) continue;

            const firstMinutes = split - startMin;
            const secondMinutes = endMin - secondStart;
            if (firstMinutes < minSegment || secondMinutes < minSegment) continue;

            const sameBuilding = a.room.buildingCode === b.room.buildingCode;
            const score =
              a.buildingRank * 12 +
              b.buildingRank * 12 +
              (sameBuilding ? 0 : 35) +
              Math.abs(firstMinutes - secondMinutes) * 0.1;

            options.push({
              kind: "combo",
              rooms: [a.room, b.room],
              blocks: [aBlock, bBlock],
              split,
              secondStart,
              sameBuilding,
              score,
              term,
              date,
              startMin,
              endMin,
              requestedMinutes: endMin - startMin,
            });
          }
        }
      }
    }
  }

  const seen = new Set();
  return options
    .sort((x, y) => x.score - y.score)
    .filter((o) => {
      const key = `${o.rooms[0].id}|${o.rooms[1].id}|${o.split}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_COMBO_RESULTS)
    .map((o) => ({
      ...o,
      first: { room: o.rooms[0], start: startMin, end: o.split, block: o.blocks[0] },
      second: { room: o.rooms[1], start: o.secondStart, end: endMin, block: o.blocks[1] },
    }));
}

export function roomDayView(dataset, roomId, date) {
  const room = dataset.roomById.get(roomId);
  if (!room) return null;
  const hours = getRoomHours(room, date);
  if (!hours) return { room, date, hours: null, events: [], segments: [] };

  const events = eventsForRoomOnDate(dataset, room.id, date);
  const segments = [];
  let cursor = hours.open;
  for (const ev of events) {
    if (ev.end <= hours.open || ev.start >= hours.close) continue;
    const start = Math.max(ev.start, hours.open, cursor);
    const end = Math.min(ev.end, hours.close);
    if (end <= start) continue;
    if (start > cursor) segments.push({ type: "free", start: cursor, end: start });
    segments.push({ type: "event", start, end, event: ev });
    cursor = end;
  }
  if (cursor < hours.close) segments.push({ type: "free", start: cursor, end: hours.close });
  return { room, date, hours, events, segments };
}

export function buildCourseRows(dataset) {
  const bySection = new Map();
  for (const meeting of dataset.meetings) {
    if (!bySection.has(meeting.sectionId)) bySection.set(meeting.sectionId, []);
    bySection.get(meeting.sectionId).push(meeting);
  }

  return dataset.sections.map((section) => {
    const meetings = (bySection.get(section.id) || []).sort(
      (a, b) => a.startMin - b.startMin || a.endMin - b.endMin
    );
    const days = [...new Set(meetings.flatMap((m) => m.days || []))];
    const times = [...new Set(meetings.map((m) => `${m.start}–${m.end}`))];
    const roomNames = [
      ...new Set(
        meetings
          .map((m) => (m.roomId ? dataset.roomById.get(m.roomId)?.name : null))
          .filter(Boolean)
      ),
    ];
    return {
      ...section,
      meetings,
      dayText: days.length ? days.join(" ") : "—",
      timeText: times.length ? times.join(" · ") : "—",
      roomText: roomNames.length ? roomNames.join(" · ") : section.delivery === "Online" ? "Online" : "Not listed",
      roomIds: meetings.map((m) => m.roomId).filter(Boolean),
      searchText: [
        section.subject,
        section.courseNumber,
        section.title,
        section.section,
        section.activity,
        section.level,
        ...roomNames,
      ]
        .join(" ")
        .toLowerCase(),
    };
  });
}

export function datasetStats(dataset) {
  const roomsWithMeetings = new Set(dataset.meetings.map((m) => m.roomId).filter(Boolean));
  const sectionsWithoutRoom = new Set(
    dataset.sections
      .filter((s) => !dataset.meetings.some((m) => m.sectionId === s.id && m.roomId))
      .map((s) => s.id)
  );
  return {
    rooms: dataset.rooms.length,
    roomsUsed: roomsWithMeetings.size,
    sections: dataset.sections.length,
    meetings: dataset.meetings.length,
    sectionsWithoutRoom: sectionsWithoutRoom.size,
    terms: dataset.meta.terms?.length || 0,
    generatedAt: dataset.meta.generatedAt,
    source: dataset.meta.source,
  };
}

export { formatTerm, prettyDate, minutesToLabel, isDateInRange, buildingRank, NEVER_SHOW_BUILDINGS };
