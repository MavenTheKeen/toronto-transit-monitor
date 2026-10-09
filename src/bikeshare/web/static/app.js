"use strict";
// Plain DOM rendering. All API text goes through textContent, never innerHTML.

const REFRESH_MS = 20000;
const ROW = 44; // Must match --row in app.css.
const OVERLAP_ROWS = 0.45; // Trains closer than this on the diagram are nudged apart.
const main = document.getElementById("main");
const updated = document.getElementById("updated");
const timeFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto", hour: "numeric", minute: "2-digit",
});
const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto", weekday: "short", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit",
});
const STATUS_ICONS = {
  normal: "✓", delays: "!", modified_service: "!", reduced_service: "!",
  no_service: "✕", detected: "?", unknown: "?",
};
let lines = [];
let stationLines = new Map();
let renderSeq = 0;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "style") Object.assign(node.style, value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path) {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  if (response.status === 404) throw new Error("Not found");
  if (!response.ok) throw new Error(`The data service returned ${response.status}`);
  return response.json();
}

function badge(line, { link = true, small = false } = {}) {
  const meta = lines.find((l) => l.id === line) || {};
  const attrs = {
    class: small ? "badge mini" : "badge",
    style: { background: meta.color || "#777", color: meta.text_color || "#fff" },
    "aria-label": `Line ${line}`,
  };
  return link ? el("a", { ...attrs, href: `#/line/${line}` }, line) : el("span", attrs, line);
}

function statusPill(status, label) {
  return el(
    "span",
    { class: `pill ${status}` },
    el("span", { class: "icon", "aria-hidden": "true" }, STATUS_ICONS[status] || "?"),
    label,
  );
}

function staleNotice(freshness, what) {
  if (!freshness || !freshness.stale) return null;
  const when = freshness.as_of ? ` Last update ${timeFmt.format(new Date(freshness.as_of))}.` : "";
  return el("p", { class: "notice", role: "status" }, `${what} may be out of date.${when}`);
}

function minutesText(seconds) {
  if (seconds < 60) return "now";
  return `${Math.round(seconds / 60)} min`;
}

function periodText(periods) {
  return periods
    .map((p) => {
      const start = p.start ? dayFmt.format(new Date(p.start)) : "now";
      const end = p.end ? dayFmt.format(new Date(p.end)) : "until further notice";
      return `${start} – ${end}`;
    })
    .join("; ");
}

function alertCard(alert) {
  return el(
    "div",
    { class: "card alert" },
    el("p", { class: "alert-head" }, alert.lines.map((l) => badge(l, { small: true })), el("span", { class: "source" }, "Reported by TTC")),
    el("p", {}, alert.header),
    alert.description ? el("p", { class: "muted" }, alert.description) : null,
    alert.advance_notice
      ? el("p", { class: "muted" }, "Advance notice: dates are in the message above.")
      : alert.timing === "upcoming" && alert.periods.length
        ? el("p", { class: "muted" }, `When: ${periodText(alert.periods)}`)
        : null,
  );
}

// Reported (TTC alerts) and detected (our inference) are always labelled separately.
function statusDetails(status) {
  const detected = status.detected;
  return [
    el("p", { class: "status-line" }, statusPill(status.status, status.label), el("span", { class: "source" }, "Reported by TTC")),
    status.summary ? el("p", { class: "muted" }, status.summary) : null,
    detected
      ? el(
          "div",
          { class: "detected" },
          el("p", { class: "status-line" }, statusPill("detected", detected.label)),
          detected.incidents.map((i) =>
            el(
              "p",
              {},
              el("a", { href: `#/station/${i.station_key}` }, i.message),
              el("span", { class: "muted" }, ` · usually every ${minutesText(i.scheduled_headway_seconds)}`),
            ),
          ),
          el("p", { class: "source" }, "Detected by this site from missing train predictions"),
        )
      : null,
  ];
}

function statusRow(status) {
  return el(
    "li",
    { class: "card status-row link-card" },
    badge(status.line, { link: false }),
    el("div", {}, el("a", { class: "name", href: `#/line/${status.line}` }, status.name), statusDetails(status)),
    el("span", { class: "chevron", "aria-hidden": "true" }, "›"),
  );
}

