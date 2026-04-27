from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
import re
import shutil
import uuid
import warnings

import pandas as pd
from fastapi import HTTPException, UploadFile, status
from slugify import slugify
from sqlalchemy import func, select
from sqlalchemy.orm import Session

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
    Project,
)
from app.schemas.ad_upload import (
    AdUploadCommitRequest,
    AdUploadCommitResponse,
    AdUploadProjectMatchSummary,
    AdUploadRecognitionResponse,
    AdUploadStatusItem,
    AdUploadStatusResponse,
)
import app.services.product_cost_service as product_cost_service
import app.services.project_service as project_service

OPENPYXL_MISSING_DEFAULT_STYLE_WARNING = (
    'Workbook contains no default style, apply openpyxl\'s default'
)

from app.utils.country import _normalize_country
ALLOWED_EXTENSIONS = {'.csv', '.xlsx'}
DECIMAL_ZERO = Decimal('0')


@dataclass(frozen=True)
class ReportSpec:
    report_type: str
    report_label: str
    extensions: tuple[str, ...]
    required_columns: tuple[str, ...]
    project_match_fields: tuple[tuple[str, str], ...] = ()


REPORT_SPECS: tuple[ReportSpec, ...] = (
    ReportSpec(
        report_type='ad_search_term_share_report',
        report_label='搜索词展示量份额',
        extensions=('.csv',),
        required_columns=('开始日期', '结束日期', '客户搜索词', '搜索词展示量排名', '搜索词展示量份额'),
    ),
    ReportSpec(
        report_type='ad_budget_report',
        report_label='预算',
        extensions=('.csv',),
        required_columns=('开始日期', '结束日期', '广告活动名称', '建议预算', '预算范围内的平均时间'),
    ),
    ReportSpec(
        report_type='ad_campaign_report',
        report_label='广告活动',
        extensions=('.csv',),
        required_columns=('开始日期', '结束日期', '广告活动名称', '预算', '定位类型', '竞价策略'),
    ),
    ReportSpec(
        report_type='ad_purchased_product_report',
        report_label='已购买商品',
        extensions=('.xlsx',),
        required_columns=('开始日期', '结束日期', '广告SKU', '广告ASIN', '已购买的ASIN'),
        project_match_fields=(('sku', '广告SKU'), ('asin', '广告ASIN')),
    ),
    ReportSpec(
        report_type='ad_promoted_product_report',
        report_label='推广的商品',
        extensions=('.xlsx',),
        required_columns=('开始日期', '结束日期', '广告SKU', '广告ASIN', '广告活动名称', '广告组名称'),
        project_match_fields=(('sku', '广告SKU'), ('asin', '广告ASIN')),
    ),
    ReportSpec(
        report_type='ad_invalid_traffic_report',
        report_label='总流量和无效流量',
        extensions=('.xlsx',),
        required_columns=('开始日期', '结束日期', '广告活动名称', '总展示量', '无效展示量', '无效点击'),
    ),
    ReportSpec(
        report_type='ad_placement_report',
        report_label='广告位',
        extensions=('.xlsx',),
        required_columns=('开始日期', '结束日期', '广告活动名称', '放置'),
    ),
    ReportSpec(
        report_type='ad_target_report',
        report_label='搜索词投放',
        extensions=('.xlsx',),
        required_columns=('开始日期', '结束日期', '投放', '匹配类型', '搜索结果首页首位展示量份额'),
    ),
    ReportSpec(
        report_type='ad_search_term_report',
        report_label='搜索词',
        extensions=('.xlsx',),
        required_columns=('开始日期', '结束日期', '投放', '匹配类型', '客户搜索词'),
    ),
    ReportSpec(
        report_type='ad_time_trend_report',
        report_label='按时间查看效果',
        extensions=('.xlsx',),
        required_columns=('开始日期', '结束日期', '国家/地区', '货币', '点击量', '单次点击成本 (CPC)', '花费'),
    ),
)


def _periodic_required_columns(spec: ReportSpec) -> tuple[str, ...]:
    columns = list(spec.required_columns)
    while columns and columns[0] in {'开始日期', '结束日期'}:
        columns.pop(0)
    return ('日期', *columns)


def _safe_name(filename: str) -> str:
    stem = Path(filename).stem
    ext = Path(filename).suffix.lower()
    base = slugify(stem)[:80] or 'file'
    return f'{base}{ext}'


def _safe_project_folder_name(project_name: str) -> str:
    raw = (project_name or '').strip()
    if not raw:
        return 'project'
    safe = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '-', raw)
    safe = re.sub(r'\s+', '-', safe).strip(' .-')
    if safe in {'', '.', '..'}:
        safe = slugify(raw)
    return (safe or 'project')[:80]


def _normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    df.columns = [str(column).strip() for column in df.columns]
    return df


def _read_dataframe(path: Path) -> pd.DataFrame:
    suffix = path.suffix.lower()
    if suffix == '.csv':
        return _normalize_columns(pd.read_csv(path, encoding='utf-8-sig'))
    if suffix == '.xlsx':
        with warnings.catch_warnings():
            warnings.filterwarnings(
                'ignore',
                message=OPENPYXL_MISSING_DEFAULT_STYLE_WARNING,
                category=UserWarning,
            )
            return _normalize_columns(pd.read_excel(path, engine='openpyxl'))
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f'Unsupported extension: {suffix or "unknown"}',
    )


