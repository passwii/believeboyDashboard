"""评论追踪采集规则常量（BLF-1378，阶段 D；设计稿 §8.3）。

设计稿要求 Agent 先读「active 目标 + 抓取规则」再采集，但库里**没有**抓取规则
字段（`amazon_review_targets` 未设规则列，本阶段不加列）。这里把**服务端已强制
的语义**集中成一份常量随 R1 下发（`crawl_rules`），避免契约里出现「假装有协议」
的分页/频率参数：

* 规则全部由服务层行为派生（单源引用 `amazon_review_ingestion_service` 的
  Literal 类型与 `BUSINESS_TZ`），不另抄一份词表；
* **不下发**分页大小 / 抓取频率 / UA / 翻页停止条件——这些由采集侧决定，
  服务端不校验也不约束（设计稿只把「一周 1–2 次」写成建议，不构成契约）。

后续若产品要「按组配置频率/分页」，再单独立项给 `amazon_review_targets` 加列，
届时只需把本常量替换成 target 字段，R1 响应形状不变。
"""

from __future__ import annotations

from typing import Any, Final, get_args

from app.services.amazon_review_ingestion_service import (
    BUSINESS_TZ,
    CaptureStatus,
    IdConfidence,
    StarCountQuality,
)

#: 近期移除判定阈值：与 ``_apply_missing`` 的 ``missing_streak >= 2`` 对齐。
REMOVAL_MISSING_STREAK: Final[int] = 2

#: 单次提交的评论条数上限（路由 schema 与本次常量共用同一数字）。
MAX_REVIEWS_PER_RUN: Final[int] = 500

#: 幂等键上限：与 ``operation_audit_logs.idempotency_key`` 列宽（64）对齐。
MAX_IDEMPOTENCY_KEY_LENGTH: Final[int] = 64

CRAWL_RULES: Final[dict[str, Any]] = {
    "schema_version": 1,
    "business_timezone": str(BUSINESS_TZ),
    "snapshot_granularity": "one_per_target_per_business_date",
    "removal_rule": {
        "requires_status": "success",
        "requires_complete_list": True,
        "consecutive_misses": REMOVAL_MISSING_STREAK,
    },
    "idempotency": {
        "key_scope": "per_target",
        "max_length": MAX_IDEMPOTENCY_KEY_LENGTH,
    },
    "max_reviews_per_run": MAX_REVIEWS_PER_RUN,
    "status_values": list(get_args(CaptureStatus)),
    "star_count_quality_values": list(get_args(StarCountQuality)),
    "id_confidence_values": list(get_args(IdConfidence)),
    "notes": [
        "失败（status=failed）只落运行记录，不写评分快照与评论",
        "评分与评论分开处理：本次没有抓到评论也要提交已取得的评分快照",
        "1–5 星百分比是页面原始比例，不能据此声称精确星数",
        "同一目标同一业务日期只有一份快照，同日重试更新当天快照并保留每次运行记录",
    ],
}
