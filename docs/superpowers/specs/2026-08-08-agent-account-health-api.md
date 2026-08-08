# 店铺合规健康 Agent API 设计（account_health）

> 设计定稿 v0.1（2026-08-08，BLF-549 S1 拍板 D1–D5）。
> 域 code：`account_health`；命名空间：`/api/v1/agent/account-health/*`。
> 前置设计：`docs/agent-api-design.md`（v0.7）；相关域：BLF-378（店铺账号健康 External API，交付归 `shop_calculations` 域）。

## 1. 文档目的与域定位

### 1.1 文档目的

承接 BLF-547「店铺合规健康 Agent API（Account Health）：调研 + 阶段推进」的 **S1（调研 + 必要元素定稿）**：
梳理现状底座、评估 SP-API 可采字段、拍板数据源 / 端点清单 / 必要元素，作为 S2（数据底座）与 S3（实施）的锚点。

### 1.2 域定位（单域原则）

- **单域原则**（spec §1.2）：本域只服务「店铺合规 / 账户健康」一个业务域，**不允许跨域打包**（对照 BLF-476 删除 business-summary 的先例——业务域边界按「一个业务实体域一个 Agent 域」切分）。
- 本域边界 = **平台巡检（platform inspection）数据**：周粒度、每（周期 × 店铺）一条巡检报告，含账户健康评级 + 客服/配送绩效 + 政策合规分类计数。
- **不吸收**店铺测算（`shop_calculations`）/ 新品测算（`new_product_calculations`）/ 库存等其它域端点——那些已有各自域 code 与端点。

## 2. 现状底座清单（代码 + 生产库双核实）

### 2.1 数据模型（3 表，`backend/app/models/inspection.py`）

| 表 | 关键字段 | 说明 |
|---|---|---|
| `inspection_periods` | `week_start` / `week_end` / `deadline` | 每周一行，`week_start` 唯一 |
| `inspection_reports` | `period_id` + `project_id` 唯一键；`health_data` / `compliance_data`（**JSON 列但 schema 固定**）；`status`(draft/submitted) / `status_summary` / `submitted_by` / `submitted_at` | 每（周期 × 店铺）一条 |
| `inspection_screenshots` | `r2_key` / `thumbnail_key` / `caption` | R2 存储，接口返回 presigned URL（**外部不可直接暴露**） |

### 2.2 字段集（= Account Health 指标集，周巡检表单，`backend/app/schemas/inspection.py`）

**`health_data` 8 字段**（账户健康 + 客服绩效 + 配送绩效）：

| 字段 | 含义 | 阈值（模板） |
|---|---|---|
| `account_health_rating` | 账户健康评级（Healthy/Good/At Risk/Critical） | select 枚举 |
| `negative_feedback` | 负面反馈（条数） | warn 1 / crit 3 |
| `a2z_claims` | 亚马逊 A-to-Z 索赔（条数） | warn 1 / crit 3 |
| `chargeback_claims` | 信用卡拒付（条数） | warn 1 / crit 3 |
| `late_shipment_rate` | 迟发率（%） | warn 2.0 / crit 4.0 |
| `pre_fulfillment_cancel_rate` | 配送前取消率（%） | — |
| `valid_tracking_rate` | 有效追踪率（%） | warn 97.0 / crit 95.0（below） |
| `on_time_delivery_rate` | 准时交付率（%） | warn 97.0 / crit 95.0（below） |

**`compliance_data` 10 字段**（政策合规分类计数，warn 1 / crit 3）：`ip_infringement` / `ip_complaints` / `product_authenticity_complaints` / `product_condition_complaints` / `food_product_safety` / `listing_policy_violations` / `restricted_product_violations` / `review_policy_violations` / `other_policy_violations` / `regulatory_compliance`。

### 2.3 后端现有端点（`backend/app/api/v1/endpoints/inspections.py`，9 条，前缀 `/api/v1/inspections`）

| # | 端点 | 方法 | 能力 |
|---|---|---|---|
| 1 | `/template` | GET | 巡检模板（字段 + 阈值） |
| 2 | `/periods` | GET | 周期列表（limit/offset） |
| 3 | `/periods/current` | GET | 当前周期（**有建行副作用**，见 §5 R2） |
| 4 | `/periods/{period_id}/overview` | GET | 周期概览（覆盖/提交/逾期 + 逐店行） |
| 5 | `/periods/{period_id}/projects/{project_id}` | GET/POST/PATCH | 单店报告读/写 |
| 6 | `/periods/{period_id}/projects/{project_id}/submit` | POST | 提交 |
| 7 | `/screenshots/upload`、`/screenshots/{id}` | POST/DELETE | 截图管理 |
| 8 | `/history` | GET | 历史（period/project 筛选 + 分页） |

