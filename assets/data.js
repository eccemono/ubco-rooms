const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_TO_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function hmToMinutes(value) {
  if (!value || typeof value !== "string") return null;
  const m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function minutesToHm(total) {
  const t = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

export function minutesToLabel(total, { compact = false } = {}) {
  if (total == null || Number.isNaN(total)) return "—";
  const t = ((total % 1440) + 1440) % 1440;
  let h = Math.floor(t / 60);
  const m = t % 60;
  const suffix = h >= 12 ? "pm" : "am";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  if (compact && m === 0) return `${h}${suffix}`;
  return m === 0 ? `${h}${suffix}` : `${h}:${String(m).padStart(2, "0")}${suffix}`;
}

export function weekdayForDate(dateString) {
  if (!dateString) return null;
  const d = new Date(`${dateString}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCDay();
}

export function weekdayName(dateString) {
  const idx = weekdayForDate(dateString);
  return idx == null ? "" : DAY_NAMES[idx];
}

export function prettyDate(dateString, { withYear = true } = {}) {
  if (!dateString) return "—";
  const d = new Date(`${dateString}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateString;
  return d.toLocaleDateString("en-CA", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}

export function parseHours(spec) {
  // "M-F 06:00-23:00; Sa-Su 07:00-22:00"
  const result = new Map();
  if (!spec || typeof spec !== "string") return result;
  const daySets = {
    "M-F": [1, 2, 3, 4, 5],
    "M-Su": [1, 2, 3, 4, 5, 6, 0],
    "Sa-Su": [6, 0],
    "Sa": [6],
    "Su": [0],
    "M": [1],
    "Tu": [2],
    "W": [3],
    "Th": [4],
    "F": [5],
  };
  for (const raw of spec.split(";")) {
    const chunk = raw.trim();
    const m = chunk.match(/^([A-Za-z-]+)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
    if (!m) continue;
    const days = daySets[m[1]];
    if (!days) continue;
    const open = hmToMinutes(m[2]);
    let close = hmToMinutes(m[3]);
    if (open == null || close == null) continue;
    if (close <= open) close += 1440;
    for (const day of days) result.set(day, { open, close });
  }
  return result;
}

export function isDateInRange(dateString, start, end) {
  return Boolean(dateString && start && end && dateString >= start && dateString <= end);
}

export function termForDate(meta, dateString) {
  return (meta?.terms || []).find((t) => isDateInRange(dateString, t.start, t.end)) || null;
}

export function nonTeachingForDate(meta, dateString) {
  return (meta?.nonTeachingPeriods || []).find((p) => isDateInRange(dateString, p.start, p.end)) || null;
}

export function detectInputIssues(meta, dateString, startMin, endMin) {
  const issues = [];
  if (!dateString) issues.push("Choose a date.");
  if (startMin == null || endMin == null) issues.push("Choose a start and end time.");
  if (startMin != null && endMin != null && endMin <= startMin) issues.push("End time must be after start time.");
  if (dateString && !termForDate(meta, dateString)) {
    issues.push("That date is outside the collected teaching dates for this dataset.");
  }
  const breakPeriod = dateString ? nonTeachingForDate(meta, dateString) : null;
  if (breakPeriod) issues.push(`${breakPeriod.reason || "Non-teaching period"} — room availability is unknown.`);
  return issues;
}

export function normalizeDataset(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Dataset is not a JSON object.");
  if (!Array.isArray(raw.rooms)) throw new Error("Dataset is missing a rooms array.");
  if (!Array.isArray(raw.sections)) throw new Error("Dataset is missing a sections array.");
  if (!Array.isArray(raw.meetings)) throw new Error("Dataset is missing a meetings array.");
  if (!raw.meta || typeof raw.meta !== "object") throw new Error("Dataset is missing meta information.");

  const rooms = raw.rooms
    .map((r, i) => ({
      ...r,
      id: r.id || `${r.buildingCode || "ROOM"}-${r.number || i}`,
      name: r.name || [r.buildingCode, r.number].filter(Boolean).join(" "),
      capacity: Number.isFinite(Number(r.capacity)) ? Number(r.capacity) : null,
      hoursMap: parseHours(r.hours),
    }))
    .filter((r) => r.id);

  const seenSections = new Set();
  const sections = raw.sections.filter((s) => {
    if (!s || !s.id || seenSections.has(s.id)) return false;
    seenSections.add(s.id);
    return true;
  });

  const sectionIds = new Set(sections.map((s) => s.id));
  const meetings = raw.meetings
    .filter((m) => m && m.sectionId && sectionIds.has(m.sectionId))
    .map((m, i) => ({
      ...m,
      id: m.id || `meeting-${i}`,
      startMin: hmToMinutes(m.start),
      endMin: hmToMinutes(m.end),
      dayIndexes: (m.days || [])
        .map((d) => (typeof d === "number" ? d : DAY_TO_INDEX[d]))
        .filter((d) => Number.isInteger(d)),
    }))
    .filter((m) => m.startMin != null && m.endMin != null && m.endMin > m.startMin && m.dayIndexes.length);

  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const sectionById = new Map(sections.map((s) => [s.id, s]));
  const meetingsByRoom = new Map();
  for (const m of meetings) {
    if (!m.roomId || !roomById.has(m.roomId)) continue;
    if (!meetingsByRoom.has(m.roomId)) meetingsByRoom.set(m.roomId, []);
    meetingsByRoom.get(m.roomId).push(m);
  }

  return {
    meta: raw.meta,
    rooms,
    sections,
    meetings,
    roomById,
    sectionById,
    meetingsByRoom,
    importedAt: new Date().toISOString(),
  };
}

export function eventsForRoomOnDate(dataset, roomId, dateString) {
  const day = weekdayForDate(dateString);
  if (day == null) return [];
  return (dataset.meetingsByRoom.get(roomId) || [])
    .filter((m) => m.dayIndexes.includes(day) && isDateInRange(dateString, m.startDate, m.endDate))
    .map((m) => {
      const section = dataset.sectionById.get(m.sectionId);
      return {
        id: m.id,
        start: m.startMin,
        end: m.endMin,
        kind: m.kind || section?.activity || "Class",
        section,
        roomId,
      };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

export function mergeEvents(events) {
  const merged = [];
  for (const ev of events) {
    const last = merged[merged.length - 1];
    if (last && ev.start <= last.end) {
      last.end = Math.max(last.end, ev.end);
      last.items.push(ev);
    } else {
      merged.push({ start: ev.start, end: ev.end, items: [ev] });
    }
  }
  return merged;
}

export function getRoomHours(room, dateString) {
  const day = weekdayForDate(dateString);
  if (day == null) return null;
  return room.hoursMap?.get(day) || null;
}

export function freeIntervalsForRoom(dataset, room, dateString) {
  const hours = getRoomHours(room, dateString);
  if (!hours) return { hours: null, events: [], blocks: [] };
  const events = eventsForRoomOnDate(dataset, room.id, dateString);
  const blocks = [];
  let cursor = hours.open;
  for (const ev of mergeEvents(events)) {
    if (ev.end <= hours.open || ev.start >= hours.close) continue;
    const start = Math.max(ev.start, hours.open);
    const end = Math.min(ev.end, hours.close);
    if (start > cursor) blocks.push({ start: cursor, end: start, events: [] });
    cursor = Math.max(cursor, end);
  }
  if (cursor < hours.close) blocks.push({ start: cursor, end: hours.close, events: [] });
  return { hours, events, blocks };
}

export function formatTerm(termKey, meta) {
  return meta?.terms?.find((t) => t.key === termKey)?.label || termKey || "—";
}

export function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
