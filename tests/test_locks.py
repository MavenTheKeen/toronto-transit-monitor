"""Advisory lock IDs must be unique: features sharing an ID silently block each other."""

import re
from pathlib import Path

from transit import locks


def test_lock_ids_are_unique():
    assert len(set(locks.ALL.values())) == len(locks.ALL)


def test_no_lock_id_literals_outside_the_locks_module():
    src = Path(__file__).resolve().parents[1] / "src" / "transit"
    offenders = [
        p.name
        for p in src.rglob("*.py")
        if p.name != "locks.py" and re.search(r"\b814_?700_?0\d\d\b", p.read_text("utf-8"))
    ]
    assert offenders == []
