"""Agent 报表上传域路由（BLF-975）。

提供 dry-run 校验 + 正式提交两步契约，避免误传。

BLF-975 复测修复：
* 鉴权：agent 命名空间**不得**挂内部 dashboard 的 ``Depends(protected)``
  （require_api_key 只认主 key / user key → agent key 必 403「Invalid API
  key」）。鉴权统一由 agent_router 级 ``require_agent_credential`` 承担。
* 项目权限：commit 不信 ``X-Is-Admin`` 头（agent 通道绕不过权限）。项目
  可见性按 agent key 的 ``project_scope`` 白名单校验（与 /agent/projects
  列表同语义），校验通过后以 ``is_admin=True`` 调服务层——服务层内部
  operator 维度的过滤是 dashboard 语义，agent 通道已在路由层收紧。
* temp 文件缺失包装为 404 资源壳（不再裸 500）。
* 广告 B 表类型（ad_*）走 C 表原生 ``commit_ad_upload``，不经 A 表
  ``normalize_report_type`` 兼容折叠（复测第 3 项）。
"""

from __future__ import annotations

import shutil

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from sqlalchemy.orm import Session

from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.scope import SCOPE_ALL, _parse_scope
from app.api.deps import get_db_session
from app.core.config import Settings, get_settings
from app.models.agent_api_key import AgentApiKey
from app.schemas.upload import (
    AgentUploadCommitRequest,
    AgentUploadCommitResponse,
    AgentUploadValidateResponse,
)
from app.services.data.upload import commit_report_upload
from app.services.data.upload.validate import validate_upload
from app.services.external import projects_query

# BLF-975 修复：agent 命名空间内的路由**不得**挂内部 dashboard 的
# Depends(protected)（require_api_key 只认主 key / user key，agent key
# 不在其中 → 必 403「Invalid API key」）。鉴权统一由 agent_router 级的
# require_agent_credential 承担；业务域门禁挂 business_scope("report_upload")。
router = APIRouter()


def _agent_project_in_scope(request: Request, project_name: str, db: Session) -> bool:
    """项目名是否在该 agent key 的 ``project_scope`` 白名单内。

    与 /agent/projects 列表（L2 语义）同源：读 key 行的 project_scope；
    ``*`` 全放行。project_name 先解析成 project_id 再比对。
    """
    key_id = getattr(request.state, "agent_api_key_id", None)
    if key_id is None:
        # 依赖顺序错误（auth 未先跑）→ fail closed。
        raise AgentApiError(ErrorCode.AGENT_AUTH_FAILED, reason="token_invalid")

    key = db.get(AgentApiKey, key_id)
    if key is None:
        raise AgentApiError(ErrorCode.AGENT_AUTH_FAILED, reason="token_invalid")

    scope = key.project_scope or SCOPE_ALL
    if scope == SCOPE_ALL:
        return True

    allowed_ids = _parse_scope(scope)
    if not allowed_ids:
        return False

    # 按名解析 project_id（与 /agent/projects?name= 同一数据面）。
    rows = projects_query.list_projects(db)
    for row in rows:
        if row.project_name == project_name:
            return row.id in allowed_ids
    return False


def _ensure_temp_file_404(exc: Exception) -> None:
    """把服务层 FileNotFoundError 包装成 agent 404 资源壳。"""
    raise AgentApiError(
        ErrorCode.RESOURCE_NOT_FOUND,
        human_message=f"temp_file_id 不存在：{exc}",
        agent_hint="请先调用 /agent/upload/validate 获取 temp_file_id，再提交 commit",
    ) from exc

def _is_ad_b_table_type(report_type: str) -> bool:
    """广告 B 表类型判定（走 C 表原生 commit，不经 A 表兼容折叠）。"""
    from app.services.ad.upload.specs import REPORT_SPECS

    return str(report_type) in {spec.report_type for spec in REPORT_SPECS}


