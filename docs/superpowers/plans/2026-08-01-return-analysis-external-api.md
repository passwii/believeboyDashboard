# Return Analysis External API — 实施方案（v1.0，2026-08-01 拍板）

> 历经 3 轮 BEL-372 讨论后定稿。属于 BEL-372 的"Return Analysis 子项"实施计划。
> 完整讨论过程见 BEL-372 评论链（thread `698b23be-...`）。

---

## 0. 目标

把现有**内部** `/api/v1/return-analysis` 端点扩展为：

1. 数据层新增**聚合快照表** `analysis_return_aggregates`（每日 03:00 UTC Celery 跑一次）
2. 端点改造为"先查快照 → fallback 现场跑"的双段式架构
3. 暴露 `/api/v1/external/projects/{id}/return-analysis[-raw]` 两个 GET 端点
4. 引入 `risk_level`（critical / warning / normal / no_data），用 **Wilson 置信区间下界** 解决小样本噪声问题

---

## 1. 已拍板决策

| # | 决策 | 取值 | 备注 |
|---|---|---|---|
| 1 | 预处理范围 | A（聚合快照）+ C（risk_level） | B（反馈聚类）/ D（推荐补货动作）留二期 |
| 2a | Celery 刷新频率 | 每日 03:00 UTC | 不做 6h |
| 2b | Celery 是否需 AI | **否** | 纯 SQL + Python |
| 3 | `estimated_loss_amount` 字段 | **不写字段** | 选项 1（最简）；P1 基建加 scope 时再补 |
| 4a | 阈值 | Critical ≥ 10% / Warning ≥ 6% | 用户拍板 |
| 4b | risk_level 算法 | **Wilson 95% 置信区间下界** + 最小销量门槛 **15** | 用户拍板（30 → 15） |
| 4c | 主窗口 | **30d**（与 `_build_summary_text` 对齐） | 7d / 90d 作趋势参照 |
| 5 | 范式升级 | 暂不推广 | 跑通 Return Analysis 2 周后复盘 |

---

## 2. 数据层

### 2.1 新表 `analysis_return_aggregates`

```sql
CREATE TABLE analysis_return_aggregates (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    country VARCHAR(2) NOT NULL,
    sku VARCHAR(100) NOT NULL,
    asin VARCHAR(20),
    data_date DATE NOT NULL,                          -- 退货日期（PT）
    return_count INTEGER NOT NULL DEFAULT 0,          -- 退货单数
    return_quantity INTEGER NOT NULL DEFAULT 0,       -- 退货件数
    sales_quantity INTEGER NOT NULL DEFAULT 0,        -- 同期销售件数（join）
    return_rate NUMERIC(6,3) NOT NULL DEFAULT 0,      -- return_quantity / sales_quantity * 100
    cycle_avg_days NUMERIC(6,2),                      -- 平均退货周期
    cycle_min_days INTEGER,                            -- 最快退货周期
    cycle_max_days INTEGER,                            -- 最慢退货周期
    reason_top1 VARCHAR(100),                          -- 当日首要退货原因
    reason_top1_pct NUMERIC(5,2),                      -- 占比
    reason_top1_display VARCHAR(64),                   -- 翻译后
    disposition_top1 VARCHAR(50),                      -- 当日首要处置
    disposition_top1_display VARCHAR(64),              -- 翻译后
    dominant_fc_id VARCHAR(20),                        -- 退货最多的仓库
    risk_level VARCHAR(16) NOT NULL DEFAULT 'normal',  -- critical/warning/normal/no_data
    wilson_lower NUMERIC(6,3),                         -- Wilson 95% 下界（便于 audit）
    data_version INTEGER NOT NULL DEFAULT 1,
    computed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_return_agg_project_country_sku_date
        UNIQUE (project_id, country, sku, data_date)
);

CREATE INDEX idx_return_agg_project_date
    ON analysis_return_aggregates (project_id, data_date);
CREATE INDEX idx_return_agg_project_sku_date
    ON analysis_return_aggregates (project_id, sku, data_date);
CREATE INDEX idx_return_agg_risk
    ON analysis_return_aggregates (project_id, country, risk_level, data_date);
```

**字段集合**（主 risk_level 用 30d 滚动窗，所以 `data_date` 是**单日**而不是**整周期**，endpoint 查询时按 `data_date BETWEEN start AND end` 聚合）：

