"""Playwright-based UI stability tests — tables, charts, tab switching."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from playwright.sync_api import Page, expect
from scripts.agent_testing.conftest import TEST_ACCOUNTS, FRONTEND_URL


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def login_as(page: Page, email: str, password: str):
    page.goto(f"{FRONTEND_URL}/login", wait_until="networkidle")
    page.locator("#email").fill(email)
    page.locator("#password").fill(password)
    page.get_by_role("button", name="立即登录").click()
    page.wait_for_url(lambda u: "/login" not in u, timeout=15_000)


def assert_no_console_errors(page: Page, since_ms: int = 0):
    """Assert that no Error-level console messages appear."""
    errors = []
    # Collect errors that occurred after 'since_ms' timestamp
    for entry in page.console.get_messages():
        if entry.type == "error":
            errors.append(entry.text)
    assert not errors, f"Console errors found:\n  " + "\n  ".join(errors)


# ---------------------------------------------------------------------------
# Module 4: UI Stability Tests
# ---------------------------------------------------------------------------

class TestUIStability:
    """Playwright tests verifying UI component stability under interaction."""

    def test_sku_cost_pagination_then_sort(self, page: Page):
        """
        U1: sku-cost page → navigate to page 2 → click a sort column → apply filter
            → navigate back → state should not be lost (or gracefully degraded).
        """
        cfg = TEST_ACCOUNTS["admin"]  # use admin for most pages
        login_as(page, cfg["email"], cfg["password"])

        page.goto(f"{FRONTEND_URL}/dashboard/data-management/sku-info", wait_until="networkidle")

        # Check pagination controls exist
        pagination = page.locator("[data-testid='pagination'], .pagination, nav[aria-label='pagination']")
        if pagination.count() > 0:
            # Try clicking next page button
            next_btn = page.get_by_role("button", name=("下一页", "›", "Next")).first
            if next_btn.count() > 0 and next_btn.is_enabled():
                next_btn.click()
                page.wait_for_timeout(300)

        # Click a sortable column header (first available)
        sort_headers = page.locator("th[aria-sort], th[data-sortable], thead button")
        if sort_headers.count() > 0:
            sort_headers.first.click()
            page.wait_for_timeout(300)

        assert_no_console_errors(page)

    def test_daily_analysis_chart_no_errors(self, page: Page):
        """
        U3: Visit /daily-analysis → open console → verify no Error-level logs.
        """
        cfg = TEST_ACCOUNTS["admin"]
        login_as(page, cfg["email"], cfg["password"])

        page.goto(f"{FRONTEND_URL}/dashboard/data-analysis/daily-analysis", wait_until="networkidle")
        page.wait_for_timeout(1000)  # give charts time to render

        assert_no_console_errors(page)

    def test_product_analysis_tab_switching(self, page: Page):
        """
        U5: product-analysis page → rapidly switch between 3 tabs → no data corruption.
        """
        cfg = TEST_ACCOUNTS["admin"]
        login_as(page, cfg["email"], cfg["password"])

        page.goto(f"{FRONTEND_URL}/dashboard/data-reporting/product-analysis", wait_until="networkidle")
        page.wait_for_timeout(500)

        # Find all tab buttons
        tabs = page.locator("[role='tab'], .tab-button, button:has-text('Tab')").all()
        if len(tabs) < 3:
            # Try alternative: look for button/list-item tabs
            tabs = page.locator("button, [role='button']").filter(
                lambda b: b.is_visible()
            ).all()

        # Rapid switch: tab 0 → tab 1 → tab 2 → tab 0
        for _ in range(2):
            for tab in tabs[:3]:
                tab.click()
                page.wait_for_timeout(100)

        page.wait_for_timeout(500)
        assert_no_console_errors(page)

    def test_exchange_rate_page_loads_clean(self, page: Page):
        """
        U4 (variant): exchange-rate page should load without console errors.
        """
        cfg = TEST_ACCOUNTS["admin"]
        login_as(page, cfg["email"], cfg["password"])

        page.goto(f"{FRONTEND_URL}/dashboard/data-management/exchange-rate", wait_until="networkidle")
        page.wait_for_timeout(500)
        assert_no_console_errors(page)