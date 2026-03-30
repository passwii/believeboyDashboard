from datetime import datetime, UTC
from pathlib import Path
from types import SimpleNamespace

from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app
from app.models.job import JobStatus
from app.services import monthly_report_service
from app.tasks.scripts import monthly_report as monthly_report_script

client = TestClient(app)


def test_monthly_reports_requires_api_key():
    response = client.post(
        '/api/v1/monthly-reports',
        json={
            'project_id': 1,
            'report_month': '2026-01',
            'transaction_file_id': 'a.csv',
            'summary_pdf_file_id': 'b.pdf',
        },
    )
    assert response.status_code == 401


def test_monthly_reports_creates_job(monkeypatch):
    monkeypatch.setattr(
        'app.api.v1.endpoints.monthly_reports.upload_service.build_upload_file_path',
        lambda settings, project_name, file_type, file_id: Path(__file__).resolve(),  # noqa: ARG005
    )

    def fake_create_task(
        settings, *, project_id, project_name, report_month, transaction_file_id, summary_pdf_file_id, resolved_file_paths  # noqa: ARG001
    ):
        assert project_id == 11
        assert project_name == 'Demo'
        assert report_month == '2026-01'
        assert transaction_file_id == 'a.csv'
        assert summary_pdf_file_id == 'b.pdf'
        assert resolved_file_paths['transaction_report']
        assert resolved_file_paths['monthly_summary_pdf']
        return SimpleNamespace(
            id=123,
            status=JobStatus.pending,
            created_at=datetime.now(UTC),
        )

    monkeypatch.setattr('app.api.v1.endpoints.monthly_reports.monthly_report_runtime_service.create_task', fake_create_task)

    response = client.post(
        '/api/v1/monthly-reports',
        headers={'X-API-Key': get_settings().api_key, 'X-Operator': 'operator@example.com'},
        json={
            'project_id': 11,
            'project_name': 'Demo',
            'report_month': '2026-01',
            'transaction_file_id': 'a.csv',
            'summary_pdf_file_id': 'b.pdf',
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload['job_id'] == 123
    assert payload['monthly_report_id'] is None
    assert payload['status_endpoint'] == '/api/v1/monthly-reports/tasks/123'
    assert payload['result_endpoint'] == '/api/v1/monthly-reports/tasks/123/result'
    assert payload['status'] == 'pending'


def test_monthly_reports_creates_job_without_pdf(monkeypatch):
    monkeypatch.setattr(
        'app.api.v1.endpoints.monthly_reports.upload_service.build_upload_file_path',
        lambda settings, project_name, file_type, file_id: Path(__file__).resolve(),  # noqa: ARG005
    )

    def fake_create_task(
        settings, *, project_id, project_name, report_month, transaction_file_id, summary_pdf_file_id, resolved_file_paths  # noqa: ARG001
    ):
        assert project_id == 11
        assert project_name == 'Demo'
        assert report_month == '2026-01'
        assert transaction_file_id == 'a.csv'
        assert summary_pdf_file_id is None
        assert resolved_file_paths['transaction_report']
        assert 'monthly_summary_pdf' not in resolved_file_paths
        return SimpleNamespace(
            id=124,
            status=JobStatus.pending,
            created_at=datetime.now(UTC),
        )

    monkeypatch.setattr('app.api.v1.endpoints.monthly_reports.monthly_report_runtime_service.create_task', fake_create_task)

    response = client.post(
        '/api/v1/monthly-reports',
        headers={'X-API-Key': get_settings().api_key, 'X-Operator': 'operator@example.com'},
        json={
            'project_id': 11,
            'project_name': 'Demo',
            'report_month': '2026-01',
            'transaction_file_id': 'a.csv',
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload['job_id'] == 124
    assert payload['status'] == 'pending'


def test_monthly_report_csv_reader_ignores_none_header_key(tmp_path: Path):
    sample = tmp_path / 'sample.csv'
    sample.write_text(
        '\n'.join([
            'meta-1',
            'meta-2',
            'meta-3',
            'meta-4',
            'meta-5',
            'meta-6',
            'meta-7',
            'date/time,type,description,quantity',
            '"Mar 01, 2026 01:23:45 PM UTC",Order,Normal,2,unexpected-extra-cell',
        ]),
        encoding='utf-8',
    )

    rows = monthly_report_script._read_transactions(str(sample))

    assert len(rows) == 1
    assert rows[0]['type'] == 'Order'
    assert rows[0]['description'] == 'Normal'
    assert rows[0]['quantity'] == 2


def test_monthly_report_csv_reader_finds_dynamic_header_row(tmp_path: Path):
    sample = tmp_path / 'sample_dynamic_header.csv'
    sample.write_text(
        '\n'.join([
            'meta-1',
            'meta-2',
            'meta-3',
            'meta-4',
            'meta-5',
            'meta-6',
            'meta-7',
            'meta-8',
            'meta-9',
            'date/time,type,quantity,total',
            '"Mar 01, 2026 01:23:45 PM UTC",Order,1,12.34',
        ]),
        encoding='utf-8',
    )

    rows = monthly_report_script._read_transactions(str(sample))

    assert len(rows) == 1
    assert rows[0]['date/time'] == 'Mar 01, 2026 01:23:45 PM UTC'
    assert rows[0]['type'] == 'Order'
    assert rows[0]['quantity'] == 1


def test_monthly_report_csv_reader_skips_blank_rows(tmp_path: Path):
    sample = tmp_path / 'sample_blank.csv'
    sample.write_text(
        '\n'.join([
            'meta-1',
            'meta-2',
            'meta-3',
            'meta-4',
            'meta-5',
            'meta-6',
            'meta-7',
            'date/time,type,quantity',
            ',,',
            '"Mar 01, 2026 01:23:45 PM UTC",Order,1',
        ]),
        encoding='utf-8',
    )

    rows = monthly_report_script._read_transactions(str(sample))

    assert len(rows) == 1
    assert rows[0]['type'] == 'Order'
    assert rows[0]['quantity'] == 1


def test_monthly_reports_list(monkeypatch):
    monkeypatch.setattr(
        'app.api.v1.endpoints.monthly_reports.monthly_report_service.list_reports',
        lambda db, project_id=None, report_month=None, current_only=True: [
            SimpleNamespace(
                id=1,
                project_id=11,
                project_name='Demo',
                report_month='2026-01',
                version=2,
                is_current=True,
                superseded_at=None,
                status='success',
                settlement_id='S1',
                total_transactions=100,
                total_orders=80,
                total_refunds=10,
                total_adjustments=5,
                total_service_fees=4,
                total_trans_fees=1,
                result_file_path='/tmp/r.xlsx',
                error_message=None,
                calculation_version=1,
                computed_at=datetime.now(UTC),
                created_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
            )
        ],
    )

    response = client.get('/api/v1/monthly-reports?project_id=11', headers={'X-API-Key': get_settings().api_key})
    assert response.status_code == 200
    payload = response.json()
    assert len(payload) == 1
    assert payload[0]['id'] == 1
    assert payload[0]['project_name'] == 'Demo'


def test_monthly_reports_list_include_history(monkeypatch):
    captured: dict[str, bool] = {}

    def fake_list_reports(db, project_id=None, report_month=None, current_only=True):  # noqa: ARG001
        captured['current_only'] = current_only
        return []

    monkeypatch.setattr('app.api.v1.endpoints.monthly_reports.monthly_report_service.list_reports', fake_list_reports)

    response = client.get('/api/v1/monthly-reports?include_history=true', headers={'X-API-Key': get_settings().api_key})
    assert response.status_code == 200
    assert captured['current_only'] is False


def test_monthly_reports_detail(monkeypatch):
    monkeypatch.setattr(
        'app.api.v1.endpoints.monthly_reports.monthly_report_service.get_report_detail',
        lambda db, report_id: (  # noqa: ARG005
            SimpleNamespace(
                id=report_id,
                project_id=11,
                project_name='Demo',
                report_month='2026-01',
                version=2,
                is_current=True,
                superseded_at=None,
                status='success',
                settlement_id='S1',
                total_transactions=100,
                total_orders=80,
                total_refunds=10,
                total_adjustments=5,
                total_service_fees=4,
                total_trans_fees=1,
                result_file_path='/tmp/r.xlsx',
                error_message=None,
                calculation_version=1,
                computed_at=datetime.now(UTC),
                created_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
            ),
            SimpleNamespace(
                __table__=SimpleNamespace(columns=[SimpleNamespace(name='income_total')]),
                income_total=123.45,
            ),
            SimpleNamespace(
                __table__=SimpleNamespace(columns=[SimpleNamespace(name='expense_total')]),
                expense_total=67.89,
            ),
        ),
    )

    response = client.get('/api/v1/monthly-reports/1', headers={'X-API-Key': get_settings().api_key})
    assert response.status_code == 200
    payload = response.json()
    assert payload['report']['id'] == 1
    assert payload['report']['project_name'] == 'Demo'
    assert payload['pt3']['income_total'] == 123.45


def test_monthly_reports_export(monkeypatch):
    monkeypatch.setattr(
        'app.api.v1.endpoints.monthly_reports.monthly_report_service.get_report_or_404',
        lambda db, report_id: SimpleNamespace(
            id=report_id,
            status=JobStatus.success,
            result_file_path=str(Path(__file__).resolve()),
        ),  # noqa: ARG005
    )
    monkeypatch.setattr(
        'app.api.v1.endpoints.monthly_reports.monthly_report_service.resolve_result_path',
        lambda report: Path(__file__).resolve(),  # noqa: ARG005
    )

    response = client.get('/api/v1/monthly-reports/1/export', headers={'X-API-Key': get_settings().api_key})
    assert response.status_code == 200


def test_monthly_report_task_status(monkeypatch):
    now = datetime.now(UTC)
    monkeypatch.setattr(
        'app.api.v1.endpoints.monthly_reports.monthly_report_runtime_service.get_task',
        lambda task_id: SimpleNamespace(
            id=task_id,
            status=JobStatus.running,
            stage='processing',
            progress=40,
            message='处理中',
            error_message=None,
            persistence_status='running',
            persistence_message='syncing',
            created_at=now,
            updated_at=now,
        ),
    )
    response = client.get('/api/v1/monthly-reports/tasks/7', headers={'X-API-Key': get_settings().api_key})
    assert response.status_code == 200
    payload = response.json()
    assert payload['task_id'] == 7
    assert payload['status'] == 'running'
    assert payload['progress'] == 40
    assert payload['persistence_status'] == 'running'


def test_monthly_report_task_result(monkeypatch):
    path = Path(__file__).resolve()
    now = datetime.now(UTC)
    monkeypatch.setattr(
        'app.api.v1.endpoints.monthly_reports.monthly_report_runtime_service.get_task',
        lambda task_id: SimpleNamespace(
            id=task_id,
            status=JobStatus.success,
            stage='completed',
            progress=100,
            message='done',
            error_message=None,
            persistence_status='success',
            persistence_message='ok',
            result_path=str(path),
            created_at=now,
            updated_at=now,
        ),
    )
    response = client.get('/api/v1/monthly-reports/tasks/7/result', headers={'X-API-Key': get_settings().api_key})
    assert response.status_code == 200


def test_monthly_report_financial_series_api(monkeypatch):
    monkeypatch.setattr(
        'app.api.v1.endpoints.monthly_reports.project_service.ensure_project_access',
        lambda db, project_id, operator, is_admin: None,  # noqa: ARG005
    )
    monkeypatch.setattr(
        'app.api.v1.endpoints.monthly_reports.monthly_report_service.get_financial_series',
        lambda db, project_id, start_month, end_month, fill_missing: {  # noqa: ARG005
            'project_id': project_id,
            'project_name': 'Demo',
            'start_month': '2025-07',
            'end_month': '2025-09',
            'rows': [
                {
                    'report_month': '2025-07',
                    'income_sales': 100.0,
                    'income_refund': 0.0,
                    'income_adjustment': 0.0,
                    'income_other': 0.0,
                    'expense_selling_fee': -10.0,
                    'expense_fba_fee': -20.0,
                    'expense_inventory_fee': -3.0,
                    'expense_service_fee': -2.0,
                    'expense_advertising': -15.0,
                    'expense_other_fees': -1.0,
                    'income_total': 100.0,
                    'expense_total': -51.0,
                    'amazon_pay_back': 49.0,
                    'has_source_report': True,
                }
            ],
            'trend': {
                'income_total_sum': 100.0,
                'expense_total_sum': -51.0,
                'amazon_pay_back_sum': 49.0,
                'net_amount_sum': 49.0,
                'points': [
                    {
                        'report_month': '2025-07',
                        'income_total': 100.0,
                        'expense_total': -51.0,
                        'amazon_pay_back': 49.0,
                        'net_amount': 49.0,
                        'has_source_report': True,
                    }
                ],
            },
        },
    )

    response = client.get(
        '/api/v1/monthly-reports/financial-series?project_id=11&start_month=2025-07&end_month=2025-09',
        headers={'X-API-Key': get_settings().api_key},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload['project_id'] == 11
    assert payload['rows'][0]['report_month'] == '2025-07'


def test_financial_series_fill_missing_rows_and_zero_values(monkeypatch):
    class FakeQueryResult:
        def __init__(self, rows):
            self._rows = rows

        def all(self):
            return self._rows

    class FakeDB:
        def get(self, _model, project_id):
            return SimpleNamespace(id=project_id, project_name='Demo')

        def execute(self, _stmt):
            pt4 = SimpleNamespace(
                income_sales=120.0,
                income_refund=-10.0,
                income_adjustment=5.0,
                income_other=0.0,
                expense_selling_fee=-8.0,
                expense_fba_fee=-20.0,
                expense_inventory_fee=-3.0,
                expense_service_fee=-1.0,
                expense_advertising=-12.0,
                expense_other_fees=-2.0,
                income_total=115.0,
                expense_total=-46.0,
                amazon_pay_back=69.0,
            )
            report = SimpleNamespace(id=1, report_month='2025-07')
            return FakeQueryResult([(report, pt4)])

    monkeypatch.setattr(monthly_report_service, 'ensure_tables', lambda db: None)
    monkeypatch.setattr(monthly_report_service, '_load_monthly_cost_totals', lambda *args, **kwargs: {})
    payload = monthly_report_service.get_financial_series(
        FakeDB(),
        project_id=11,
        start_month='2025-07',
        end_month='2025-09',
        fill_missing=True,
    )
    assert [row['report_month'] for row in payload['rows']] == ['2025-07', '2025-08', '2025-09']
    assert payload['rows'][1]['income_total'] == 0.0
    assert payload['rows'][1]['has_source_report'] is False
    assert payload['rows'][1]['fob_cost_rmb'] == 0.0
    assert payload['rows'][1]['first_leg_cost_rmb'] == 0.0


def test_financial_series_filters_current_reports_in_query(monkeypatch):
    class FakeQueryResult:
        def all(self):
            return []

    class FakeDB:
        last_stmt = ''

        def get(self, _model, project_id):
            return SimpleNamespace(id=project_id, project_name='Demo')

        def execute(self, stmt):
            self.last_stmt = str(stmt)
            return FakeQueryResult()

    fake_db = FakeDB()
    monkeypatch.setattr(monthly_report_service, 'ensure_tables', lambda db: None)
    monkeypatch.setattr(monthly_report_service, '_load_monthly_cost_totals', lambda *args, **kwargs: {})
    monthly_report_service.get_financial_series(fake_db, project_id=11, fill_missing=False)
    assert 'monthly_reports.is_current' in fake_db.last_stmt


def test_financial_series_invalid_month_raises_400(monkeypatch):
    class FakeDB:
        def get(self, _model, project_id):
            return SimpleNamespace(id=project_id, project_name='Demo')

    monkeypatch.setattr(monthly_report_service, 'ensure_tables', lambda db: None)
    try:
        monthly_report_service.get_financial_series(
            FakeDB(),
            project_id=11,
            start_month='2025-13',
            end_month='2025-09',
        )
        assert False, 'expected HTTPException'
    except HTTPException as exc:
        assert exc.status_code == 400
