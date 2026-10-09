# Demo walkthrough

Allow about five minutes to explain an already running project. Collect actual
observations over several hours beforehand for a useful history. One live
collection is enough to demonstrate current availability, but it does not justify
claims about recurring station reliability.

## Prepare the local project

Install the prerequisites in the root README or [Windows setup](setup-windows.md).
The commands below are the intended Compose workflow. Container execution and
Airflow scheduling were still unverified on the original Windows environment;
Docker and WSL were absent. Read the latest README verification status before
describing those parts as demonstrated.

From the repository root, copy `.env.example` to `.env` once and replace its
example password. Preserve an existing `.env`. In PowerShell:

```powershell
Copy-Item .env.example .env
notepad .env
docker compose config --quiet
docker compose build
docker compose up -d postgres
docker compose run --rm init-db
docker compose run --rm collector collect --collection-id demo-first
docker compose run --rm dbt
docker compose up -d dashboard
```

Open <http://localhost:8501>. Record the collection result and its ID. The default
dbt service command uses the tracked transformation wrapper, so build/test results
appear in pipeline health. A direct `dbt build` is useful for development but does
not itself record a transformation-run row.

## Show the product

1. **Current availability:** explain the source and actual collection time. Search
   for a station, inspect its map location, and compare available bikes and docks
   with rental/return state. Show publication and station-report timestamps.
2. **History:** select that station's history. Say explicitly when collection
   began. Missing/stale observations are not zero counts, and observations do not
   establish trips or exact duration between samples.
3. **Rankings:** choose a period and minimum eligible-snapshot threshold. Compare
   empty and full percentages with their different eligible denominators. A newly
   started database may correctly have no stations meeting the default threshold.
4. **Coverage and health:** distinguish station report completeness from occupied
   15-minute collection slots. A seven-day view started today should show low slot
   coverage. Show ingestion quality results and the latest dbt build result.
5. **Architecture:** open the README diagram, then the staging SQL. Follow one
   collection/station key through normalized records to its raw payload ID.

## Demonstrate retry safety and replay

Repeat the **same** ID:

```powershell
docker compose run --rm collector collect --collection-id demo-first
```

The collector should return `already_succeeded`. It reuses the successful
collection without refetching or adding observations. Inspect the database:

```powershell
docker compose exec postgres psql -U bikeshare -d bikeshare -c "SELECT collection_id, count(*) FROM normalized.observations GROUP BY collection_id ORDER BY collection_id;"
```

Replay preserves the collection identity and uses stored source JSON:

```powershell
docker compose run --rm collector replay --collection-id demo-first
docker compose run --rm dbt
```

Run the count query again. The original collection's count should be unchanged.
Explain that raw data commits before normalization, so a fixed transformation can
be rerun without requesting a different live snapshot.

For a genuinely later sample, wait approximately 15 minutes, then use a new ID or
let the CLI generate one:

```powershell
docker compose run --rm collector collect
docker compose run --rm dbt
```

An unchanged bike count is still a valid later observation. Do not edit timestamps,
relabel fixtures, or repeatedly poll to manufacture a long-looking history.

## Scheduling and verification

Use the README's Airflow startup commands and open <http://localhost:8080> after
the scheduler is running. Confirm the collection-to-transformation dependency,
15-minute schedule, disabled catch-up, retries, and actual task logs. Scheduled
runtime execution must be verified separately from having a DAG file in Git.

At the Stage 2 checkpoint on 2026-10-09, native PostgreSQL ingestion stored 1,075
real station observations, repeat/replay checks succeeded, dbt built three views
and passed 45 data tests, and the project run passed 142 pytest tests. These are
verification measurements, not a claimed operating scale or uptime guarantee.
Run the current README test commands before a presentation; do not imply CI or
containers passed unless their actual runs are available to inspect.

Chromium later rendered the real dashboard, map tiles, station search, and ranking
tabs. The saved [dashboard](screenshots/dashboard.png) and
[rankings](screenshots/dashboard-analytics.png) screenshots show actual recorded
data and collection times. Empty/stale/error states also have Streamlit AppTest
coverage. Review layout at your presentation screen size and capture a fresh
collection before demonstrating; these screenshots are dated evidence, not live data.

To stop local services while retaining collected history:

```powershell
docker compose --profile airflow down
```

Do not add `--volumes` during ordinary shutdown: that removes the database volume
and its collected history.
