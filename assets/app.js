import {
  formatTerm,
  prettyDate,
  minutesToLabel,
  normalizeDataset,
  nonTeachingForDate,
  termForDate,
  weekdayForDate,
  weekdayName,
} from "./data.js?v=20261117";
import {
  NEVER_SHOW_BUILDINGS,
  buildCourseRows,
  datasetStats,
  dayAvailability,
  roomDayView,
  searchAvailability,
} from "./engine.js?v=20261117";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  dataset: null,
  courseRows: [],
  tab: "search",
  lastSearch: null,
  visibleExact: 8,
  showCombos: false,
  showPartial: false,
  otherTimes: [],
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

function isTeachingDay(dateString) {
  const day = weekdayForDate(dateString);
  if (day == null || day === 0 || day === 6) return false;
  if (!termForDate(state.dataset.meta, dateString)) return false;
  if (nonTeachingForDate(state.dataset.meta, dateString)) return false;
  return true;
}

function adjacentTeachingDay(dateString, direction) {
  if (!dateString) return null;
  const d = new Date(`${dateString}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  for (let i = 0; i < 400; i += 1) {
    d.setUTCDate(d.getUTCDate() + direction);
    const iso = d.toISOString().slice(0, 10);
    if (isTeachingDay(iso)) return iso;
  }
  return null;
}

function slotTone(count) {
  return count > 0 ? "free" : "";
}

function renderDayGlance() {
  const strip = $("#day-strip");
  const axis = $("#day-axis");
  const title = $("#day-title");
  const note = $("#day-note");
  const date = $("#date").value;
  if (!strip || !date) return;

  const result = dayAvailability(state.dataset, {
    date,
    buildings: selectedBuildings(),
    allowLabs: $("#allow-labs")?.checked || false,
  });

  title.textContent = prettyDate(date, { withYear: false });
  const prev = adjacentTeachingDay(date, -1);
  const next = adjacentTeachingDay(date, 1);
  $("#prev-day").disabled = !prev;
  $("#next-day").disabled = !next;

  if (result.issues?.length) {
    note.textContent = result.issues[0];
    strip.innerHTML = `<div class="day-empty">${escapeHtml(result.issues[0])}</div>`;
    axis.innerHTML = "";
    return;
  }

  const term = termForDate(state.dataset.meta, date);
  note.textContent = `${term ? formatTerm(term.key, state.dataset.meta).replace("2026-27 ", "") + " · " : ""}Teaching day`;
  const parseInput = (value) => {
    const [h, m] = (value || "0:0").split(":").map(Number);
    return h * 60 + (m || 0);
  };
  const selStart = parseInput($("#start").value);
  const selEnd = parseInput($("#end").value);
  const slots = result.slots;
  const selectionLabel = $("#day-selection");

  strip.innerHTML = slots
    .map((slot, index) => {
      const titleText =
        slot.count > 0
          ? `${slot.count} rooms free ${minutesToLabel(slot.start)}–${minutesToLabel(slot.end)}`
          : `No standard room free ${minutesToLabel(slot.start)}–${minutesToLabel(slot.end)}`;
      const selected = slot.start < selEnd && slot.end > selStart;
      return `<button type="button" class="day-slot ${slotTone(slot.count)}${selected ? " selected" : ""}" data-index="${index}" title="${escapeHtml(titleText)}" aria-label="${escapeHtml(titleText)}"></button>`;
    })
    .join("") + '<div class="day-range" hidden><span class="day-cap start"></span><span class="day-cap end"></span></div>';

  const rangeEl = strip.querySelector(".day-range");
  const positionRange = (lo, hi) => {
    if (!rangeEl) return;
    rangeEl.hidden = false;
    rangeEl.style.left = `${(lo / slots.length) * 100}%`;
    rangeEl.style.width = `${((hi - lo + 1) / slots.length) * 100}%`;
  };

  const setPreview = (a, b) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    strip.querySelectorAll(".day-slot").forEach((button, index) => {
      button.classList.toggle("selected", index >= lo && index <= hi);
    });
    positionRange(lo, hi);
    selectionLabel.textContent = `${minutesToLabel(slots[lo].start)}–${minutesToLabel(slots[hi].end)} selected`;
  };

  const indexAt = (clientX) => {
    const rect = strip.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(0.9999, (clientX - rect.left) / rect.width));
    return Math.floor(ratio * slots.length);
  };

  let dragging = false;
  let anchor = 0;
  let current = 0;

  strip.onpointerdown = (event) => {
    const button = event.target.closest(".day-slot");
    if (!button) return;
    event.preventDefault();
    dragging = true;
    anchor = Number(button.dataset.index);
    current = anchor;
    strip.setPointerCapture?.(event.pointerId);
    setPreview(anchor, current);
  };

  strip.onpointermove = (event) => {
    if (!dragging) return;
    current = indexAt(event.clientX);
    setPreview(anchor, current);
  };

  const finishDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    current = indexAt(event.clientX);
    const lo = Math.min(anchor, current);
    const hi = Math.max(anchor, current);
    setPreview(lo, hi);
    $("#start").value = `${String(Math.floor(slots[lo].start / 60)).padStart(2, "0")}:${String(slots[lo].start % 60).padStart(2, "0")}`;
    $("#end").value = `${String(Math.floor(slots[hi].end / 60)).padStart(2, "0")}:${String(slots[hi].end % 60).padStart(2, "0")}`;
    searchFromForm();
  };
  strip.onpointerup = finishDrag;
  strip.onpointercancel = () => { dragging = false; };

  strip.querySelectorAll(".day-slot").forEach((button) => {
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      const index = Number(button.dataset.index);
      setPreview(index, index);
      $("#start").value = `${String(Math.floor(slots[index].start / 60)).padStart(2, "0")}:${String(slots[index].start % 60).padStart(2, "0")}`;
      $("#end").value = `${String(Math.floor(slots[index].end / 60)).padStart(2, "0")}:${String(slots[index].end % 60).padStart(2, "0")}`;
      searchFromForm();
    });
  });

  if (selectionLabel) {
    const lo = slots.findIndex((slot) => slot.start <= selStart && slot.end > selStart);
    const hi = slots.findIndex((slot) => slot.start < selEnd && slot.end >= selEnd);
    if (lo >= 0 && hi >= 0) {
      positionRange(lo, hi);
      selectionLabel.textContent = `${minutesToLabel(slots[lo].start)}–${minutesToLabel(slots[hi].end)} selected`;
    } else {
      selectionLabel.textContent = "";
    }
  }

  const ticks = [420, 600, 780, 960, 1140, 1320];
  axis.innerHTML = ticks
    .map((t) => {
      const left = ((t - 420) / (1320 - 420)) * 100;
      return `<span style="left:${left}%">${minutesToLabel(t)}</span>`;
    })
    .join("");
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

function renderBuildingOptions() {
  const codes = [...new Set(state.dataset.rooms.map((r) => r.buildingCode))]
    .filter((code) => code && !NEVER_SHOW_BUILDINGS.has(code))
    .sort();
  const existing = new Set($$("#building-options input:checked").map((el) => el.value));
  const initial = !$("#building-options").children.length;
  $("#building-options").innerHTML = codes
    .map((code) => {
      const name = state.dataset.rooms.find((r) => r.buildingCode === code)?.buildingName || code;
      const checked = initial || existing.has(code);
      return `<label class="building-check" title="${escapeHtml(name)}"><input type="checkbox" value="${escapeHtml(code)}"${checked ? " checked" : ""}>${escapeHtml(code)}</label>`;
    })
    .join("");
}

function selectedBuildings() {
  return $$("#building-options input:checked").map((el) => el.value);
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

  renderBuildingOptions();
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
  const buildings = selectedBuildings();
  const allowLabs = $("#allow-labs")?.checked || false;

  const result = searchAvailability(state.dataset, {
    date,
    start,
    end,
    buildings,
    allowLabs,
  });
  state.lastSearch = result;
  state.visibleExact = 8;
  state.showCombos = false;
  state.showPartial = false;
  state.otherTimes = otherTimeOptions(result);
  renderSearchResult(result);
  renderDayGlance();
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
      const code = ev.section ? `${ev.section.subject}${ev.section.courseNumber}` : "Class";
      const label =
        width >= 4.5
          ? `<span class="bar-busy-label">${width >= 10 ? "Occupied" : "Occ"}<span class="bar-busy-code">(${escapeHtml(code)})</span></span>`
          : "";
      return `<span class="bar-busy" style="left:${left}%;width:${width}%">${label}</span>`;
    })
    .join("");

  const freeLabel =
    freeWidth >= 14
      ? `<span class="bar-free-label" style="left:${freeLeft}%;width:${freeWidth}%">free</span>`
      : "";

  const gridCount = Math.max(1, Math.round((viewEnd - viewStart) / 15));
  return `
    <div class="availability-bar">
      <span class="bar-grid" style="background-size:${100 / gridCount}% 100%"></span>
      <span class="bar-free" style="left:${freeLeft}%;width:${freeWidth}%"></span>
      ${eventHtml}
      <span class="bar-selected" style="left:${selLeft}%;width:${selWidth}%"></span>
      ${freeLabel}
    </div>`;
}

function renderAxis(viewStart, viewEnd, block, events, startMin, endMin) {
  const span = viewEnd - viewStart;
  const points = new Map();
  const add = (time, role, priority) => {
    if (time < viewStart || time > viewEnd) return;
    if (!points.has(time)) points.set(time, { time, roles: new Set(), priority });
    const entry = points.get(time);
    entry.roles.add(role);
    entry.priority = Math.min(entry.priority, priority);
  };
  add(viewStart, "timeline starts", 4);
  add(viewEnd, "timeline ends", 4);
  add(startMin, "selected start", 0);
  add(endMin, "selected end", 0);
  if (block) {
    add(block.start, "free starts", 1);
    add(block.end, "free ends", 1);
  }
  for (const event of events || []) {
    add(event.start, "class starts", 2);
    add(event.end, "class ends", 2);
  }

  const ordered = [...points.values()].sort((a, b) => a.time - b.time);
  const lanes = [[], []];
  const labels = ordered
    .map((point) => {
      const left = ((point.time - viewStart) / span) * 100;
      let lane = lanes.findIndex((positions) => positions.every((p) => Math.abs(p - left) > 5.2));
      if (lane === -1) lane = left < 50 ? 0 : 1;
      lanes[lane].push(left);
      const selected = point.roles.has("selected start") || point.roles.has("selected end");
      const title = `${minutesToLabel(point.time)} · ${[...point.roles].join(" · ")}`;
      return `<span class="axis-label${selected ? " axis-selected" : ""}" style="left:${left}%;top:${lane * 11}px" title="${escapeHtml(title)}">${minutesToLabel(point.time)}</span>`;
    })
    .join("");
  const ticks = ordered
    .map((point) => `<i class="axis-tick" style="left:${((point.time - viewStart) / span) * 100}%"></i>`)
    .join("");
  return `<div class="bar-axis">${ticks}${labels}</div>`;
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
      buildings: selectedBuildings(),
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

function renderBestRoute(result) {
  const exact = result.exact[0];
  const partial = result.partial?.[0];
  const combo = result.combos?.[0];
  if (!exact && !partial && !combo) return "";

  let type = "room";
  let best = exact;
  if (!best) {
    const partialScore = partial ? partial.usableMinutes : -1;
    const comboStudy = combo
      ? combo.first.end - combo.first.start + (combo.second.end - combo.second.start) - combo.gap * 0.5
      : -1;
    if (partial && partialScore >= comboStudy) {
      type = "partial";
      best = partial;
    } else {
      type = "combo";
      best = combo;
    }
  }

  if (type === "combo") {
    const gap = best.gap || best.transfer || 5;
    const hasGap = gap > (best.transfer || 5);
    return `
      <section class="best-route card">
        <div class="best-route-kicker">Best route${hasGap ? " · gap" : " · one move"}</div>
        <div class="best-route-main">
          ${roomButton(best.first.room, best.date)}
          <span class="best-route-time">${minutesToLabel(best.first.start)}–${minutesToLabel(best.first.end)}</span>
          <span class="best-route-arrow">→</span>
          ${roomButton(best.second.room, best.date)}
          <span class="best-route-time">${minutesToLabel(best.second.start)}–${minutesToLabel(best.second.end)}</span>
        </div>
        <div class="best-route-note">${hasGap ? `⚠ ${formatDuration(gap)} gap · ${best.transfer || 5} min walk included` : `${best.transfer || 5} min walk`}</div>
      </section>`;
  }

  const isPartial = type === "partial";
  return `
    <section class="best-route card">
      <div class="best-route-kicker">Best route${isPartial ? " · partial window" : ""}</div>
      <div class="best-route-main">
        ${roomButton(best.room, best.date)}
        <span class="best-route-time">${minutesToLabel(best.startMin)}–${minutesToLabel(best.endMin)}</span>
      </div>
      <div class="best-route-note">${isPartial ? `${formatDuration(best.usableMinutes)} usable of ${formatDuration(best.requestedMinutes)}` : "Covers the full requested window"}</div>
    </section>`;
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
  const title = `${prettyDate(result.date)} from ${minutesToLabel(result.startMin)}–${minutesToLabel(result.endMin)}`;
  const total = result.exact.length;
  const partial = result.partial || [];
  const visible = Math.min(state.visibleExact, total);
  const showPartial = state.showPartial || (total === 0 && partial.length > 0);
  const showCombos = state.showCombos || (total === 0 && partial.length === 0);

  let statusBits;
  if (total) {
    statusBits = [
      `<strong>${plural(total, "room")}</strong> with no scheduled class ${escapeHtml(title)} (${requested}).`,
    ];
    if (visible < total) statusBits.push(`Showing ${visible} of ${total}; more are below.`);
  } else {
    statusBits = [`<strong>No single room</strong> covers the full window ${escapeHtml(title)}.`];
    if (partial.length) statusBits.push("The best partial blocks are below.");
    else if (result.combos.length) statusBits.push("Room-change options are below.");
    else statusBits.push("Try one of the other times below or the Advanced option.");
  }
  setStatus(status, statusBits.join(" "));

  const { viewStart, viewEnd } = viewWindow(result);
  const cards = [];
  result.exact.slice(0, state.visibleExact).forEach((item, index) => {
    cards.push(renderRoomCard(item, index === 0, viewStart, viewEnd));
  });
  if (showPartial) {
    partial.slice(0, 6).forEach((item) => {
      cards.push(renderRoomCard(item, false, viewStart, viewEnd));
    });
  }
  if (showCombos) {
    result.combos.forEach((combo, index) => {
      cards.push(renderComboCard(combo, index, viewStart, viewEnd));
    });
  }

  const foot = [];
  if (visible < total) {
    foot.push(`<button class="btn btn-ghost" type="button" id="show-more-rooms">Show ${Math.min(8, total - visible)} more rooms</button>`);
  }
  if (partial.length && !showPartial) {
    foot.push(`<button class="btn btn-ghost" type="button" id="show-partial-rooms">Show ${Math.min(6, partial.length)} partial rooms</button>`);
  }
  if (result.combos.length && !showCombos) {
    foot.push(`<button class="btn btn-ghost" type="button" id="show-room-changes">Show room changes</button>`);
  }
  const alternatives = state.otherTimes;
  if (alternatives.length) {
    foot.push(`<div class="other-times"><span class="other-times-label">Other times</span>${alternatives
      .map((alt) => `<button type="button" class="chip" data-other-start="${alt.start}" data-other-end="${alt.end}">${minutesToLabel(alt.startMin)}–${minutesToLabel(alt.endMin)} · ${plural(alt.count, "room")}</button>`)
      .join("")}</div>`);
  }

  const main = cards.length
    ? cards.join("")
    : `<div class="empty"><strong>Nothing in the captured data.</strong>Try a different building, a shorter window, or one of the times below.</div>`;
  const bestRoute = renderBestRoute(result);
  results.innerHTML = (bestRoute ? `<div class="best-route-wrap">${bestRoute}</div>` : "") + main + (foot.length ? `<div class="results-foot">${foot.join("")}</div>` : "");

  $$("[data-room-jump]", results).forEach((btn) => {
    btn.addEventListener("click", () => jumpToRoom(btn.dataset.roomJump, btn.dataset.roomDate || result.date));
  });
  $("#show-more-rooms")?.addEventListener("click", () => {
    state.visibleExact += 8;
    renderSearchResult(result);
  });
  $("#show-partial-rooms")?.addEventListener("click", () => {
    state.showPartial = true;
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
        ${item.partial ? `<span class="tag tag-warn room-best">Partial · ${formatDuration(item.usableMinutes)}</span>` : best ? '<span class="tag room-best">Best</span>' : ""}
        ${state.dataset.labRoomIds.has(room.id) ? '<span class="tag tag-warn room-best">Lab room</span>' : ""}
      </div>
      <div class="plot">
        ${renderBar({ block, events, startMin, endMin, viewStart, viewEnd })}
        ${renderAxis(viewStart, viewEnd, block, events, startMin, endMin)}
      </div>
    </article>`;
}

function renderComboCard(combo, index, viewStart, viewEnd) {
  const firstView = roomDayView(state.dataset, combo.first.room.id, combo.date);
  const secondView = roomDayView(state.dataset, combo.second.room.id, combo.date);
  const transfer = combo.transfer || 5;
  const gap = combo.gap || transfer;
  const hasGap = gap > transfer;
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
        ${renderAxis(viewStart, viewEnd, part.block, view?.events || [], part.start, part.end)}
      </div>
    </div>`;

  return `
    <article class="result-card combo">
      <div class="combo-head">
        <span class="combo-title">Room change${index === 0 ? " · best" : ""}</span>
        <span class="plot-cushion ${hasGap ? "cushion-tight" : "cushion-ok"}">${hasGap ? `⚠ ${formatDuration(gap)} gap` : `${transfer} min to move`}</span>
      </div>
      ${row(combo.first, firstView, "Start here")}
      <div class="combo-move">${hasGap ? `⚠ ${formatDuration(gap)} without a room · includes ${transfer} min walk` : `↓ ${transfer} min walk / reset`}</div>
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

  $("#buildings-all").addEventListener("click", () => {
    $$("#building-options input").forEach((el) => { el.checked = true; });
    searchFromForm();
  });
  $("#buildings-none").addEventListener("click", () => {
    $$("#building-options input").forEach((el) => { el.checked = false; });
    searchFromForm();
  });
  $("#building-options").addEventListener("change", () => searchFromForm());
  $("#date").addEventListener("change", () => searchFromForm());

  $("#prev-day").addEventListener("click", () => {
    const next = adjacentTeachingDay($("#date").value, -1);
    if (!next) return;
    $("#date").value = next;
    $("#tt-date").value = next;
    searchFromForm();
  });
  $("#next-day").addEventListener("click", () => {
    const next = adjacentTeachingDay($("#date").value, 1);
    if (!next) return;
    $("#date").value = next;
    $("#tt-date").value = next;
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
