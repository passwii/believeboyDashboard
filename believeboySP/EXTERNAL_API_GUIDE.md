# 广告分析- 外部 API 接入文档

## 1. 基础信息
- **Base URL**: https://dash-api.believeboy.com
- **Path**: /api/v1/external/
- **协议**: HTTPS（HTTP 自动重定向至 HTTPS）
- **认证**: 无（P0 级别接口，认证和速率限制由网关层处理）
- **网络隔离**: 通过网关层实施，见 `docs/deployment/external-api-network-isolation.md`

## 2. 端点分类与报表枚举

下表逐端点列出消费方能看到的路径，以及后端 `AdUploadFile.report_type`（CSV 上传时记录的报表类型枚举）。

| 类别 | 端点路径 | 报表枚举 (`report_type`) | 说明 |
|------|----------|--------------------------|------|
| **Discovery** | `/projects` | — | 获取所有可访问的项目列表（支持 `?status=active\|archived\|all`） |
| **Files** | `/projects/{id}/ad-upload-files` | — | 获取广告上传文件列表（含 `report_type`、版本号、`ingestion_status`；`?include_history=true` 拉历史版本） |
| **Reports（聚合）** | `/projects/{id}/ad-campaigns` | `ad_campaign_report` | 广告活动层聚合（按 business key 汇总） |
|  | `/projects/{id}/ad-search-terms` | `ad_search_term_report` | 搜索词层聚合（含 `targeting_type`） |
|  | `/projects/{id}/ad-budgets` | `ad_budget_report` | 广告预算 + `suggested_budget` + `missed_*` 量化 |
|  | `/projects/{id}/ad-targets` | `ad_target_report` | 目标/定位层聚合（`top_of_search_impression_share` 等） |
|  | `/projects/{id}/ad-placements` | `ad_placement_report` | 广告位聚合（top-of-search / product-pages / rest） |
|  | `/projects/{id}/ad-promoted-products` | `ad_promoted_product_report` | 推广商品聚合（`scope_status`、`ad_sku_*` vs `other_sku_*`） |
|  | `/projects/{id}/ad-purchased-products` | `ad_purchased_product_report` | 关联购买商品聚合（halo effect 量化） |
|  | `/projects/{id}/ad-time-trends` | `ad_time_trend_report` | 时间序列聚合（日级粒度） |
|  | `/projects/{id}/ad-search-term-shares` | `ad_search_term_share_report` | 搜索词 `impression_share` + `impression_rank` |
|  | `/projects/{id}/ad-invalid-traffic` | `ad_invalid_traffic_report` | 无效流量聚合（`invalid_impression_rate`） |
| **Reports（原始）** | `/projects/{id}/ad-{type}-raw` | 同聚合端点枚举 | 未汇总原始亚马逊报告行（含 `raw_row` JSON；支持 `limit`/`offset` 分页） |
| **Summary** | `/projects/{id}/orders/summary` | — | 订单层明细 + 汇总 ✅ 当前可用（2026-07-02 实测 200） |
|  | `/projects/{id}/business-summary` | — | 业务汇总（traffic + cost/profit）🕒 **未实施**（roadmap / 未来开发） |

> **别名说明**：所有原始数据端点同时支持复数（如 `/ad-campaigns-raw`）和单数（如 `/ad-campaign-raw`）形式，功能完全相同。

> **`report_type` 枚举来源**：该枚举值在 CSV 上传时由识别层（`autoReportUpload/recognition.py`）根据文件表头确定，并作为 `AdUploadFile` 主键之一索引。可通过 `/ad-upload-files` 端点直接读到，用于消费方"我手上这份 CSV 是哪类报表"的判断；不必再去猜测路径中的复数形态。

## 3. 公共参数
所有报告端点均需要以下参数：
- `country`（**必填**）：国家代码，如 `"US"`，不能为空或空白
- `period`（**必填**）：时间周期，支持以下格式：
  - 相对周期：`7d`, `14d`, `28d`, `30d`, `60d`, `90d`
  - 特殊周期：`this_month`, `last_month`, `ytd`
  - 自定义周期：`period=custom&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`
- **仅原始数据端点可用的分页参数**：
  - `limit`：返回记录数（默认 `10000`，最大 `50000`）
  - `offset`：偏移量（默认 `0`）
  - `order_by`：排序字段（默认 `report_end_date`）
  - `order_dir`：排序方向（`asc|desc`，默认 `desc`）

> **重要提示**：`country` 和 `period` 为强制参数，缺失任一将返回 400 错误。

