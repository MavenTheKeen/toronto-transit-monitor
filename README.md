# Toronto Transit Monitor

Two live data pipelines for Toronto transit, built to measure how reliable service
actually is:

- **TTC subway**: train predictions and service alerts from TTC's GTFS-Realtime feeds,
  polled every 30 seconds and keyed to a versioned copy of the static schedule.
- **Bike Share Toronto**: availability at every dock from the official GBFS API,
  collected every 15 minutes.

Both pipelines land raw responses in PostgreSQL, validate and normalize them in a
separate step that can be replayed from storage, and feed dbt models for reliability
metrics. Two front ends read the results: **Toronto Transit Now**, a public-facing,
mobile-first site (service status, live line diagrams, station arrivals, a subway and
Bike Share map, reliability analytics), and a Streamlit dashboard for Bike Share
operations.

**Status:** runs locally with Docker Compose and has collected real data since
2026-10-09. It is not publicly hosted yet.

| Service status | Line 1 | Map | Reliability | Bike Share dashboard |
| --- | --- | --- | --- | --- |
| ![Service status](docs/screenshots/site-home.png) | ![Line 1 diagram](docs/screenshots/site-line1.png) | ![Subway and Bike Share map](docs/screenshots/site-map.png) | ![Reliability](docs/screenshots/site-reliability.png) | ![Dashboard](docs/screenshots/dashboard.png) |

## Architecture

```mermaid
flowchart LR
    TTCRT[TTC GTFS-Realtime<br/>trips, alerts, accessibility] --> TTCC[TTC collector<br/>every 30 s]
    TTCS[TTC static GTFS] --> TTCC
    GBFS[Bike Share GBFS 3.0] --> BSC[Bike Share collector<br/>every 15 min]
    Airflow[Airflow] --> BSC
    Airflow --> dbt
    Airflow --> TTCS
    TTCC --> Raw[(PostgreSQL raw)]
    BSC --> Raw
    Raw --> Norm[Validated normalization<br/>replayable from raw]
    Norm --> Normalized[(normalized)]
    Normalized --> dbt[dbt staging and analytics<br/>+ tests]
    TTCC --> Ops[(ops: runs, rejected records)]
    BSC --> Ops
    dbt --> Ops
    Normalized --> API[FastAPI read-only API<br/>15 s cache, rate limit]
    dbt --> API
    API --> Site[Toronto Transit Now<br/>HTML/CSS/JS]
    Normalized --> Dash[Streamlit dashboard]
    dbt --> Dash
```

One PostgreSQL service holds `raw`, `normalized`, `staging`, `analytics` and `ops`
schemas, plus a separate Airflow metadata database. Browsers never call TTC or Bike
Share; only the collectors do.

## What the live data required

Real feeds behaved differently from what their specifications suggest. Each of these
is handled in code, tested, and documented:

