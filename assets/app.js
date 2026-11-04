import {
  formatTerm,
  prettyDate,
  minutesToLabel,
  normalizeDataset,
  termForDate,
  weekdayName,
} from "./data.js";
import {
  NEVER_SHOW_BUILDINGS,
  buildCourseRows,
  datasetStats,
  roomDayView,
  searchAvailability,
} from "./engine.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  dataset: null,
  courseRows: [],
  tab: "search",
  lastSearch: null,
  visibleExact: 8,
  showCombos: false,
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function todayIso() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function defaultDate(meta) {
  const today = todayIso();
  const inTerm = (meta.terms || []).find((t) => today >= t.start && today <= t.end);
  if (inTerm) return today;
  const upcoming = (meta.terms || []).find((t) => t.start > today);
  return upcoming?.start || (meta.terms || [])[0]?.start || today;
}

function formatDuration(minutes) {
  if (minutes == null) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function setStatus(el, html) {
  el.innerHTML = html;
}

function dataBadge(meta) {
  if (meta.demo) return { text: "Demo data", cls: "badge-demo" };
  if (!meta.generatedAt) return { text: "Dataset loaded", cls: "badge-muted" };
  const date = new Date(meta.generatedAt);
  if (Number.isNaN(date.getTime())) return { text: "Dataset loaded", cls: "badge-muted" };
  return {
    text: `Updated ${date.toLocaleDateString("en-CA", { month: "short", day: "numeric" })}`,
    cls: "badge-live",
  };
}

function renderHeader() {
  const { meta } = state.dataset;
  const badge = dataBadge(meta);
  const el = $("#data-badge");
  el.textContent = badge.text;
  el.className = `badge ${badge.cls}`;

  $("#demo-banner").hidden = !meta.demo;

  const generated = meta.generatedAt
    ? new Date(meta.generatedAt).toLocaleString("en-CA", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "unknown";
  $("#footer-meta").textContent = `${meta.source || "Unknown source"} · generated ${generated} · ${meta.campus || "UBC Okanagan"}`;
}

function fillSelect(select, items, { placeholder, valueKey = "value", labelKey = "label" } = {}) {
  const current = select.value;
  select.innerHTML = "";
  if (placeholder != null) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = placeholder;
    select.append(opt);
  }
  for (const item of items) {
    const opt = document.createElement("option");
    opt.value = item[valueKey];
    opt.textContent = item[labelKey];
    select.append(opt);
  }
  if ([...select.options].some((o) => o.value === current)) select.value = current;
}

function populateControls() {
  const { meta, rooms } = state.dataset;
  const termOptions = (meta.terms || []).map((t) => ({ value: t.key, label: t.label }));
  const buildings = [...new Set(rooms.map((r) => r.buildingCode))]
    .filter(Boolean)
    .sort()
    .map((code) => ({
      value: code,
      label: `${code} · ${rooms.find((r) => r.buildingCode === code)?.buildingName || code}`,
    }));

  fillSelect($("#building"), buildings, { placeholder: "Any building" });
  fillSelect($("#course-term"), termOptions, { placeholder: "All terms" });

  const date = defaultDate(meta);
  if (!$("#date").value || !termForDate(meta, $("#date").value)) $("#date").value = date;
  if (!$("#tt-date").value || !termForDate(meta, $("#tt-date").value)) $("#tt-date").value = date;

  const roomOptions = [...rooms]
    .filter((r) => !NEVER_SHOW_BUILDINGS.has(r.buildingCode) && !state.dataset.specializedRoomIds.has(r.id))
    .sort((a, b) => a.buildingCode.localeCompare(b.buildingCode) || a.number.localeCompare(b.number, undefined, { numeric: true }))
    .map((r) => ({ value: r.id, label: `${r.name} — ${r.buildingName}` }));
  fillSelect($("#tt-room"), roomOptions);
}

function switchTab(tab) {
  state.tab = tab;
  $$(".tab").forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
  });
  $$(".panel").forEach((panel) => {
    const active = panel.id === `panel-${tab}`;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  });
  if (tab === "timetable" && !$("#tt-results").dataset.rendered) renderTimetable();
  if (tab === "courses") renderCourses();
  if (tab === "data") renderDataPanel();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function searchFromForm() {
  const date = $("#date").value;
  const start = $("#start").value;
  const end = $("#end").value;
  const building = $("#building").value;
  const allowLabs = $("#allow-labs")?.checked || false;

  const result = searchAvailability(state.dataset, {
    date,
    start,
    end,
    building,
    allowLabs,
  });
  state.lastSearch = result;
  state.visibleExact = 8;
  state.showCombos = false;
  renderSearchResult(result);
}

