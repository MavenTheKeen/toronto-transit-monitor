import os

import pytest

from transit.config import Settings
from transit.db import connect, init_db


@pytest.fixture
def settings():
    """Only reset project tables in an explicitly disposable database."""
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("Set TEST_DATABASE_URL to run PostgreSQL integration checks")
    with connect(url) as conn:
        database = conn.execute("SELECT current_database() AS name").fetchone()["name"]
        if not database.endswith("_test"):
            pytest.fail("Integration database name must end in _test; tables are cleared")
    init_db(url)
    with connect(url) as conn:
        # An interrupted rollback test can leave its failure-injection trigger behind.
        conn.execute("DROP TRIGGER IF EXISTS reject_test_write ON normalized.observations")
        conn.execute("TRUNCATE ops.ingestion_runs CASCADE")
        conn.execute("TRUNCATE ops.source_backoff, ops.transformation_runs")
        conn.execute(
            """TRUNCATE normalized.ttc_gtfs_versions, raw.ttc_realtime_snapshots,
               normalized.ttc_train_stop_events, normalized.ttc_current_predictions,
               normalized.ttc_alerts, ops.ttc_poll_runs, ops.ttc_feed_state,
               ops.ttc_static_refreshes CASCADE"""
        )
        # Incremental dbt models keep history between builds by design; tests start empty.
        for table in ("analytics.ttc_headways", "analytics.ttc_scheduled_service"):
            if conn.execute("SELECT to_regclass(%s) AS t", (table,)).fetchone()["t"]:
                conn.execute(f"TRUNCATE {table}")
    return Settings(url)