def _normalize_country(value: object) -> str:
    """Accept object args (e.g. pandas scalars) and delegate to shared utility."""
    from app.utils.country import _normalize_country as _nc
    return _nc(str(value) if value is not None else None)


def _normalize_identifier(value: object) -> str:
    if value is None:
        return ''
    text = str(value).strip()
    if not text or text.lower() == 'nan':
        return ''
    return text.upper()


def _clean_string(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() == 'nan':
        return None
    return text


def _to_int(value: object) -> int:
    normalized = _clean_string(value)
    if normalized is None:
        return 0
    try:
        return int(float(normalized.replace(',', '')))
    except ValueError:
        return 0


def _to_decimal(value: object, *, percent: bool = False) -> Decimal:
    normalized = _clean_string(value)
    if normalized is None:
        return DECIMAL_ZERO
    text = normalized.replace(',', '').replace('$', '').replace('USD', '').strip()
    if text.endswith('%'):
        percent = True
        text = text[:-1].strip()
    try:
        parsed = Decimal(str(text))
    except (InvalidOperation, ValueError):
        return DECIMAL_ZERO
    if percent:
        return parsed / Decimal('100')
    return parsed


def _json_safe_value(value: object) -> object:
    if value is None or pd.isna(value):
        return None
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    try:
        if pd.isna(value):
            return None
    except TypeError:
        pass
    return value


def _raw_row_dict(record: dict[str, object]) -> dict[str, object]:
    return {str(key): _json_safe_value(value) for key, value in record.items()}


def _date_to_string(value: object) -> str | None:
    if value is None or value == '':
        return None
    parsed = pd.to_datetime(value, errors='coerce')
    if parsed is None or pd.isna(parsed):
        return None
    return parsed.strftime('%Y-%m-%d')


def _resolve_record_date_range(record: dict[str, object]) -> tuple[date, date]:
    start_text = _date_to_string(record.get('开始日期'))
    end_text = _date_to_string(record.get('结束日期'))
    row_date_text = _date_to_string(record.get('日期'))

    if row_date_text and not start_text and not end_text:
        row_date = _parse_yyyy_mm_dd(row_date_text, '日期')
        return row_date, row_date

    return (
        _parse_yyyy_mm_dd(start_text, '开始日期'),
        _parse_yyyy_mm_dd(end_text, '结束日期'),
    )


def _prepare_ingest_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    prepared = df.copy()
    prepared = prepared.dropna(how='all').reset_index(drop=True)

    if '开始日期' in prepared.columns:
        first_start = prepared['开始日期'].dropna()
        if not first_start.empty:
            prepared['开始日期'] = prepared['开始日期'].fillna(first_start.iloc[0])

    if '结束日期' in prepared.columns:
        first_end = prepared['结束日期'].dropna()
        if not first_end.empty:
            prepared['结束日期'] = prepared['结束日期'].fillna(first_end.iloc[0])

    return prepared


def _parse_yyyy_mm_dd(value: str | None, field_name: str) -> date:
    normalized = (value or '').strip()
    if not normalized:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f'{field_name} is required',
        )
    try:
        return datetime.strptime(normalized, '%Y-%m-%d').date()
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f'{field_name} must be YYYY-MM-DD',
        ) from None


def _ensure_single_day_range(*, start_date: date, end_date: date) -> None:
    if start_date != end_date:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail='当前 ad-upload 仅支持单日报表入库：report_start_date 必须等于 report_end_date',
        )


def _build_project_match(
    db: Session,
    *,
    df: pd.DataFrame,
    spec: ReportSpec,
    country: str,
    allowed_projects: set[str] | None = None,
) -> AdUploadProjectMatchSummary:
    if not spec.project_match_fields:
        return AdUploadProjectMatchSummary(
            status='manual',
            message='该报表需要手动选择项目',
        )

    for match_by, column_name in spec.project_match_fields:
        if column_name not in df.columns:
            continue
        values = sorted(
            {
                _normalize_identifier(value)
                for value in df[column_name].dropna().tolist()
                if _normalize_identifier(value)
            }
        )
        if not values:
            continue

        matched_map = product_cost_service.match_projects_by_identifiers(
            db,
            identifiers=values,
            match_by=match_by,
            country=country,
        )
        if allowed_projects is not None:
            matched_map = {
                key: [project for project in projects if project in allowed_projects]
                for key, projects in matched_map.items()
            }

        all_projects = sorted(
            {project for projects in matched_map.values() for project in projects}
        )
        matched_values = [key for key, projects in matched_map.items() if projects]

        if len(all_projects) == 1:
            return AdUploadProjectMatchSummary(
                status='matched',
                project_name=all_projects[0],
                candidate_projects=all_projects,
                matched_by=match_by,
                matched_values=matched_values[:8],
                message=f'已根据{match_by.upper()}自动匹配项目',
            )
        if len(all_projects) > 1:
            return AdUploadProjectMatchSummary(
                status='conflict',
                candidate_projects=all_projects,
                matched_by=match_by,
                matched_values=matched_values[:8],
                message=f'检测到多个项目，请手动确认（{len(all_projects)} 个候选项目）',
            )

    return AdUploadProjectMatchSummary(
        status='manual',
        message='未匹配到唯一项目，请手动选择',
    )


