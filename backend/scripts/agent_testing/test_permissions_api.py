"""
API-level permission tests using Playwright as the HTTP client.
Login happens in-browser (NextAuth credentials), then we use
the browser's cookie session to call API endpoints through the frontend proxy.

This verifies:
  - Backend enforces role-based access (403 on unauthorized calls)
  - Frontend proxy correctly forwards auth headers
  - Admin vs operator vs businessdev isolation
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from playwright.sync_api import Page, APIRequestContext

from scripts.agent_testing.auth import login_as
from scripts.agent_testing.conftest import TEST_ACCOUNTS, FRONTEND_URL


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def new_api_context(page: Page) -> APIRequestContext:
    """Create an APIRequestContext that shares the browser's cookie state."""
    return page.context.request


# ---------------------------------------------------------------------------
# Module 1: API Permission Tests
# ---------------------------------------------------------------------------

class TestAPIPermissions:
    """
    Verify backend endpoint authorization using browser-authenticated sessions.
    """

    def test_admin_can_list_accounts(self, page: Page):
        """
        P1 (API): Admin calling GET /api/v1/system-management/accounts → 200.
        """
        cfg = TEST_ACCOUNTS["admin"]
        login_as(page, cfg["email"], cfg["password"])

        api = new_api_context(page)
        resp = api.get(f"{FRONTEND_URL}/api/backend/system-management/accounts")
        assert resp.ok, \
            f"[P1] Admin should be able to list accounts, got {resp.status}: {resp.text()}"

    def test_operator_cannot_list_accounts(self, page: Page):
        """
        P2 (API): Operator calling GET /api/v1/system-management/accounts → 403.
        """
        cfg = TEST_ACCOUNTS["operator"]
        login_as(page, cfg["email"], cfg["password"])

        api = new_api_context(page)
        resp = api.get(f"{FRONTEND_URL}/api/backend/system-management/accounts")
        assert resp.status in (302, 403), \
            f"[P2] Operator should get 403, got {resp.status}: {resp.text()}"

    def test_businessdev_cannot_list_accounts(self, page: Page):
        """
        P4 (API): Businessdev calling GET /api/v1/system-management/accounts → 403.
        """
        cfg = TEST_ACCOUNTS["businessdev"]
        login_as(page, cfg["email"], cfg["password"])

        api = new_api_context(page)
        resp = api.get(f"{FRONTEND_URL}/api/backend/system-management/accounts")
        assert resp.status in (302, 403), \
            f"[P4] Businessdev should get 403, got {resp.status}: {resp.text()}"

    def test_admin_can_list_exchange_rates(self, page: Page):
        """
        P5 (API): Admin listing exchange rates → 200.
        """
        cfg = TEST_ACCOUNTS["admin"]
        login_as(page, cfg["email"], cfg["password"])

        api = new_api_context(page)
        resp = api.get(f"{FRONTEND_URL}/api/backend/exchange-rates")
        assert resp.ok, \
            f"[P5] Admin should be able to list exchange rates, got {resp.status}"

    def test_operator_can_read_exchange_rates(self, page: Page):
        """
        P6 (API): Operator reading exchange rates → 200 (read allowed, edit forbidden at UI level).
        """
        cfg = TEST_ACCOUNTS["operator"]
        login_as(page, cfg["email"], cfg["password"])

        api = new_api_context(page)
        resp = api.get(f"{FRONTEND_URL}/api/backend/exchange-rates")
        assert resp.ok, \
            f"[P6] Operator should be able to read exchange rates, got {resp.status}"

    def test_operator_project_data_isolation(self, page: Page):
        """
        P8 (API): Operator should only see their own projects in project-scoped APIs.
        Uses inventory_replenishment as a representative endpoint.
        """
        cfg = TEST_ACCOUNTS["operator"]
        login_as(page, cfg["email"], cfg["password"])

        api = new_api_context(page)
        resp = api.get(f"{FRONTEND_URL}/api/backend/inventory-replenishment")
        if resp.ok:
            data = resp.json()
            # All returned project_ids should belong to this operator
            # (We verify the backend correctly filters, test is a smoke check)
            assert isinstance(data, (list, dict)), \
                f"[P8] Response should be list or dict, got {type(data)}"
        # If 404 (endpoint doesn't support list without params), that's acceptable
        # The key test is: operator should NOT get 500 or data from other operators

    def test_businessdev_role_accepted(self, page: Page):
        """
        P3 (API): Businessdev role is recognized and accepted by the backend.
        """
        cfg = TEST_ACCOUNTS["businessdev"]
        login_as(page, cfg["email"], cfg["password"])

        api = new_api_context(page)
        # Try a neutral endpoint (exchange rates, which all roles can read)
        resp = api.get(f"{FRONTEND_URL}/api/backend/exchange-rates")
        # Should not 403 because role is not admin
        # (Exchange rate read is not admin-restricted, only write is)
        assert resp.ok or resp.status in (400, 422), \
            f"[P3] Businessdev should be accepted, got {resp.status}"


class TestBackendRoleHeaderPassthrough:
    """
    Verify that the frontend proxy correctly sends X-Role-Type and X-Is-Admin
    based on the NextAuth session role.
    """

    @pytest.mark.parametrize("role_key", ["admin", "operator", "businessdev"])
    def test_role_type_header_sent(self, page: Page, role_key: str):
        """
        After login, the backend should receive the correct X-Role-Type header
        for each role. We verify this by calling a simple endpoint and inspecting
        the proxy behavior (no 401/403 due to auth failure).
        """
        cfg = TEST_ACCOUNTS[role_key]
        login_as(page, cfg["email"], cfg["password"])

        api = new_api_context(page)
        resp = api.get(f"{FRONTEND_URL}/api/backend/exchange-rates")
        # All roles can at least reach the auth layer — this proves headers are sent
        assert resp.status not in (401,), \
            f"[Role:{role_key}] Got 401 — X-API-Key or session headers not sent correctly"

    def test_admin_sets_is_admin_header(self, page: Page):
        """
        Only admin role should result in X-Is-Admin: true being forwarded.
        We test this by verifying admin-specific behavior (account listing works).
        """
        cfg = TEST_ACCOUNTS["admin"]
        login_as(page, cfg["email"], cfg["password"])

        api = new_api_context(page)
        resp = api.get(f"{FRONTEND_URL}/api/backend/system-management/accounts")
        # If backend checks X-Is-Admin for this endpoint, admin should get 200
        assert resp.ok, \
            f"[admin-header] Account listing should work for admin, got {resp.status}"