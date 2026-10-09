"""Toronto Transit Monitor: collect, replay and transform without an orchestrator."""

import argparse
import json
import os
import sys

from transit.bikeshare.ingestion import CollectionBusy, run
from transit.bikeshare.parsing import FeedValidationError, discover, parse_information, parse_status
from transit.config import DISCOVERY_URL, Settings
from transit.db import connect, init_db
from transit.http import FeedClient, FetchError
from transit.transform import run_transform
from transit.ttc import collector as ttc_collector
from transit.ttc import realtime as ttc_realtime
from transit.ttc import store as ttc_store
from transit.ttc.sources import REALTIME_FEEDS, REALTIME_HOST


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("init-db", help="Create schemas/tables (safe to repeat)")
    collect = commands.add_parser("collect", help="Collect live GBFS; reuse an ID only for a retry")
    collect.add_argument("--collection-id")
    replay = commands.add_parser("replay", help="Normalize stored raw feeds without HTTP")
    replay.add_argument("--collection-id", required=True)
    commands.add_parser("smoke", help="Explicit live API parse check; writes no database data")
    transform = commands.add_parser("transform", help="Run isolated dbt build and record results")
    transform.add_argument("--dbt-executable", default="dbt")
    transform.add_argument("--project-dir", default="dbt")
    commands.add_parser("ttc-gtfs-refresh", help="Load TTC static GTFS if it changed")
    ttc_collect = commands.add_parser("ttc-collect", help="Poll TTC realtime feeds every 30 s")
    ttc_collect.add_argument("--once", action="store_true", help="Poll each feed once and exit")
    ttc_replay = commands.add_parser("ttc-replay", help="Re-normalize stored TTC snapshots")
    which = ttc_replay.add_mutually_exclusive_group(required=True)
    which.add_argument("--snapshot-id", type=int)
    which.add_argument("--pending", action="store_true", help="All not-yet-normalized")
    commands.add_parser("ttc-retention", help="Delete expired TTC raw snapshots and history")
    commands.add_parser("ttc-smoke", help="Explicit live TTC parse check; writes no data")
    commands.add_parser("ttc-health", help="Exit 1 unless every TTC feed polled in 2 minutes")
    args = parser.parse_args()
    try:
        if args.command == "ttc-smoke":
            client = FeedClient()
            try:
                result = {}
                for feed, url in REALTIME_FEEDS.items():
                    snapshot = ttc_realtime.decode(client.fetch_bytes(url, host=REALTIME_HOST))
                    result[feed] = {
                        "feed_timestamp": snapshot.feed_timestamp.isoformat(),
                        "entities": len(snapshot.message.entity),
                    }
            finally:
                client.close()
        elif args.command == "smoke":
            client = FeedClient()
            try:
                urls = discover(client.fetch(DISCOVERY_URL))
                stations = parse_information(client.fetch(urls["station_information"]))
                statuses = parse_status(client.fetch(urls["station_status"]))
                result = {
                    "live_api": "parsed",
                    "stations": len(stations),
                    "statuses": len(statuses),
                }
            finally:
                client.close()
        else:
            settings = Settings.from_env()
            if args.command.startswith("ttc-"):
                result = run_ttc(args, settings.database_url)
            elif args.command == "init-db":
                init_db(settings.database_url)
                result = {"schema": "ready"}
            elif args.command == "transform":
                result = run_transform(settings.database_url, args.dbt_executable, args.project_dir)
            else:
                result = run(settings, args.collection_id, replay=args.command == "replay")
        print(json.dumps(result, default=str))
    except (
        ValueError,
        FetchError,
        FeedValidationError,
        CollectionBusy,
        ttc_collector.CollectorBusy,
    ) as exc:
        print(f"Failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(
            f"Failed: {type(exc).__name__}. Check database/service health and ingestion attempts.",
            file=sys.stderr,
        )
        return 1
    return 0


def run_ttc(args, database_url):
    raw_days = int(os.environ.get("TTC_RAW_RETENTION_DAYS", "3"))
    event_days = int(os.environ.get("TTC_EVENT_RETENTION_DAYS", "90"))
    if args.command == "ttc-gtfs-refresh":
        client = FeedClient()
        try:
            result = ttc_collector.refresh_static(database_url, client)
        finally:
            client.close()
        if result["status"] == "failed":
            raise FetchError(f"Static GTFS refresh failed: {result['error']}")
        return result
    if args.command == "ttc-collect":
        if not args.once:
            ttc_collector.run_forever(
                database_url,
                interval=float(os.environ.get("TTC_POLL_SECONDS", "30")),
                raw_days=raw_days,
                event_days=event_days,
            )
            return {"collector": "stopped"}
        client = FeedClient()
        try:
            return ttc_collector.poll_once(database_url, client)
        finally:
            client.close()
    with connect(database_url) as conn:
        if args.command == "ttc-health":
            healthy = conn.execute(
                """SELECT feed FROM ops.ttc_poll_runs
                   WHERE status <> 'failed' AND started_at > now() - interval '2 minutes'
                   GROUP BY feed"""
            ).fetchall()
            missing = set(REALTIME_FEEDS) - {r["feed"] for r in healthy}
            if missing:
                raise ValueError(f"No successful recent poll for {', '.join(sorted(missing))}")
            return {"ttc_collector": "healthy"}
        if args.command == "ttc-retention":
            return ttc_store.apply_retention(conn, raw_days, event_days)
        if args.snapshot_id is not None:
            return ttc_store.normalize_snapshot(conn, args.snapshot_id)
        pending = conn.execute(
            """SELECT snapshot_id FROM raw.ttc_realtime_snapshots
               WHERE normalized_at IS NULL ORDER BY feed_timestamp"""
        ).fetchall()
        return [ttc_store.normalize_snapshot(conn, r["snapshot_id"]) for r in pending]


if __name__ == "__main__":
    sys.exit(main())
