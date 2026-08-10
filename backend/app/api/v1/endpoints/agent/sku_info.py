"""Agent SKU Info（商品主数据）域读路由（BLF-582；设计对齐 BLF-579 spec §4 R1）。

在 ``/api/v1/agent/projects/{project_id}/sku-info`` 开放 **R1 列表**读路由，
**原生替换 external 镜像**（external/sku_info.py 端点模块已删除，BLF-582）：

* **读侧收口**（BLF-579 spec §3 D2）：镜像路径加入
  ``external_mirror._EXCLUDED_EXTERNAL_PATHS`` 排除，读路由只走原生
  ``sku_info`` 域——避免「双路径 + 无 business_scope 门禁」漂移（对齐
  new-product-calculations / return-analysis / replenishment-analysis 先例）。
* **域级权限门**：``require_business_scope("sku_info")`` 在 ``agent/__init__.py``
  装配时挂载（BLF-579 spec §3 D1：域 code ``sku_info``）。
* **服务层复用**：``list_sku_records``（``app/services/data/sku_info/crud.py``）
  按 ``managed_project_ids=[project_id]`` 项目白名单复用，0 存量调用方影响；
  ``_serialize_sku_record`` 与内部 ``/api/v1/sku-info`` 同构（字段逐一对应）。
* **R2 详情 / R3 审计 / W1-W3 写路由**不在本域范围（BLF-579 S2 实施，backlog）；
  本模块只落 R1，S2 在其上扩展不重写。

查询契约（BLF-579 spec §4 R1）：``country``（可选 2 字母，``normalize_country``
归一）/ ``is_active``（**默认 true**，显式 ``=false`` 查下架）/ ``sku`` /
``asin``（可选 ilike 模糊）/ ``page``（默认 1）/ ``page_size``（默认 200，
≤500）/ ``include_total``（默认 false）。响应
``{ ok, data: { items, page, page_size, total, has_next } }``。
"""

from __future__ import annotations

from contextlib import contextmanager

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.response import agent_ok
from app.api.agent.scope import require_project_scope
from app.api.deps import get_read_db_session
from app.models.sku_info import SkuRecord
from app.services.data.sku_info import list_sku_records
from app.services.external import projects_query
from app.utils.marketplace_url import build_marketplace_url

sku_info_router = APIRouter(
    prefix="/projects/{project_id}",
    tags=["agent-sku-info"],
)


# ============================================================
# 壳翻译与解析 helper（对齐各原生域模板）
# ============================================================


@contextmanager
def _service_errors():
    """把 service 层 HTTPException 翻译成 agent 响应壳（设计稿 §5）。"""
    try:
        yield
    except AgentApiError:
        raise
    except HTTPException as exc:
        detail = str(exc.detail) if exc.detail else None
        if exc.status_code == 404:
            raise AgentApiError(
                ErrorCode.RESOURCE_NOT_FOUND, human_message=detail
            ) from None
        raise AgentApiError(ErrorCode.VALIDATION_FAILED, human_message=detail) from None


def _serialize_sku_record(row: SkuRecord) -> dict:
    """``SkuRecord`` → 同构 JSON 行（与内部 ``/api/v1/sku-info`` 完全一致，
    BLF-579 spec §4 R1「_serialize_sku_record 同构行」）。

    不暴露 ``*_r2_key`` 内部存储键 / ``source_file``（spec §4 公共约定）；
    暴露 URL 类字段与工厂信息。
    """
    return {
        "id": int(row.id),
        "project_name": str(row.project_name),
        "sku": str(row.sku),
        "asin": str(row.asin),
        "fnsku": str(row.fnsku) if row.fnsku else None,
        "product_name": str(row.product_name) if row.product_name else None,
        "fob_unit_cost": float(row.fob_unit_cost),
        "first_leg_cost_rmb": float(row.first_leg_cost_rmb),
        "package_length_cm": float(row.package_length_cm),
        "package_width_cm": float(row.package_width_cm),
        "package_height_cm": float(row.package_height_cm),
        "weight_kg": float(row.weight_kg),
        "carton_length_cm": float(row.carton_length_cm),
        "carton_width_cm": float(row.carton_width_cm),
        "carton_height_cm": float(row.carton_height_cm),
        "carton_weight_kg": float(row.carton_weight_kg),
        "units_per_carton": int(row.units_per_carton),
        "currency": str(row.currency),
        "country": str(row.country),
        "sort_order": int(row.sort_order),
        "is_active": bool(row.is_active),
        "sku_factory_info": row.sku_factory_info
        if hasattr(row, "sku_factory_info")
        else None,
        "sku_factory_info_updated_at": str(row.sku_factory_info_updated_at)
        if row.sku_factory_info_updated_at
        else None,
        "sku_factory_info_updated_by": str(row.sku_factory_info_updated_by)
        if row.sku_factory_info_updated_by
        else None,
        "fnsku_label_r2_url": getattr(row, "fnsku_label_r2_url", None),
        "product_image_r2_url": getattr(row, "product_image_r2_url", None),
        "product_image_thumbnail_r2_url": getattr(
            row, "product_image_thumbnail_r2_url", None
        ),
        "product_image_uploaded_at": str(row.product_image_uploaded_at)
        if getattr(row, "product_image_uploaded_at", None)
        else None,
        "product_image_uploaded_by": getattr(row, "product_image_uploaded_by", None),
        "marketplace_url": build_marketplace_url(row.country, row.asin),
    }


# ============================================================
# R1 列表（agent 原生）
# ============================================================


@sku_info_router.get("/sku-info")
def get_agent_sku_info(
    project_id: int = Path(..., ge=1),
    country: str | None = Query(default=None),
    is_active: bool | None = Query(default=True),
    sku: str | None = Query(default=None),
    asin: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=200, ge=1, le=500),
    include_total: bool = Query(default=False),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """R1 商品主数据列表：``country`` / ``is_active``（默认 true）/
    ``sku`` / ``asin`` 过滤 + 分页（BLF-579 spec §4 R1）。"""
    with _service_errors():
        if not projects_query.project_exists(db, project_id):
            raise AgentApiError(
                ErrorCode.RESOURCE_NOT_FOUND,
                human_message=f"project {project_id} not found",
            )

        rows, total, has_next = list_sku_records(
            db,
            None,
            sku,
            asin,
            country,
            is_active,
            page,
            page_size,
            include_total=include_total,
            managed_project_ids=[project_id],
        )

    return agent_ok(
        {
            "items": [_serialize_sku_record(row) for row in rows],
            "page": page,
            "page_size": page_size,
            "total": total,
            "has_next": has_next,
        }
    )