**Agent 侧零开放**：`external_mirror.py` 无任何 inspection 路由；`/agent/*` 命名空间（`agent/__init__.py`）10 个 live 域无 `account_health`。

### 2.4 生产库实查（2026-08-09 VPS）

11 周档（2026-05-25 → 2026-08-09）、49 条报告**全部 submitted**、覆盖 14 店、`health_data` / `compliance_data` 填充 **100%**、评级分布 Good 45 / Healthy 1 / At Risk 1 / 空 2、截图 51 张、`status_summary` 仅 ~23% 填充。

## 3. BLF-378 存量方案对齐（D5 依据）

### 3.1 关键发现

- **BLF-378 调研结论**（2026-08-01）："店铺账号健康"= **平台巡检**（platform inspection），非库存健康分。
- 但 BLF-378 实际交付（BEL-416，已部署）是**店铺核算 / 新品核算** 4 端点（`shop-calculation-history` / `shop-calculation/snapshots` / `pricing-snapshots?as_of=` / `new-product-calculations`）——归 **`shop_calculations` 域**，与巡检数据无关。
- **巡检数据从未对 Agent 开放**：无 `/external/inspections/*` 也无 `/agent/account-health/*`。本域补齐这个空白，**不产生重复**。
- 仓库**无 SP-API 集成**（全库仅 roadmap 提及）；opencli 爬 Seller Central 因反爬 / TOS 风险已在 BLF-378 明确不采用（BEL-415 已 cancelled）。

### 3.2 边界结论（D5）

独立端点 + 独立域 code `account_health`，**不吸收 BLF-378 端点**（其交付归 `shop_calculations` 域）；字段拍平口径沿用 BLF-378 调研建议（§4 字段集、不暴露 raw JSON / R2 presigned URL）。

## 4. SP-API Account Health 可采字段评估（2026-08-09 调研）

### 4.1 结论先行

**SP-API 没有独立的「Account Health API」**。Account Health 数据面 = **Reports API 的 Seller Performance Report（`GET_V2_SELLER_PERFORMANCE_REPORT`）**，外加 Notifications API 的 `ACCOUNT_STATUS_CHANGE_NOTIFICATION`（实时状态变更推送）。本域 S2 **不引入 SP-API 采集**（见 D1）；以下评估作为未来独立 L3 项目的输入。

### 4.2 `GET_V2_SELLER_PERFORMANCE_REPORT` 结构（实测字段映射）

- 位置：Reports API（v2020-09-04），角色 **Selling Partner Insights**，**只能主动请求**（requested，不可 scheduled），需 reportOptions（dateRangeType / marketplaceIds）。
- 返回结构（2022 实测 + GitHub selling-partner-api-models 讨论 #2811 / #3575 核实）：

```jsonc
{
  "accountStatuses": [ { "marketplaceId": "...", "status": "NORMAL" } ],   // 账户级状态
  "performanceMetrics": [
    {
      "accountHealthRating": { ... },          // AHR 0-1000 分（讨论 #3575 证实存在）
      "orderDefectRate": { "afn": {...}, "mfN": {...},   // 内含 A-to-Z / chargeback 组件计数
        "negativeFeedback": {...}, "aTozClaims": {...}, "chargebackClaims": {...} },
      "lateShipmentRate": { "rate": 0, "targetValue": 0.04, "targetCondition": "LESS_THAN", ... },
      "preFulfillmentCancelRate": { ... },
      "validTrackingRate": { ... },
      "onTimeDeliveryRate": { ... },            // 2025 changelog 新增 unitOnTimeDeliveryRate
      "negativeFeedbackRate": { ... },
      "invoiceDefectRate": { ... },
      "listingPolicyViolations": { ... },       // 政策违规计数（讨论 #2811）
      "foodAndProductSafetyIssues": { ... }     // 商品安全计数
    }
  ]
}
```

- 每个 metric 自带：`reportingDateRange`、`status`（GOOD/…）、`targetValue` + `targetCondition`（阈值语义，与巡检模板 warn/crit 概念同构）、`rate` / 组件计数。

