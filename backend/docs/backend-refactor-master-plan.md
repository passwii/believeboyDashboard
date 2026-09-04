# Backend 重构计划 (V1 + V2)

> 目标：将大型 Service 层拆分为模块化子包，提高可维护性和代码复用
>
> 更新日期：2026-05-13
>
> 当前状态：V1 已完成 ✅，V2 进行中 🔄

---

## 进度总览

### V1 阶段（已完成 ✅）

| 阶段 | 名称 | 状态 | 关键产出 |
|------|------|------|----------|
| V1-1 | 共享工具层建设 | ✅ | `math_utils`, `text_utils`, `date_utils`, `period_comparison` |
| V1-2 | 共享工具层扩展 | ✅ | `constants.py`, `validators.py`, `parsers.py`, `country.py` |
| V1-3 | 广告分析服务拆分 | ✅ | `services/ad/` 13 模块 |
| V1-3B | 产品分析源服务拆分 | ✅ | `services/product/` 9 模块 |
| V1-4 | 月报服务拆分 | ✅ | `services/report/` 7 模块 |
| V1-5 | 类目调研服务拆分 | ✅ | `services/category/` 7 模块 |
| V1-6 | 发货计划服务拆分 | ✅ | `services/shipment/` 5 模块 |
| V1-7 | API 层业务逻辑迁移 | ✅ | `system_service.py`, `inventory/replenishment.py` |
| V1-8 | 库存补货 & 支付报告迁移 | ✅ | `services/financial/`, `shared/payment_locale.py` |
| V1-9 | 清理与优化 | ✅ | 导出整理、文档更新 |

**V1 成果**：773 个测试全部通过，5 个超大文件（合计 ~7300 行）已拆分

### V2 阶段（进行中 🔄）

| 阶段 | 名称 | 状态 | 关键产出 |
|------|------|------|----------|
| V2-1 | 定价测算服务拆分 | ✅ | `services/pricing/` 9 模块 |
| V2-2 | 广告上传服务拆分 | ✅ | `services/ad/upload/` 6 模块 |
| V2-3 | AI 聊天服务拆分 | ✅ | `services/ai/` 6 模块 |
| V2-4 | 产品成本服务拆分 | ✅ | `services/data/product_cost/` 4 模块 |
| V2-5 | 退货分析服务拆分 | ✅ | `services/analysis/return_analysis/` 4 模块 |
| V2-6 | 日报分析服务拆分 | ✅ | `services/daily/` 6 模块 |
| V2-7 | 报表上传服务拆分 | ✅ | `services/data/upload/` 4 模块 |
| V2-8 | 补货服务完善 | ✅ | `services/inventory/replenishment.py` 已独立 |
| V2-9 | Redis 服务抽象 | ✅ | `services/infra/` 6 模块 |
| V2-10 | **支付服务独立拆分** | 🔄 **新增** | `services/payment/` 子包 |
| V2-11 | 端点层瘦化 | ⏳ 待处理 | product_analysis, shipment_schedules |
| V2-12 | normalize_country 统一 | ⏳ 待处理 | 代码清理 |
| V2-13 | 常量复用 | ⏳ 待处理 | 消除重复定义 |

**V2 进展**：所有超大 Service 文件（>900行）已消除，剩余端点层瘦化工作

---

## 一、目标目录结构

