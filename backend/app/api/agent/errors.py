"""Agent API 错误码注册表与异常处理器（设计稿 §5）。

所有新错误码必须在 ``ErrorCode`` 注册——Agent 提示词依赖稳定 code。
``_HTTP_STATUS`` 映射固定（设计稿 §5.3），实现不得漂移。
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

AGENT_PATH_PREFIX = "/api/v1/agent/"


class ErrorCode(str, Enum):
    # 鉴权
    AGENT_AUTH_FAILED = "AGENT_AUTH_FAILED"
    AGENT_PROJECT_OUT_OF_SCOPE = "AGENT_PROJECT_OUT_OF_SCOPE"
    AGENT_BUSINESS_OUT_OF_SCOPE = "AGENT_BUSINESS_OUT_OF_SCOPE"
    # 限流
    AGENT_RATE_LIMIT_EXCEEDED = "AGENT_RATE_LIMIT_EXCEEDED"
    # 幂等
    IDEMPOTENCY_KEY_CONFLICT = "IDEMPOTENCY_KEY_CONFLICT"
    # 评论追踪采集域（BLF-1378 阶段 D）：captured_at 早于该目标最近一次 run
    REVIEW_TRACKING_CAPTURE_OUT_OF_ORDER = "REVIEW_TRACKING_CAPTURE_OUT_OF_ORDER"
    # confirm（CONFIRM_REQUIRED 是协议正常一步，直接构造 200 壳，不走异常）
    CONFIRM_TOKEN_INVALID = "CONFIRM_TOKEN_INVALID"
    CONFIRM_TOKEN_EXPIRED = "CONFIRM_TOKEN_EXPIRED"
    CONFIRM_REQUIRED = "CONFIRM_REQUIRED"
    # 货件域（P2）
    SHIPMENT_DUPLICATE_NO = "SHIPMENT_DUPLICATE_NO"
    SHIPMENT_ITEMS_INVALID_SKU = "SHIPMENT_ITEMS_INVALID_SKU"
    SHIPMENT_ITEMS_MISSING_CARTON_INFO = "SHIPMENT_ITEMS_MISSING_CARTON_INFO"
    SHIPMENT_STATUS_INVALID = "SHIPMENT_STATUS_INVALID"
    # 店铺测算域（BLF-442）
    SHOP_CALCULATION_INVALID_SOURCE = "SHOP_CALCULATION_INVALID_SOURCE"
    SHOP_CALCULATION_INVALID_SKU = "SHOP_CALCULATION_INVALID_SKU"
    SHOP_CALCULATION_AMBIGUOUS_COUNTRY = "SHOP_CALCULATION_AMBIGUOUS_COUNTRY"
    # 新品测算域（BLF-451）——注：D2b 拍板 4 种全可存后不再需要 INVALID_TYPE
    NEW_PRODUCT_CALCULATION_INVALID_SOURCE = "NEW_PRODUCT_CALCULATION_INVALID_SOURCE"
    NEW_PRODUCT_CALCULATION_INVALID_SKU = "NEW_PRODUCT_CALCULATION_INVALID_SKU"
    # SKU Info 主数据域（BLF-579 S2）
    SKU_INFO_INVALID_SOURCE = "SKU_INFO_INVALID_SOURCE"
    SKU_INFO_DUPLICATE = "SKU_INFO_DUPLICATE"
    # 客诉中心域（BLF-981）
    COMPLAINT_STATUS_INVALID = "COMPLAINT_STATUS_INVALID"
    # 店铺身份核验（BLF-1022）
    IDENTITY_CHECK_REQUIRED = "IDENTITY_CHECK_REQUIRED"
    IDENTITY_CHECK_CONTRADICTION = "IDENTITY_CHECK_CONTRADICTION"
    IDENTITY_CHECK_INVALID = "IDENTITY_CHECK_INVALID"
    IDENTITY_EXPECTED_ALIAS_MISSING = "IDENTITY_EXPECTED_ALIAS_MISSING"
    # 月报写入域（BLF-1250 阶段一）：临时上传 + 仅计算草稿 + 确认入库
    MONTHLY_REPORT_INVALID_INPUT = "MONTHLY_REPORT_INVALID_INPUT"
    MONTHLY_REPORT_TOO_LARGE = "MONTHLY_REPORT_TOO_LARGE"
    MONTHLY_REPORT_UPLOAD_CONFLICT = "MONTHLY_REPORT_UPLOAD_CONFLICT"
    MONTHLY_REPORT_NOT_READY = "MONTHLY_REPORT_NOT_READY"
    MONTHLY_REPORT_EXPIRED = "MONTHLY_REPORT_EXPIRED"
    MONTHLY_REPORT_CONFLICT = "MONTHLY_REPORT_CONFLICT"
    MONTHLY_REPORT_DISPATCH_FAILED = "MONTHLY_REPORT_DISPATCH_FAILED"
    # 通用
    VALIDATION_FAILED = "VALIDATION_FAILED"
    RESOURCE_NOT_FOUND = "RESOURCE_NOT_FOUND"
    INTERNAL_ERROR = "INTERNAL_ERROR"


# 设计稿 §5.3 固定映射。
_HTTP_STATUS: dict[ErrorCode, int] = {
    ErrorCode.AGENT_AUTH_FAILED: 401,
    ErrorCode.AGENT_PROJECT_OUT_OF_SCOPE: 403,
    ErrorCode.AGENT_BUSINESS_OUT_OF_SCOPE: 403,
    ErrorCode.AGENT_RATE_LIMIT_EXCEEDED: 429,
    ErrorCode.IDEMPOTENCY_KEY_CONFLICT: 409,
    ErrorCode.REVIEW_TRACKING_CAPTURE_OUT_OF_ORDER: 409,
    ErrorCode.CONFIRM_TOKEN_INVALID: 400,
    ErrorCode.CONFIRM_TOKEN_EXPIRED: 409,
    ErrorCode.SHIPMENT_DUPLICATE_NO: 409,
    ErrorCode.SHIPMENT_ITEMS_INVALID_SKU: 400,
    ErrorCode.SHIPMENT_ITEMS_MISSING_CARTON_INFO: 400,
    ErrorCode.SHIPMENT_STATUS_INVALID: 400,
    ErrorCode.SHOP_CALCULATION_INVALID_SOURCE: 400,
    ErrorCode.SHOP_CALCULATION_INVALID_SKU: 400,
    ErrorCode.SHOP_CALCULATION_AMBIGUOUS_COUNTRY: 400,
    ErrorCode.NEW_PRODUCT_CALCULATION_INVALID_SOURCE: 400,
    ErrorCode.NEW_PRODUCT_CALCULATION_INVALID_SKU: 400,
    ErrorCode.SKU_INFO_INVALID_SOURCE: 400,
    ErrorCode.SKU_INFO_DUPLICATE: 409,
    ErrorCode.COMPLAINT_STATUS_INVALID: 400,
    ErrorCode.IDENTITY_CHECK_REQUIRED: 422,
    ErrorCode.IDENTITY_CHECK_CONTRADICTION: 422,
    ErrorCode.IDENTITY_CHECK_INVALID: 422,
    ErrorCode.IDENTITY_EXPECTED_ALIAS_MISSING: 422,
    # 月报写入域（BLF-1250）：输入不合规 400、超限 413、会话内重复上传 409、
    # 草稿未就绪/已过期/同月已有成功月报 409、派发失败 503（可重试）。
    ErrorCode.MONTHLY_REPORT_INVALID_INPUT: 400,
    ErrorCode.MONTHLY_REPORT_TOO_LARGE: 413,
    ErrorCode.MONTHLY_REPORT_UPLOAD_CONFLICT: 409,
    ErrorCode.MONTHLY_REPORT_NOT_READY: 409,
    ErrorCode.MONTHLY_REPORT_EXPIRED: 409,
    ErrorCode.MONTHLY_REPORT_CONFLICT: 409,
    ErrorCode.MONTHLY_REPORT_DISPATCH_FAILED: 503,
    ErrorCode.VALIDATION_FAILED: 400,
    ErrorCode.RESOURCE_NOT_FOUND: 404,
    ErrorCode.INTERNAL_ERROR: 500,
}

_DEFAULTS: dict[ErrorCode, tuple[str, str]] = {
    ErrorCode.AGENT_AUTH_FAILED: (
        "Agent 鉴权失败",
        "请确认 Authorization 与 X-Agent-Id 配对正确；如凭据失效请联系管理员重新生成",
    ),
    ErrorCode.AGENT_PROJECT_OUT_OF_SCOPE: (
        "本凭据未被授权访问该项目",
        "请在 Agent 平台为该 agent 配置项目访问权限",
    ),
    ErrorCode.AGENT_BUSINESS_OUT_OF_SCOPE: (
        "本凭据未被授权访问该业务域",
        "请在 Agent 平台为该 agent 配置业务域访问权限",
    ),
    ErrorCode.AGENT_RATE_LIMIT_EXCEEDED: (
        "Agent 调用频率超限",
        "请在 Retry-After 秒后重试",
    ),
    ErrorCode.IDEMPOTENCY_KEY_CONFLICT: (
        "Idempotency-Key 已被用于不同的请求体",
        "新请求请生成新的 Idempotency-Key；confirm 重放请保持原 key 与请求体一致",
    ),
    ErrorCode.REVIEW_TRACKING_CAPTURE_OUT_OF_ORDER: (
        "采集时间早于或等于该目标最近一次有效采集（failed 不计）",
        "请用晚于 details.latest_started_at 的 captured_at 重试；同一业务日重跑用当天更晚的"
        "时间点，如需补采历史请先与运营确认（当前态评论表无版本，乱序写入会覆盖现网数据）。"
        "若 latest_started_at 晚于当前时间，说明此前某次提交的客户端时钟/时区标错，"
        "请先校准再按真实时间重试，不要提交更远的未来时间",
    ),
    ErrorCode.CONFIRM_TOKEN_INVALID: (
        "确认凭证无效或与请求体不匹配",
        "请重新发起预览请求，向用户确认后用同一请求体重放",
    ),
    ErrorCode.CONFIRM_TOKEN_EXPIRED: (
        "确认凭证已过期",
        "请重新发起预览请求，向用户再次确认后再调用",
    ),
    ErrorCode.SHIPMENT_DUPLICATE_NO: (
        "货件编号已存在",
        "请更换 shipment_no 后重试；可用列表端点查询已有货件",
    ),
    ErrorCode.SHIPMENT_ITEMS_INVALID_SKU: (
        "明细里有 SKU 在本项目不存在",
        "先核对 SKU 主数据（sku-info 相关端点），修正后重试",
    ),
    ErrorCode.SHIPMENT_ITEMS_MISSING_CARTON_INFO: (
        "明细里有 SKU 未维护装箱信息（units_per_carton）",
        "先用 sku-info 相关端点维护外箱尺寸/毛重/装箱率，修正后重试（建货件时数量 = 箱数 × 装箱率）",
    ),
    ErrorCode.SHIPMENT_STATUS_INVALID: (
        "货件状态值不合法",
        "合法状态值：draft、in_transit、completed",
    ),
    ErrorCode.SHOP_CALCULATION_INVALID_SOURCE: (
        "写入来源不合法",
        "合法来源：agent_listing_pull、agent_review_scrape、agent_market_research、external_api",
    ),
    ErrorCode.SHOP_CALCULATION_INVALID_SKU: (
        "该 SKU 在本项目不存在",
        "先核对 SKU 主数据（sku-info 相关端点），确认后再追加",
    ),
    ErrorCode.SHOP_CALCULATION_AMBIGUOUS_COUNTRY: (
        "该 SKU 存在多个国家站点，需指定 country",
        "用 details 里的国家列表带 ?country= 重试",
    ),
    ErrorCode.NEW_PRODUCT_CALCULATION_INVALID_SOURCE: (
        "写入来源不合法",
        "合法来源：agent_listing_pull、agent_review_scrape、agent_market_research、external_api",
    ),
    ErrorCode.NEW_PRODUCT_CALCULATION_INVALID_SKU: (
        "该 SKU 在本项目不存在",
        "先核对 SKU 主数据（sku-info 相关端点），确认后再写入",
    ),
    ErrorCode.SKU_INFO_INVALID_SOURCE: (
        "写入来源不合法",
        "合法来源：agent_listing_pull、agent_user_supplied、external_api（禁 manual）",
    ),
    ErrorCode.SKU_INFO_DUPLICATE: (
        "SKU 主数据更新后与现有记录重复",
        "唯一键为 (project_id, sku, asin, country)；请核对 sku/asin/country 后重试",
    ),
    ErrorCode.COMPLAINT_STATUS_INVALID: (
        "非法状态流转",
        "客诉状态机单向（pending → drafted → replied → resolved → closed_no_response），不可回退",
    ),
    ErrorCode.IDENTITY_CHECK_REQUIRED: (
        "身份核验未通过，禁止写入客诉",
        "check observed_alias and observed_country before retry",
    ),
    ErrorCode.IDENTITY_CHECK_CONTRADICTION: (
        "身份核验状态自相矛盾",
        "identity_mismatch must pair with verified=false; re-probe the account switcher before retry",
    ),
    ErrorCode.IDENTITY_CHECK_INVALID: (
        "身份核验声明与页面观测不一致",
        "verified=true requires observed_alias to exactly match expected_alias/aliases and observed_country to contain the target country",
    ),
    ErrorCode.IDENTITY_EXPECTED_ALIAS_MISSING: (
        "店铺缺少期望身份别名",
        "seller_identity.required=true but expected_alias is empty; maintain the alias before writing complaints",
    ),
    ErrorCode.MONTHLY_REPORT_INVALID_INPUT: (
        "月报输入文件不合法",
        "请确认 CSV 为 Amazon Payment Report（含计算必需列、编码受支持、有可计算行）；PDF 需为真实 PDF 文件",
    ),
    ErrorCode.MONTHLY_REPORT_TOO_LARGE: (
        "月报输入文件超过大小上限",
        "每个 CSV/PDF 上限 50 MiB（服务端按流累计字节校验）；请压缩或拆分后重传",
    ),
    ErrorCode.MONTHLY_REPORT_UPLOAD_CONFLICT: (
        "该上传会话已存在同类文件",
        "每个会话只允许一份 CSV（transaction_csv）与一份可选 PDF（summary_pdf）；更换文件请新建会话",
    ),
    ErrorCode.MONTHLY_REPORT_NOT_READY: (
        "月报草稿尚不可用",
        "请轮询 GET /builds/{build_id} 直到 status=success 再预览/下载/确认",
    ),
    ErrorCode.MONTHLY_REPORT_EXPIRED: (
        "月报草稿或输入已过期",
        "临时输入与结果保留 24 小时；请新建上传会话与 build 后重试",
    ),
    ErrorCode.MONTHLY_REPORT_CONFLICT: (
        "该 项目+国家+月份 已有成功月报",
        "阶段一不自动替换当前版本；如确需新版本，请在 dashboard 侧处理或等待后续版本切换能力",
    ),
    ErrorCode.MONTHLY_REPORT_DISPATCH_FAILED: (
        "月报计算任务派发失败",
        "队列暂时不可用，请稍后用新的 Idempotency-Key 重试 POST /builds",
    ),
    ErrorCode.VALIDATION_FAILED: (
        "请求参数校验失败",
        "请根据 details 修正参数后重试",
    ),
    ErrorCode.RESOURCE_NOT_FOUND: (
        "请求的资源不存在",
        "请检查资源 id；可用对应的列表端点查询可用 id",
    ),
    ErrorCode.INTERNAL_ERROR: (
        "服务器内部错误",
        "请稍后重试；若持续出现请联系管理员",
    ),
}


class AgentApiError(Exception):
    """agent 命名空间统一业务异常；handler 序列化为响应壳。"""

    def __init__(
        self,
        code: ErrorCode,
        *,
        reason: str | None = None,
        human_message: str | None = None,
        agent_hint: str | None = None,
        details: list[Any] | dict[str, Any] | None = None,
    ) -> None:
        super().__init__(code.value)
        self.code = code
        self.reason = reason
        self.human_message = human_message
        self.agent_hint = agent_hint
        self.details = details

    @property
    def status_code(self) -> int:
        return _HTTP_STATUS[self.code]


def error_payload(
    code: ErrorCode,
    *,
    reason: str | None = None,
    human_message: str | None = None,
    agent_hint: str | None = None,
    details: list[Any] | dict[str, Any] | None = None,
) -> dict:
    """构造统一失败壳（设计稿 §5.1）。"""
    default_human, default_hint = _DEFAULTS[code]
    error: dict[str, Any] = {
        "code": code.value,
        "human_message": human_message or default_human,
        "agent_hint": agent_hint or default_hint,
    }
    if reason:
        error["reason"] = reason
    if details is not None:
        error["details"] = details
    return {"ok": False, "error": error}


def register_agent_error_handlers(app: FastAPI) -> None:
    """全局异常处理器：agent 前缀统一响应壳；其余路径保持现状。"""

    @app.exception_handler(AgentApiError)
    async def _agent_api_error(_request: Request, exc: AgentApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=error_payload(
                exc.code,
                reason=exc.reason,
                human_message=exc.human_message,
                agent_hint=exc.agent_hint,
                details=exc.details,
            ),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        if request.url.path.startswith(AGENT_PATH_PREFIX):
            details = [
                {
                    "loc": [str(part) for part in err.get("loc", [])],
                    "msg": err.get("msg"),
                    "type": err.get("type"),
                }
                for err in exc.errors()
            ]
            return JSONResponse(
                status_code=400,
                content=error_payload(ErrorCode.VALIDATION_FAILED, details=details),
            )
        # 非 agent 路径：保持 FastAPI 默认行为（422 + detail）
        return JSONResponse(
            status_code=422, content={"detail": jsonable_encoder(exc.errors())}
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_exception(
        request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        if request.url.path.startswith(AGENT_PATH_PREFIX):
            code = (
                ErrorCode.RESOURCE_NOT_FOUND
                if exc.status_code == 404
                else ErrorCode.INTERNAL_ERROR
            )
            return JSONResponse(
                status_code=exc.status_code,
                content=error_payload(
                    code,
                    human_message=str(exc.detail) if exc.detail else None,
                ),
            )
        headers = getattr(exc, "headers", None)
        if headers:
            return JSONResponse(
                status_code=exc.status_code,
                content={"detail": exc.detail},
                headers=headers,
            )
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