def _detect_report_spec(df: pd.DataFrame, extension: str) -> ReportSpec:
    columns = set(df.columns)
    for spec in REPORT_SPECS:
        if extension not in spec.extensions:
            continue
        missing = [column for column in spec.required_columns if column not in columns]
        if not missing:
            return spec
        periodic_columns = _periodic_required_columns(spec)
        missing_periodic = [column for column in periodic_columns if column not in columns]
        if not missing_periodic:
            return ReportSpec(
                report_type=spec.report_type,
                report_label=spec.report_label,
                extensions=spec.extensions,
                required_columns=periodic_columns,
                project_match_fields=spec.project_match_fields,
            )

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail='未命中广告报表识别规则，请检查文件格式或表头',
    )


def save_ad_upload_temp_file(file: UploadFile, settings: Settings) -> dict:
    if not file.filename:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Missing filename')

    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        expected = ', '.join(sorted(ALLOWED_EXTENSIONS))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f'Unsupported extension: {ext} (expected: {expected})',
        )

    folder = settings.upload_root / '_ad_upload_tmp'
    folder.mkdir(parents=True, exist_ok=True)

    temp_id = uuid.uuid4().hex
    safe_name = _safe_name(file.filename)
    stored_name = f'{temp_id}_{safe_name}'
    path = folder / stored_name

    size = 0
    with path.open('wb') as target:
        while True:
            chunk = file.file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > settings.max_upload_bytes:
                path.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail='File too large',
                )
            target.write(chunk)

    return {
        'temp_file_id': stored_name,
        'file_path': str(path.resolve()),
        'original_filename': file.filename,
        'size': size,
    }


def resolve_ad_upload_temp_file_path(settings: Settings, temp_file_id: str) -> Path:
    path = settings.upload_root / '_ad_upload_tmp' / temp_file_id
    if path.exists() and path.is_file():
        return path
    raise FileNotFoundError(f'temp_file_id not found: {temp_file_id}')


def finalize_ad_upload_temp_file(
    settings: Settings,
    *,
    temp_file_id: str,
    original_filename: str,
    project_name: str,
    report_type: str,
) -> dict:
    source = resolve_ad_upload_temp_file_path(settings, temp_file_id)
    ext = source.suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        expected = ', '.join(sorted(ALLOWED_EXTENSIONS))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f'Unsupported extension: {ext} (expected: {expected})',
        )

    folder = (
        settings.upload_root
        / '_ad_upload'
        / _safe_project_folder_name(project_name)
        / (slugify(report_type)[:60] or 'ad-upload')
    )
    folder.mkdir(parents=True, exist_ok=True)

    unique_id = uuid.uuid4().hex
    safe_name = _safe_name(original_filename or source.name)
    stored_name = f'{unique_id}_{safe_name}'
    destination = folder / stored_name
    shutil.copy2(source, destination)

    return {
        'file_id': stored_name,
        'file_path': str(destination.resolve()),
        'filename': stored_name,
        'original_filename': original_filename or source.name,
        'size': destination.stat().st_size,
    }


def recognize_saved_ad_upload(
    db: Session,
    settings: Settings,
    *,
    temp_file_id: str,
    original_filename: str,
    country: str = 'US',
    operator: str | None = None,
    is_admin: bool = True,
) -> AdUploadRecognitionResponse:
    path = resolve_ad_upload_temp_file_path(settings, temp_file_id)
    df = _read_dataframe(path)
    extension = path.suffix.lower()
    normalized_country = _normalize_country(country)
    spec = _detect_report_spec(df, extension)

    allowed_projects = {
        str(item.project_name)
        for item in project_service.list_project_items(
            db,
            operator=operator,
            is_admin=is_admin,
        )
    }

    detected_country = normalized_country
    if '国家/地区' in df.columns and not df['国家/地区'].dropna().empty:
        detected_country = _normalize_country(df['国家/地区'].dropna().iloc[0])

    if '开始日期' in df.columns and '结束日期' in df.columns:
        detected_start_date = (
            _date_to_string(df['开始日期'].dropna().iloc[0])
            if not df['开始日期'].dropna().empty
            else None
        )
        detected_end_date = (
            _date_to_string(df['结束日期'].dropna().iloc[0])
            if not df['结束日期'].dropna().empty
            else None
        )
    elif '日期' in df.columns and not df['日期'].dropna().empty:
        parsed_dates = pd.to_datetime(df['日期'], errors='coerce').dropna()
        detected_start_date = (
            parsed_dates.min().strftime('%Y-%m-%d')
            if not parsed_dates.empty
            else None
        )
        detected_end_date = (
            parsed_dates.max().strftime('%Y-%m-%d')
            if not parsed_dates.empty
            else None
        )
    else:
        detected_start_date = None
        detected_end_date = None

    warnings_list: list[str] = []
    if len(df.index) == 0:
        warnings_list.append('报表已识别，但当前文件没有业务明细行')
    if detected_start_date and detected_end_date and detected_start_date != detected_end_date:
        if '日期' in df.columns:
            warnings_list.append('当前文件识别为周期报表，入库时将按日期拆分并覆盖对应单日数据')
        else:
            warnings_list.append('当前文件识别为非单日报表，系统将拒绝入库')

    project_match = _build_project_match(
        db,
        df=df,
        spec=spec,
        country=detected_country,
        allowed_projects=allowed_projects,
    )

    return AdUploadRecognitionResponse(
        temp_file_id=temp_file_id,
        original_filename=original_filename,
        extension=extension,
        report_type=spec.report_type,
        report_label=spec.report_label,
        matched_columns=list(spec.required_columns),
        reason=f'命中字段：{" / ".join(spec.required_columns[:6])}',
        status='recognized',
        country=detected_country,
        detected_report_date=detected_end_date or detected_start_date,
        detected_start_date=detected_start_date,
        detected_end_date=detected_end_date or detected_start_date,
        project_match=project_match,
        row_count_preview=len(df.index),
        warnings=warnings_list,
    )