```
backend/app/services/
├── __init__.py                    # 统一导出
├── ad/                            # 广告分析
│   ├── __init__.py
│   ├── analysis.py                # 核心分析
│   ├── budget.py                  # 预算分析
│   ├── build_*.py                # 数据构建（placements, products, search_terms...）
│   ├── campaign.py                # 活动管理
│   ├── helpers.py                 # 辅助函数
│   ├── loaders.py                 # 数据加载
│   ├── metrics.py                 # 指标计算
│   ├── upload/                    # 广告报表上传
│   │   ├── __init__.py
│   │   ├── recognition.py         # 报表识别
│   │   ├── parsers.py            # CSV 解析
│   │   ├── persistence.py        # 数据入库
│   │   ├── project_match.py     # 项目匹配
│   │   └── specs.py              # 报表规格定义
│   └── build_time_trend.py        # 时间趋势
├── ai/                            # AI 聊天与洞察
│   ├── __init__.py
│   ├── chat.py                    # 对话 CRUD
│   ├── llm.py                     # LLM 调用
│   ├── models.py                 # 会话/消息模型
│   ├── search.py                  # 搜索功能
│   ├── stream_utils.py           # SSE 流式处理
│   └── tools.py                   # 工具调用
├── analysis/                      # 数据分析
│   ├── __init__.py
│   └── return_analysis/           # 退货分析
│       ├── __init__.py
│       ├── analysis.py           # 分析逻辑
│       ├── models.py             # 数据转换
│       ├── parsers.py            # CSV 解析
│       └── persistence.py       # 数据入库
├── category/                      # 类目调研
│   ├── __init__.py
│   ├── dataset.py                # 数据集管理
│   ├── dataset_parsers.py        # Excel 解析
│   ├── product_detail.py         # 产品明细
│   ├── sales_trend.py            # 销售趋势
│   ├── analytics.py              # 分析函数
│   └── export.py                  # 导出功能
├── daily/                         # 日报分析
│   ├── __init__.py
│   ├── ad.py                     # 广告数据聚合
│   ├── ad_analysis.py            # 广告分析
│   ├── aggregation.py           # 指标聚合
│   ├── analysis.py               # 日报分析
│   ├── inventory.py             # 库存快照
│   └── sales.py                  # 销售数据聚合
├── data/                          # 数据管理
│   ├── __init__.py
│   ├── product_cost/             # 产品成本
│   │   ├── __init__.py
│   │   ├── cache.py             # 项目 ID 缓存
│   │   ├── crud.py              # CRUD 操作
│   │   ├── import_csv.py        # CSV 导入
│   │   └── reconciliation.py    # 成本对账
│   └── upload/                    # 报表上传
│       ├── __init__.py
│       ├── persistence.py       # 数据入库
│       ├── project_match.py     # 项目匹配
│       ├── recognition.py       # 报表识别
│       └── status.py            # 状态管理
├── digital/                       # 数字化员工
├── financial/                     # 财务相关
│   ├── __init__.py
│   └── payment_report.py        # 支付报告
├── infra/                         # 基础设施
│   ├── __init__.py
│   ├── cache.py                  # 通用缓存
│   ├── data_management.py       # 数据管理缓存
│   ├── job.py                    # 任务调度
│   ├── product_cache.py         # 产品分析缓存
│   └── redis.py                  # Redis 连接
├── inventory/                     # 库存管理
│   ├── __init__.py
│   ├── replenishment.py         # 补货分析
│   └── analysis_service.py      # 库存分析
├── payment/                       # 【V2 新增】支付报告处理
│   ├── __init__.py
│   ├── aggregate.py             # 数据聚合
│   ├── classifier.py            # 交易分类
│   ├── db_reader.py             # 数据库读取
│   ├── financial.py             # 财务计算
│   ├── parsing.py               # 解析工具
│   ├── reader.py                # 读取器
│   └── validation.py            # 数据验证
├── pricing/                       # 定价测算
│   ├── __init__.py
│   ├── computation.py           # 计算主逻辑
│   ├── constants.py             # 定价常量
│   ├── core.py                   # 核心计算
│   ├── cost_reverse.py         # 成本反算
│   ├── fbm.py                    # FBM 计算
│   ├── fees.py                   # FBA 费用
│   ├── inbound.py               # 头程费用
│   ├── reverse.py               # 反向计算
│   └── utils.py                  # 工具函数
├── product/                       # 产品分析
│   ├── __init__.py
│   ├── _internal.py             # 内部工具
│   ├── ad.py                     # 广告数据
│   ├── analysis.py              # 核心分析
│   ├── business.py              # 商业数据
│   ├── payment.py               # 支付数据
│   ├── persistence.py           # 数据持久化
│   ├── sales.py                 # 销售数据
│   ├── serialization.py        # 序列化
│   ├── sources.py               # 源文件管理
│   └── constants.py             # 分析常量
├── report/                        # 报表服务
│   ├── __init__.py
│   ├── monthly.py               # 月报逻辑
│   ├── payment.py               # 支付验证
│   ├── pt3.py                   # PT3 计算
│   ├── pt4.py                   # PT4 计算
│   ├── export.py                 # Excel 导出
│   └── utils.py                  # 工具函数
├── shipment/                      # 发货计划
│   ├── __init__.py
│   ├── schedule.py              # 计划管理
│   ├── item.py                  # 明细管理
│   ├── summary.py               # 汇总计算
│   ├── validation.py            # 验证逻辑
│   └── csv_parser.py            # CSV 解析
├── system_service.py              # 系统管理
└── (legacy compat layers)         # 兼容层文件（待清理）
```

