"""Real DAG import/behavior checks; never execute a collector or contact the live API."""

import sys
from datetime import timedelta
from pathlib import Path

import pytest

pytestmark = pytest.mark.airflow
if sys.platform == "win32":
    pytest.skip(
        "Airflow requires Linux/WSL; exercised in the separate CI job", allow_module_level=True
    )
pytest.importorskip("airflow.sdk", reason="Install the isolated Airflow test environment")

from airflow.dag_processing.dagbag import DagBag  # noqa: E402
from airflow.sdk.definitions.timetables.trigger import CronTriggerTimetable  # noqa: E402


@pytest.fixture(scope="module")
def dag_bag():
    folder = Path(__file__).resolve().parents[1] / "dags"
    bag = DagBag(dag_folder=str(folder), safe_mode=False)
    assert bag.import_errors == {}
    assert set(bag.dags) == {
        "toronto_bikeshare_reliability",
        "ttc_static_gtfs",
        "open_data_export",
    }
    return bag


@pytest.fixture(scope="module")
def monitor_dag(dag_bag):
    return dag_bag.dags["toronto_bikeshare_reliability"]


def test_ttc_static_refresh_is_daily_and_shell_free(dag_bag, monkeypatch):
    dag = dag_bag.dags["ttc_static_gtfs"]
    assert dag.catchup is False
    assert dag.is_paused_upon_creation is True
    assert isinstance(dag.timetable, CronTriggerTimetable)
    assert dag.timetable.expression == "0 9 * * *"
    refresh = dag.get_task("refresh").python_callable
    calls = []
    monkeypatch.setattr(
        refresh.__globals__["subprocess"], "run", lambda args, **kw: calls.append((args, kw))
    )
    refresh()
    assert calls == [
        (["/opt/app-venv/bin/transit", "ttc-gtfs-refresh"], {"check": True, "timeout": 840})
    ]


def test_open_data_export_runs_daily_after_the_service_day(dag_bag, monkeypatch):
    dag = dag_bag.dags["open_data_export"]
    assert dag.catchup is False and dag.is_paused_upon_creation is True
    assert dag.timetable.expression == "30 9 * * *"
    export = dag.get_task("export").python_callable
    calls = []
    monkeypatch.setattr(
        export.__globals__["subprocess"], "run", lambda args, **kw: calls.append((args, kw))
    )
    export()
    assert calls == [(["/opt/app-venv/bin/transit", "export"], {"check": True, "timeout": 1140})]


def test_real_dag_import_and_scheduling_safety(monitor_dag):
    assert monitor_dag.catchup is False
    assert monitor_dag.is_paused_upon_creation is True
    assert monitor_dag.max_active_runs == 1
    assert monitor_dag.max_active_tasks == 1
    assert isinstance(monitor_dag.timetable, CronTriggerTimetable)
    assert monitor_dag.timetable.expression == "*/15 * * * *"
    assert set(monitor_dag.task_ids) == {"collect", "replay", "transform"}
    assert monitor_dag.get_task("collect").downstream_task_ids == {"replay"}
    assert monitor_dag.get_task("replay").downstream_task_ids == {"transform"}
    for task in monitor_dag.tasks:
        assert task.retries == 2
        assert task.retry_delay == timedelta(minutes=2)
        assert task.retry_exponential_backoff == 2.0
        assert task.max_retry_delay == timedelta(minutes=5)
        assert task.execution_timeout == timedelta(minutes=12)


def test_task_retries_reuse_identity_and_shell_free_commands(monitor_dag, monkeypatch):
    collect = monitor_dag.get_task("collect").python_callable
    task_globals = collect.__globals__
    requests = []

    def fake_run(arguments, **kwargs):
        requests.append((arguments, kwargs))

    monkeypatch.setattr(task_globals["subprocess"], "run", fake_run)
    context = {"run_id": "manual__a; echo should-never-run"}
    monkeypatch.setitem(task_globals, "get_current_context", lambda: context)
    first = collect()
    assert collect() == first
    context["run_id"] = "manual__later"
    assert collect() != first
    assert len(first) <= 200
    replay = monitor_dag.get_task("replay").python_callable
    assert replay(first) == first
    monitor_dag.get_task("transform").python_callable(first)
    assert requests[0][0] == ["/opt/app-venv/bin/transit", "collect", "--collection-id", first]
    assert requests[-2][0] == ["/opt/app-venv/bin/transit", "replay", "--collection-id", first]
    assert requests[-1][0] == [
        "/opt/app-venv/bin/transit",
        "transform",
        "--dbt-executable",
        "/opt/dbt-venv/bin/dbt",
        "--project-dir",
        "/app/dbt",
    ]
    assert all(options == {"check": True, "timeout": 660} for _, options in requests)