def _resolve_project(
    db: Session,
    *,
    project_name: str,
    operator: str | None,
    is_admin: bool,
) -> Project:
    normalized = (project_name or '').strip()
    if not normalized:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail='project_name is required',
        )

    allowed_projects = {
        str(item.project_name)
        for item in project_service.list_project_items(
            db,
            operator=operator,
            is_admin=is_admin,
        )
    }
    if normalized not in allowed_projects:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail='当前账号无权操作该项目',
        )

    project = (
        db.execute(select(Project).where(Project.project_name == normalized))
        .scalars()
        .first()
    )
    if project is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail='project not found',
        )
    return project


def _ensure_table(db: Session) -> None:
    AdUploadFile.__table__.create(bind=db.get_bind(), checkfirst=True)
    AdUploadBudgetRow.__table__.create(bind=db.get_bind(), checkfirst=True)
    AdUploadCampaignRow.__table__.create(bind=db.get_bind(), checkfirst=True)
    AdUploadPlacementRow.__table__.create(bind=db.get_bind(), checkfirst=True)
    AdUploadInvalidTrafficRow.__table__.create(bind=db.get_bind(), checkfirst=True)
    AdUploadTargetRow.__table__.create(bind=db.get_bind(), checkfirst=True)
    AdUploadSearchTermShareRow.__table__.create(bind=db.get_bind(), checkfirst=True)
    AdUploadTimeTrendRow.__table__.create(bind=db.get_bind(), checkfirst=True)
    AdUploadPurchasedProductRow.__table__.create(bind=db.get_bind(), checkfirst=True)
    AdUploadSearchTermRow.__table__.create(bind=db.get_bind(), checkfirst=True)
    AdUploadPromotedProductRow.__table__.create(bind=db.get_bind(), checkfirst=True)


def _ingest_budget_rows(db: Session, *, source_file_id: int, df: pd.DataFrame) -> None:
    for index, (_, series) in enumerate(df.iterrows(), start=1):
        record = series.to_dict()
        report_start_date, report_end_date = _resolve_record_date_range(record)
        db.add(
            AdUploadBudgetRow(
                source_file_id=source_file_id,
                source_row_no=index,
                report_start_date=report_start_date,
                report_end_date=report_end_date,
                campaign_name=_clean_string(record.get('广告活动名称')),
                status=_clean_string(record.get('状态')),
                budget=_to_decimal(record.get('预算')),
                suggested_budget=_to_decimal(record.get('建议预算')),
                budget_utilization_rate=_to_decimal(record.get('预算范围内的平均时间')),
                missed_impressions_min=_to_int(record.get('预计错失的展示量范围（最小值）')),
                missed_impressions_max=_to_int(record.get('预计错失的展示量范围（最大值）')),
                missed_clicks_min=_to_int(record.get('预计错失的点击量范围（最小值）')),
                missed_clicks_max=_to_int(record.get('预计错失的点击量范围（最大）')),
                missed_sales_min=_to_decimal(record.get('预计错失的销售额范围（最小值）')),
                missed_sales_max=_to_decimal(record.get('预计错失的销售额范围（最大值）')),
                spend=_to_decimal(record.get('花费')),
                sales_7d=_to_decimal(record.get('7天总销售额')),
                orders_7d=_to_int(record.get('7天总订单数(#)')),
                acos=_to_decimal(record.get('广告投入产出比 (ACOS) 总计')),
                raw_row=_raw_row_dict(record),
            )
        )


def _ingest_campaign_rows(db: Session, *, source_file_id: int, df: pd.DataFrame) -> None:
    for index, (_, series) in enumerate(df.iterrows(), start=1):
        record = series.to_dict()
        report_start_date, report_end_date = _resolve_record_date_range(record)
        db.add(
            AdUploadCampaignRow(
                source_file_id=source_file_id,
                source_row_no=index,
                report_start_date=report_start_date,
                report_end_date=report_end_date,
                campaign_name=_clean_string(record.get('广告活动名称')),
                portfolio_name=_clean_string(record.get('广告组合名称')),
                campaign_type=_clean_string(record.get('广告活动类型')),
                targeting_type=_clean_string(record.get('定位类型')),
                bidding_strategy=_clean_string(record.get('竞价策略')),
                status=_clean_string(record.get('状态')),
                budget=_to_decimal(record.get('预算')),
                impressions=_to_int(record.get('展示量')),
                clicks=_to_int(record.get('点击量')),
                ctr=_to_decimal(record.get('点击率 (CTR)'), percent=True),
                spend=_to_decimal(record.get('花费')),
                cpc=_to_decimal(record.get('单次点击成本 (CPC)')),
                orders_7d=_to_int(record.get('7天总订单数(#)')),
                sales_7d=_to_decimal(record.get('7天总销售额')),
                acos=_to_decimal(record.get('广告投入产出比 (ACOS) 总计')),
                roas=_to_decimal(record.get('总广告投资回报率 (ROAS)')),
                raw_row=_raw_row_dict(record),
            )
        )


