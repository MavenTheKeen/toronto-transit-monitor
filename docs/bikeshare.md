# Bike Share collection and dashboard

The Bike Share pipeline collects real Toronto Bike Share availability from the official
GBFS 3.0 API every 15 minutes, keeps the source JSON in PostgreSQL, and shows current
availability, observed empty/full rates, hourly patterns and pipeline health in a
Streamlit dashboard. The public site's station pages and map read the same data.

**History starts when collection starts.** This is a sampled monitor, not a trip
counter or an archive of past station availability. Fixtures are never served as live
data. Source: [Bike Share Toronto](https://bikesharetoronto.com/) / Toronto Parking
Authority. Contains information licensed under the
[Open Government Licence – Toronto](https://www.toronto.ca/city-government/data-research-maps/open-data/open-data-licence/).
See [source verification and licensing nuances](source.md).

![Dashboard showing a real collection on 2026-10-09](screenshots/dashboard.png)

## Data flow

1. **Raw**: each GBFS response (discovery, station information, station status) is
   stored as received in `raw.feed_payloads` with its hash, before any parsing.
2. **Validate and normalize**: in a separate transaction, payloads are parsed and
   validated into `normalized.station_snapshots` and `normalized.observations`. A
   malformed or empty feed fails the collection rather than storing an empty dataset.
3. **Transform**: dbt builds staging and analytics views (hourly station metrics,
   empty/full rates) with tests; results are recorded in `ops.transformation_runs`.
4. **Ops**: every attempt is a row in `ops.ingestion_runs` / `ops.ingestion_attempts`,
   and data-quality checks are recorded alongside.

## Collect, retry and replay

With the stack from the [quick start](../README.md#quick-start) running:

```powershell
docker compose run --rm collector collect --collection-id first-local-collection
docker compose run --rm dbt
docker compose up -d dashboard
```

Open **<http://localhost:8501>**. The dashboard never fetches the live API itself;
Refresh reads committed database data. If no collection exists, it shows an empty
state. It marks stale data explicitly and excludes it from current availability.

Check retry and replay using the same collection ID:

```powershell
docker compose run --rm collector collect --collection-id first-local-collection
docker compose run --rm collector replay --collection-id first-local-collection
docker compose run --rm dbt
```

The retry returns `already_succeeded`; replay reconstructs that collection from stored
JSON without HTTP. A genuinely later collection should use a new ID:

```powershell
docker compose run --rm collector collect
```

The generated UUID is printed. Identical later counts are kept as a new observation.
The source publication time, station report time, and collection time are separate
columns. Dashboard timestamps use America/Toronto.

An explicit live API parse check (no database writes):

```powershell
docker compose run --rm collector smoke
```

Scheduled collection runs through Airflow; see [Airflow operation](airflow.md).

## Metrics and limitations

- Empty percentage uses rental-eligible observed snapshots; full percentage uses
  return-eligible snapshots. Missing, stale, inactive, or disabled service readings
  are excluded. Zero denominator means unknown, not 0%.
- Rankings show their denominators. Station observation coverage compares status rows
  with metadata rows; system collection coverage counts occupied complete UTC 15-minute
  slots across the selected period, including time before collection began.
- Available bikes plus available docks need not equal capacity. Optional disabled
  counts and capacity remain unknown when omitted.
- These percentages describe samples, not exact minutes, trip counts, or guaranteed
  availability on arrival. A handful of snapshots is insufficient for strong rankings.
- Views favor clarity over long-history performance. There is no automatic retention
  for Bike Share data.

Read [metric definitions](metrics.md) and the [demo walkthrough](demo.md).

## Troubleshooting

- **No analytics yet:** run `docker compose run --rm dbt`; inspect the recorded build
  result in Pipeline health. After schema changes, rerun `init-db`.
- **Collection failed:** inspect `ops.ingestion_attempts` and Airflow/collector logs.
  Stored raw data can be replayed after a parser fix.
- **Stale data:** confirm collection is running and inspect all three clocks. A
  successful API request can still contain stale station reports.