## 4. 数据类型与返回结构

### 4.1 响应通用结构
```json
{
  "project_id": 15,
  "period": {
    "type": "relative",
    "value": "30d",
    "start_date": "2026-06-02",
    "end_date": "2026-07-01"
  },
  "country": "US",
  "data": [...], // 具体数据数组
  "summary": {...} // 汇总信息
}
```

### 4.2 聚合端点 vs 原始端点区别

| 特性 | 聚合端点（如 `/ad-campaigns`） | 原始端点（如 `/ad-campaigns-raw`） |
|------|-------------------------------|----------------------------------|
| **数据粒度** | 按业务键汇总的聚合数据 | 未汇总的原始亚马逊报告行 |
| **返回结构** | 简单对象数组 | 包含 `raw_row` 和解析字段的对象数组 |
| **适用场景** | 仪表盘、趋势分析、高层汇总 | 深度钻取、审计、问题排查 |
| **数据量** | 较少（已聚合） | 较多（原始粒度） |
| **处理开销** | 低（直接返回） | 较高（需处理原始数据） |

### 4.3 原始端点特殊结构
原始端点（`-raw`）返回的每个数据对象包含若干通用字段以及一个 `raw_row` 对象，其中保存了亚马逊原始报告的完整列。具体的解析字段会根据报告类型（如广告活动、搜索词、预算等）略有不同，但都会至少包含以下字段：

| 字段 | 说明 |
|------|------|
| id | 内部记录ID |
| source_file_id | 关联的源文件ID |
| report_start_date | 报告开始日期 |
| report_end_date | 报告结束日期 |
| raw_row | **原始亚马逊报告数据**（销数据**（键为中文标题，结构取决于报告类型） |
| created_at | 记录创建时间 |
| campaign_name | 解析后的广告活动名称（并非所有报告类型均有） |
| ad_group_name | 解析后的广告组名称（可能为null） |
| match_type | 解析后的匹配类型（EXACT, PHRASE, BROAD, `-` 等） |
| search_term | 解析后的搜索词（仅搜索词类报告存在） |
| targeting_type | 解析后的定位类型（依广告活动类型而异，见 4.5） |
| impressions | 展示次数 |
| clicks | 点击次数 |
| ctr | 点击率 (%) |
| cpc | 每次点击费用 (USD) |
| spend | 花费 (USD) |
| orders_7d | 7天订单数（仅销售类报告存在） |
| sales_7d | 7天销售额 (USD) |
| acos | 广告花费销售比 (%) |
| roas | 广告回报率 |
| cvr_7d | 7天转化率 (%) |

> **说明**：不同的 `-raw` 端点会返回各自特有的解析字段。例如：
> - `/ad-campaigns-raw` 返回的解析字段侧重于广告活动层面的指标（如预算、状态、出价策略等），但不一定包含 `search_term`。
> - `/ad-search-terms-raw` 则包含 `search_term`、`match_type`、`targeting_type` 等搜索词特有字段，但可能不包含广告活动的预算字段。
> 因此，在处理原始数据时，建议先检查实际返回的 JSON 结构，以确定哪些字段存在。

#### raw_row 字段详解
`raw_row` 包含原始亚马逊报告的字段（示例来自搜索词报告）：
- 开始日期 / 结束日期：报告期间
- 广告组合名称 / 广告活动名称 / 广告组名称：广告结构信息
- 零售商 / 国家/地区 / 货币：环境信息
- 投放：定位类型（close-match, substitutes 等）
- 匹配类型：EXACT, PHRASE, BROAD, -
- 客户搜索词：实际触发广告的搜索词
- 展示量 / 点击量 / 点击率 (CTR) / 单次点击成本 (CPC) / 花费：基础指标
- 7天总订单数 / 7天总销售额 / 广告投入产出比 (ACOS) / 总广告投资回报率 (ROAS) / 7天的转化率：绩效指标
- 其他详细拆分指标（如7天内广告SKU销售额等）

其他报告类型（如广告预算、广告位置等）的 `raw_row` 将包含该报告特有的列，具体请参考对应的亚马逊报告模板。

### 4.4 关键字段说明（以 ad-search-terms 为例）

