from datetime import UTC, datetime
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app

client = TestClient(app)


def test_product_analysis_reports_requires_api_key():
    response = client.post(
        '/api/v1/product-analysis-reports',
        json={
            'project_name': 'Demo',
            'report_start_date': '2026-02-01',
            'report_end_date': '2026-02-07',
            'business_report_file_id': 'b.csv',
            'payment_report_file_id': 'p.csv',
            'ad_report_file_id': 'a.xlsx',
        },
    )
    assert response.status_code == 401


def test_product_analysis_reports_creates_job(monkeypatch):
    def fake_enqueue_job(db, settings, payload):  # noqa: ARG001
        assert payload['job_type'] == 'product_analysis'
        assert payload['file_id'] == 'biz.csv'
        assert payload['params']['file_ids']['business_report'] == 'biz.csv'
        assert payload['params']['file_ids']['payment_report'] == 'pay.csv'
        assert payload['params']['file_ids']['ad_report'] == 'ad.xlsx'
        assert payload['params']['file_ids']['inventory_report'] == 'inv.txt'
        return SimpleNamespace(id=789, status='pending', created_at=datetime.now(UTC))

    monkeypatch.setattr('app.api.v1.endpoints.product_analysis_reports.job_service.enqueue_job', fake_enqueue_job)

    response = client.post(
        '/api/v1/product-analysis-reports',
        headers={'X-API-Key': get_settings().api_key},
        json={
            'project_name': 'Demo',
            'report_start_date': '2026-02-01',
            'report_end_date': '2026-02-07',
            'business_report_file_id': 'biz.csv',
            'payment_report_file_id': 'pay.csv',
            'ad_report_file_id': 'ad.xlsx',
            'inventory_report_file_id': 'inv.txt',
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload['job_id'] == 789
    assert payload['status'] == 'pending'


def test_product_analysis_reports_rejects_invalid_date_range():
    response = client.post(
        '/api/v1/product-analysis-reports',
        headers={'X-API-Key': get_settings().api_key},
        json={
            'project_name': 'Demo',
            'report_start_date': '2026-02-08',
            'report_end_date': '2026-02-07',
            'business_report_file_id': 'biz.csv',
            'payment_report_file_id': 'pay.csv',
            'ad_report_file_id': 'ad.xlsx',
        },
    )
    assert response.status_code == 400
