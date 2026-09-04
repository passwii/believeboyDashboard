# 后端重构修复推进计划

> 基于 `backend-refactor-master-plan.md` 的偏差分析，制定分阶段修复计划
>
> 创建日期：2026-05-13
> 当前状态：🔄 待执行
>
> **核心问题**：V2 完成了模块拆分的骨架（目录/文件创建），但质量目标未达标——大文件未瘦身、端点未瘦化、遗留兼容层未清理。

---

## 偏差清单（回顾）

| # | 偏差 | 严重程度 | 影响 |
|---|------|----------|------|
| D1 | 超大文件(>900行)仍有 ~10 个，目标 0 个 | P0 | 可维护性差 |
| D2 | 最大 Service 文件 1407 行，目标 <600 行 | P0 | 违反质量红线 |
| D3 | 4 个 endpoint 文件未瘦化（854/759/757/650 行） | P0 | 端点层臃肿 |
| D4 | `services/financial/` 遗留 3 行桩文件 + payment_report.py 未合并 | P1 | 混乱 |
| D5 | 9 个遗留单文件模块未清理 | P2 | 技术债 |
| D6 | 无 deprecation warning 向后兼容策略 | P2 | 迁移不安全 |
| D7 | V2-12/V2-13（normalize_country/常量复用）未开始 | P3 | 重复代码 |
| D8 | `backend-refactor-plan-v2.md` 不存在 | P3 | 文档缺失 |

---

## 修复推进计划

### 总原则
- **每个阶段独立可提交**，原子化小步推进
- **每个阶段后运行 `pytest tests/`** 确保不引入回归
- **优先处理 P0 项**（大文件瘦身）

---

### 阶段 0：清理环境（预估 30 min）

**目标**：删除无意义的桩文件，建立 deprecation 基础设施

| 任务 | 文件 | 操作 |
|------|------|------|
| 0.1 | `services/financial/accounting.py` | 删除（3行 TODO 桩） |
| 0.2 | `services/financial/commission.py` | 删除（3行 TODO 桩） |
| 0.3 | `services/financial/financial_series.py` | 删除（3行 TODO 桩） |
| 0.4 | `services/financial/monthly_report.py` | 删除（3行 TODO 桩） |
| 0.5 | `services/financial/__init__.py` | 删除或清空 |
| 0.6 | `services/financial/payment_report.py` | 内容合并至 `services/payment/` 中对应模块，或确认 payment/ 已覆盖后删除 |
| 0.7 | 创建 `services/deprecated.py` | 集中存放 deprecation 警告 helper |

```python
# services/deprecated.py
import warnings

def warn_deprecated(old_module: str, new_module: str) -> None:
    warnings.warn(
        f"{old_module} is deprecated. Use {new_module} instead.",
        DeprecationWarning,
        stacklevel=2,
    )
```

**验收**：`services/financial/` 目录为空或只剩 `__init__.py`，1397 个测试通过。

---

### 阶段 1：瘦身 system_service.py（预估 2-3h）

**现状**：1407 行，包含系统管理 + 佣金管理两大块

**分析**（根据 grep 结果）：
- 行 1-730：系统管理相关函数
- 行 731+：佣金相关函数（`upsert_commission_records`, `update_commission_payment_status`, `get_commission_yearly_monthly_summary` 等）

**拆分方案**：

```
services/system_management/
├── __init__.py
├── system.py           # 原 system_service.py 行 1-730
└── commission.py       # 原 system_service.py 行 731+
```

**步骤**：
1. 1.1 读取 `system_service.py` 全文，在行 731 处切开
2. 1.2 创建 `services/system_management/` 目录
3. 1.3 将前半部分（系统管理）移入 `system.py`
4. 1.4 将后半部分（佣金管理）移入 `commission.py`
5. 1.5 创建 `__init__.py` 统一导出
6. 1.6 在原 `system_service.py` 中添加 deprecation 警告 + re-export
7. 1.7 更新所有 import 引用（`grep -rn "from app.services.system_service"`）
8. 1.8 运行测试

**影响范围**：
- `app/api/v1/endpoints/system_management.py` — 导入路径变更
- `app/api/v1/endpoints/users.py` — 如果导入了 system_service