def _commit_ad_b_table(
    *,
    request: Request,
    payload: AgentUploadCommitRequest,
    settings: Settings,
    db: Session,
) -> AgentUploadCommitResponse:
    """广告 B 表提交：走 ``commit_ad_upload``（C 表）。

    temp 文件衔接：agent validate 存的是 ``_report_upload_tmp``，B 表
    commit 读 ``_ad_upload_tmp``——把 A 侧 temp 文件复制到 B 侧 temp
    目录，agent 拿同一个 temp_file_id 两段式衔接（复测第 3 项闭环）。
    服务层 ``_resolve_project`` 的 operator 过滤是 dashboard 语义（agent
    无 operator → 恒 403），权限已在路由层按 project_scope 收紧，这里
    传 is_admin=True 复用其解析逻辑。
    """
    from app.schemas.ad_upload import AdUploadCommitRequest
    from app.services.ad.upload import commit_ad_upload
    from app.services.upload_service import (
        resolve_report_upload_temp_file_path,
    )

    source = resolve_report_upload_temp_file_path(settings, payload.temp_file_id)
    ad_tmp = settings.upload_root / "_ad_upload_tmp"
    ad_tmp.mkdir(parents=True, exist_ok=True)
    ad_path = ad_tmp / source.name
    if not ad_path.exists():
        shutil.copy2(source, ad_path)

    ad_payload = AdUploadCommitRequest(
        temp_file_id=source.name,
        report_type=payload.report_type,  # type: ignore[arg-type]
        original_filename=payload.original_filename,
        project_name=payload.project_name,
        country=payload.country,
        report_date=payload.report_date,
        report_start_date=payload.report_start_date,
        report_end_date=payload.report_end_date,
        dry_run=False,
    )
    ad_result = commit_ad_upload(
        db,
        settings,
        payload=ad_payload,
        operator=None,
        is_admin=True,
    )
    return AgentUploadCommitResponse(
        report_type=ad_result.report_type,  # type: ignore[arg-type]
        status="persisted",
        project_name=ad_result.project_name,
        country=ad_result.country,
        report_date=ad_result.report_date,
        report_start_date=ad_result.report_start_date,
        report_end_date=ad_result.report_end_date,
        file_id=ad_result.file_id,
        file_path=ad_result.file_path,
        persisted_source_id=ad_result.id,
        persisted_table="ad_upload_files",
        message=ad_result.message,
        duplicate_warnings=[],
        rows_ingested=None,
    )




@router.post("/upload/validate", response_model=AgentUploadValidateResponse)
def validate_report_upload(
    file: UploadFile = File(...),
    report_type: str = Form(...),
    country: str = Form(default="US"),
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db_session),
) -> AgentUploadValidateResponse:
    """Dry-run 校验：返回列匹配度、检测国家、行数估算 + temp_file_id，不入库。"""
    return validate_upload(
        db=db,
        settings=settings,
        file=file,
        report_type=report_type,
        country=country,
    )


@router.post("/upload/commit", response_model=AgentUploadCommitResponse)
def commit_report_upload_agent(
    request: Request,
    payload: AgentUploadCommitRequest,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db_session),
) -> AgentUploadCommitResponse:
    """正式提交：复用现有 commit_report_upload 逻辑入库。

    项目权限：按 agent key 的 ``project_scope`` 白名单校验 ``project_name``
    （``*`` 全放行）；**不信任 ``X-Is-Admin`` 头**——agent 通道在路由层已
    完成权限收紧，服务层以 is_admin=True 调用只复用其入库逻辑。

    BLF-975 复测第 3 项（B 类不走 A 类兼容模式）：广告 B 表类型（``ad_*``）
    走广告原生的 ``commit_ad_upload``（C 表：ad_upload_files /
    ad_upload_promoted_product_rows），**不经** A 表 commit 的
    ``normalize_report_type``（它会把 ``ad_report`` 旧值折叠成
    ``ad_product_report`` → 400 Unsupported）。
    """
    project_name = (payload.project_name or "").strip()
    if not project_name:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="project_name 必填（agent 通道不支持自动匹配入库）",
        )
    if not _agent_project_in_scope(request, project_name, db):
        raise AgentApiError(
            ErrorCode.AGENT_PROJECT_OUT_OF_SCOPE,
            reason="project_not_in_scope",
            human_message=f"项目 {project_name} 不在该凭据的项目范围内",
            agent_hint="GET /agent/projects 查询该凭据可见项目；scope 由管理员配置",
        )

    try:
        if _is_ad_b_table_type(payload.report_type):
            result = _commit_ad_b_table(
                request=request,
                payload=payload,
                settings=settings,
                db=db,
            )
        else:
            result = commit_report_upload(
                db=db,
                settings=settings,
                payload=payload,
                operator=None,
                is_admin=True,
            )
    except FileNotFoundError as exc:
        _ensure_temp_file_404(exc)
    return result
# 包装为 agent 壳（403「无权限访问该项目」/400/422 → 对应壳），无需在此翻译。