// Match "bloor yonge" to "Bloor-Yonge" and "queens park" to "Queen's Park".
function searchKey(text) {
  return text.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function stationSearch(stations) {
  const search = el("input", {
    type: "search", id: "station-search", autocomplete: "off", enterkeyhint: "go",
    placeholder: "e.g. Union, Bloor-Yonge", "aria-controls": "station-results",
    "aria-describedby": "station-count",
  });
  const count = el("p", { class: "sr-only", id: "station-count", "aria-live": "polite" });
  const results = el("ul", { class: "results", id: "station-results" });
  let matches = [];
  search.addEventListener("input", () => {
    const query = searchKey(search.value);
    matches = query ? stations.filter((s) => searchKey(s.name).includes(query)).slice(0, 8) : [];
    count.textContent = query ? `${matches.length} station${matches.length === 1 ? "" : "s"} found` : "";
    results.replaceChildren(
      ...matches.map((s) =>
        el("li", {}, el("a", { href: `#/station/${s.key}` }, el("span", {}, s.name), el("span", { class: "badges" }, s.lines.map((l) => badge(l, { link: false, small: true }))))),
      ),
    );
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && matches.length) location.hash = `#/station/${matches[0].key}`;
  });
  return [el("label", { for: "station-search" }, "Find a station"), search, count, results];
}

async function renderHome() {
  const [lineData, alertData] = await Promise.all([api("/api/lines"), api("/api/alerts")]);
  const accessibility = alertData.accessibility;
  return [
    el("h1", {}, "Service status"),
    staleNotice(alertData.alerts_as_of, "TTC alerts"),
    el("ul", { class: "status-list" }, lineData.lines.map((l) => statusRow(l.status))),
    stationSearch(lineData.stations),
    el("h2", {}, "Active alerts"),
    alertData.active.length ? alertData.active.map(alertCard) : el("p", { class: "muted" }, "No active subway alerts."),
    el("h2", {}, "Planned closures and notices"),
    alertData.upcoming.length ? alertData.upcoming.map(alertCard) : el("p", { class: "muted" }, "None announced."),
    el("h2", {}, "Elevators and escalators"),
    accessibility.length
      ? el(
          "details",
          { class: "card", "data-key": "home-accessibility" },
          el("summary", {}, `${accessibility.length} out of service`),
          el("ul", { class: "plain" }, accessibility.map((a) => el("li", {}, a.header))),
        )
      : el("p", { class: "muted" }, "No outages reported."),
  ];
}

// Spread trains that would overlap on the diagram sideways, away from the line.
function trainOffsets(trains) {
  const offsets = new Map();
  for (const direction of [0, 1]) {
    let previous = null;
    let shift = 0;
    for (const train of trains.filter((t) => t.direction_id === direction).sort((a, b) => a.position - b.position)) {
      shift = previous !== null && train.position - previous < OVERLAP_ROWS ? shift + 1 : 0;
      offsets.set(train, shift);
      previous = train.position;
    }
  }
  return offsets;
}

function lineDiagram(data) {
  const lineId = data.line.id;
  const last = data.stations.length - 1;
  const strip = el(
    "div",
    { class: "strip", style: { height: `${data.stations.length * ROW}px` } },
    el("div", { class: "bar", "aria-hidden": "true", style: { background: data.line.color || "#777" } }),
    el(
      "ol",
      { "aria-label": `Stations on ${data.line.name}` },
      data.stations.map((s, i) => {
        const transfers = (stationLines.get(s.key) || []).filter((l) => l !== lineId);
        return el(
          "li",
          { class: i === 0 || i === last ? "terminal" : null },
          el("a", { href: `#/station/${s.key}` }, s.name, transfers.length ? el("span", { class: "badges" }, transfers.map((l) => badge(l, { link: false, small: true }))) : null),
        );
      }),
    ),
  );
  for (const gap of data.gaps.filter((g) => g.long)) {
    const top = Math.min(gap.from_position, gap.to_position) * ROW + ROW / 2;
    const size = Math.abs(gap.to_position - gap.from_position) * ROW;
    strip.append(el("div", { class: `gap d${gap.direction_id}`, "aria-hidden": "true", style: { top: `${top}px`, height: `${Math.max(size, 24)}px` } }, `${Math.round(gap.seconds / 60)} min`));
  }
  const offsets = trainOffsets(data.trains);
  for (const train of data.trains) {
    const outward = (offsets.get(train) || 0) * 12 * (train.direction_id === 0 ? -1 : 1);
    strip.append(el("div", {
      class: `train d${train.direction_id}${train.at_station ? " at" : ""}`,
      "aria-hidden": "true",
      style: { top: `${train.position * ROW + ROW / 2}px`, translate: `${outward}px 0` },
      title: `Train ${train.train_id}: ${train.at_station ? "at" : "approaching"} ${train.station}`,
    }));
  }
  return strip;
}