function viewWindow(result) {
  const pad = 120;
  const viewStart = Math.max(6 * 60, Math.floor((result.startMin - pad) / 30) * 30);
  const viewEnd = Math.min(23 * 60, Math.ceil((result.endMin + pad) / 30) * 30);
  return { viewStart, viewEnd, span: Math.max(60, viewEnd - viewStart) };
}

function pct(minutes, viewStart, span) {
  return Math.max(0, Math.min(100, ((minutes - viewStart) / span) * 100));
}

function renderBar({ block, events = [], startMin, endMin, viewStart, viewEnd }) {
  const span = viewEnd - viewStart;
  const clip = (a, b) => ({ start: Math.max(a, viewStart), end: Math.min(b, viewEnd) });
  const free = clip(block.start, block.end);
  const selected = clip(startMin, endMin);
  const visibleEvents = events
    .map((ev) => ({ ...ev, ...clip(ev.start, ev.end) }))
    .filter((ev) => ev.end > ev.start);

  const freeLeft = pct(free.start, viewStart, span);
  const freeWidth = pct(free.end, viewStart, span) - freeLeft;
  const selLeft = pct(selected.start, viewStart, span);
  const selWidth = pct(selected.end, viewStart, span) - selLeft;

  const eventHtml = visibleEvents
    .map((ev) => {
      const left = pct(ev.start, viewStart, span);
      const width = pct(ev.end, viewStart, span) - left;
      const code = ev.section ? `${ev.section.subject} ${ev.section.courseNumber} ${ev.section.section || ""}`.trim() : "Class";
      const activity = ev.section?.activity || ev.kind || "Class";
      const title = ev.section?.title ? ` · ${ev.section.title}` : "";
      const tooltip = `${code} · ${activity} · ${minutesToLabel(ev.start)}–${minutesToLabel(ev.end)}${title}`;
      const label =
        width >= 10
          ? `<span class="bar-busy-label">Occupied</span>`
          : width >= 4.5
            ? `<span class="bar-busy-label">Occ</span>`
            : "";
      return `<span class="bar-busy" style="left:${left}%;width:${width}%" title="${escapeHtml(tooltip)}">${label}</span>`;
    })
    .join("");

  const freeLabel =
    freeWidth >= 14
      ? `<span class="bar-free-label" style="left:${freeLeft}%;width:${freeWidth}%">free</span>`
      : "";

  return `
    <div class="availability-bar">
      <span class="bar-free" style="left:${freeLeft}%;width:${freeWidth}%"></span>
      ${eventHtml}
      <span class="bar-selected" style="left:${selLeft}%;width:${selWidth}%"></span>
      ${freeLabel}
    </div>`;
}

function renderAxis(viewStart, viewEnd) {
  const span = viewEnd - viewStart;
  const step = span <= 180 ? 60 : span <= 480 ? 120 : 180;
  const ticks = new Set([viewStart, viewEnd]);
  for (let t = Math.ceil(viewStart / step) * step; t < viewEnd; t += step) ticks.add(t);
  return `<div class="bar-axis">${[...ticks]
    .sort((a, b) => a - b)
    .map((t) => `<span style="left:${pct(t, viewStart, span)}%">${minutesToLabel(t)}</span>`)
    .join("")}</div>`;
}

function roomButton(room, date) {
  return `<button class="room-link" type="button" data-room-jump="${escapeHtml(room.id)}" data-room-date="${escapeHtml(date)}">${escapeHtml(room.name)}</button>`;
}

function otherTimeOptions(result) {
  const options = [];
  const deltas = [-30, 30, -60, 60, -90, 90];
  for (const delta of deltas) {
    const startMin = result.startMin + delta;
    const endMin = result.endMin + delta;
    if (startMin < 6 * 60 || endMin > 23 * 60 || endMin <= startMin) continue;
    const start = `${String(Math.floor(startMin / 60)).padStart(2, "0")}:${String(startMin % 60).padStart(2, "0")}`;
    const end = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
    const probe = searchAvailability(state.dataset, {
      date: result.date,
      start,
      end,
      building: $("#building").value,
      allowLabs: result.allowLabs,
      includeCombos: false,
    });
    if (!probe.issues.length && probe.exact.length > 0) {
      options.push({ start, end, startMin, endMin, count: probe.exact.length });
    }
    if (options.length >= 4) break;
  }
  return options;
}

