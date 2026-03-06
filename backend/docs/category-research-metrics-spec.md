# 调研分析指标口径手册

更新时间：2026-03-06

## 1. 目的

本文件用于统一「调研分析」页面的指标定义、计算口径、分级标准、前端展示算法与月度维护规则，避免后端计算、前端展示、人工解读三者口径不一致。

适用范围：
- `frontend/app/dashboard/tools/research-analysis/page.tsx`
- `backend/app/services/category_research_service.py`
- `backend/app/schemas/category_research.py`

## 2. 口径总原则

### 2.1 基础单位
- 销量：默认指 `monthly_sales`。
- 销售额：默认指 `monthly_revenue_usd`。
- 份额：默认指某对象销量 / 类目总销量。
- 占比展示：前端统一将 0-1 小数转换为百分比展示。
- 分数展示：若为雷达/仪表盘分数，统一压到 0-100。

### 2.2 风险等级口径
- `low`：低风险
- `medium`：中风险
- `high`：高风险

### 2.3 时间口径
- 市场趋势优先基于趋势表 `trend_rows` 聚合到 `year_month`。
- 增长默认比较“最近 12 个月”与“之前 12 个月”。
- 新品默认定义为 `listing_age_days <= 90`。

### 2.4 展示层与计算层
- 后端是指标真源，负责输出结构化指标。
- 前端允许基于后端原始指标做二次归一化、分数化和视觉映射。
- 任何“雷达分”“仪表盘分”都不应回写理解为原始业务指标。

## 3. 数据输入与基础字段

调研分析依赖的核心输入字段包括：
- 商品侧：`asin`、`brand`、`seller`、`seller_country_region`、`price_usd`、`monthly_sales`、`monthly_revenue_usd`
- 评论侧：`rating`、`review_count`
- 履约侧：`fulfillment_method`、`fba_fee_usd`
- 上新侧：`launch_date`、`listing_age_days`、`is_new_90d`
- 趋势侧：`year_month`、`monthly_sales`
- 数据质量侧：`quality_warnings`

## 4. 基础 KPI

### 4.1 样本规模
- 样本产品数：`sample_count`
- 品牌数：`brand_count`
- 类目总月销量：`total_monthly_sales`
- 类目总月销售额：`total_monthly_revenue_usd`
- 亚马逊样本占比：`amazon_share`

### 4.2 价格统计
- 均价：全部有效价格均值
- 中位价：全部有效价格中位数
- `P25`：25 分位价格
- `P75`：75 分位价格

## 5. 竞争结构指标

### 5.1 集中度通用算法

统一算法 `_build_market_concentration`：
- `CR1 = Top1销量 / 总销量`
- `CR3 = Top3销量之和 / 总销量`
- `CR5 = Top5销量之和 / 总销量`
- `CR10 = Top10销量之和 / 总销量`
- `HHI = Σ(份额 × 100)^2`

统一风险判定 `_risk_level_by_concentration`：
- 高风险：`CR3 >= 70%` 或 `HHI >= 2500`
- 中风险：`CR3 >= 45%` 或 `HHI >= 1500`
- 低风险：其余情况

### 5.2 品牌垄断

指标：
- 品牌 `CR3`
- 品牌 `CR5`
- 品牌 `CR10`
- 品牌 `HHI`
- 品牌风险等级

公式：
- 品牌粒度按 `brand` 聚合销量后计算

分级：
- `CR3`：低 `<45%`，中 `45%-70%`，高 `>=70%`
- `HHI`：低 `<1500`，中 `1500-2500`，高 `>=2500`

### 5.3 卖家垄断

指标：
- 卖家数
- 卖家 `CR1 / CR3 / CR5 / CR10`
- 卖家 `HHI`
- 自营销量占比 `amazon_seller_sales_share`
- 卖家风险等级

公式：
- 卖家粒度按 `seller` 聚合销量
- 自营销量占比 = 亚马逊自营销量 / 总销量

自营识别规则 `_is_amazon_seller`：
- `bbx_attr` 命中“亚马逊自营”
- 或 `seller` / `bbx_attr` 包含 `amazon` / `亚马逊`

### 5.4 卖家垄断系数

该指标主要用于说明卡片和卖家结构解释，不是单独后端字段。

公式：
- `0.6 × Seller CR3 + 0.4 × min(Seller HHI / 2500, 1)`

分级：
- 低 `< 0.45`
- 中 `0.45 - 0.70`
- 高 `>= 0.70`