### 4.3 SP-API 字段 → 巡检字段覆盖映射

| 巡检字段 | SP-API 来源 | 口径差异 |
|---|---|---|
| `account_health_rating` | `performanceMetrics.accountHealthRating`（AHR 0-1000 分） | 现有为字符串评级（Healthy/Good/At Risk/Critical），需映射规则或并存原始分 |
| `a2z_claims` / `chargeback_claims` | `orderDefectRate.aTozClaims` / `.chargebackClaims`（组件计数） | 基本一致 |
| `negative_feedback` | `negativeFeedbackRate` | 现有为**条数**，SP-API 为**比率**，需换算或改口径 |
| `late_shipment_rate` | `lateShipmentRate.rate` | 一致 |
| `pre_fulfillment_cancel_rate` | `preFulfillmentCancelRate.rate` | 一致 |
| `valid_tracking_rate` | `validTrackingRate.rate` | 一致 |
| `on_time_delivery_rate` | `onTimeDeliveryRate` / `unitOnTimeDeliveryRate` | 注意 14 天窗口 vs 周巡检窗口差异（GitHub #4078） |
| `listing_policy_violations` | `listingPolicyViolations`（计数） | 一致 |
| `food_product_safety` | `foodAndProductSafetyIssues`（计数） | 一致 |
| 其余 8 项合规（ip_* / product_authenticity / product_condition / review_policy / other_policy / regulatory） | **无 SP-API 字段** | 只能人工录入或页面爬取 |
| 账户状态（新） | `accountStatuses[].status`（NORMAL 等） | 现有模板无此字段，可作扩展 |

### 4.4 局限（为什么 S2 不复用 SP-API）

1. **合规类 10 项只有 ~20% 可自动化**（8/10 无公开字段）；违规**明细列表**（按 ASIN）SP-API 不提供（讨论 #2811），只有计数。
2. **接入成本高**：SP-API 应用注册 + LWA/RDT 授权 + Selling Partner Insights 角色 + 报表管道（request→poll→download→parse），是独立基建工程；仓库当前**零 SP-API 集成**（亚马逊数据全靠 CSV/Excel 手动上传，17 种报表）。
3. **现有巡检已 100% 覆盖且结构化**（49 条/14 店/填充 100%），Agent 读 API 不需要 SP-API 就能交付业务价值。

> 未来 L3 选项（独立 issue，不进本域 S2）：SP-API 采集管道落 `account_health_snapshots` 时序表，与人工巡检双源（自动信号 + 人工合规），字段映射见 §4.3 表。

## 5. 决策拍板（D1–D5）

| # | 决策点 | 结论 |
|---|---|---|
| **D1 数据源** | 复用巡检（L1）vs 新增 SP-API 采集（L3） | **复用现有巡检数据（L1）**：零采集成本、数据已结构化（49 条 / 14 店 / 100% 填充）。**S2 缩水为「确认零新增 + 数据局限文档」**；SP-API Account Health 采集为独立 L3 项目（§4.4），不在本域 S2 |
| **D2 域 code** | — | **`account_health`**（与既有 10 域无冲突；`agent_api_keys.business_scope` 为字符串列，加值无迁移） |
| **D3 端点清单** | 读/写 | **读 5 条、写 0 条**（§6 R1–R5）。巡检是人工周检事实记录，Agent 无写场景；纯读域不落操作审计（对齐 `report_upload_status` / `return_analysis` 模板） |
| **D4 必要元素** | — | 逐端点字段表（§7）：`limit=20/50`、`offset=0`、**空值=null 非 0**、**空结果=200 非 404**；无费率概念 → 默认值 = 查询默认 + 空值语义 |
| **D5 与 BLF-378 边界** | — | 独立端点 + 独立域 code，不吸收 BLF-378 端点（其交付归 `shop_calculations` 域）；字段拍平口径沿用 BLF-378 调研建议 |

## 6. 端点清单（R1–R5，全读）

挂载：`agent/__init__.py` 兜底路由之前 `include_router(account_health_router, dependencies=[Depends(require_business_scope("account_health"))])`。
项目范围门禁：`project_scope` **列表过滤语义**（对齐 `report_upload_status` / `external_mirror /projects`）——白名单只返回可见项目；R4 直取项目不在范围 → 404 `RESOURCE_NOT_FOUND`。

### R1 周期列表 — `GET /api/v1/agent/account-health/periods`

