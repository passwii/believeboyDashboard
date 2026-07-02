"""Unit tests for ``app.services.external.ad_targeting``."""
from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import (
    AdUploadCampaignRow,
    AdUploadFile,
    Project,
)
from app.services.external.ad_targeting import (
    build_campaign_targeting_cache,
    resolve_targeting_type,
)


@pytest.fixture
def db_session():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _make_file(
    db,
    *,
    project_id: int,
    country: str,
    report_type: str,
    report_date: date,
    version: int = 1,
    project_name: str = 'test-project',
) -> AdUploadFile:
    f = AdUploadFile(
        project_id=project_id,
        project_name=project_name,
        report_type=report_type,
        report_label=report_type,
        country=country,
        report_date=report_date,
        period_start_date=report_date,
        period_end_date=report_date,
        version=version,
        is_current=True,
        ingestion_status='success',
        recognition_status='recognized',
        upload_file_id=f'test-{project_id}-{country}-{report_date.isoformat()}-v{version}',
        upload_file_path=f'/tmp/test-{project_id}-{country}-{report_date.isoformat()}-v{version}.csv',
        stored_filename=f'test-{project_id}-{country}-{report_date.isoformat()}-v{version}.csv',
        logical_filename=f'test-{project_id}-{country}-{report_date.isoformat()}-v{version}.csv',
        file_extension='.csv',
    )
    db.add(f)
    db.flush()
    return f


def test_resolve_targeting_type_auto_uses_投放_value(db_session):
    raw_row: dict[str, Any] = {'投放': 'close-match', '匹配类型': '-'}
    campaign_map = {('A-Close-Max', 'US'): '自动投放'}
    result = resolve_targeting_type(
        campaign_name='A-Close-Max', country='US',
        raw_row=raw_row, campaign_targeting_map=campaign_map,
    )
    assert result == 'close-match'


@pytest.mark.parametrize("auto_value", [
    'close-match',
    'loose-match',
    'substitutes',
    'complements',
])
def test_resolve_targeting_type_auto_all_four_buckets(db_session, auto_value):
    """All 4 Amazon 自动投放定位类型 → resolved verbatim from raw_row.投放.

    Spec §测试策略 lists these 4 explicitly; unit test should cover all of them
    so a refactor of `resolve_targeting_type` (e.g. accidental normalisation)
    is caught immediately.
    """
    raw_row = {'投放': auto_value, '匹配类型': '-'}
    campaign_map = {('A-Auto', 'US'): '自动投放'}
    result = resolve_targeting_type(
        campaign_name='A-Auto', country='US',
        raw_row=raw_row, campaign_targeting_map=campaign_map,
    )
    assert result == auto_value


@pytest.mark.parametrize("upper,lower", [
    ('EXACT', 'exact'),
    ('PHRASE', 'phrase'),
    ('BROAD', 'broad'),
])
def test_resolve_targeting_type_manual_all_three_match_types(db_session, upper, lower):
    """All 3 Amazon 手动投放 match types → resolved to lowercased form."""
    raw_row = {'投放': 'some-keyword', '匹配类型': upper}
    campaign_map = {('A-Manual', 'US'): '手动投放'}
    result = resolve_targeting_type(
        campaign_name='A-Manual', country='US',
        raw_row=raw_row, campaign_targeting_map=campaign_map,
    )
    assert result == lower


def test_resolve_targeting_type_manual_uses_lowered_match_type(db_session):
    raw_row = {'投放': 'electric ratchet', '匹配类型': 'EXACT'}
    campaign_map = {('A-Manual', 'US'): '手动投放'}
    result = resolve_targeting_type(
        campaign_name='A-Manual', country='US',
        raw_row=raw_row, campaign_targeting_map=campaign_map,
    )
    assert result == 'exact'


def test_resolve_targeting_type_no_campaign_returns_none(db_session):
    raw_row = {'投放': 'close-match', '匹配类型': '-'}
    result = resolve_targeting_type(
        campaign_name='orphan-campaign', country='US',
        raw_row=raw_row, campaign_targeting_map={},
    )
    assert result is None


def test_resolve_targeting_type_empty_投放_value(db_session):
    raw_row = {'投放': None, '匹配类型': '-'}
    campaign_map = {('A-Close', 'US'): '自动投放'}
    result = resolve_targeting_type(
        campaign_name='A-Close', country='US',
        raw_row=raw_row, campaign_targeting_map=campaign_map,
    )
    assert result is None


def test_resolve_targeting_type_manual_no_match_type(db_session):
    raw_row = {'投放': 'foo', '匹配类型': None}
    campaign_map = {('A-Manual', 'US'): '手动投放'}
    result = resolve_targeting_type(
        campaign_name='A-Manual', country='US',
        raw_row=raw_row, campaign_targeting_map=campaign_map,
    )
    assert result is None


def test_build_cache_returns_latest_targeting_per_campaign(db_session):
    proj = db_session.execute(select(Project).limit(1)).scalar_one()
    if proj is None:
        pytest.skip('no project in test DB')

    f1 = _make_file(db_session, project_id=proj.id, country='US',
                    report_type='ad_campaign_report', report_date=date(2026, 2, 1))
    f2 = _make_file(db_session, project_id=proj.id, country='US',
                    report_type='ad_campaign_report', report_date=date(2026, 2, 15))

    db_session.add_all([
        AdUploadCampaignRow(
            source_file_id=f1.id, source_row_no=1,
            report_start_date=date(2026, 2, 1), report_end_date=date(2026, 2, 1),
            campaign_name='Test-Cache-Auto', targeting_type='自动投放',
            impressions=0, clicks=0, spend=0, sales_7d=0, orders_7d=0,
            ctr=0, cpc=0, acos=0, roas=0, budget=0,
            raw_row={},
        ),
        AdUploadCampaignRow(
            source_file_id=f2.id, source_row_no=1,
            report_start_date=date(2026, 2, 15), report_end_date=date(2026, 2, 15),
            campaign_name='Test-Cache-Auto', targeting_type='手动投放',
            impressions=0, clicks=0, spend=0, sales_7d=0, orders_7d=0,
            ctr=0, cpc=0, acos=0, roas=0, budget=0,
            raw_row={},
        ),
    ])
    db_session.flush()

    cache = build_campaign_targeting_cache(
        db_session, project_id=proj.id, country='US',
        date_from=date(2026, 2, 1), date_to=date(2026, 2, 20),
    )
    assert cache.get(('Test-Cache-Auto', 'US')) == '手动投放'