### 5.5 产品垄断

按 `asin` 聚合销量，计算：
- `asin_top1_share`
- `asin_top3_share`
- `asin_top10_share`
- `top1_to_top100_ratio`

公式：
- `Top1份额 = Top1 ASIN销量 / 总销量`
- `Top3份额 = Top3 ASIN销量之和 / 总销量`
- `Top10份额 = Top10 ASIN销量之和 / 总销量`
- `Top1/Top100 = Top1 ASIN销量 / Top100 ASIN销量总和`

风险判定：
- 高风险：`Top1 >= 35%` 或 `Top3 >= 65%` 或 `Top1/Top100 >= 20%`
- 中风险：`Top1 >= 20%` 或 `Top3 >= 45%` 或 `Top1/Top100 >= 12%`
- 低风险：其余情况

### 5.6 中国卖家竞争强度

输出字段：
- 中国卖家数 `china_seller_count`
- 中国卖家数量占比 `china_seller_count_share`
- 中国卖家销量占比 `china_seller_sales_share`
- 风险等级

中国卖家识别 `_is_china_seller`：
- 优先识别 `seller_country_region` 命中 `cn/china/中国/中国大陆/mainland china/hong kong/香港`
- 其次在 `seller` 和 `BBX卖家属性/卖家属性` 中模糊匹配：
  - `中国`
  - `china`
  - `chinese`
  - `cn seller`
  - `mainland`
  - `香港`
  - `hong kong`
  - `shenzhen`
  - `guangdong`
  - `义乌`

风险判定：
- 高风险：数量占比或销量占比 `>= 70%`
- 中风险：数量占比或销量占比 `>= 50%`
- 低风险：其余情况

## 6. 市场节奏与机会指标

### 6.1 市场增长

函数：`_build_market_growth`

输出字段：
- `trend_slope`
- `last12_vs_prev12_growth`
- `cagr_like_growth`
- `growth_level`
- `growth_tier`
- `radar_score`

公式：
- 趋势斜率：对月销量序列做一元线性拟合，取斜率
- 最近 12 个月增长：
  - 若数据不少于 24 个月：`最近12个月销量 / 之前12个月销量 - 1`
  - 若数据在 12-23 个月：按前后半段切分
  - 若数据不足 12 个月：用末月对前序合计做近似
- `CAGR-like`：
  - `((末值 / 首值) ^ (12 / 期间数)) - 1`

基础方向分级 `growth_level`：
- 增长：`last12_vs_prev12_growth >= 8%` 或 `cagr_like_growth >= 10%`
- 收缩：`last12_vs_prev12_growth <= -8%` 或 `cagr_like_growth <= -8%`
- 平稳：其余情况

精细层级 `growth_tier`：
- `explosive`：`>= 25%`，雷达分 `96`
- `fast_growing`：`12%-25%`，雷达分 `84`
- `growing`：`3%-12%`，雷达分 `68`
- `stable`：`-3%~3%`，雷达分 `52`
- `softening`：`-12%~-3%`，雷达分 `30`
- `shrinking`：`< -12%`，雷达分 `12`

### 6.2 季节性

函数：`_build_seasonality`

输出字段：
- `peak3_month_sales_share`
- `monthly_sales_cv`
- `seasonality_level`
- `recommended_entry_months`
- `seasonality_tier`
- `entry_friendliness_score`

公式：
- `Peak3占比 = 销量最高3个月销量之和 / 全部月份销量`
- `CV = 月销量标准差 / 月销量均值`
- 推荐入场月：取全年销量最高 3 个自然月，每个峰值月向前推 1 个月

基础分级 `seasonality_level`：
- 强季节性：`Peak3 >= 45%` 或 `CV >= 0.60`
- 中季节性：`Peak3 >= 32%` 或 `CV >= 0.35`
- 弱季节性：其余情况

精细层级 `seasonality_tier` 与入场友好分：
- `extreme`：`Peak3 >= 58%` 或 `CV >= 0.85`，分数 `12`
- `strong`：`Peak3 >= 45%` 或 `CV >= 0.60`，分数 `28`
- `elevated`：`Peak3 >= 38%` 或 `CV >= 0.45`，分数 `46`
- `moderate`：`Peak3 >= 32%` 或 `CV >= 0.35`，分数 `64`
- `mild`：`Peak3 >= 26%` 或 `CV >= 0.22`，分数 `82`
- `balanced`：其余情况，分数 `94`

