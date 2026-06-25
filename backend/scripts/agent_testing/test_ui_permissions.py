"""Playwright-based UI permission tests — verifies role-based UI behavior."""
import os
import pytest
from playwright.sync_api import Page, expect

# Import shared config
import sys
sys.path.insert(0, str(__file__).rsplit("/", 3)[0])
from scripts.agent_testing.conftest import TEST_ACCOUNTS, FRONTEND_URL


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def login_as(page: Page, email: str, password: str):
    """Log in via NextAuth credentials provider and wait for redirect."""
    page.goto(f"{FRONTEND_URL}/login", wait_until="networkidle")
    page.locator("#email").fill(email)
    page.locator("#password").fill(password)
    page.get_by_role("button", name="立即登录").click()
    page.wait_for_url(lambda u: "/login" not in u, timeout=15_000)


def assert_contains_text(page: Page, text: str, timeout: int = 5000):
    expect(page.get_by_text(text, include_hidden=False)).toBeVisible(timeout=timeout)


# ---------------------------------------------------------------------------
# Module 1b: UI Permission Tests
# ---------------------------------------------------------------------------

class TestUIPermissions:
    """Playwright tests verifying UI-level permission controls."""

    def test_operator_exchange_rate_edit_disabled(self, page: Page):
        """
        P6: Operator role → exchange-rate edit button is disabled.
        """
        cfg = TEST_ACCOUNTS["operator"]
        login_as(page, cfg["email"], cfg["password"])

        page.goto(f"{FRONTEND_URL}/dashboard/data-management/exchange-rate", wait_until="networkidle")

        # Look for any edit/save/add buttons and verify they are disabled
        edit_buttons = page.get_by_role("button").filter(has=page.locator("[disabled], [aria-disabled='true']"))
        # Alternative: check if there are buttons that are disabled
        disabled_edits = page.locator("button[disabled]").filter(
            lambda btn: any(kw in btn.inner_text() for kw in ["编辑", "新增", "添加", "保存"])
        )

        # The page should have at least one "disabled" variant of edit/save/add
        # We assert: NOT any enabled edit button
        all_edit_buttons = page.get_by_role("button").filter(
            lambda btn: any(kw in btn.inner_text() for kw in ["编辑", "新增", "添加", "保存"])
        )
        for btn in all_edit_buttons.all():
            if btn.is_enabled():
                pytest.fail(f"[P6] Operator should not have enabled edit button: {btn.inner_text()!r}")

    def test_middleware_redirect_operator(self, page: Page):
        """
        P2: Operator attempting to access /system-management → redirect to forbidden.
        """
        cfg = TEST_ACCOUNTS["operator"]
        login_as(page, cfg["email"], cfg["password"])

        page.goto(f"{FRONTEND_URL}/dashboard/system-management/account-management")
        # Should be redirected to /dashboard?forbidden=1
        assert "?forbidden=1" in page.url or page.url.endswith("/dashboard"), \
            f"[P2] Operator should be redirected from system-management, got: {page.url}"

    def test_middleware_redirect_businessdev(self, page: Page):
        """
        P4: Businessdev attempting to access /system-management → redirect to forbidden.
        """
        cfg = TEST_ACCOUNTS["businessdev"]
        login_as(page, cfg["email"], cfg["password"])

        page.goto(f"{FRONTEND_URL}/dashboard/system-management/account-management")
        assert "?forbidden=1" in page.url or page.url.endswith("/dashboard"), \
            f"[P4] Businessdev should be redirected from system-management, got: {page.url}"

    def test_admin_can_access_system_management(self, page: Page):
        """
        P1: Admin can access /system-management without redirect.
        """
        cfg = TEST_ACCOUNTS["admin"]
        login_as(page, cfg["email"], cfg["password"])

        page.goto(f"{FRONTEND_URL}/dashboard/system-management/account-management")
        assert "forbidden" not in page.url, \
            f"[P1] Admin should access system-management, got: {page.url}"
        assert "account-management" in page.url or "system-management" in page.url, \
            f"[P1] URL should contain account-management or system-management, got: {page.url}"

    def test_admin_exchange_rate_edit_enabled(self, page: Page):
        """
        P5: Admin role → exchange-rate edit button is enabled.
        """
        cfg = TEST_ACCOUNTS["admin"]
        login_as(page, cfg["email"], cfg["password"])

        page.goto(f"{FRONTEND_URL}/dashboard/data-management/exchange-rate", wait_until="networkidle")

        # Look for at least one non-disabled edit/add button
        enabled_edit = page.get_by_role("button").filter(
            lambda btn: any(kw in btn.inner_text() for kw in ["编辑", "新增", "添加"])
        ).first
        if enabled_edit.count() > 0:
            assert enabled_edit.is_enabled(), \
                f"[P5] Admin should have enabled edit button for exchange-rate"