from datetime import UTC, date, datetime
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app

client = TestClient(app)


def _source_row(source_id: int = 1, report_type: str = 'payment_report') -> SimpleNamespace:
    now = datetime.now(UTC)
    return SimpleNamespace(
        id=source_id,
        project_id=11,
        report_type=report_type,
        report_date=date(2026, 2, 7) if report_type == 'business_report' else None,
        period_start_date=date(2026, 2, 1) if report_type != 'inventory_report' else None,
        period_end_date=date(2026, 2, 7) if report_type != 'inventory_report' else None,
        snapshot_at=now if report_type == 'inventory_report' else None,
        version=2,
        is_current=True,
        superseded_at=None,
        upload_file_id='f1.csv',
        upload_file_path='/tmp/f1.csv',
        original_filename='raw.csv',
        stored_filename='f1.csv',
        logical_filename='demo__payment_report__20260201_20260207__v2__20260227T000000Z.csv',
        storage_key='analysis/demo/payment_report/20260201_20260207/v2/f1.csv',
        file_size_bytes=123,
        file_sha256='a' * 64,
        ingestion_status='success',
        ingestion_error=None,
        row_count_total=10,
        row_count_included=8,
        created_by='operator@example.com',
        created_at=now,
        updated_at=now,
    )


def test_product_analysis_sources_list_include_history(monkeypatch):
    captured: dict[str, bool] = {}

    def fake_list_sources(
        db,
        *,
        project_id=None,
        report_type=None,
        period_start_date=None,
        period_end_date=None,
        current_only=True,
    ):  # noqa: ARG001
        captured['current_only'] = current_only
        return [_source_row()]

    monkeypatch.setattr('app.api.v1.endpoints.product_analysis.product_analysis_source_service.list_sources', fake_list_sources)

    response = client.get(
        '/api/v1/product-analysis/sources?project_id=11&include_history=true',
        headers={'X-API-Key': get_settings().api_key},
    )
    assert response.status_code == 200
    assert captured['current_only'] is False
    payload = response.json()
    assert payload[0]['report_type'] == 'payment_report'


def test_product_analysis_source_rows_api(monkeypatch):
    monkeypatch.setattr(
        'app.api.v1.endpoints.product_analysis.product_analysis_source_service.get_source_rows',
        lambda db, source_id, page, page_size, include_excluded: (  # noqa: ARG005
            _source_row(source_id=source_id),
            [
                {
                    'source_row_no': 1,
                    'sku': 'SKU1',
                    'scope_status': 'included_product',
                }
            ],
            False,
        ),
    )

    response = client.get(
        '/api/v1/product-analysis/sources/1/rows?page=1&page_size=50',
        headers={'X-API-Key': get_settings().api_key},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload['source']['id'] == 1
    assert payload['rows'][0]['scope_status'] == 'included_product'


def test_product_analysis_current_inventory_api(monkeypatch):
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        'app.api.v1.endpoints.product_analysis.product_analysis_source_service.get_current_inventory_snapshot',
        lambda db, project_id, country='US', start_date=None, end_date=None: (  # noqa: ARG005
            captured.update(
                {
                    'project_id': project_id,
                    'country': country,
                    'start_date': start_date.isoformat() if start_date else None,
                    'end_date': end_date.isoformat() if end_date else None,
                }
            )
            or (
            _source_row(source_id=8, report_type='inventory_report'),
            [
                {
                    'source_row_no': 1,
                    'sku': 'SKU1',
                    'available_qty': 0,
                    'stock_status': 'out_of_stock',
                    'aging_status': 'over_aged',
                    'raw_row': {'sku': 'SKU1'},
                }
            ],
        )),
    )

    response = client.get(
        '/api/v1/product-analysis/inventory/current?project_id=11&country=DE&start_date=2026-02-01&end_date=2026-02-07',
        headers={'X-API-Key': get_settings().api_key},
    )
    assert response.status_code == 200
    assert captured == {
        'project_id': 11,
        'country': 'DE',
        'start_date': '2026-02-01',
        'end_date': '2026-02-07',
    }
    payload = response.json()
    assert payload['source']['report_type'] == 'inventory_report'
    assert payload['rows'][0]['stock_status'] == 'out_of_stock'


def test_product_analysis_weekly_recompute_api(monkeypatch):
    monkeypatch.setattr(
        'app.api.v1.endpoints.product_analysis.project_service.ensure_project_access',
        lambda db, project_id, operator, is_admin: None,  # noqa: ARG005
    )
    monkeypatch.setattr(
        'app.api.v1.endpoints.product_analysis.product_analysis_source_service.recompute_weekly_product_analysis_from_history',
        lambda db, project_id, country, start_date, end_date, current_only: {  # noqa: ARG005
            'project_id': project_id,
            'project_name': 'Demo',
            'country': country,
            'recomputed': 1,
            'skipped': 0,
            'periods': [
                {
                    'pt1_id': 9,
                    'version': 3,
                    'report_start_date': date(2026, 2, 1),
                    'report_end_date': date(2026, 2, 7),
                    'row_count': 12,
                    'business_report_source_id': 11,
                    'ad_report_source_id': 12,
                    'payment_report_source_id': 13,
                }
            ],
        },
    )

    response = client.post(
        '/api/v1/product-analysis/weekly/recompute?project_id=11&country=US',
        headers={'X-API-Key': get_settings().api_key},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload['recomputed'] == 1
    assert payload['periods'][0]['pt1_id'] == 9
