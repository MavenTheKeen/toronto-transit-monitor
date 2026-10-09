"""PostgreSQL persistence; source writes and normalized writes have separate commits."""

import hashlib
import json
from datetime import UTC, datetime
from importlib.resources import files

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from bikeshare.config import FUTURE_TOLERANCE_SECONDS, STALE_SECONDS
from bikeshare.parsing import FeedValidationError, parse_information, parse_status, timestamp

LOCK_ID = 814_700_015  # One source/system per repository. Session lock spans HTTP and SQL.


def connect(database_url):
    return psycopg.connect(
        database_url,
        autocommit=True,
        row_factory=dict_row,
        connect_timeout=10,
        options="-c timezone=UTC -c statement_timeout=60000",
    )


def init_db(database_url):
    with connect(database_url) as conn, conn.transaction():
        conn.execute(files("bikeshare").joinpath("schema.sql").read_text(encoding="utf-8"))


def payload_hash(payload):
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def store_raw(conn, collection_id, feed_name, url, payload):
    # Record even a JSON object that fails GBFS validation. Publication may be unknown.
    try:
        published_at = timestamp(payload.get("last_updated"))
    except FeedValidationError:
        published_at = None
    fetched_at = datetime.now(UTC)
    with conn.transaction():
        result = conn.execute(
            """INSERT INTO raw.feed_payloads
           (collection_id, feed_name, feed_url, fetched_at, source_published_at,
            payload_hash, payload)
           VALUES (%s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (collection_id, feed_name) DO NOTHING RETURNING raw_id""",
            (
                collection_id,
                feed_name,
                url,
                fetched_at,
                published_at,
                payload_hash(payload),
                Jsonb(payload),
            ),
        ).fetchone()
        if feed_name == "station_status" and result:
            # Actual status acquisition, never the Airflow logical date or original
            # failed attempt's start. A retry tomorrow cannot invent yesterday's data.
            conn.execute(
                "UPDATE ops.ingestion_runs SET collected_at=%s WHERE collection_id=%s",
                (fetched_at, collection_id),
            )
    return result


def load_raw(conn, collection_id):
    return {
        r["feed_name"]: r
        for r in conn.execute(
            "SELECT * FROM raw.feed_payloads WHERE collection_id = %s", (collection_id,)
        ).fetchall()
    }


def age_valid(observed_at, reported_at):
    age = (observed_at - reported_at).total_seconds()
    return -FUTURE_TOLERANCE_SECONDS <= age <= STALE_SECONDS


def normalize(conn, collection_id):
    raw = load_raw(conn, collection_id)
    if not {"station_information", "station_status"} <= raw.keys():
        raise FeedValidationError(
            "Replay needs both stored station feeds; collect can fetch missing feeds"
        )
    information = raw["station_information"]
    status = raw["station_status"]
    stations = parse_information(information["payload"])
    observations = parse_status(status["payload"])
    station_ids = {r["station_id"] for r in stations}
    observed_ids = {r["station_id"] for r in observations}
    unknown = observed_ids - station_ids
    if unknown:
        raise FeedValidationError(f"Status has {len(unknown)} stations absent from metadata")
    collected_at = conn.execute(
        "SELECT collected_at FROM ops.ingestion_runs WHERE collection_id=%s", (collection_id,)
    ).fetchone()["collected_at"]
    stale_count = sum(
        not age_valid(status["fetched_at"], row["station_reported_at"]) for row in observations
    )
    checks = [
        ("required_fields_and_unique_stations", True, {"stations": len(stations)}),
        (
            "station_status_coverage",
            station_ids == observed_ids,
            {
                "metadata_stations": len(station_ids),
                "observed_stations": len(observed_ids),
                "missing_status": len(station_ids - observed_ids),
            },
        ),
        (
            "feed_freshness",
            all(
                age_valid(r["fetched_at"], r["source_published_at"]) for r in (information, status)
            ),
            {"threshold_seconds": STALE_SECONDS},
        ),
        (
            "station_report_freshness",
            stale_count == 0,
            {
                "stale_or_future_reports": stale_count,
                "observed_stations": len(observations),
                "threshold_seconds": STALE_SECONDS,
            },
        ),
    ]
    # Replay replaces only this collection atomically. A failed insert leaves old data intact.
    with conn.transaction():
        conn.execute("DELETE FROM normalized.observations WHERE collection_id=%s", (collection_id,))
        conn.execute(
            "DELETE FROM normalized.station_snapshots WHERE collection_id=%s", (collection_id,)
        )
        with conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO normalized.station_snapshots
                   (collection_id, station_id, name, lat, lon, capacity, information_raw_id)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                [
                    (
                        collection_id,
                        s["station_id"],
                        s["name"],
                        s["lat"],
                        s["lon"],
                        s["capacity"],
                        information["raw_id"],
                    )
                    for s in stations
                ],
            )
            cur.executemany(
                """INSERT INTO normalized.observations
                   (collection_id, station_id, collected_at, status_fetched_at,
                    source_published_at, station_reported_at, num_bikes_available,
                    num_docks_available, num_bikes_disabled, num_docks_disabled,
                    is_installed, is_renting, is_returning, status_raw_id)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                [
                    (
                        collection_id,
                        r["station_id"],
                        collected_at,
                        status["fetched_at"],
                        status["source_published_at"],
                        r["station_reported_at"],
                        r["num_bikes_available"],
                        r["num_docks_available"],
                        r["num_bikes_disabled"],
                        r["num_docks_disabled"],
                        r["is_installed"],
                        r["is_renting"],
                        r["is_returning"],
                        status["raw_id"],
                    )
                    for r in observations
                ],
            )
            cur.executemany(
                """INSERT INTO ops.quality_checks (collection_id,check_name,passed,details)
                   VALUES (%s,%s,%s,%s) ON CONFLICT (collection_id,check_name)
                   DO UPDATE SET passed=excluded.passed,details=excluded.details""",
                [(collection_id, name, passed, Jsonb(details)) for name, passed, details in checks],
            )
        conn.execute(
            """UPDATE ops.ingestion_runs SET status='succeeded', completed_at=now(), error=NULL
               WHERE collection_id=%s""",
            (collection_id,),
        )
    return len(observations)
