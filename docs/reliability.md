# Subway reliability analytics

dbt models turn observed train arrivals into headway and outage metrics. They run in the
same `dbt build` as the Bike Share models (every 15 minutes from Airflow locally), and
the public site's Reliability page and `/api/reliability` read them.

Reliability numbers describe this project's observations, which start when collection
started. They are estimates from predicted arrival times, not official TTC statistics.

## Models

| Model | Type | Contents |
| --- | --- | --- |
| `staging.stg_ttc_platforms` | view | Platforms of the newest static GTFS version, with line order and a terminal flag. |
| `staging.stg_ttc_arrivals` | view | Train visits marked passed, with station and service hour (hours since local midnight of the service day; can exceed 23 after midnight, like GTFS). |
| `staging.stg_ttc_collection_gaps` | view | Periods over 2 minutes without a new trip-update snapshot. |
| `analytics.ttc_headways` | incremental | Time since the previous train at the same platform and service day, with `implausible` (under 60 s) and `spans_collection_gap` flags. Keeps history after train visits expire; each run rebuilds the last two service days. |
| `analytics.ttc_scheduled_service` | incremental | Scheduled trains per platform and service hour on each observed day, using the static GTFS version whose calendar covers that day. |
| `analytics.ttc_headway_reliability_hourly` | table | Observed versus scheduled headways per line, direction, day and hour. |
| `analytics.ttc_longest_gaps` | table | Ten longest gaps per line and day. |
| `analytics.ttc_elevator_outages` | view | Elevator/escalator outages with durations. |

## Definitions

- **Measurable headway**: not at a terminal, not implausibly short, and not spanning a
  collection gap. Only these count in reliability metrics.
- **Regular headway**: at most 1.5 times the scheduled headway for that platform and hour.
- **Long gap**: more than twice the scheduled headway and more than the scheduled headway
  plus 5 minutes. The live site uses the same rule.
- **Longest gaps** are counted once per pair of consecutive trains. A held train shows the
  same gap at every platform downstream; the incident is reported at the platform where
  it was longest.
- **Outage duration** runs from when this project first saw the alert to when it left
  the feed (or now, if still active). Outages already present when collection began are
  flagged `began_before_collection`; their durations are lower bounds.

## Detected delays (live)

`/api/status` adds a **detected** status, labelled "Possible delay, not confirmed by TTC",
only when TTC reports nothing for the line. A line is flagged when at least two adjacent
non-terminal platforms in one direction have had no train for longer than the long-gap
threshold, no train is due within a minute, predictions are fresh, and there was no
collection gap since the last train. The message names the platform with the longest
wait, e.g. "No southbound train at Bloor-Yonge in 11 min".

## Tests

Structural tests (unique keys, not null, accepted values, relationships) and model
invariants (non-negative headways, consistent counts and percentiles) fail the build.
`ttc_implausible_headway_share` is a warning: it signals a change in TTC's feed without
failing the shared Bike Share build. `tests/test_ttc_dbt_integration.py` runs the real
dbt project on controlled arrivals, including a second incremental run.
