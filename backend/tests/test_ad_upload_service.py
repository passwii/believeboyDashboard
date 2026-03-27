from datetime import date
from pathlib import Path

import pandas as pd
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.models import (
    AdUploadBudgetRow,
    AdUploadCampaignRow,
    AdUploadFile,
    AdUploadInvalidTrafficRow,
    AdUploadPlacementRow,
    AdUploadPromotedProductRow,
    AdUploadPurchasedProductRow,
    AdUploadSearchTermShareRow,
    AdUploadSearchTermRow,
    AdUploadTimeTrendRow,
    AdUploadTargetRow,
    ProductCost,
    Project,
)
from app.services import ad_analysis_service
from app.schemas.ad_upload import AdUploadCommitRequest
from app.services import ad_upload_service


def _build_settings(tmp_path: Path) -> Settings:
    return Settings(
        database_url='sqlite://',
        upload_root=tmp_path / 'uploads',
        result_root=tmp_path / 'results',
    )


def _make_db() -> Session:
    engine = create_engine('sqlite://', future=True)
    Project.__table__.create(bind=engine, checkfirst=True)
    ProductCost.__table__.create(bind=engine, checkfirst=True)
    AdUploadFile.__table__.create(bind=engine, checkfirst=True)
    AdUploadBudgetRow.__table__.create(bind=engine, checkfirst=True)
    AdUploadCampaignRow.__table__.create(bind=engine, checkfirst=True)
    AdUploadPlacementRow.__table__.create(bind=engine, checkfirst=True)
    AdUploadInvalidTrafficRow.__table__.create(bind=engine, checkfirst=True)
    AdUploadTargetRow.__table__.create(bind=engine, checkfirst=True)
    AdUploadSearchTermShareRow.__table__.create(bind=engine, checkfirst=True)
    AdUploadTimeTrendRow.__table__.create(bind=engine, checkfirst=True)
    AdUploadPurchasedProductRow.__table__.create(bind=engine, checkfirst=True)
    AdUploadSearchTermRow.__table__.create(bind=engine, checkfirst=True)
    AdUploadPromotedProductRow.__table__.create(bind=engine, checkfirst=True)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    return factory()


def _copy_sample_to_temp(settings: Settings, source_path: Path) -> str:
    target_dir = settings.upload_root / '_ad_upload_tmp'
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / source_path.name
    target.write_bytes(source_path.read_bytes())
    return target.name


def _write_temp_csv(settings: Settings, filename: str, content: str) -> str:
    target_dir = settings.upload_root / '_ad_upload_tmp'
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / filename
    target.write_text(content, encoding='utf-8-sig')
    return target.name


def _write_temp_xlsx(settings: Settings, filename: str, rows: list[dict[str, object]]) -> str:
    import pandas as pd

    target_dir = settings.upload_root / '_ad_upload_tmp'
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / filename
    pd.DataFrame(rows).to_excel(target, index=False)
    return target.name


def _create_ad_file(
    db: Session,
    *,
    project_id: int,
    project_name: str,
    report_type: str,
    report_label: str,
    report_date: date,
    country: str = 'US',
) -> AdUploadFile:
    row = AdUploadFile(
        project_id=project_id,
        project_name=project_name,
        report_type=report_type,
        report_label=report_label,
        country=country,
        report_date=report_date,
        period_start_date=report_date,
        period_end_date=report_date,
        version=1,
        is_current=True,
        upload_file_id=f'{report_type}-{report_date.isoformat()}',
        upload_file_path='/tmp/mock',
        original_filename=f'{report_type}.csv',
        stored_filename=f'{report_type}.csv',
        logical_filename=f'{report_type}.csv',
        file_extension='csv',
        recognition_status='recognized',
        ingestion_status='saved',
        matched_columns=[],
        warnings=[],
        recognition_payload={},
    )
    db.add(row)
    db.flush()
    return row


def test_recognize_campaign_report_sample(tmp_path: Path):
    settings = _build_settings(tmp_path)
    db = _make_db()
    db.add(Project(project_name='Demo项目', sort_order=0))
    db.commit()

    sample = Path(__file__).resolve().parent / 'amazon_ad_report' / '商品推广_广告活动_报告.csv'
    temp_file_id = _copy_sample_to_temp(settings, sample)

    payload = ad_upload_service.recognize_saved_ad_upload(
        db,
        settings,
        temp_file_id=temp_file_id,
        original_filename=sample.name,
        country='US',
    )

    assert payload.report_type == 'ad_campaign_report'
    assert payload.report_label == '广告活动'
    assert payload.country == 'US'
    assert payload.row_count_preview == 11
    assert payload.project_match.status == 'manual'


