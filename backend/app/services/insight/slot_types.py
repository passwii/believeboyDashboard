"""Insight slot typed payload：三个 role 的命名空间 slot。

全部 `extra="forbid"`；slot 名采用小写点分隔命名空间。
广告/库存只新增自身 namespace（`ad.*` / `inventory.*`），不复用 `report.*` 语义。

域层（adapter）负责把业务数据装进 slot；本模块只定义**可审计输入**的
类型与上限：范围（project_ids/country/日期）、数据新鲜度、缺数状态、
JSON envelope。业务判断（新鲜度阈值、截断策略）留在各域 adapter。
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    PositiveInt,
    StringConstraints,
    model_validator,
)

from app.schemas.insight import CountryCode

_FROZEN = ConfigDict(extra="forbid")

ReportFrequency = Literal["daily", "weekly", "monthly"]

#: 缺数维度标识：受控短 ID，避免自由文本进 slot。
DimensionName = Annotated[
    str, StringConstraints(min_length=1, max_length=64, pattern=r"^[a-z0-9][a-z0-9._-]*$")
]


def json_safe(value: Any) -> Any:
    """递归转成 JSON 原生类型：date/datetime→ISO、Decimal→float、UUID→str。

    slots 会原样 ``json.dumps`` 落库（``runs.create_run``）并进 prompt，
    所以域 adapter 必须在入 slot 前消除一切非 JSON 原生类型。这里是唯一
    转换点：未知类型直接抛 ``TypeError``——宁可提交失败，也不写坏行。
    """
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [json_safe(item) for item in value]
    raise TypeError(f"value of type {type(value).__name__} is not JSON-native")


class JsonEnvelopeSlot(BaseModel):
    """版本化 JSON envelope：payload 只接受真实对象，不接受 repr/二进制/字符串化 JSON。"""

    model_config = _FROZEN

    slot_version: Literal[1]
    encoding: Literal["json"] = "json"
    payload: dict[str, object]

    @model_validator(mode="before")
    @classmethod
    def _reject_stringified(cls, data: object) -> object:
        if isinstance(data, dict):
            payload = data.get("payload")
            # ValueError（非 TypeError）：pydantic 会把它包成 ValidationError，
            # validator 才能映射成 typed SLOT_VALIDATION_FAILED(422) 而不是裸 500。
            if isinstance(payload, str):
                raise ValueError(
                    "payload must be a JSON object, not a stringified JSON string"
                )
            if isinstance(payload, bytes):
                raise ValueError("payload must be a JSON object, not binary")
        return data

    @model_validator(mode="after")
    def _reject_non_json(self) -> JsonEnvelopeSlot:
        """payload 必须能被 ``json.dumps`` 原样落库；非 JSON 类型在契约层就拦。"""
        try:
            json_safe(self.payload)
        except TypeError as exc:
            raise ValueError(f"payload must be JSON-native: {exc}") from None
        return self


class DataFreshness(BaseModel):
    """数据新鲜度：域层量化的可审计输入（不在 slot 层做业务判断）。

    ``age_days`` 是数据锚点距当日的天数；``as_of`` 是数据锚点日期。
    ``missing`` 表示域层确认该域无可用数据；``unknown`` 表示无法判定。
    """

    model_config = _FROZEN

    status: Literal["fresh", "stale", "missing", "unknown"]
    as_of: date | None = None
    age_days: int | None = Field(default=None, ge=0, le=3650)
    source: str | None = Field(default=None, min_length=1, max_length=64)


class MissingData(BaseModel):
    """缺数状态：是否完整 + 缺失维度（受控短 ID 列表，上限 20）。"""

    model_config = _FROZEN

    is_complete: bool
    missing_dimensions: list[DimensionName] = Field(default_factory=list, max_length=20)


class ReportContextSlot(BaseModel):
    """`report.context`：报表范围与口径；须与请求 scope 一致（由 validator 校验）。"""

    model_config = _FROZEN

    slot_version: Literal[1]
    frequency: ReportFrequency
    report_date: date
    date_range_start: date
    date_range_end: date
    project_ids: list[PositiveInt] = Field(min_length=1, max_length=50)
    country: CountryCode
    project_name: str | None = Field(default=None, min_length=1, max_length=256)

    @model_validator(mode="after")
    def _check_range(self) -> ReportContextSlot:
        if self.date_range_end < self.date_range_start:
            raise ValueError("date_range_end must be >= date_range_start")
        return self


class ReportDataSlot(JsonEnvelopeSlot):
    """`report.data`：数据构建产物原样入 slot（真实 JSON 对象，非字符串化）。"""


class ProjectSummary(BaseModel):
    model_config = _FROZEN

    project_id: PositiveInt
    name: str = Field(min_length=1, max_length=256)
    country: CountryCode | None = None


class ProjectContextSlot(BaseModel):
    """`project.context`：项目摘要列表，最多 50 项。"""

    model_config = _FROZEN

    slot_version: Literal[1]
    projects: list[ProjectSummary] = Field(min_length=1, max_length=50)


class SkuSummary(BaseModel):
    model_config = _FROZEN

    sku: str = Field(min_length=1, max_length=128)
    asin: str | None = Field(default=None, min_length=1, max_length=32)
    project_id: PositiveInt | None = None
    title: str | None = Field(default=None, min_length=1, max_length=512)
    factory_info: str | None = Field(default=None, min_length=1, max_length=512)


class SkuContextSlot(BaseModel):
    """`sku.context`：SKU 摘要列表，最多 200 项。"""

    model_config = _FROZEN

    slot_version: Literal[1]
    skus: list[SkuSummary] = Field(min_length=1, max_length=200)


class AdContextSlot(BaseModel):
    """`ad.context`：广告分析范围与口径（须与请求 scope 一致，由 validator 校验）。

    数据新鲜度与缺数是域层量化的可审计输入：分析窗口的锚点日期、
    聚合覆盖率判定出的缺失维度。客户端不提交数据本体。
    """

    model_config = _FROZEN

    slot_version: Literal[1]
    date_range_start: date
    date_range_end: date
    project_ids: list[PositiveInt] = Field(min_length=1, max_length=50)
    country: CountryCode
    data_freshness: DataFreshness
    missing_data: MissingData
    project_name: str | None = Field(default=None, min_length=1, max_length=256)

    @model_validator(mode="after")
    def _check_range(self) -> AdContextSlot:
        if self.date_range_end < self.date_range_start:
            raise ValueError("date_range_end must be >= date_range_start")
        return self


class AdDataSlot(JsonEnvelopeSlot):
    """`ad.data`：广告分析聚合产物（销售/广告日序列、活动、10 类广告报表）。"""


class InventoryContextSlot(BaseModel):
    """`inventory.context`：库存健康分析范围与口径（须与请求 scope 一致）。

    ``report_date`` 是分析锚定日；``data_freshness`` 反映库存快照实际
    使用日期的年龄；``missing_data`` 记录快照/SKU 目录缺失维度。
    """

    model_config = _FROZEN

    slot_version: Literal[1]
    report_date: date
    project_ids: list[PositiveInt] = Field(min_length=1, max_length=50)
    country: CountryCode
    data_freshness: DataFreshness
    missing_data: MissingData
    project_name: str | None = Field(default=None, min_length=1, max_length=256)


class InventoryDataSlot(JsonEnvelopeSlot):
    """`inventory.data`：补货分析行 + 汇总（含截断标记与筛选口径）。"""
