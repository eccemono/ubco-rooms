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

const TRANSFER_MINUTES = 10;
const MAX_EXACT_RESULTS = 40;
const MAX_COMBO_RESULTS = 5;

function capacityInfo(room, people) {
  if (room.capacity == null) return { ok: true, unknown: true, delta: 0 };
  return { ok: room.capacity >= people, unknown: false, delta: room.capacity - people };
}

function roomSortKey(room, people, buildingFilter) {
  const cap = capacityInfo(room, people);
  return [
    cap.ok ? 0 : 1,
    cap.unknown ? 1 : 0,
    room.buildingCode === buildingFilter ? 0 : 1,
    Math.abs(cap.delta),
    room.buildingCode,
    room.number,
  ];
}

function sortRooms(rooms, people, buildingFilter) {
  return rooms.sort((a, b) => {
    const ka = roomSortKey(a, people, buildingFilter);
    const kb = roomSortKey(b, people, buildingFilter);
    for (let i = 0; i < ka.length; i += 1) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });
}

function findContainingBlock(blocks, start, end) {
  return blocks.find((b) => b.start <= start && b.end >= end) || null;
}

function findBlockCovering(blocks, start, end) {
  return blocks.find((b) => b.end > start && b.start < end) || null;
}

export function searchAvailability(dataset, options) {
  const {
    date,
    start,
    end,
    people = 1,
    building = "",
    termKey = "",
    allowMoves = true,
  } = options;

  const startMin = hmToMinutes(start);
  const endMin = hmToMinutes(end);
  const issues = detectInputIssues(dataset.meta, date, startMin, endMin);
  if (issues.length) {
    return { issues, exact: [], combos: [], date, startMin, endMin, transfer: TRANSFER_MINUTES };
  }

  const term = termKey
    ? dataset.meta.terms?.find((t) => t.key === termKey)
    : termForDate(dataset.meta, date);

  const rooms = dataset.rooms.filter((r) => !building || r.buildingCode === building);
  const candidates = [];

  for (const room of rooms) {
    const cap = capacityInfo(room, people);
    if (!cap.ok) continue;
    const { hours, events, blocks } = freeIntervalsForRoom(dataset, room, date);
    if (!hours) continue;
    const block = findContainingBlock(blocks, startMin, endMin);
    if (!block) continue;

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
      slackBefore: startMin - block.start,
      slackAfter: block.end - endMin,
      freeDuration: block.end - block.start,
      capacity: cap,
      sameBuilding: Boolean(building && room.buildingCode === building),
    });
  }

  // Prefer rooms that are not comically oversized, then rooms with useful free
  // time around the requested window.
  candidates.sort((a, b) => {
    if (a.capacity.unknown !== b.capacity.unknown) return a.capacity.unknown ? 1 : -1;
    if (a.sameBuilding !== b.sameBuilding) return a.sameBuilding ? -1 : 1;
    const aCap = a.room.capacity || 0;
    const bCap = b.room.capacity || 0;
    const aOver = aCap ? Math.max(0, aCap - people) : 0;
    const bOver = bCap ? Math.max(0, bCap - people) : 0;
    if (aOver !== bOver) return aOver - bOver;
    const aSlack = Math.min(a.slackAfter, 180) + Math.min(a.slackBefore, 60) * 0.4;
    const bSlack = Math.min(b.slackAfter, 180) + Math.min(b.slackBefore, 60) * 0.4;
    if (aSlack !== bSlack) return bSlack - aSlack;
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
  if (allowMoves && exact.length === 0) {
    combos = findCombinations(dataset, {
      date,
      startMin,
      endMin,
      people,
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
    requestedMinutes: endMin - startMin,
    weekday: weekdayName(date),
  };
}

function findCombinations(dataset, { date, startMin, endMin, people, building, rooms, term }) {
  const pool = [];
  for (const room of rooms) {
    const cap = capacityInfo(room, people);
    if (!cap.ok) continue;
    const { hours, blocks } = freeIntervalsForRoom(dataset, room, date);
    if (!hours) continue;
    const relevant = blocks
      .map((b) => ({ start: Math.max(b.start, startMin), end: Math.min(b.end, endMin), raw: b }))
      .filter((b) => b.end - b.start >= 15);
    if (!relevant.length) continue;
    pool.push({ room, cap, hours, blocks, relevant });
  }

  if (pool.length < 2) return [];

  const minSegment = 20;
  const splitStep = 5;
  const options = [];

  for (let i = 0; i < pool.length; i += 1) {
    for (let j = 0; j < pool.length; j += 1) {
      if (i === j) continue;
      const a = pool[i];
      const b = pool[j];
      const aBlocks = a.blocks.filter((bl) => bl.start <= startMin && bl.end > startMin + minSegment);
      const bBlocks = b.blocks.filter((bl) => bl.end >= endMin && bl.start < endMin - minSegment);
      if (!aBlocks.length || !bBlocks.length) continue;

      for (const aBlock of aBlocks) {
        for (const bBlock of bBlocks) {
          const earliest = Math.max(startMin + minSegment, aBlock.start + minSegment);
          const latest = Math.min(endMin - minSegment - TRANSFER_MINUTES, bBlock.end - minSegment - TRANSFER_MINUTES);
          if (latest < earliest) continue;

          // Try a few evenly spaced splits rather than every 5-minute slot. This
          // keeps the search fast while still finding sensible hand-offs.
          const points = new Set();
          points.add(earliest);
          points.add(latest);
          points.add(Math.round((earliest + latest) / 2));
          for (let t = Math.ceil(earliest / 30) * 30; t <= latest; t += 30) points.add(t);

          for (const split of points) {
            if (split < aBlock.start || split > aBlock.end) continue;
            const secondStart = split + TRANSFER_MINUTES;
            if (secondStart < bBlock.start || secondStart > bBlock.end) continue;

            const firstMinutes = split - startMin;
            const secondMinutes = endMin - secondStart;
            if (firstMinutes < minSegment || secondMinutes < minSegment) continue;

            const sameBuilding = a.room.buildingCode === b.room.buildingCode;
            const overA = a.room.capacity ? Math.max(0, a.room.capacity - people) : 0;
            const overB = b.room.capacity ? Math.max(0, b.room.capacity - people) : 0;
            const score =
              (a.room.buildingCode === building ? 0 : 100) +
              (b.room.buildingCode === building ? 0 : 100) +
              (sameBuilding ? 0 : 50) +
              overA + overB +
              Math.abs(firstMinutes - secondMinutes) * 0.1;

            options.push({
              kind: "combo",
              rooms: [a.room, b.room],
              blocks: [aBlock, bBlock],
              split,
              secondStart,
              sameBuilding,
              capacity: [a.cap, b.cap],
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

  // Deduplicate by room pair + split, then keep the best few.
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
  const merged = [];
  for (const ev of events) {
    const last = merged[merged.length - 1];
    if (last && ev.start <= last.end) last.end = Math.max(last.end, ev.end);
    else merged.push({ start: ev.start, end: ev.end });
  }
  for (const ev of events) {
    if (ev.end <= hours.open || ev.start >= hours.close) continue;
    // Clip to the opening hours and to the previous event so overlapping
    // bookings cannot produce out-of-order timeline rows.
    const start = Math.max(ev.start, hours.open, cursor);
    const end = Math.min(ev.end, hours.close);
    if (end <= start) continue;
    if (start > cursor) segments.push({ type: "free", start: cursor, end: start });
    segments.push({ type: "event", start, end, event: ev });
    cursor = end;
  }
  if (cursor < hours.close) segments.push({ type: "free", start: cursor, end: hours.close });
  return { room, date, hours, events, segments, merged };
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

export { formatTerm, prettyDate, minutesToLabel, isDateInRange };