### 2.2 新常量 `backend/app/constants/return_thresholds.py`

```python
"""退货分析阈值常量（从 _build_summary_text 抽取）"""

# 最小销量门槛：低于此销量不下 risk_level（避免小样本噪声）
MIN_SALES_FOR_RISK_LEVEL = 15

# Wilson 95% 置信区间下界阈值
WILSON_CRITICAL_THRESHOLD = 10.0  # ≥ 10% → critical
WILSON_WARNING_THRESHOLD = 6.0     # ≥ 6% → warning

# 行业基线（与 _build_summary_text 对齐，备查）
APPAREL_INDUSTRY_LOW = 3.0
APPAREL_INDUSTRY_HIGH = 8.0
GENERAL_RETAIL_BASELINE = 5.0

# Wilson 公式系数
WILSON_Z = 1.96  # 95% 置信
```

### 2.3 新增 `wilson_lower_bound()` 工具函数

放在 `backend/app/utils/stats.py`（新文件，复用风险）：

```python
def wilson_lower_bound(successes: int, trials: int, z: float = 1.96) -> float:
    """Wilson 95% 置信区间下界（百分比形式）。

    卖 2 退 1 → ~0.6%（不误报）
    卖 100 退 10 → ~4.6%
    卖 1000 退 100 → ~8.0%
    卖 10 退 5 (50%) → ~21.7%
    """
    if trials <= 0:
        return 0.0
    p = successes / trials
    denom = 1 + z * z / trials
    center = (p + z * z / (2 * trials)) / denom
    margin = z * math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials)) / denom
    return max(0.0, (center - margin) * 100)
```

### 2.4 新增 Celery 任务 `backend/app/celery_tasks/return_analysis_refresh.py`

```python
@shared_task(name="return_analysis.refresh_daily")
def refresh_return_aggregates(target_date: date | None = None) -> dict:
    """每日 03:00 UTC 跑近 90 天增量。target_date 留 None 时跑昨天。"""
    ...
```

- 调度：复用 `backend/app/core/scheduler.py` 的 `BackgroundScheduler`（已有）
- 增量策略：处理近 90 天的 `analysis_return_rows`（用 `return_date >= today - 90 days`）
- 失败重试：Celery 任务 `max_retries=3, retry_backoff=True`
- 失败回退：endpoint 检测 `data_version` 时间戳，超过 25h 走原 `build_return_analysis()` 路径
- 手动触发：暴露 `POST /api/v1/internal/jobs/return-analysis-refresh`（仅 admin）

---

## 3. Service 层改造

### 3.1 新增 `build_return_analysis_from_snapshot()`

放在 `backend/app/services/analysis/return_analysis/analysis.py`（与 `build_return_analysis()` 同文件，便于校对）：

```python
def build_return_analysis_from_snapshot(
    db: Session,
    *,
    project_id: int,
    country: str,
    start_date: date,
    end_date: date,
    sku: str | None = None,
) -> ReturnAnalysisResponse:
    """从 analysis_return_aggregates 物化表读 + endpoint 维度再聚合。
    
    与 build_return_analysis() 输出 schema 完全一致（保证外部调用方无感切换）。
    """
    ...
```

### 3.2 改 `internal/return_analysis.py`

```python
# 现有 Redis 缓存保留，但 key 改为：
key = f"return_analysis:v2:{project_id}:{country}:{start_date}:{end_date}:{sku}"

# 读：
cached = get_return_analysis_cache(...)
if cached is not None:
    return ReturnAnalysisResponse(**cached)

# 检查快照是否最新
if is_snapshot_fresh_for_range(db, project_id, country, start_date, end_date):
    result = build_return_analysis_from_snapshot(...)
else:
    # Celery 失败 / 首次跑 / 数据未覆盖 → fallback 现场算
    result = build_return_analysis(...)

# 写缓存（5 分钟）
set_return_analysis_cache(...)
```

### 3.3 risk_level 计算

放在 Celery 任务内（不是 endpoint 现场算）：

```python
def _compute_risk_level(return_quantity: int, sales_quantity: int) -> tuple[str, float]:
    if sales_quantity < MIN_SALES_FOR_RISK_LEVEL:
        return "no_data", 0.0
    wilson = wilson_lower_bound(return_quantity, sales_quantity)
    if wilson >= WILSON_CRITICAL_THRESHOLD:
        return "critical", wilson
    if wilson >= WILSON_WARNING_THRESHOLD:
        return "warning", wilson
    return "normal", wilson
```

