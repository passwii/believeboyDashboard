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

# 原始行端点单次返回上限（spec §2.4）：超限显式 400，禁止静默截断 ——
# 静默截断会让「导出包含全部原始内容」变成假承诺。实测数据量距上限三个数量级。
MAX_RAW_ROWS = 50_000

# R1 overview 榜单行数硬上限（BLF-1078 P1-3）。
# 超出部分不再静默丢弃：响应会带上 ``ranking_truncated: true`` +
# ``ranking_total_count``，调用方可据此改用 R2（支持 limit/offset 分页）
# 拿完整榜单。历史上该上限是裸的 ``[:20]``，SKU 数 >20 的项目（如犀牛 30 个 SKU）
# 会无提示地丢掉尾部 SKU——而那些正是「单量小但退货率可能极高」的长尾单品。
MAX_RANKING_ROWS = 20
