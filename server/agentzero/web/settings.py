"""
Where API keys live: ~/.agentzero/settings.json, written 0600.

The settings screen exists so an evaluator can type in their own keys, so they
must persist somewhere the UI can write and the runtime can read -- user-global
(not per-project) and outside version control.

A provider can have several keys (see providers.py's `read_env_keys` and
router.py's per-key rate buckets), so every entry under "keys" is a list, even
a single key. Every source that offers keys for a provider is MERGED, not
overridden: the settings file's list, then `.env`/the real environment's
numbered vars (KEY, KEY_2, KEY_3, ...), then the repo `.env` file's -- keys
already seen (by value) are not repeated, so the same key entered in two
places still yields one rate bucket, not two that silently overcount headroom.
That is a deliberate change from the old single-key behaviour, where a
settings-file key replaced the environment entirely: "add keys in the
environment too" only means something if the environment actually adds to
what is configured, not sit unused behind it.

Keys are WRITE-ONLY over the wire: the API reports presence and count, never
the key itself.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from ..agent.providers import PROVIDERS, read_env_keys

SETTINGS_PATH = Path.home() / ".agentzero" / "settings.json"

# Repo-root .env fallback: python-dotenv is not a dependency, so a key put in
# <repo>/.env (as .env.example instructs) would otherwise never reach
# os.environ and the Settings screen would show "not configured". We parse the
# file ourselves and use it as a final fallback after the settings file and
# the real environment -- and also seed os.environ so direct os.environ.get()
# checks elsewhere keep working.
_REPO_DOTENV: dict[str, str] | None = None

def _repo_dotenv() -> dict[str, str]:
    global _REPO_DOTENV
    if _REPO_DOTENV is not None:
        return _REPO_DOTENV
    env: dict[str, str] = {}
    # settings.py is at <repo>/server/agentzero/web/settings.py -> parents[3] is <repo>
    for candidate in (Path(__file__).resolve().parents[3] / ".env", Path.cwd() / ".env"):
        try:
            if not candidate.is_file():
                continue
            for raw in candidate.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in env:
                    env[k] = v
            break  # use first file found
        except OSError:
            continue
    _REPO_DOTENV = env
    # Seed os.environ so bare os.environ.get() elsewhere also sees it
    for k, v in env.items():
        os.environ.setdefault(k, v)
    return env

#: Not an LLM routing provider, so it lives outside PROVIDERS/effective_keys
#: (which feed Router) -- but it is stored and resolved the same way: the
#: settings file first, the environment filling the gap. Same reasoning as
#: every other key here: an evaluator types it into the Settings screen
#: without needing to touch a .env file or restart the server.
EXA_PROVIDER_ID = "exa"
EXA_KEY_ENV = "EXA_API_KEY"


def settings_path() -> str:
    return str(SETTINGS_PATH)


def load_settings() -> dict:
    if not SETTINGS_PATH.exists():
        return {"keys": {}}
    try:
        parsed = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"keys": {}}     # a corrupt file must not stop the app; re-enter keys
    raw_keys = parsed.get("keys") or {}
    # Migrate a pre-multi-key settings.json, where each entry was a bare
    # string, to the list shape every reader/writer below now assumes.
    keys = {pid: ([v] if isinstance(v, str) else list(v)) for pid, v in raw_keys.items()}
    settings = {"keys": keys}
    if parsed.get("lastProjectRoot"):
        settings["lastProjectRoot"] = parsed["lastProjectRoot"]
    return settings


def save_settings(settings: dict) -> None:
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    try:
        SETTINGS_PATH.chmod(0o600)
    except OSError:
        pass                    # best effort; some filesystems do not support it


def set_provider_key(provider_id: str, api_key: str) -> None:
    """
    Replace a provider's entire key list with a single key, or clear it with
    an empty string. Only Exa (web_search) uses this now -- it has no models
    or rate buckets, so multiple keys would buy it nothing. LLM providers use
    `add_provider_key`/`remove_provider_key` instead.
    """
    settings = load_settings()
    if api_key.strip():
        settings["keys"][provider_id] = [api_key.strip()]
    else:
        settings["keys"].pop(provider_id, None)
    save_settings(settings)


def add_provider_key(provider_id: str, api_key: str) -> None:
    """Append one more key for a provider. A duplicate value is a no-op."""
    key = api_key.strip()
    if not key:
        return
    settings = load_settings()
    existing = settings["keys"].setdefault(provider_id, [])
    if key not in existing:
        existing.append(key)
    save_settings(settings)


def remove_provider_key(provider_id: str, index: int) -> None:
    """Remove one key by its position in the stored list."""
    settings = load_settings()
    existing = settings["keys"].get(provider_id) or []
    if 0 <= index < len(existing):
        existing.pop(index)
    if existing:
        settings["keys"][provider_id] = existing
    else:
        settings["keys"].pop(provider_id, None)
    save_settings(settings)


def effective_keys(env: dict[str, str] | None = None) -> dict[str, list[str]]:
    """
    Effective keys for the runtime: every source that has one for a provider,
    merged (see the module docstring for why this is a merge, not a
    fallback-only chain, and why duplicate values are dropped).
    """
    source = os.environ if env is None else env
    # When env is the real os.environ (the default), also allow the repo .env file
    repo_env = _repo_dotenv() if env is None else {}
    stored = load_settings()["keys"]
    keys: dict[str, list[str]] = {}
    for provider in PROVIDERS:
        if not provider.key_env:
            continue
        merged: list[str] = []
        for found in (
            stored.get(provider.id) or [],
            read_env_keys(provider.key_env, source),
            read_env_keys(provider.key_env, repo_env),
        ):
            for key in found:
                if key not in merged:
                    merged.append(key)
        if merged:
            keys[provider.id] = merged
    return keys


def key_presence() -> dict[str, bool]:
    """Whether at least one key is set, without ever returning the key itself."""
    keys = effective_keys()
    return {p.id: (p.key_env is None or bool(keys.get(p.id))) for p in PROVIDERS}


def key_counts() -> dict[str, int]:
    """How many keys are configured per provider (settings + env), for the Settings screen."""
    keys = effective_keys()
    return {p.id: len(keys.get(p.id, [])) for p in PROVIDERS if p.key_env}


def stored_key_counts() -> dict[str, int]:
    """
    How many of a provider's keys live in the settings file specifically --
    NOT the merged total `key_counts()` reports. `remove_provider_key` indexes
    into the settings-file list only, and `effective_keys`'s merge always puts
    that list first, so a UI index below this count is safe to remove; one at
    or above it is an environment-sourced key with no settings-file position
    to remove, and must be shown read-only instead.
    """
    stored = load_settings()["keys"]
    return {p.id: len(stored.get(p.id, [])) for p in PROVIDERS if p.key_env}


def exa_key(env: dict[str, str] | None = None) -> str | None:
    """
    Resolve the web_search tool's key: settings file first, then the
    environment -- same order as effective_keys(), so "set EXA_API_KEY in
    .env" and "type it into Settings" both work, and either one alone is
    enough to show as configured. Single-key only -- see `set_provider_key`.
    """
    source = os.environ if env is None else env
    repo_env = _repo_dotenv() if env is None else {}
    stored = load_settings()["keys"]
    stored_list = stored.get(EXA_PROVIDER_ID) or []
    value = (stored_list[0] if stored_list else None) \
        or source.get(EXA_KEY_ENV) or repo_env.get(EXA_KEY_ENV)
    return value.strip() if value and value.strip() else None