### 3.4 趋势字段（`risk_trend`）

endpoint 查询时根据 `data_date` 序列算（7d 趋势 vs 30d 主）：

- `improving` : 7d 较 30d 显著下降（差 ≥ 2 个百分点）
- `degrading` : 7d 较 30d 显著上升
- `stable` : 其余
- `unclear` : 任一窗口 sales_quantity < 15

---

## 4. External API

### 4.1 路由

```
GET /api/v1/external/projects/{project_id}/return-analysis
GET /api/v1/external/projects/{project_id}/return-analysis-raw
```

挂在现有 `external_router` 下，无新鉴权 / 限流 / 审计（P0 与 ad 端口一致）。P1 基建 sub-issue 处理。

### 4.2 Query 参数

```
?period=7d|14d|30d|60d|90d|this_month|last_month|ytd|custom
?country=US|DE|UK|...         # 必填
?start_date=YYYY-MM-DD         # period=custom
?end_date=YYYY-MM-DD           # period=custom
?sku=SKU-001                   # 可选子串
?min_return_rate=5.0           # 可选，仅返回 ≥ X% 的 SKU
?risk_level=critical|warning   # 可选过滤
?limit=50                      # 默认 50，1~500
?offset=0
?order_by=return_count|return_quantity|return_rate|cycle_avg_days|wilson_lower|risk_level
?order_dir=asc|desc
```

### 4.3 响应 shape（`/return-analysis`）

```json
{
  "project_id": 1,
  "project_name": "MyProject",
  "country": "US",
  "period": {
    "type": "relative",
    "value": "30d",
    "start_date": "2026-07-01",
    "end_date": "2026-07-31"
  },
  "summary": {
    "total_return_count": 287,
    "total_return_quantity": 412,
    "total_sales_quantity": 5840,
    "overall_return_rate": 7.05,
    "overall_risk_level": "warning",
    "top_return_sku": "SKU-001",
    "top_return_reason_display": "与描述不符",
    "unique_skus": 23,
    "multi_item_return_count": 18
  },
  "summary_text": "📊 退货概况（...）\n⚠️ 高退货 SKU（...）\n...",
  "items": [
    {
      "sku": "SKU-001",
      "asin": "B0000001",
      "product_name": "Product A",
      "return_count": 47,
      "return_quantity": 68,
      "sales_quantity": 520,
      "return_rate": 13.08,
      "wilson_lower": 10.12,
      "cycle_avg_days": 12.4,
      "cycle_min_days": 2,
      "cycle_max_days": 41,
      "reason_top1_display": "与描述不符",
      "reason_top1_pct": 42.6,
      "disposition_top1_display": "可售",
      "dominant_fc_id": "PHX6",
      "risk_level": "critical",
      "risk_trend": "degrading",
      "first_return_date": "2026-07-03",
      "last_return_date": "2026-07-29"
    }
  ],
  "trend_rows": [...],
  "reason_rows": [...],
  "disposition_rows": [...],
  "fulfillment_center_rows": [...],
  "weekday_rows": [...]
}
```

### 4.4 响应 shape（`/return-analysis-raw`）

```json
{
  "project_id": 1,
  "country": "US",
  "period": { ... },
  "data": [
    {
      "id": 12345,
      "return_date": "2026-07-15",
      "order_id": "111-2222222-3333333",
      "sku": "SKU-001",
      "asin": "B0000001",
      "product_name": "Product A",
      "quantity": 2,
      "fulfillment_center_id": "PHX6",
      "detailed_disposition": "SELLABLE",
      "disposition_display": "可售",
      "reason": "NOT_AS_DESCRIBED",
      "reason_display": "与描述不符",
      "status": "PROCESSED",
      "status_display": "已处理",
      "original_return_datetime": "2026-07-15T10:23:00+00:00"
    }
  ],
  "summary": {
    "total_rows": 287,
    "date_range": ["2026-07-01", "2026-07-31"]
  }
}
```

**剔除字段**：`raw_row` JSON（永远不返回）、`customer_comments`（永远不返回，因为含客户隐私）

### 4.5 列白名单

加在 `backend/app/api/v1/endpoints/external/_whitelist.py`：

