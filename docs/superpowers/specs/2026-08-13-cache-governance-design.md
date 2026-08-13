# 缓存治理方案设计（缓存治理母 issue · L0/L1/L2 分层 + 写后失效强制）

> **状态**：方案定稿（用户 2026-08-13 经多轮 brainstorming 拍板）
> **范围**：`backend/app/services/infra/cache.py` + `inventory_cache.py` + `product_cache.py` 全栈缓存层；FastAPI 路由 + Celery 任务两类写端点
> **关联**：BLF-632 / BLF-633（缓存写后忘失效事故）→ 本方案根因修复
> **实施走法**：走法 A——子 issue #2 内分两阶段（先补 commission/CRM 缓存层，再加装饰器），不拆出独立子 issue

## 1. 背景与目标

### 1.1 痛点（用户原话）

> "我项目在推进的过程中呢，我可能处于无意或者有意的状态，有时候上缓存，有时候会做缓存失效机制，但是没有从一个全局的角度把它给充分的利用好。这会导致很多时候我经常会发现缓存在我不需要的时候一直保留。比如说有时候我在处理东西的时候会发现它新的东西没有生效，只能过几分钟等缓存失效。"
>
> "经常有一些需要的数据，那么需要缓存，那么缓存机制呢，有可能需要我点击某个页面才能出现，那么是不是在一些高频页我们要做一个常规的缓存，或者说定期的缓存自动更新机制等等方面要做一下设定"

提炼为两个具体目标：

- **G1 消除「等几分钟才能看到新值」**——任意写入路径必须保证对应读端点在下一次请求就拿到新值
- **G2 把高频数据「打开页面之前就准备好」**——减少「访问才触发冷计算」的等待

### 1.2 已发生过的根因（BLF-632 / BLF-633）

补货分析设置写路径（web + agent R6 双路径）commit 后**从未调用** `invalidate_inventory_replenishment_cache(project_id)`，用户保存/刷新重算后 GET analysis 最长 5 分钟返回旧值。修复方式（a72bc62c 后续）：

- 两个写端点各加一行 `invalidate_inventory_replenishment_cache(project_id)`
- 补缓存 key 加 `project:{id}` 段使失效可项目级收敛
- 加单测锁定契约

**教训**：补缓存时漏调失效 = 沉默式不生效。**纪律靠人盯不可靠，必须用机制保证**。

## 2. 设计原则

| 原则 | 含义 |
|---|---|
| **两档 TTL** | L0=4h 长 TTL + L1=5min 短 TTL，不留中间档 |
| **L0 强一致 + 装饰器强制** | 漏失效 = 测试 fail（启动期/测试期双拦截） |
| **L1 弱一致 + 短 TTL 兜底** | 漏失效 = 5 分钟自然愈合（best_effort） |
| **commit 协议** | Celery 任务在 `db.commit()` 后调 `mark_committed()`，装饰器函数返回前统一失效 |
| **域注册表驱动** | 所有失效域在 `REGISTERED_DOMAINS` 集中登记，未登记域 = 启动期 KeyError |
| **白名单 + 自动扫描双校验** | 白名单是业务契约，自动扫描是代码事实，两边必须一致 |
| **L3 基础设施独立** | `presence/session/ratelimit/semaphore` 不归本方案治理 |

## 3. 治理骨架（TL;DR）

### 3.1 三层语义对比

| 维度 | L0 强一致 | L1 弱一致 | L2 长 TTL 省 token |
|---|---|---|---|
| 目标 | 写后读立即见新值（用户期望 0 延迟） | 写后读最多等 TTL（用户容忍分钟级） | 防 LLM 重复计费 / stale prompt |
| TTL | 4h 长 TTL（兜底） | 5min 短 TTL | 4h 长 TTL |
| 失效机制 | 装饰器强制（漏失效 = 测试 fail） | 约定（漏失效 = TTL 自然愈合） | 装饰器强制（机制同 L0） |
| 漏失效后果 | 沉默式不生效（必须测试发现） | 最多等 5 分钟（可观察） | 沉默式不生效 |
| 适用数据 | 单源写、算钱、权限、配置 | 多源写、聚合报表 | LLM 类省 token 场景 |
| 写端点工程量 | 每个写端点必须装饰器声明 | 自由（加是优化，不加也不致命） | 每个写端点必须装饰器 |

### 3.2 L3 基础设施（独立维护）

`presence` / `session` / `ratelimit` / `semaphore` / `auth` — 鉴权 /限流/锁，规则完全不同（presence 短 TTL 是特性，ratelimit 短 TTL 是设计要求）。**L0/L1/L2/L3 四套独立维护**。