def _ingest_placement_rows(db: Session, *, source_file_id: int, df: pd.DataFrame) -> None:
    for index, (_, series) in enumerate(df.iterrows(), start=1):
        record = series.to_dict()
        report_start_date, report_end_date = _resolve_record_date_range(record)
        db.add(
            AdUploadPlacementRow(
                source_file_id=source_file_id,
                source_row_no=index,
                report_start_date=report_start_date,
                report_end_date=report_end_date,
                campaign_name=_clean_string(record.get('广告活动名称')),
                placement=_clean_string(record.get('放置')),
                bidding_strategy=_clean_string(record.get('竞价策略')),
                impressions=_to_int(record.get('展示量')),
                clicks=_to_int(record.get('点击量')),
                spend=_to_decimal(record.get('花费')),
                cpc=_to_decimal(record.get('单次点击成本 (CPC)')),
                sales_7d=_to_decimal(record.get('7天总销售额')),
                orders_7d=_to_int(record.get('7天总订单数(#)')),
                units_7d=_to_int(record.get('7天总销售量(#)')),
                acos=_to_decimal(record.get('广告投入产出比 (ACOS) 总计')),
                roas=_to_decimal(record.get('总广告投资回报率 (ROAS)')),
                raw_row=_raw_row_dict(record),
            )
        )


def _ingest_invalid_traffic_rows(db: Session, *, source_file_id: int, df: pd.DataFrame) -> None:
    for index, (_, series) in enumerate(df.iterrows(), start=1):
        record = series.to_dict()
        report_start_date, report_end_date = _resolve_record_date_range(record)
        db.add(
            AdUploadInvalidTrafficRow(
                source_file_id=source_file_id,
                source_row_no=index,
                report_start_date=report_start_date,
                report_end_date=report_end_date,
                campaign_name=_clean_string(record.get('广告活动名称')),
                status=_clean_string(record.get('状态')),
                total_impressions=_to_int(record.get('总展示量')),
                valid_impressions=_to_int(record.get('展示量')),
                invalid_impressions=_to_int(record.get('无效展示量')),
                invalid_impression_rate=_to_decimal(record.get('无效展示率')),
                total_clicks=_to_int(record.get('总点击量')),
                valid_clicks=_to_int(record.get('点击量')),
                invalid_clicks=_to_int(record.get('无效点击')),
                invalid_click_rate=_to_decimal(record.get('无效的点击率')),
                raw_row=_raw_row_dict(record),
            )
        )


def _ingest_target_rows(db: Session, *, source_file_id: int, df: pd.DataFrame) -> None:
    for index, (_, series) in enumerate(df.iterrows(), start=1):
        record = series.to_dict()
        report_start_date, report_end_date = _resolve_record_date_range(record)
        db.add(
            AdUploadTargetRow(
                source_file_id=source_file_id,
                source_row_no=index,
                report_start_date=report_start_date,
                report_end_date=report_end_date,
                campaign_name=_clean_string(record.get('广告活动名称')),
                ad_group_name=_clean_string(record.get('广告组名称')),
                target_text=_clean_string(record.get('投放')),
                match_type=_clean_string(record.get('匹配类型')),
                impressions=_to_int(record.get('展示量')),
                top_of_search_impression_share=_to_decimal(record.get('搜索结果首页首位展示量份额')),
                clicks=_to_int(record.get('点击量')),
                ctr=_to_decimal(record.get('点击率 (CTR)')),
                cpc=_to_decimal(record.get('单次点击成本 (CPC)')),
                spend=_to_decimal(record.get('花费')),
                sales_7d=_to_decimal(record.get('7天总销售额')),
                orders_7d=_to_int(record.get('7天总订单数(#)')),
                units_7d=_to_int(record.get('7天总销售量(#)')),
                acos=_to_decimal(record.get('广告投入产出比 (ACOS) 总计')),
                roas=_to_decimal(record.get('总广告投资回报率 (ROAS)')),
                cvr_7d=_to_decimal(record.get('7天的转化率')),
                raw_row=_raw_row_dict(record),
            )
        )


def _ingest_search_term_rows(db: Session, *, source_file_id: int, df: pd.DataFrame) -> None:
    for index, (_, series) in enumerate(df.iterrows(), start=1):
        record = series.to_dict()
        report_start_date, report_end_date = _resolve_record_date_range(record)
        db.add(
            AdUploadSearchTermRow(
                source_file_id=source_file_id,
                source_row_no=index,
                report_start_date=report_start_date,
                report_end_date=report_end_date,
                campaign_name=_clean_string(record.get('广告活动名称')),
                ad_group_name=_clean_string(record.get('广告组名称')),
                target_text=_clean_string(record.get('投放')),
                match_type=_clean_string(record.get('匹配类型')),
                search_term=_clean_string(record.get('客户搜索词')),
                impressions=_to_int(record.get('展示量')),
                clicks=_to_int(record.get('点击量')),
                ctr=_to_decimal(record.get('点击率 (CTR)')),
                spend=_to_decimal(record.get('花费')),
                cpc=_to_decimal(record.get('单次点击成本 (CPC)')),
                orders_7d=_to_int(record.get('7天总订单数(#)')),
                sales_7d=_to_decimal(record.get('7天总销售额')),
                acos=_to_decimal(record.get('广告投入产出比 (ACOS) 总计')),
                roas=_to_decimal(record.get('总广告投资回报率 (ROAS)')),
                cvr_7d=_to_decimal(record.get('7天的转化率')),
                raw_row=_raw_row_dict(record),
            )
        )


