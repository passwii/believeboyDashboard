# 调研分析口径对照清单

更新时间：2026-03-06

## 核心原则

- 后端是业务指标唯一真源。
- 前端只负责格式化、百分比映射、雷达/仪表盘归一和图表视觉组合。
- 任何业务分桶、分段、聚合，不允许再由前端基于样本数据本地重算。

## 本次修正覆盖

- 价格带规格：统一由 `price_band_standard` + `price_band_breaks` 驱动 overview 与 products。
- 评论分段：统一消费 `advanced_metrics.review_research.review_segment_distribution`。
- 上架时间天数分布：统一消费 `listing_age_distribution`。
- 上架年月趋势：统一消费 `launch_month_distribution`。
- 价格带样本占比、价格区间销量、品牌价格带覆盖：统一消费后端聚合结果。

## 验收检查

- 切换价格带预设后，价格图表、价格明细、products 过滤口径一致。
- 填写自定义断点后，overview 返回 `price_band_standard=custom` 且断点正确回显。
- 评论 tab 不再基于前端样本重算任何评论分段。
- 市场 tab 不再依赖 `/products?page_size=500` 生成上架年龄和上架年月分布。
- 历史数据执行 `recompute` 后，`review_count`、`seller_country_region`、维度字段与布尔补字段可回填。
