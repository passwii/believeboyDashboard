"""项目启动台模板常量（BLF-1234 / P2 BLF-1237）。

P1 这里放着两份**硬编码模板定义**；P2 起模板是数据库数据
（``workflow_templates`` / ``workflow_template_tasks``，由 revision 276 种入），
本模块只保留与代码强绑定的常量：

- 流程类型取值（``kind``）。
- **固定文档白名单键**：这两份内置资料不在 R2，而是随包放在
  ``backend/app/resources/project_launch_documents/``，由 endpoint 的白名单映射到服务器固定路径。
  管理员可以给节点选择或清空这个键，但不能用它指向任意文件。
"""

from __future__ import annotations

WORKFLOW_KIND_STORE_LAUNCH = "store_launch"
WORKFLOW_KIND_PRODUCT_DEVELOPMENT = "product_development"

WORKFLOW_KINDS = (WORKFLOW_KIND_STORE_LAUNCH, WORKFLOW_KIND_PRODUCT_DEVELOPMENT)

# 受保护的对外文档键（值由 endpoint 层的白名单映射到服务器固定路径）。
DOCUMENT_KEY_AMAZON_REGISTRATION_FORM = "amazon_registration_form"
DOCUMENT_KEY_WORLDFIRST_REGISTRATION_GUIDE = "worldfirst_registration_guide"

# 允许写进 ``attachment_key`` 的全部取值（固定文档白名单）。
DOCUMENT_KEYS: frozenset[str] = frozenset(
    {
        DOCUMENT_KEY_AMAZON_REGISTRATION_FORM,
        DOCUMENT_KEY_WORLDFIRST_REGISTRATION_GUIDE,
    }
)


def is_valid_document_key(value: str | None) -> bool:
    """``None`` / 空串 / 白名单键 合法，其余一律拒绝。"""
    if value is None:
        return True
    return value.strip() == "" or value.strip() in DOCUMENT_KEYS
