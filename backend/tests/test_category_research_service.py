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
        '变体数量',
        '主图视频',
        '是否气候承诺友好标',
        '是否做品牌旗舰店',
        '国籍/地区',
        'Blade Material',
    ]
    for index, header in enumerate(headers, start=1):
        ws.cell(2, index).value = header

    row1 = [1, 'Saw A', 'B000TEST01', 'PARENT1', '99.99', 800, '79992', 'BrandA', 'Amazon', '2024-01-10', 420, '8.15', 'FBA', 4.6, 2100, 'Amazon', 6, '是', '是', '是', 'CN', 'Bi-Metal']
    row2 = [2, 'Saw B', 'B000TEST02', 'PARENT2', 'invalid', 250, '12500', 'BrandB', 'SellerX', '2025-12-01', 30, 'invalid', 'FBM', 4.2, 120, '--', 2, '否', '否', '否', 'US', 'HCS']
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
        product_rows = {item.asin: item for item in rows[1].product_rows}
        assert len(product_rows) == 2
        assert product_rows['B000TEST01'].bbx_seller_attribute == 'Amazon'
        assert product_rows['B000TEST01'].variant_count == 6
        assert product_rows['B000TEST01'].has_main_image_video is True
        assert product_rows['B000TEST01'].is_climate_pledge_friendly is True
        assert product_rows['B000TEST01'].has_brand_store is True
        assert product_rows['B000TEST01'].seller_country_region == 'CN'
        assert product_rows['B000TEST02'].variant_count == 2
        assert product_rows['B000TEST02'].has_main_image_video is False
        assert product_rows['B000TEST02'].is_climate_pledge_friendly is False
        assert product_rows['B000TEST02'].has_brand_store is False
        assert product_rows['B000TEST02'].seller_country_region == 'US'


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


def test_get_dataset_overview_contains_advanced_metrics(tmp_path: Path):
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    workbook = tmp_path / 'research-overview.xlsx'
    _write_research_workbook(workbook, include_trend_asin2=True)
    settings = _build_settings(tmp_path)

    with Session(engine) as db:
        dataset = category_research_service.import_category_research_dataset(
            db,
            settings=settings,
            marketplace='US',
            category_keyword_en='reciprocating saws',
            category_name_zh='往复锯',
            upload_file=_upload_from_path(workbook),
            created_by='tester',
        )

        overview = category_research_service.get_dataset_overview(db, dataset.id)
        advanced = overview['advanced_metrics']
        assert advanced['market_concentration']['cr3'] >= 0
        assert advanced['market_concentration']['hhi'] >= 0
        assert advanced['brand_monopoly']['risk_level'] in {'low', 'medium', 'high'}
        assert advanced['seller_monopoly']['risk_level'] in {'low', 'medium', 'high'}
        assert advanced['product_monopoly']['risk_level'] in {'low', 'medium', 'high'}
        assert advanced['china_seller_competition']['risk_level'] in {'low', 'medium', 'high'}
        assert advanced['market_growth']['growth_level'] in {'growing', 'stable', 'shrinking'}
        assert advanced['seasonality']['seasonality_level'] in {'weak', 'moderate', 'strong'}
        assert advanced['review_research']['review_p75'] >= 0
        assert advanced['review_research']['low_review_threshold'] == 100
        assert isinstance(advanced['review_research']['rating_band_distribution'], list)
        assert isinstance(advanced['review_research']['review_segment_distribution'], list)
        assert len(advanced['price_band_opportunities']) >= 4
        assert advanced['new_product_opportunity']['new_product_count'] >= 0
        assert advanced['supply_complexity']['score'] >= 0
        assert 'score' in advanced['data_quality']
        assert isinstance(advanced['dimension_blocks'], list)
        assert isinstance(advanced['metric_definitions'], list)
        assert isinstance(advanced['action_recommendations'], list)
        assert isinstance(advanced['signals'], list)
        assert advanced['seller_monopoly']['seller_cr1'] >= 0
        assert advanced['price_band_standard'] == 'refined'
        assert advanced['price_band_method'] == 'scientific_refined'
        assert len(advanced['price_band_breaks']) >= 3
        assert advanced['price_correlation_score'] >= 0
        assert isinstance(advanced['dimension_price_band_analysis'], list)
        assert isinstance(advanced['brand_price_band_analysis'], list)

        rebuilt = category_research_service.recompute_dataset_from_history(db, dataset.id)
        warnings = rebuilt.quality_warnings if isinstance(rebuilt.quality_warnings, dict) else {}
        assert warnings.get('missing_trend_for_asin_count') == 0
        assert warnings.get('invalid_price_count') == 1
        assert warnings.get('invalid_fba_fee_count') == 1
        assert warnings.get('duplicate_asin_count') == 0


