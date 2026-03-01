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
    def fake_build_path(settings, project_name, file_type, file_id):  # noqa: ARG001
        return f'/tmp/{project_name}-{file_type}-{file_id}'

    monkeypatch.setattr('app.api.v1.endpoints.daily_reports.upload_service.build_upload_file_path', fake_build_path)

    def fake_create_task(settings, *, report_type, input_path, params):  # noqa: ARG001
        assert report_type == 'daily_report'
        assert input_path.endswith('sales_report-sales.txt')
        assert params['file_ids']['sales_report'] == 'sales.txt'
        assert params['file_ids']['ad_report'] == 'ad.xlsx'
        assert params['file_ids']['inventory_report'] == 'inventory.txt'
        return SimpleNamespace(
            id=456,
            status='pending',
            created_at=datetime.now(UTC),
        )

    monkeypatch.setattr('app.api.v1.endpoints.daily_reports.analysis_report_runtime_service.create_task', fake_create_task)

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
    assert payload['status_endpoint'] == '/api/v1/daily-reports/tasks/456'
    assert payload['result_endpoint'] == '/api/v1/daily-reports/tasks/456/result'
    assert payload['status'] == 'pending'


def test_daily_report_task_status(monkeypatch):
    now = datetime.now(UTC)
    monkeypatch.setattr(
        'app.api.v1.endpoints.daily_reports.analysis_report_runtime_service.get_task',
        lambda task_id: SimpleNamespace(
            id=task_id,
            report_type='daily_report',
            status='running',
            stage='processing',
            progress=30,
            message='处理中',
            error_message=None,
            created_at=now,
            updated_at=now,
        ),
    )

    response = client.get('/api/v1/daily-reports/tasks/456', headers={'X-API-Key': get_settings().api_key})
    assert response.status_code == 200
    payload = response.json()
    assert payload['task_id'] == 456
    assert payload['status'] == 'running'


def test_daily_report_task_result(monkeypatch):
    monkeypatch.setattr(
        'app.api.v1.endpoints.daily_reports.analysis_report_runtime_service.get_task',
        lambda task_id: SimpleNamespace(
            id=task_id,
            report_type='daily_report',
            status=SimpleNamespace(value='success'),
            result_path=__file__,
        ),
    )

    response = client.get('/api/v1/daily-reports/tasks/456/result', headers={'X-API-Key': get_settings().api_key})
    assert response.status_code == 200