def test_recognize_promoted_product_report_matches_project_by_sku(tmp_path: Path):
    settings = _build_settings(tmp_path)
    db = _make_db()
    db.add(Project(project_name='创酷', sort_order=0))
    db.add(
        ProductCost(
            project_name='创酷',
            sku='MJQ-TR250M',
            asin='B0CJF6HC24',
            country='US',
            sort_order=1,
            is_active=True,
        )
    )
    db.commit()

    sample = Path(__file__).resolve().parent / 'amazon_ad_report' / '商品推广_推广的商品_报告.xlsx'
    temp_file_id = _copy_sample_to_temp(settings, sample)

    payload = ad_upload_service.recognize_saved_ad_upload(
        db,
        settings,
        temp_file_id=temp_file_id,
        original_filename=sample.name,
        country='US',
    )

    assert payload.report_type == 'ad_promoted_product_report'
    assert payload.project_match.status == 'matched'
    assert payload.project_match.project_name == '创酷'
    assert payload.detected_start_date == '2026-03-03'
    assert payload.detected_end_date == '2026-03-03'


def test_commit_ad_upload_creates_new_version_and_supersedes_previous(tmp_path: Path):
    settings = _build_settings(tmp_path)
    db = _make_db()
    db.add(Project(project_name='创酷', sort_order=0))
    db.add(
        ProductCost(
            project_name='创酷',
            sku='MJQ-TR250M',
            asin='B0CJF6HC24',
            country='US',
            sort_order=1,
            is_active=True,
        )
    )
    db.commit()

    sample = Path(__file__).resolve().parent / 'amazon_ad_report' / '商品推广_推广的商品_报告.xlsx'
    temp_file_id = _copy_sample_to_temp(settings, sample)

    first = ad_upload_service.commit_ad_upload(
        db,
        settings,
        payload=AdUploadCommitRequest(
            temp_file_id=temp_file_id,
            report_type='ad_promoted_product_report',
            original_filename=sample.name,
            project_name='创酷',
            country='US',
            report_date='2026-03-03',
            report_start_date='2026-03-03',
            report_end_date='2026-03-03',
        ),
    )

    second = ad_upload_service.commit_ad_upload(
        db,
        settings,
        payload=AdUploadCommitRequest(
            temp_file_id=temp_file_id,
            report_type='ad_promoted_product_report',
            original_filename=sample.name,
            project_name='创酷',
            country='US',
            report_date='2026-03-03',
            report_start_date='2026-03-03',
            report_end_date='2026-03-03',
        ),
    )

    rows = db.execute(select(AdUploadFile).order_by(AdUploadFile.id.asc())).scalars().all()
    detail_rows = db.execute(select(AdUploadPromotedProductRow)).scalars().all()

    assert first.version == 1
    assert second.version == 2
    assert len(rows) == 2
    assert len(detail_rows) == 32
    assert rows[0].is_current is False
    assert rows[1].is_current is True
    assert rows[0].superseded_at is not None


def test_analysis_service_builds_overview_from_current_rows(tmp_path: Path):
    settings = _build_settings(tmp_path)
    db = _make_db()
    db.add(Project(project_name='创酷', sort_order=0))
    db.add(
        ProductCost(
            project_name='创酷',
            sku='MJQ-TR250M',
            asin='B0CJF6HC24',
            country='US',
            sort_order=1,
            is_active=True,
        )
    )
    db.commit()

    campaign_sample = Path(__file__).resolve().parent / 'amazon_ad_report' / '商品推广_广告活动_报告.csv'
    campaign_temp_id = _copy_sample_to_temp(settings, campaign_sample)
    ad_upload_service.commit_ad_upload(
        db,
        settings,
        payload=AdUploadCommitRequest(
            temp_file_id=campaign_temp_id,
            report_type='ad_campaign_report',
            original_filename=campaign_sample.name,
            project_name='创酷',
            country='US',
            report_date='2026-03-03',
            report_start_date='2026-03-03',
            report_end_date='2026-03-03',
        ),
    )

    product_sample = Path(__file__).resolve().parent / 'amazon_ad_report' / '商品推广_推广的商品_报告.xlsx'
    product_temp_id = _copy_sample_to_temp(settings, product_sample)
    ad_upload_service.commit_ad_upload(
        db,
        settings,
        payload=AdUploadCommitRequest(
            temp_file_id=product_temp_id,
            report_type='ad_promoted_product_report',
            original_filename=product_sample.name,
            project_name='创酷',
            country='US',
            report_date='2026-03-03',
            report_start_date='2026-03-03',
            report_end_date='2026-03-03',
        ),
    )

    search_sample = Path(__file__).resolve().parent / 'amazon_ad_report' / '商品推广_搜索词_报告.xlsx'
    search_temp_id = _copy_sample_to_temp(settings, search_sample)
    ad_upload_service.commit_ad_upload(
        db,
        settings,
        payload=AdUploadCommitRequest(
            temp_file_id=search_temp_id,
            report_type='ad_search_term_report',
            original_filename=search_sample.name,
            project_name='创酷',
            country='US',
            report_date='2026-03-03',
            report_start_date='2026-03-03',
            report_end_date='2026-03-03',
        ),
    )

    overview = ad_analysis_service.build_overview(
        db,
        project_id=1,
        country='US',
    )
    campaigns = ad_analysis_service.build_campaigns(
        db,
        project_id=1,
        country='US',
    )
    products = ad_analysis_service.build_products(
        db,
        project_id=1,
        country='US',
    )

    assert overview['project_id'] == 1
    assert len(overview['metrics']) >= 6
    assert len(overview['narrative_sections']) == 4
    assert len(overview['top_campaigns']) > 0
    assert len(campaigns['summary_cards']) == 4
    assert len(campaigns['narrative_sections']) == 3
    assert 'budget_gap' in campaigns['items'][0]
    assert 'next_action' in campaigns['items'][0]
    assert len(campaigns['items']) > 0
    assert len(products['items']) > 0
    assert 'next_action' in products['items'][0]