## 4. 完整分层总表

### 4.1 L0 强一致层（10 域）

| # | 域 | TTL | 关键理由 | 现状 |
|---|---|---|---|---|
| 1 | `inventory_replenishment` | 4h | BLF-633 教训 | ✅ 已修 |
| 2 | `data_management` | 4h | 业务核心事实 | ✅ 已有 |
| 3 | `commission_records` | 4h | 算钱 | ⚠️ **待补缓存** |
| 4 | `commission_ratio_overrides` | 4h | 比例改了下游立变 | ⚠️ 待补 |
| 5 | `commission_role_assignments` | 4h | 权限敏感 | ⚠️ 待补 |
| 6 | `commission_summary` | 4h | 聚合 | ⚠️ 待补 |
| 7 | `platform_revenues` | 4h | 财务不能错 | ✅ 已有 |
| 8 | `crm` | 4h | CRM 统一 L0（5 子域一起失效） | ⚠️ 待补 |
| 9 | `operator_performance` | 4h | 聚合（依赖 records/roles 写时级联） | ⚠️ 待盘 |
| 10 | `crm_tasks` | 4h | 跟随 CRM 统一 L0 | ⚠️ 待补 |

### 4.2 L1 弱一致层（9 域）

| # | 域 | TTL | 关键理由 | 现状 |
|---|---|---|---|---|
| 11 | `shipment_schedules` | 5min | 4 源写多源 | ✅ 已有 |
| 12 | `inventory_analysis` | 5min | 多源 | ✅ 已有 |
| 13 | `inventory_snapshot_options` | 5min | 选项列表 | ✅ 已有 |
| 14 | `return_analysis` | 5min | T+1 | ✅ 已有 |
| 15 | `sku_info` | 5min | 编辑不频繁 | ✅ 已有 |
| 16 | `report_reconciliation` | 5min | 对账分钟级 | ⚠️ 待盘 |
| 17 | `office` | 5min | 中等敏感 | ⚠️ 待盘 |
| 18 | `product_analysis` | 5min | 死代码先复活 | ⚠️ 接通死代码 |
| 19 | `monthly_financial_series` | 5min | 原 1h 改 5min | ✅ 已有 |
| 20 | `daily_analysis` | 5min | 原 2min 改 5min | ✅ 已有 |

### 4.3 L2 长 TTL 省 token 层（2 域）

| # | 域 | TTL | 关键理由 |
|---|---|---|---|
| 21 | `ai_chat_v2` | 4h | 防 stale prompt |
| 22 | `ai_insight` | 4h | 防重复计费 |

> 详细 L3 基础设施边界见 §3.2。

## 5. 装饰器 API 设计（钉死版）

### 5.1 L0 强一致装饰器

```python
def invalidate_cache_on_commit(
    *,
    domains: list[str],                              # 必填
    cascade: list[str] | None = None,                # 可选
    project_id_from: str = "path",                   # path/query/payload/arg/global
    resource_id_from: str | None = None,             # path:<key>/payload:<key>/row.id
    extra_project_ids: Callable | None = None,      # 回调 (args, kwargs, rv) -> list[int]
    on_error: str = "raise",                         # raise/log/queue（L0 不允许 log）
) -> Callable:
    """装饰 FastAPI 路由 / 普通同步函数，commit 后强制失效。"""
```

### 5.2 L1 弱一致装饰器

```python
def invalidate_cache_on_commit_l1(
    *,
    domains: list[str],
    project_id_from: str = "path",
    extra_project_ids: Callable | None = None,
) -> Callable:
    """L1 装饰器：失效失败 best_effort（log），短 TTL 自动兜底。"""
```

### 5.3 Celery 任务装饰器

```python
def invalidate_cache_on_commit_celery(
    *,
    domains: list[str],
    cascade: list[str] | None = None,
    project_id_from: str = "arg",   # Celery 默认从 kwargs 取
    extra_project_ids: Callable | None = None,
    on_error: str = "log",          # Celery 默认 best_effort
) -> Callable:
    """Celery 任务装饰器：用 mark_committed() 协议，函数返回时统一失效。"""
```

### 5.4 `mark_committed()` 协议

```python
from app.services.infra.cache_decorator import mark_committed, auto_commit

# 方式 A：手动标记
db.commit()
mark_committed()   # ← commit 成功后必须调

# 方式 B：context manager 一体化
with auto_commit(db):
    do_business(db)
    # exit 时自动 db.commit() + mark_committed()
```

