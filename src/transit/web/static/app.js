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
    el("h2", { class: "with-link" }, "Nearest Bike Share", el("a", { href: `#/map/${station.key}`, class: "small" }, "View on map")),
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


// Open-data downloads listed from /api/datasets (the export's index.json).
const fileDayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric",
});

function sizeText(bytes) {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function downloadSection(sets) {
  if (!sets.available) return null;
  const shown = 7;
  return [
    el("h2", { id: "download" }, "Download the data"),
    el(
      "p",
      { class: "muted" },
      "Daily files from this project's own collection, free to reuse with attribution. ",
      "Parquet for analysis tools, gzipped CSV for spreadsheets.",
    ),
    sets.datasets
      .filter((d) => d.files.length)
      .map((d) =>
        el(
          "section",
          { class: "card" },
          el("h3", {}, d.title),
          el("p", { class: "muted small" }, d.description, d.day ? ` One file per day (${d.day}).` : ""),
          el(
            "ul",
            { class: "downloads" },
            d.files.slice(0, shown).map((f) =>
              el(
                "li",
                {},
                el("span", {}, f.day ? fileDayFmt.format(new Date(`${f.day}T00:00:00Z`)) : "All to date", f.partial ? " (partial day)" : ""),
                el("span", { class: "muted small" }, `${numberFmt.format(f.rows)} rows`),
                el(
                  "span",
                  { class: "links" },
                  el("a", { href: `/data/${f.files.parquet.path}`, download: "" }, `Parquet, ${sizeText(f.files.parquet.bytes)}`),
                  el("a", { href: `/data/${f.files.csv.path}`, download: "" }, `CSV, ${sizeText(f.files.csv.bytes)}`),
                ),
              ),
            ),
          ),
          d.files.length > shown
            ? el("p", { class: "muted small" }, `${d.files.length - shown} earlier files are listed in `, el("a", { href: "/data/index.json" }, "index.json"), ".")
            : null,
          el(
            "details",
            { "data-key": `columns-${d.name}` },
            el("summary", {}, "Columns"),
            el("dl", { class: "facts columns" }, Object.entries(d.columns).map(([name, text]) => [el("dt", {}, el("code", {}, name)), el("dd", {}, text)])),
          ),
        ),
      ),
    el(
      "p",
      { class: "muted small" },
      sets.licence,
      " ",
      el("a", { href: sets.licence_url }, "Licence terms"),
      ". Row counts and SHA-256 checksums for every file are in ",
      el("a", { href: "/data/index.json" }, "index.json"),
      ".",
    ),
  ];
}

async function renderReliability() {
  const [data, sets] = await Promise.all([api("/api/reliability"), api("/api/datasets")]);
  if (!data.available) {
    return [
      el("h1", {}, "Reliability"),
      el("p", {}, "Reliability analytics have not been built yet. They appear after the first scheduled transformation."),
      downloadSection(sets),
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
    downloadSection(sets),
  ];
}

// Map: subway lines, stations and Bike Share docks drawn from their coordinates. No map
// tiles, so the page still makes no third-party requests. Coordinates are projected to
// metres around the network's centre; the SVG viewBox is the visible area in metres.
const SVG_NS = "http://www.w3.org/2000/svg";
const METRES_PER_DEGREE = 111320;
const MAP_DEFAULT = { lat: 43.6585, lon: -79.385, mpp: 8 }; // Downtown, Union to Bloor.
const MAP_FOCUS_MPP = 4; // Zoom when opening a station or finding a dock near you.
const MAP_MIN_MPP = 1;
const MAP_MAX_MPP = 120;
const LABELS_ALL_BELOW = 6; // Every station name below this many metres per pixel.
const LABELS_MAJOR_BELOW = 13; // Interchanges and terminals only, up to this.
const MAP_REFRESH_MS = 120000; // Bike Share data changes every 15 minutes.
const MAP_MODES = { bikes: "Find a bike", docks: "Find a dock" };
// Kept across the 20-second refresh so it does not reset the view or the selection.
const mapState = {
  view: null, mode: "bikes", selected: null, focusedKey: null, located: null, busy: false, observer: null, renderedAt: 0,
};

function fill(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
}

function svgEl(tag, attrs = {}, text = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  if (text !== null) node.textContent = text;
  return node;
}

function dockCount(dock, mode) {
  return mode === "bikes" ? dock.bikes : dock.docks;
}

function dockClass(dock, mode) {
  if (!dock.current) return "dock unknown";
  const count = dockCount(dock, mode);
  return `dock ${count === 0 ? "none" : count < 3 ? "few" : "ok"}`;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function mapLegend(mode) {
  const what = mode === "bikes" ? ["bikes", "No bikes"] : ["open docks", "No open docks"];
  return [
    el("li", {}, el("span", { class: "swatch ok" }), `3+ ${what[0]}`),
    el("li", {}, el("span", { class: "swatch few" }), "1–2"),
    el("li", {}, el("span", { class: "swatch none" }), what[1]),
    el("li", {}, el("span", { class: "swatch unknown" }), "No recent report"),
    el("li", {}, el("span", { class: "swatch station" }), "Subway station"),
  ];
}

async function renderMap(focusKey) {
  const data = await api("/api/map");
  mapState.renderedAt = Date.now();
  const bikes = data.bike_share;
  const lat0 = data.stations.reduce((sum, s) => sum + s.lat, 0) / data.stations.length;
  const lon0 = data.stations.reduce((sum, s) => sum + s.lon, 0) / data.stations.length;
  const kx = Math.cos((lat0 * Math.PI) / 180) * METRES_PER_DEGREE;
  const project = (lat, lon) => [(lon - lon0) * kx, (lat0 - lat) * METRES_PER_DEGREE];
  const stations = data.stations.map((s) => ({ ...s, kind: "station", xy: project(s.lat, s.lon) }));
  const docks = bikes.docks.map((d) => ({ ...d, kind: "dock", xy: project(d.lat, d.lon) }));
  const terminals = new Set(data.lines.flatMap((l) => [l.path[0], l.path[l.path.length - 1]].map((p) => p.join())));
  const major = (s) => s.lines.length > 1 || terminals.has([s.lat, s.lon].join());

  const svg = svgEl("svg", {
    class: "map-svg", role: "img",
    "aria-label": `Map of ${stations.length} subway stations and ${docks.length} Bike Share docks. Details for the selected item appear below the map.`,
  });
  const lineLayer = svgEl("g");
  for (const line of data.lines) {
    const points = line.path.map(([lat, lon]) => project(lat, lon).map((v) => v.toFixed(1)).join(",")).join(" ");
    lineLayer.append(svgEl("polyline", { class: "map-line", points, stroke: line.color || "#777" }));
  }
  const dockLayer = svgEl("g");
  const dockNodes = docks.map((d) => {
    const node = svgEl("circle", { cx: d.xy[0].toFixed(1), cy: d.xy[1].toFixed(1), class: dockClass(d, mapState.mode) });
    dockLayer.append(node);
    return node;
  });
  const stationLayer = svgEl("g");
  const stationNodes = stations.map((s) => {
    const node = svgEl("circle", { cx: s.xy[0].toFixed(1), cy: s.xy[1].toFixed(1), class: s.lines.length > 1 ? "stn interchange" : "stn" });
    stationLayer.append(node);
    return node;
  });
  const labelLayer = svgEl("g", { class: "stn-labels", "aria-hidden": "true" });
  const labelNodes = stations.map((s) => {
    const node = svgEl("text", { y: s.xy[1].toFixed(1), class: major(s) ? "stn-label major" : "stn-label" }, s.name);
    labelLayer.append(node);
    return node;
  });
  const selection = svgEl("circle", { class: "sel", r: 0 });
  const me = svgEl("circle", { class: "me", r: 0 });
  svg.append(lineLayer, dockLayer, stationLayer, labelLayer, selection, me);

  const panel = el("div", { class: "card map-panel", "aria-live": "polite" });
  let view = mapState.view ? { ...mapState.view } : null;
  let lastWidth = null;

  // Before the map is on screen its width is unknown; main's content width is the same.
  const screenWidth = () => svg.clientWidth || main.clientWidth - 32 || 358;

  function centreOn([x, y], mpp) {
    const width = mpp * screenWidth();
    view = { x: x - width / 2, y: y - width / 2, w: width, h: width };
    fitAspect();
  }
  if (focusKey && focusKey !== mapState.focusedKey) {
    const target = stations.find((s) => s.key === focusKey);
    if (target) {
      centreOn(target.xy, MAP_FOCUS_MPP);
      mapState.selected = { kind: "station", id: target.key };
    }
  }
  mapState.focusedKey = focusKey || null;
  if (!view) centreOn(project(MAP_DEFAULT.lat, MAP_DEFAULT.lon), MAP_DEFAULT.mpp);

  // Keep the viewBox at the element's aspect ratio so one scale applies to x and y.
  function fitAspect() {
    const ratio = svg.clientWidth ? svg.clientHeight / svg.clientWidth : 1;
    const cy = view.y + view.h / 2;
    view.h = view.w * ratio;
    view.y = cy - view.h / 2;
  }

  function metresPerPixel() {
    return view.w / screenWidth();
  }

  function apply() {
    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
    mapState.view = { ...view };
    const mpp = metresPerPixel();
    if (view.w !== lastWidth) {
      lastWidth = view.w;
      const dockPx = mpp > 40 ? 2.5 : mpp > 15 ? 3.5 : mpp > 6 ? 5 : 7;
      for (const node of dockNodes) node.setAttribute("r", (dockPx * mpp).toFixed(1));
      for (const node of stationNodes) node.setAttribute("r", ((node.classList.contains("interchange") ? 6 : 4.5) * mpp).toFixed(1));
      labelLayer.style.fontSize = `${12 * mpp}px`;
      labelLayer.style.strokeWidth = `${3 * mpp}px`;
      labelNodes.forEach((node, i) => node.setAttribute("x", (stations[i].xy[0] + 9 * mpp).toFixed(1)));
      svg.classList.toggle("labels-all", mpp < LABELS_ALL_BELOW);
      svg.classList.toggle("labels-major", mpp < LABELS_MAJOR_BELOW);
    }
    drawMarker(selection, selectedItem(), 11 * mpp);
    drawMarker(me, mapState.located && { xy: project(mapState.located.lat, mapState.located.lon) }, 7 * mpp);
  }

  function drawMarker(node, item, radius) {
    if (!item) {
      node.setAttribute("r", 0);
      return;
    }
    node.setAttribute("cx", item.xy[0].toFixed(1));
    node.setAttribute("cy", item.xy[1].toFixed(1));
    node.setAttribute("r", radius.toFixed(1));
  }

  function selectedItem() {
    const sel = mapState.selected;
    if (!sel) return null;
    return (sel.kind === "station" ? stations : docks).find((item) => (item.key || item.id) === sel.id) || null;
  }

  function nearestStation(xy) {
    let best = null;
    for (const s of stations) {
      const d = Math.hypot(s.xy[0] - xy[0], s.xy[1] - xy[1]);
      if (!best || d < best.d) best = { s, d };
    }
    return best;
  }

  function showPanel(intro = null) {
    const item = selectedItem();
    if (!item) {
      fill(panel, el("p", { class: "muted" }, "Tap a Bike Share dock or a subway station for details. Drag to move, pinch or scroll to zoom."));
      return;
    }
    if (item.kind === "station") {
      const statuses = item.lines.map((id) => data.lines.find((l) => l.id === id)).filter(Boolean);
      fill(panel, 
        el("h2", { class: "with-badge" }, item.name, item.lines.map((l) => badge(l, { small: true }))),
        statuses.map((l) => el("p", { class: "status-line" }, statusPill(l.status.status, l.status.label), el("span", { class: "source" }, `${l.name} · reported by TTC`))),
        el("p", {}, el("a", { href: `#/station/${item.key}` }, "Next trains, alerts and nearest docks →")),
      );
      return;
    }
    const near = nearestStation(item.xy);
    fill(panel, 
      intro ? el("p", { class: "source" }, intro) : null,
      el("h2", {}, item.name),
      item.current
        ? el(
            "p",
            { class: "bike-stats" },
            el("span", {}, el("b", {}, item.bikes), item.bikes === 1 ? " bike" : " bikes"),
            el("span", {}, el("b", {}, item.docks), item.docks === 1 ? " open dock" : " open docks"),
            item.capacity ? el("span", { class: "muted" }, `${item.capacity} total`) : null,
          )
        : el("p", { class: "warn" }, "No recent report from this dock, so availability is unknown."),
      el("p", { class: "muted small" }, `Dock reported ${timeFmt.format(new Date(item.reported_at))}`),
      near ? el("p", {}, `${Math.round(near.d / 10) * 10} m from `, el("a", { href: `#/station/${near.s.key}` }, `${near.s.name} station`)) : null,
    );
  }

  function select(item, intro = null) {
    mapState.selected = item ? { kind: item.kind, id: item.key || item.id } : null;
    showPanel(intro);
    apply();
  }

  // One listener handles every feature: a tap picks the nearest station or dock within a
  // finger's reach, which works better than tiny per-circle targets on a phone.
  function tap(px, py) {
    const mpp = metresPerPixel();
    const x = view.x + px * mpp;
    const y = view.y + py * mpp;
    const nearest = (items, reach) => {
      let best = null;
      for (const item of items) {
        const d = Math.hypot(item.xy[0] - x, item.xy[1] - y);
        if (d <= reach && (!best || d < best.d)) best = { item, d };
      }
      return best && best.item;
    };
    select(nearest(stations, 16 * mpp) || nearest(docks, 18 * mpp));
  }

  function zoomAt(factor, px, py) {
    const width = Math.min(MAP_MAX_MPP, Math.max(MAP_MIN_MPP, metresPerPixel() * factor)) * screenWidth();
    const f = width / view.w;
    const mpp = metresPerPixel();
    const ux = view.x + px * mpp;
    const uy = view.y + py * mpp;
    view = { x: ux - (ux - view.x) * f, y: uy - (uy - view.y) * f, w: width, h: view.h * f };
    apply();
  }

  const pointers = new Map();
  let gesture = null;
  const local = (event) => {
    const rect = svg.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };
  svg.addEventListener("pointerdown", (event) => {
    svg.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, local(event));
    mapState.busy = true;
    gesture = { start: local(event), moved: 0, at: Date.now(), multi: pointers.size > 1 || (gesture && gesture.multi) };
  });
  svg.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    const previous = pointers.get(event.pointerId);
    const current = local(event);
    if (pointers.size === 1) {
      const mpp = metresPerPixel();
      view.x -= (current[0] - previous[0]) * mpp;
      view.y -= (current[1] - previous[1]) * mpp;
      gesture.moved += Math.hypot(current[0] - previous[0], current[1] - previous[1]);
      pointers.set(event.pointerId, current);
      apply();
      return;
    }
    const [a, b] = [...pointers.values()];
    const other = a === previous ? b : a;
    const before = Math.hypot(previous[0] - other[0], previous[1] - other[1]);
    const after = Math.hypot(current[0] - other[0], current[1] - other[1]);
    pointers.set(event.pointerId, current);
    if (before > 0 && after > 0) zoomAt(before / after, (current[0] + other[0]) / 2, (current[1] + other[1]) / 2);
  });
  const release = (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (pointers.size === 0 && gesture && !gesture.multi && gesture.moved < 8 && Date.now() - gesture.at < 600) tap(...gesture.start);
    if (pointers.size === 0) {
      gesture = null;
      mapState.busy = false;
    }
  };
  svg.addEventListener("pointerup", release);
  svg.addEventListener("pointercancel", (event) => {
    pointers.delete(event.pointerId);
    gesture = null;
    mapState.busy = pointers.size > 0;
  });
  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomAt(Math.exp(event.deltaY * 0.0015), ...local(event));
  }, { passive: false });
  mapState.observer?.disconnect();
  mapState.observer = new ResizeObserver(() => { fitAspect(); lastWidth = null; apply(); });
  mapState.observer.observe(svg);

  const zoomButton = (label, text, factor) => {
    const button = el("button", { type: "button", "aria-label": label }, text);
    button.addEventListener("click", () => zoomAt(factor, svg.clientWidth / 2, svg.clientHeight / 2));
    return button;
  };
  const resetButton = el("button", { type: "button", "aria-label": "Back to downtown" }, "⌂");
  resetButton.addEventListener("click", () => {
    centreOn(project(MAP_DEFAULT.lat, MAP_DEFAULT.lon), MAP_DEFAULT.mpp);
    apply();
  });

  const container = el(
    "div",
    { class: "map-wrap", tabindex: "0", id: "map", "aria-label": "Map. Arrow keys move, plus and minus zoom." },
    svg,
    el("div", { class: "map-zoom" }, zoomButton("Zoom in", "+", 0.6), zoomButton("Zoom out", "−", 1 / 0.6), resetButton),
  );
  container.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (step) {
      view.x += step[0] * view.w * 0.15;
      view.y += step[1] * view.h * 0.15;
      apply();
    } else if (event.key === "+" || event.key === "=") zoomAt(0.7, svg.clientWidth / 2, svg.clientHeight / 2);
    else if (event.key === "-") zoomAt(1 / 0.7, svg.clientWidth / 2, svg.clientHeight / 2);
    else return;
    event.preventDefault();
  });

  const legend = el("ul", { class: "map-legend" }, mapLegend(mapState.mode));
  const modeButtons = Object.entries(MAP_MODES).map(([mode, label]) => {
    const button = el("button", { type: "button", class: "seg", "aria-pressed": String(mode === mapState.mode) }, label);
    button.addEventListener("click", () => {
      mapState.mode = mode;
      for (const b of modeButtons) b.setAttribute("aria-pressed", String(b === button));
      docks.forEach((d, i) => dockNodes[i].setAttribute("class", dockClass(d, mode)));
      legend.replaceChildren(...mapLegend(mode));
    });
    return button;
  });

  const locateButton = el("button", { type: "button", class: "seg locate" }, "◎ Near me");
  locateButton.addEventListener("click", () => {
    if (!navigator.geolocation) {
      fill(panel, el("p", { class: "warn" }, "This browser cannot share its location."));
      return;
    }
    locateButton.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        locateButton.disabled = false;
        mapState.located = { lat: position.coords.latitude, lon: position.coords.longitude };
        const here = project(mapState.located.lat, mapState.located.lon);
        const usable = docks.filter((d) => d.current && dockCount(d, mapState.mode) > 0);
        let best = null;
        for (const d of usable) {
          const dist = Math.hypot(d.xy[0] - here[0], d.xy[1] - here[1]);
          if (!best || dist < best.dist) best = { d, dist };
        }
        centreOn(here, MAP_FOCUS_MPP);
        const what = mapState.mode === "bikes" ? "with bikes" : "with open docks";
        if (best && best.dist < 20000) select(best.d, `Nearest dock ${what}, about ${Math.round(best.dist / 10) * 10} m away in a straight line`);
        else select(null);
      },
      () => {
        locateButton.disabled = false;
        fill(panel, el("p", { class: "warn" }, "Your location is unavailable. Check the browser's location permission."));
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });

  const reporting = docks.filter((d) => d.current);
  const withBikes = reporting.filter((d) => d.bikes > 0).length;
  const full = reporting.filter((d) => d.docks === 0).length;
  showPanel();
  return [
    el("h1", {}, "Map"),
    staleNotice(bikes, "Bike Share availability"),
    el("div", { class: "map-tools" }, el("div", { class: "segmented", role: "group", "aria-label": "Colour docks by" }, modeButtons), locateButton),
    container,
    legend,
    panel,
    el(
      "p",
      { class: "muted small" },
      `${plural(reporting.length, "dock", "docks")} reporting: ${withBikes} with bikes, ${reporting.length - withBikes} empty, ${full} full. `,
      bikes.as_of ? `Bike Share collected ${timeFmt.format(new Date(bikes.as_of))}, every 15 minutes. ` : "",
      "Lines are drawn straight between stations. Your location stays in this browser; it is never sent to the server. Each station page lists its nearest docks.",
    ),
  ];
}