| 字段 | 说明 | 备注 |
|------|------|------|
| campaign_name | 广告活动名称 | 例如："商品定位"、"自动" |
| ad_group_name | 广告组名称 | 手动活动中可能有值，自动活动通常为 `null` |
| match_type | 匹配类型 | `EXACT`, `PHRASE`, `BROAD`, `-`（自动活动中表示非适用） |
| search_term | 搜索词 | 实际触发广告的搜索词 |
| targeting_type | **定位类型** | **关键区分点**：自动/手动活动使用不同分类法（见下文） |
| impressions | 展示次数 | 广告被展示的次数 |
| clicks | 点击次数 | 广告被点击的次数 |
| spend | 花费 | 广告花费（USD） |
| sales_7d | 7天销售额 | 广告带来的7天销售额（USD） |
| orders_7d | 7天订单数 | 广告带来的7天订单数 |
| ctr | 点击率 (%) | `(clicks/impressions)*100` |
| cpc | 每次点击费用 (USD) | `spend/clicks`（当 clicks > 0） |
| cvr | 转化率 (%) | `(orders_7d/clicks)*100`（当 clicks > 0） |
| acos | 广告花费销售比 (%) | `(spend/sales_7d)*100`（当 sales_7d > 0） |
| roas | 广告回报率 | `sales_7d/spend`（当 spend > 0） |

### 4.5 targeting_type 分类说明（核心机制）

后端根据广告活动类型（**自动** vs **手动**）应用不同的分类法来填充 `targeting_type` 字段：

#### 自动广告活动（Sponsored Products 自动活动）
亚马逊算法决定如何将搜索词与产品匹配，`targeting_type` 反映亚马逊的内部分类：
- `close-match`：搜索词与产品**紧密相关**（高相关性）
- `substitutes`：搜索词是**可替代产品**（用户可能考虑的替代品）
- `loose-match`：搜索词与产品**松散相关**（低相关性但仍有关联）
- `complements`：搜索词是**互补产品**（用户购买此产品时可能同时购买的产品）  
  > ✅ **已验证存在**：在项目 7 中发现明确案例（见 5.2 示例）

#### 手动广告活动（Sponsored Products 手动活动）
广告主明确选择匹配类型，`targeting_type` 直接反映所选的 `match_type`：
- `exact`：精确匹配
- `phrase`：短语匹配
- `broad`：广泛匹配
- `-`：不适用（手动活动中此字段实际 mirror 了 match_type，但保留为兼容性字段）

> **验证结论**：通过多项目测试（尤其是项目 7），确认所有四种自动活动定位类型（包括 `complements`）均存在于真实数据中。

### 4.6 订单汇总端点（orders/summary）

**端点路径**：`/projects/{id}/orders/summary`  
**说明**：返回指定项目在给定时间周期内的订单明细及汇总统计。适用于订单层面的销售分析、发货状态跟踪等。

#### 响应结构
```json
{
  "project_id": 15,
  "period": {
    "type": "relative",
    "value": "30d",
    "start_date": "2026-06-02",
    "end_date": "2026-07-01"
  },
  "country": "US",
  "data": [ /* 订单明细数组 */ ],
  "summary": { /* 汇总统计 */ }
}
```

**data 数组中每个订单对象包含以下字段：**

| 字段 | 类型 | 说明 | 示例 |
|------|------|------|------|
| amazon_order_id | String | Amazon 订单 ID | `"112-6232421-9275434"` |
| purchase_date_pt | String | 购买日期（太平洋时间） | `"2026-06-02"` |
| order_status | String | 订单状态 | `"Shipped"` / `"Pending"` |
| fulfillment_channel | String | 履约渠道 | `"—"` |
| fulfillment_label | String | 履约标签 | `"—"` |
| sku | String | 商品 SKU | `"JDB-M35-29PCS"` |
| asin | String | Amazon 商品标识码 | `"B0GX6S3RGW"` |
| product_name | null | 商品名称（本数据集中始终为 null） | `null` |
| quantity | Integer | 订购数量 | `1` |
| item_price | Float | 单价（USD） | `42.99` |
| shipping_price | Float | 运费（USD） | `0.0` |
| currency | String | 货币代码 | `"USD"` |
| country | String | 国家代码 | `"US"` |
| is_counted_sales | Boolean | 是否计入销售 | `true` / `false` |

**summary 对象包含以下聚合字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| total_orders | Integer | 订单总数 |
| total_quantity | Integer | 商品总件数 |
| total_sales_amount | Float | 销售总额（USD） |
| currency | String | 货币代码 |
| fba_orders | Integer | FBA 订单数 |
| fbm_orders | Integer | FBM 订单数 |

> **状态说明**：`/orders/summary` 端点目前能正常返回 200 响应（实测 2026-07-02）。`/business-summary` 端点未实施（roadmap / 未来开发），不在 P0 合同范围。