def _ingest_search_term_share_rows(db: Session, *, source_file_id: int, df: pd.DataFrame) -> None:
    for index, (_, series) in enumerate(df.iterrows(), start=1):
        record = series.to_dict()
        report_start_date, report_end_date = _resolve_record_date_range(record)
        db.add(
            AdUploadSearchTermShareRow(
                source_file_id=source_file_id,
                source_row_no=index,
                report_start_date=report_start_date,
                report_end_date=report_end_date,
                search_term=_clean_string(record.get('客户搜索词')),
                impression_rank=_to_int(record.get('搜索词展示量排名')),
                impression_share=_to_decimal(record.get('搜索词展示量份额'), percent=True),
                target_text=_clean_string(record.get('投放')),
                match_type=_clean_string(record.get('匹配类型')),
                campaign_name=_clean_string(record.get('广告活动名称')),
                ad_group_name=_clean_string(record.get('广告组名称')),
                clicks=_to_int(record.get('点击量')),
                impressions=_to_int(record.get('展示量')),
                ctr=_to_decimal(record.get('点击率 (CTR)'), percent=True),
                spend=_to_decimal(record.get('花费')),
                cpc=_to_decimal(record.get('单次点击成本 (CPC)')),
                orders_7d=_to_int(record.get('7 天内的总订单量 (#)')),
                sales_7d=_to_decimal(record.get('7 天内的总销售额 ')),
                acos=_to_decimal(record.get('广告投入产出比 (ACOS) 总计')),
                roas=_to_decimal(record.get('总广告投资回报率 (ROAS)')),
                cvr_7d=_to_decimal(record.get('7 天转化率'), percent=True),
                raw_row=_raw_row_dict(record),
            )
        )


def _ingest_time_trend_rows(db: Session, *, source_file_id: int, df: pd.DataFrame) -> None:
    for index, (_, series) in enumerate(df.iterrows(), start=1):
        record = series.to_dict()
        report_start_date, report_end_date = _resolve_record_date_range(record)
        db.add(
            AdUploadTimeTrendRow(
                source_file_id=source_file_id,
                source_row_no=index,
                report_start_date=report_start_date,
                report_end_date=report_end_date,
                country=_clean_string(record.get('国家/地区')),
                currency=_clean_string(record.get('货币')),
                clicks=_to_int(record.get('点击量')),
                cpc=_to_decimal(record.get('单次点击成本 (CPC)')),
                spend=_to_decimal(record.get('花费')),
                raw_row=_raw_row_dict(record),
            )
        )


def _ingest_promoted_product_rows(db: Session, *, source_file_id: int, df: pd.DataFrame) -> None:
    for index, (_, series) in enumerate(df.iterrows(), start=1):
        record = series.to_dict()
        report_start_date, report_end_date = _resolve_record_date_range(record)
        db.add(
            AdUploadPromotedProductRow(
                source_file_id=source_file_id,
                source_row_no=index,
                report_start_date=report_start_date,
                report_end_date=report_end_date,
                campaign_name=_clean_string(record.get('广告活动名称')),
                ad_group_name=_clean_string(record.get('广告组名称')),
                ad_sku=_clean_string(record.get('广告SKU')),
                ad_asin=_clean_string(record.get('广告ASIN')),
                impressions=_to_int(record.get('展示量')),
                clicks=_to_int(record.get('点击量')),
                ctr=_to_decimal(record.get('点击率 (CTR)')),
                spend=_to_decimal(record.get('花费')),
                cpc=_to_decimal(record.get('单次点击成本 (CPC)')),
                orders_7d=_to_int(record.get('7天总订单数(#)')),
                units_7d=_to_int(record.get('7天总销售量(#)')),
                sales_7d=_to_decimal(record.get('7天总销售额')),
                acos=_to_decimal(record.get('广告投入产出比 (ACOS) 总计')),
                roas=_to_decimal(record.get('总广告投资回报率 (ROAS)')),
                cvr_7d=_to_decimal(record.get('7天的转化率')),
                ad_sku_units_7d=_to_int(record.get('7天内广告SKU销售量(#)')),
                other_sku_units_7d=_to_int(record.get('7天内其他SKU销售量(#)')),
                ad_sku_sales_7d=_to_decimal(record.get('7天内广告SKU销售额')),
                other_sku_sales_7d=_to_decimal(record.get('7天内其他SKU销售额')),
                raw_row=_raw_row_dict(record),
            )
        )


def _ingest_purchased_product_rows(db: Session, *, source_file_id: int, df: pd.DataFrame) -> None:
    for index, (_, series) in enumerate(df.iterrows(), start=1):
        record = series.to_dict()
        report_start_date, report_end_date = _resolve_record_date_range(record)
        db.add(
            AdUploadPurchasedProductRow(
                source_file_id=source_file_id,
                source_row_no=index,
                report_start_date=report_start_date,
                report_end_date=report_end_date,
                campaign_name=_clean_string(record.get('广告活动名称')),
                ad_group_name=_clean_string(record.get('广告组名称')),
                ad_sku=_clean_string(record.get('广告SKU')),
                ad_asin=_clean_string(record.get('广告ASIN')),
                target_text=_clean_string(record.get('投放')),
                match_type=_clean_string(record.get('匹配类型')),
                purchased_asin=_clean_string(record.get('已购买的ASIN')),
                other_sku_units_7d=_to_int(record.get('7天内其他SKU销售量(#)')),
                other_sku_orders_7d=_to_int(record.get('7天内其他SKU订单数(#)')),
                other_sku_sales_7d=_to_decimal(record.get('7天内其他SKU销售额')),
                raw_row=_raw_row_dict(record),
            )
        )


