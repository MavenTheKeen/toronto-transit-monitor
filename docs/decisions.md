# Engineering decisions

- **One system, GBFS 3.0.** Discover station endpoints from the live discovery
  document. Reject unsupported versions explicitly. No second source or migration
  heuristics. Unknown JSON fields survive in raw storage.
- **PostgreSQL at every data layer.** JSONB source records in `raw`, Python-validated
  station snapshots and observations in `normalized`, dbt views in `staging` and
  `analytics`, and operational records in `ops`. A station's metadata is retained
  per collection, so later name/location/capacity changes do not rewrite history.
- **Logical collection identity.** `(collection_id, station_id)` is the observation
  primary key; `(collection_id, feed_name)` is unique for raw feeds. Use an existing
  collection ID only to retry that collection. New command invocations default to
  UUIDs. Payload hashes identify content, not observations: identical availability
  collected later remains valid. Feed and station timestamps are not unique keys.
- **Real time, not scheduler time.** `collected_at` is actual status-response storage
  time, `fetched_at` records each feed's acquisition, `source_published_at` is GBFS
  `last_updated`, and `station_reported_at` is `last_reported`. A delayed retry never
  labels today's reading with yesterday's Airflow logical date. All DB connections
  use UTC; display uses America/Toronto including daylight saving time.
- **Raw first, atomic normalized writes.** Each raw feed commits independently.
  Failure to fetch status preserves discovery and metadata. Retrying fetches only
  missing feeds. Normalization replaces the collection's metadata/observations and
  check results in one transaction. A failed replay preserves previously successful
  data and its success status; the failed replay remains visible as a failed attempt.
- **Concurrency.** One PostgreSQL session advisory lock spans network requests and
  writes for this source. The database uniqueness constraints are a second defense.
  A competing collection fails explicitly. A dead process releases its lock; the
  next collector marks interrupted attempts failed. An interrupted running attempt
  remains visible until that recovery happens.
- **Retries.** HTTP has 5-second connect/20-second other timeouts, at most three
  attempts, exponential delays, and Retry-After handling. A delay over 60 seconds
  ends the attempt rather than retrying early. Schema errors and permanent HTTP
  failures are not retried internally. The next allowed request time survives in
  PostgreSQL, so a fresh process or orchestration retry cannot bypass Retry-After.
- **Quality is separate from collection success.** Malformed required fields,
  empty station feeds, duplicate station IDs, and unknown metadata IDs fail the
  collection. Missing individual status rows, stale station reports and stale
  publication times produce visible failed checks; they never become fake zeros.
  Freshness uses a documented 30-minute threshold and 5-minute future tolerance.
- **A modest local project.** No inferred trips, forecasting, paid services, or
  production availability guarantee. Analytical views favor inspectable SQL and
  immediate consistency over premature materialization. Retention/partitioning can
  follow measured growth; full source snapshots accumulate until explicitly removed.
- **Separate dependency environments.** The app, dbt, and Airflow have independent
  pinned dependency sets. The app and dbt use committed uv lockfiles; Airflow uses a
  digest-pinned official image and its official Python constraints. Docker volumes and
  development runtimes are not repository data.

## Deferred production work

This is a local portfolio service: no external alerts, deployment, secrets manager,
automatic data retention, backup service, role separation, or public authentication.
The Compose database role owns its local schemas; dashboard SQL is read-only but
does not use a separate least-privilege database role. Those would be explicit
production requirements, not evidence claimed for this project.
