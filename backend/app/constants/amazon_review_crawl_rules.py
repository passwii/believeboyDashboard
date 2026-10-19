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

from datetime import timedelta
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

#: ``captured_at`` 允许超出服务器当前时间的上限（容忍采集端时钟漂移）。
#:
#: 采集语义是「**现在**抓、**现在**报」，``captured_at`` 代表采集时刻，合法值
#: 恒在过去；这里留 2 小时只用于容忍机器间时钟漂移 / 微小偏差。口径取比仓库
#: 既有 ``observed_at 不晚于 now()+24h`` 更紧的值，原因：``captured_at`` 直接
#: 决定 ``amazon_review_rating_snapshots.capture_date``（运营报表口径）与 W1 的
#: 顺序水位，一旦被误报到未来，既污染当天之后的快照日期，也会让真实采集在
#: 水位追上之前一直 409。收紧到 2h 把这两个影响的最大窗口压到 2 小时，
#: 且超限时返回可自纠的 400（提示核对时钟 / 时区），不会产生任何写入。
MAX_CAPTURED_AT_FUTURE: Final[timedelta] = timedelta(hours=2)

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
    "max_captured_at_future_seconds": int(MAX_CAPTURED_AT_FUTURE.total_seconds()),
    "status_values": list(get_args(CaptureStatus)),
    "star_count_quality_values": list(get_args(StarCountQuality)),
    "id_confidence_values": list(get_args(IdConfidence)),
    "notes": [
        "失败（status=failed）只落运行记录，不写评分快照与评论",
        "评分与评论分开处理：本次没有抓到评论也要提交已取得的评分快照",
        "1–5 星百分比是页面原始比例，不能据此声称精确星数",
        "同一目标同一业务日期只有一份快照，同日重试更新当天快照并保留每次运行记录",
        "captured_at 不能晚于服务器当前时间 2 小时：超限按客户端时钟/时区标错拒绝，"
        "不会写入快照或抬高风险水位",
    ],
}
