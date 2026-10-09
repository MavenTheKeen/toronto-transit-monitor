"use strict";
// Plain DOM rendering. All API text goes through textContent, never innerHTML.

const REFRESH_MS = 20000;
const ROW = 44; // Must match --row in app.css.
const main = document.getElementById("main");
const updated = document.getElementById("updated");
const timeFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto", hour: "numeric", minute: "2-digit",
});
const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto", weekday: "short", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit",
});
let lines = [];

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

function badge(line, link = true) {
  const meta = lines.find((l) => l.id === line) || {};
  const attrs = {
    class: "badge",
    style: { background: meta.color || "#777", color: meta.text_color || "#fff" },
    "aria-label": `Line ${line}`,
  };
  return link ? el("a", { ...attrs, href: `#/line/${line}` }, line) : el("span", attrs, line);
}

function statusPill(status) {
  return el("span", { class: `pill ${status.status}` }, status.label);
}

function staleNotice(freshness, what) {
  if (!freshness || !freshness.stale) return null;
  const when = freshness.as_of ? ` Last update ${timeFmt.format(new Date(freshness.as_of))}.` : "";
  return el("p", { class: "notice", role: "status" }, `${what} may be out of date.${when}`);
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
    el("p", {}, alert.lines.map((l) => [badge(l), " "]), el("span", { class: "tag" }, "Reported by TTC")),
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
    el("div", {}, el("span", { class: "tag" }, "Reported"), statusPill(status)),
    status.summary ? el("p", { class: "muted" }, status.summary) : null,
    detected
      ? el(
          "div",
          { class: "detected" },
          el("span", { class: "tag" }, "Detected"),
          el("span", { class: "pill detected" }, detected.label),
          detected.incidents.map((i) =>
            el(
              "p",
              {},
              el("a", { href: `#/station/${i.station_key}` }, i.message),
              el("span", { class: "muted" }, ` (scheduled every ${minutesText(i.scheduled_headway_seconds)})`),
            ),
          ),
        )
      : null,
  ];
}

function statusRow(status) {
  return el(
    "li",
    { class: "card status-row" },
    badge(status.line),
    el("div", {}, el("a", { class: "name", href: `#/line/${status.line}` }, status.name), statusDetails(status)),
  );
}

async function renderHome() {
  const [lineData, alertData] = await Promise.all([api("/api/lines"), api("/api/alerts")]);
  const stations = lineData.stations;
  const search = el("input", {
    type: "search", id: "station-search", autocomplete: "off",
    placeholder: "e.g. Union, Bloor-Yonge", "aria-controls": "station-results",
  });
  const results = el("ul", { class: "results", id: "station-results" });
  search.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    const matches = query ? stations.filter((s) => s.name.toLowerCase().includes(query)) : [];
    results.replaceChildren(
      ...matches.slice(0, 8).map((s) =>
        el("li", {}, el("a", { href: `#/station/${s.key}` }, s.name, " ", el("span", { class: "muted" }, `Line ${s.lines.join(", ")}`))),
      ),
    );
  });
  const accessibility = alertData.accessibility;
  return [
    el("h1", {}, "Service status"),
    staleNotice(alertData.alerts_as_of, "TTC alerts"),
    el("ul", { class: "status-list" }, lineData.lines.map((l) => statusRow(l.status))),
    el("label", { for: "station-search" }, "Find a station"),
    search,
    results,
    el("h2", {}, "Active alerts"),
    alertData.active.length ? alertData.active.map(alertCard) : el("p", { class: "muted" }, "No active subway alerts."),
    el("h2", {}, "Planned closures and notices"),
    alertData.upcoming.length ? alertData.upcoming.map(alertCard) : el("p", { class: "muted" }, "None announced."),
    el("h2", {}, "Elevators and escalators"),
    accessibility.length
      ? el(
          "details",
          { class: "card" },
          el("summary", {}, `${accessibility.length} out of service`),
          accessibility.map((a) => el("p", {}, a.header)),
        )
      : el("p", { class: "muted" }, "No outages reported."),
  ];
}

function minutesText(seconds) {
  if (seconds < 60) return "now";
  return `${Math.round(seconds / 60)} min`;
}