### 6.3 新品机会

函数：`_build_new_product_opportunity`

新品定义：
- `listing_age_days <= 90`

输出字段：
- `new_product_count`
- `new_product_share`
- `new_product_sales_share`
- `new_product_avg_monthly_sales`
- `new_product_median_price_usd`
- `opportunity_level`
- `radar_score`

公式：
- 新品数量占比 = 新品数 / 总商品数
- 新品销量占比 = 新品总销量 / 类目总销量
- 机会信号 = `max(新品数量占比, 新品销量占比 × 1.15)`

分级：
- 极高：`>= 25%`，雷达分 `92`
- 高：`16%-25%`，雷达分 `76`
- 中：`8%-16%`，雷达分 `58`
- 低：`4%-8%`，雷达分 `36`
- 极低：`<4%`，雷达分 `18`

## 7. 评论与口碑指标

### 7.1 评论统计

函数：`_build_review_research`

输出字段：
- 平均评分 `average_rating`
- 评论中位数 `review_median`
- 评论 `P75`
- `review_top10_share`
- `low_review_product_share`
- `low_review_threshold`
- `bottom_quartile_product_share`
- `rating_band_distribution`
- `review_segment_distribution`

公式：
- `Top10评价占比 = 评论数 Top10 产品评论总数 / 全部评论总数`
- 低评价产品占比：评论数 `< 100` 的商品数 / 全部商品数
- 末尾 25% 产品占比：评论数 `<= P25(review_count)` 的商品数 / 全部商品数

### 7.2 评分星级分布

固定分桶：
- `1.0-1.5`
- `1.5-2.0`
- `2.0-2.5`
- `2.5-3.0`
- `3.0-3.5`
- `3.5-4.0`
- `4.0-4.5`
- `4.5-5.0`

### 7.3 评论分段算法

算法：
- 仅取 `review_count > 0` 的正样本计算 10%、20% ... 90% 分位数
- 分位数取整并去重
- 构造边界 `[0, q10, q20, ..., q90, max(review_count)]`
- 最后一段用 `lower+` 表示

说明：
- 该分段为“近似十分位分段”，不是固定评论档位
- 目的是保留冷启动段和高壁垒段

## 8. 价格结构指标

### 8.1 价格带生成方法

函数：
- `_resolve_price_band_spec`
- `_auto_price_breaks`
- `_build_price_band_spec`

支持方式：
- 手动断点：`manual_custom`
- 预设断点：`default / value / premium`
- 自动精细断点：`scientific_refined`

预设断点：
- `default`: `[50, 100, 150]`
- `value`: `[30, 60, 100, 150]`
- `premium`: `[100, 150, 200, 300]`

自动断点算法：
- 先对有效价格排序
- 用 `IQR = Q3 - Q1`
- 用 Freedman-Diaconis 风格宽度：`2 * IQR / n^(1/3)`
- 再与全价差/目标桶数做比较，取更大的宽度
- 通过 `_nice_price_step` 把步长美化为 `1 / 2 / 2.5 / 5 / 10 × 10^k`
- 最多 8 个断点

### 8.2 固定价格带样本分布

函数：`_build_fixed_price_bands`

含义：
- 按当前价格带规格，把每个商品落到对应价格带，统计 `count`

### 8.3 分位价格带

函数：`_build_quantile_price_bands`

算法：
- 计算 `Q1/Q2/Q3/Q4`
- 按 `<=P25`、`<=P50`、`<=P75`、`>P75` 分桶

### 8.4 价格机会带

函数：`_build_price_band_opportunities`

每个价格带输出：
- 样本数 `count`
- 月销量 `monthly_sales`
- 月销售额 `monthly_revenue_usd`
- 销量占比 `sales_share`
- 销售额占比 `revenue_share`
- 平均评分 `average_rating`
- 平均评论数 `average_review_count`

### 8.5 价格相关性

函数：`_price_sales_correlation`

公式：
- 用全部有效 `(price_usd, monthly_sales)` 做皮尔逊相关系数

派生分数：
- `price_correlation_score = max(0, 100 - abs(correlation) * 100)`

解释：
- 绝对值越低，说明价格对销量解释力越弱，价格自由度越高
- 绝对值越高，说明销量与价格更强绑定

## 9. 供给复杂度

函数：`_build_supply_complexity`