def test_commit_rejects_multi_day_report(tmp_path: Path):
    settings = _build_settings(tmp_path)
    db = _make_db()
    db.add(Project(project_name='创酷', sort_order=0))
    db.commit()

    temp_file_id = _write_temp_csv(
        settings,
        'multi-day-campaign.csv',
        '\n'.join(
            [
                '开始日期,结束日期,广告组合名称,广告活动类型,广告活动名称,国家/地区,状态,货币,预算,定位类型,竞价策略,展示量,点击量,点击率 (CTR),花费,单次点击成本 (CPC),7天总订单数(#),广告投入产出比 (ACOS) 总计,总广告投资回报率 (ROAS),7天总销售额',
                '2026-03-01,2026-03-03,No Portfolio,商品推广,测试活动,美国,ENABLED,USD,$10.0,自动投放,固定竞价,100,10,10%,5.0,0.5,1,20%,5,25.0',
            ]
        ),
    )

    recognition = ad_upload_service.recognize_saved_ad_upload(
        db,
        settings,
        temp_file_id=temp_file_id,
        original_filename='multi-day-campaign.csv',
        country='US',
    )

    assert '系统将拒绝入库' in ' '.join(recognition.warnings)

    with pytest.raises(Exception) as exc_info:
        ad_upload_service.commit_ad_upload(
            db,
            settings,
            payload=AdUploadCommitRequest(
                temp_file_id=temp_file_id,
                report_type='ad_campaign_report',
                original_filename='multi-day-campaign.csv',
                project_name='创酷',
                country='US',
                report_date='2026-03-03',
                report_start_date='2026-03-01',
                report_end_date='2026-03-03',
            ),
        )

    assert '仅支持单日报表入库' in str(exc_info.value)


def test_budget_placement_and_traffic_quality_ingest_and_build_analysis(tmp_path: Path):
    settings = _build_settings(tmp_path)
    db = _make_db()
    db.add(Project(project_name='创酷', sort_order=0))
    db.commit()

    budget_sample = Path(__file__).resolve().parent / 'amazon_ad_report' / '商品推广_预算_报告.csv'
    budget_temp_id = _copy_sample_to_temp(settings, budget_sample)
    ad_upload_service.commit_ad_upload(
        db,
        settings,
        payload=AdUploadCommitRequest(
            temp_file_id=budget_temp_id,
            report_type='ad_budget_report',
            original_filename=budget_sample.name,
            project_name='创酷',
            country='US',
            report_date='2026-03-03',
            report_start_date='2026-03-03',
            report_end_date='2026-03-03',
        ),
    )

    placement_sample = Path(__file__).resolve().parent / 'amazon_ad_report' / '商品推广_广告位_报告.xlsx'
    placement_temp_id = _copy_sample_to_temp(settings, placement_sample)
    ad_upload_service.commit_ad_upload(
        db,
        settings,
        payload=AdUploadCommitRequest(
            temp_file_id=placement_temp_id,
            report_type='ad_placement_report',
            original_filename=placement_sample.name,
            project_name='创酷',
            country='US',
            report_date='2026-03-03',
            report_start_date='2026-03-03',
            report_end_date='2026-03-03',
        ),
    )

    traffic_sample = Path(__file__).resolve().parent / 'amazon_ad_report' / '商品推广_总流量和无效流量_报告.xlsx'
    traffic_temp_id = _copy_sample_to_temp(settings, traffic_sample)
    ad_upload_service.commit_ad_upload(
        db,
        settings,
        payload=AdUploadCommitRequest(
            temp_file_id=traffic_temp_id,
            report_type='ad_invalid_traffic_report',
            original_filename=traffic_sample.name,
            project_name='创酷',
            country='US',
            report_date='2026-03-03',
            report_start_date='2026-03-03',
            report_end_date='2026-03-03',
        ),
    )

    budget_rows = db.execute(select(AdUploadBudgetRow)).scalars().all()
    placement_rows = db.execute(select(AdUploadPlacementRow)).scalars().all()
    traffic_rows = db.execute(select(AdUploadInvalidTrafficRow)).scalars().all()
    campaign_name = budget_rows[0].campaign_name

    budget = ad_analysis_service.build_budget(db, project_id=1, country='US')
    placements = ad_analysis_service.build_placements(db, project_id=1, country='US')
    traffic_quality = ad_analysis_service.build_traffic_quality(db, project_id=1, country='US')
    filtered_budget = ad_analysis_service.build_budget(db, project_id=1, country='US', campaign=campaign_name)
    filtered_placements = ad_analysis_service.build_placements(db, project_id=1, country='US', campaign=campaign_name)
    filtered_traffic_quality = ad_analysis_service.build_traffic_quality(
        db,
        project_id=1,
        country='US',
        campaign=campaign_name,
    )

    assert len(budget_rows) == 11
    assert len(placement_rows) == 36
    assert len(traffic_rows) == 11
    assert len(budget['summary_cards']) == 4
    assert len(budget['narrative_sections']) == 3
    assert len(placements['summary_cards']) == 4
    assert len(placements['narrative_sections']) == 3
    assert len(traffic_quality['summary_cards']) == 4
    assert len(traffic_quality['narrative_sections']) == 3
    assert len(budget['items']) > 0
    assert len(placements['items']) > 0
    assert len(traffic_quality['items']) > 0
    assert len(filtered_budget['items']) > 0
    assert all(item['campaign_name'] == campaign_name for item in filtered_budget['items'])
    assert len(filtered_placements['items']) > 0
    assert len(filtered_traffic_quality['items']) > 0
    assert budget['items'][0]['action'] in {'优先加预算', '先优化再加预算', '观察预算', '预算充足'}
    assert 'next_step' in budget['items'][0]
    assert placements['items'][0]['action'] in {'可提高系数', '谨慎降价', '流量偏弱', '持续观察'}
    assert 'next_step' in placements['items'][0]
    assert traffic_quality['items'][0]['risk_level'] in {'高风险', '中风险', '正常'}
    assert 'next_step' in traffic_quality['items'][0]