async function renderLine(id) {
  const data = await api(`/api/lines/${encodeURIComponent(id)}`);
  const [dir0, dir1] = [0, 1].map((d) => data.line.directions.find((x) => x.direction_id === d));
  const height = data.stations.length * ROW;
  const strip = el(
    "div",
    { class: "strip", "aria-hidden": "true", style: { height: `${height}px` } },
    el("div", { class: "bar", style: { background: data.line.color || "#777" } }),
    el("ol", {}, data.stations.map((s) => el("li", {}, el("a", { href: `#/station/${s.key}`, tabindex: "-1" }, s.name)))),
  );
  for (const gap of data.gaps.filter((g) => g.long)) {
    const top = Math.min(gap.from_position, gap.to_position) * ROW + ROW / 2;
    const size = Math.abs(gap.to_position - gap.from_position) * ROW;
    strip.append(el("div", { class: `gap d${gap.direction_id}`, style: { top: `${top}px`, height: `${Math.max(size, 24)}px` } }, `${Math.round(gap.seconds / 60)} min`));
  }
  for (const train of data.trains) {
    strip.append(el("div", {
      class: `train d${train.direction_id}${train.at_station ? " at" : ""}`,
      style: { top: `${train.position * ROW + ROW / 2}px` },
      title: `Train ${train.train_id}: ${train.at_station ? "at" : "approaching"} ${train.station}`,
    }));
  }
  const textual = [dir0, dir1].filter(Boolean).map((dir) => {
    const trains = data.trains.filter((t) => t.direction_id === dir.direction_id);
    const longGaps = data.gaps.filter((g) => g.long && g.direction_id === dir.direction_id);
    const headway = data.scheduled_headway_seconds[dir.direction_id];
    return el(
      "section",
      { class: "card" },
      el("h2", {}, `Towards ${dir.towards}`),
      el("p", { class: "muted" }, `${trains.length} trains in the feed`, headway ? ` · scheduled about every ${minutesText(headway)}` : ""),
      longGaps.length
        ? el("p", {}, el("span", { class: "tag" }, "Detected"), `${longGaps.length} unusually long gap${longGaps.length > 1 ? "s" : ""} between trains (longest ${Math.round(Math.max(...longGaps.map((g) => g.seconds)) / 60)} min).`)
        : el("p", { class: "muted" }, "No unusually long gaps between trains."),
      el("details", {}, el("summary", {}, "Train list"), el("ul", {}, trains.map((t) => el("li", {}, t.at_station ? `At ${t.station}` : `Approaching ${t.station} (${minutesText(t.eta_seconds)})`)))),
    );
  });
  return [
    el("h1", {}, badge(data.line.id, false), " ", data.line.name),
    el("div", { class: "card" }, statusDetails(data.status)),
    staleNotice(data.predictions_as_of, "Train predictions"),
    el("div", { class: "legend" }, el("span", {}, dir0 ? `↓ towards ${dir0.towards}` : ""), el("span", {}, dir1 ? `towards ${dir1.towards} ↑` : "")),
    strip,
    el("p", { class: "muted" }, "Dots are trains, placed between stations from predicted arrival times. Shaded boxes mark gaps between trains well above the scheduled headway."),
    textual,
  ];
}