def _ingest_detail_rows(
    db: Session,
    *,
    source_file_id: int,
    report_type: str,
    path: Path,
    df: pd.DataFrame | None = None,
) -> None:
    if report_type not in {
        'ad_budget_report',
        'ad_campaign_report',
        'ad_placement_report',
        'ad_invalid_traffic_report',
        'ad_target_report',
        'ad_search_term_report',
        'ad_search_term_share_report',
        'ad_time_trend_report',
        'ad_promoted_product_report',
        'ad_purchased_product_report',
    }:
        return

    prepared_df = _prepare_ingest_dataframe(df if df is not None else _read_dataframe(path))
    if report_type == 'ad_budget_report':
        _ingest_budget_rows(db, source_file_id=source_file_id, df=prepared_df)
    elif report_type == 'ad_campaign_report':
        _ingest_campaign_rows(db, source_file_id=source_file_id, df=prepared_df)
    elif report_type == 'ad_placement_report':
        _ingest_placement_rows(db, source_file_id=source_file_id, df=prepared_df)
    elif report_type == 'ad_invalid_traffic_report':
        _ingest_invalid_traffic_rows(db, source_file_id=source_file_id, df=prepared_df)
    elif report_type == 'ad_target_report':
        _ingest_target_rows(db, source_file_id=source_file_id, df=prepared_df)
    elif report_type == 'ad_search_term_report':
        _ingest_search_term_rows(db, source_file_id=source_file_id, df=prepared_df)
    elif report_type == 'ad_search_term_share_report':
        _ingest_search_term_share_rows(db, source_file_id=source_file_id, df=prepared_df)
    elif report_type == 'ad_time_trend_report':
        _ingest_time_trend_rows(db, source_file_id=source_file_id, df=prepared_df)
    elif report_type == 'ad_promoted_product_report':
        _ingest_promoted_product_rows(db, source_file_id=source_file_id, df=prepared_df)
    elif report_type == 'ad_purchased_product_report':
        _ingest_purchased_product_rows(db, source_file_id=source_file_id, df=prepared_df)


def commit_ad_upload(
    db: Session,
    settings: Settings,
    *,
    payload: AdUploadCommitRequest,
    operator: str | None = None,
    is_admin: bool = True,
) -> AdUploadCommitResponse:
    _ensure_table(db)

    recognition = recognize_saved_ad_upload(
        db,
        settings,
        temp_file_id=payload.temp_file_id,
        original_filename=payload.original_filename or '',
        country=payload.country,
        operator=operator,
        is_admin=is_admin,
    )
    if payload.report_type != recognition.report_type:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail='report_type does not match recognized report',
        )

    project_name = (
        (payload.project_name or '').strip()
        or (recognition.project_match.project_name or '').strip()
    )
    project = _resolve_project(
        db,
        project_name=project_name,
        operator=operator,
        is_admin=is_admin,
    )

    report_start_date = _parse_yyyy_mm_dd(
        payload.report_start_date or recognition.detected_start_date or payload.report_date,
        'report_start_date',
    )
    report_end_date = _parse_yyyy_mm_dd(
        payload.report_end_date or recognition.detected_end_date or payload.report_date,
        'report_end_date',
    )
    if report_start_date > report_end_date:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail='report_start_date must be <= report_end_date',
        )

    source_path = resolve_ad_upload_temp_file_path(settings, payload.temp_file_id)
    source_df = _prepare_ingest_dataframe(_read_dataframe(source_path))
    is_periodic_row_date_upload = (
        payload.report_type.startswith('ad_')
        and '日期' in source_df.columns
        and '开始日期' not in source_df.columns
        and '结束日期' not in source_df.columns
    )

    if not is_periodic_row_date_upload:
        _ensure_single_day_range(start_date=report_start_date, end_date=report_end_date)

    if payload.report_date and not is_periodic_row_date_upload:
        input_report_date = _parse_yyyy_mm_dd(payload.report_date, 'report_date')
        if input_report_date != report_start_date:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail='report_date 必须与识别出的单日报表日期一致',
            )

    file_meta = finalize_ad_upload_temp_file(
        settings,
        temp_file_id=payload.temp_file_id,
        original_filename=payload.original_filename or recognition.original_filename,
        project_name=project.project_name,
        report_type=payload.report_type,
    )

    def _save_scope(*, scope_date: date, scope_df: pd.DataFrame, row_count_preview: int) -> AdUploadFile:
        scope_filters = (
            AdUploadFile.project_id == project.id,
            AdUploadFile.report_type == payload.report_type,
            AdUploadFile.country == recognition.country,
            AdUploadFile.period_start_date == scope_date,
            AdUploadFile.period_end_date == scope_date,
        )

        max_version = (
            db.execute(
                select(func.coalesce(func.max(AdUploadFile.version), 0)).where(*scope_filters)
            )
            .scalar_one()
        )
        current_rows = (
            db.execute(
                select(AdUploadFile).where(*scope_filters, AdUploadFile.is_current.is_(True))
            )
            .scalars()
            .all()
        )
        for current_row in current_rows:
            current_row.is_current = False
            current_row.superseded_at = datetime.now(UTC)

        new_row = AdUploadFile(
            project_id=project.id,
            project_name=project.project_name,
            report_type=payload.report_type,
            report_label=recognition.report_label,
            country=recognition.country,
            report_date=scope_date,
            period_start_date=scope_date,
            period_end_date=scope_date,
            version=int(max_version) + 1,
            is_current=True,
            upload_file_id=str(file_meta['file_id']),
            upload_file_path=str(file_meta['file_path']),
            original_filename=(payload.original_filename or recognition.original_filename or '').strip() or None,
            stored_filename=str(file_meta['filename']),
            logical_filename=(payload.original_filename or recognition.original_filename or str(file_meta['filename'])).strip(),
            file_extension=Path(str(file_meta['file_path'])).suffix.lower(),
            file_size_bytes=int(file_meta['size']) if file_meta.get('size') is not None else None,
            recognition_status=recognition.status,
            ingestion_status='saved',
            row_count_preview=row_count_preview,
            matched_columns=list(recognition.matched_columns),
            warnings=list(recognition.warnings),
            recognition_payload=recognition.model_dump(mode='json'),
            created_by=(operator or '').strip()[:255] or None,
        )
        db.add(new_row)
        db.flush()
        _ingest_detail_rows(
            db,
            source_file_id=int(new_row.id),
            report_type=new_row.report_type,
            path=Path(new_row.upload_file_path),
            df=scope_df,
        )
        return new_row

    saved_rows: list[AdUploadFile] = []
    if is_periodic_row_date_upload:
        source_df = source_df.copy()
        source_df['__row_date__'] = pd.to_datetime(source_df['日期'], errors='coerce')
        normalized_range = source_df.dropna(subset=['__row_date__']).copy()
        if normalized_range.empty:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail='日期 is required',
            )
        normalized_range['__row_date_key__'] = normalized_range['__row_date__'].dt.strftime('%Y-%m-%d')
        for row_date_text, scope_df in normalized_range.groupby('__row_date_key__', sort=True):
            scope_date = _parse_yyyy_mm_dd(str(row_date_text), '日期')
            saved_rows.append(
                _save_scope(
                    scope_date=scope_date,
                    scope_df=scope_df.drop(columns=['__row_date__', '__row_date_key__']),
                    row_count_preview=len(scope_df.index),
                )
            )
    else:
        saved_rows.append(
            _save_scope(
                scope_date=report_start_date,
                scope_df=source_df,
                row_count_preview=recognition.row_count_preview or len(source_df.index),
            )
        )

    db.commit()
    for saved_row in saved_rows:
        db.refresh(saved_row)

    result_row = saved_rows[-1]
    message = (
        f'广告报表已按 {len(saved_rows)} 个日期保存并覆盖对应单日数据'
        if is_periodic_row_date_upload
        else '广告报表已保存到新的 ad-upload 链路'
    )

    return AdUploadCommitResponse(
        id=int(result_row.id),
        report_type=result_row.report_type,
        report_label=result_row.report_label,
        ingestion_status=result_row.ingestion_status,
        project_name=result_row.project_name,
        country=result_row.country,
        report_date=result_row.report_date.isoformat() if result_row.report_date else None,
        report_start_date=result_row.period_start_date.isoformat(),
        report_end_date=result_row.period_end_date.isoformat(),
        file_id=result_row.upload_file_id,
        file_path=result_row.upload_file_path,
        version=result_row.version,
        is_current=result_row.is_current,
        message=message,
    )


