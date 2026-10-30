"""Regression tests for the live-contract fixture database selection."""

from __future__ import annotations

import os
import sys

BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

from scripts import seed_live_contract_data as seeder  # noqa: E402


def test_explicit_env_file_is_authoritative(monkeypatch, tmp_path):
    """A custom env file must not be overwritten by backend/.env.test."""
    decoy_url = "postgresql+psycopg://decoy:decoy@127.0.0.1:5999/BLF_test"
    expected_url = "postgresql+psycopg://u:selected@127.0.0.1:5432/BLF_test"
    (tmp_path / ".env.test").write_text(
        f"DATABASE_URL={decoy_url}\nTEST_DATABASE_URL={decoy_url}\n",
        encoding="utf-8",
    )
    custom_env = tmp_path / "custom.env"
    custom_env.write_text(f"DATABASE_URL={expected_url}\n", encoding="utf-8")

    monkeypatch.setattr(seeder, "ROOT", tmp_path)
    monkeypatch.setenv("LIVE_CONTRACT_ENV_FILE", str(custom_env))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("TEST_DATABASE_URL", raising=False)

    seeder._load_env_files()

    assert seeder._database_url() == expected_url
    assert os.environ["DATABASE_URL"] == expected_url
    assert os.environ["TEST_DATABASE_URL"] == expected_url


def test_explicit_database_url_wins_over_ambient_env(monkeypatch):
    expected_url = "postgresql+psycopg://u:selected@127.0.0.1:5432/BLF_test"
    monkeypatch.setenv(
        "TEST_DATABASE_URL",
        "postgresql+psycopg://decoy:decoy@127.0.0.1:5999/BLF_test",
    )
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql+psycopg://decoy:decoy@127.0.0.1:5998/BLF_test",
    )

    assert seeder._database_url(expected_url) == expected_url


def test_explicit_env_file_syncs_single_test_database_url(monkeypatch, tmp_path):
    expected_url = "postgresql+psycopg://u:selected@127.0.0.1:5432/BLF_test"
    custom_env = tmp_path / "custom.env"
    custom_env.write_text(f"TEST_DATABASE_URL={expected_url}\n", encoding="utf-8")

    monkeypatch.setattr(seeder, "ROOT", tmp_path)
    monkeypatch.setenv("LIVE_CONTRACT_ENV_FILE", str(custom_env))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("TEST_DATABASE_URL", raising=False)

    seeder._load_env_files()

    assert os.environ["DATABASE_URL"] == expected_url
    assert os.environ["TEST_DATABASE_URL"] == expected_url
