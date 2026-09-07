"""Shared fixtures. Everything here is offline -- no API key, no network."""

from __future__ import annotations

import os

import pytest

from agentzero.agent.providers import PROVIDERS
from agentzero.agent.store import Store, now_ms
from agentzero.agent.types import Task, TaskBudget
from agentzero.web import settings as settings_module

#: Highest numbered suffix cleared. `read_env_keys` stops at the first gap, so
#: clearing a contiguous run from the base name is enough to hide any number of
#: real keys.
_MAX_KEY_SUFFIX = 12


def _provider_key_vars() -> list[str]:
    bases = [p.key_env for p in PROVIDERS if p.key_env] + [settings_module.EXA_KEY_ENV]
    return [name for base in bases
            for name in (base, *(f"{base}_{i}" for i in range(2, _MAX_KEY_SUFFIX + 1)))]


@pytest.fixture(autouse=True)
def offline_environment(monkeypatch):
    """
    Hide the developer's real provider keys from every test.

    Two sources leak them, and both have to go or the suite passes on a clean
    machine and fails on the machine of anyone who actually configured the
    thing -- which is the worst possible way for a test to be wrong:

      - `*_API_KEY` (and `_2`, `_3`, ...) in the real environment.
      - `<repo>/.env`, which `settings._repo_dotenv()` parses itself because
        python-dotenv is not a dependency. Its result is cached, and reading it
        also seeds `os.environ`, so the cache is primed with an empty mapping
        rather than cleared -- `None` would mean "not loaded yet" and send it
        straight back to the file.

    Tests that want a key set one explicitly with `monkeypatch.setenv`; that
    still works, because this runs first.
    """
    for name in _provider_key_vars():
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(settings_module, "_REPO_DOTENV", {}, raising=False)


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