## 5. 成功请求示例

### 示例 1：获取广告活动汇总数据（聚合视图）
**请求**：
```http
GET https://dash-api.believeboy.com/api/v1/external/projects/15/ad-campaigns?country=US&period=30d
Accept: application/json
```

**响应摘要**：
```json
{
  "project_id": 15,
  "period": {"type":"relative","value":"30d","start_date":"2026-06-02","end_date":"2026-07-01"},
  "country":"US",
  "data":[
    {
      "campaign_name":"商品定位",
      "impressions":10605,
      "clicks":186,
      "spend":134.49,
      "sales_7d":130.45,
      "orders_7d":21,
      "ctr":1.7539,
      "cpc":0.72,
      "cvr":11.2903,
      "acos":103.097,
      "roas":0.97,
      "budget":5.0,
      "status":"ENABLED",
      "bidding_strategy":"动态竞价 - 仅降低",
      "campaign_type":"商品推广",
      "targeting_type":"手动投放",
      "portfolio_name":"No Portfolio"
    }
    // ... 更多活动数据
  ],
  "summary":{
    "total_rows":7,
    "total_spend":790.91,
    "total_sales":1710.68,
    "total_orders":77,
    "overall_acos":46.2337,
    "overall_roas":2.1629
  }
}
```

### 示例 2：获取广告活动原始数据（未汇总视图）
**请求**：
```http
GET https://dash-api.believeboy.com/api/v1/external/projects/15/ad-campaigns-raw?country=US&period=30d&limit=3
Accept: application/json
```

**响应摘要**：
```json
{
  "project_id": 15,
  "period": {"type":"relative","value":"30d","start_date":"2026-06-02","end_date":"2026-07-01"},
  "country":"US",
  "data":[
    {
      "id":2422,
      "source_file_id":5428,
      "report_start_date":"2026-06-30",
      "report_end_date":"2026-06-30",
      "raw_row":{
        "开始日期":"Jun 30, 2026",
        "结束日期":"Jun 30, 2026",
        "广告组合名称":"No Portfolio",
        "广告活动类型":"商品推广",
        "广告活动名称":"Jobber Drill Bits Set-Low ASP",
        "零售商":"Amazon",
        "国家/地区":"美国",
        "状态":"ENABLED",
        "货币":"USD",
        "预算":"$5.0",
        "定位类型":"自动投放",
        "竞价策略":"动态竞价 - 仅降低",
        "展示量":618,
        "去年曝光量":null,
        "点击量":6,
        "去年点击量":null,
        "点击率 (CTR)":"0.971%",
        "花费":"$2.32",
        "去年支出":null,
        "单次点击成本 (CPC)":"$0.38666670000000003",
        "去年每次点击成本(CPC)":"$0.0",
        "7天总订单数(#)":1,
        "广告投入产出比 (ACOS) 总计":"38.731%",
        "总广告投资回报率 (ROAS)":2.58,
        "7天总销售额":"$5.99"
      },
      "created_at":"2026-07-01T16:58:17.916975+08:00",
      "campaign_name":"Jobber Drill Bits Set-Low ASP",
      "portfolio_name":"No Portfolio",
      "campaign_type":"商品推广",
      "targeting_type":"自动投放",
      "bidding_strategy":"动态竞价 - 仅降低",
      "status":"ENABLED",
      "budget":5.0,
      "impressions":618,
      "clicks":6,
      "ctr":0.00971,
      "spend":2.32,
      "cpc":0.386667,
      "orders_7d":1,
      "sales_7d":5.99,
      "acos":0.38731,
      "roas":2.58
    }
    // ... 更多原始数据行
  ],
  "summary":{"total_rows":5,"date_range":["2026-06-02","2026-07-01"]}
}
```

### 示例 3：获取搜索词原始数据（展示 targeting_type 分类及原始数据）
**请求**：
```http
GET https://dash-api.believeboy.com/api/v1/external/projects/7/ad-search-terms-raw?country=US&period=90d&limit=3
Accept: application/json
```