function directionSummary(data, dir) {
  const trains = data.trains.filter((t) => t.direction_id === dir.direction_id);
  const longGaps = data.gaps.filter((g) => g.long && g.direction_id === dir.direction_id);
  const headway = data.scheduled_headway_seconds[dir.direction_id];
  return el(
    "section",
    { class: "card" },
    el("h2", {}, `Towards ${dir.towards}`),
    el("p", { class: "muted" }, `${trains.length} trains in the feed`, headway ? ` · scheduled about every ${minutesText(headway)}` : ""),
    longGaps.length
      ? el("p", {}, statusPill("detected", `${longGaps.length} unusually long gap${longGaps.length > 1 ? "s" : ""}`), ` Longest ${Math.round(Math.max(...longGaps.map((g) => g.seconds)) / 60)} min between trains.`)
      : el("p", { class: "muted" }, "No unusually long gaps between trains."),
    el(
      "details",
      { "data-key": `trains-${dir.direction_id}` },
      el("summary", {}, "Train list"),
      el("ul", { class: "plain" }, trains.map((t) => el("li", {}, t.at_station ? `At ${t.station}` : `Approaching ${t.station} (${minutesText(t.eta_seconds)})`))),
    ),
  );
}

async function renderLine(id) {
  const data = await api(`/api/lines/${encodeURIComponent(id)}`);
  const [dir0, dir1] = [0, 1].map((d) => data.line.directions.find((x) => x.direction_id === d));
  return [
    el("h1", { class: "with-badge" }, badge(data.line.id, { link: false }), data.line.name),
    el("div", { class: "card" }, statusDetails(data.status)),
    staleNotice(data.predictions_as_of, "Train predictions"),
    el(
      "div",
      { class: "diagram" },
      el("div", { class: "legend", "aria-hidden": "true" }, el("span", {}, dir0 ? `↓ to ${dir0.towards}` : ""), el("span", {}, dir1 ? `↑ to ${dir1.towards}` : "")),
      lineDiagram(data),
      el(
        "ul",
        { class: "key", "aria-hidden": "true" },
        el("li", {}, el("span", { class: "train d0 sample" }), "Train between stations"),
        el("li", {}, el("span", { class: "train at sample" }), "Train at a station"),
        el("li", {}, el("span", { class: "gap sample" }), "Gap well above the schedule"),
      ),
      el("p", { class: "muted small" }, "Positions are estimated from predicted arrival times. Train lists below give the same information as text."),
    ),
    [dir0, dir1].filter(Boolean).map((dir) => directionSummary(data, dir)),
  ];
}

function arrivalsCard(d) {
  return el(
    "section",
    { class: "card" },
    el("h3", { class: "with-badge" }, badge(d.line, { link: false, small: true }), el("span", {}, d.platform, el("span", { class: "muted" }, ` to ${d.towards}`))),
    d.arrivals.length
      ? el(
          "ul",
          { class: "arrivals" },
          d.arrivals.map((a) => el("li", {}, el("span", { class: "mins" }, a.minutes === 0 ? "Due" : `${a.minutes} min`), el("span", { class: "muted" }, timeFmt.format(new Date(a.arrival))))),
        )
      : el("p", { class: "muted" }, "No predictions right now."),
  );
}

function bikeCard(d) {
  return el(
    "li",
    { class: "card bike" },
    el("strong", {}, d.name),
    el(
      "p",
      { class: "bike-stats" },
      el("span", {}, el("b", {}, d.bikes), d.bikes === 1 ? " bike" : " bikes"),
      el("span", {}, el("b", {}, d.docks), d.docks === 1 ? " open dock" : " open docks"),
      el("span", { class: "muted" }, `${d.distance_m} m away`),
      d.renting ? null : el("span", { class: "warn" }, "Not renting"),
    ),
  );
}

async function renderStation(key) {
  const data = await api(`/api/stations/${encodeURIComponent(key)}`);
  const station = data.station;
  const bikes = data.bike_share;
  return [
    el("h1", { class: "with-badge" }, station.name, station.lines.map((l) => badge(l))),
    data.line_status.map((s) => el("div", { class: "card status-row" }, badge(s.line, { link: false }), el("div", {}, statusDetails(s)))),
    staleNotice(data.predictions_as_of, "Train predictions"),
    el("h2", {}, "Next trains"),
    el("div", { class: "grid" }, station.directions.map(arrivalsCard)),
    el("h2", {}, "Alerts at this station"),
    data.alerts.length ? data.alerts.map(alertCard) : el("p", { class: "muted" }, "No alerts for this station, including elevators and escalators."),
    el("h2", {}, "Nearest Bike Share"),
    staleNotice(bikes, "Bike Share availability"),
    bikes.docks.length ? el("ul", { class: "grid bare" }, bikes.docks.map(bikeCard)) : el("p", { class: "muted" }, "No Bike Share data yet."),
  ];
}

