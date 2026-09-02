"""
Where API keys live: ~/.agentzero/settings.json, written 0600.

The settings screen exists so an evaluator can type in their own keys, so they
must persist somewhere the UI can write and the runtime can read -- user-global
(not per-project) and outside version control. Resolution order: the settings
file first, then the environment (useful for CI).

Keys are WRITE-ONLY over the wire: the API reports presence, never the key.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from ..agent.providers import PROVIDERS

SETTINGS_PATH = Path.home() / ".agentzero" / "settings.json"

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
    settings = {"keys": parsed.get("keys") or {}}
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
    """Set or clear one provider's key. An empty string removes it."""
    settings = load_settings()
    if api_key.strip():
        settings["keys"][provider_id] = api_key.strip()
    else:
        settings["keys"].pop(provider_id, None)
    save_settings(settings)


def effective_keys(env: dict[str, str] | None = None) -> dict[str, str]:
    """Effective keys for the runtime: settings file, environment filling gaps."""
    source = os.environ if env is None else env
    stored = load_settings()["keys"]
    keys: dict[str, str] = {}
    for provider in PROVIDERS:
        if not provider.key_env:
            continue
        value = stored.get(provider.id) or source.get(provider.key_env)
        if value and value.strip():
            keys[provider.id] = value.strip()
    return keys


def key_presence() -> dict[str, bool]:
    """Whether a key is set, without ever returning the key itself."""
    keys = effective_keys()
    return {p.id: (p.key_env is None or p.id in keys) for p in PROVIDERS}


def exa_key(env: dict[str, str] | None = None) -> str | None:
    """
    Resolve the web_search tool's key: settings file first, then the
    environment -- same order as effective_keys(), so "set EXA_API_KEY in
    .env" and "type it into Settings" both work, and either one alone is
    enough to show as configured.
    """
    source = os.environ if env is None else env
    stored = load_settings()["keys"]
    value = stored.get(EXA_PROVIDER_ID) or source.get(EXA_KEY_ENV)
    return value.strip() if value and value.strip() else None