**响应摘要（展示 complements 类型及原始数据结构）**：
```json
{
  "project_id": 7,
  "period": {"type":"relative","value":"90d","start_date":"2026-04-02","end_date":"2026-06-30"},
  "country":"US",
  "data":[
    {
      "id":7241,
      "source_file_id":5437,
      "report_start_date":"2026-06-30",
      "report_end_date":"2026-06-30",
      "raw_row":{
        "开始日期":"2026-06-30T00:00:00",
        "结束日期":"2026-06-30T00:00:00",
        "广告组合名称":"No Portfolio",
        "货币":"USD",
        "广告活动名称":"M35 29pcs-AUTO",
        "广告组名称":"M35 29pcs-AUTO",
        "零售商":"Amazon",
        "国家/地区":"美国",
        "投放":"close-match",
        "匹配类型":"-",
        "客户搜索词":"135 split point cobalt drill bit set",
        "展示量":1,
        "点击量":1,
        "点击率 (CTR)":1.0,
        "单次点击成本 (CPC)":1.75,
        "花费":1.75,
        "7天总销售额":0.0,
        "广告投入产出比 (ACOS) 总计":null,
        "总广告投资回报率 (ROAS)":0.0,
        "7天总订单数(#)":0,
        "7天总销售量(#)":0,
        "7天的转化率":0.0,
        "7天内广告SKU销售量(#)":0,
        "7天内其他SKU销售量(#)":0,
        "7天内广告SKU销售额":0.0,
        "7天内其他SKU销售额":0.0
      },
      "created_at":"2026-07-01T16:58:19.667673+08:00",
      "campaign_name":"M35 29pcs-AUTO",
      "ad_group_name":"M35 29pcs-AUTO",
      "match_type":"-",
      "search_term":"135 split point cobalt drill bit set",
      "targeting_type":"close-match",
      "impressions":1,
      "clicks":1,
      "ctr":1.0,
      "spend":1.75,
      "cpc":1.75,
      "orders_7d":0,
      "sales_7d":0.0,
      "acos":0.0,
      "roas":0.0,
      "cvr_7d":0.0
    },
    {
      "id":7242,
      "source_file_id":5437,
      "report_start_date":"2026-06-30",
      "report_end_date":"2026-06-30",
      "raw_row":{
        "开始日期":"2026-06-30T00:00:00",
        "结束日期":"2026-06-30T00:00:00",
        "广告组合名称":"No Portfolio",
        "货币":"USD",
        "广告活动名称":"商品定位",
        "广告组名称":"定位投放",
        "零售商":"Amazon",
        "国家/地区":"美国",
        "投放":"category=\"Jobber Drill Bits\"",
        "匹配类型":"-",
        "客户搜索词":"53/64\" drill bit",
        "展示量":1,
        "点击量":1,
        "点击率 (CTR)":1.0,
        "单次点击成本 (CPC)":0.74,
        "花费":0.74,
        "7天总销售额":0.0,
        "广告投入产出比 (ACOS) 总计":null,
        "总广告投资回报率 (ROAS)":0.0,
        "7天总订单数(#)":0,
        "7天总销售量(#)":0,
        "7天的转化率":0.0,
        "7天内广告SKU销售量(#)":0,
        "7天内其他SKU销售量(#)":0,
        "7天内广告SKU销售额":0.0,
        "7天内其他SKU销售额":0.0
      },
      "created_at":"2026-07-01T16:58:19.667673+08:00",
      "campaign_name":"商品定位",
      "ad_group_name":"定位投放",
      "match_type":"-",
      "search_term":"53/64\" drill bit",
      "targeting_type":"-",
      "impressions":1,
      "clicks":1,
      "ctr":1.0,
      "spend":0.74,
      "cpc":0.74,
      "orders_7d":0,
      "sales_7d":0.0,
      "acos":0.0,
      "roas":0.0,
      "cvr_7d":0.0
    }
    // ... 更多数据
  ],
  "summary":{"total_rows":3,"date_range":["2026-06-02","2026-07-01"]}
}
```

### 示例 4：获取广告预算建议数据（展示预算优化字段）
**请求**：
```http
GET https://dash-api.believeboy.com/api/v1/external/projects/15/ad-budgets?country=US&period=30d
Accept: application/json
```

**响应摘要**：
```json
{
  "project_id": 15,
  "period": {"type":"relative","value":"30d","start_date":"2026-06-02","end_date":"2026-07-01"},
  "country":"US",
  "data":[
    {
      "campaign_name":"自动",
      "spend":269.33,
      "sales_7d":744.78,
      "orders_7d":22,
      "acos":36.1624,
      "roas":2.7653,
      "budget":10.0,
      "suggested_budget":38.18,
      "status":"ENABLED",
      "budget_utilization_rate":0.0,
      "missed_impressions_min":0,
      "missed_impressions_max":0,
      "missed_clicks_min":0,
      "missed_clicks_max":0,
      "missed_sales_min":0.0,
      "missed_sales_max":0.0
    }
    // ... 更多活动数据
  ],
  "summary":{
    "total_rows":7,
    "total_spend":784.76,
    "total_sales":1710.68,
    "total_orders":77,
    "overall_acos":45.8742,
    "overall_roas":2.1799
  }
}
```

