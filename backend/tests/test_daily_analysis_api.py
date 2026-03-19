from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app

client = TestClient(app)


def test_daily_analysis_api_returns_payload(monkeypatch):
    monkeypatch.setattr(
        'app.api.v1.endpoints.daily_analysis.project_service.ensure_project_access',
        lambda db, project_id, operator, is_admin: None,  # noqa: ARG005
    )
    monkeypatch.setattr(
        'app.api.v1.endpoints.daily_analysis.daily_analysis_service.build_daily_analysis',
        lambda db, project_id, country, start_date, end_date: {  # noqa: ARG005
            'console': {
                'project_id': project_id,
                'project_name': 'Demo',
                'country': country,
                'start_date': start_date,
                'end_date': end_date,
                'requested_days': 2,
                'summary_days': 1,
                'detail_rows': 2,
                'sales_source_days': 1,
                'ad_source_days': 1,
                'inventory_source_days': 1,
                'missing_dates': ['2026-03-11'],
                'latest_sales_date': '2026-03-10',
                'latest_ad_date': '2026-03-10',
                'latest_inventory_date': '2026-03-10',
            },
            'summary_rows': [
                {
                    'date': '2026-03-10',
                    'order_qty': 3,
                    'sales_amount': 30.0,
                    'impressions': 100,
                    'clicks': 5,
                    'cpc': 2.5,
                    'ad_spend': 12.5,
                    'ad_orders': 2,
                    'available_qty': 10,
                }
            ],
            'detail_rows': [
                {
                    'date': '2026-03-10',
                    'sku': 'SKU-1',
                    'asin': 'ASIN-1',
                    'order_qty': 3,
                    'sales_amount': 30.0,
                    'impressions': 100,
                    'clicks': 5,
                    'cpc': 2.5,
                    'ad_spend': 12.5,
                    'ad_orders': 2,
                    'available_qty': 10,
                }
            ],
            'available_dates': {
                'sales_report': ['2026-03-10'],
                'ad_product_report': ['2026-03-10'],
                'inventory_report': ['2026-03-10'],
            },
        },
    )

    response = client.get(
        '/api/v1/daily-analysis?project_id=11&country=US&start_date=2026-03-10&end_date=2026-03-11',
        headers={'X-API-Key': get_settings().api_key, 'X-Is-Admin': 'true'},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload['console']['project_id'] == 11
    assert payload['summary_rows'][0]['date'] == '2026-03-10'
    assert payload['detail_rows'][0]['sku'] == 'SKU-1'
