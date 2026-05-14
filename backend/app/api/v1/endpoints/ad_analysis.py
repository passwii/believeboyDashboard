from datetime import date

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.schemas.ad_analysis import (
    AdAnalysisBudgetResponse,
    AdAnalysisCampaignsResponse,
    AdAnalysisOverviewResponse,
    AdAnalysisPlacementsResponse,
    AdAnalysisPurchasedProductsResponse,
    AdAnalysisProductsResponse,
    AdAnalysisSearchTermsResponse,
    AdAnalysisTargetsResponse,
    AdAnalysisTimeTrendResponse,
    AdAnalysisTrafficQualityResponse,
)
from app.services.ad import (
    build_budget,
    build_campaigns,
    build_overview,
    build_placements,
    build_products,
    build_purchased_products,
    build_search_terms,
    build_targets,
    build_time_trend,
    build_traffic_quality,
)

router = APIRouter(dependencies=[Depends(protected)])


@router.get('/ad-analysis/overview', response_model=AdAnalysisOverviewResponse)
def get_ad_analysis_overview(
    project_id: int = Query(..., ge=1),
    country: str = Query(default='US'),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> AdAnalysisOverviewResponse:
    payload = build_overview(
        db,
        project_id=project_id,
        country=country,
        date_from=date_from,
        date_to=date_to,
        operator=operator,
        is_admin=bool(is_admin),
    )
    return AdAnalysisOverviewResponse(**payload)


@router.get('/ad-analysis/campaigns', response_model=AdAnalysisCampaignsResponse)
def get_ad_analysis_campaigns(
    project_id: int = Query(..., ge=1),
    country: str = Query(default='US'),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    campaign: str | None = Query(default=None),
    sku: str | None = Query(default=None),
    search_term: str | None = Query(default=None),
    placement: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> AdAnalysisCampaignsResponse:
    payload = build_campaigns(
        db,
        project_id=project_id,
        country=country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
        sku=sku,
        search_term=search_term,
        placement=placement,
        operator=operator,
        is_admin=bool(is_admin),
    )
    return AdAnalysisCampaignsResponse(**payload)


@router.get('/ad-analysis/products', response_model=AdAnalysisProductsResponse)
def get_ad_analysis_products(
    project_id: int = Query(..., ge=1),
    country: str = Query(default='US'),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    campaign: str | None = Query(default=None),
    sku: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> AdAnalysisProductsResponse:
    payload = build_products(
        db,
        project_id=project_id,
        country=country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
        sku=sku,
        operator=operator,
        is_admin=bool(is_admin),
    )
    return AdAnalysisProductsResponse(**payload)


@router.get('/ad-analysis/time-trend', response_model=AdAnalysisTimeTrendResponse)
def get_ad_analysis_time_trend(
    project_id: int = Query(..., ge=1),
    country: str = Query(default='US'),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> AdAnalysisTimeTrendResponse:
    payload = build_time_trend(
        db,
        project_id=project_id,
        country=country,
        date_from=date_from,
        date_to=date_to,
        operator=operator,
        is_admin=bool(is_admin),
    )
    return AdAnalysisTimeTrendResponse(**payload)


@router.get('/ad-analysis/purchased-products', response_model=AdAnalysisPurchasedProductsResponse)
def get_ad_analysis_purchased_products(
    project_id: int = Query(..., ge=1),
    country: str = Query(default='US'),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    campaign: str | None = Query(default=None),
    sku: str | None = Query(default=None),
    purchased_asin: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> AdAnalysisPurchasedProductsResponse:
    payload = build_purchased_products(
        db,
        project_id=project_id,
        country=country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
        sku=sku,
        purchased_asin=purchased_asin,
        operator=operator,
        is_admin=bool(is_admin),
    )
    return AdAnalysisPurchasedProductsResponse(**payload)


@router.get('/ad-analysis/search-terms', response_model=AdAnalysisSearchTermsResponse)
def get_ad_analysis_search_terms(
    project_id: int = Query(..., ge=1),
    country: str = Query(default='US'),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    campaign: str | None = Query(default=None),
    search_term: str | None = Query(default=None),
    sku: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> AdAnalysisSearchTermsResponse:
    payload = build_search_terms(
        db,
        project_id=project_id,
        country=country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
        search_term=search_term,
        sku=sku,
        operator=operator,
        is_admin=bool(is_admin),
    )
    return AdAnalysisSearchTermsResponse(**payload)


@router.get('/ad-analysis/targets', response_model=AdAnalysisTargetsResponse)
def get_ad_analysis_targets(
    project_id: int = Query(..., ge=1),
    country: str = Query(default='US'),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    campaign: str | None = Query(default=None),
    target_text: str | None = Query(default=None),
    sku: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> AdAnalysisTargetsResponse:
    payload = build_targets(
        db,
        project_id=project_id,
        country=country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
        target_text=target_text,
        sku=sku,
        operator=operator,
        is_admin=bool(is_admin),
    )
    return AdAnalysisTargetsResponse(**payload)


@router.get('/ad-analysis/budget', response_model=AdAnalysisBudgetResponse)
def get_ad_analysis_budget(
    project_id: int = Query(..., ge=1),
    country: str = Query(default='US'),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    campaign: str | None = Query(default=None),
    sku: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> AdAnalysisBudgetResponse:
    payload = build_budget(
        db,
        project_id=project_id,
        country=country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
        sku=sku,
        operator=operator,
        is_admin=bool(is_admin),
    )
    return AdAnalysisBudgetResponse(**payload)


@router.get('/ad-analysis/placements', response_model=AdAnalysisPlacementsResponse)
def get_ad_analysis_placements(
    project_id: int = Query(..., ge=1),
    country: str = Query(default='US'),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    campaign: str | None = Query(default=None),
    sku: str | None = Query(default=None),
    placement: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> AdAnalysisPlacementsResponse:
    payload = build_placements(
        db,
        project_id=project_id,
        country=country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
        sku=sku,
        placement=placement,
        operator=operator,
        is_admin=bool(is_admin),
    )
    return AdAnalysisPlacementsResponse(**payload)


@router.get('/ad-analysis/traffic-quality', response_model=AdAnalysisTrafficQualityResponse)
def get_ad_analysis_traffic_quality(
    project_id: int = Query(..., ge=1),
    country: str = Query(default='US'),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    campaign: str | None = Query(default=None),
    sku: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> AdAnalysisTrafficQualityResponse:
    payload = build_traffic_quality(
        db,
        project_id=project_id,
        country=country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
        sku=sku,
        operator=operator,
        is_admin=bool(is_admin),
    )
    return AdAnalysisTrafficQualityResponse(**payload)