```python
# ROW_WHITELIST 增量
AnalysisReturnRow: _whitelist(
    id=AnalysisReturnRow.id,
    return_date=AnalysisReturnRow.return_date,
    order_id=AnalysisReturnRow.order_id,
    sku=AnalysisReturnRow.sku,
    asin=AnalysisReturnRow.asin,
    product_name=AnalysisReturnRow.product_name,
    quantity=AnalysisReturnRow.quantity,
    fulfillment_center_id=AnalysisReturnRow.fulfillment_center_id,
    detailed_disposition=AnalysisReturnRow.detailed_disposition,
    reason=AnalysisReturnRow.reason,
    status=AnalysisReturnRow.status,
    original_return_datetime=AnalysisReturnRow.original_return_datetime,
)

# AGG_WHITELIST 增量（用于 /return-analysis 聚合端点 + 7d/30d/90d 窗口查询）
AnalysisReturnAggregate: _agg_whitelist(
    sku=AnalysisReturnAggregate.sku,
    return_count=AnalysisReturnAggregate.return_count,
    return_quantity=AnalysisReturnAggregate.return_quantity,
    sales_quantity=AnalysisReturnAggregate.sales_quantity,
    return_rate=AnalysisReturnAggregate.return_rate,
    wilson_lower=AnalysisReturnAggregate.wilson_lower,
    cycle_avg_days=AnalysisReturnAggregate.cycle_avg_days,
    cycle_min_days=AnalysisReturnAggregate.cycle_min_days,
    cycle_max_days=AnalysisReturnAggregate.cycle_max_days,
    reason_top1=AnalysisReturnAggregate.reason_top1,
    disposition_top1=AnalysisReturnAggregate.disposition_top1,
    dominant_fc_id=AnalysisReturnAggregate.dominant_fc_id,
    risk_level=AnalysisReturnAggregate.risk_level,
)
```

---

## 5. 文件改动清单

### 5.1 新建文件

| 路径 | 行数估计 | 用途 |
|---|---|---|
| `backend/alembic/versions/YYYYMMDD_NNN_add_return_aggregates.py` | ~50 | 迁移 |
| `backend/app/models/analysis_return_aggregate.py` | ~80 | SQLAlchemy 模型 |
| `backend/app/utils/stats.py` | ~30 | Wilson 公式 |
| `backend/app/constants/return_thresholds.py` | ~30 | 阈值常量 |
| `backend/app/celery_tasks/return_analysis_refresh.py` | ~150 | 每日刷新任务 |
| `backend/app/schemas/external/return_analysis.py` | ~120 | External schema |
| `backend/app/api/v1/endpoints/external/return_analysis.py` | ~150 | External 端点 |
| `backend/app/services/external/return_analysis_query.py` | ~200 | 物化表查询 + 维度聚合 |
| `backend/tests/api/v1/endpoints/external/test_return_analysis_aggregate.py` | ~150 | API 契约测试 |
| `backend/tests/api/v1/endpoints/external/test_return_analysis_raw.py` | ~100 | raw 端点测试 |
| `backend/tests/services/analysis/return_analysis/test_wilson.py` | ~50 | Wilson 公式单测 |
| `backend/tests/celery_tasks/test_return_analysis_refresh.py` | ~80 | Celery 任务测试 |

### 5.2 修改文件

| 路径 | 改动 |
|---|---|
| `backend/app/models/__init__.py` | 导出 `AnalysisReturnAggregate` |
| `backend/app/services/analysis/return_analysis/analysis.py` | 新增 `build_return_analysis_from_snapshot()` + `_compute_risk_level()` |
| `backend/app/api/v1/endpoints/return_analysis.py` | 加快照检测 + fallback 逻辑 |
| `backend/app/services/infra/inventory_cache.py` | 缓存 key 加 `v2` |
| `backend/app/api/v1/endpoints/external/__init__.py` | 注册 `return_analysis_router` |
| `backend/app/api/v1/endpoints/external/_whitelist.py` | 加 ROW + AGG 白名单 |
| `backend/docs/external-api.md` | 加 §7 "Return Analysis"（仿 §6） |

---

## 6. 实施路径（建议拆为 2 个 sub-issue）

### 6.1 Sub-issue 1: 数据层 + 内部 endpoint 改造

- 范围：§2（数据层）+ §3（service 改造）
- 不动：External API 端点
- 验证：内部 `/return-analysis` 行为不变（对比新旧路径输出）+ 内部前端可见
- 风险：低（保留 fallback 路径）