**铁律**：
1. 每次 `db.commit()` 成功 → 调 `mark_committed()`
2. `db.rollback()` 或异常时**不要**调 `mark_committed()`
3. 多次 commit 可多次 mark，装饰器**只在函数返回时失效一次**

### 5.5 project_id 解析（5 种策略）

| `project_id_from` | 解析位置 | 适用端点 |
|---|---|---|
| `"path"` | `request.path_params["project_id"]` | `PUT /settings/{project_id}/{sku}` |
| `"query"` | `request.query_params["project_id"]` | `GET /list?project_id=42` |
| `"payload"` | `payload.project_id` | `POST /upsert` (body 含 project_id) |
| `"arg"` | 函数参数 `project_id` | Celery 任务（从 kwargs 取） |
| `"global"` | 不解析（全量失效） | system-level 配置 |

### 5.6 跨项目失效（`extra_project_ids`）

默认 `project_id_from` 解析出的单 project_id 失效。如业务涉及跨多项目（如 CRM `batch-transfer(from=A, to=B)`），用回调：

```python
@invalidate_cache_on_commit(
    domains=["crm"],
    project_id_from="payload",
    extra_project_ids=lambda args, kwargs, rv: [
        args[0].from_project_id, args[0].to_project_id,
    ],
)
def batch_transfer_customers(payload, db):
    # 失效 crm(payload.project_id) + crm(from) + crm(to) 三个项目
    ...
```

回调签名：`(args, kwargs, rv) -> list[int]`，lazy 求值。

## 6. 失效矩阵存储（白名单）

### 6.1 存储位置

`backend/app/services/infra/cache_write_endpoints.py`（Python dataclass，类型安全）。

### 6.2 dataclass 形状

```python
@dataclass(frozen=True)
class WriteEndpointSpec:
    domain: str                          # 必须已在 REGISTERED_DOMAINS
    module: str                          # dotted path，不含 .py
    function: str                        # 函数名
    decorator: str                       # invalidate_cache_on_commit / _celery / _l1
    cascade: tuple[str, ...] = ()
    on_error: str = "raise"
    project_id_from: str = "path"
    extra_project_ids: str | None = None  # 函数名字符串（弱引用）
    rationale: str = ""
    issue_ref: str = ""
```

### 6.3 白名单组成

- `L0_WRITE_ENDPOINTS`（10 域 × N 写端点）—— **强制登记**
- `L1_WRITE_ENDPOINTS`（9 域 × 部分写端点）—— 建议登记（方便审计）
- `L2_WRITE_ENDPOINTS`（2 域 × N 写端点）—— **强制登记**

> 补充：commission / CRM 域当前**无缓存层**（子 #2 阶段 2-A 先补缓存层后，才能在本白名单中登记装饰器声明）。阶段 2-A 与阶段 2-B 之间的白名单逐步充实。

## 7. 不变量测试设计

### 7.1 A 类（已装饰但未实际失效）—— 8 个场景

| # | 场景 | 防护 |
|---|---|---|
| A1 | 函数抛异常 → 不失效（fail-safe） | 装饰器 fail-safe |
| A2 | 未 mark → log warning，失效失败 | 提醒业务漏 mark |
| A3 | project_id 解析失败 → 触发全量失效 | 防御缺失参数 |
| A4 | 域未注册 → 启动期 KeyError | typo 拦截 |
| A5 | L0 拒绝 `on_error="log"` | 防御 L0 best_effort |
| A6 | extra_project_ids 回调异常 → 主 project_id 仍失效 | 防御回调挂掉 |
| A7 | FastAPI 抛 HTTPException → 不失效 | 防御 4xx 误失效 |
| A8 | FastAPI 域未注册 → 启动期 KeyError | typo 拦截 |

### 7.2 B 类（应失效但未装饰）—— 4 个场景

| # | 场景 | 防护 |
|---|---|---|
| B1 | L0/L2 白名单端点必须有装饰器 | AST 扫描 + dataclass 对照 |
| B2 | L1 白名单端点必须有 L1 装饰器 | 同上 |
| B3 | cascade 域必须同层或更高（不允许 L1 cascade 进 L0） | 层约束 |
| B4 | 白名单腐烂（声明的端点代码不存在）→ **hard fail** | 维护纪律 |

### 7.3 CI 钩子（`check_cache_decorator_coverage.py`）

- **hard fail**：白名单腐烂（声明了但代码没了）→ exit 1
- **soft warn**：未登记写端点（代码有了但白名单无）→ log warning + exit 0
- 集成到 GitHub Actions `cache-governance.yml`

### 7.4 测试文件分布