function renderSearchResult(result) {
  const status = $("#search-status");
  const results = $("#results");

  if (result.issues?.length) {
    setStatus(status, `<div class="notice notice-danger">${result.issues.map(escapeHtml).join("<br>")}</div>`);
    results.innerHTML = `<div class="empty"><strong>No estimate for that date.</strong>Pick a date inside the collected teaching period.</div>`;
    return;
  }

  const requested = formatDuration(result.requestedMinutes);
  const title = `${prettyDate(result.date)} · ${minutesToLabel(result.startMin)}–${minutesToLabel(result.endMin)}`;
  const total = result.exact.length;
  const visible = Math.min(state.visibleExact, total);
  const showCombos = state.showCombos || total === 0;

  let statusBits;
  if (total) {
    statusBits = [
      `<strong>${plural(total, "room")}</strong> with no scheduled class ${escapeHtml(title)} (${requested}).`,
      `Sorted by cushion, then building.`,
    ];
    if (visible < total) statusBits.push(`Showing ${visible} of ${total}; more are below.`);
  } else {
    statusBits = [`<strong>No single room</strong> covers the full window ${escapeHtml(title)}.`];
    if (result.combos.length) statusBits.push("Room-change options are below.");
    else statusBits.push("Try one of the other times below or the Advanced option.");
  }
  if (!result.allowLabs) statusBits.push("Lab rooms are hidden.");
  setStatus(status, statusBits.join(" "));

  const { viewStart, viewEnd } = viewWindow(result);
  const cards = [];
  result.exact.slice(0, state.visibleExact).forEach((item, index) => {
    cards.push(renderRoomCard(item, index === 0, viewStart, viewEnd));
  });
  if (showCombos) {
    result.combos.forEach((combo, index) => {
      cards.push(renderComboCard(combo, index, viewStart, viewEnd));
    });
  }

  const foot = [];
  if (visible < total) {
    foot.push(`<button class="btn btn-ghost" type="button" id="show-more-rooms">Show ${Math.min(8, total - visible)} more rooms</button>`);
  }
  if (result.combos.length && !showCombos) {
    foot.push(`<button class="btn btn-ghost" type="button" id="show-room-changes">Show room changes</button>`);
  }
  const alternatives = otherTimeOptions(result);
  if (alternatives.length) {
    foot.push(`<div class="other-times"><span class="other-times-label">Other times</span>${alternatives
      .map((alt) => `<button type="button" class="chip" data-other-start="${alt.start}" data-other-end="${alt.end}">${minutesToLabel(alt.startMin)}–${minutesToLabel(alt.endMin)} · ${plural(alt.count, "room")}</button>`)
      .join("")}</div>`);
  }

  const main = cards.length
    ? cards.join("")
    : `<div class="empty"><strong>Nothing in the captured data.</strong>Try a different building, a shorter window, or one of the times below.</div>`;
  results.innerHTML = main + (foot.length ? `<div class="results-foot">${foot.join("")}</div>` : "");

  $$("[data-room-jump]", results).forEach((btn) => {
    btn.addEventListener("click", () => jumpToRoom(btn.dataset.roomJump, btn.dataset.roomDate || result.date));
  });
  $("#show-more-rooms")?.addEventListener("click", () => {
    state.visibleExact += 8;
    renderSearchResult(result);
  });
  $("#show-room-changes")?.addEventListener("click", () => {
    state.showCombos = true;
    renderSearchResult(result);
  });
  $$("[data-other-start]", results).forEach((btn) => {
    btn.addEventListener("click", () => {
      $("#start").value = btn.dataset.otherStart;
      $("#end").value = btn.dataset.otherEnd;
      searchFromForm();
    });
  });
}

function renderRoomCard(item, best, viewStart, viewEnd) {
  const { room, block, startMin, endMin, events } = item;
  return `
    <article class="result-card${best ? " best" : ""}">
      <div class="room-cell">
        ${roomButton(room, item.date)}
        <span class="room-building">${escapeHtml(room.buildingName)}</span>
        ${best ? '<span class="tag room-best">Best</span>' : ""}
        ${state.dataset.labRoomIds.has(room.id) ? '<span class="tag tag-warn room-best">Lab room</span>' : ""}
      </div>
      <div class="plot">
        ${renderBar({ block, events, startMin, endMin, viewStart, viewEnd })}
        ${renderAxis(viewStart, viewEnd)}
      </div>
    </article>`;
}