function hourLabel(hour) {
  const h = hour % 24;
  const label = `${h % 12 || 12} ${h < 12 ? "a.m." : "p.m."}`;
  return hour >= 24 ? `${label} (late)` : label;
}

function meter(pct) {
  if (pct === null || pct === undefined) return el("span", { class: "muted" }, "–");
  return el(
    "span",
    { class: "meter", role: "img", "aria-label": `${pct}%` },
    el("span", { class: "fill", style: { width: `${pct}%` } }),
    el("span", { class: "value", "aria-hidden": "true" }, `${pct}%`),
  );
}

function durationText(minutes) {
  const h = Math.floor(minutes / 60);
  return h ? `${h} h ${minutes % 60} min` : `${minutes} min`;
}

function lineCard(line, body) {
  return el("section", { class: "card" }, el("h3", { class: "with-badge" }, badge(line.id, { small: true }), line.name), body);
}

function gapList(gaps) {
  if (!gaps.length) return el("p", { class: "muted" }, "No measurable gaps yet today.");
  return el(
    "ol",
    { class: "gaps" },
    gaps.map((g) =>
      el(
        "li",
        {},
        el("strong", { class: "mins" }, `${(g.gap_seconds / 60).toFixed(1)} min`),
        el(
          "span",
          {},
          el("a", { href: `#/station/${g.station_key}` }, g.station_name),
          ` to ${g.towards}`,
          el("span", { class: "muted" }, ` · ${timeFmt.format(new Date(g.gap_start))}–${timeFmt.format(new Date(g.gap_end))}`, g.scheduled_headway_seconds ? ` · usually every ${minutesText(g.scheduled_headway_seconds)}` : ""),
        ),
      ),
    ),
  );
}

function hourTable(hours) {
  if (!hours.length) return el("p", { class: "muted" }, "No data yet.");
  return el(
    "table",
    { class: "hours" },
    el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Hour"), el("th", { scope: "col" }, "Today"), el("th", { scope: "col" }, "Last 7 days"), el("th", { scope: "col" }, "Long gaps today"))),
    el(
      "tbody",
      {},
      hours.map((h) =>
        el("tr", {}, el("th", { scope: "row" }, hourLabel(h.hour)), el("td", {}, meter(h.today_regular_pct)), el("td", {}, meter(h.week_regular_pct)), el("td", {}, h.today_long_gaps === null ? "–" : h.today_long_gaps)),
      ),
    ),
  );
}

function outageItem(o) {
  return el(
    "li",
    {},
    el("a", { href: `#/station/${o.station_key}` }, o.station_name),
    el("span", { class: "muted" }, ` ${o.device_type}`),
    el("span", { class: "mins" }, o.began_before_collection ? `≥ ${durationText(o.duration_minutes)}` : durationText(o.duration_minutes)),
  );
}

const OUTAGES_SHOWN = 6;

async function renderReliability() {
  const data = await api("/api/reliability");
  if (!data.available) {
    return [
      el("h1", {}, "Reliability"),
      el("p", {}, "Reliability analytics have not been built yet. They appear after the first scheduled transformation."),
    ];
  }
  const coverage = data.coverage;
  const outages = data.outages;
  const resolvedText =
    outages.median_resolved_minutes === null
      ? ""
      : ` (median ${durationText(outages.median_resolved_minutes)}, longest ${durationText(outages.longest_resolved_minutes)})`;
  return [
    el("h1", {}, "Reliability"),
    el(
      "p",
      { class: "muted" },
      `Measured from ${coverage.headways.toLocaleString("en-CA")} gaps between observed train arrivals since ${coverage.first_day}. History starts when collection started. `,
      data.analytics_built_at ? `Analytics updated ${timeFmt.format(new Date(data.analytics_built_at))}` : "",
    ),
    el("h2", {}, "Longest gaps between trains today"),
    el("div", { class: "grid" }, lines.map((line) => lineCard(line, gapList(data.longest_gaps_today.filter((g) => g.route_id === line.id))))),
    el("h2", {}, "Headway reliability by hour"),
    el(
      "p",
      { class: "muted" },
      "Share of gaps between trains within 1.5 times the scheduled headway. A long gap exceeds twice the scheduled headway and the headway plus 5 minutes. Terminals are excluded.",
    ),
    el("div", { class: "grid" }, lines.map((line) => lineCard(line, hourTable(data.hourly[line.id] || [])))),
    el("h2", {}, "Elevator and escalator outages"),
    el("p", {}, `${outages.active.length} out of service now. Resolved in the last 7 days: ${outages.resolved_last_7_days}${resolvedText}.`),
    outages.active.length
      ? el(
          "div",
          { class: "card" },
          el("ul", { class: "outages" }, outages.active.slice(0, OUTAGES_SHOWN).map(outageItem)),
          outages.active.length > OUTAGES_SHOWN
            ? el(
                "details",
                { "data-key": "more-outages" },
                el("summary", {}, `Show ${outages.active.length - OUTAGES_SHOWN} more`),
                el("ul", { class: "outages" }, outages.active.slice(OUTAGES_SHOWN).map(outageItem)),
              )
            : null,
          el("p", { class: "muted small" }, "≥ means the outage was already in progress when collection started."),
        )
      : null,
  ];
}