```
tests/services/infra/
├── test_cache_decorator.py            # A 类 8 个场景
└── test_cache_decorator_invariants.py # B 类 4 个场景

tests/api/
├── test_inventory_replenishment_settings_endpoint.py  # 已存在（BLF-633）
├── test_commission_records_endpoint_cache.py          # 新增
└── test_crm_endpoints_cache.py                        # 新增

tests/celery/
├── test_cache_decorator_celery.py     # 协议测试
└── test_crm_rule_engine_cache.py      # 真实 Celery 集成

backend/scripts/
└── check_cache_decorator_coverage.py  # CI 钩子
```

## 8. 端点改造示意（4 种 commit 模式）

### 8.1 模式 A：FastAPI 单次 commit（path 解析）

```python
# inventory_replenishment.py 改造后
@router.put("/inventory-replenishment-settings/{project_id}/{sku:path}")
@invalidate_cache_on_commit(
    domains=["inventory_replenishment"],
    project_id_from="path",
    resource_id_from="path:sku",
)
def update_inventory_replenishment_setting(
    project_id: int, sku: str, payload, db, ...
):
    row = upsert_inventory_replenishment_setting(db, ...)
    db.commit()
    # ↑ 装饰器自动失效；不再手动调 invalidate_inventory_replenishment_cache
    return InventoryReplenishmentSettingItem(...)
```

### 8.2 模式 B：FastAPI payload 解析 + cascade

```python
@router.post("/records/upsert")
@invalidate_cache_on_commit(
    domains=["commission_records"],
    cascade=["commission_summary", "operator_performance"],
    project_id_from="payload",
    resource_id_from="row.id",
)
def upsert_commission_records(payload, db, operator):
    rows = bulk_upsert_commission_records(db, payload, operator=operator)
    db.commit()
    return CommissionRecordsResponse(rows=rows)
```

### 8.3 模式 C：跨项目失效（extra_project_ids 回调）

```python
@router.post("/customers/batch-transfer")
@invalidate_cache_on_commit(
    domains=["crm"],
    project_id_from="payload",
    extra_project_ids=lambda args, kwargs, rv: [
        args[0].from_project_id, args[0].to_project_id,
    ],
)
def batch_transfer_customers(payload, db):
    transfer_customers_batch(db, payload)
    db.commit()
```

### 8.4 模式 D：Celery 任务（mark_committed 协议）

```python
@shared_task(name="crm_rule_engine", acks_late=False)
@invalidate_cache_on_commit_celery(
    domains=["crm"],
    project_id_from="arg",
    on_error="log",
)
def crm_rule_engine(project_id: int | None = None) -> str:
    db = SessionLocal()
    try:
        result = scan_rules(db, project_id=project_id)
        db.commit()
        mark_committed()   # ← 协议：commit 后必须 mark
    finally:
        db.close()
    return f"rules={result['rules_evaluated']}"
```

## 9. 实施拆分（4 个子 issue）

### 子 issue #1：基础设施 + 不变量测试
- 新建 `backend/app/services/infra/cache_decorator.py`（装饰器实现）
- 新建 `backend/app/services/infra/cache_write_endpoints.py`（白名单 dataclass）
- 新建 `tests/services/infra/test_cache_decorator.py`（A 类 8 个）
- 新建 `tests/services/infra/test_cache_decorator_invariants.py`（B 类 4 个）
- 新建 `backend/scripts/check_cache_decorator_coverage.py`（CI 钩子）
- 接入 GitHub Actions `cache-governance.yml`

### 子 issue #2：L0 域改造（高优先级 — 防 BLF-633 重演）

**走法 A**：本子 issue 内分两阶段完成——先补缓存层（缺失域），再完成装饰器改造。

**阶段 2-A：补缓存层（仅 commission / CRM 域）**

下列域当前**无独立缓存层**（每次 list 都打 DB），需要先补上 L0 缓存，才能接装饰器：

- `commission_records`（业绩明细）
  - 在 `backend/app/services/infra/cache_decorator.py` 注入 `commission_records` 域 + invalidate_fn
  - 在 `records.py` 端点里接入 `get/set_invalidate_commission_records_cache`
  - 补测试：缓存命中率 + invalidate 生效
- `commission_ratio_overrides`（业绩比例）
  - 同上模式
- `commission_role_assignments`（角色分配）
  - 同上模式
- `commission_summary`（业绩汇总）
  - 同上模式（聚合性质可加 `cascade` 依赖）
- `crm` / `crm_tasks`（客户/线索/商机/公海/跟进 + 任务）
  - 盘点所有 5 子域读写端点，引入 `crm_cache.py` 模块统一管理
  - 补 `get/set/invalidate_crm_cache(project_id)` 函数