def test_recompute_backfills_new_product_detail_fields_from_raw_row(tmp_path: Path):
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    workbook = tmp_path / 'research-backfill.xlsx'
    _write_research_workbook(workbook, include_trend_asin2=True)
    settings = _build_settings(tmp_path)

    with Session(engine) as db:
        dataset = category_research_service.import_category_research_dataset(
            db,
            settings=settings,
            marketplace='US',
            category_keyword_en='reciprocating saws',
            category_name_zh='往复锯',
            upload_file=_upload_from_path(workbook),
            created_by='tester',
        )

        rows = db.execute(
            select(CategoryResearchDataset)
            .where(CategoryResearchDataset.id == dataset.id)
        ).scalar_one().product_rows
        row = next(item for item in rows if item.asin == 'B000TEST01')
        row.rating = None
        row.review_count = 0
        row.launch_date = None
        row.listing_age_days = None
        row.fba_fee_usd = None
        row.fulfillment_method = None
        row.bbx_seller_attribute = None
        row.variant_count = None
        row.has_main_image_video = None
        row.is_climate_pledge_friendly = None
        row.has_brand_store = None
        row.seller_country_region = None
        row.is_amazon = False
        row.is_new_90d = False
        db.commit()

        rebuilt = category_research_service.recompute_dataset_from_history(db, dataset.id)
        refreshed = next(item for item in rebuilt.product_rows if item.asin == 'B000TEST01')

        assert float(refreshed.rating) == 4.6
        assert refreshed.review_count == 2100
        assert str(refreshed.launch_date) == '2024-01-10'
        assert refreshed.listing_age_days == 420
        assert float(refreshed.fba_fee_usd) == 8.15
        assert refreshed.fulfillment_method == 'FBA'
        assert refreshed.bbx_seller_attribute == 'Amazon'
        assert refreshed.variant_count == 6
        assert refreshed.has_main_image_video is True
        assert refreshed.is_climate_pledge_friendly is True
        assert refreshed.has_brand_store is True
        assert refreshed.seller_country_region == 'CN'
        assert refreshed.is_amazon is True
        assert refreshed.is_new_90d is False


def test_new_dimensions_have_stable_defaults_with_sparse_data(tmp_path: Path):
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    workbook = tmp_path / 'research-sparse.xlsx'
    _write_research_workbook(workbook)
    settings = _build_settings(tmp_path)

    with Session(engine) as db:
        dataset = category_research_service.import_category_research_dataset(
            db,
            settings=settings,
            marketplace='US',
            category_keyword_en='portable fans',
            category_name_zh='便携风扇',
            upload_file=_upload_from_path(workbook),
            created_by='tester',
        )
        overview = category_research_service.get_dataset_overview(db, dataset.id)
        advanced = overview['advanced_metrics']

        assert isinstance(advanced['seller_monopoly']['top_sellers'], list)
        assert isinstance(advanced['product_monopoly']['top_asins'], list)
        assert advanced['market_growth']['trend_slope'] == float(advanced['market_growth']['trend_slope'])
        assert isinstance(advanced['seasonality']['recommended_entry_months'], list)
        assert 0 <= advanced['review_research']['low_review_product_share'] <= 1
        assert isinstance(advanced['dimension_profiles'], list)
        assert any(item.get('key') == 'blade_material' for item in advanced['dimension_profiles'])


