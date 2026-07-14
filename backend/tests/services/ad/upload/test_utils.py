from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path
import tempfile
import warnings

import pandas as pd
import pytest


@pytest.mark.recognition
@pytest.mark.ad_report
@pytest.mark.upload
class TestSafeName:
    def test_basic(self):
        from app.services.ad.upload.utils import _safe_name
        assert _safe_name('hello.csv') == 'hello.csv'

    def test_uppercase_ext(self):
        from app.services.ad.upload.utils import _safe_name
        assert _safe_name('report.CSV').endswith('.csv')

    def test_special_chars(self):
        from app.services.ad.upload.utils import _safe_name
        assert _safe_name('My Report (1).xlsx') == 'my-report-1.xlsx'

    def test_empty_stem_fallback(self):
        from app.services.ad.upload.utils import _safe_name
        name = _safe_name('!!!.csv')
        assert name.endswith('.csv')
        assert len(name) > 4

    def test_long_stem_truncated(self):
        from app.services.ad.upload.utils import _safe_name
        long_name = 'a' * 200 + '.csv'
        result = _safe_name(long_name)
        assert len(result) <= 85  # 80 + '.csv'


class TestSafeProjectFolderName:
    def test_basic(self):
        from app.services.ad.upload.utils import _safe_project_folder_name
        assert _safe_project_folder_name('My Project') == 'My-Project'

    def test_empty(self):
        from app.services.ad.upload.utils import _safe_project_folder_name
        assert _safe_project_folder_name('') == 'project'

    def test_none(self):
        from app.services.ad.upload.utils import _safe_project_folder_name
        assert _safe_project_folder_name(None) == 'project'  # type: ignore

    def test_illegal_chars(self):
        from app.services.ad.upload.utils import _safe_project_folder_name
        assert ':' not in _safe_project_folder_name('foo:bar')
        assert '*' not in _safe_project_folder_name('foo*bar')

    def test_whitespace_collapse(self):
        from app.services.ad.upload.utils import _safe_project_folder_name
        assert '  ' not in _safe_project_folder_name('a   b')

    def test_truncated(self):
        from app.services.ad.upload.utils import _safe_project_folder_name
        assert len(_safe_project_folder_name('a' * 200)) <= 80


class TestNormalizeColumns:
    def test_strips_whitespace(self):
        from app.services.ad.upload.utils import _normalize_columns
        df = pd.DataFrame(columns=[' 开始日期 ', '结束日期 '])
        result = _normalize_columns(df)
        assert list(result.columns) == ['开始日期', '结束日期']

    def test_converts_non_string(self):
        from app.services.ad.upload.utils import _normalize_columns
        df = pd.DataFrame(columns=[123, 456])
        result = _normalize_columns(df)
        assert list(result.columns) == ['123', '456']


class TestNormalizeIdentifier:
    def test_uppercase(self):
        from app.services.ad.upload.utils import _normalize_identifier
        assert _normalize_identifier('abc-123') == 'ABC-123'

    def test_strips_whitespace(self):
        from app.services.ad.upload.utils import _normalize_identifier
        assert _normalize_identifier('  hello  ') == 'HELLO'

    def test_none(self):
        from app.services.ad.upload.utils import _normalize_identifier
        assert _normalize_identifier(None) == ''

    def test_nan_string(self):
        from app.services.ad.upload.utils import _normalize_identifier
        assert _normalize_identifier('nan') == ''

    def test_empty(self):
        from app.services.ad.upload.utils import _normalize_identifier
        assert _normalize_identifier('') == ''


class TestCleanString:
    def test_basic(self):
        from app.services.ad.upload.utils import _clean_string
        assert _clean_string('  hello  ') == 'hello'

    def test_none(self):
        from app.services.ad.upload.utils import _clean_string
        assert _clean_string(None) is None

    def test_nan_string(self):
        from app.services.ad.upload.utils import _clean_string
        assert _clean_string('nan') is None

    def test_empty(self):
        from app.services.ad.upload.utils import _clean_string
        assert _clean_string('') is None


class TestToInt:
    def test_basic(self):
        from app.services.ad.upload.utils import _to_int
        assert _to_int('42') == 42

    def test_with_commas(self):
        from app.services.ad.upload.utils import _to_int
        assert _to_int('1,234') == 1234

    def test_float_string(self):
        from app.services.ad.upload.utils import _to_int
        assert _to_int('3.14') == 3

    def test_none(self):
        from app.services.ad.upload.utils import _to_int
        assert _to_int(None) == 0

    def test_invalid(self):
        from app.services.ad.upload.utils import _to_int
        assert _to_int('abc') == 0


