# 库存及补货分析页面当前业务逻辑

更新时间：2026-03-18

> **BLF-630 增补（2026-08-11）**：本文描述的是旧页面
> （`dashboard/data-analysis/inventory-replenishment`，`inventory_replenishment_service.py`）。
> 新页面（`dashboard/operations/inventory-replenishment`）逻辑在
> `backend/app/services/inventory/replenishment.py`，其风险/状态判定已在 BLF-630 修订：
>
> - 判定锚点从"距离断货天数绝对值分档"改为**下单缓冲**
>   `order_buffer_days = coverage_end_date − (production_lead_days + shipping_days) − today`；
> - `coverage_end_date` 为**连续覆盖截止日**：可售 + 各在途批次按 `eta_date`（兑底链
>   eta→etd+shipping→created+shipping）排时间线，断档即截止；断档如实告警（`gap_days`/`gap_start_date`）；
> - `risk_status` 分档：断档中→长期断货；order_buffer<0→短期断货；0≤order_buffer≤14→断货风险；
>   其余按覆盖天数 90/120 判健康/滞销/严重滞销；
> - `inventory_state` 新增补货可行性规则 P0a（watch）/P0b（deteriorating）。
> - 新增字段：`production_plus_shipping_days` / `latest_order_date` / `order_buffer_days` /
>   `coverage_end_date` / `gap_days` / `gap_start_date` / `next_transit_eta`。

---

## 1. 文档目的

本文档用于梳理当前项目中“库存及补货分析”页面的现有业务逻辑，作为后续重做页面与重构计算逻辑的基线说明。

本文档描述的是“当前系统实际行为”，不代表最终想要的业务方案。

---

## 2. 当前实现位置

### 2.1 前端页面

- `frontend/app/dashboard/data-analysis/inventory-replenishment/page.tsx`

当前页面负责：

- 选择项目
- 选择国家站点
- 按 SKU / ASIN 搜索
- 按风险状态筛选
- 展示主分析表
- 行内修改部分补货参数
- 打开发货信息抽屉

### 2.2 后端接口

- `GET /api/v1/inventory-replenishment-analysis`
- `PUT /api/v1/inventory-replenishment-settings/{project_id}/{sku}`
- `GET /api/v1/inventory-replenishment-shipments`

接口定义位于：

- `backend/app/api/v1/endpoints/inventory_replenishment.py`

### 2.3 后端核心服务

- `backend/app/services/inventory_replenishment_service.py`

当前页面的大部分业务口径、数据聚合、风险判定和补货日期计算都在这个 service 中完成。

### 2.4 配置表

- `backend/app/models/inventory_replenishment.py`

当前仅有一张配置表：

- `inventory_replenishment_settings`

用于保存每个 `project_id + sku + country` 的人工补货参数。

---

## 3. 页面请求流程

### 3.1 页面初始化

页面先加载项目列表，然后在已选项目下请求补货分析数据。

当前前端请求参数包括：

- `project_id`
- `country`
- `keyword`
- `risk_status`
- `page=1`
- `page_size=200`

说明：

- 当前前端虽然调用的是分页接口，但页面没有真正做翻页交互。
- 当前页面一次最多只拉取 200 行。

### 3.2 行内保存

用户在主表中修改参数后，前端会调用：

- `PUT /api/v1/inventory-replenishment-settings/{project_id}/{sku}?country=...`

保存成功后，前端会重新请求一次分析列表，刷新整张表。

### 3.3 查看发货

点击“查看发货”后，前端会调用：

- `GET /api/v1/inventory-replenishment-shipments?project_id=...&sku=...`

用于展示该 SKU 的发货记录明细。

当前排序规则：

- 以实际发货日期优先（`created_date`，若为空则退化到 `etd_date`）进行倒序
- 最近发货在最上面显示

---

## 4. 国家站点口径

### 4.1 当前允许国家

当前仅允许以下国家站点：

- `US`
- `DE`
- `UK`

### 4.2 当前别名映射

系统会将以下值归一化：

- `US / USA / 美国 / 美国站 -> US`
- `DE / GERMANY / 德国 / 德国站 -> DE`
- `UK / GB / UNITED KINGDOM / 英国 / 英国站 -> UK`

### 4.3 默认国家

如果国家为空，默认使用：

- `US`

---

## 5. 当前 SKU 基表来源

这是当前页面最重要的前置逻辑之一。