- **TTC trip IDs are not train identities.** The same train gets a new `trip_id` from
  one poll to the next, so train visits are keyed by vehicle label.
  [Details](docs/ttc.md#train-identity-and-arrivals)
- **Arrivals must be inferred.** The subway feed has predictions but no "arrived" event
  and no vehicle positions; a platform counts as passed only if the train was due
  there when it was last listed. [Details](docs/ttc.md#train-identity-and-arrivals)
- **The TTC feed drops out.** About 1 in 10 trip snapshots on the first day listed no
  trains; those are skipped instead of blanking the site and inventing arrivals.
  [Details](docs/ttc.md#validation)
- **Advance notices look like active closures.** TTC sets their active period to the
  whole notice week, so they are classified separately from current disruptions.
  [Details](docs/ttc.md#alert-status)
- **A successful Bike Share response can hold stale dock readings.** Collection time,
  publication time and each dock's own report time are tracked separately, and stale
  readings make no availability claim. [Details](docs/metrics.md#time-and-freshness)

## Quick start

Prerequisites: Docker Engine with Compose v2 (on Windows, Docker Desktop with the WSL2
backend; see [Windows setup](docs/setup-windows.md)) and roughly 6–8 GB of RAM for the
full stack. Run at the repository root; replace the example password in `.env` with a
URL-safe value (`.env` is ignored by Git).

```powershell
Copy-Item .env.example .env
docker compose --profile tools build
docker compose up -d --wait postgres
docker compose run --rm init-db
docker compose up -d ttc-collector web
docker compose run --rm collector collect
docker compose run --rm dbt
docker compose up -d dashboard
```

- **Toronto Transit Now**: <http://localhost:8000>
- **Bike Share dashboard**: <http://localhost:8501>

The TTC collector loads the static schedule on first start, then polls every 30
seconds. Reliability analytics appear after a dbt build that includes observed arrivals.

To schedule Bike Share collection, dbt builds and the daily schedule refresh:

```powershell
docker compose --profile airflow build airflow
docker compose --profile airflow up -d airflow
docker compose exec airflow airflow dags unpause toronto_bikeshare_reliability
docker compose exec airflow airflow dags unpause ttc_static_gtfs
```

Airflow's UI is at <http://localhost:8080>; it is a local development instance and all
ports bind to localhost. See [Airflow operation](docs/airflow.md).

Stop everything without deleting collected history:

```powershell
docker compose --profile airflow down
```

Do not add `--volumes` unless you intend to delete the collected history.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/transit/ttc/` | TTC GTFS-Realtime and static GTFS collection, validation, storage, retention |
| `src/transit/bikeshare/` | Bike Share GBFS collection, validation, storage, dashboard queries |
| `src/transit/web/` | FastAPI app and the static site (plain HTML/CSS/JS, no build step) |
| `src/transit/` | Shared CLI (`transit`), database setup, HTTP client, locks, dbt runner |
| `dbt/` | Staging and analytics models and tests for both pipelines |
| `airflow/` | DAGs for Bike Share collection + dbt, and the daily schedule refresh |
| `dashboard/` | Streamlit Bike Share dashboard |
| `tests/` | Unit and PostgreSQL integration tests, real-data fixtures |

## Tests

Ordinary tests use recorded real responses and controlled mutations, never a live API.
Integration tests **clear project tables** in a database whose name must end in
`_test`; they never touch the live `transit` database.

With Python 3.12, uv 0.9.5 and Compose PostgreSQL running:

```powershell
uv sync --locked
uv sync --project dbt --locked
docker compose exec postgres createdb -U transit transit_test
$env:TEST_DATABASE_URL='postgresql://transit:YOUR_ENV_PASSWORD@127.0.0.1:5432/transit_test'
$env:DBT_EXECUTABLE="$PWD/dbt/.venv/Scripts/dbt.exe"
uv run --locked pytest -q
uv run --locked ruff check src tests dashboard scripts airflow
```

Use `127.0.0.1`, not `localhost`: Compose publishes PostgreSQL on IPv4 loopback only,
and on Windows `localhost` tries IPv6 first, which makes every connection stall. Create
the test database only once. On Linux/macOS use `export NAME=value` and
`DBT_EXECUTABLE="$PWD/dbt/.venv/bin/dbt"`. Without `TEST_DATABASE_URL`, PostgreSQL
tests skip; without `DBT_EXECUTABLE`, the dbt builds skip. Offline only:
`uv run --locked pytest -m 'not integration' -q`.

GitHub Actions runs the PostgreSQL and dbt suite, an Airflow DAG import test in the
Airflow image, and container startup checks. No check depends on a live feed.

Native commands use `DATABASE_URL` (the app does not auto-load `.env`):

```powershell
$env:DATABASE_URL='postgresql://transit:YOUR_ENV_PASSWORD@127.0.0.1:5432/transit'
uv run --locked transit --help
uv run --locked transit init-db
uv run --locked transit collect
uv run --locked transit ttc-collect --once
uv run --locked transit transform --dbt-executable "$PWD/dbt/.venv/Scripts/dbt.exe"
uv run --locked uvicorn transit.web.app:app --host 127.0.0.1 --port 8000
```

## Documentation

- [TTC subway collection](docs/ttc.md): sources, data model, validation rules, feed quirks
- [Bike Share collection and dashboard](docs/bikeshare.md): retry/replay, metric caveats
- [Public site and API](docs/site.md): endpoints, how positions and gaps are derived, map
- [Reliability analytics](docs/reliability.md): headways, detected delays, outages
- [Metric definitions](docs/metrics.md) and [engineering decisions](docs/decisions.md)
- [Deployment](docs/deploy.md): single-server production setup with HTTPS and backups
- [Airflow operation](docs/airflow.md), [Windows setup](docs/setup-windows.md),
  [demo walkthrough](docs/demo.md), [source verification](docs/source.md)

## Data sources and attribution

- Data: Toronto Transit Commission (GTFS and GTFS-Realtime open data). Predictions may be
  inaccurate. This project is not affiliated with the TTC.
- [Bike Share Toronto](https://bikesharetoronto.com/) / Toronto Parking Authority.
  Contains information licensed under the
  [Open Government Licence – Toronto](https://www.toronto.ca/city-government/data-research-maps/open-data/open-data-licence/).

## Troubleshooting

- **Docker unavailable:** complete Windows setup, start Docker Desktop, confirm Linux
  containers and `docker info`. A Compose CLI alone is not an engine.
- **Database unavailable:** `docker compose ps` and `docker compose logs postgres`.
  Changing `.env` does not change an existing PostgreSQL volume's password.
- **No trains on the site:** `docker compose logs --tail 20 ttc-collector`; `/health`
  reports `degraded` when predictions are more than 2 minutes old.
- **Port collision:** edit `POSTGRES_PORT`, `WEB_PORT`, `DASHBOARD_PORT` or
  `AIRFLOW_PORT` in `.env`; internal Compose ports stay unchanged.
- **Unhealthy Airflow:** inspect logs, then `docker compose restart airflow`.

Pipeline-specific troubleshooting is in [TTC](docs/ttc.md) and
[Bike Share](docs/bikeshare.md).
