"""Safety checks for the local TEST_DATABASE_URL fallback."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


def _load_root_conftest_helper():
    path = Path(__file__).with_name("conftest.py")
    spec = importlib.util.spec_from_file_location("_root_conftest_test_db_guard", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module._test_database_url_from_fallback


_test_database_url_from_fallback = _load_root_conftest_helper()


@pytest.mark.parametrize(
    ("database_url", "expected"),
    [
        ("postgresql+psycopg://damon@localhost:5432/BLF_test", True),
        ("postgresql+psycopg://damon@localhost:5432/BLF_TEST", True),
        ("postgresql+psycopg://damon@localhost:5432/BLF", False),
        ("postgresql+psycopg://damon@localhost:5432/blf_test", True),
        ("postgresql+psycopg://damon@localhost:5432/BLF_test_archive", False),
        ("", False),
        (None, False),
        ("not a database url", False),
    ],
)
def test_only_lowercase_blf_test_database_is_promoted(
    database_url: str | None, expected: bool
) -> None:
    resolved = _test_database_url_from_fallback(database_url)
    assert (resolved is not None) is expected
    if expected:
        assert resolved == database_url