function renderComboCard(combo, index, viewStart, viewEnd) {
  const firstView = roomDayView(state.dataset, combo.first.room.id, combo.date);
  const secondView = roomDayView(state.dataset, combo.second.room.id, combo.date);
  const row = (part, view, label) => `
    <div class="combo-row">
      <div class="room-cell">
        ${roomButton(part.room, combo.date)}
        <span class="room-building">${escapeHtml(part.room.buildingName)}</span>
      </div>
      <div class="plot">
        <div class="plot-head"><span class="plot-free">${label} · ${minutesToLabel(part.start)}–${minutesToLabel(part.end)}</span></div>
        ${renderBar({
          block: part.block,
          events: view?.events || [],
          startMin: part.start,
          endMin: part.end,
          viewStart,
          viewEnd,
        })}
        ${renderAxis(viewStart, viewEnd)}
      </div>
    </div>`;

  return `
    <article class="result-card combo">
      <div class="combo-head">
        <span class="combo-title">Room change${index === 0 ? " · best" : ""}</span>
        <span class="plot-cushion cushion-ok">${combo.transfer || 15} min to move</span>
      </div>
      ${row(combo.first, firstView, "Start here")}
      <div class="combo-move">↓ ${combo.transfer || 15} min walk / reset</div>
      ${row(combo.second, secondView, "Then move to")}
    </article>`;
}

function jumpToRoom(roomId, date) {
  $("#tt-date").value = date;
  $("#tt-room").value = roomId;
  $("#tt-results").dataset.rendered = "";
  switchTab("timetable");
}

function renderTimetable() {
  const date = $("#tt-date").value;
  const roomId = $("#tt-room").value;
  const summary = $("#tt-summary");
  const out = $("#tt-results");

  if (!date || !roomId) {
    summary.textContent = "Choose a date and a room.";
    out.innerHTML = "";
    return;
  }

  const view = roomDayView(state.dataset, roomId, date);
  if (!view) {
    summary.textContent = "That room is not in the dataset.";
    out.innerHTML = "";
    return;
  }

  out.dataset.rendered = "1";
  const { room, hours, events, segments } = view;
  if (!hours) {
    summary.innerHTML = `<strong>${escapeHtml(room.name)}</strong> has no listing for ${escapeHtml(prettyDate(date))}. The building may be closed or the room has no published hours.`;
    out.innerHTML = "";
    return;
  }

  summary.innerHTML =
    `<strong>${escapeHtml(room.name)}</strong> · ${escapeHtml(room.buildingName)} · ${escapeHtml(prettyDate(date))} · ` +
    `${minutesToLabel(hours.open)}–${minutesToLabel(hours.close)} · ${plural(events.length, "scheduled class", "scheduled classes")}`;

  const rows = segments.map((seg) => {
    if (seg.type === "free") {
      const dur = seg.end - seg.start;
      return `
        <div class="tl-row">
          <div class="tl-hour">${minutesToLabel(seg.start)}</div>
          <div class="tl-track"><div class="tl-free">Free · ${formatDuration(dur)} (no class listed)</div></div>
        </div>`;
    }
    const ev = seg.event;
    const section = ev.section;
    const code = section ? `${section.subject} ${section.courseNumber}` : "Class";
    const title = section?.title || "";
    const activity = section?.activity || ev.kind || "Class";
    const cls = /lab/i.test(activity) ? "lab" : /seminar|tutorial/i.test(activity) ? "other" : "";
    return `
      <div class="tl-row">
        <div class="tl-hour">${minutesToLabel(seg.start)}</div>
        <div class="tl-track">
          <div class="tl-event ${cls}">
            <strong>${escapeHtml(code)} ${escapeHtml(section?.section || "")}</strong> · ${escapeHtml(activity)}<br>
            ${escapeHtml(title)}
          </div>
        </div>
      </div>`;
  });

  out.innerHTML = `
    <div class="timeline">
      ${rows.join("") || `<div class="empty">No scheduled activity and no listed opening hours for this day.</div>`}
    </div>
    <p class="fine-print table-note">“Free” means no class appears in this dataset. Events, exams and private bookings are not included.</p>`;
}

