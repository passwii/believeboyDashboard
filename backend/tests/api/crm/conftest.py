"""CRM API 集成测试夹具。

端点调用走独立 session 并 commit，根 conftest 的 ``db_session`` 回滚清不掉，
故这里用 autouse 夹具 ``TRUNCATE ... RESTART IDENTITY CASCADE``（独立 committing
session）在每个测试前清空 CRM 表，保证 scope/count 断言确定。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text


@pytest.fixture
def client() -> TestClient:
    from app.main import app

    return TestClient(app)


@pytest.fixture(autouse=True)
def _clean_crm_tables(db_session):
    """每个测试前清空 CRM 表（独立 session + commit）。

    依赖 db_session 以继承“无 TEST_DATABASE_URL 则 skip”保护。
    """
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(
            text(
                "truncate crm_audit_logs, crm_follows, crm_contacts, "
                "crm_leads, crm_customers, crm_saved_views, "
                "crm_proposal_versions, crm_proposals restart identity cascade"
            )
        )
        s.commit()
    finally:
        s.close()
    yield