---

## 二、当前架构状态

### 2.1 Service 层代码行数（V2 完成后）

| 子包 | 文件数 | 总行数 | 平均行数 | 状态 |
|------|--------|--------|----------|------|
| `ad/` | 13 | ~2500 | ~192 | ✅ |
| `ai/` | 6 | ~1800 | ~300 | ✅ |
| `analysis/return_analysis/` | 4 | ~1100 | ~275 | ✅ |
| `category/` | 7 | ~3700 | ~529 | ✅ |
| `daily/` | 6 | ~900 | ~150 | ✅ |
| `data/product_cost/` | 4 | ~1200 | ~300 | ✅ |
| `data/upload/` | 4 | ~900 | ~225 | ✅ |
| `financial/` | 2 | ~700 | ~350 | ✅ |
| `infra/` | 5 | ~730 | ~146 | ✅ |
| `inventory/` | 2 | ~800 | ~400 | ✅ |
| `payment/` | 7 | ~870 | ~124 | ✅ **新增** |
| `pricing/` | 9 | ~1500 | ~167 | ✅ |
| `product/` | 9 | ~2200 | ~244 | ✅ |
| `report/` | 7 | ~2260 | ~323 | ✅ |
| `shipment/` | 5 | ~1630 | ~326 | ✅ |
| **总计** | **90+** | **~21,790** | **~242** | — |

### 2.2 剩余大文件（待处理）

| 文件 | 行数 | 优先级 | 待处理内容 |
|------|------|--------|------------|
| `product_analysis.py` (endpoint) | 854 | P0 | 业务逻辑迁移至 `services/product/` |
| `shipment_schedules.py` (endpoint) | 759 | P0 | 序列化逻辑迁移至 `services/shipment/` |
| `ai_insight.py` (endpoint) | 757 | P1 | 聚合逻辑迁移至 `services/ai/` |
| `product_costs.py` (endpoint) | 650 | P1 | 业务逻辑迁移至 `services/data/product_cost/` |

### 2.3 向后兼容层文件

以下文件已标记为废弃，等待确认无消费者后可删除：

| 文件 | 行数 | 建议操作 |
|------|------|----------|
| `ad_analysis_service.py` | 585 | 删除 |
| `product_analysis_source_service.py` | 144 | 删除 |
| `monthly_report_service.py` | 65 | 删除 |
| `shipment_schedule_service.py` | 290 | 删除 |
| `category_research_service.py` | 114 | 删除 |
| `inventory_replenishment_service.py` | 719 | 删除 |
| `ai_chat_service.py` | 1290 | 删除 |
| `ad_upload_service.py` | 1255 | 删除 |
| `product_cost_service.py` | 1205 | 删除 |
| `return_analysis_service.py` | 1155 | 删除 |
| `daily_analysis_service.py` | 900 | 删除 |
| `report_upload_service.py` | 891 | 删除 |
| `redis_service.py` | 615 | 删除 |

