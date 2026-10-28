from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pandas as pd
import pytest
from fastapi import HTTPException


@pytest.mark.recognition
@pytest.mark.ad_report
class TestDetectReportSpec:
    def test_detect_campaign_csv(self):
        from app.services.ad.upload.recognition import _detect_report_spec
        df = pd.DataFrame(columns=['开始日期', '结束日期', '广告活动名称', '预算', '定位类型', '竞价策略'])
        spec = _detect_report_spec(df, '.csv')
        assert spec.report_type == 'ad_campaign_report'

    def test_detect_budget_csv(self):
        from app.services.ad.upload.recognition import _detect_report_spec
        df = pd.DataFrame(columns=['开始日期', '结束日期', '广告活动名称', '建议预算', '预算范围内的平均时间'])
        spec = _detect_report_spec(df, '.csv')
        assert spec.report_type == 'ad_budget_report'

    def test_detect_xlsx_with_start_end(self):
        from app.services.ad.upload.recognition import _detect_report_spec
        df = pd.DataFrame(columns=['开始日期', '结束日期', '广告SKU', '广告ASIN', '已购买的ASIN'])
        spec = _detect_report_spec(df, '.xlsx')
        assert spec.report_type == 'ad_purchased_product_report'

    def test_detect_periodic_format(self):
        from app.services.ad.upload.recognition import _detect_report_spec
        df = pd.DataFrame(columns=['日期', '国家/地区', '货币', '点击量', '单次点击成本 (CPC)', '花费'])
        spec = _detect_report_spec(df, '.xlsx')
        assert spec.report_type == 'ad_time_trend_report'

    def test_no_match_raises(self):
        from app.services.ad.upload.recognition import _detect_report_spec
        df = pd.DataFrame(columns=['随机列1', '随机列2'])
        with pytest.raises(HTTPException) as exc:
            _detect_report_spec(df, '.csv')
        assert '未命中' in str(exc.value.detail)

    def test_wrong_extension(self):
        from app.services.ad.upload.recognition import _detect_report_spec
        df = pd.DataFrame(columns=['开始日期', '结束日期', '广告SKU', '广告ASIN', '已购买的ASIN'])
        with pytest.raises(HTTPException):
            _detect_report_spec(df, '.csv')  # purchased_product requires .xlsx

    def test_detect_placement(self):
        from app.services.ad.upload.recognition import _detect_report_spec
        df = pd.DataFrame(columns=['开始日期', '结束日期', '广告活动名称', '放置'])
        spec = _detect_report_spec(df, '.xlsx')
        assert spec.report_type == 'ad_placement_report'

    def test_detect_invalid_traffic(self):
        from app.services.ad.upload.recognition import _detect_report_spec
        df = pd.DataFrame(columns=['开始日期', '结束日期', '广告活动名称', '总展示量', '无效展示量', '无效点击'])
        spec = _detect_report_spec(df, '.xlsx')
        assert spec.report_type == 'ad_invalid_traffic_report'

    def test_detect_target(self):
        from app.services.ad.upload.recognition import _detect_report_spec
        df = pd.DataFrame(columns=['开始日期', '结束日期', '投放', '匹配类型', '搜索结果首页首位展示量份额'])
        spec = _detect_report_spec(df, '.xlsx')
        assert spec.report_type == 'ad_target_report'

    def test_detect_search_term(self):
        from app.services.ad.upload.recognition import _detect_report_spec
        df = pd.DataFrame(columns=['开始日期', '结束日期', '投放', '匹配类型', '客户搜索词'])
        spec = _detect_report_spec(df, '.xlsx')
        assert spec.report_type == 'ad_search_term_report'

    def test_detect_search_term_share(self):
        from app.services.ad.upload.recognition import _detect_report_spec
        df = pd.DataFrame(columns=['开始日期', '结束日期', '客户搜索词', '搜索词展示量排名', '搜索词展示量份额'])
        spec = _detect_report_spec(df, '.csv')
        assert spec.report_type == 'ad_search_term_share_report'

    def test_detect_promoted_product(self):
        from app.services.ad.upload.recognition import _detect_report_spec
        df = pd.DataFrame(columns=['开始日期', '结束日期', '广告SKU', '广告ASIN', '广告活动名称', '广告组名称'])
        spec = _detect_report_spec(df, '.xlsx')
        assert spec.report_type == 'ad_promoted_product_report'

    def test_detect_new_promoted_product_format(self):
        from app.services.ad.upload.recognition import _detect_report_spec
        df = pd.DataFrame(columns=[
            '日期范围', '广告组合名称', '预算货币', '广告活动名称', '广告组名称',
            '投放广告活动的国家/地区', '推广的商品 SKU-Advertised product SKU',
            '推广的商品编号', '展示量', '点击量', '点击率', 'CPC', '总成本',
            '销售额', '归因于点击的 ROAS', '购买量', '由点击产生的已售商品数量',
            '点击购买率', '已售商品数量（推广）', '已售商品数量（光环）',
            '推广商品的销量', '销售额（光环）',
        ])
        spec = _detect_report_spec(df, '.xlsx')
        assert spec.report_type == 'ad_promoted_product_report'
        assert ('sku', '推广的商品 SKU-Advertised product SKU') in spec.project_match_fields


