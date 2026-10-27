"""Collects every measurement into $FX_OUT/results.{json,md} (the table in docs/fx-verification.md)."""
from __future__ import annotations

import json

import pytest

from measure import OUT

ROWS: list[dict] = []


class Recorder:
    def __call__(self, device: str, case: str, metric: str, reference, measured, tol: str, ok: bool, ref_name: str = ""):
        ROWS.append({"device": device, "case": case, "metric": metric, "reference": reference, "measured": measured,
                     "tolerance": tol, "pass": bool(ok), "source": ref_name})
        return ok


@pytest.fixture
def rec():
    return Recorder()


def _fmt(v):
    if isinstance(v, float):
        return f"{v:.4g}" if abs(v) < 1e4 else f"{v:.0f}"
    return str(v)


def pytest_sessionfinish(session, exitstatus):
    if not ROWS:
        return
    (OUT / "results.json").write_text(json.dumps(ROWS, indent=1, default=float))
    lines = ["| device | case | metric | reference | measured | tolerance | pass |", "|---|---|---|---|---|---|---|"]
    for r in ROWS:
        lines.append(f"| {r['device']} | {r['case']} | {r['metric']} | {_fmt(r['reference'])} | {_fmt(r['measured'])} | {r['tolerance']} | {'yes' if r['pass'] else '**NO**'} |")
    (OUT / "results.md").write_text("\n".join(lines) + "\n")
