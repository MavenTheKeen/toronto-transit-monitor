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

from airflow.models.dagbag import DagBag  # noqa: E402


@pytest.fixture(scope="module")
def monitor_dag():
    folder = Path(__file__).resolve().parents[1] / "dags"
    bag = DagBag(dag_folder=str(folder), include_examples=False, safe_mode=False)
    assert bag.import_errors == {}
    assert set(bag.dags) == {"toronto_bikeshare_reliability"}
    return bag.dags["toronto_bikeshare_reliability"]


def test_real_dag_import_and_scheduling_safety(monitor_dag):
    assert monitor_dag.catchup is False
    assert monitor_dag.is_paused_upon_creation is True
    assert monitor_dag.max_active_runs == 1
    assert monitor_dag.max_active_tasks == 1
    assert monitor_dag.timetable.summary == "*/15 * * * *"
    assert set(monitor_dag.task_ids) == {"collect", "replay", "transform"}
    assert monitor_dag.get_task("collect").downstream_task_ids == {"replay"}
    assert monitor_dag.get_task("replay").downstream_task_ids == {"transform"}
    for task in monitor_dag.tasks:
        assert task.retries == 2
        assert task.retry_delay == timedelta(minutes=2)
        assert task.retry_exponential_backoff is True
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
    assert requests[0][0] == ["/opt/app-venv/bin/bikeshare", "collect", "--collection-id", first]
    assert requests[-2][0] == ["/opt/app-venv/bin/bikeshare", "replay", "--collection-id", first]
    assert requests[-1][0] == [
        "/opt/app-venv/bin/bikeshare",
        "transform",
        "--dbt-executable",
        "/opt/dbt-venv/bin/dbt",
        "--project-dir",
        "/app/dbt",
    ]
    assert all(options == {"check": True, "timeout": 660} for _, options in requests)