class TestToDecimal:
    def test_basic(self):
        from app.services.ad.upload.utils import _to_decimal
        assert _to_decimal('10.50') == Decimal('10.50')

    def test_with_dollar(self):
        from app.services.ad.upload.utils import _to_decimal
        assert _to_decimal('$100.00') == Decimal('100.00')

    def test_with_usd(self):
        from app.services.ad.upload.utils import _to_decimal
        assert _to_decimal('50 USD') == Decimal('50')

    def test_percent_flag(self):
        from app.services.ad.upload.utils import _to_decimal
        assert _to_decimal('25', percent=True) == Decimal('0.25')

    def test_percent_in_string(self):
        from app.services.ad.upload.utils import _to_decimal
        assert _to_decimal('25%') == Decimal('0.25')

    def test_none(self):
        from app.services.ad.upload.utils import _to_decimal
        assert _to_decimal(None) == Decimal('0')

    def test_invalid(self):
        from app.services.ad.upload.utils import _to_decimal
        assert _to_decimal('not-a-number') == Decimal('0')

    def test_with_commas(self):
        from app.services.ad.upload.utils import _to_decimal
        assert _to_decimal('1,234.56') == Decimal('1234.56')


class TestJsonSafeValue:
    def test_none(self):
        from app.services.ad.upload.utils import _json_safe_value
        assert _json_safe_value(None) is None

    def test_decimal_to_float(self):
        from app.services.ad.upload.utils import _json_safe_value
        assert _json_safe_value(Decimal('1.5')) == 1.5

    def test_date_to_iso(self):
        from app.services.ad.upload.utils import _json_safe_value
        assert _json_safe_value(date(2024, 1, 15)) == '2024-01-15'

    def test_string_passthrough(self):
        from app.services.ad.upload.utils import _json_safe_value
        assert _json_safe_value('hello') == 'hello'


class TestParseYyyyMmDd:
    def test_valid(self):
        from app.services.ad.upload.utils import _parse_yyyy_mm_dd
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', DeprecationWarning)
            result = _parse_yyyy_mm_dd('2024-01-15', '测试')
            assert result == date(2024, 1, 15)

    def test_empty_raises(self):
        from app.services.ad.upload.utils import _parse_yyyy_mm_dd
        from fastapi import HTTPException
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', DeprecationWarning)
            with pytest.raises(HTTPException):
                _parse_yyyy_mm_dd('', '测试')

    def test_invalid_format_raises(self):
        from app.services.ad.upload.utils import _parse_yyyy_mm_dd
        from fastapi import HTTPException
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', DeprecationWarning)
            with pytest.raises(HTTPException):
                _parse_yyyy_mm_dd('01/15/2024', '测试')

    def test_deprecation_warning(self):
        from app.services.ad.upload.utils import _parse_yyyy_mm_dd
        with pytest.warns(DeprecationWarning):
            _parse_yyyy_mm_dd('2024-01-15', '测试')


class TestEnsureSingleDayRange:
    def test_same_date_ok(self):
        from app.services.ad.upload.utils import _ensure_single_day_range
        _ensure_single_day_range(start_date=date(2024, 1, 1), end_date=date(2024, 1, 1))

    def test_different_dates_raises(self):
        from app.services.ad.upload.utils import _ensure_single_day_range
        from fastapi import HTTPException
        with pytest.raises(HTTPException):
            _ensure_single_day_range(start_date=date(2024, 1, 1), end_date=date(2024, 1, 2))


class TestDateToString:
    def test_valid(self):
        from app.services.ad.upload.utils import _date_to_string
        result = _date_to_string('2024-01-15')
        assert result == '2024-01-15'

    def test_none(self):
        from app.services.ad.upload.utils import _date_to_string
        assert _date_to_string(None) is None

    def test_empty(self):
        from app.services.ad.upload.utils import _date_to_string
        assert _date_to_string('') is None

    def test_pandas_timestamp(self):
        from app.services.ad.upload.utils import _date_to_string
        result = _date_to_string(pd.Timestamp('2024-06-15'))
        assert result == '2024-06-15'


class TestResolveRecordDateRange:
    def test_with_start_end(self):
        from app.services.ad.upload.utils import _resolve_record_date_range
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', DeprecationWarning)
            start, end = _resolve_record_date_range({'开始日期': '2024-01-01', '结束日期': '2024-01-31'})
            assert start == date(2024, 1, 1)
            assert end == date(2024, 1, 31)

    def test_with_row_date_only(self):
        from app.services.ad.upload.utils import _resolve_record_date_range
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', DeprecationWarning)
            start, end = _resolve_record_date_range({'日期': '2024-06-01'})
            assert start == date(2024, 6, 1)
            assert end == date(2024, 6, 1)

    def test_with_row_date_preferred(self):
        from app.services.ad.upload.utils import _resolve_record_date_range
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', DeprecationWarning)
            start, end = _resolve_record_date_range({
                '开始日期': '2024-01-01', '结束日期': '2024-01-31', '日期': '2024-06-15'
            })
            assert start == date(2024, 1, 1)
            assert end == date(2024, 1, 31)


