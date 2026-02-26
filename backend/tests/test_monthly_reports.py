from datetime import datetime, UTC
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app

client = TestClient(app)


def test_monthly_reports_requires_api_key():
    response = client.post(
        '/api/v1/monthly-reports',
        json={
            'project_name': 'Demo',
            'report_month': '2026-01',
            'transaction_file_id': 'a.csv',
            'summary_pdf_file_id': 'b.pdf',
        },
    )
    assert response.status_code == 401


def test_monthly_reports_creates_job(monkeypatch):
    def fake_enqueue_job(db, settings, payload):  # noqa: ARG001
        assert payload['job_type'] == 'monthly_report'
        assert payload['params']['file_ids']['transaction_report'] == 'a.csv'
        assert payload['params']['file_ids']['monthly_summary_pdf'] == 'b.pdf'
        return SimpleNamespace(
            id=123,
            status='pending',
            created_at=datetime.now(UTC),
        )

    monkeypatch.setattr('app.api.v1.endpoints.monthly_reports.job_service.enqueue_job', fake_enqueue_job)

    response = client.post(
        '/api/v1/monthly-reports',
        headers={'X-API-Key': get_settings().api_key},
        json={
            'project_name': 'Demo',
            'report_month': '2026-01',
            'transaction_file_id': 'a.csv',
            'summary_pdf_file_id': 'b.pdf',
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload['job_id'] == 123
    assert payload['status'] == 'pending'
