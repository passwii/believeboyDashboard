from __future__ import annotations

from datetime import date
from pathlib import Path

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.schemas.upload import (
    ReportCommitRequest,
    ReportCommitResponse,
    ReportProjectMatchSummary,
)
from app.models import ReportUploadStatus
from app.services.data.upload.recognition import recognize_saved_report_upload
from app.services.product.persistence import (
    _get_project_by_name,
    _load_project_product_mapping,
    _persist_one_source_file,
    persist_single_analysis_source,
)
from app.services.product.sales import persist_sales_report_by_purchase_date
from app.services import project_service
from app.services import upload_service
from app.services.infra import (
    invalidate_daily_analysis_cache as _invalidate_daily_analysis_cache,
)
from app.services.report_type_service import AD_PRODUCT_REPORT, normalize_report_type
from app.utils.constants import SUPPORTED_REPORT_TYPES
from app.utils.country import normalize_country as _normalize_country
from app.utils.date_utils import parse_yyyy_mm_dd as _parse_yyyy_mm_dd
from app.services.data.upload.dedup import find_sha256_duplicates
from app.utils.persist_helpers import write_report_upload_log
from app.utils.utils import sha256_file as _sha256_file


def _recognition_matches_declared(declared: str, recognized: str) -> bool:
    """识别结果是否满足声明类型（report_type 一致性校验）。

    新识别器只输出拆分的 ``inventory_ledger_summary`` / ``inventory_ledger_detail``，
    不再输出旧值 ``inventory_ledger``。声明旧值的受控兼容客户端在此放行，
    由入库层按表头自动路由（旧分支 expected_kind=None）；新调用方必须精确一致。
    """
    if declared == recognized:
        return True
    return (
        declared == "inventory_ledger"
        and recognized in {"inventory_ledger_summary", "inventory_ledger_detail"}
    )