// A periodic refresh must not throw away what the visitor is doing: typed search text,
// focus, open panels and scroll position are carried over to the new content.
function captureState() {
  const active = document.activeElement;
  const focused = active && main.contains(active) && active.id ? active : null;
  return {
    open: new Set([...main.querySelectorAll("details[data-key]")].filter((d) => d.open).map((d) => d.dataset.key)),
    search: document.getElementById("station-search")?.value || "",
    focusId: focused ? focused.id : null,
    selection: focused && typeof focused.selectionStart === "number" ? [focused.selectionStart, focused.selectionEnd] : null,
    scroll: window.scrollY,
  };
}

function restoreState(state) {
  for (const d of main.querySelectorAll("details[data-key]")) d.open = state.open.has(d.dataset.key);
  const search = document.getElementById("station-search");
  if (search && state.search) {
    search.value = state.search;
    search.dispatchEvent(new Event("input"));
  }
  const focused = state.focusId && document.getElementById(state.focusId);
  if (focused) {
    focused.focus({ preventScroll: true });
    if (state.selection) focused.setSelectionRange(...state.selection);
  }
  window.scrollTo(0, state.scroll);
}

function markCurrentNav(kind, id) {
  for (const link of document.querySelectorAll("#line-nav a")) {
    const href = link.getAttribute("href");
    const current = (kind === "line" && href === `#/line/${id}`) || (kind === "reliability" && href === "#/reliability");
    if (current) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

async function route({ refresh = false } = {}) {
  const [, kind, id] = (location.hash || "#/").split("/");
  const seq = ++renderSeq;
  try {
    if (!lines.length) {
      const lineData = await api("/api/lines");
      lines = lineData.lines;
      stationLines = new Map(lineData.stations.map((s) => [s.key, s.lines]));
      document.getElementById("line-nav").replaceChildren(
        ...lines.map((l) => badge(l.id)),
        el("a", { href: "#/reliability", class: "navlink" }, "Reliability"),
      );
    }
    let content;
    if (kind === "line" && id) content = await renderLine(id);
    else if (kind === "station" && id) content = await renderStation(id);
    else if (kind === "reliability") content = await renderReliability();
    else content = await renderHome();
    if (seq !== renderSeq) return; // A newer navigation or refresh finished first.
    const state = refresh ? captureState() : null;
    main.replaceChildren(...[content].flat(Infinity).filter(Boolean));
    if (state) restoreState(state);
    markCurrentNav(kind, id);
    updated.textContent = `Updated ${timeFmt.format(new Date())}`;
    updated.classList.remove("warn");
  } catch (error) {
    if (seq !== renderSeq) return;
    if (refresh && main.querySelector("h1") && error.message !== "Not found") {
      // Keep the last good data on screen rather than replacing it with an error.
      updated.textContent = `Could not refresh at ${timeFmt.format(new Date())}. Showing earlier data; retrying shortly.`;
      updated.classList.add("warn");
      return;
    }
    main.replaceChildren(el("h1", {}, "Unavailable"), el("p", {}, error.message === "Not found" ? "That line or station does not exist." : "Live data is unavailable right now. Retrying shortly."));
  }
}

window.addEventListener("hashchange", () => {
  route().then(() => { window.scrollTo(0, 0); main.focus({ preventScroll: true }); });
});
setInterval(() => { if (document.visibilityState === "visible") route({ refresh: true }); }, REFRESH_MS);
route();