输出字段：
- `score`
- `fulfillment_mix_score`
- `fba_fee_pressure_score`
- `price_dispersion_score`
- `complexity_level`
- `radar_score`

公式：
- 履约混合度：
  - 对履约方式分布计算信息熵
  - 再除以最大熵归一到 `0-100`
- `FBA费用压力 = min(100, 平均(FBA费 / 售价) × 500)`
- `价格离散度 = min(100, 价格标准差 / 平均价 × 100)`
- 总分：
  - `0.4 × 履约混合度 + 0.4 × FBA费用压力 + 0.2 × 价格离散度`
- 展示向正向分：
  - `radar_score = 100 - score`

分级：
- 极低复杂度 `<24`
- 低复杂度 `24-40`
- 中复杂度 `40-58`
- 高复杂度 `58-75`
- 极高复杂度 `>=75`

## 10. 数据质量

函数：`_build_data_quality`

警报来源：
- `missing_trend_for_asin_count`
- `invalid_price_count`
- `invalid_fba_fee_count`
- `duplicate_asin_count`
- `missing_fba_fee_count`
- `missing_seller_country_count`
- `missing_brand_count`
- `unknown_fulfillment_count`

### 10.1 子分构成

完整性扣分：
- `0.35 × 缺失FBA费占比`
- `0.25 × 缺失卖家国家占比`
- `0.20 × 缺失品牌占比`
- `0.20 × 缺失趋势占比`

有效性扣分：
- `0.55 × 无效价格占比`
- `0.45 × 无效FBA费占比`

一致性扣分：
- `0.60 × 重复ASIN占比`
- `0.40 × 未知履约方式占比`

覆盖度扣分：
- `1.00 × 缺失趋势占比`

### 10.2 总分公式

- `completeness_score = 100 × (1 - completeness_penalty)`
- `validity_score = 100 × (1 - validity_penalty)`
- `consistency_score = 100 × (1 - consistency_penalty)`
- `coverage_score = 100 × (1 - coverage_penalty)`
- `score = 0.3 × 完整性 + 0.3 × 有效性 + 0.2 × 一致性 + 0.2 × 覆盖度`

### 10.3 质量等级

- 优秀：`>= 92`
- 良好：`82 - 92`
- 一般：`68 - 82`
- 较差：`< 68`

### 10.4 警报密度

公式：
- `warning_density = 所有警报总数 / 样本产品数`

## 11. 维度块、信号与建议

### 11.1 三大维度块

函数：`_build_dimension_blocks`

竞争结构 `structure`：
- 综合品牌、卖家、产品、中国卖家竞争的最高风险等级

机会定位 `opportunity`：
- 满足以下条件累计计分：
  - 市场增长为 `growing`
  - 季节性为 `weak` 或 `moderate`
  - 新品销量占比 `>= 12%`
  - 低评价产品占比 `>= 35%`
- 评分结果：
  - `>=3` 为高
  - `=2` 为中
  - `<2` 为低

执行落地 `execution`：
- 数据质量 `<80` 为高风险
- 数据质量 `<92` 为中风险
- 否则低风险

### 11.2 信号卡片

函数：`_build_signals`

规则：
- 品牌/卖家/产品/中国卖家竞争：直接继承风险等级，方向为负向
- 市场增长：
  - `growing` => 高等级、正向
  - `stable` => 中等级、中性
  - `shrinking` => 高等级、负向
- 季节性：
  - `strong` => 高等级、负向
  - `moderate` => 中等级、中性
  - `weak` => 低等级、中性
- 数据可信度：
  - 分数 `<80` => 高等级、负向
  - 分数 `<92` => 中等级、负向
  - 否则低等级、正向

### 11.3 动作建议

函数：`_build_action_recommendations`

当前内置 3 条主建议与 1 条追加建议：
- 中尾部价格带差异化切入
- 按推荐入场月提前铺货
- 先做高影响数据校验
- 当“单品垄断高且新品承接不足”时，追加“暂缓进入”

## 12. 前端展示层派生算法

本节不是后端原始指标，而是 `research-analysis/page.tsx` 的展示口径。

### 12.1 总览雷达

六个维度均统一为“越高越好”：
- 增长机会 = `market_growth.radar_score`
- 淡旺季友好度 = `seasonality.entry_friendliness_score`
- 新品承接度 = `new_product_opportunity.radar_score`
- 供给友好度 = `supply_complexity.radar_score`
- 竞争开放度 = 平均值：
  - `(1 - 品牌CR3) × 100`
  - `(1 - 卖家CR3) × 100`
  - `(1 - 中国卖家销量占比) × 100`