def commit_report_upload(
    db: Session,
    settings: Settings,
    *,
    payload: ReportCommitRequest,
    operator: str | None = None,
    is_admin: bool = True,
) -> ReportCommitResponse:
    recognition: ReportRecognitionResponse | None = None
    project_match: ReportProjectMatchSummary | None = None
    report_type = normalize_report_type(payload.report_type)
    if report_type not in SUPPORTED_REPORT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported report_type: {report_type}",
        )

    country = _normalize_country(payload.country)
    raw_project_name = (payload.project_name or "").strip()

    is_auto_commit = not raw_project_name

    allowed_projects = {
        str(item.project_name)
        for item in project_service.list_project_items(
            db, operator=operator, is_admin=is_admin
        )
    }

    if is_auto_commit:
        if report_type != "ad_search_term_report":
            auto_recognition = recognize_saved_report_upload(
                db,
                settings,
                temp_file_id=payload.temp_file_id,
                original_filename=(
                    payload.original_filename or payload.temp_file_id
                ).strip(),
                country=country,
                operator=operator,
                is_admin=is_admin,
            )
            if auto_recognition.status != "recognized":
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"文件识别失败，无法确认项目归属：{auto_recognition.reason}",
                )
            recognized_type = normalize_report_type(auto_recognition.report_type)
            if not _recognition_matches_declared(report_type, recognized_type):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="report_type does not match recognized report",
                )
            if (
                report_type
                in {
                    "sales_report",
                    "inventory_report",
                    "business_report",
                    AD_PRODUCT_REPORT,
                    "payment_report",
                    "return_report",
                }
                and auto_recognition.country != country
            ):
                # 多站点销售报表 / 退货报表：跳过国家验证，后端会自动按站点拆分
                is_multi_country_sales = (
                    report_type == "sales_report"
                    and auto_recognition.detected_countries
                    and len(auto_recognition.detected_countries) > 1
                )
                is_multi_country_return = (
                    report_type == "return_report"
                    and auto_recognition.detected_countries
                    and len(auto_recognition.detected_countries) > 1
                )
                if not is_multi_country_sales and not is_multi_country_return:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=(
                            f"文件站点（{auto_recognition.country}）与所选站点（{country}）不一致，"
                            "请确认后重新上传到对应站点"
                        ),
                    )
            auto_project_match = auto_recognition.project_match
            if (
                auto_project_match.status != "matched"
                or not auto_project_match.project_name
            ):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="文件未匹配到唯一项目，请先确认文件归属后再入库",
                )
            project_name = auto_project_match.project_name
            if project_name not in allowed_projects:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN, detail="无权限访问该项目"
                )
            recognition = auto_recognition
            project_match = auto_project_match

    else:
        project_name = raw_project_name
        if project_name not in allowed_projects:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="无权限访问该项目"
            )
        if report_type != "ad_search_term_report":
            recognition = recognize_saved_report_upload(
                db,
                settings,
                temp_file_id=payload.temp_file_id,
                original_filename=(
                    payload.original_filename or payload.temp_file_id
                ).strip(),
                country=country,
                operator=operator,
                is_admin=is_admin,
            )
            if recognition.status != "recognized":
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"文件识别失败，无法确认项目归属：{recognition.reason}",
                )
            recognized_type = normalize_report_type(recognition.report_type)
            if not _recognition_matches_declared(report_type, recognized_type):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="report_type does not match recognized report",
                )
            if (
                report_type
                in {
                    "sales_report",
                    "inventory_report",
                    "business_report",
                    AD_PRODUCT_REPORT,
                    "payment_report",
                    "return_report",
                }
                and recognition.country != country
            ):
                # 多站点销售/退货报表：跳过国家验证，后端会自动按站点拆分
                is_multi_country_sales = (
                    report_type == "sales_report"
                    and recognition.detected_countries
                    and len(recognition.detected_countries) > 1
                )
                is_multi_country_return = (
                    report_type == "return_report"
                    and recognition.detected_countries
                    and len(recognition.detected_countries) > 1
                )
                if not is_multi_country_sales and not is_multi_country_return:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=(
                            f"文件站点（{recognition.country}）与所选站点（{country}）不一致，"
                            "请确认后重新上传到对应站点"
                        ),
                    )
            project_match = recognition.project_match
            if project_match.status != "matched" or not project_match.project_name:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="文件未匹配到唯一项目，请先确认文件归属后再入库",
                )
            if project_match.project_name != project_name:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=(
                        "文件匹配项目与当前选择不一致："
                        f"文件匹配为 {project_match.project_name}，当前选择为 {project_name}"
                    ),
                )

    original_filename = (
        payload.original_filename or ""
    ).strip() or payload.temp_file_id
    file_meta = upload_service.finalize_report_upload_temp_file(
        settings,
        temp_file_id=payload.temp_file_id,
        original_filename=original_filename,
        project_name=project_name,
        file_type=report_type,
    )

    # dry_run=True：临时核算/手动核算场景 — 仅完成识别校验 + 临时文件复制，
    # 不写入 analysis_source_files / 业务/广告/付款/退货行表，不写 ReportUploadLog。
    # 原报表仍可继续在 report-upload 页面通过正式 commit 入库。
    if payload.dry_run:
        start_d = (payload.report_start_date or "").strip()
        end_d = (payload.report_end_date or "").strip()
        return ReportCommitResponse(
            report_type=report_type,
            status="skipped",
            project_name=project_name,
            country=country,
            report_date=(payload.report_date or "").strip() or None,
            report_start_date=start_d or None,
            report_end_date=end_d or None,
            file_id=str(file_meta["file_id"]),
            file_path=str(file_meta["file_path"]),
            persisted_source_id=None,
            persisted_table=None,
            message=(
                f"已识别为报表（dry_run）：未写入 analysis_source_files。"
                f"文件已暂存，临时文件 ID={file_meta['file_id']}。"
            ),
            duplicate_warnings=[],
        )

    # SHA-256 duplicate detection (warn only, do not block)
    file_path = Path(file_meta["file_path"])
    file_sha256 = _sha256_file(file_path)
    duplicates = find_sha256_duplicates(db, file_sha256)
    duplicate_warnings = []
    if duplicates:
        from app.models import Project

        for dup in duplicates:
            project = (
                db.execute(select(Project).where(Project.id == dup.project_id))
                .scalars()
                .first()
            )
            project_name = (
                project.project_name if project else f"project_id={dup.project_id}"
            )
            duplicate_warnings.append(
                {
                    "project_name": project_name,
                    "report_type": dup.report_type,
                    "country": dup.country,
                    "period": f"{dup.period_start_date} ~ {dup.period_end_date}"
                    if dup.period_start_date
                    else "N/A",
                    "original_filename": dup.original_filename,
                }
            )

    persisted_source_id: int | None = None
    persisted_table: str | None = None
    response_status: str = "saved"
    message = "文件已保存"

    if report_type == "inventory_report":
        report_date = (payload.report_date or "").strip()
        if not report_date:
            if recognition and recognition.detected_date:
                report_date = recognition.detected_date
        if not report_date:
            raise HTTPException(status_code=422, detail="report_date is required")
        outcome = persist_single_analysis_source(
            db,
            project_name=project_name,
            report_type="inventory_report",
            country=country,
            upload_file_id=file_meta["file_id"],
            upload_file_path=file_meta["file_path"],
            report_date=report_date,
            created_by=operator,
        )
        if not outcome.success:
            raise HTTPException(
                status_code=400, detail=outcome.error_message or "库存报表入库失败"
            )
        persisted_source_id = outcome.source_id
        persisted_table = "analysis_source_files"
        response_status = "persisted"
        message = "库存报表已保存并写入库存源数据"
        project = _get_project_by_name(db, project_name)
        _invalidate_daily_analysis_cache(project.id)
    elif report_type == "inventory_ledger":
        # Amazon Inventory Ledger CSV → inventory_ledger_summary / _detail
        # (auto-detected by headers) + inventory_ledger_ingest_batch
        from app.services.inventory.ledger import ingest_ledger_csv

        project = _get_project_by_name(db, project_name)
        file_path = file_meta["file_path"]
        with open(file_path, "rb") as f:
            csv_content = f.read()
        row_count = ingest_ledger_csv(
            db,
            project_id=project.id,
            csv_content=csv_content,
            filename=payload.original_filename or "",
            loaded_by=operator,
        )
        response_status = "persisted"
        message = f"库存盘点数据已入库（{row_count} 行）"
    elif report_type in {"inventory_ledger_summary", "inventory_ledger_detail"}:
        # 库存分类账独立类型：声明类型必须与 CSV 表头一致，分别只写
        # inventory_ledger_summary / inventory_ledger_detail 目标表，
        # 不落入通用 _persist_single_source 路径。
        from app.services.inventory.ledger import ingest_ledger_csv

        expected_kind = (
            "summary" if report_type == "inventory_ledger_summary" else "detail"
        )
        view_label = "汇总视图" if expected_kind == "summary" else "明细视图"
        project = _get_project_by_name(db, project_name)
        file_path = file_meta["file_path"]
        with open(file_path, "rb") as f:
            csv_content = f.read()
        try:
            row_count = ingest_ledger_csv(
                db,
                project_id=project.id,
                csv_content=csv_content,
                filename=payload.original_filename or "",
                loaded_by=operator,
                expected_kind=expected_kind,
            )
        except ValueError as exc:
            # 声明类型与表头不一致 / 格式不完整等：结构化 4xx，不落裸 500。
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=str(exc),
            ) from exc
        response_status = "persisted"
        message = f"库存分类账{view_label}已入库（{row_count} 行）"
    elif report_type == "business_report":
        if payload.use_period_dates:
            start = (payload.report_start_date or "").strip()
            end = (payload.report_end_date or "").strip()
            if not start or not end:
                raise HTTPException(
                    status_code=422,
                    detail="report_start_date and report_end_date are required",
                )
            project = _get_project_by_name(db, project_name)
            known_skus, known_asins = _load_project_product_mapping(
                db, project.project_name, country
            )
            start_d = _parse_yyyy_mm_dd(start, "report_start_date")
            end_d = _parse_yyyy_mm_dd(end, "report_end_date")
            outcome = _persist_one_source_file(
                db,
                project=project,
                report_type="business_report",
                country=country,
                report_date=None,
                period_start_date=start_d,
                period_end_date=end_d,
                upload_file_id=file_meta["file_id"],
                upload_file_path=file_meta["file_path"],
                known_skus=known_skus,
                known_asins=known_asins,
                created_by=operator,
            )
            if not outcome.success:
                raise HTTPException(
                    status_code=400, detail=outcome.error_message or "业务报表入库失败"
                )
            persisted_source_id = outcome.source_id
            persisted_table = "analysis_source_files"
            response_status = "persisted"
            message = "业务报表已按周期保存并写入业务源数据"
            _invalidate_daily_analysis_cache(project.id)
        else:
            report_date = (payload.report_date or "").strip()
            if not report_date:
                raise HTTPException(status_code=422, detail="report_date is required")
            outcome = persist_single_analysis_source(
                db,
                project_name=project_name,
                report_type="business_report",
                country=country,
                upload_file_id=file_meta["file_id"],
                upload_file_path=file_meta["file_path"],
                report_date=report_date,
                report_start_date=report_date,
                report_end_date=report_date,
                created_by=operator,
            )
            if not outcome.success:
                raise HTTPException(
                    status_code=400, detail=outcome.error_message or "业务报表入库失败"
                )
            persisted_source_id = outcome.source_id
            persisted_table = "analysis_source_files"
            response_status = "persisted"
            message = "业务报表已保存并写入业务源数据"
            project = _get_project_by_name(db, project_name)
            _invalidate_daily_analysis_cache(project.id)
    elif report_type == AD_PRODUCT_REPORT:
        if payload.use_period_dates:
            start = (payload.report_start_date or "").strip()
            end = (payload.report_end_date or "").strip()
            if not start or not end:
                raise HTTPException(
                    status_code=422,
                    detail="report_start_date and report_end_date are required",
                )
            project = _get_project_by_name(db, project_name)
            known_skus, known_asins = _load_project_product_mapping(
                db, project.project_name, country
            )
            start_d = _parse_yyyy_mm_dd(start, "report_start_date")
            end_d = _parse_yyyy_mm_dd(end, "report_end_date")
            outcome = _persist_one_source_file(
                db,
                project=project,
                report_type=AD_PRODUCT_REPORT,
                country=country,
                report_date=None,
                period_start_date=start_d,
                period_end_date=end_d,
                upload_file_id=file_meta["file_id"],
                upload_file_path=file_meta["file_path"],
                known_skus=known_skus,
                known_asins=known_asins,
                created_by=operator,
            )
            if not outcome.success:
                raise HTTPException(
                    status_code=400, detail=outcome.error_message or "广告报表入库失败"
                )
            persisted_source_id = outcome.source_id
            persisted_table = "analysis_source_files"
            response_status = "persisted"
            message = "广告报表已按周期保存并写入分析广告源数据"
            _invalidate_daily_analysis_cache(project.id)
        else:
            report_date = (payload.report_date or "").strip()
            if not report_date:
                if recognition and recognition.detected_date:
                    report_date = recognition.detected_date
            if not report_date:
                raise HTTPException(status_code=422, detail="report_date is required")
            outcome = persist_single_analysis_source(
                db,
                project_name=project_name,
                report_type=AD_PRODUCT_REPORT,
                country=country,
                upload_file_id=file_meta["file_id"],
                upload_file_path=file_meta["file_path"],
                report_date=report_date,
                report_start_date=report_date,
                report_end_date=report_date,
                created_by=operator,
            )
            if not outcome.success:
                raise HTTPException(
                    status_code=400, detail=outcome.error_message or "广告报表入库失败"
                )
            persisted_source_id = outcome.source_id
            persisted_table = "analysis_source_files"
            response_status = "persisted"
            message = "广告报表已保存并写入分析广告源数据"
            project = _get_project_by_name(db, project_name)
            _invalidate_daily_analysis_cache(project.id)
    elif report_type == "sales_report":
        # BEL-348：固定"计数截至日期"快照，避免 is_counted_sales 在
        # 多次重传时按函数执行当下的墙钟日期重算而翻转。
        # 优先用用户选定的 report_date；自动上报无 report_date 时退回识别到的日期。
        count_as_of_date = None
        _rd = (payload.report_date or "").strip()
        if _rd:
            count_as_of_date = _parse_yyyy_mm_dd(_rd, "report_date")
        elif recognition and recognition.detected_date:
            count_as_of_date = _parse_yyyy_mm_dd(
                recognition.detected_date, "report_date"
            )
        outcome = persist_sales_report_by_purchase_date(
            db,
            project_name=project_name,
            country=country,
            upload_file_id=file_meta["file_id"],
            upload_file_path=file_meta["file_path"],
            created_by=operator,
            count_as_of_date=count_as_of_date,
        )
        if not outcome["success"]:
            raise HTTPException(
                status_code=400,
                detail=str(outcome.get("error_message") or "销售报表入库失败"),
            )
        persisted_source_id = outcome.get("latest_source_id")
        persisted_table = "analysis_source_files"
        response_status = "persisted"
        payload.report_start_date = outcome.get("report_start_date")
        payload.report_end_date = outcome.get("report_end_date")
        message = (
            outcome.get("message") or "销售报表已按购买日期拆分并写入分析销售源数据"
        )
        project = _get_project_by_name(db, project_name)
        _invalidate_daily_analysis_cache(project.id)
    elif report_type == "payment_report":
        start_date = (payload.report_start_date or "").strip()
        end_date = (payload.report_end_date or "").strip()
        if not start_date or not end_date:
            raise HTTPException(
                status_code=422,
                detail="report_start_date and report_end_date are required",
            )
        if payload.use_period_dates:
            project = _get_project_by_name(db, project_name)
            known_skus, known_asins = _load_project_product_mapping(
                db, project.project_name, country
            )
            start_d = _parse_yyyy_mm_dd(start_date, "report_start_date")
            end_d = _parse_yyyy_mm_dd(end_date, "report_end_date")
            outcome = _persist_one_source_file(
                db,
                project=project,
                report_type="payment_report",
                country=country,
                report_date=None,
                period_start_date=start_d,
                period_end_date=end_d,
                upload_file_id=file_meta["file_id"],
                upload_file_path=file_meta["file_path"],
                known_skus=known_skus,
                known_asins=known_asins,
                created_by=operator,
            )
            if not outcome.success:
                raise HTTPException(
                    status_code=400, detail=outcome.error_message or "付款报告入库失败"
                )
            persisted_source_id = outcome.source_id
            persisted_table = "analysis_source_files"
            response_status = "persisted"
            message = "付款报告已按周期保存并写入付款源数据"
            _invalidate_daily_analysis_cache(project.id)
        else:
            outcome = persist_single_analysis_source(
                db,
                project_name=project_name,
                report_type="payment_report",
                country=country,
                upload_file_id=file_meta["file_id"],
                upload_file_path=file_meta["file_path"],
                report_start_date=start_date,
                report_end_date=end_date,
                created_by=operator,
            )
            if not outcome.success:
                raise HTTPException(
                    status_code=400, detail=outcome.error_message or "付款报告入库失败"
                )
            persisted_source_id = outcome.source_id
            persisted_table = "analysis_source_files"
            response_status = "persisted"
            message = "付款报告已保存并写入付款源数据"
            project = _get_project_by_name(db, project_name)
            _invalidate_daily_analysis_cache(project.id)
    elif report_type == "ad_search_term_report":
        report_date = (payload.report_date or "").strip()
        if not report_date:
            raise HTTPException(status_code=422, detail="report_date is required")
        persisted_source_id = upsert_file_only_report_status(
            db,
            project_name=project_name,
            report_type="ad_search_term_report",
            report_date=report_date,
            country=country,
            file_id=str(file_meta["file_id"]),
            file_path=str(file_meta["file_path"]),
            original_filename=str(file_meta["original_filename"]),
            created_by=operator,
        )
        persisted_table = "report_upload_statuses"
        message = "搜索词报表已保存，本期不拆行落库"
    elif report_type == "return_report":
        from app.services.analysis.return_analysis import persist_return_report

        outcome = persist_return_report(
            db,
            project_name=project_name,
            country=country,
            file_path=str(file_meta["file_path"]),
            created_by=operator,
            detected_countries=recognition.detected_countries if recognition else None,
        )
        if not outcome["success"]:
            raise HTTPException(
                status_code=400,
                detail=str(outcome.get("error_message") or "退货报表入库失败"),
            )
        persisted_source_id = outcome.get("source_id")
        persisted_table = "analysis_return_rows"
        response_status = "persisted"
        payload.report_start_date = outcome.get("report_start_date")
        payload.report_end_date = outcome.get("report_end_date")
        message = outcome.get("message") or "退货报表已保存并写入退货数据"

    # Write upload log for single-day reports only.
    # Multi-day / periodic reports (sales_report, payment_report) are skipped
    # to avoid false "complete" markers on the RPA status grid — their coverage
    # is detected by date-range fallback queries against analysis_source_files.
    # Period-mode uploads (use_period_dates=True) are also skipped since they
    # represent periodic data, not daily uploads.
    _is_period_mode = getattr(payload, "use_period_dates", False)
    if (
        response_status == "persisted"
        and report_type
        in {
            "inventory_report",
            "business_report",
            "ad_product_report",
            "return_report",
        }
        and not _is_period_mode
    ):
        project = _get_project_by_name(db, project_name)
        write_report_upload_log(
            db,
            project_id=project.id,
            country=country,
            report_type=report_type,
            source_file_id=persisted_source_id,
            has_real_data=True,
            original_filename=original_filename,
        )

    def _coerce_date_to_iso_str(value: object) -> str | None:
        """归一化 report_start_date / report_end_date 为 ISO 字符串。

        不同分支对 payload 这两个字段的赋值类型不一致：
        - sales_report 分支：persist_sales_report_by_purchase_date 已返回 .isoformat() 字符串
        - return_report 分支：persist_return_report 返回的是 datetime.date 对象
        - 其他分支：保持 None 或用户传入的字符串
        Pydantic 在末尾构造 ReportCommitResponse 时 schema 强制 str|None，这里统一兜底。
        """
        if value is None:
            return None
        if isinstance(value, date):
            return value.isoformat()
        text = str(value).strip()
        return text or None

    return ReportCommitResponse(
        report_type=report_type,
        status=response_status,
        project_name=project_name,
        country=country,
        report_date=payload.report_date,
        report_start_date=_coerce_date_to_iso_str(payload.report_start_date),
        report_end_date=_coerce_date_to_iso_str(payload.report_end_date),
        file_id=str(file_meta["file_id"]),
        file_path=str(file_meta["file_path"]),
        persisted_source_id=persisted_source_id,
        persisted_table=persisted_table,
        message=message,
        duplicate_warnings=duplicate_warnings,
    )