def list_ad_upload_statuses(
    db: Session,
    *,
    country: str = 'US',
    project_name: str | None = None,
    report_type: str | None = None,
    report_date: str | None = None,
    limit: int = 50,
    operator: str | None = None,
    is_admin: bool = True,
) -> AdUploadStatusResponse:
    _ensure_table(db)

    normalized_country = _normalize_country(country)
    stmt = select(AdUploadFile).where(AdUploadFile.country == normalized_country)

    allowed_projects = {
        str(item.project_name)
        for item in project_service.list_project_items(
            db,
            operator=operator,
            is_admin=is_admin,
        )
    }
    if allowed_projects:
        stmt = stmt.where(AdUploadFile.project_name.in_(sorted(allowed_projects)))
    elif not is_admin:
        return AdUploadStatusResponse(country=normalized_country, items=[])

    normalized_project_name = (project_name or '').strip()
    if normalized_project_name:
        stmt = stmt.where(AdUploadFile.project_name == normalized_project_name)

    normalized_report_type = (report_type or '').strip()
    if normalized_report_type:
        stmt = stmt.where(AdUploadFile.report_type == normalized_report_type)

    normalized_report_date = (report_date or '').strip()
    if normalized_report_date:
        stmt = stmt.where(AdUploadFile.report_date == _parse_yyyy_mm_dd(normalized_report_date, 'report_date'))

    rows = (
        db.execute(
            stmt.order_by(
                AdUploadFile.updated_at.desc(),
                AdUploadFile.id.desc(),
            ).limit(max(1, min(limit, 200)))
        )
        .scalars()
        .all()
    )

    return AdUploadStatusResponse(
        country=normalized_country,
        items=[
            AdUploadStatusItem(
                id=int(row.id),
                project_name=row.project_name,
                report_type=row.report_type,
                report_label=row.report_label,
                country=row.country,
                report_date=row.report_date.isoformat() if row.report_date else None,
                report_start_date=row.period_start_date.isoformat(),
                report_end_date=row.period_end_date.isoformat(),
                version=row.version,
                is_current=row.is_current,
                recognition_status=row.recognition_status,
                ingestion_status=row.ingestion_status,
                original_filename=row.original_filename,
                row_count_preview=row.row_count_preview,
                updated_at=row.updated_at.isoformat() if row.updated_at else None,
                warnings=list(row.warnings or []),
            )
            for row in rows
        ],
    )
