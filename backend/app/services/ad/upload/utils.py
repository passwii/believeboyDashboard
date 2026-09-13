from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
import re
import warnings
from typing import TYPE_CHECKING, Any

# BLF-1036: pandas imported lazily — this module chain loads at API boot via
# endpoints.ad_upload; pandas is only needed when actually parsing an ad report.
if TYPE_CHECKING:
    import pandas as pd

from fastapi import HTTPException, status
from slugify import slugify

from app.services.ad.upload.specs import DECIMAL_ZERO, OPENPYXL_MISSING_DEFAULT_STYLE_WARNING


def _record_get_ci(record: dict[str, object], column_name: str) -> object:
    """Case-insensitive column lookup against a DataFrame row dict.

    Why: Amazon's advertising console sometimes exports columns in mixed case
    (e.g. "广告SKU" vs "广告sku"). The B-table specs and persistence code use
    Amazon's official case, but we want robustness against pd.read_excel's
    case normalization quirks.

    Lookup order: exact match -> case-insensitive match -> None.
    """
    if column_name in record:
        return record[column_name]
    lowered = str(column_name).lower()
    for key, value in record.items():
        if str(key).lower() == lowered:
            return value
    return None


def _find_column_ci(df_columns: Any, column_name: str) -> str | None:
    """Case-insensitive column name lookup against a DataFrame's columns.

    Returns the original column name from df_columns that matches (case-insensitively)
    the given column_name, or None if not found.
    """
    if column_name in df_columns:
        return column_name
    lowered = str(column_name).lower()
    for col in df_columns:
        if str(col).lower() == lowered:
            return col
    return None


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
    import pandas as pd

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
    import pandas as pd

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
    # BLF-975 复测第 3 项：亚马逊广告后台导出的 xlsx 日期列可能是
    # Excel serial 数字单元格（1900 日期系统，epoch 1899-12-30）。
    # openpyxl 对带日期格式的单元格已转 datetime，对裸数字保留 int/float
    # （pandas 读入后是 numpy.int64，isinstance int 为 False，需单独判）。
    # 20000~80000 覆盖 1954~2119 年，远超报表业务范围，避免误伤普通数值列。
    value_num: float | None = None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value_num = float(value)
    elif type(value).__module__ == "numpy" and hasattr(value, "item"):
        try:
            value_num = float(value.item())
        except (TypeError, ValueError):
            value_num = None
    if value_num is not None:
        if 20000 < value_num < 80000:
            from datetime import timedelta

            return (date(1899, 12, 30) + timedelta(days=int(value_num))).strftime(
                '%Y-%m-%d'
            )
        return None
    import pandas as pd

    parsed = pd.to_datetime(value, errors='coerce')
    if parsed is None or pd.isna(parsed):
        return None
    return parsed.strftime('%Y-%m-%d')


def _resolve_record_date_range(record: dict[str, object]) -> tuple[date, date]:
    start_text = _date_to_string(_record_get_ci(record, '开始日期'))
    end_text = _date_to_string(_record_get_ci(record, '结束日期'))
    row_date_text = _date_to_string(_record_get_ci(record, '日期'))

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
            prepared.loc[:, '开始日期'] = prepared['开始日期'].fillna(first_start.iloc[0])

    if '结束日期' in prepared.columns:
        first_end = prepared['结束日期'].dropna()
        if not first_end.empty:
            prepared.loc[:, '结束日期'] = prepared['结束日期'].fillna(first_end.iloc[0])

    return prepared


def _parse_yyyy_mm_dd(value: str | None, field_name: str) -> date:
    warnings.warn(
        "_parse_yyyy_mm_dd is deprecated, use app.shared.date_utils.parse_yyyy_mm_dd instead",
        DeprecationWarning,
        stacklevel=2,
    )
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