当前不是“库存报表里有什么 SKU 就展示什么”，而是先生成一个“基础 SKU 集合”，后续所有库存、销量、发货和风险计算都挂到这个集合上。

### 5.1 第一来源：ProductCost

基础 SKU 的第一来源是 `product_costs` 中的启用 SKU。

筛选条件：

- `ProductCost.project_name` 与 `Project.project_name` 做 `trim + lower` 后相等
- `ProductCost.is_active = true`
- `ProductCost.country = 当前国家`

排序规则：

- `sort_order asc`
- `id asc`

### 5.2 第二来源：inventory_replenishment_settings

基础 SKU 的第二来源是历史保存过参数的配置表：

- `inventory_replenishment_settings`

筛选条件：

- `project_id = 当前项目`
- `country = 当前国家`

### 5.3 合并规则

系统会将 `ProductCost` 和 `inventory_replenishment_settings` 两部分 SKU 合并。

合并键为：

- `(sku, country)`

合并后的现状行为：

- 如果某个 SKU 先从 `ProductCost` 进入基表，则保留该顺序
- 如果配置表里存在同一 SKU，只会在 `asin` 缺失时补上 `asin`
- 如果某个 SKU 不在 `ProductCost` 中，但在配置表中存在，也会出现在分析结果中

### 5.4 当前实际影响

这意味着以下 SKU 不会显示：

- 仅存在于库存报表中，但不在 `ProductCost` 中
- 也没有在补货配置表中保存过参数

---

## 6. 各字段的数据来源

## 6.1 店铺库存 `available_inventory`

来源：

- 当前项目
- 当前国家
- 最新一份 `inventory_report`

取数方式：

- 找出当前国家下 `is_current = true` 的最新库存报表
- 从 `inventory_snapshot_rows` 中按 `sku` 汇总 `available_qty`

现状说明：

- 当前库存只统计 `available_qty`
- 页面展示的“店铺库存”是库存快照中的可售数量汇总

## 6.2 在途数量 `in_transit_quantity`

来源：

- 发货管理数据

取数方式：

- `shipment_schedules` join `shipment_schedule_items`
- 按 `sku` 汇总 `quantity`

当前真实统计状态：

- `in_transit`
- `draft`

现状说明：

- 在途汇总口径当前包含 `in_transit + draft`
- 前端说明文案已按该口径修正

## 6.3 30D / 14D / 7D 销量

来源：

- `business_report`

取数步骤：

1. 在当前项目、当前国家下查找 `is_current = true` 的业务报表
2. 只考虑 `period_start_date` 和 `period_end_date` 都不为空，且 `period_end_date <= today` 的报表
3. 从候选报表中选择“天数最接近目标窗口，且结束日期尽量接近今天”的那一份
4. 按 `asin` 汇总 `AnalysisBusinessRow.units_ordered`
5. 再通过 `asin -> sku` 的映射回填到基础 SKU 集合

当前计算公式：

- `dms_30 = 30天报表 units_ordered / 30`
- `dms_14 = 14天报表 units_ordered / 14`
- `dms_7 = 7天报表 units_ordered / 7`

现状说明：

- 业务报表层是先按 `asin` 聚合，再映射回 SKU
- 如果多个 SKU 共用同一个 ASIN，则该 ASIN 的销量会累加分配到这些 SKU 上

## 6.4 3D 销量

来源：

- `analysis_sales_order_rows`

当前窗口并不是“最近 3 天”，而是“滞后 2 天的 3 天窗口”。

当前常量：

- `RECENT_SALES_LAG_DAYS = 2`
- `RECENT_SALES_WINDOW_DAYS = 3`

当前计算方式：

- `window_end = today - 2`
- `since = window_end - 2`
- 在 `since ~ window_end` 之间统计销量
- 只统计 `is_counted_sales = true` 的订单
- 按 `sku` 汇总 `quantity`
- 再除以 `3`

示例：

- 若今天是 `2026-03-09`
- 则 3D 实际统计窗口是 `2026-03-05 ~ 2026-03-07`

---

## 7. DMS 计算逻辑

## 7.1 基础 DMS `base_dms`

当前采用固定权重加权：

- `30D * 0.10`
- `14D * 0.30`
- `7D * 0.30`
- `3D * 0.30`

公式：

`base_dms = dms_30 * 0.10 + dms_14 * 0.30 + dms_7 * 0.30 + dms_3 * 0.30`

### 7.1.1 缺失窗口重权重规则

当前会对缺失窗口自动重权重，确保参与计算的窗口权重合计为 `100%`。

例如：

