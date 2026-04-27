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

# Test accounts — update these before running
TEST_ACCOUNTS = {
    "admin": {
        "email": os.getenv("TEST_ADMIN_EMAIL", "yawei@believeboy.com"),
        "password": os.getenv("TEST_ADMIN_PASSWORD", "XeonJJ2024@"),
    },
    "operator": {
        "email": os.getenv("TEST_OPERATOR_EMAIL", "test_operator@believeboy.com"),
        "password": os.getenv("TEST_OPERATOR_PASSWORD", "TestPassword123"),
    },
    "businessdev": {
        "email": os.getenv("TEST_BUSINESSDEV_EMAIL", "test_businessdev@believeboy.com"),
        "password": os.getenv("TEST_BUSINESSDEV_PASSWORD", "TestPassword123"),
    },
    "factory": {
        "email": os.getenv("TEST_FACTORY_EMAIL", "test_factory@believeboy.com"),
        "password": os.getenv("TEST_FACTORY_PASSWORD", "TestPassword123"),
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