// Pipeline status: health of each collector and the dbt build, from the ops tables.
const HEALTH = {
  ok: ["normal", "Healthy"],
  delayed: ["delays", "Delayed"],
  failing: ["no_service", "Failing"],
};
const CHECK_LABELS = {
  feed_freshness: "Feeds published within the last 30 minutes",
  required_fields_and_unique_stations: "Required fields present, no duplicate stations",
  station_report_freshness: "Every station reported within the last 30 minutes",
  station_status_coverage: "Every listed station has a status report",
};
const numberFmt = new Intl.NumberFormat("en-CA");

function healthPill(status) {
  const [css, label] = HEALTH[status] || HEALTH.failing;
  return statusPill(css, label);
}

function ageText(seconds) {
  if (seconds === null || seconds === undefined) return "never";
  if (seconds < 90) return `${seconds} s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

function healthCard(title, status, ...body) {
  return el("section", { class: "card" }, el("h3", { class: "with-link" }, title, healthPill(status)), body);
}

function checkDetail(check) {
  const d = check.details || {};
  if (check.check_name === "station_report_freshness") {
    return `${numberFmt.format(d.stale_or_future_reports)} of ${numberFmt.format(d.observed_stations)} stale`;
  }
  if (check.check_name === "station_status_coverage") {
    return `${numberFmt.format(d.observed_stations)} of ${numberFmt.format(d.metadata_stations)} reported`;
  }
  return null;
}

async function renderPipeline() {
  const data = await api("/api/pipeline");
  const { ttc, bikeshare: bikes, dbt, data: volume } = data;
  const drops = ttc.dropouts_today;
  const latest = dbt.latest;
  const dateOf = (iso) => (iso ? dayFmt.format(new Date(iso)) : "–");
  return [
    el("h1", { class: "with-link" }, "Pipeline status", healthPill(data.overall)),
    el(
      "p",
      { class: "muted" },
      "Health of the data pipelines behind this site, read from the records each step writes as it runs. ",
      "Healthy means the last success is recent; delayed or failing means data on this site may be out of date.",
    ),
    el("h2", {}, "TTC realtime feeds"),
    el("p", { class: "muted small" }, "Polled every 30 seconds."),
    ttc.feeds.map((f) =>
      healthCard(
        f.label,
        f.status,
        el("p", {}, `Last update ${ageText(f.age_seconds)}`),
        el(
          "p",
          { class: "muted small" },
          `Last hour: ${numberFmt.format(f.last_hour.polls)} polls, ${f.last_hour.failed} failed · `,
          `${numberFmt.format(f.last_hour.rejected)} records rejected, ${numberFmt.format(f.last_hour.flagged)} flagged by validation`,
        ),
      ),
    ),
    drops.snapshots
      ? el(
          "p",
          {},
          `Feed dropouts today: ${numberFmt.format(drops.dropouts)} of ${numberFmt.format(drops.snapshots)} train snapshots (${drops.pct}%) listed far fewer trains than the minutes before and were skipped, so they never blank this site.`,
        )
      : null,
    el("h2", {}, "Bike Share"),
    healthCard(
      "Dock availability",
      bikes.status,
      el("p", {}, `Last collection ${ageText(bikes.age_seconds)} · runs every 15 minutes`),
      el(
        "p",
        { class: "muted small" },
        `${numberFmt.format(bikes.succeeded_24h)} collections in the last 24 hours (at most ${bikes.expected_24h}), ${bikes.failed_attempts_24h} failed attempts`,
      ),
      el(
        "ul",
        { class: "checks" },
        bikes.quality_checks.map((c) =>
          el(
            "li",
            {},
            el("span", { class: c.passed ? "pass" : "fail", "aria-hidden": "true" }, c.passed ? "✓" : "✕"),
            el(
              "span",
              {},
              CHECK_LABELS[c.check_name] || c.check_name,
              el("span", { class: "sr-only" }, c.passed ? " (passed)" : " (failed)"),
              checkDetail(c) ? el("span", { class: "detail muted small" }, checkDetail(c)) : null,
            ),
          ),
        ),
      ),
    ),
    el("h2", {}, "Transformations"),
    healthCard(
      "dbt models and tests",
      dbt.status,
      el("p", {}, `Last successful build ${ageText(dbt.age_seconds)}`),
      latest
        ? el("p", { class: "muted small" }, `Latest build: ${latest.passed} passed, ${plural(latest.warned, "warning", "warnings")}, ${latest.failed} failed`)
        : null,
    ),
    data.official_delays
      ? [
          el("h2", {}, "TTC's official delay log"),
          el(
            "p",
            {},
            data.official_delays.log_reaches
              ? `TTC's published log currently covers incidents up to ${dayFmt.format(new Date(data.official_delays.log_reaches))}. `
              : "",
            `Last checked ${ageText(Math.round((Date.now() - new Date(data.official_delays.finished_at)) / 1000))} (${data.official_delays.status}). `,
            "The city publishes each month a few weeks after it ends; this site's detected gaps are compared with it once the months overlap.",
          ),
        ]
      : null,
    el("h2", {}, "Data collected"),
    el(
      "dl",
      { class: "card facts" },
      el("dt", {}, "Subway history since"), el("dd", {}, dateOf(volume.ttc_since)),
      el("dt", {}, "Train visits recorded"), el("dd", {}, numberFmt.format(volume.rows.ttc_train_visits ?? 0)),
      el("dt", {}, "Gaps between trains measured"), el("dd", {}, numberFmt.format(volume.rows.ttc_headways ?? 0)),
      el("dt", {}, "Bike Share history since"), el("dd", {}, dateOf(volume.bikeshare_since)),
      el("dt", {}, "Dock readings recorded"), el("dd", {}, numberFmt.format(volume.rows.bikeshare_observations ?? 0)),
      el("dt", {}, "Database size"), el("dd", {}, `${(volume.database_bytes / 1e6).toFixed(0)} MB`),
      el("dt", {}, "Schema version"), el("dd", {}, (volume.schema_version || "–").replaceAll("_", " ")),
    ),
    el("p", { class: "muted small" }, "Row counts are PostgreSQL's planner estimates, refreshed as tables are analyzed."),
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
    const current = (kind === "line" && href === `#/line/${id}`) || href === `#/${kind}`;
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
        el("a", { href: "#/map", class: "navlink" }, "Map"),
        el("a", { href: "#/reliability", class: "navlink" }, "Reliability"),
      );
    }
    let content;
    if (kind === "line" && id) content = await renderLine(id);
    else if (kind === "station" && id) content = await renderStation(id);
    else if (kind === "reliability") content = await renderReliability();
    else if (kind === "map") content = await renderMap(id);
    else if (kind === "pipeline") content = await renderPipeline();
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
setInterval(() => {
  // Skip a refresh in the middle of a map drag or pinch rather than interrupt it.
  if (document.visibilityState !== "visible" || mapState.busy) return;
  if (location.hash.startsWith("#/map") && Date.now() - mapState.renderedAt < MAP_REFRESH_MS) return;
  route({ refresh: true });
}, REFRESH_MS);
route();