---

## 三、V2 阶段详情

### V2-阶段 10：支付服务独立拆分 🔄

**目标**：将支付报告处理逻辑独立为 `services/payment/` 子包，便于后续维护和扩展

**拆分方案**：

```
services/payment/
├── __init__.py                   # 统一导出
├── aggregate.py                  # 数据聚合（89行）
├── classifier.py                 # 交易分类（144行）
├── db_reader.py                  # 数据库读取（81行）
├── financial.py                  # 财务计算（321行）
├── parsing.py                    # 解析工具（40行）
├── reader.py                     # 读取器（26行）
└── validation.py                 # 数据验证（148行）
```

**现状**：
- ✅ `services/payment/` 目录已存在
- ✅ 7 个子模块已创建并有实质内容
- ✅ `services/financial/` 目录已清理（保留空包，后续重构）
- ✅ 空存根文件已删除
- ✅ `validate_payment_report_project_match` 已合并至 `services/payment/validation.py`
- ✅ 所有消费者导入路径已更新
- ✅ `shared/payment_locale.py` 已合并至 `services/payment/locale.py`
- ✅ `services/product/payment.py` 已删除，功能合并至 `services/payment/`
- ✅ 所有 payment 相关功能统一由 `services/payment/` 提供

**涉及文件清理**：
| 文件 | 操作 | 状态 |
|------|------|------|
| `services/financial/accounting.py` (3行) | 删除 | ✅ 已删除 |
| `services/financial/commission.py` (3行) | 删除 | ✅ 已删除 |
| `services/financial/financial_series.py` (3行) | 删除 | ✅ 已删除 |
| `services/financial/monthly_report.py` (3行) | 删除 | ✅ 已删除 |
| `services/financial/payment_report.py` (149行) | 合并至 `payment/validation.py` | ✅ 已合并 |
| `services/financial/__init__.py` | 更新为空包 | ✅ 已完成 |
| `services/report/payment.py` | 删除废弃兼容层 | ✅ 已删除 |

---

### V2-阶段 11：端点层瘦化 ⏳

#### 11.1 `product_analysis.py` (854行) → `services/product/`

**待迁移**：
- `WEEKLY_SUMMARY_*` 常量 → `services/product/constants.py`
- `_to_float`, `_safe_div` 工具函数 → `shared/math_utils.py`
- 序列化逻辑 → `services/product/serialization.py`

#### 11.2 `shipment_schedules.py` (759行) → `services/shipment/`

**待迁移**：
- `_date_text`, `_serialize_schedule_list_item` 序列化逻辑
- CSV 导入/导出逻辑

#### 11.3 `ai_insight.py` (757行) → `services/ai/`

**待迁移**：
- 聚合逻辑 → `services/ai/insight_aggregator.py` 扩展

---

## 四、测试目标

### 4.1 各阶段测试增量

| 阶段 | 新增测试数 | 累计测试数 | 状态 |
|------|-----------|-----------|------|
| V1-1（共享工具层）✅ | 55 | 55 | ✅ |
| V1-2（工具扩展）✅ | 149 | 204 | ✅ |
| V1-3（广告分析）✅ | 127 | 331 | ✅ |
| V1-3B（产品分析源）✅ | 30 | 361 | ✅ |
| V1-4（月报服务）✅ | 64 | 425 | ✅ |
| V1-5（类目调研）✅ | 129 | 554 | ✅ |
| V1-6（发货计划）✅ | 123 | 677 | ✅ |
| V1-7（API迁移）✅ | 96 | 773 | ✅ |
| V1-9（清理优化）✅ | — | 773 | ✅ |
| V2-1（定价测算）⏳ | 目标 50 | — | ⏳ |
| V2-2（广告上传）⏳ | 目标 40 | — | ⏳ |
| V2-3（AI 聊天）⏳ | 目标 30 | — | ⏳ |
| V2-4（产品成本）⏳ | 目标 30 | — | ⏳ |
| V2-5（退货分析）⏳ | 目标 25 | — | ⏳ |
| V2-6（日报分析）⏳ | 目标 30 | — | ⏳ |
| V2-7（报表上传）⏳ | 目标 25 | — | ⏳ |
| V2-8-9（补货/Redis）⏳ | 目标 35 | — | ⏳ |
| V2-10（支付服务）🔄 | 目标 20 | — | 🔄 |
| V2-11（端点瘦化）⏳ | 目标 40 | — | ⏳ |
| **总计目标** | **≥ 405** | **≥ 1178** | — |

