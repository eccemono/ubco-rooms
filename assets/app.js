import {
  formatTerm,
  prettyDate,
  minutesToLabel,
  normalizeDataset,
  termForDate,
  weekdayName,
} from "./data.js";
import {
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

  fillSelect($("#term"), termOptions, { placeholder: "Auto from date" });
  fillSelect($("#building"), buildings, { placeholder: "Any building" });
  fillSelect($("#course-term"), termOptions, { placeholder: "All terms" });

  const date = defaultDate(meta);
  if (!$("#date").value || !termForDate(meta, $("#date").value)) $("#date").value = date;
  if (!$("#tt-date").value || !termForDate(meta, $("#tt-date").value)) $("#tt-date").value = date;

  const roomOptions = [...rooms]
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
  const people = Math.max(1, Number($("#people").value) || 1);
  const building = $("#building").value;
  const termKey = $("#term").value;
  const allowMoves = $("#allow-moves").checked;

  const result = searchAvailability(state.dataset, {
    date,
    start,
    end,
    people,
    building,
    termKey,
    allowMoves,
  });
  state.lastSearch = result;
  renderSearchResult(result);
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

  if (total) {
    setStatus(
      status,
      `<strong>${plural(total, "room")}</strong> with no scheduled class for ${escapeHtml(title)} (${requested}). ` +
        `Showing best matches first.`
    );
  } else {
    setStatus(
      status,
      `<strong>No single room</strong> covers the full window for ${escapeHtml(title)}.` +
        (result.combos.length ? " These two-room options still work if you are willing to move." : "")
    );
  }

  const cards = [];
  result.exact.forEach((item, index) => {
    cards.push(renderRoomCard(item, index === 0));
  });
  result.combos.forEach((combo, index) => {
    cards.push(renderComboCard(combo, index));
  });

  if (!cards.length) {
    results.innerHTML = `<div class="empty"><strong>Nothing in the captured data.</strong>Try a shorter window, a different building, or check whether this dataset covers the date.</div>`;
    return;
  }

  results.innerHTML = cards.join("");

  $$("[data-room-jump]", results).forEach((btn) => {
    btn.addEventListener("click", () => {
      $("#tt-date").value = result.date;
      $("#tt-room").value = btn.dataset.roomJump;
      $("#tt-results").dataset.rendered = "";
      switchTab("timetable");
    });
  });
}

function renderRoomCard(item, best) {
  const { room, block, startMin, endMin, slackBefore, slackAfter, nextEvent, capacity } = item;
  const tags = [];
  if (best) tags.push(`<span class="tag">Best fit</span>`);
  if (capacity.unknown) tags.push(`<span class="tag tag-warn">Capacity unknown</span>`);
  if (item.sameBuilding) tags.push(`<span class="tag tag-neutral">Preferred building</span>`);

  const notes = [
    `Free ${minutesToLabel(block.start)}–${minutesToLabel(block.end)}`,
    slackBefore >= 5 ? `${formatDuration(slackBefore)} free before` : "Starts right at this window",
    nextEvent ? `Next class ${minutesToLabel(nextEvent.start)}` : "No later class listed today",
  ];

  return `
    <article class="result-card${best ? " best" : ""}">
      <div>
        <div class="result-top">
          <span class="room-name">${escapeHtml(room.name)}</span>
          ${tags.join("")}
        </div>
        <div class="result-meta">
          ${escapeHtml(room.buildingName)}${room.capacity ? ` · ${room.capacity} seats` : ""}${room.layout ? ` · ${escapeHtml(room.layout)}` : ""}
        </div>
        <div class="result-window">Free for your ${formatDuration(endMin - startMin)} · ${minutesToLabel(startMin)}–${minutesToLabel(endMin)}</div>
      </div>
      <div class="result-actions">
        <button class="btn btn-ghost btn-small" type="button" data-room-jump="${escapeHtml(room.id)}">Day view</button>
      </div>
      <div class="result-notes">
        ${notes.map((n) => `<span>${escapeHtml(n)}</span>`).join("")}
        ${room.features?.length ? `<span>${room.features.slice(0, 3).map(escapeHtml).join(" · ")}</span>` : ""}
      </div>
    </article>`;
}

function renderComboCard(combo, index) {
  const { first, second, transfer } = { ...combo, transfer: 10 };
  return `
    <article class="result-card combo">
      <div>
        <div class="result-top">
          <span class="room-name">Two-room option</span>
          <span class="tag tag-warn">${index === 0 ? "Best combination" : "Room change"}</span>
        </div>
        <div class="result-meta">
          ${escapeHtml(first.room.buildingName)} → ${escapeHtml(second.room.buildingName)}${combo.sameBuilding ? " · same building" : ""}
        </div>
        <div class="result-window">Covers ${minutesToLabel(combo.startMin)}–${minutesToLabel(combo.endMin)} with one move</div>
      </div>
      <div class="result-actions"></div>
      <div class="combo-steps">
        <div class="combo-step">
          <span class="n">1</span>
          <div><div class="times">${minutesToLabel(first.start)}–${minutesToLabel(first.end)}</div>
             <div class="where">${escapeHtml(first.room.name)} · ${escapeHtml(first.room.buildingName)}</div></div>
          <span class="tag tag-neutral">${formatDuration(first.end - first.start)}</span>
        </div>
        <div class="combo-step">
          <span class="n">→</span>
          <div><div class="times">${minutesToLabel(first.end)}–${minutesToLabel(second.start)}</div>
             <div class="where">Walk / reset · ${transfer} min allowed</div></div>
          <span class="tag tag-warn">transfer</span>
        </div>
        <div class="combo-step">
          <span class="n">2</span>
          <div><div class="times">${minutesToLabel(second.start)}–${minutesToLabel(second.end)}</div>
             <div class="where">${escapeHtml(second.room.name)} · ${escapeHtml(second.room.buildingName)}</div></div>
          <span class="tag tag-neutral">${formatDuration(second.end - second.start)}</span>
        </div>
      </div>
    </article>`;
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
        <td class="room-cell${r.roomText === "Not listed" ? " muted-cell" : ""}">${escapeHtml(r.roomText)}</td>
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

  const warnings = [...(meta.warnings || [])];
  if (meta.demo) {
    warnings.unshift("This build uses a generated demo fixture, not a real Workday collection.");
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

  $$("[data-duration]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const minutes = Number(chip.dataset.duration);
      const start = $("#start").value || "13:00";
      const [h, m] = start.split(":").map(Number);
      const total = Math.min(h * 60 + m + minutes, 23 * 60 + 59);
      $("#end").value = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    });
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
