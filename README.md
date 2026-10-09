# Toronto Bike Share Reliability Monitor

A small data engineering project that collects real Toronto Bike Share availability,
keeps the source JSON in PostgreSQL, and shows current availability, observed
empty/full rates, hourly patterns, and pipeline health in Streamlit.

**History starts when collection starts.** This is a sampled monitor, not a trip
counter or an archive of past station availability. Fixtures are never served as
live data. Source: [Bike Share Toronto](https://bikesharetoronto.com/) / Toronto
Parking Authority. Contains information licensed under the
[Open Government Licence – Toronto](https://www.toronto.ca/city-government/data-research-maps/open-data/open-data-licence/).
See [source verification and licensing nuances](docs/source.md).

![Dashboard showing a real collection on 2026-10-09](docs/screenshots/dashboard.png)

## Architecture

```mermaid
flowchart LR
    GBFS[Official GBFS 3.0 API] --> CLI[Python collector CLI]
    Airflow[Airflow: every 15 minutes] --> CLI
    CLI --> Raw[(PostgreSQL raw JSONB)]
    Raw --> Normalize[Validated Python normalization / replay]
    Normalize --> Normalized[(Station snapshots and observations)]
    Normalized --> dbt[dbt staging and analytics views + tests]
    Airflow --> dbt
    CLI --> Ops[(Run history and quality checks)]
    dbt --> Ops
    Normalized --> UI[Streamlit dashboard]
    dbt --> UI
    Ops --> UI
```

One PostgreSQL service stores `raw`, `normalized`, `staging`, `analytics`, and `ops`
schemas. Airflow has a separate metadata database in the same service. Its local
executor needs no message broker or workers. App, dbt, and Airflow dependencies are
isolated. App/dbt transitive versions and hashes are in their `uv.lock` files;
container base images use explicit versions and verified registry digests.

## Prerequisites

- Docker Engine with Docker Compose v2; Docker Desktop using Linux containers on
  Windows. Allow roughly 6–8 GB RAM for the complete local stack.
- Internet access for the initial builds and the public GBFS API.
- Git. Python on the host is optional for Compose, or Python 3.12 and uv 0.9.5 for
  native development/testing.

For Windows installation instructions, follow
[Windows setup](docs/setup-windows.md): install WSL2, restart if prompted, install
Docker Desktop, enable its WSL2 backend, and wait until the engine is running.
Verify before continuing:

```powershell
docker --version
docker compose version
docker info
```

## Start from a clean checkout

Run at the repository root. Copy the example only once and replace its local
password with a URL-safe value; `.env` is ignored by Git. The shell equivalent
on Linux/macOS is `cp .env.example .env`.

```powershell
Copy-Item .env.example .env
docker compose --profile tools build
docker compose up -d --wait postgres
docker compose run --rm init-db
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

The retry returns `already_succeeded`; replay reconstructs that collection from
stored JSON without HTTP. A genuinely later collection should use a new ID:

```powershell
docker compose run --rm collector collect
```

The generated UUID is printed. Identical later counts are kept as a new observation.
The source publication time, station report time, and collection time are separate
columns. Dashboard timestamps use America/Toronto.

## Enable scheduling

```powershell
docker compose --profile airflow build airflow
docker compose --profile airflow up -d airflow
docker compose --profile airflow logs --tail 80 airflow
docker compose exec airflow airflow dags list-import-errors
docker compose exec airflow airflow dags unpause toronto_bikeshare_reliability
```

Open **<http://localhost:8080>**. Wait for Airflow to finish initializing before the
last two commands. The DAG starts paused, then runs `collect -> replay -> transform`
on a 15-minute schedule after unpausing. Catch-up is disabled. CLI ingestion also
normalizes, so the scheduled replay is an intentional idempotency/recovery boundary.
See [Airflow operation and retry details](docs/airflow.md).

The Airflow UI allows local visitors to administer this development instance;
ports bind to localhost. This configuration is not a public deployment.

Stop services without deleting collected history:

```powershell
docker compose --profile airflow down
```

Do not add `--volumes` unless you intend to delete the collected database history.

## TTC subway collection

A second always-on service collects TTC subway predictions and service alerts from
TTC's public GTFS-Realtime feeds every 30 seconds, keyed to a versioned copy of TTC's
static GTFS. It keeps the same raw -> validated -> normalized pattern, logs every
rejected or flagged record to `ops`, and applies a retention policy.

```powershell
docker compose up -d ttc-collector
docker compose logs --tail 20 ttc-collector
```

See [TTC subway collection](docs/ttc.md) for sources, data model, validation rules,
and the source quirks found in the live feed. Data: Toronto Transit Commission.

## Public subway site

A FastAPI service exposes read-only JSON endpoints and a mobile-first page: service
status per line (reported by TTC, plus our own clearly labelled detected delays), active alerts and planned closures, a line diagram with estimated
train positions and unusually long gaps, and station pages with next arrivals,
elevator/escalator outages and the nearest Bike Share dock, and a map of the subway
with every Bike Share dock coloured by bikes or open docks available.

```powershell
docker compose up -d web
```

Open **<http://localhost:8000>**. See [public site and API](docs/site.md). A Reliability
page shows the longest gaps between trains, headway reliability by hour, and
elevator/escalator outage durations from dbt models; see
[reliability analytics](docs/reliability.md).

## Tests and native development

Ordinary tests use two documented real station extracts and controlled mutations,
never a live API. The integration tests **clear project tables** in a database
whose name must end in `_test`. They do not touch the live `bikeshare` database.

With Python/uv installed, and Compose PostgreSQL running:

```powershell
uv sync --locked
uv sync --project dbt --locked
docker compose exec postgres createdb -U transit transit_test
$env:TEST_DATABASE_URL='postgresql://transit:YOUR_ENV_PASSWORD@127.0.0.1:5432/transit_test'
$env:DBT_EXECUTABLE="$PWD/dbt/.venv/Scripts/dbt.exe"
uv run --locked pytest -q
uv run --locked ruff check src tests dashboard scripts airflow
```

Use `127.0.0.1`, not `localhost`: Compose publishes PostgreSQL on IPv4 loopback
only, and on Windows `localhost` tries IPv6 first, which makes every connection
stall. Create the test database only once. On Linux/macOS use `export NAME=value` and
`DBT_EXECUTABLE="$PWD/dbt/.venv/bin/dbt"`. Without `TEST_DATABASE_URL`, PostgreSQL
tests skip; without `DBT_EXECUTABLE`, the dbt integration build skips. For offline
unit/UI tests explicitly: `uv run --locked pytest -m 'not integration' -q`.

The PostgreSQL suite verifies duplicate prevention, identical later observations,
concurrency exclusion, rollback/replay, cross-run Retry-After, missing observations,
DST period boundaries, and dbt empty/full denominators including zero eligibility.
`transit transform` records dbt results in `ops.transformation_runs`.

An explicit live API parse check (no database writes):

```powershell
docker compose run --rm collector smoke
```

Native application commands use `DATABASE_URL` (the app does not auto-load `.env`):

```powershell
$env:DATABASE_URL='postgresql://transit:YOUR_ENV_PASSWORD@127.0.0.1:5432/transit'
uv run --locked transit init-db
uv run --locked transit collect
uv run --locked transit transform --dbt-executable "$PWD/dbt/.venv/Scripts/dbt.exe"
uv run --locked streamlit run dashboard/app.py --server.address=127.0.0.1 --browser.gatherUsageStats=false
```

For a browser smoke check of a running dashboard containing real data:

```powershell
uv sync --locked --group browser
uv run --group browser playwright install chromium
uv run --group browser python scripts/browser_check.py
```

GitHub Actions defines PostgreSQL/dbt tests, a separate Linux Airflow DAG import
test, and container startup checks. The DAG stays paused in CI; no ordinary check
depends on the live feed.

## Metrics and limitations

- Empty percentage uses rental-eligible observed snapshots; full percentage uses
  return-eligible snapshots. Missing, stale, inactive, or disabled service readings
  are excluded. Zero denominator means unknown, not 0%.
- Rankings show their denominators. Station observation coverage compares status
  rows with metadata rows; system collection coverage counts occupied complete UTC
  15-minute slots across the selected period, including time before collection began.
- Available bikes plus available docks need not equal capacity. Optional disabled
  counts and capacity remain unknown when omitted.
- These percentages describe samples, not exact minutes, trip counts, or guaranteed
  availability on arrival. A handful of snapshots is insufficient for strong rankings.
- Views favor clarity over long-history performance. There is no automatic retention,
  backup, public deployment, or external alerting service.

Read [metric definitions](docs/metrics.md), [decisions](docs/decisions.md),
and the [demo walkthrough](docs/demo.md).

## Troubleshooting

- **Docker unavailable:** complete Windows setup, start Docker Desktop, confirm
  Linux containers and `docker info`. A Compose CLI alone is not an engine.
- **Database unavailable:** `docker compose ps` and `docker compose logs postgres`.
  Changing `.env` does not change an existing PostgreSQL volume's password; use
  the original password or deliberately alter it in PostgreSQL.
- **No analytics yet:** run `docker compose run --rm dbt`; inspect the recorded
  build result in Pipeline health. After schema changes, rerun `init-db`.
- **Collection failed:** inspect `ops.ingestion_attempts` and Airflow/collector logs.
  Stored raw data can be replayed after a parser fix. A malformed or empty feed is
  a failure, not a successful empty dataset.
- **Stale data:** confirm collection is running and inspect all three clocks. A
  successful API request can still contain stale station reports.
- **Port collision:** edit `POSTGRES_PORT`, `DASHBOARD_PORT`, or `AIRFLOW_PORT` in
  `.env`; internal Compose ports stay unchanged.
- **Unhealthy Airflow:** inspect logs then `docker compose restart airflow`.
  Standalone does not supervise crashed child components for production recovery.
