from pathlib import Path

from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db_session
from app.core.config import Settings, get_settings
from app.db.session import Base
from app.main import app


def _write_research_workbook(path: Path) -> None:
    wb = Workbook()

    ws = wb.active
    ws.title = '产品详情'
    ws['A1'] = 'note'
    headers = [
        '序号',
        '产品名称',
        'ASIN',
        'ParentAsin',
        '实际价格($)',
        '预计Listing月销量',
        '预计月销售额($)',
        '品牌',
        '店铺',
        '上架时间',
        '上架天数',
        'FBA费用($)',
        '物流方式',
        '评分星级',
        '评价数量',
    ]
    for index, header in enumerate(headers, start=1):
        ws.cell(2, index).value = header

    row1 = [1, 'Saw A', 'B000TEST01', 'PARENT1', '99.99', 800, '79992', 'BrandA', 'Amazon', '2024-01-10', 420, '8.15', 'FBA', 4.6, 2100]
    row2 = [2, 'Saw B', 'B000TEST02', 'PARENT2', '69.99', 250, '17497.5', 'BrandB', 'SellerX', '2025-12-01', 30, '5.60', 'FBM', 4.2, 120]
    for col, value in enumerate(row1, start=1):
        ws.cell(3, col).value = value
    for col, value in enumerate(row2, start=1):
        ws.cell(4, col).value = value

    trend = wb.create_sheet('销量趋势')
    trend_headers = ['ASIN', 'ParentASIN']
    for month in [
        '2026-01', '2025-12', '2025-11', '2025-10', '2025-09', '2025-08',
        '2025-07', '2025-06', '2025-05', '2025-04', '2025-03', '2025-02',
        '2025-01', '2024-12', '2024-11', '2024-10', '2024-09', '2024-08',
        '2024-07', '2024-06', '2024-05', '2024-04', '2024-03', '2024-02',
    ]:
        trend_headers.append(month)
    for index, header in enumerate(trend_headers, start=1):
        trend.cell(1, index).value = header

    trend_row_1 = ['B000TEST01', 'PARENT1'] + [100 + i for i in range(24)]
    trend_row_2 = ['B000TEST02', 'PARENT2'] + [50 + i for i in range(24)]
    for index, value in enumerate(trend_row_1, start=1):
        trend.cell(2, index).value = value
    for index, value in enumerate(trend_row_2, start=1):
        trend.cell(3, index).value = value

    wb.save(path)


def test_category_research_endpoints_happy_path(tmp_path: Path):
    engine = create_engine(
        'sqlite://',
        future=True,
        connect_args={'check_same_thread': False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    Base.metadata.create_all(bind=engine)

    settings = Settings(
        api_key='test-api-key-123',
        upload_root=tmp_path / 'uploads',
        result_root=tmp_path / 'results',
        database_url='sqlite://',
    )
    settings.upload_root.mkdir(parents=True, exist_ok=True)
    settings.result_root.mkdir(parents=True, exist_ok=True)

    def override_get_db_session():
        db: Session = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    def override_get_settings() -> Settings:
        return settings

    app.dependency_overrides[get_db_session] = override_get_db_session
    app.dependency_overrides[get_settings] = override_get_settings

    workbook = tmp_path / 'research.xlsx'
    _write_research_workbook(workbook)

    client = TestClient(app)

    response = client.post(
        '/api/v1/category-research/datasets/import',
        headers={'X-API-Key': settings.api_key},
        data={
            'marketplace': 'US',
            'category_keyword_en': 'reciprocating saws',
            'category_name_zh': '往复锯',
        },
        files={
            'file': (
                workbook.name,
                workbook.read_bytes(),
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            )
        },
    )
    assert response.status_code == 200
    payload = response.json()
    dataset_id = payload['dataset_id']

    list_resp = client.get(
        '/api/v1/category-research/datasets',
        headers={'X-API-Key': settings.api_key},
        params={'marketplace': 'US', 'category_keyword_en': 'reciprocating saws'},
    )
    assert list_resp.status_code == 200
    assert len(list_resp.json()) == 1

    overview_resp = client.get(
        f'/api/v1/category-research/datasets/{dataset_id}',
        headers={'X-API-Key': settings.api_key},
    )
    assert overview_resp.status_code == 200
    overview = overview_resp.json()
    assert overview['kpis']['sample_count'] == 2
    assert overview['dataset']['category_keyword_en'] == 'reciprocating saws'

    products_resp = client.get(
        f'/api/v1/category-research/datasets/{dataset_id}/products',
        headers={'X-API-Key': settings.api_key},
        params={'page': 1, 'page_size': 20},
    )
    assert products_resp.status_code == 200
    assert len(products_resp.json()['rows']) == 2

    trend_resp = client.get(
        f'/api/v1/category-research/datasets/{dataset_id}/trend',
        headers={'X-API-Key': settings.api_key},
        params={'asin': 'b000test01'},
    )
    assert trend_resp.status_code == 200
    assert len(trend_resp.json()['points']) == 24

    app.dependency_overrides.clear()