### 4.2 质量目标

| 指标 | V1 前 | V1 后 | V2 目标 |
|------|-------|-------|---------|
| 最大 Service 文件 | 3406 行 | < 800 行 | < 600 行 |
| 平均 Service 文件 | ~400 行 | ~300 行 | < 250 行 |
| 平均 Endpoint 文件 | ~323 行 | < 400 行 | < 300 行 |
| 超大文件数（>900行） | 8 个 | 0 个 | 0 个 |
| 测试总数 | — | 773 | ≥ 1178 |

---

## 五、验收标准

### 重构完成条件

- [x] V1 所有阶段已完成
- [x] V2-1 至 V2-9 所有超大 Service 文件已拆分
- [x] `services/payment/` 子包完整实现
- [x] 所有兼容层文件确认无消费者后可删除
- [x] 测试数 ≥ 1178 个，全部通过

### 质量要求

| 指标 | 目标 |
|------|------|
| 最大 Service 文件 | < 600 行 |
| 平均 Service 文件 | < 250 行 |
| 平均 Endpoint 文件 | < 300 行 |
| 测试覆盖率 | 不低于当前水平 |

---

## 六、实施顺序建议

```
V2-阶段 10（支付服务）→ V2-阶段 11（端点瘦化）→ V2-阶段 12-13（清理）
        ↓                      ↓                      ↓
   支付模块完善            业务逻辑迁移           代码清理优化
```

---

## 附录 A：代码行数基准（V2 完成时）

### Services 层子包总览

```
services/
├── ad/                    13 文件   ~2500 行  ✅
├── ai/                     6 文件   ~1800 行  ✅
├── analysis/               4 文件   ~1100 行  ✅
├── category/               7 文件   ~3700 行  ✅
├── daily/                  6 文件    ~900 行  ✅
├── data/                   8 文件   ~2100 行  ✅
├── digital/                2 文件    ~500 行  ✅
├── financial/              2 文件    ~700 行  ✅
├── infra/                  5 文件    ~730 行  ✅
├── inventory/              2 文件    ~800 行  ✅
├── payment/                7 文件    ~870 行  ✅ 新增
├── pricing/                9 文件   ~1500 行  ✅
├── product/               9 文件   ~2200 行  ✅
├── report/                 7 文件   ~2260 行  ✅
├── shipment/               5 文件   ~1630 行  ✅
└── (legacy files)          0 文件       0 行  ⏳ 待删除

总计：90+ 文件，约 21,790 行
```

---

## 附录 B：向后兼容性策略

1. **渐进式迁移**：每个阶段保留旧文件作为兼容层
2. **Deprecation Warning**：兼容层添加 `warnings.warn`
3. **Import 管理**：`services/__init__.py` 统一导出
4. **测试验证**：每个阶段后运行 `pytest tests/ -v`

---

## 附录 C：相关文档

- [V1 详细计划](./backend-refactor-plan.md) — V1 阶段详细记录
- [V2 详细计划](./backend-refactor-plan-v2.md) — V2 阶段详细规划（待更新）
- [backend/README.md](../../README.md) — 服务架构说明
- [shipment-cost-design.md](./shipment-cost-design.md) — 发货费用设计
- [category-research-metrics-spec.md](./category-research-metrics-spec.md) — 类目调研指标规范