**验收标准**：
- [ ] system_service.py 标记为 deprecated
- [ ] 新目录 `system_management/` 下两个文件均 <600 行
- [ ] 1397 个测试全部通过

---

### 阶段 2：瘦身 category/analytics.py（预估 2h）

**现状**：1233 行

**分析**（根据 grep 结果）：
- 行 1-1046：数据集加载/准备相关函数
- 行 1047+：`_build_*` 系列分析构建函数（10 个 build 函数）

**拆分方案**：

```
services/category/
├── dataset.py           # 已存在 - 数据集管理
├── dataset_parsers.py   # 已存在
├── product_detail.py    # 已存在
├── sales_trend.py       # 已存在
├── analytics.py          # 瘦身后的 analytics（行 1-1046）
└── insight.py           # 新增 - 分析构建逻辑（行 1047+）
```

**步骤**：
2.1 将行 1047-1233 的 `_build_*` 函数移入新的 `insight.py`
2.2 在原文件中添加 deprecation 警告 + re-export
2.3 更新端点层导入
2.4 运行测试

**验收标准**：
- [ ] analytics.py < 600 行
- [ ] 新 insight.py 文件存在，包含 10 个 build 函数
- [ ] 测试全部通过

---

### 阶段 3：瘦身 product/analysis.py（预估 2h）

**现状**：1149 行

**分析**（根据 grep 结果）：
- 行 47-150：`_build_active_product_costs_df`, `_list_recomputable_weekly_period_sources`
- 行 151-559：`list_weekly_product_analysis_from_details`, `_list_history_weekly_period_sources`
- 行 560+：`check_product_calculation_data_availability`, `recompute_*`, `run_product_calculation_from_history`

**拆分方案**：

```
services/product/
├── analysis.py           # 瘦身 - 核心分析逻辑（保留部分）
├── computation.py         # 新增 - 计算/重算逻辑（原行 560+）
└── history.py            # 新增 - 历史数据处理（原行 151-559）
```

**步骤**：
3.1 将重计算函数（行 560+）移入 `computation.py`
3.2 将历史列表函数（行 151-559）移入 `history.py`
3.3 瘦身后的 analysis.py 保留行 1-149
3.4 添加 deprecation 警告
3.5 更新导入
3.6 运行测试

**验收标准**：
- [ ] analysis.py < 600 行
- [ ] 新增 computation.py (~350行) 和 history.py (~410行)
- [ ] 测试全部通过

---

### 阶段 4：瘦身 category/dataset.py（预估 2h）

**现状**：1089 行

**分析**：
- 行 1-708：数据集初始化/加载逻辑
- 行 709+：`build_*` 系列函数

**拆分方案**：

```
services/category/
├── dataset.py            # 瘦身 - Dataset 类定义
└── dataset_builders.py   # 新增 - build_* 系列函数
```

**步骤**：
4.1 将行 709+ 的 builder 函数移入 `dataset_builders.py`
4.2 添加 deprecation 警告
4.3 更新导入
4.4 运行测试

**验收标准**：
- [ ] dataset.py < 600 行
- [ ] 新 dataset_builders.py ~400 行
- [ ] 测试全部通过

---

### 阶段 5：端点瘦化 - product_analysis.py（预估 3-4h）

**现状**：854 行 endpoint 文件

**分析**：该 endpoint 包含了大量业务逻辑和序列化代码，应迁移至 `services/product/`

**迁移内容**：
- `WEEKLY_SUMMARY_*` 常量 → `services/product/constants.py`
- `_to_float`, `_safe_div` 工具函数 → `services/shared/math_utils.py`
- 序列化逻辑 → `services/product/serialization.py`（扩展已有文件）
- endpoint 瘦身为纯路由 + 参数校验 + 服务调用

**步骤**：
5.1 提取 `WEEKLY_SUMMARY_*` 常量到 `services/product/constants.py`
5.2 提取 `_to_float`, `_safe_div` 到 `shared/math_utils.py`
5.3 提取序列化逻辑到 `services/product/serialization.py`
5.4 瘦化 endpoint 至 <300 行
5.5 添加 deprecation 警告到原 endpoint
5.6 运行测试

