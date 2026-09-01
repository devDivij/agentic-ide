"""Shared fixtures. Everything here is offline -- no API key, no network."""

from __future__ import annotations

import pytest

from agentzero.agent.store import Store, now_ms
from agentzero.agent.types import Task, TaskBudget


@pytest.fixture
def project(tmp_path):
    """An empty project root."""
    return str(tmp_path)


@pytest.fixture
def store(project):
    s = Store(project)
    yield s
    s.close()


@pytest.fixture
def budget():
    return TaskBudget(max_usd=0.06, max_seconds=1200, max_tokens=400_000,
                      max_steps=16, max_retries_per_step=2)


@pytest.fixture
def task(store, project, budget):
    """A task already inserted into the store."""
    t = Task(id="t1", project_root=project, conversation_id="c1", prompt="do the thing",
             status="running", complexity="medium", created_at=now_ms(), budget=budget)
    store.create_task(t)
    return t
