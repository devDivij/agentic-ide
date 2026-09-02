"""
Key storage and resolution: the list shape, legacy-string migration, and how
settings-file keys and environment keys combine into one merged list.
"""

from __future__ import annotations

import json

import pytest

import agentzero.web.settings as settings_module
from agentzero.web.settings import (
    add_provider_key, effective_keys, key_counts, load_settings, remove_provider_key,
)


@pytest.fixture(autouse=True)
def isolated_settings(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_module, "SETTINGS_PATH", tmp_path / "settings.json")
    monkeypatch.setattr(settings_module, "_REPO_DOTENV", {})


def test_a_pre_multi_key_settings_file_is_migrated_on_load(tmp_path):
    settings_module.SETTINGS_PATH.write_text(json.dumps({"keys": {"groq": "sk-old"}}))
    assert load_settings()["keys"]["groq"] == ["sk-old"]


def test_add_and_remove_build_the_list(tmp_path):
    add_provider_key("groq", "sk-1")
    add_provider_key("groq", "sk-2")
    assert load_settings()["keys"]["groq"] == ["sk-1", "sk-2"]

    remove_provider_key("groq", 0)
    assert load_settings()["keys"]["groq"] == ["sk-2"]

    remove_provider_key("groq", 0)
    assert "groq" not in load_settings()["keys"]


def test_adding_a_duplicate_key_is_a_no_op(tmp_path):
    add_provider_key("groq", "sk-1")
    add_provider_key("groq", "sk-1")
    assert load_settings()["keys"]["groq"] == ["sk-1"]


def test_settings_and_env_keys_merge_rather_than_override():
    add_provider_key("groq", "sk-settings")
    keys = effective_keys({"GROQ_API_KEY": "sk-env"})
    assert keys["groq"] == ["sk-settings", "sk-env"]


def test_a_key_present_in_both_settings_and_env_is_not_duplicated():
    add_provider_key("groq", "sk-shared")
    keys = effective_keys({"GROQ_API_KEY": "sk-shared"})
    assert keys["groq"] == ["sk-shared"]


def test_numbered_env_vars_are_all_picked_up():
    keys = effective_keys({"GROQ_API_KEY": "sk-1", "GROQ_API_KEY_2": "sk-2"})
    assert keys["groq"] == ["sk-1", "sk-2"]


def test_key_counts_reflect_the_merged_total():
    add_provider_key("groq", "sk-1")
    add_provider_key("groq", "sk-2")
    assert key_counts()["groq"] == 2
    assert key_counts()["mistral"] == 0