- 参数：`limit`（默认 20，≤100）、`offset`（默认 0）。
- 响应：`{ ok, data: { items: [PeriodItem], total } }`。
- 复用：`inspection_service.list_periods`（纯读，零改造）。

### R2 当前周期 — `GET /api/v1/agent/account-health/periods/current`

- ⚠️ **唯一需要动内部服务的地方**：内部 `get_or_create_current_period` 有**建行副作用**（无周期时 INSERT）。Agent 读侧需在 `inspection_service` **新增纯读函数**（如 `get_current_period`，无则返回 404）——**不改现有签名，0 存量调用方受影响**（BEL-93 影响面结论见 §9）。
- 响应：单个 PeriodItem；无周期 → 404 `RESOURCE_NOT_FOUND`。

### R3 周期概览 — `GET /api/v1/agent/account-health/periods/{period_id}/overview`

- 参数：`period_id`（路径）；无其它查询参数。
- 复用：`inspection_service.get_overview`（纯读）→ 逐店行拍平（§7.3 字段）；按 `project_scope` 过滤 items。
- 响应：`{ ok, data: { period, items: [ProjectReportRow], total_projects, submitted_count, overdue_count } }`。
- 周期不存在 → 404 `RESOURCE_NOT_FOUND`。

### R4 单店报告明细 — `GET /api/v1/agent/account-health/periods/{period_id}/projects/{project_id}`

- 参数：`period_id`、`project_id`（路径）；`include_summary`（可选，`status_summary` 默认不返回，`=true` 才返回）。
- 复用：`inspection_service.get_report`（纯读）+ `project_service.ensure_project_access` 语义 → 项目不在凭据范围 → 404。
- 响应：单个报告行（§7.3 字段 + `status_summary?`）；无报告 → 404 `RESOURCE_NOT_FOUND`。

### R5 历史趋势 — `GET /api/v1/agent/account-health/history`

- 参数：`period_id` / `project_id`（可选筛选）、`limit`（默认 50，≤200）、`offset`、`order_by` / `order_dir`。
- `order_by` 白名单：`week_start` / `project_name` / `account_health_rating` / `compliance_total` / `submitted_at`（+ 各数值健康/合规列，实现时逐列枚举，非法值 → 400 `VALIDATION_FAILED`）。
- 复用：`/api/v1/inspections/history` 同构查询（拍平 + `compliance_total` 派生）→ 按 `project_scope` 过滤。
- 响应：`{ ok, data: { items: [HistoryRow], total } }`。

### 公共约定（对齐 agent-api-design v0.7）

- 鉴权：Bearer + `X-Agent-Id`（`require_agent_credential`，命名空间默认）+ 读限流（`require_agent_read_rate_limit`）。
- 响应壳：`agent_ok` → `{ ok: true, data: ... }`；错误走 `app/api/agent/errors.py`（`VALIDATION_FAILED` 400 / `RESOURCE_NOT_FOUND` 404 / `AGENT_PROJECT_OUT_OF_SCOPE` 403；**无新增错误码**）。
- **不暴露**：raw JSON（`health_data` / `compliance_data` 原始 blob）、截图 presigned URL（如需要只给 `screenshot_count`）、`status_summary`（默认，`include_summary=true` 可选）。

## 7. 必要元素定稿（逐端点字段）

### 7.1 通用行结构（R3/R4/R5 共用「拍平事实行」）

```
period_id · week_start · week_end · project_id · project_name · status · submitted_at
# 账户健康 8（health_data）
account_health_rating · negative_feedback · a2z_claims · chargeback_claims
late_shipment_rate · pre_fulfillment_cancel_rate · valid_tracking_rate · on_time_delivery_rate
# 合规分类 10（compliance_data）
ip_infringement · ip_complaints · product_authenticity_complaints · product_condition_complaints
food_product_safety · listing_policy_violations · restricted_product_violations
review_policy_violations · other_policy_violations · regulatory_compliance
# 派生 1
compliance_total          # 10 项合规计数求和（口径与内部 overview / history 一致）
```

### 7.2 R1/R2 周期项

`period_id` · `week_start` · `week_end` · `deadline`（R1 可附 `submitted_count`，供 Agent 快速判断周完成度）。

### 7.3 R3 概览行 / R4 明细 / R5 历史行

