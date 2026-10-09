# Public site and API

`web` serves a read-only JSON API and a single mobile-first page. It reads only from
PostgreSQL; browsers never call the TTC or Bike Share APIs.

```powershell
docker compose up -d web
```

Open <http://localhost:8000>. Pages use hash routes: `#/` (service status), `#/line/1`
(line view), `#/station/bloor-yonge` (station).

| Home | Line | Station |
| --- | --- | --- |
| ![Service status](screenshots/site-home.png) | ![Line 1 diagram](screenshots/site-line1.png) | ![Bloor-Yonge](screenshots/site-station.png) |

Screenshots were captured from real data on 2026-10-09 at about 10:25 Toronto time.

## Endpoints

| Path | Returns |
| --- | --- |
| `/api/status` | One status row per line: `normal`, `delays`, `reduced_service`, `modified_service`, `no_service`, or `unknown` when alerts are stale. `source` is `reported` (from TTC alerts). |
| `/api/alerts` | Active service alerts, upcoming planned closures and advance notices, and active elevator/escalator outages. |
| `/api/lines` | Lines with colours, directions and status, plus every station for search. |
| `/api/lines/{id}` | Stations in order, estimated train positions, gaps between consecutive trains, and the scheduled headway now. |
| `/api/stations/{key}` | Next arrivals per platform, alerts naming the station's platforms, line status, and the nearest Bike Share docks. |
| `/health` | `ok`, `degraded` (predictions older than 2 minutes), `no_data` (no schedule loaded), or HTTP 503 if PostgreSQL is unreachable. |

Every response includes `generated_at` and the attribution. Freshness objects
(`as_of`, `stale`) accompany predictions, alerts and Bike Share data.

## How positions, gaps and status are derived

- **Train position.** The subway feed has no vehicle positions. TTC often predicts a
  train's first listed platform at the current time even while it is between stations,
  so the next platform is the first predicted more than 20 seconds ahead. If that
  arrival is further away than the scheduled run from the previous platform, the train
  has not left the previous platform; otherwise it is placed between the two in
  proportion to the remaining time. Scheduled run times are medians from static GTFS.
- **Gaps.** Consecutive moving trains in a direction are separated by the scheduled
  running time between their positions. A gap is marked long when it exceeds both twice
  the scheduled headway and the headway plus 5 minutes. The headway counts trips in the
  next/previous 30 minutes at a mid-line platform on today's service calendar. Trains
  waiting at their first platform are excluded.
- **Status.** The most severe active TTC service alert on the line. Advance notices
  ("There will be no subway service ... nightly") are listed under planned closures and
  do not change today's status, because TTC sets their active period to the whole notice
  window rather than the closure hours.

## Protection

- Responses are cached in memory for 15 seconds, so PostgreSQL load does not grow with
  visitors. Schedule-derived data is cached until a new static GTFS version loads.
- `/api/` allows `WEB_RATE_LIMIT_PER_MINUTE` (default 120) requests per client address
  per sliding minute, then returns 429 with `Retry-After`.
- A strict Content Security Policy allows only same-origin scripts, styles and requests.
  The page has no cookies, analytics or third-party resources, and renders API text with
  `textContent` only.

## Accessibility

Semantic headings and lists, a skip link, visible focus, text equivalents for the line
diagram (train lists and gap summaries), status text that never relies on colour alone,
light and dark themes, and reduced motion respected.