- `dms_30 = 3`
- `dms_14 = 4`
- `dms_7 = 5`
- `dms_3 = null`

当前结果是：

- `base_dms = (3*0.1 + 4*0.3 + 5*0.3) / (0.1 + 0.3 + 0.3) = 4.2857`

## 7.2 加权系数 `safety_factor`

当前默认值：

- `0.20`

页面显示为百分比输入，即：

- 页面输入 `20`
- 后端落库为 `0.20`

## 7.3 加权 DMS `weighted_dms`

公式：

`weighted_dms = base_dms * (1 + safety_factor)`

现状说明：

- 如果 `weighted_dms <= 0`，后端会直接将其视为无效，后续很多字段会返回空

---

## 8. 库存可售与补货日期计算

以下所有日期计算都是以后端 `today = date.today()` 为基准。

## 8.1 可售天数 `sellable_days`

公式：

`sellable_days = available_inventory / weighted_dms`

若 `weighted_dms` 为空，则：

- `sellable_days = null`

## 8.2 售卖截止 `sellout_date`

公式：

- `sellout_date = today + sellable_days`

## 8.3 含在途截止 `sellout_date_with_transit`

公式：

- `sellout_date_with_transit = today + (available_inventory + in_transit_quantity) / weighted_dms`

## 8.4 补货指令日期 `replenishment_order_date`

公式：

- `replenishment_order_date = sellout_date_with_transit - production_lead_days - shipping_days`

当前页面表头文案显示为：

- `补货指令`

## 8.5 建仓指令日期 `warehouse_entry_date`

公式：

- `warehouse_entry_date = replenishment_order_date + 7天`

当前这里的 `+7天` 是写死逻辑，不来自配置。

当前页面表头文案显示为：

- `建仓指令`

## 8.6 发货指令日期 `shipment_order_date`

公式：

- `shipment_order_date = replenishment_order_date + production_lead_days`

当前页面表头文案显示为：

- `发货指令`

## 8.7 风险锚点日期 `risk_anchor_date`

公式：

- `risk_anchor_date = replenishment_order_date - shipping_days`

该字段主要用于风险状态判定，当前页面不直接展示，但接口会返回。

---

## 9. 风险状态判定

当前风险状态共有 4 类：

- `断货风险`
- `未来健康`
- `滞销风险`
- `待补数据`

## 9.1 待补数据

满足以下任一条件时，判定为：

- `weighted_dms` 为空
- `weighted_dms <= 0`
- `risk_anchor_date` 为空

结果：

- `risk_status = 待补数据`

## 9.2 断货风险

如果：

- `risk_anchor_date < today`

结果：

- `risk_status = 断货风险`

## 9.3 未来健康

如果：

- `risk_anchor_date >= today`
- 且 `risk_anchor_date <= today + 90天`

结果：

- `risk_status = 未来健康`

## 9.4 滞销风险

如果：

- `risk_anchor_date > today + 90天`

结果：

- `risk_status = 滞销风险`

### 9.5 当前风险口径的直观含义

当前风险判断不是直接看“库存是否够卖”，而是看：

- 按照当前销量和在途推算出的补货触发时间
- 再减去运输时间后
- 落在今天之前、未来 90 天内、还是更远的时间段

因此它本质上是一个“时间锚点分类”，不是单纯的库存周转分类。

---

## 10. 当前可人工维护的参数

当前页面行内允许维护的参数只有 3 个：

- `production_lead_days`
- `shipping_days`
- `safety_factor`

对应默认值：

- `production_lead_days = 20`
- `shipping_days = 25`
- `safety_factor = 0.20`

保存维度：

- `project_id + sku + country`

当前表结构还支持：

- `asin`

但当前页面不提供 ASIN 编辑输入框，只是保存时会把当前行已有 ASIN 一并传回后端。

---

## 11. 当前筛选逻辑

## 11.1 关键字筛选

当前关键字会匹配：

- `sku`
- `asin`

匹配方式：

- 转小写后包含匹配

## 11.2 风险状态筛选

当前支持筛选：

- `断货风险`
- `未来健康`
- `滞销风险`
- `待补数据`

## 11.3 在途筛选

后端接口支持：

- `in_transit_only`

即只看在途数量大于 0 的 SKU。

但当前前端页面没有暴露这个筛选入口。

---

## 12. 当前顶部汇总卡片

当前页面展示 4 张卡片：

- `SKU 总数`
- `断货风险`
- `总店铺库存`
- `总在途库存`