## 6. 最佳实践建议

### 6.1 请求优化
- **缓存项目列表**：`/external/projects` 接口变化频率低（新增项目较少），建议缓存 1-24 小时
- **并行请求**：对于同一项目的多个报告类型（如 campaigns、budgets、search-terms），可并行请求以减少总延迟
- **分页策略**：处理大数据集时，使用 `limit` 和 `offset` 参数进行分页，建议每页 1000-5000 条记录
- **周期选择策略**：
  - 常运营分析：使用 `30d`
  - 趋势分析：使用 `90d` 或 `ytd`
  - 月度对比：使用 `this_month` 搭配历史数据
  - 避免过小周期：`7d` 可能因数据延迟导致不完整（亚马逊数据通常有 24-48 小时延迟）

### 6.2 错误处理
| 错误码 | 可能原因 | 处理建议 |
|--------|----------|----------|
| `400` | 缺少 `country` 或 `period` 参数 | 检查参数是否提供且非空 |
| `400` | 无效的 `period` 格式 | 参考支持的周期格式列表 |
| `404` | 无效的 `project_id` | 先调用 `/projects` 验证项目 ID 有效性 |
| `500` | 服务器内部错误 | 其他端点极少发生；`business-summary` 未上线 |
| `429` | 速率限制（网关层） | 实现重试机制（指数退避）或降低请求频率 |

### 6.3 数据解析建议
- **聚焦 targeting_type**：此字段是理解搜索词定位策略的关键维度
- **效率评估优先级**：
  1. 先看 `roas`（广告回报率） > 1 表示盈利
  2. 再看 `acos`（广告花费销售比） < 100% 为盈亏平衡线
  3. 结合 `ctr` 和 `cvr` 评估广告创意和落地页质量
- **预算优化利用**：`ad-budgets` 端点的 `suggested_budget` 字段提供基于历史表现的预算建议
- **原始数据处理**：对于需要粒度分析的场景，使用 `-raw` 端点（如 `ad-campaigns-raw`）并注意分页（`limit`/`offset`）
- **时间窗口注意**：所有数据以昨日（T-1）为结束 anchor point，确保数据完整性
- **货币处理**：所有金额字段使用小数表示，单位为美元（USD）

### 6.4 特别注意事项
1. **业务汇总端点状态（roadmap）**：
   - `business-summary` 端点**未实施**——非已知 bug，是计划中未来开发项，不在 P0 合同范围
   - 当前 `/orders/summary` 已恢复正常（实测 2026-07-02 返回 200）
   - 消费方建议：现阶段优先使用具体的广告报告端点（campaigns / search-terms / targets 等）进行分析

2. **原始数据优势**：
   - 使用 `-raw` 端点时，可访问完整的原始亚马逊报告字段（通过 `raw_row`）
   - 这对于审计、问题排查和深度分析尤为重要
   - 原始数据包含亚马逊报告中所有可用的指标和维度

3. **数据一致性**：
   - 聚合端点和原始端点的数据应在汇总层面保持一致
   - 原始数据提供了验证聚合结果的基础

4. **速率限制建议**：
   - 建议每秒不超过 5-10 个请求（具体限制由网关层决定）
   - 实现指数退避重试机制处理 429 错误
   - 考虑在非高峰时段进行批量数据同步

5. **错误监控**：
   - 监控 500 错误（业务汇总端点上线路后纳入监控）
   - 跟踪 400 错误以及时发现参数问题
   - 记录响应时间以识别性能瓶颈

通过遵循这些最佳实践，开发者可以高效、可靠地集成广告分析外部 API，无论是构建仪表盘、报告系统还是进行深度数据分析。提供的聚合和原始双路径设计使得 API 能够满足从高层监控到底层调研的多样化需求。

---

> **文档版本**：1.0  
> **最后更新**：基于对 dash-api.believeboy.com 实际测试（2026-07-02）  
> **适用范围**：External API P0 合同版本（无认证，网络隔离在网关层）  
> **后续维护**：如遇新端点或字段变更，请参考最新的 `backend/app/api/v1/endpoints/external/` 目录及对应的 `_helpers.py`、`_period.py` 等共享模块。