@pytest.mark.recognition
@pytest.mark.ad_report
class TestDetectReportSpecCaseInsensitive:
    """业务库现状：raw_row 列名都是大写，spec/ingest 函数也用大写。
    但 autoReportUpload 走的是 _normalize_columns (strip-only)，
    部分上游可能传入大写或混合大小写。_detect_report_spec 必须 CI 匹配。
    """

    def test_lowercase_columns_match_uppercase_required(self):
        from app.services.ad.upload.recognition import _detect_report_spec
        df = pd.DataFrame(columns=['开始日期', '结束日期', '广告活动名称', '预算', '定位类型', '竞价策略'])
        spec = _detect_report_spec(df, '.csv')
        assert spec.report_type == 'ad_campaign_report'

    def test_uppercase_columns_match_uppercase_required(self):
        from app.services.ad.upload.recognition import _detect_report_spec
        # 业务库 raw_row 都是大写，spec required 是大写
        df = pd.DataFrame(columns=['开始日期', '结束日期', '广告活动名称', '预算', '定位类型', '竞价策略'])
        spec = _detect_report_spec(df, '.csv')
        assert spec.report_type == 'ad_campaign_report'

    def test_promoted_product_lowercase(self):
        from app.services.ad.upload.recognition import _detect_report_spec
        df = pd.DataFrame(columns=['开始日期', '结束日期', '广告SKU', '广告ASIN', '广告活动名称', '广告组名称'])
        spec = _detect_report_spec(df, '.xlsx')
        assert spec.report_type == 'ad_promoted_product_report'

    def test_search_term_lowercase(self):
        from app.services.ad.upload.recognition import _detect_report_spec
        df = pd.DataFrame(columns=['开始日期', '结束日期', '投放', '匹配类型', '客户搜索词'])
        spec = _detect_report_spec(df, '.xlsx')
        assert spec.report_type == 'ad_search_term_report'

    def test_time_trend_lowercase(self):
        from app.services.ad.upload.recognition import _detect_report_spec
        df = pd.DataFrame(columns=['日期', '国家/地区', '货币', '点击量', '单次点击成本 (CPC)', '花费'])
        spec = _detect_report_spec(df, '.xlsx')
        assert spec.report_type == 'ad_time_trend_report'

    def test_lowercase_does_not_change_actual_columns(self):
        """raw_row 仍然保留原 case（不被 lower 污染）。"""
        from app.services.ad.upload.recognition import _detect_report_spec
        df = pd.DataFrame(columns=['开始日期', '结束日期', '广告活动名称', '预算', '定位类型', '竞价策略'])
        _detect_report_spec(df, '.csv')
        # spec.required_columns 是大写（specs.py 静态定义）
        # 但 _detect_report_spec 不修改 df.columns
        assert list(df.columns) == ['开始日期', '结束日期', '广告活动名称', '预算', '定位类型', '竞价策略']



@pytest.mark.recognition
@pytest.mark.ad_report
@pytest.mark.upload
class TestSaveAdUploadTempFile:
    def test_no_filename_raises(self):
        from app.services.ad.upload.recognition import save_ad_upload_temp_file
        mock_file = MagicMock()
        mock_file.filename = None
        mock_settings = MagicMock()
        with pytest.raises(HTTPException) as exc:
            save_ad_upload_temp_file(mock_file, mock_settings)
        assert 'Missing filename' in str(exc.value.detail)

    def test_bad_extension_raises(self):
        from app.services.ad.upload.recognition import save_ad_upload_temp_file
        mock_file = MagicMock()
        mock_file.filename = 'test.pdf'
        mock_settings = MagicMock()
        with pytest.raises(HTTPException) as exc:
            save_ad_upload_temp_file(mock_file, mock_settings)
        assert 'Unsupported extension' in str(exc.value.detail)