function renderCourses() {
  const query = $("#course-search").value.trim().toLowerCase();
  const term = $("#course-term").value;
  const level = $("#course-level").value;

  const rows = state.courseRows.filter((r) => {
    if (term && r.term !== term) return false;
    if (level && r.level !== level) return false;
    if (query && !r.searchText.includes(query)) return false;
    return true;
  });

  const shown = rows.slice(0, 400);
  const tbody = $("#course-table tbody");
  tbody.innerHTML = shown
    .map(
      (r) => `
      <tr>
        <td class="course-code">${escapeHtml(r.subject)} ${escapeHtml(r.courseNumber)}</td>
        <td>${escapeHtml(r.section)}</td>
        <td>${escapeHtml(r.title)}</td>
        <td>${escapeHtml(r.activity || "—")}</td>
        <td>${escapeHtml(formatTerm(r.term, state.dataset.meta).replace("2026-27 ", ""))}</td>
        <td>${escapeHtml(r.dayText)}</td>
        <td>${escapeHtml(r.timeText)}</td>
        <td class="room-cell">${renderCourseRooms(r)}</td>
      </tr>`
    )
    .join("");

  $("#course-count").innerHTML =
    `<strong>${plural(rows.length, "section")}</strong> match` +
    (shown.length < rows.length ? ` · showing the first ${shown.length}` : "");
  $("#course-note").textContent =
    rows.length === 0
      ? "No sections match those filters."
      : `Each row is one section. Multiple meeting patterns are joined with “·”. Capacity, instructors and enrolment are in the Excel workbook when collected.`;
}

function renderCourseRooms(row) {
  if (!row.roomIds.length) {
    return `<span class="muted-cell">${escapeHtml(row.roomText)}</span>`;
  }
  const seen = new Set();
  const buttons = [];
  for (const roomId of row.roomIds) {
    if (seen.has(roomId)) continue;
    seen.add(roomId);
    const room = state.dataset.roomById.get(roomId);
    if (!room) continue;
    if (NEVER_SHOW_BUILDINGS.has(room.buildingCode)) {
      buttons.push(`<span class="muted-cell">Not student-accessible</span>`);
      continue;
    }
    if (state.dataset.specializedRoomIds.has(room.id)) {
      buttons.push(`<span class="muted-cell">Specialized room</span>`);
      continue;
    }
    const meeting = row.meetings.find((m) => m.roomId === roomId);
    const selectedDate = $("#date").value;
    const inRange =
      meeting?.startDate && meeting?.endDate && selectedDate >= meeting.startDate && selectedDate <= meeting.endDate;
    const date = inRange ? selectedDate : meeting?.startDate || row.meetings[0]?.startDate || selectedDate;
    buttons.push(`<button class="room-link" type="button" data-room-jump="${escapeHtml(room.id)}" data-room-date="${escapeHtml(date)}">${escapeHtml(room.name)}</button>`);
  }
  return buttons.join(" · ") || `<span class="muted-cell">${escapeHtml(row.roomText)}</span>`;
}

function renderDataPanel() {
  const { meta } = state.dataset;
  const stats = datasetStats(state.dataset);
  $("#data-stats").innerHTML = [
    ["Sections", stats.sections],
    ["Meeting patterns", stats.meetings],
    ["Rooms", stats.rooms],
    ["Rooms used", stats.roomsUsed],
    ["Sections without room", stats.sectionsWithoutRoom],
    ["Terms", stats.terms],
  ]
    .map(
      ([label, value]) => `
      <div class="stat"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`
    )
    .join("");

  const meetingsBySection = new Map();
  for (const m of state.dataset.meetings) {
    if (!meetingsBySection.has(m.sectionId)) meetingsBySection.set(m.sectionId, []);
    meetingsBySection.get(m.sectionId).push(m);
  }
  const byTermLevel = new Map();
  for (const section of state.dataset.sections) {
    const key = `${section.term}|${section.level || "Unknown"}`;
    if (!byTermLevel.has(key)) {
      byTermLevel.set(key, { term: section.term, level: section.level || "Unknown", sections: 0, withRoom: 0, meetings: 0 });
    }
    const row = byTermLevel.get(key);
    row.sections += 1;
    const ms = meetingsBySection.get(section.id) || [];
    row.meetings += ms.length;
    if (ms.some((m) => m.roomId)) row.withRoom += 1;
  }
  $("#coverage-table tbody").innerHTML = [...byTermLevel.values()]
    .sort((a, b) => a.term.localeCompare(b.term) || a.level.localeCompare(b.level))
    .map(
      (r) => `<tr>
        <td>${escapeHtml(formatTerm(r.term, meta).replace("2026-27 ", ""))}</td>
        <td>${escapeHtml(r.level)}</td>
        <td>${r.sections}</td>
        <td>${r.withRoom}</td>
        <td>${r.meetings}</td>
      </tr>`
    )
    .join("");
  $("#coverage-card").hidden = byTermLevel.size === 0;

  const warnings = (meta.warnings || []).filter((w) => !/demo/i.test(w));
  if (meta.demo) {
    warnings.unshift("This build uses a generated demo fixture, not a real Workday collection. Replace data/schedule.json before trusting results.");
  }
  $("#data-warnings").innerHTML = warnings
    .map((w) => `<div class="notice notice-warn">${escapeHtml(w)}</div>`)
    .join("");
}