def test_invalid_traffic_ingest_tolerates_missing_row_dates(tmp_path: Path):
    settings = _build_settings(tmp_path)
    db = _make_db()
    db.add(Project(project_name='创酷', sort_order=0))
    db.commit()

    sample = Path(__file__).resolve().parent / 'amazon_ad_report' / '商品推广_总流量和无效流量_报告.xlsx'
    target = settings.upload_root / '_ad_upload_tmp'
    target.mkdir(parents=True, exist_ok=True)
    temp_path = target / 'traffic-missing-date.xlsx'

    df = pd.read_excel(sample, engine='openpyxl')
    df.loc[0, '开始日期'] = None
    df.loc[0, '结束日期'] = None
    df.to_excel(temp_path, index=False, engine='openpyxl')

    response = ad_upload_service.commit_ad_upload(
        db,
        settings,
        payload=AdUploadCommitRequest(
            temp_file_id=temp_path.name,
            report_type='ad_invalid_traffic_report',
            original_filename=sample.name,
            project_name='创酷',
            country='US',
            report_date='2026-03-03',
            report_start_date='2026-03-03',
            report_end_date='2026-03-03',
        ),
    )

    rows = db.execute(select(AdUploadInvalidTrafficRow)).scalars().all()

    assert response.ingestion_status == 'saved'
    assert len(rows) == 11


def test_search_terms_and_targets_ingest_and_build_analysis(tmp_path: Path):
    settings = _build_settings(tmp_path)
    db = _make_db()
    db.add(Project(project_name='创酷', sort_order=0))
    db.commit()

    search_term_sample = Path(__file__).resolve().parent / 'amazon_ad_report' / '商品推广_搜索词_报告.xlsx'
    search_term_temp_id = _copy_sample_to_temp(settings, search_term_sample)
    ad_upload_service.commit_ad_upload(
        db,
        settings,
        payload=AdUploadCommitRequest(
            temp_file_id=search_term_temp_id,
            report_type='ad_search_term_report',
            original_filename=search_term_sample.name,
            project_name='创酷',
            country='US',
            report_date='2026-03-03',
            report_start_date='2026-03-03',
            report_end_date='2026-03-03',
        ),
    )

    share_sample = Path(__file__).resolve().parent / 'amazon_ad_report' / '商品推广_搜索词展示量份额_报告.csv'
    share_temp_id = _copy_sample_to_temp(settings, share_sample)
    ad_upload_service.commit_ad_upload(
        db,
        settings,
        payload=AdUploadCommitRequest(
            temp_file_id=share_temp_id,
            report_type='ad_search_term_share_report',
            original_filename=share_sample.name,
            project_name='创酷',
            country='US',
            report_date='2026-03-03',
            report_start_date='2026-03-03',
            report_end_date='2026-03-03',
        ),
    )

    target_sample = Path(__file__).resolve().parent / 'amazon_ad_report' / '商品推广_搜索词投放_报告.xlsx'
    target_temp_id = _copy_sample_to_temp(settings, target_sample)
    ad_upload_service.commit_ad_upload(
        db,
        settings,
        payload=AdUploadCommitRequest(
            temp_file_id=target_temp_id,
            report_type='ad_target_report',
            original_filename=target_sample.name,
            project_name='创酷',
            country='US',
            report_date='2026-03-03',
            report_start_date='2026-03-03',
            report_end_date='2026-03-03',
        ),
    )

    search_rows = db.execute(select(AdUploadSearchTermRow)).scalars().all()
    share_rows = db.execute(select(AdUploadSearchTermShareRow)).scalars().all()
    target_rows = db.execute(select(AdUploadTargetRow)).scalars().all()
    campaign_name = search_rows[0].campaign_name

    search_terms = ad_analysis_service.build_search_terms(db, project_id=1, country='US')
    targets = ad_analysis_service.build_targets(db, project_id=1, country='US')
    filtered_search_terms = ad_analysis_service.build_search_terms(
        db,
        project_id=1,
        country='US',
        campaign=campaign_name,
    )
    filtered_targets = ad_analysis_service.build_targets(
        db,
        project_id=1,
        country='US',
        campaign=campaign_name,
    )

    assert len(share_rows) == 47
    assert len(target_rows) == 23
    assert len(search_terms['summary_cards']) == 4
    assert len(search_terms['narrative_sections']) == 3
    assert len(targets['summary_cards']) == 4
    assert len(search_terms['items']) > 0
    assert len(targets['items']) > 0
    assert len(filtered_search_terms['items']) > 0
    assert len(filtered_targets['items']) > 0
    assert 'primary_campaign' in search_terms['items'][0]
    assert 'primary_campaign' in targets['items'][0]
    assert search_terms['items'][0]['action'] in {'提竞价争份额', '加词放量', '否词/降价', '继续观察'}
    assert targets['items'][0]['action'] in {'保留放量', '降价/隔离', '提高首页系数', '持续观察'}


