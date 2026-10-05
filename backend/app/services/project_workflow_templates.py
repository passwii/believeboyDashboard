"""项目启动台流程模板定义（BLF-1234）。

模板只作为**后端定义**：前端只看到 ``key/kind/title`` 元数据，
创建流程时把任务定义（标题/描述/序号/附件键）复制进项目，
因此后续修改这里的文案不会覆盖已有项目的进度（用户明确要求）。

每个模板带 ``version``；同 kind 多版本时 ``key`` 后缀区分（``-v1``）。
描述文案是占位符，业务方后续可在此处直接修改。
"""

from __future__ import annotations

from dataclasses import dataclass, field

WORKFLOW_KIND_STORE_LAUNCH = "store_launch"
WORKFLOW_KIND_PRODUCT_DEVELOPMENT = "product_development"

# 受保护的对外文档键（值由 endpoint 层的白名单映射到服务器固定路径）。
DOCUMENT_KEY_AMAZON_REGISTRATION_FORM = "amazon_registration_form"
DOCUMENT_KEY_WORLDFIRST_REGISTRATION_GUIDE = "worldfirst_registration_guide"


@dataclass(frozen=True)
class WorkflowTaskTemplate:
    title: str
    description: str | None = None
    attachment_key: str | None = None


@dataclass(frozen=True)
class WorkflowTemplate:
    key: str
    kind: str
    title: str
    version: int = 1
    tasks: tuple[WorkflowTaskTemplate, ...] = field(default_factory=tuple)


STORE_LAUNCH_TEMPLATE = WorkflowTemplate(
    key="store-launch-v1",
    kind=WORKFLOW_KIND_STORE_LAUNCH,
    title="店铺启动",
    version=1,
    tasks=(
        WorkflowTaskTemplate(
            title="店铺注册资料收集",
            description=(
                "按《亚马逊_注册信息收集表》收集主体、法人、地址、联系方式等注册资料，"
                "汇总回传后进入注册流程。"
            ),
            attachment_key=DOCUMENT_KEY_AMAZON_REGISTRATION_FORM,
        ),
        WorkflowTaskTemplate(
            title="万里汇收款账户注册",
            description=(
                "按《万里汇海外收款注册流程》完成海外收款账户注册，"
                "并回填账户主体与账号信息。"
            ),
            attachment_key=DOCUMENT_KEY_WORLDFIRST_REGISTRATION_GUIDE,
        ),
        WorkflowTaskTemplate(
            title="店铺业务审核",
            description="完成卖家平台业务审核（身份/视频验证等），直至审核通过。",
        ),
        WorkflowTaskTemplate(
            title="品牌备案",
            description="提交品牌备案（Brand Registry）并跟进平台审核结果。",
        ),
        WorkflowTaskTemplate(
            title="UPC 注册豁免",
            description="申请 GTIN/UPC 豁免，避免上架时强制使用外部条码。",
        ),
        WorkflowTaskTemplate(
            title="收款账户后台绑定验证",
            description="在卖家后台绑定万里汇收款账户并完成小额验证。",
        ),
    ),
)

WOMENS_SWIMWEAR_TEMPLATE = WorkflowTemplate(
    key="product-womens-swimwear-v1",
    kind=WORKFLOW_KIND_PRODUCT_DEVELOPMENT,
    title="女士泳衣",
    version=1,
    tasks=(
        WorkflowTaskTemplate(
            title="产品选款对接",
            description="与供应商确认款式、版型、面料与目标成本，锁定选款方向。",
        ),
        WorkflowTaskTemplate(
            title="产品打样对接",
            description="确认打样尺寸与工艺要求，跟进打样进度并评审样衣。",
        ),
        WorkflowTaskTemplate(
            title="产品包装设计",
            description="输出包装结构与视觉设计稿，完成内部与业务方确认。",
        ),
        WorkflowTaskTemplate(
            title="产品吊卡设计",
            description="输出吊卡文案与视觉设计稿，完成确认并交付供应商。",
        ),
        WorkflowTaskTemplate(
            title="产品洗标",
            description="确认洗标内容（成分、洗涤说明、产地）与样式要求。",
        ),
        WorkflowTaskTemplate(
            title="完整款打样、打包与邮寄",
            description="完成完整款打样、包装打包并邮寄，作为量产前的最终确认。",
        ),
    ),
)

_TEMPLATES: tuple[WorkflowTemplate, ...] = (
    STORE_LAUNCH_TEMPLATE,
    WOMENS_SWIMWEAR_TEMPLATE,
)

TEMPLATES_BY_KEY: dict[str, WorkflowTemplate] = {t.key: t for t in _TEMPLATES}


def list_templates() -> tuple[WorkflowTemplate, ...]:
    """Return every template definition (metadata + tasks)."""
    return _TEMPLATES


def get_template(template_key: str) -> WorkflowTemplate | None:
    return TEMPLATES_BY_KEY.get((template_key or "").strip())


def default_product_template() -> WorkflowTemplate:
    return WOMENS_SWIMWEAR_TEMPLATE
