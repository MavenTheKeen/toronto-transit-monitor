# TTC subway collection

The `ttc-collector` service polls TTC's public GTFS-Realtime feeds every 30 seconds and
stores subway train predictions and service alerts in PostgreSQL. Static GTFS (stops,
routes, trips, stop times) maps platform IDs to stations and line order.

Data: Toronto Transit Commission. Predictions may be inaccurate.

## Sources

| Feed | URL | Use |
| --- | --- | --- |
| Subway trip updates | `https://gtfsrt.ttc.ca/trips/subway?format=binary` | Predicted arrivals for the next few platforms per train |
| Subway alerts | `https://gtfsrt.ttc.ca/alerts/subway?format=binary` | Delays, closures, planned track work |
| Accessibility alerts | `https://gtfsrt.ttc.ca/alerts/accessibility?format=binary` | Elevator and escalator outages |
| Static GTFS | Toronto Open Data, "TTC Routes and Schedules" (ZIP) | Platforms, line order, scheduled trips |

The realtime feeds need no API key and publish no rate limits or terms of use. One
backend process polls them; browsers never call TTC directly. Only subway routes
(GTFS `route_type` 1: Lines 1, 2 and 4) are loaded. Lines 5 and 6 are light rail and
are not in the subway realtime feed.

## Data flow

1. **Raw**: each response is stored as received in `raw.ttc_realtime_snapshots`
   (protobuf bytes, SHA-256, fetch time). The feed's header timestamp is unique per
   feed, so polling the same publication twice stores it once.
2. **Validate and normalize**: in a separate transaction, the snapshot is decoded,
   validated against the active static GTFS version, and written to normalized tables.
   `transit ttc-replay` rebuilds normalized rows from stored raw snapshots without
   any HTTP request.
3. **Ops**: every poll is a row in `ops.ttc_poll_runs`; every rejected or flagged record
   is a row in `ops.ttc_record_issues`; static refreshes are in `ops.ttc_static_refreshes`.

| Table | Contents |
| --- | --- |
| `normalized.ttc_gtfs_versions` and `ttc_routes`, `ttc_stops`, `ttc_line_stops`, `ttc_trips`, `ttc_stop_times`, `ttc_calendar*` | Static GTFS keyed by `feed_version` (the zip's SHA-256). A new schedule is a new version; older versions stay for historical joins. |
| `normalized.ttc_current_predictions` | Predictions from the newest trip snapshot only. |
| `normalized.ttc_train_stop_events` | One row per train visit to a platform: latest predicted arrival, first/last seen, and `passed_at`. |
| `normalized.ttc_alerts`, `ttc_alert_versions` | Every distinct version of every alert, with first and last seen times. |

## Train identity and arrivals

The subway feed has no vehicle positions, only predicted arrival times for the next few
platforms of each train. Two findings from the live feed shape the model:

- **`trip_id` is not a stable train identity.** The same train usually gets a different
  `trip_id` on consecutive polls. The vehicle label is stable and unique per snapshot,
  so visits are keyed by train (vehicle label), with the latest `trip_id` kept for
  reference. A prediction for the same train and platform within 10 minutes of an
  existing visit updates that visit; a train passes a given platform at most once per
  round trip.
- **Arrival is inferred.** A visit is marked `passed_at` at the first snapshot that no
  longer lists that platform, provided the train was due there within 2 minutes when
  last listed (and was listed in the last 10 minutes). Its last `predicted_arrival` is
  the best available estimate of when the train was there. This holds whether or not
  the train is still in the feed: trains leave the feed at terminals and when their
  label changes. A platform dropped well before its predicted time is a withdrawn
  prediction (short turn, reroute), not an arrival. If the platform is listed again
  later, the mark is withdrawn.
- **The feed sometimes drops out.** About 1 in 10 trip snapshots on the first day of
  collection listed no trains at all (once, about half), between two complete ones.
  Accepting them would blank the live site and mark every train due within 2 minutes as
  arrived. Such a snapshot is skipped: its raw payload is kept and a `feed_dropout` issue
  is logged, but visits and current predictions are left alone. If the feed stays empty,
  no train was seen in the last 2 minutes, so the empty snapshot is accepted; the end of
  service and a real shutdown still show up within about 2 minutes.

Terminal platforms need care in analysis: trains dwell and change ends there, and the
vehicle label can change when they do. Near Wilson Yard, where trains enter and leave
service, one train is occasionally reported under two labels for a few minutes, which
shows up as two arrivals under a minute apart; these are flagged `implausible` and
excluded from reliability metrics.

## Validation

| Check | Action |
| --- | --- |
| Header missing version or timestamp, non-`FULL_DATASET`, undecodable protobuf | Snapshot fails; poll recorded as failed |
| Feed timestamp more than 5 minutes from fetch time | Flagged |
| Trip snapshot lists fewer than half the trains seen in the previous 2 minutes | Snapshot skipped (`feed_dropout`); raw kept |
| Missing or duplicate `trip_id`; duplicate vehicle in one snapshot | Rejected |
| Missing vehicle label | Flagged; the trip ID is used as the train ID |
| Platform not in static GTFS, or belonging to another line | Rejected |
| No arrival/departure time; time 30+ minutes past or 3+ hours ahead of the feed | Rejected |
| Platforms from both directions in one trip | Minority direction rejected |
| Same platform twice in one trip | Duplicate rejected |
| `stop_sequence` out of order; feed order differs from line order | Flagged; rows re-sorted into line order |
| Identical arrival time at consecutive platforms; decreasing times | Flagged |
| Alert with no English text, or duplicate alert ID | Rejected |
| Alert `effect` contradicts its text | Flagged (`alert_effect_text_mismatch`) |

## Alert status

Alerts have no severity field, and `effect` can contradict the text. For example, one
planned closure had effect `REDUCED_SERVICE` while its text said there was no subway
service. Each alert version gets:

- `effect_status` from the GTFS-Realtime effect,
- `text_status` from keywords in the text (no service, reduced service, delays,
  elevator/escalator),
- `derived_status`, the more severe of the two, in the order `no_service`,
  `reduced_service`, `delays`, `modified_service`, `accessibility`, `other`.

Accessibility alerts list platforms only; their lines are derived from static GTFS.
Alerts whose active period starts in the future are planned disruptions.

`advance_notice` marks notices of planned work worded in the future tense ("There will
be no subway service ... nightly ..."). TTC gives these an active period covering the
whole notice week, not the closure hours, so they must not be read as a current
disruption. Derived fields are recomputed on replay, so rule changes apply to history.

## Retention

Hourly, the collector deletes raw snapshots older than `TTC_RAW_RETENTION_DAYS`
(default 3), train visits older than `TTC_EVENT_RETENTION_DAYS` (default 90), and poll
runs older than 30 days. The snapshot each feed currently points at is never deleted.
Alerts and static GTFS versions are kept.

## Commands

```powershell
docker compose up -d ttc-collector              # polls every 30 s; loads static GTFS first if absent
docker compose run --rm ttc-collector ttc-gtfs-refresh   # load a new static version if changed
docker compose run --rm ttc-collector ttc-replay --pending
docker compose run --rm ttc-collector ttc-replay --snapshot-id 123
docker compose run --rm ttc-collector ttc-retention
docker compose run --rm --no-deps ttc-collector ttc-smoke   # live parse check, no writes
```

The `ttc_static_gtfs` Airflow DAG runs `ttc-gtfs-refresh` daily at 09:00 UTC once
unpaused. Only one collector can run per database (PostgreSQL advisory lock). The
container health check (`transit ttc-health`) fails unless every feed had a
successful poll in the last 2 minutes.