### 6.2 Sub-issue 2: External API 暴露

- 范围：§4（External API）+ §5 的对应文件
- 依赖：Sub-issue 1 已合 main
- 验证：API 契约测试 + 文档 + `multica issue create` 创 P1 基建 sub-issue
- 风险：中（新加 namespace 路由）

### 6.3 不拆"小颗粒"的原因

- Phase C 验证（pytest + 部署）已经包含在 sub-issue 1 末尾
- Celery 任务逻辑完整在数据层内（sub-issue 1），不必单独 issue
- "每 1 周一个 issue" 颗粒度过细反而增加管理成本

---

## 7. 验收标准

### Sub-issue 1 验收

- [ ] `analysis_return_aggregates` 表迁移成功（PG 本地 + prod）
- [ ] Celery 任务每日 03:00 自动跑（手动触发也工作）
- [ ] `analysis_return_aggregates` 数据与 `build_return_analysis()` 现场算结果一致（对比脚本通过）
- [ ] 内部 `/api/v1/return-analysis` 行为不变（前端无感知）
- [ ] Redis 5 分钟缓存正常
- [ ] Celery 失败 → 走 fallback 路径
- [ ] 全部 backend pytest 通过
- [ ] 文档：`backend/docs/external-api.md` 内部章节更新（外部端点章节在 sub-issue 2）

### Sub-issue 2 验收

- [ ] `/external/projects/{id}/return-analysis` 200 OK
- [ ] `/external/projects/{id}/return-analysis-raw` 200 OK
- [ ] period / country / order_by / limit / offset / pagination 行为符合 §4.2
- [ ] 列白名单生效：未授权字段返回 400
- [ ] 风险等级：sales_quantity < 15 → `no_data`，其余按 Wilson 下界
- [ ] customer_comments / raw_row 永远不返回（用契约测试锁）
- [ ] 全部 backend pytest 通过
- [ ] `backend/docs/external-api.md §7 Return Analysis` 文档完成
- [ ] 上线后用 `multica issue create` 创 P1 通用基建 sub-issue（鉴权/限流/审计挂 `/external/*`）

---

## 8. 已知风险与回退路径

| 风险 | 触发 | 回退 |
|---|---|---|
| Celery 任务失败 | broker 断 / DB 卡 / 代码 bug | endpoint 走 `build_return_analysis()` 现场跑 + 5 分钟缓存（已保留） |
| 物化表数据漂移 | Celery 中途崩 | 下次跑增量修复 + audit log 留痕 |
| Wilson 公式被质疑 | 运营说"为什么卖 2 退 1 报 normal" | 给个 dashboard 解释（已在 `summary_text` 模板里加） |
| 性能不如预期 | 90 天 × 数千 SKU join 慢 | 缩小增量窗口到 30 天（90% 退货落在 30 天内） |
| P1 基建未做就被外部 Agent 滥用 | 没鉴权 / 限流 | 用 gateway IP 白名单（已有）+ 监控 4xx 5xx 异常 |

---

## 9. 后续

- **2 周后复盘**：Celery 任务价值、Wilson 阈值是否合适、物化表大小
- **二期候选**：B（反馈聚类）/ D（推荐补货动作）/ 把广告端口也迁移到物化表
- **P1 基建 sub-issue**：鉴权 + 限流 + 审计挂 `/external/*`（独立 issue，与本项目并行）

---

## 10. 参考

- 现状盘点 + 范式：BEL-372 评论 `698b23be-...`（规划稿）
- Return Analysis 设计稿：BEL-372 评论 `def1737e-...`（v1）
- 阈值与小样本讨论：BEL-372 评论 `560e1a89-...`（v2）
- 最终拍板：BEL-372 评论 `0a8c1028-...`（用户确认 v3）
- 仓库内参考：
  - `backend/app/api/v1/endpoints/external/ad_campaigns.py`（端点范式）
  - `backend/app/api/v1/endpoints/external/_whitelist.py`（列白名单范式）
  - `backend/app/api/v1/endpoints/external/replenishment_analysis.py`（risk_status 字段范式）
  - `backend/app/services/inventory/replenishment.py:476 _classify_risk`（风险等级判定范式）
  - `backend/app/celery_tasks/_common.py`（Celery 任务基类范式）