def test_custom_price_band_breaks_apply_to_overview_and_filters(tmp_path: Path):
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    workbook = tmp_path / 'research-custom-breaks.xlsx'
    _write_research_workbook(workbook, include_trend_asin2=True)
    settings = _build_settings(tmp_path)

    with Session(engine) as db:
        dataset = category_research_service.import_category_research_dataset(
            db,
            settings=settings,
            marketplace='US',
            category_keyword_en='reciprocating saws',
            category_name_zh='往复锯',
            upload_file=_upload_from_path(workbook),
            created_by='tester',
        )

        overview = category_research_service.get_dataset_overview(
            db,
            dataset.id,
            price_band_standard='custom',
            price_band_breaks='80,120',
        )
        advanced = overview['advanced_metrics']
        assert advanced['price_band_standard'] == 'custom'
        assert advanced['price_band_breaks'] == [80.0, 120.0]
        assert [item['label'] for item in overview['fixed_price_bands']] == ['$0-79', '$80-119', '$120+']

        rows, _ = category_research_service.list_dataset_products(
            db,
            dataset_id=dataset.id,
            page=1,
            page_size=10,
            price_band='80-119',
            price_band_standard='custom',
            price_band_breaks='80,120',
        )
        assert rows


def test_manual_dimension_upsert_overrides_extracted_value(tmp_path: Path):
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    workbook = tmp_path / 'research-manual-dimension.xlsx'
    _write_research_workbook(workbook)
    settings = _build_settings(tmp_path)

    with Session(engine) as db:
        dataset = category_research_service.import_category_research_dataset(
            db,
            settings=settings,
            marketplace='US',
            category_keyword_en='reciprocating saws',
            category_name_zh='往复锯',
            upload_file=_upload_from_path(workbook),
            created_by='tester',
        )

        rows, _ = category_research_service.list_dataset_products(
            db,
            dataset_id=dataset.id,
            page=1,
            page_size=10,
        )
        assert rows
        assert rows[0].extracted_dimensions.get('blade_material') in {'Bi-Metal', 'HCS'}

        payload = category_research_service.upsert_manual_dimensions(
            db,
            dataset_id=dataset.id,
            items=[{'product_row_id': rows[0].id, 'key': 'blade_material', 'value': 'Carbide'}],
        )
        assert payload['updated_count'] == 1

        refreshed_rows, _ = category_research_service.list_dataset_products(
            db,
            dataset_id=dataset.id,
            page=1,
            page_size=10,
        )
        target = next(item for item in refreshed_rows if item.id == rows[0].id)
        assert target.manual_dimensions.get('blade_material') == 'Carbide'


def test_get_dataset_market_trend_points_returns_latest_24_months(tmp_path: Path):
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    workbook = tmp_path / 'research-market-trend.xlsx'
    _write_research_workbook(workbook, include_trend_asin2=True)
    settings = _build_settings(tmp_path)

    with Session(engine) as db:
        dataset = category_research_service.import_category_research_dataset(
            db,
            settings=settings,
            marketplace='US',
            category_keyword_en='reciprocating saws',
            category_name_zh='往复锯',
            upload_file=_upload_from_path(workbook),
            created_by='tester',
        )

        points = category_research_service.get_dataset_market_trend_points(
            db,
            dataset_id=dataset.id,
            months=24,
        )

        assert len(points) == 24
        assert points[0]['year_month'] == '2025-01'
        assert points[-1]['year_month'] == '2026-12'
        jan_2025 = next(item for item in points if item['year_month'] == '2025-01')
        assert jan_2025['monthly_sales'] == 174
