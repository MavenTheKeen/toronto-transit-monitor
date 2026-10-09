"""Run ingestion without an orchestrator: python -m bikeshare.cli --help."""

import argparse
import json
import sys

from bikeshare.config import DISCOVERY_URL, Settings
from bikeshare.db import init_db
from bikeshare.http import FeedClient, FetchError
from bikeshare.ingestion import CollectionBusy, run
from bikeshare.parsing import FeedValidationError, discover, parse_information, parse_status
from bikeshare.transform import run_transform


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
    args = parser.parse_args()
    try:
        if args.command == "smoke":
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
            if args.command == "init-db":
                init_db(settings.database_url)
                result = {"schema": "ready"}
            elif args.command == "transform":
                result = run_transform(settings.database_url, args.dbt_executable, args.project_dir)
            else:
                result = run(settings, args.collection_id, replay=args.command == "replay")
        print(json.dumps(result))
    except (ValueError, FetchError, FeedValidationError, CollectionBusy) as exc:
        print(f"Failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(
            f"Failed: {type(exc).__name__}. Check database/service health and ingestion attempts.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