def test_overview_date_range_filters_current_daily_rows(tmp_path: Path):
    settings = _build_settings(tmp_path)
    db = _make_db()
    db.add(Project(project_name='创酷', sort_order=0))
    db.commit()

    march_3_temp_id = _write_temp_csv(
        settings,
        'campaign-2026-03-03.csv',
        '\n'.join(
            [
                '开始日期,结束日期,广告组合名称,广告活动类型,广告活动名称,国家/地区,状态,货币,预算,定位类型,竞价策略,展示量,点击量,点击率 (CTR),花费,单次点击成本 (CPC),7天总订单数(#),广告投入产出比 (ACOS) 总计,总广告投资回报率 (ROAS),7天总销售额',
                '2026-03-03,2026-03-03,No Portfolio,商品推广,测试活动A,美国,ENABLED,USD,$10.0,自动投放,固定竞价,100,10,10%,5.0,0.5,1,20%,5,25.0',
            ]
        ),
    )
    ad_upload_service.commit_ad_upload(
        db,
        settings,
        payload=AdUploadCommitRequest(
            temp_file_id=march_3_temp_id,
            report_type='ad_campaign_report',
            original_filename='campaign-2026-03-03.csv',
            project_name='创酷',
            country='US',
            report_date='2026-03-03',
            report_start_date='2026-03-03',
            report_end_date='2026-03-03',
        ),
    )

    march_4_temp_id = _write_temp_csv(
        settings,
        'campaign-2026-03-04.csv',
        '\n'.join(
            [
                '开始日期,结束日期,广告组合名称,广告活动类型,广告活动名称,国家/地区,状态,货币,预算,定位类型,竞价策略,展示量,点击量,点击率 (CTR),花费,单次点击成本 (CPC),7天总订单数(#),广告投入产出比 (ACOS) 总计,总广告投资回报率 (ROAS),7天总销售额',
                '2026-03-04,2026-03-04,No Portfolio,商品推广,测试活动B,美国,ENABLED,USD,$20.0,自动投放,固定竞价,200,20,10%,8.0,0.4,2,16%,6.25,50.0',
            ]
        ),
    )
    ad_upload_service.commit_ad_upload(
        db,
        settings,
        payload=AdUploadCommitRequest(
            temp_file_id=march_4_temp_id,
            report_type='ad_campaign_report',
            original_filename='campaign-2026-03-04.csv',
            project_name='创酷',
            country='US',
            report_date='2026-03-04',
            report_start_date='2026-03-04',
            report_end_date='2026-03-04',
        ),
    )

    march_3_overview = ad_analysis_service.build_overview(
        db,
        project_id=1,
        country='US',
        date_from=date(2026, 3, 3),
        date_to=date(2026, 3, 3),
    )

    march_4_overview = ad_analysis_service.build_overview(
        db,
        project_id=1,
        country='US',
        date_from=date(2026, 3, 4),
        date_to=date(2026, 3, 4),
    )

    assert march_3_overview['metrics'][0]['value'] == 5.0
    assert march_4_overview['metrics'][0]['value'] == 8.0
    assert march_3_overview['comparison']['summary'] == '上一周期没有足够数据，当前周期先作为基准观察。'
    assert march_4_overview['comparison']['previous_start'] == '2026-03-03'
    assert march_4_overview['comparison']['spend_change_ratio'] == 0.6


