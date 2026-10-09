"""Always-on TTC collector: poll each realtime feed every 30 s from one process."""

import json
import signal
import threading
import time
from datetime import UTC, datetime

from transit import locks
from transit.bikeshare.parsing import FeedValidationError
from transit.db import connect
from transit.http import FeedClient, FetchError
from transit.ttc import static_gtfs, store
from transit.ttc.sources import REALTIME_FEEDS, REALTIME_HOST, STATIC_GTFS_URL, STATIC_HOST

COLLECTOR_LOCK_ID = locks.TTC_COLLECTOR  # One TTC collector per database.
RETENTION_EVERY_SECONDS = 3600


class CollectorBusy(RuntimeError):
    pass


def _safe_error(exc: Exception) -> str:
    # Fetch/validation messages are written by this project; anything else may contain a DSN.
    if isinstance(exc, (FetchError, FeedValidationError)):
        return str(exc)[:1000]
    return type(exc).__name__


def refresh_static(database_url: str, client: FeedClient, url: str = STATIC_GTFS_URL) -> dict:
    started = datetime.now(UTC)
    with connect(database_url) as conn:
        try:
            payload = client.fetch_bytes(url, host=STATIC_HOST, max_bytes=200 * 1024 * 1024)
            feed = static_gtfs.parse(payload)
            loaded = static_gtfs.load(conn, feed, url, started)
            result = {
                "status": "loaded" if loaded else "unchanged",
                "feed_version": feed.feed_version,
            }
        except Exception as exc:
            result = {"status": "failed", "feed_version": None, "error": _safe_error(exc)}
        conn.execute(
            """INSERT INTO ops.ttc_static_refreshes
               (started_at, finished_at, status, feed_version, error)
               VALUES (%s, now(), %s, %s, %s)""",
            (started, result["status"], result["feed_version"], result.get("error")),
        )
    return result


def poll_feed(conn, client: FeedClient, feed: str, url: str) -> dict:
    started = datetime.now(UTC)
    result = {"feed": feed, "status": "failed", "snapshot_id": None, "feed_timestamp": None}
    try:
        backoff = conn.execute(
            "SELECT retry_not_before FROM ops.source_backoff WHERE discovery_url = %s", (url,)
        ).fetchone()
        if backoff and backoff["retry_not_before"] > started:
            raise FetchError("Source Retry-After is still active; no HTTP request made")
        payload = client.fetch_bytes(url, host=REALTIME_HOST, max_bytes=5 * 1024 * 1024)
        snapshot_id, is_new = store.store_snapshot(conn, feed, url, payload, started)
        result["snapshot_id"] = snapshot_id
        pending = conn.execute(
            """SELECT feed_timestamp, normalized_at IS NULL AS pending
               FROM raw.ttc_realtime_snapshots WHERE snapshot_id = %s""",
            (snapshot_id,),
        ).fetchone()
        result["feed_timestamp"] = pending["feed_timestamp"]
        if is_new or pending["pending"]:
            result.update(store.normalize_snapshot(conn, snapshot_id))
            result["status"] = "stored"
        else:
            result["status"] = "unchanged"
    except Exception as exc:
        result["error"] = _safe_error(exc)
        if isinstance(exc, FetchError) and exc.retry_not_before:
            conn.execute(
                """INSERT INTO ops.source_backoff (discovery_url, retry_not_before)
                   VALUES (%s, %s) ON CONFLICT (discovery_url) DO UPDATE
                   SET retry_not_before = greatest(ops.source_backoff.retry_not_before,
                                                  excluded.retry_not_before)""",
                (url, exc.retry_not_before),
            )
    conn.execute(
        """INSERT INTO ops.ttc_poll_runs
           (feed, started_at, finished_at, status, snapshot_id, feed_timestamp,
            accepted, rejected, flagged, error)
           VALUES (%s, %s, now(), %s, %s, %s, %s, %s, %s, %s)""",
        (
            feed,
            started,
            result["status"],
            result["snapshot_id"],
            result["feed_timestamp"],
            result.get("accepted"),
            result.get("rejected"),
            result.get("flagged"),
            result.get("error"),
        ),
    )
    return result


def poll_once(database_url: str, client: FeedClient) -> list[dict]:
    with connect(database_url) as conn:
        return [poll_feed(conn, client, feed, url) for feed, url in REALTIME_FEEDS.items()]


def run_forever(
    database_url: str,
    *,
    interval: float = 30,
    raw_days: int = 3,
    event_days: int = 90,
    client: FeedClient | None = None,
    stop: threading.Event | None = None,
):
    stop = stop or threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, lambda *_: stop.set())
        except ValueError:  # Not the main thread (tests).
            pass
    client = client or FeedClient()
    # Held for the process lifetime: a second collector exits instead of double-polling.
    with connect(database_url) as lock_conn:
        if not lock_conn.execute(
            "SELECT pg_try_advisory_lock(%s) AS locked", (COLLECTOR_LOCK_ID,)
        ).fetchone()["locked"]:
            raise CollectorBusy("Another TTC collector is already running")
        with connect(database_url) as conn:
            has_static = store.active_feed_version(conn)
        if not has_static:
            _log({"event": "static_gtfs", **refresh_static(database_url, client)})
        last_retention = 0.0
        summary = {"polls": 0, "stored": 0, "unchanged": 0, "failed": 0}
        while not stop.is_set():
            started = time.monotonic()
            for result in poll_once(database_url, client):
                summary["polls"] += 1
                summary[result["status"]] += 1
                if result["status"] == "failed":
                    _log({"event": "poll_failed", **result})
            if started - last_retention >= RETENTION_EVERY_SECONDS:
                with connect(database_url) as conn:
                    deleted = store.apply_retention(conn, raw_days, event_days)
                _log({"event": "hourly", **summary, "retention_deleted": deleted})
                summary = dict.fromkeys(summary, 0)
                last_retention = started
            stop.wait(max(0.0, interval - (time.monotonic() - started)))
    client.close()


def _log(record: dict):
    print(json.dumps({"at": datetime.now(UTC).isoformat(), **record}, default=str), flush=True)