**阶段 2-B：装饰器改造（所有 L0 写端点）**

缓存层补齐后，逐个加装饰器（遵循 §5 API）：

- `inventory_replenishment`：2 个写端点已修，需加装饰器
- `data_management`：盘点写端点 + 加装饰器
- `commission_records / ratio_overrides / role_assignments / summary`：从阶段 2-A 接手 + 加装饰器
- `platform_revenues`：盘点写端点 + 加装饰器
- `crm / crm_tasks`：从阶段 2-A 接手 + 加装饰器
- `operator_performance`：级联失效（依赖 cascade 即可，无需独立缓存层）

**验收顺序**：阶段 2-A 全部完成 → B1 测试纳入新缓存层端点 → 阶段 2-B 逐个加装饰器 → B1 测试再次绿灯。

**走法 A 选择理由**：让治理方案保持"纯治理"语义、避免拆出独立子 issue 增加交付复杂度；阶段划分足以防止"补缓存层 + 加装饰器"在同一 commit 里混着交难评审。

### 子 issue #3：L1 域改造（低优先级 — 短 TTL 兜底）
- `shipment_schedules`：4 源写路径登记 + L1 装饰器（best_effort）
- `inventory_analysis` / `inventory_snapshot_options`：盘点 + L1 装饰器
- `return_analysis` / `daily_analysis` / `monthly_financial_series`：调整 TTL 到 5min（统一档）
- `product_analysis`：**接通死代码** + L1 装饰器
- `sku_info` / `report_reconciliation` / `office`：盘点 + L1 装饰器

### 子 issue #4：L2 域 + Celery 改造
- `ai_chat_v2` / `ai_insight`：盘点写端点 + L2 装饰器
- 全部 Celery 写任务：加 `mark_committed()` + `invalidate_cache_on_commit_celery`
- 集成测试：`tests/celery/test_cache_decorator_celery.py`

## 10. 验证 / 完成定义（DoD）

### 每个子 issue 的 DoD
1. ✅ 装饰器按设计实现并通过 A 类 8 个测试
2. ✅ 该子 issue 涉及的所有写端点改造完成，并通过 B1 测试
3. ✅ B4（白名单腐烂）测试通过——无腐烂项
4. ✅ CI 钩子 `check_cache_decorator_coverage.py` 通过（hard fail 项 0）
5. ✅ 真实端点集成测试通过（`tests/api/` + `tests/celery/`）
6. ✅ 后端 `pytest` 全绿
7. ✅ 前端 `vitest` 全绿（无 frontend 改动，但跑冒烟）

### 整体方案 DoD
1. ✅ 4 个子 issue 全部完成
2. ✅ A 类 8 个 + B 类 4 个不变量测试全绿
3. ✅ CI 钩子在 GitHub Actions 启用
4. ✅ 完整分层总表中所有 L0 域写端点已装饰
5. ✅ BLF-633 验证：`PUT /inventory-replenishment-settings/{project_id}/{sku}` 后立即失效（无需等 TTL）
6. ✅ 监控验证：写后冷击不超过可接受范围（VPS 2GB 内存稳定）

## 11. 已知风险与缓解

| 风险 | 缓解 |
|---|---|
| 大体积数据冷击（commission_summary 写后多人并发冷击） | 监控 + 必要时加 re-warm（v1.1 异步预热任务） |
| Celery 任务漏 `mark_committed()` → 失效失败 | log warning + 测试覆盖 + code review checklist |
| 跨项目失效 `extra_project_ids` 回调挂掉 | 主 project_id 仍失效 + log error（A6 测试覆盖） |
| 服务层 commit 提前 commit 而装饰器看不到 | 服务层调 `mark_committed()`（ContextVar 跨调用栈） |
| 白名单腐烂 | B4 hard fail |
| 新增加写端点未登记白名单 | CI 钩子 soft warn（不阻断 PR，但提示开发者） |
| 子 #2 阶段 2-A 工作量超预期（commission / CRM 补缓存层） | 分两阶段提交，阶段 2-A 完成才能进阶段 2-B；阶段可独立评估与汇报 |

## 12. 不在本方案范围

- L3 基础设施（presence/session/ratelimit/semaphore/auth）独立维护
- 缓存预热任务（re-warm）—— v1.1 子 issue
- 缓存击穿 / 雪崩保护（已有 `cache_get_or_set` stampede 保护，足够）
- Redis Cluster / 哨兵改造
- 缓存 key 加密 / 压缩算法升级（已 zlib 压缩足够）