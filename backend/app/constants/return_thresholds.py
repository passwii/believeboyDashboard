"""退货分析阈值常量。

BEL-372 拍板（commit 2b8b6914 plan §1）：
- 销量门槛 15（用户从 30 减半拍板）
- Wilson 95% 置信区间下界 + Critical ≥ 10% / Warning ≥ 6%
- 公式 z=1.96（95% 置信）
"""

# 最小销量门槛：低于此销量不下 risk_level（避免小样本噪声）
MIN_SALES_FOR_RISK_LEVEL = 15

# Wilson 95% 置信区间下界阈值
WILSON_CRITICAL_THRESHOLD = 10.0  # ≥ 10% → critical
WILSON_WARNING_THRESHOLD = 6.0  # ≥ 6% → warning

# 行业基线（与 _build_summary_text 对齐，备查）
APPAREL_INDUSTRY_LOW = 3.0
APPAREL_INDUSTRY_HIGH = 8.0
GENERAL_RETAIL_BASELINE = 5.0

# Wilson 公式系数
WILSON_Z = 1.96  # 95% 置信

# 快照新鲜度阈值（小时）：超过此时间走 fallback 现场跑
SNAPSHOT_STALENESS_HOURS = 25