这些汇总值都基于“筛选后的结果集”即时统计，而不是全量项目统计。

当前 summary 字段包括：

- `sku_count`
- `out_of_stock_risk_count`
- `healthy_count`
- `slow_moving_count`
- `pending_data_count`
- `total_available_inventory`
- `total_in_transit_quantity`

但前端卡片实际只展示其中 4 个。

---

## 13. 当前发货信息抽屉逻辑

点击“查看发货”时，后端会返回该项目下该 SKU 的全部发货记录。

当前查询条件：

- `ShipmentSchedule.project_id = 当前项目`
- `ShipmentScheduleItem.sku = 当前 SKU`

当前并不会按国家过滤，也不会只展示“在途”状态。

因此当前抽屉展示的是：

- 该项目下该 SKU 的所有发货记录

包括但不限于：

- `draft`
- `preparing`
- `in_transit`
- `arrived_port`
- `inbound_processing`
- `completed`
- `cancelled`

当前抽屉只是只读展示，不支持在这里维护发货信息。

---

## 14. 当前已确认的现状问题

以下问题是基于当前代码梳理出的“现状不一致”或“改版时需要明确”的点。

## 14.1 在途口径

当前在途汇总口径为：

- `in_transit + draft`

## 14.2 SKU 基表不是来自库存报表

当前主表展示范围主要由 `ProductCost` 决定，而不是由库存表决定。

这会导致：

- 库存报表里出现的新 SKU，不一定能被看到
- 若 `ProductCost` 未维护或被停用，则该 SKU 即使有库存、有销量，也可能不显示

## 14.3 业务报表销量按 ASIN 回填 SKU

当前 `30D / 14D / 7D` 销量不是直接按 SKU 统计，而是：

- 先按 ASIN 聚合
- 再回填到 SKU

如果存在：

- 一个 ASIN 对多个 SKU
- SKU 与 ASIN 维护不完整

则可能出现分配偏差或数据缺失。

## 14.4 缺失窗口自动重权重

当前加权 DMS 在缺失窗口时会自动重权重，保持参与窗口总权重为 100%。

## 14.5 建仓日期的 `+7天` 是硬编码

当前：

- `warehouse_entry_date = replenishment_order_date + 7`

这里的 `7` 没有配置来源，也没有业务说明。

如果后续要重做，建议确认这个字段真实业务含义。

## 14.6 风险状态本质是“日期锚点分类”

当前“断货风险 / 未来健康 / 滞销风险”并不是常见的库存周转分层，而是根据：

- `risk_anchor_date`

落在什么时间区间来分类。

如果后续业务想改成：

- 按可售天数分级
- 按库存覆盖天数分级
- 按补货建议量分级

则需要整体重定义。

---

## 15. 当前测试已锁定的行为

以下行为已经在测试中被覆盖，改逻辑时若不调整测试会直接失败。

### 15.1 只展示启用 SKU

- 只统计 `ProductCost.is_active = true`

### 15.2 保持 ProductCost 排序

- 主表顺序按 `ProductCost.sort_order asc, id asc`

### 15.3 国家隔离

- `ProductCost`
- 库存报表
- 日销数据
- 配置表

都会按国家隔离处理。

### 15.4 3D 使用滞后 2 天窗口

- 不是“今天往前 3 天”
- 而是“今天减 2 天后的 3 天窗口”

### 15.5 缺失窗口自动重权重

- 当前 `base_dms` 对缺失窗口采用归一化重权重逻辑

---

## 16. 建议作为重做讨论的起点

如果后续要重做“库存及补货分析”，建议优先明确以下问题：

1. 主表 SKU 范围应以什么为准
2. 在途数量到底包含哪些发货状态
3. 销量口径应按 SKU 还是按 ASIN
4. 缺失销量窗口时是否要归一化权重
5. 风险状态应按什么标准划分
6. 补货指令、建仓指令、发货指令三个日期的真实业务含义是什么
7. 是否需要增加“建议补货量”“建议发货量”等更直接的业务字段

---

## 17. 关联代码文件

本页当前逻辑主要参考以下文件：

- `backend/app/services/inventory_replenishment_service.py`
- `backend/app/api/v1/endpoints/inventory_replenishment.py`
- `backend/app/schemas/inventory_replenishment.py`
- `backend/app/models/inventory_replenishment.py`
- `backend/tests/test_inventory_replenishment_service.py`
- `frontend/app/dashboard/data-analysis/inventory-replenishment/page.tsx`
