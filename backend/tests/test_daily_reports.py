from datetime import UTC, datetime
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app

client = TestClient(app)


def test_daily_reports_requires_api_key():
    response = client.post(
        '/api/v1/daily-reports',
        json={
            'project_name': 'Demo',
            'report_date': '2026-02-25',
            'sales_report_file_id': 'a.txt',
            'ad_report_file_id': 'b.xlsx',
            'inventory_report_file_id': 'c.txt',
        },
    )
    assert response.status_code == 401


def test_daily_reports_creates_job(monkeypatch):
    def fake_enqueue_job(db, settings, payload, operator=None):  # noqa: ARG001
        assert payload['job_type'] == 'daily_report'
        assert payload['file_id'] == 'sales.txt'
        assert payload['params']['file_ids']['sales_report'] == 'sales.txt'
        assert payload['params']['file_ids']['ad_report'] == 'ad.xlsx'
        assert payload['params']['file_ids']['inventory_report'] == 'inventory.txt'
        assert operator == 'operator@example.com'
        return SimpleNamespace(
            id=456,
            status='pending',
            created_at=datetime.now(UTC),
        )

    monkeypatch.setattr('app.api.v1.endpoints.daily_reports.job_service.enqueue_job', fake_enqueue_job)

    response = client.post(
        '/api/v1/daily-reports',
        headers={'X-API-Key': get_settings().api_key, 'X-Operator': 'operator@example.com'},
        json={
            'project_name': 'Demo',
            'report_date': '2026-02-25',
            'sales_report_file_id': 'sales.txt',
            'ad_report_file_id': 'ad.xlsx',
            'inventory_report_file_id': 'inventory.txt',
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload['job_id'] == 456
    assert payload['status'] == 'pending'