def test_time_trend_and_purchased_product_ingest_and_build_analysis(tmp_path: Path):
    settings = _build_settings(tmp_path)
    db = _make_db()
    db.add(Project(project_name='创酷', sort_order=0))
    db.add(
        ProductCost(
            project_name='创酷',
            sku='MJQ-TR250M',
            asin='B0CJF6HC24',
            country='US',
            sort_order=1,
            is_active=True,
        )
    )
    db.commit()

    product_sample = Path(__file__).resolve().parent / 'amazon_ad_report' / '商品推广_推广的商品_报告.xlsx'
    product_temp_id = _copy_sample_to_temp(settings, product_sample)
    ad_upload_service.commit_ad_upload(
        db,
        settings,
        payload=AdUploadCommitRequest(
            temp_file_id=product_temp_id,
            report_type='ad_promoted_product_report',
            original_filename=product_sample.name,
            project_name='创酷',
            country='US',
            report_date='2026-03-03',
            report_start_date='2026-03-03',
            report_end_date='2026-03-03',
        ),
    )

    time_trend_sample = Path(__file__).resolve().parent / 'amazon_ad_report' / '商品推广_按时间查看效果_报告.xlsx'
    time_trend_temp_id = _copy_sample_to_temp(settings, time_trend_sample)
    ad_upload_service.commit_ad_upload(
        db,
        settings,
        payload=AdUploadCommitRequest(
            temp_file_id=time_trend_temp_id,
            report_type='ad_time_trend_report',
            original_filename=time_trend_sample.name,
            project_name='创酷',
            country='US',
            report_date='2026-03-03',
            report_start_date='2026-03-03',
            report_end_date='2026-03-03',
        ),
    )

    purchased_temp_id = _write_temp_xlsx(
        settings,
        'purchased-products.xlsx',
        [
            {
                '开始日期': '2026-03-03',
                '结束日期': '2026-03-03',
                '广告组合名称': 'No Portfolio',
                '广告活动名称': '测试活动',
                '国家/地区': '美国',
                '货币': 'USD',
                '广告组名称': '测试组',
                '零售商': 'Amazon',
                '广告SKU': 'MJQ-TR250M',
                '广告ASIN': 'B0CJF6HC24',
                '投放': 'keyword',
                '匹配类型': 'PHRASE',
                '已购买的ASIN': 'B000BUY001',
                '7天内其他SKU销售量(#)': 3,
                '7天内其他SKU订单数(#)': 2,
                '7天内其他SKU销售额': 126.5,
            }
        ],
    )
    ad_upload_service.commit_ad_upload(
        db,
        settings,
        payload=AdUploadCommitRequest(
            temp_file_id=purchased_temp_id,
            report_type='ad_purchased_product_report',
            original_filename='purchased-products.xlsx',
            project_name='创酷',
            country='US',
            report_date='2026-03-03',
            report_start_date='2026-03-03',
            report_end_date='2026-03-03',
        ),
    )

    time_trend_rows = db.execute(select(AdUploadTimeTrendRow)).scalars().all()
    purchased_rows = db.execute(select(AdUploadPurchasedProductRow)).scalars().all()

    trend = ad_analysis_service.build_time_trend(db, project_id=1, country='US')
    purchased = ad_analysis_service.build_purchased_products(db, project_id=1, country='US')
    overview = ad_analysis_service.build_overview(db, project_id=1, country='US')
    products = ad_analysis_service.build_products(db, project_id=1, country='US')

    assert len(time_trend_rows) == 1
    assert len(purchased_rows) == 1
    assert len(trend['summary']) == 1
    assert trend['summary'][0]['spend'] == 69.95
    assert trend['summary'][0]['spend_change_ratio'] == 0.0
    assert trend['comparison'] is None
    assert len(purchased['items']) == 1
    assert purchased['items'][0]['action'] == '放大关联'
    assert len(overview['trend_summary']) == 1
    assert len(overview['top_cross_sell_products']) == 1
    assert len(overview['narrative_sections']) == 4
    assert overview['metrics'][-1]['display_value'] == '$126.50'
    assert any(item.get('drill_to') == 'products' for item in overview['issue_cards'])
    assert len(products['summary_cards']) == 4
    matched_product = next(item for item in products['items'] if item['ad_sku'] == 'MJQ-TR250M')
    assert matched_product['primary_campaign'] != '-'
    assert matched_product['cross_sell_action'] == '放大关联'
    assert matched_product['top_purchased_asin'] == 'B000BUY001'


