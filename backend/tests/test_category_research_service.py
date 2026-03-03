from pathlib import Path
from tempfile import SpooledTemporaryFile

from fastapi import UploadFile
from openpyxl import Workbook
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.db.session import Base
from app.models import CategoryResearchDataset
from app.services import category_research_service


def _build_settings(tmp_path: Path) -> Settings:
    return Settings(
        database_url='sqlite:///:memory:',
        upload_root=tmp_path / 'uploads',
        result_root=tmp_path / 'results',
        product_cost_cache_sqlite_path=tmp_path / 'cache' / 'query_cache.db',
    )


def _write_research_workbook(path: Path, *, trend_months: int = 24, include_trend_asin2: bool = False) -> None:
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
        'BBX卖家属性',
    ]
    for index, header in enumerate(headers, start=1):
        ws.cell(2, index).value = header

    row1 = [1, 'Saw A', 'B000TEST01', 'PARENT1', '99.99', 800, '79992', 'BrandA', 'Amazon', '2024-01-10', 420, '8.15', 'FBA', 4.6, 2100, 'Amazon']
    row2 = [2, 'Saw B', 'B000TEST02', 'PARENT2', 'invalid', 250, '12500', 'BrandB', 'SellerX', '2025-12-01', 30, 'invalid', 'FBM', 4.2, 120, '--']
    for col, value in enumerate(row1, start=1):
        ws.cell(3, col).value = value
    for col, value in enumerate(row2, start=1):
        ws.cell(4, col).value = value

    trend = wb.create_sheet('销量趋势')
    trend_headers = ['ASIN', 'ParentASIN']
    base_year = 2026
    base_month = 1
    for offset in range(trend_months):
        y = base_year - ((base_month - 1 + offset) // 12)
        m = ((base_month - 1 + offset) % 12) + 1
        trend_headers.append(f'{y:04d}-{m:02d}')
    for index, header in enumerate(trend_headers, start=1):
        trend.cell(1, index).value = header

    trend_row_1 = ['B000TEST01', 'PARENT1'] + [100 + i for i in range(trend_months)]
    for index, value in enumerate(trend_row_1, start=1):
        trend.cell(2, index).value = value

    if include_trend_asin2:
        trend_row_2 = ['B000TEST02', 'PARENT2'] + [50 + i for i in range(trend_months)]
        for index, value in enumerate(trend_row_2, start=1):
            trend.cell(3, index).value = value

    wb.save(path)


def _upload_from_path(path: Path) -> UploadFile:
    tmp = SpooledTemporaryFile()
    tmp.write(path.read_bytes())
    tmp.seek(0)
    return UploadFile(
        file=tmp,
        filename=path.name,
        headers={'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},
    )


def test_import_category_research_success_with_versioning(tmp_path: Path):
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    workbook = tmp_path / 'research.xlsx'
    _write_research_workbook(workbook)

    settings = _build_settings(tmp_path)

    with Session(engine) as db:
        first = category_research_service.import_category_research_dataset(
            db,
            settings=settings,
            marketplace='us',
            category_keyword_en='reciprocating saws',
            category_name_zh='往复锯',
            upload_file=_upload_from_path(workbook),
            created_by='tester',
        )
        second = category_research_service.import_category_research_dataset(
            db,
            settings=settings,
            marketplace='US',
            category_keyword_en='reciprocating saws',
            category_name_zh='往复锯更新',
            upload_file=_upload_from_path(workbook),
            created_by='tester',
        )

        assert first.version == 1
        assert second.version == 2
        assert second.is_current is True

        rows = db.execute(
            select(CategoryResearchDataset)
            .where(
                CategoryResearchDataset.marketplace == 'US',
                CategoryResearchDataset.category_keyword_en == 'reciprocating saws',
            )
            .order_by(CategoryResearchDataset.version.asc())
        ).scalars().all()
        assert len(rows) == 2
        assert rows[0].is_current is False
        assert rows[1].is_current is True
        assert rows[1].row_count_products == 2
        assert rows[1].row_count_trends == 24
        assert rows[1].quality_warnings['missing_trend_for_asin_count'] == 1
        assert rows[1].quality_warnings['invalid_price_count'] == 1
        assert rows[1].quality_warnings['invalid_fba_fee_count'] == 1


def test_import_category_research_rejects_missing_24_month_columns(tmp_path: Path):
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    workbook = tmp_path / 'invalid-months.xlsx'
    _write_research_workbook(workbook, trend_months=12)

    settings = _build_settings(tmp_path)

    with Session(engine) as db:
        try:
            category_research_service.import_category_research_dataset(
                db,
                settings=settings,
                marketplace='US',
                category_keyword_en='reciprocating saws',
                category_name_zh='往复锯',
                upload_file=_upload_from_path(workbook),
                created_by='tester',
            )
            assert False, 'expected ValueError'
        except ValueError as exc:
            assert '24 month columns' in str(exc)