**验收标准**：
- [ ] `product_analysis.py` endpoint < 300 行
- [ ] 常量和工具函数已迁移
- [ ] 测试全部通过

---

### 阶段 6：端点瘦化 - shipment_schedules.py（预估 3-4h）

**现状**：759 行 endpoint 文件

**迁移内容**：
- `_date_text`, `_serialize_schedule_list_item` → `services/shipment/serialization.py`
- CSV 导入/导出逻辑 → `services/shipment/csv_parser.py`（已有，扩展）

**步骤**：
6.1 将序列化函数迁移至 `services/shipment/serialization.py`
6.2 将 CSV 逻辑迁移至 `services/shipment/csv_parser.py`
6.3 瘦化 endpoint
6.4 运行测试

**验收标准**：
- [ ] `shipment_schedules.py` endpoint < 300 行
- [ ] 测试全部通过

---

### 阶段 7：端点瘦化 - ai_insight.py + product_costs.py（预估 3-4h）

**现状**：757 行 / 650 行

**迁移内容**：
- `ai_insight.py` → 聚合逻辑迁移至 `services/ai/`（可扩展已有的 ai_insight_aggregator.py，或新建 insight.py）
- `product_costs.py` → 业务逻辑迁移至 `services/data/product_cost/`

**步骤**：
7.1 为 ai_insight 创建 `services/ai/insight.py`，迁移聚合逻辑
7.2 瘦化 ai_insight.py endpoint
7.3 将 product_costs 业务逻辑迁移至 `services/data/product_cost/` 已有模块
7.4 瘦化 product_costs.py endpoint
7.5 运行测试

**验收标准**：
- [ ] 两个 endpoint 均 < 300 行
- [ ] 测试全部通过

---

### 阶段 8：向后兼容策略落地（预估 1h）

**目标**：所有已废弃文件添加 DeprecationWarning

**操作清单**：

| 文件 | 废弃后指向 |
|------|-----------|
| `services/ad_analysis_service.py` (585行) | `services/ad/` |
| `services/product_analysis_source_service.py` (144行) | `services/product/` |
| `services/monthly_report_service.py` (65行) | `services/report/` |
| `services/shipment_schedule_service.py` (290行) | `services/shipment/` |
| `services/category_research_service.py` (114行) | `services/category/` |
| `services/inventory_replenishment_service.py` (719行) | `services/inventory/` |
| `services/ai_chat_service.py` (1290行) | `services/ai/` |
| `services/ad_upload_service.py` (1255行) | `services/ad/upload/` |
| `services/product_cost_service.py` (1205行) | `services/data/product_cost/` |
| `services/return_analysis_service.py` (1155行) | `services/analysis/return_analysis/` |
| `services/daily_analysis_service.py` (900行) | `services/daily/` |
| `services/report_upload_service.py` (891行) | `services/data/upload/` |
| `services/redis_service.py` (615行) | `services/infra/` |

每个文件头部添加：
```python
import warnings
warnings.warn(
    "This module is deprecated. Use 'app.services.{new_module}' instead.",
    DeprecationWarning,
    stacklevel=2,
)
```

然后重新导出新模块的内容，保持向后兼容。

**验收标准**：
- [ ] 所有 13 个废弃文件添加 deprecation 警告
- [ ] 导入旧路径仍然可用（不会报错中断）
- [ ] 测试全部通过

---

### 阶段 9：剩余遗留文件清理（预估 1h）

**目标**：清理 `services/` 根目录下的 9 个遗留单文件模块

| 文件 | 行数 | 处理方案 |
|------|------|---------|
| `exchange_rate_service.py` (316行) | 检查是否有 endpoint 仍导入 → 迁移至对应子包或废弃 |
| `job_service.py` (72行) | 检查导入 → 迁移或废弃 |
| `ai_file_upload_service.py` (244行) | 检查导入 → 迁移至 `services/ai/` 或废弃 |
| `rate_limit_service.py` (103行) | 检查导入 → 迁移至 `services/infra/` 或废弃 |
| `rpa_report_service.py` (262行) | 检查导入 → 迁移至 `services/tools/rpa/` 或废弃 |
| `audit_log_service.py` (146行) | 检查导入 → 迁移至 `services/system_management/` |
| `shop_calculation_service.py` (283行) | 检查导入 → 迁移或废弃 |
| `upload_service.py` (203行) | 检查导入 → 迁移至 `services/data/upload/` |
| `ai_insight_aggregator.py` (593行) | 检查导入 → 迁移至 `services/ai/` |

