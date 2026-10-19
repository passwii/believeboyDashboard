"""Agent 评论追踪采集域请求 schema（BLF-1378，阶段 D）。

W1 提交采集结果的**形态**校验层（语义校验仍在
``amazon_review_ingestion_service.record_crawl_result``，本阶段零改造）：

* ``captured_at`` 用 ``AwareDatetime``——naive 时间直接 400（服务层也会再挡一次，
  这里提前给出可自纠的字段级错误）；
* 枚举（``status`` / ``star_count_quality`` / ``id_confidence``）与 ``1..5`` 星、
  ``star_percentages`` / ``star_counts`` 恰好 5 项，都在 schema 层收紧；
* 字符串长度对齐目标列宽（``review_key`` 255 / ``title`` 512 /
  ``reviewer_id`` 128 / ``reviewer_name`` 255 / ``asin_scraped`` 20 /
  ``error_message`` 4000 / ``source`` 64），避免落库时才报数据库错误；
* ``idempotency_key`` 在 strip 后重新校验非空——``min_length=1`` 只挡原始长度，
  ``"   "`` 能过但路由会把它当 ``None`` 降级成「无幂等键」（同一请求重复提交会
  落两行 run），与 ``Idempotency-Key`` 头全空白 → 400 的口径不一致，因此在
  schema 层直接 400；
* ``reviews`` 一次最多 ``MAX_REVIEWS_PER_RUN``（500）条——与 R1 下发的
  ``crawl_rules.max_reviews_per_run`` 同一数字（单源引用常量模块）。
"""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator

from app.constants.amazon_review_crawl_rules import (
    MAX_IDEMPOTENCY_KEY_LENGTH,
    MAX_REVIEWS_PER_RUN,
)

AgentCaptureStatus = Literal["success", "partial", "failed"]
AgentStarCountQuality = Literal["exact", "estimated", "unavailable"]
AgentIdConfidence = Literal["original", "derived"]


class AgentRatingCapture(BaseModel):
    """评分块：均分 / 评分数 / 评论数 / 1–5 星百分比或绝对数。

    ``rating_count``（页面 global ratings 总数）与 ``review_count``（有文案的评论
    数）是两个指标，不得互相填充（设计稿 §8.3 / 阶段 A 观察结论）。
    """

    model_config = ConfigDict(extra="forbid")

    average_rating: float | None = Field(default=None, ge=0, le=5)
    rating_count: int | None = Field(default=None, ge=0)
    review_count: int | None = Field(default=None, ge=0)
    #: 1..5 星百分比（页面原始比例，合计可能因舍入不等于 100）。
    star_percentages: list[float] | None = Field(default=None, min_length=5, max_length=5)
    #: 1..5 星绝对数（页面给出精确数时才有）。
    star_counts: list[int] | None = Field(default=None, min_length=5, max_length=5)
    star_count_quality: AgentStarCountQuality = "unavailable"


class AgentReviewCapture(BaseModel):
    """单条评论的当前记录（内容变化只更新当前行，不保留版本）。"""

    model_config = ConfigDict(extra="forbid")

    review_key: str = Field(min_length=1, max_length=255)
    id_confidence: AgentIdConfidence
    rating: int | None = Field(default=None, ge=1, le=5)
    title: str | None = Field(default=None, max_length=512)
    body: str | None = Field(default=None, max_length=20000)
    reviewer_id: str | None = Field(default=None, max_length=128)
    reviewer_name: str | None = Field(default=None, max_length=255)
    review_date: date | None = None
    verified_purchase: bool | None = None
    helpful_count: int | None = Field(default=None, ge=0)


class AgentCrawlResultRequest(BaseModel):
    """W1 `POST .../targets/{target_id}/runs` 请求体。

    ``reviews`` 区分三种语义（不可合并）：``null``（本次未抓评论列表）、
    ``[]``（抓到了完整的空列表）、``[...]``（抓到 N 条）。空列表 + 
    ``is_complete_list=true`` + ``status=success`` 才会触发「两连缺失 → 疑似移除」
    判定，因此不能把「没抓到」提交成空列表。
    """

    model_config = ConfigDict(extra="forbid")

    captured_at: AwareDatetime
    status: AgentCaptureStatus
    rating: AgentRatingCapture | None = None
    reviews: list[AgentReviewCapture] | None = Field(
        default=None, max_length=MAX_REVIEWS_PER_RUN
    )
    is_complete_list: bool = False
    idempotency_key: str | None = Field(
        default=None, min_length=1, max_length=MAX_IDEMPOTENCY_KEY_LENGTH
    )
    asin_scraped: str | None = Field(default=None, max_length=20)
    error_message: str | None = Field(default=None, max_length=4000)
    source: str | None = Field(default=None, max_length=64)

    @field_validator("idempotency_key")
    @classmethod
    def _idempotency_key_not_blank(cls, value: str | None) -> str | None:
        """全空白等于没给键——必须 400，不能静默降级成 ``None``（假幂等）。"""
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            raise ValueError("idempotency_key 不能为空白字符串")
        return stripped