function wireEvents() {
  $$(".tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  $("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    searchFromForm();
  });

  $("#advanced-toggle").addEventListener("click", () => {
    const panel = $("#advanced-panel");
    const open = panel.hidden;
    panel.hidden = !open;
    $("#advanced-toggle").setAttribute("aria-expanded", String(open));
  });
  $("#allow-labs").addEventListener("change", () => {
    if ($("#search-status").innerText.trim()) searchFromForm();
  });

  $("#tt-go").addEventListener("click", () => {
    $("#tt-results").dataset.rendered = "";
    renderTimetable();
  });
  $("#tt-date").addEventListener("change", () => {
    $("#tt-results").dataset.rendered = "";
    renderTimetable();
  });
  $("#tt-room").addEventListener("change", () => {
    $("#tt-results").dataset.rendered = "";
    renderTimetable();
  });

  let courseTimer = 0;
  $("#course-search").addEventListener("input", () => {
    clearTimeout(courseTimer);
    courseTimer = setTimeout(renderCourses, 120);
  });
  $("#course-term").addEventListener("change", renderCourses);
  $("#course-level").addEventListener("change", renderCourses);
  $("#course-table").addEventListener("click", (event) => {
    const button = event.target.closest("[data-room-jump]");
    if (!button) return;
    jumpToRoom(button.dataset.roomJump, button.dataset.roomDate || $("#date").value);
  });

  const drop = $("#drop-zone");
  const fileInput = $("#file-input");
  $("#choose-file").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files?.[0]) importFile(fileInput.files[0]);
  });
  ["dragenter", "dragover"].forEach((name) => {
    drop.addEventListener(name, (event) => {
      event.preventDefault();
      drop.classList.add("drag");
    });
  });
  ["dragleave", "drop"].forEach((name) => {
    drop.addEventListener(name, (event) => {
      event.preventDefault();
      drop.classList.remove("drag");
    });
  });
  drop.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) importFile(file);
  });
}

async function importFile(file) {
  const status = $("#import-status");
  try {
    const text = await file.text();
    const raw = JSON.parse(text);
    const dataset = normalizeDataset(raw);
    state.dataset = dataset;
    state.courseRows = buildCourseRows(dataset);
    populateControls();
    renderHeader();
    renderDataPanel();
    renderCourses();
    $("#tt-results").dataset.rendered = "";
    status.innerHTML = `<span class="tag">Imported</span> ${escapeHtml(file.name)} · ${plural(dataset.sections.length, "section")}, ${plural(dataset.meetings.length, "meeting pattern")}. Nothing was uploaded.`;
    switchTab("data");
  } catch (error) {
    status.innerHTML = `<div class="notice notice-danger">Could not read that file: ${escapeHtml(error.message)}</div>`;
  }
}

async function boot() {
  try {
    const response = await fetch("data/schedule.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = await response.json();
    state.dataset = normalizeDataset(raw);
    state.courseRows = buildCourseRows(state.dataset);
    populateControls();
    renderHeader();
    wireEvents();
    renderCourses();
    renderDataPanel();
    searchFromForm();
  } catch (error) {
    $("#data-badge").textContent = "Data failed to load";
    $("#data-badge").className = "badge badge-demo";
    $("#results").innerHTML = `<div class="notice notice-danger">
      <strong>Could not load data/schedule.json.</strong><br>
      ${escapeHtml(error.message)}<br>
      Run a local server from the project folder (see README) instead of opening index.html directly.
    </div>`;
    console.error(error);
  }
}

boot();