**步骤**：
9.1 逐一 `grep -rn "from app.services.<name>" app/` 检查消费者
9.2 有消费者的 → 添加 deprecation 警告 + 重定向 import
9.3 无消费者的 → 直接删除
9.4 每次删除后运行测试

**验收标准**：
- [ ] `services/` 根目录不再有遗留单文件模块（`__init__.py` 除外）
- [ ] 测试全部通过

---

### 阶段 10：V2-12/V2-13 收尾（预估 1h）

- **V2-12 normalize_country 统一**：grep 搜索所有 `normalize_country` 的调用和定义，统一到一个位置
- **V2-13 常量复用**：扫描各 services 子包，提取重复定义的常量到 `services/constants.py`

---

## 各阶段完成后预期指标

| 阶段 | 完成后最大文件 | 完成后平均文件 | 超大文件数(>900) |
|------|---------------|---------------|-----------------|
| 阶段 0 | ~1407 | ~312 | ~10 |
| 阶段 1 | ~1233 | ~280 | ~9 |
| 阶段 2 | ~1149 | ~260 | ~8 |
| 阶段 3 | ~1089 | ~240 | ~7 |
| 阶段 4 | ~868 | ~180 | ~3 |
| 阶段 5-7 | <800 | ~150 | **0** ✅ |
| 阶段 8-10 | <800 | <250 ✅ | **0** ✅ |

---

## 实施顺序总览

```
Phase 0  ████░░░░░░░░░░░░░  30min   清理桩文件 + deprecation 基础设施
Phase 1  █████████░░░░░░░░  2-3h    瘦身 system_service.py (1407行)
Phase 2  █████████░░░░░░░░  2h      瘦身 category/analytics.py (1233行)
Phase 3  █████████░░░░░░░░  2h      瘦身 product/analysis.py (1149行)
Phase 4  █████░░░░░░░░░░░░  2h      瘦身 category/dataset.py (1089行)
Phase 5  █████████░░░░░░░░  3-4h    瘦化 product_analysis endpoint
Phase 6  █████████░░░░░░░░  3-4h    瘦化 shipment_schedules endpoint
Phase 7  █████████░░░░░░░░  3-4h    瘦化 ai_insight + product_costs endpoints
Phase 8  ███░░░░░░░░░░░░░░  1h      全部废弃文件添加 DeprecationWarning
Phase 9  ███░░░░░░░░░░░░░░  1h      清理 9 个遗留单文件模块
Phase 10 █░░░░░░░░░░░░░░░  1h      normalize_country + 常量复用
```

**总预估时间：20-26 小时（分 2-3 天完成）**

---

## 风险控制

| 风险 | 缓解措施 |
|------|----------|
| 拆分后测试失败 | 每个阶段后立即运行 `pytest`，失败则回滚该阶段 |
| 遗漏 import 路径变更 | 使用 `grep -rn "from app.services"` 全量检查 |
| 循环导入 | 拆分前先画依赖图，`services/product/__init__.py` 不 import 子模块 |
| 遗漏废弃文件消费者 | 阶段 8 的 grep + 阶段删除前二次确认 |

---

## 验收总清单（全部完成后）

- [ ] 测试 ≥ 1178 个且全部通过
- [ ] 最大 Service 文件 < 600 行
- [ ] 平均 Service 文件 < 250 行
- [ ] 所有 endpoint 文件 < 300 行
- [ ] 超大文件(>900行) = 0 个
- [ ] 所有废弃文件有 deprecation warning
- [ ] `backend-refactor-plan-v2.md` 已创建并更新
- [ ] `backend-refactor-master-plan.md` 进度更新到 100%