def test_campaign_budget_snapshot_uses_latest_daily_budget_in_date_range():
    db = _make_db()
    db.add(Project(id=1, project_name='创酷', sort_order=0))
    db.commit()

    campaign_day_1 = _create_ad_file(
        db,
        project_id=1,
        project_name='创酷',
        report_type='ad_campaign_report',
        report_label='广告活动',
        report_date=date(2026, 3, 3),
    )
    campaign_day_2 = _create_ad_file(
        db,
        project_id=1,
        project_name='创酷',
        report_type='ad_campaign_report',
        report_label='广告活动',
        report_date=date(2026, 3, 4),
    )
    budget_day_1 = _create_ad_file(
        db,
        project_id=1,
        project_name='创酷',
        report_type='ad_budget_report',
        report_label='预算',
        report_date=date(2026, 3, 3),
    )
    budget_day_2 = _create_ad_file(
        db,
        project_id=1,
        project_name='创酷',
        report_type='ad_budget_report',
        report_label='预算',
        report_date=date(2026, 3, 4),
    )

    db.add_all(
        [
            AdUploadCampaignRow(
                source_file_id=campaign_day_1.id,
                source_row_no=1,
                report_start_date=date(2026, 3, 3),
                report_end_date=date(2026, 3, 3),
                campaign_name='活动A',
                status='ENABLED',
                targeting_type='自动投放',
                bidding_strategy='固定竞价',
                budget=10,
                impressions=100,
                clicks=10,
                spend=5,
                orders_7d=1,
                sales_7d=20,
                acos=0.25,
                roas=4,
                raw_row={},
            ),
            AdUploadCampaignRow(
                source_file_id=campaign_day_2.id,
                source_row_no=1,
                report_start_date=date(2026, 3, 4),
                report_end_date=date(2026, 3, 4),
                campaign_name='活动A',
                status='ENABLED',
                targeting_type='自动投放',
                bidding_strategy='固定竞价',
                budget=20,
                impressions=200,
                clicks=20,
                spend=8,
                orders_7d=2,
                sales_7d=40,
                acos=0.2,
                roas=5,
                raw_row={},
            ),
            AdUploadBudgetRow(
                source_file_id=budget_day_1.id,
                source_row_no=1,
                report_start_date=date(2026, 3, 3),
                report_end_date=date(2026, 3, 3),
                campaign_name='活动A',
                status='ENABLED',
                budget=10,
                suggested_budget=16,
                budget_utilization_rate=0.8,
                missed_sales_max=12,
                spend=5,
                sales_7d=20,
                orders_7d=1,
                acos=0.25,
                raw_row={},
            ),
            AdUploadBudgetRow(
                source_file_id=budget_day_2.id,
                source_row_no=1,
                report_start_date=date(2026, 3, 4),
                report_end_date=date(2026, 3, 4),
                campaign_name='活动A',
                status='ENABLED',
                budget=20,
                suggested_budget=30,
                budget_utilization_rate=0.9,
                missed_sales_max=20,
                spend=8,
                sales_7d=40,
                orders_7d=2,
                acos=0.2,
                raw_row={},
            ),
        ]
    )
    db.commit()

    payload = ad_analysis_service.build_campaigns(
        db,
        project_id=1,
        country='US',
        date_from=date(2026, 3, 3),
        date_to=date(2026, 3, 4),
    )

    item = payload['items'][0]
    assert item['budget'] == 20.0
    assert item['budget_gap'] == 10.0
    assert item['missed_sales_max'] == 20.0


def test_campaign_drill_filters_related_campaigns_by_sku():
    db = _make_db()
    db.add(Project(id=1, project_name='创酷', sort_order=0))
    db.commit()

    campaign_file = _create_ad_file(
        db,
        project_id=1,
        project_name='创酷',
        report_type='ad_campaign_report',
        report_label='广告活动',
        report_date=date(2026, 3, 3),
    )
    product_file = _create_ad_file(
        db,
        project_id=1,
        project_name='创酷',
        report_type='ad_promoted_product_report',
        report_label='推广商品',
        report_date=date(2026, 3, 3),
    )

    db.add_all(
        [
            AdUploadCampaignRow(
                source_file_id=campaign_file.id,
                source_row_no=1,
                report_start_date=date(2026, 3, 3),
                report_end_date=date(2026, 3, 3),
                campaign_name='活动A',
                status='ENABLED',
                targeting_type='自动投放',
                bidding_strategy='固定竞价',
                budget=10,
                impressions=100,
                clicks=10,
                spend=5,
                orders_7d=1,
                sales_7d=20,
                acos=0.25,
                roas=4,
                raw_row={},
            ),
            AdUploadCampaignRow(
                source_file_id=campaign_file.id,
                source_row_no=2,
                report_start_date=date(2026, 3, 3),
                report_end_date=date(2026, 3, 3),
                campaign_name='活动B',
                status='ENABLED',
                targeting_type='自动投放',
                bidding_strategy='固定竞价',
                budget=10,
                impressions=100,
                clicks=10,
                spend=5,
                orders_7d=1,
                sales_7d=20,
                acos=0.25,
                roas=4,
                raw_row={},
            ),
            AdUploadPromotedProductRow(
                source_file_id=product_file.id,
                source_row_no=1,
                report_start_date=date(2026, 3, 3),
                report_end_date=date(2026, 3, 3),
                campaign_name='活动A',
                ad_group_name='组A',
                ad_sku='SKU-1',
                ad_asin='ASIN-1',
                impressions=100,
                clicks=10,
                spend=5,
                orders_7d=1,
                units_7d=1,
                sales_7d=20,
                raw_row={},
            ),
        ]
    )
    db.commit()

    payload = ad_analysis_service.build_campaigns(db, project_id=1, country='US', sku='SKU-1')

    assert [item['campaign_name'] for item in payload['items']] == ['活动A']


