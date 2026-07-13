"""Shared fixtures for agent testing.

This conftest sets up Playwright browser automation for the test suite.
It creates the `page` fixture by launching a Chromium browser.
"""
import os
import sys
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright

# Add backend root to path so we can import app modules
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:3000")
BACKEND_URL = os.getenv("BACKEND_URL", "http://127.0.0.1:8000")
BACKEND_API_BASE = f"{BACKEND_URL}/api/v1"


def _require(name: str) -> str:
    val = os.getenv(name)
    if not val:
        raise RuntimeError(
            f"Missing required env var {name}. Set it before running agent tests "
            "(e.g. in backend/.env, never commit real credentials)."
        )
    return val


# Test accounts — credentials MUST come from env, never hardcoded.
TEST_ACCOUNTS = {
    "admin": {
        "email": os.getenv("TEST_ADMIN_EMAIL", "yawei@believeboy.com"),
        "password": _require("TEST_ADMIN_PASSWORD"),
    },
    "operator": {
        "email": os.getenv("TEST_OPERATOR_EMAIL", "test_operator@believeboy.com"),
        "password": _require("TEST_OPERATOR_PASSWORD"),
    },
    "businessdev": {
        "email": os.getenv("TEST_BUSINESSDEV_EMAIL", "test_businessdev@believeboy.com"),
        "password": _require("TEST_BUSINESSDEV_PASSWORD"),
    },
}


@pytest.fixture(scope="session")
def browser():
    """Launch a single Chromium browser for the entire test session."""
    pw = sync_playwright().start()
    b = pw.chromium.launch(headless=True)
    yield b
    b.close()
    pw.stop()


@pytest.fixture(scope="function")
def page(browser):
    """Create a new browser context and page for each test."""
    context = browser.new_context()
    page = context.new_page()
    yield page
    context.close()


@pytest.fixture(scope="module")
def frontend_url():
    return FRONTEND_URL


@pytest.fixture(scope="module")
def backend_api_base():
    return BACKEND_API_BASE