- 数据可信度 = `data_quality.score`

### 12.2 市场 Tab

月趋势对比：
- `recent12` = 最近 12 个月月销量
- `prior12` = 上一轮 12 个月对应月份销量

季节性/增长双饼图：
- 季节性：
  - `Peak3 月份占比`
  - `其他月份 = 100 - Peak3`
- 增长：
  - `增长得分 = clamp((last12_vs_prev12_growth + 1) × 50)`
  - `剩余区间 = 100 - 增长得分`

上架分段表：
- 依据 `launch_date` 聚合
- 仅取最近 18 个上架月份
- 表格展示销量最高的前 8 个批次

### 12.3 品牌 Tab

Top10 vs 其他品牌：
- `Top10品牌 = Top10品牌销量份额之和`
- `其他品牌 = 1 - Top10品牌`

Top5 品牌雷达：
- 销量 = 以 Top5 中最大月销量为 `100` 归一
- 份额 = 以 Top5 中最大市场份额为 `100` 归一
- 价格跨度 = `(最高价 - 最低价) × 2` 后截断到 `0-100`
- 覆盖价格带 = `已覆盖价格带数 / Top5总价格带数 × 100`
- 产品数 = 以 Top5 中最大产品数为 `100` 归一

说明：
- “份额”轴 2026-03-06 起改为 Top5 内相对归一，不再直接展示市场百分比，避免图上被压扁

### 12.4 卖家 Tab

卖家国籍构成：
- 饼图按销量占比，不按卖家数占比

销量占比 vs 数量占比：
- 销量占比 = 国别卖家销量 / 总销量
- 数量占比 = 国别卖家数 / 总卖家数

卖家结构雷达：
- 卖家数量 = `clamp(seller_count)`
- `CR3/CR5 = 百分比 × 100`
- `HHI = HHI / 100`
- `FBA占比 = FBA商品数 / 全部商品数`
- 非自营空间 = `(1 - amazon_seller_sales_share) × 100`

### 12.5 评价 Tab

低评价产品占比饼图：
- 当前图实际展示的是 `bottom_quartile_product_share`
- 即“评论数处于样本末尾 25% 的产品占比”
- 不等同于 `<100` 条评论产品占比

评论门槛仪表：
- 评价中位数 = `review_median / review_p75 × 100`
- 评价 `P75` = `review_p75 / review_p75 × 100 = 100`
- Top10评价占比 = 百分比 × 100
- 低评价产品占比 = `<100评论商品占比 × 100`

累计销量占比：
- 沿评论分段顺序累加月销量，再除以评论分段总销量

### 12.6 价格 Tab

价格带样本占比：
- 每个价格带样本占比 = `价格带count / 全部价格带count合计`

价格结构雷达：
- 均价 = `mean / p75 × 100`
- 中位价 = `median / p75 × 100`
- `P25 = p25 / p75 × 100`
- `P75 = 100`
- 价格离散度 = `(p75 - p25) × 2`
- 价格相关得分 = `price_correlation_score`

## 13. 月度维护建议

每月更新时建议按以下顺序检查：

1. 先确认源数据字段是否有新增、改名或缺失。
2. 再检查 `quality_warnings` 口径是否变化。
3. 复核品牌、卖家、评论、价格四个核心聚合函数是否改动。
4. 若改了阈值，必须同时更新：
   - 后端计算函数
   - `metric_definitions`
   - 前端提示文案
   - 本文档
5. 若改了展示归一算法，必须在“前端展示层派生算法”章节记录修改日期与原因。

## 14. 当前容易混淆的点

- “低评价产品占比”有两个口径：
  - 后端主指标：`low_review_product_share`，即 `<100评论商品占比`
  - 当前饼图：`bottom_quartile_product_share`，即评论数末尾 25% 商品占比
- 品牌 Tab 雷达中的“份额”是展示归一分，不是原始市场份额百分比。
- 卖家国籍构成饼图按销量占比，不按卖家数量占比。
- 价格带样本占比按样本数，不按销量。

## 15. 后续扩展建议

若后续希望把这份文档用于月度复盘模板，建议追加两部分：
- 指标异常变动记录表：记录本月阈值或算法是否变更
- 口径变更日志：记录修改日期、责任人、影响页面与影响字段
