"""Run the real dbt project on controlled TTC arrivals and check the reliability models."""

import os
from datetime import UTC, datetime, timedelta

import pytest

from tests.ttc_helpers import T0, alert_feed, static_zip, trip_feed
from transit.db import connect
from transit.transform import run_transform
from transit.ttc import static_gtfs, store

pytestmark = pytest.mark.integration

# 06:00 Toronto on Friday 2026-10-09; the helper schedule has one southbound train per
# hour at Wellesley (13806), so the scheduled headway in service hour 6 is 3600 s.
SIX_AM = datetime(2026, 10, 9, 10, 0, tzinfo=UTC)


def arrive(conn, train, at, stop="13806"):
    """A snapshot listing the train as due, then one where the platform is gone."""
    for when, stops in (
        (at - timedelta(seconds=10), [(stop, 3, 10)]),
        (at + timedelta(seconds=15), []),
    ):
        trips = [{"trip_id": f"t{train}", "vehicle": train, "route_id": "1", "stops": stops}]
        snapshot_id, _ = store.store_snapshot(
            conn, "trips_subway", "test://", trip_feed(when, trips if stops else []), when
        )
        store.normalize_snapshot(conn, snapshot_id)


def test_ttc_reliability_models(settings):
    executable = os.environ.get("DBT_EXECUTABLE")
    if not executable:
        pytest.skip("Set DBT_EXECUTABLE to the isolated dbt executable")
    with connect(settings.database_url) as conn:
        static_gtfs.load(conn, static_gtfs.parse(static_zip()), "test://gtfs", T0)
        for train, offset in (("A", 0), ("B", 180), ("C", 210), ("D", 900)):
            arrive(conn, train, SIX_AM + timedelta(seconds=offset))
        outage = alert_feed(
            T0,
            [
                {
                    "id": "9",
                    "effect": "ACCESSIBILITY_ISSUE",
                    "stops": ["13864"],
                    "text": "Bloor-Yonge: Elevator 1A out of service",
                }
            ],
        )
        snapshot_id, _ = store.store_snapshot(conn, "alerts_accessibility", "test://", outage, T0)
        store.normalize_snapshot(conn, snapshot_id)

    assert run_transform(settings.database_url, executable, "dbt")["status"] == "succeeded"

    with connect(settings.database_url) as conn:
        headways = conn.execute(
            """SELECT train_id, previous_train_id, headway_seconds, implausible, service_hour
               FROM analytics.ttc_headways ORDER BY arrived_at"""
        ).fetchall()
        assert [(h["train_id"], h["headway_seconds"], h["implausible"]) for h in headways] == [
            ("A", None, False),
            ("B", 180, False),
            ("C", 30, True),  # Two trains 30 s apart: excluded from metrics.
            ("D", 690, False),
        ]
        assert {h["service_hour"] for h in headways} == {6}
        hourly = conn.execute("SELECT * FROM analytics.ttc_headway_reliability_hourly").fetchall()
        assert len(hourly) == 1
        row = hourly[0]
        assert (row["route_id"], row["direction_id"], row["service_hour"]) == ("1", 0, 6)
        assert (row["observed_headways"], row["compared_headways"]) == (2, 2)
        assert float(row["scheduled_headway_seconds"]) == 3600
        assert row["median_headway_seconds"] == 435
        assert (row["regular_headways"], row["long_gaps"]) == (2, 0)
        gaps = conn.execute(
            """SELECT gap_rank, gap_seconds, station_name FROM analytics.ttc_longest_gaps
               ORDER BY gap_rank"""
        ).fetchall()
        assert [(g["gap_rank"], g["gap_seconds"]) for g in gaps] == [(1, 690), (2, 180)]
        assert gaps[0]["station_name"] == "Wellesley"
        outage_row = conn.execute("SELECT * FROM analytics.ttc_elevator_outages").fetchone()
        assert (outage_row["station_name"], outage_row["device_type"]) == (
            "Bloor-Yonge",
            "elevator",
        )
        assert outage_row["active"] is True and outage_row["began_before_collection"] is True

        # Incremental: a later run keeps earlier rows and adds new ones exactly once.
        arrive(conn, "E", SIX_AM + timedelta(seconds=1200))
    assert run_transform(settings.database_url, executable, "dbt")["status"] == "succeeded"
    with connect(settings.database_url) as conn:
        rows = conn.execute(
            "SELECT train_id, headway_seconds FROM analytics.ttc_headways ORDER BY arrived_at"
        ).fetchall()
        assert [(r["train_id"], r["headway_seconds"]) for r in rows][-2:] == [
            ("D", 690),
            ("E", 300),
        ]
        assert len(rows) == 5