def test_placements_keep_campaign_and_placement_grain():
    db = _make_db()
    db.add(Project(id=1, project_name='创酷', sort_order=0))
    db.commit()

    placement_file = _create_ad_file(
        db,
        project_id=1,
        project_name='创酷',
        report_type='ad_placement_report',
        report_label='广告位',
        report_date=date(2026, 3, 3),
    )

    db.add_all(
        [
            AdUploadPlacementRow(
                source_file_id=placement_file.id,
                source_row_no=1,
                report_start_date=date(2026, 3, 3),
                report_end_date=date(2026, 3, 3),
                campaign_name='活动A',
                placement='Top of search',
                impressions=100,
                clicks=10,
                spend=5,
                sales_7d=20,
                orders_7d=1,
                units_7d=1,
                raw_row={},
            ),
            AdUploadPlacementRow(
                source_file_id=placement_file.id,
                source_row_no=2,
                report_start_date=date(2026, 3, 3),
                report_end_date=date(2026, 3, 3),
                campaign_name='活动B',
                placement='Top of search',
                impressions=80,
                clicks=8,
                spend=4,
                sales_7d=16,
                orders_7d=1,
                units_7d=1,
                raw_row={},
            ),
        ]
    )
    db.commit()

    payload = ad_analysis_service.build_placements(db, project_id=1, country='US')

    assert len(payload['items']) == 2
    assert {item['campaign_name'] for item in payload['items']} == {'活动A', '活动B'}


def test_search_term_share_does_not_borrow_from_other_campaigns():
    db = _make_db()
    db.add(Project(id=1, project_name='创酷', sort_order=0))
    db.commit()

    search_file = _create_ad_file(
        db,
        project_id=1,
        project_name='创酷',
        report_type='ad_search_term_report',
        report_label='搜索词',
        report_date=date(2026, 3, 3),
    )
    share_file = _create_ad_file(
        db,
        project_id=1,
        project_name='创酷',
        report_type='ad_search_term_share_report',
        report_label='搜索词份额',
        report_date=date(2026, 3, 3),
    )

    db.add_all(
        [
            AdUploadSearchTermRow(
                source_file_id=search_file.id,
                source_row_no=1,
                report_start_date=date(2026, 3, 3),
                report_end_date=date(2026, 3, 3),
                campaign_name='活动A',
                match_type='EXACT',
                search_term='desk mat',
                impressions=100,
                clicks=10,
                spend=5,
                orders_7d=1,
                sales_7d=20,
                raw_row={},
            ),
            AdUploadSearchTermRow(
                source_file_id=search_file.id,
                source_row_no=2,
                report_start_date=date(2026, 3, 3),
                report_end_date=date(2026, 3, 3),
                campaign_name='活动B',
                match_type='EXACT',
                search_term='desk mat',
                impressions=100,
                clicks=10,
                spend=5,
                orders_7d=1,
                sales_7d=20,
                raw_row={},
            ),
            AdUploadSearchTermShareRow(
                source_file_id=share_file.id,
                source_row_no=1,
                report_start_date=date(2026, 3, 3),
                report_end_date=date(2026, 3, 3),
                campaign_name='活动A',
                match_type='EXACT',
                search_term='desk mat',
                impression_share=0.1,
                impression_rank=8,
                raw_row={},
            ),
            AdUploadSearchTermShareRow(
                source_file_id=share_file.id,
                source_row_no=2,
                report_start_date=date(2026, 3, 3),
                report_end_date=date(2026, 3, 3),
                campaign_name='活动B',
                match_type='EXACT',
                search_term='desk mat',
                impression_share=0.8,
                impression_rank=1,
                raw_row={},
            ),
        ]
    )
    db.commit()

    combined = ad_analysis_service.build_search_terms(db, project_id=1, country='US')
    campaign_a = ad_analysis_service.build_search_terms(db, project_id=1, country='US', campaign='活动A')

    assert combined['items'][0]['impression_share'] == 0.0
    assert campaign_a['items'][0]['impression_share'] == 0.1


def test_time_trend_builds_previous_period_comparison():
    db = _make_db()
    db.add(Project(id=1, project_name='创酷', sort_order=0))
    db.commit()

    day_1_file = _create_ad_file(
        db,
        project_id=1,
        project_name='创酷',
        report_type='ad_time_trend_report',
        report_label='按时间查看效果',
        report_date=date(2026, 3, 3),
    )
    day_2_file = _create_ad_file(
        db,
        project_id=1,
        project_name='创酷',
        report_type='ad_time_trend_report',
        report_label='按时间查看效果',
        report_date=date(2026, 3, 4),
    )
    db.add_all(
        [
            AdUploadTimeTrendRow(
                source_file_id=day_1_file.id,
                source_row_no=1,
                report_start_date=date(2026, 3, 3),
                report_end_date=date(2026, 3, 3),
                clicks=10,
                spend=5,
                cpc=0.5,
                raw_row={},
            ),
            AdUploadTimeTrendRow(
                source_file_id=day_2_file.id,
                source_row_no=1,
                report_start_date=date(2026, 3, 4),
                report_end_date=date(2026, 3, 4),
                clicks=20,
                spend=8,
                cpc=0.4,
                raw_row={},
            ),
        ]
    )
    db.commit()

    payload = ad_analysis_service.build_time_trend(
        db,
        project_id=1,
        country='US',
        date_from=date(2026, 3, 4),
        date_to=date(2026, 3, 4),
    )

    assert payload['comparison']['previous_start'] == '2026-03-03'
    assert payload['comparison']['spend_change_ratio'] == 0.6
    assert payload['comparison']['clicks_change_ratio'] == 1.0