class TestPrepareIngestDataFrame:
    def test_drop_all_na_rows(self):
        from app.services.ad.upload.utils import _prepare_ingest_dataframe
        df = pd.DataFrame({'a': [1, None, 3], 'b': [4, None, 6]})
        result = _prepare_ingest_dataframe(df)
        assert len(result) == 2

    def test_fill_start_date(self):
        from app.services.ad.upload.utils import _prepare_ingest_dataframe
        df = pd.DataFrame({'开始日期': ['2024-01-01', None], '名称': ['a', 'b']})
        result = _prepare_ingest_dataframe(df)
        assert result['开始日期'].iloc[1] == '2024-01-01'

    def test_fill_end_date(self):
        from app.services.ad.upload.utils import _prepare_ingest_dataframe
        df = pd.DataFrame({'结束日期': ['2024-01-31', None], '名称': ['a', 'b']})
        result = _prepare_ingest_dataframe(df)
        assert result['结束日期'].iloc[1] == '2024-01-31'


class TestRecordGetCi:
    def test_lowercase_key_matches_uppercase(self):
        from app.services.ad.upload.utils import _record_get_ci
        record = {'开始日期': '2024-01-01', '结束日期': '2024-01-31'}
        assert _record_get_ci(record, '开始日期') == '2024-01-01'
        assert _record_get_ci(record, '结束日期') == '2024-01-31'

    def test_uppercase_request_matches_lowercase_actual(self):
        from app.services.ad.upload.utils import _record_get_ci
        # 实际数据用大写列名（业务库现状），但 spec/ingest 用大写
        # → 即使 raw_row 是 {'开始日期': ...}，也能命中
        record = {'开始日期': '2024-01-01', '结束日期': '2024-01-31'}
        assert _record_get_ci(record, '开始日期') == '2024-01-01'

    def test_mixed_case(self):
        from app.services.ad.upload.utils import _record_get_ci
        # raw_row 是小写列名 (autoReportUpload 未走 _normalize_columns 时) 也能命中
        record = {'开始日期': '2024-01-01', '结束日期': '2024-01-31'}
        assert _record_get_ci(record, '开始日期') == '2024-01-01'
        assert _record_get_ci(record, '结束日期') == '2024-01-31'

    def test_missing_key_returns_default(self):
        from app.services.ad.upload.utils import _record_get_ci
        record = {'开始日期': '2024-01-01'}
        assert _record_get_ci(record, '结束日期') is None
        assert _record_get_ci(record, '不存在的列') is None

    def test_empty_record(self):
        from app.services.ad.upload.utils import _record_get_ci
        assert _record_get_ci({}, '开始日期') is None

    def test_passthrough_value(self):
        from app.services.ad.upload.utils import _record_get_ci
        # 任何值都原样返回
        assert _record_get_ci({'k': 0}, 'k') == 0
        assert _record_get_ci({'k': ''}, 'k') == ''
        assert _record_get_ci({'k': False}, 'k') is False


class TestFindColumnCi:
    def test_finds_existing_column(self):
        from app.services.ad.upload.utils import _find_column_ci
        df = pd.DataFrame(columns=['开始日期', '结束日期', '广告SKU'])
        assert _find_column_ci(df, '开始日期') == '开始日期'
        assert _find_column_ci(df, '结束日期') == '结束日期'
        assert _find_column_ci(df, '广告SKU') == '广告SKU'

    def test_lowercase_request_matches_uppercase_actual(self):
        from app.services.ad.upload.utils import _find_column_ci
        df = pd.DataFrame(columns=['开始日期', '结束日期'])
        assert _find_column_ci(df, '开始日期') == '开始日期'
        assert _find_column_ci(df, '结束日期') == '结束日期'

    def test_mixed_case(self):
        from app.services.ad.upload.utils import _find_column_ci
        df = pd.DataFrame(columns=['开始日期', '结束日期'])
        assert _find_column_ci(df, '开始日期') == '开始日期'

    def test_returns_none_when_missing(self):
        from app.services.ad.upload.utils import _find_column_ci
        df = pd.DataFrame(columns=['开始日期'])
        assert _find_column_ci(df, '结束日期') is None

    def test_empty_dataframe(self):
        from app.services.ad.upload.utils import _find_column_ci
        df = pd.DataFrame()
        assert _find_column_ci(df, '开始日期') is None


class TestResolveRecordDateRangeCi:
    def test_uppercase_columns_with_uppercase_request(self):
        from app.services.ad.upload.utils import _resolve_record_date_range
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', DeprecationWarning)
            start, end = _resolve_record_date_range(
                {'开始日期': '2024-01-01', '结束日期': '2024-01-31'}
            )
            assert start == date(2024, 1, 1)
            assert end == date(2024, 1, 31)

    def test_lowercase_columns_with_uppercase_request(self):
        from app.services.ad.upload.utils import _resolve_record_date_range
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', DeprecationWarning)
            start, end = _resolve_record_date_range(
                {'开始日期': '2024-01-01', '结束日期': '2024-01-31'}
            )
            assert start == date(2024, 1, 1)
            assert end == date(2024, 1, 31)

    def test_mixed_case_columns(self):
        from app.services.ad.upload.utils import _resolve_record_date_range
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', DeprecationWarning)
            start, end = _resolve_record_date_range(
                {'开始日期': '2024-02-01', '结束日期': '2024-02-28'}
            )
            assert start == date(2024, 2, 1)
            assert end == date(2024, 2, 28)