async function renderStation(key) {
  const data = await api(`/api/stations/${encodeURIComponent(key)}`);
  const station = data.station;
  const bikes = data.bike_share;
  return [
    el("h1", {}, station.name, " ", station.lines.map((l) => [badge(l), " "])),
    data.line_status.map((s) => el("div", { class: "card status-row" }, badge(s.line), el("div", {}, statusDetails(s)))),
    staleNotice(data.predictions_as_of, "Train predictions"),
    el("h2", {}, "Next trains"),
    station.directions.map((d) =>
      el(
        "section",
        { class: "card" },
        el("h3", {}, badge(d.line, false), ` ${d.platform} towards ${d.towards}`),
        d.arrivals.length
          ? el("ul", { class: "arrivals" }, d.arrivals.map((a) => el("li", {}, el("span", {}, timeFmt.format(new Date(a.arrival))), el("span", { class: "mins" }, a.minutes === 0 ? "Due" : `${a.minutes} min`))))
          : el("p", { class: "muted" }, "No predictions right now."),
      ),
    ),
    el("h2", {}, "Alerts at this station"),
    data.alerts.length ? data.alerts.map(alertCard) : el("p", { class: "muted" }, "No alerts for this station, including elevators and escalators."),
    el("h2", {}, "Nearest Bike Share"),
    staleNotice(bikes, "Bike Share availability"),
    bikes.docks.length
      ? bikes.docks.map((d) => el("div", { class: "card" }, el("strong", {}, d.name), el("p", {}, `${d.bikes} bikes · ${d.docks} open docks · ${d.distance_m} m away`, d.renting ? "" : " · not renting")))
      : el("p", { class: "muted" }, "No Bike Share data yet."),
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

async function renderReliability() {
  const data = await api("/api/reliability");
  if (!data.available) {
    return [
      el("h1", {}, "Reliability"),
      el("p", {}, "Reliability analytics have not been built yet. They appear after the first scheduled transformation."),
    ];
  }
  const coverage = data.coverage;
  const sections = [
    el("h1", {}, "Reliability"),
    el(
      "p",
      { class: "muted" },
      `Measured from ${coverage.headways.toLocaleString("en-CA")} gaps between observed train arrivals since ${coverage.first_day}. History starts when collection started. `,
      data.analytics_built_at ? `Analytics updated ${timeFmt.format(new Date(data.analytics_built_at))}` : "",
    ),
    el("h2", {}, "Longest gaps between trains today"),
  ];
  for (const line of lines) {
    const gaps = data.longest_gaps_today.filter((g) => g.route_id === line.id);
    sections.push(
      el(
        "section",
        { class: "card" },
        el("h3", {}, badge(line.id, false), ` ${line.name}`),
        gaps.length
          ? el(
              "ol",
              { class: "gaps" },
              gaps.map((g) =>
                el(
                  "li",
                  {},
                  el("strong", {}, `${(g.gap_seconds / 60).toFixed(1)} min`),
                  " at ",
                  el("a", { href: `#/station/${g.station_key}` }, g.station_name),
                  ` towards ${g.towards}, ${timeFmt.format(new Date(g.gap_start))}–${timeFmt.format(new Date(g.gap_end))}`,
                  g.scheduled_headway_seconds
                    ? el("span", { class: "muted" }, ` · scheduled every ${minutesText(g.scheduled_headway_seconds)}`)
                    : null,
                ),
              ),
            )
          : el("p", { class: "muted" }, "No measurable gaps yet today."),
      ),
    );
  }
  sections.push(
    el("h2", {}, "Headway reliability by hour"),
    el(
      "p",
      { class: "muted" },
      "Share of gaps between trains within 1.5 times the scheduled headway. A long gap exceeds twice the scheduled headway and the headway plus 5 minutes. Terminals are excluded.",
    ),
  );
  for (const line of lines) {
    const hours = data.hourly[line.id] || [];
    sections.push(
      el(
        "section",
        { class: "card" },
        el("h3", {}, badge(line.id, false), ` ${line.name}`),
        hours.length
          ? el(
              "table",
              { class: "hours" },
              el(
                "thead",
                {},
                el(
                  "tr",
                  {},
                  el("th", { scope: "col" }, "Hour"),
                  el("th", { scope: "col" }, "Today"),
                  el("th", { scope: "col" }, "Last 7 days"),
                  el("th", { scope: "col" }, "Long gaps today"),
                ),
              ),
              el(
                "tbody",
                {},
                hours.map((h) =>
                  el(
                    "tr",
                    {},
                    el("th", { scope: "row" }, hourLabel(h.hour)),
                    el("td", {}, meter(h.today_regular_pct)),
                    el("td", {}, meter(h.week_regular_pct)),
                    el("td", {}, h.today_long_gaps === null ? "–" : h.today_long_gaps),
                  ),
                ),
              ),
            )
          : el("p", { class: "muted" }, "No data yet."),
      ),
    );
  }
  const outages = data.outages;
  const resolvedText =
    outages.median_resolved_minutes === null
      ? ""
      : ` (median ${durationText(outages.median_resolved_minutes)}, longest ${durationText(outages.longest_resolved_minutes)})`;
  sections.push(
    el("h2", {}, "Elevator and escalator outages"),
    el("p", {}, `${outages.active.length} out of service now. Resolved in the last 7 days: ${outages.resolved_last_7_days}${resolvedText}.`),
    el(
      "ul",
      { class: "card plain" },
      outages.active.map((o) =>
        el(
          "li",
          {},
          el("a", { href: `#/station/${o.station_key}` }, o.station_name),
          ` · ${o.device_type} · `,
          o.began_before_collection ? `at least ${durationText(o.duration_minutes)}` : durationText(o.duration_minutes),
        ),
      ),
    ),
  );
  return sections;
}

async function route() {
  const [, kind, id] = (location.hash || "#/").split("/");
  try {
    if (!lines.length) {
      lines = (await api("/api/lines")).lines;
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
    main.replaceChildren(...[content].flat(Infinity).filter(Boolean));
    updated.textContent = `Updated ${timeFmt.format(new Date())}`;
  } catch (error) {
    main.replaceChildren(el("h1", {}, "Unavailable"), el("p", {}, error.message === "Not found" ? "That line or station does not exist." : "Live data is unavailable right now. Retrying shortly."));
  }
}

window.addEventListener("hashchange", () => { route(); main.focus(); });
setInterval(() => { if (document.visibilityState === "visible") route(); }, REFRESH_MS);
route();
