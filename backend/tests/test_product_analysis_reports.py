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
    def fake_build_path(settings, project_name, file_type, file_id):  # noqa: ARG001
        return f'/tmp/{project_name}-{file_type}-{file_id}'

    monkeypatch.setattr('app.api.v1.endpoints.product_analysis_reports.upload_service.build_upload_file_path', fake_build_path)

    def fake_create_task(settings, *, report_type, input_path, params):  # noqa: ARG001
        assert report_type == 'product_analysis'
        assert input_path.endswith('business_report-biz.csv')
        assert params['file_ids']['business_report'] == 'biz.csv'
        assert params['file_ids']['payment_report'] == 'pay.csv'
        assert params['file_ids']['ad_report'] == 'ad.xlsx'
        assert params['file_ids']['inventory_report'] == 'inv.txt'
        return SimpleNamespace(id=789, status='pending', created_at=datetime.now(UTC))

    monkeypatch.setattr(
        'app.api.v1.endpoints.product_analysis_reports.analysis_report_runtime_service.create_task',
        fake_create_task,
    )

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
    assert payload['status_endpoint'] == '/api/v1/product-analysis-reports/tasks/789'
    assert payload['result_endpoint'] == '/api/v1/product-analysis-reports/tasks/789/result'
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


def test_product_analysis_task_status(monkeypatch):
    now = datetime.now(UTC)
    monkeypatch.setattr(
        'app.api.v1.endpoints.product_analysis_reports.analysis_report_runtime_service.get_task',
        lambda task_id: SimpleNamespace(
            id=task_id,
            report_type='product_analysis',
            status='running',
            stage='processing',
            progress=22,
            message='处理中',
            error_message=None,
            persistence_status='running',
            persistence_message='syncing',
            created_at=now,
            updated_at=now,
        ),
    )
    response = client.get('/api/v1/product-analysis-reports/tasks/9', headers={'X-API-Key': get_settings().api_key})
    assert response.status_code == 200
    payload = response.json()
    assert payload['task_id'] == 9
    assert payload['status'] == 'running'
    assert payload['persistence_status'] == 'running'


def test_product_analysis_task_result(monkeypatch):
    monkeypatch.setattr(
        'app.api.v1.endpoints.product_analysis_reports.analysis_report_runtime_service.get_task',
        lambda task_id: SimpleNamespace(
            id=task_id,
            report_type='product_analysis',
            status=SimpleNamespace(value='success'),
            result_path=__file__,
        ),
    )
    response = client.get('/api/v1/product-analysis-reports/tasks/9/result', headers={'X-API-Key': get_settings().api_key})
    assert response.status_code == 200