def upsert_file_only_report_status(
    db: Session,
    *,
    project_name: str,
    report_type: str,
    report_date: str,
    country: str,
    file_id: str,
    file_path: str,
    original_filename: str,
    created_by: str | None,
) -> int:
    if report_type != "ad_search_term_report":
        raise ValueError(f"Unsupported file-only report_type: {report_type}")

    ReportUploadStatus.__table__.create(bind=db.get_bind(), checkfirst=True)
    project = _get_project_by_name(db, project_name)
    target_date = _parse_yyyy_mm_dd(report_date, "report_date")
    row = (
        db.execute(
            select(ReportUploadStatus).where(
                ReportUploadStatus.project_id == project.id,
                ReportUploadStatus.report_type == report_type,
                ReportUploadStatus.country == country,
                ReportUploadStatus.report_date == target_date,
            )
        )
        .scalars()
        .first()
    )
    if row is None:
        row = ReportUploadStatus(
            project_id=project.id,
            report_type=report_type,
            country=country,
            report_date=target_date,
            upload_file_id=file_id,
            upload_file_path=file_path,
            original_filename=original_filename,
            stored_filename=file_id,
            file_size_bytes=Path(file_path).stat().st_size
            if Path(file_path).exists()
            else None,
            created_by=(created_by or "").strip()[:255] or None,
        )
        db.add(row)
    else:
        row.upload_file_id = file_id
        row.upload_file_path = file_path
        row.original_filename = original_filename
        row.stored_filename = file_id
        row.file_size_bytes = (
            Path(file_path).stat().st_size if Path(file_path).exists() else None
        )
        row.created_by = (created_by or "").strip()[:255] or row.created_by

    db.commit()
    db.refresh(row)
    return int(row.id)