- R3：§7.1 行 + `screenshot_count`（可选）；`status_summary` 不带。
- R4：§7.1 行 + `status_summary?`（`include_summary=true`）+ `screenshot_count`。
- R5：§7.1 行子集（对齐现有 `InspectionHistoryItem`：context + `account_health_rating` + `compliance_total` + `submitted_at` + `screenshot_count`），可带 `screenshots` 摘要（`screenshot_count` 而非 URL）。

### 7.4 空值语义（D4）

- 未填写的数值字段 → `null`（**不是 0**）：`null` 表示「本周未录入」，`0` 表示「录入为 0」。
- `compliance_total`：全部为 null / 空 → `null`（内部口径同）。
- 空结果（无匹配行）→ **200** + 空 `items`（不是 404）；只有「资源本身不存在」（周期 / 项目 / 报告）→ 404。

## 8. 测试清单（供 S3 实施）

1. **R2 纯读函数**：无周期 → 404；有周期 → 返回当前周期；**不产生新行**（断言 `inspection_periods` 行数不变）。
2. **R3**：period 不存在 404；items 按 `project_scope` 过滤；空值 null 非 0；`compliance_total` 口径与内部 overview 一致。
3. **R4**：无报告 404；`include_summary` 默认不带 / `=true` 带；项目不在凭据范围 404。
4. **R5**：分页；`order_by` 白名单非法值 400 `VALIDATION_FAILED`；按 period / project 筛选；scope 过滤。
5. **壳与错误码**：未鉴权 401 壳；限流 429；所有错误均走统一错误壳。
6. **路由注册**：`agent/__init__.py` 兜底路由之前注册（新路由不被吞成 404）。
7. **regression**：内部 `/api/v1/inspections/*` 9 端点行为不变（R2 新增纯读函数不改 `get_or_create_current_period`）。

## 9. 影响面结论（BEL-93，CodeGraph 核实）

- `inspection_service`：R2 需**新增**纯读函数（不改 `get_or_create_current_period` 签名与行为）；其余 R1/R3/R4/R5 直接复用现有 `list_periods` / `get_overview` / `get_report` / history 查询——**0 存量调用方受影响**（CodeGraph callers 核实上述函数仅被 `inspections.py` 内部端点调用）。
- `agent/__init__.py`：追加一个 `include_router`（必须插在兜底路由之前）——纯增量。
- `agent_api_keys.business_scope`：新增取值 `account_health`，字符串列无需迁移。
- 前端 `lib/agent-domains.ts`：S4 注册表加一条（`status: 'live'` 在 S3 合入后）——纯增量。

## 10. 阶段规划（BLF-547 S2–S4）

| 阶段 | issue | 结论 / 范围 |
|---|---|---|
| **S2 数据底座** | BLF-548 | 按 D1 **缩水为「确认零新增」**：复用现有巡检数据，无新表 / 无迁移；产出「数据局限文档」（现状覆盖 vs SP-API 可采差异，即 §4.3 表落地） |
| **S3 实施** | BLF-550 | 照 §6 端点 + §8 测试清单：新增 `backend/app/api/v1/endpoints/agent/account_health.py` + 服务层纯读函数 + 壳/错误码 + 测试；不含 DB 迁移 |
| **S4 上线收尾** | BLF-551 | 前端注册表加域（`account_health`，live）+ agent-usage-guide 调用说明 + 归档 BLF-547 |

## 11. 风险与开放问题

1. **R2 建行副作用**：必须新增纯读函数而不是复用 `get_or_create_current_period`——S3 实现时以测试锁契约（行数不变）。
2. **`status_summary` 覆盖率低**（~23%）：默认不返回，`include_summary=true` 才带——避免 Agent 把低覆盖自由文本当事实。
3. **SP-API 未来接入**（L3 独立 issue）：AHR 分数 → 字符串评级映射、负面反馈条数 vs 比率口径、14 天窗口 vs 周窗口差异（§4.3）需在采集设计时拍板。
4. **`screenshot_count` 是否需要**：预留字段，默认返回（不暴露 URL）；如 Agent 无场景可在 S3 裁掉。

## 版本记录

- v0.1（2026-08-08）：S1 拍板 D1–D5，设计定稿（BLF-549）。原始文件仅存于 S1 执行工作目录；因 S1 约束「本阶段无 commit」，2026-08-09 由 BLF-547 父 issue 运行重建落库（内容依据 BLF-549 完成汇报 + 二次代码/SP-API 核实）。