@pytest.mark.recognition
@pytest.mark.ad_report
@pytest.mark.upload
class TestResolveAdUploadTempFilePath:
    def test_file_not_found(self):
        from app.services.ad.upload.recognition import resolve_ad_upload_temp_file_path
        mock_settings = MagicMock()
        mock_settings.upload_root = Path('/nonexistent')
        with pytest.raises(FileNotFoundError):
            resolve_ad_upload_temp_file_path(mock_settings, 'nonexistent_file_id')


@pytest.mark.recognition
@pytest.mark.ad_report
@pytest.mark.upload
class TestRecognizeSavedAdUpload:
    def test_calls_internal_functions(self):
        from app.services.ad.upload.recognition import recognize_saved_ad_upload
        import app.services.ad.upload.recognition as rec

        mock_db = MagicMock()
        mock_settings = MagicMock()
        mock_settings.upload_root = Path('/tmp')

        df = pd.DataFrame({'开始日期': ['2024-01-01'], '结束日期': ['2024-01-01'],
                           '广告活动名称': ['test'], '预算': ['100'], '定位类型': ['auto'],
                           '竞价策略': ['dynamic']})

        with patch.object(rec, 'resolve_ad_upload_temp_file_path') as mock_resolve:
            with patch.object(rec, '_read_dataframe', return_value=df):
                with patch.object(rec, '_detect_report_spec') as mock_detect:
                    with patch.object(rec, 'project_service') as mock_ps:
                        mock_resolve.return_value = Path('/tmp/test.csv')
                        mock_detect.return_value.report_type = 'ad_campaign_report'
                        mock_detect.return_value.report_label = '广告活动'
                        mock_detect.return_value.required_columns = ('开始日期', '结束日期', '广告活动名称', '预算', '定位类型', '竞价策略')
                        mock_detect.return_value.project_match_fields = ()
                        mock_ps.list_project_items.return_value = []

                        result = recognize_saved_ad_upload(
                            mock_db, mock_settings,
                            temp_file_id='test_id',
                            original_filename='test.csv',
                        )
                        assert result.status == 'recognized'
                        assert result.report_type == 'ad_campaign_report'

    def test_recognize_new_promoted_product_format_detects_dates_and_country(self):
        import app.services.ad.upload.recognition as rec
        from app.schemas.ad_upload import AdUploadProjectMatchSummary

        df = pd.DataFrame([{
            '日期范围': '2026年10月26日 - 2026年10月26日',
            '广告组合名称': '250-C',
            '预算货币': 'USD',
            '广告活动名称': 'campaign',
            '广告组名称': 'group',
            '投放广告活动的国家/地区': 'US',
            '推广的商品 SKU-Advertised product SKU': 'SKU-1',
            '推广的商品编号': 'B000000001',
            '展示量': 20,
            '点击量': 2,
            '点击率': 10,
            'CPC': 1.5,
            '总成本': 3,
        }])
        mock_db = MagicMock()
        mock_settings = MagicMock()
        mock_settings.upload_root = Path('/tmp')
        with patch.object(rec, 'resolve_ad_upload_temp_file_path', return_value=Path('/tmp/new.xlsx')):
            with patch.object(rec, '_read_dataframe', return_value=df):
                with patch.object(rec.project_service, 'list_project_items', return_value=[]):
                    with patch.object(
                        rec,
                        '_build_project_match',
                        return_value=AdUploadProjectMatchSummary(status='manual'),
                    ):
                        result = rec.recognize_saved_ad_upload(
                            mock_db,
                            mock_settings,
                            temp_file_id='new',
                            original_filename='new.xlsx',
                        )
        assert result.report_type == 'ad_promoted_product_report'
        assert result.country == 'US'
        assert result.detected_start_date == '2026-10-26'
        assert result.detected_end_date == '2026-10-26'


@pytest.mark.recognition
@pytest.mark.ad_report
@pytest.mark.upload
class TestFinalizeAdUploadTempFile:
    def test_unsupported_extension_raises(self):
        from app.services.ad.upload.recognition import finalize_ad_upload_temp_file
        mock_settings = MagicMock()
        with patch('app.services.ad.upload.recognition.resolve_ad_upload_temp_file_path',
                   return_value=Path('/tmp/test.pdf')):
            with pytest.raises(HTTPException) as exc:
                finalize_ad_upload_temp_file(
                    mock_settings,
                    temp_file_id='x',
                    original_filename='test.pdf',
                    project_name='p',
                    report_type='ad_campaign_report',
                )
            assert 'Unsupported extension' in str(exc.value.detail)
