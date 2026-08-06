# Specs 目录约定 · 附 Agent API 多域接入指南

> **适用对象：** `docs/superpowers/specs/` 下所有 spec / design 文档（人类 + 子智能体）。
> **确立时间：** 2026-08-05
> **配套引用：** [plans/README.md](../plans/README.md)（plan 归档约定）+ [AGENTS.md](../../../AGENTS.md) "关键约定" 段
> **重点：** Agent API 正在多域扩张，本 README §二 给出新域接入的固定模式——**开新域前先读这节**。

---

## 一、specs 目录约定（通用）

- **命名**：`YYYY-MM-DD-<slug>-<类型>.md`，类型用 `-design`（设计）/ `-spec`（实施规格）/ `-api`（API 规格）。
- **职责**：spec 记录**设计定稿与拍板结论**（"做什么、为什么这么定"）；落地步骤进 `plans/`，实现细节进代码。spec 不是操作手册。
- **头部必备**：状态、配套文档链接、范围声明（见 §二 2.2 模板）。

---

## 二、Agent API 多域接入指南（重点）

### 2.1 两级文档结构

| 层 | 位置 | 放什么 | 新域何时动它 |
|---|---|---|---|
| **主设计稿** | [`docs/agent-api-design.md`](../../agent-api-design.md) | 跨域公共协议：鉴权契约、confirm 流、响应壳、错误码注册表、限流幂等、路径迁移、实施阶段 | 一般**不碰**；除非动公共协议、§3.2 白名单追加域动作、§8 阶段表打勾 |
| **域 spec** | `docs/superpowers/specs/YYYY-MM-DD-agent-<域>-api.md` | 该域路由表、confirm 白名单、validate/preview 契约、域专属错误码、权限矩阵、拍板记录 | 每域一份，**开域必写** |
| **域 plan** | `docs/superpowers/plans/YYYY-MM-DD-agent-api-<阶段>-<域>.md` | 实施步骤与 Task 拆分 | 实施阶段写，落地模板见 [P2 货件 plan](../plans/2026-08-05-agent-api-p2-shipments.md) |

### 2.2 域 spec 模板骨架

照 [`2026-08-05-agent-shop-calculation-api.md`](./2026-08-05-agent-shop-calculation-api.md) 抄，章节结构：

```
# Agent API · <域名> API 实施规格（设计定稿）

> 状态 / 配套文档（指回主设计稿 + 前置域 spec）/ 范围声明（本 spec 只设计，不实施）

## 0. 拍板结论摘要          ← 讨论清单逐项收口（决策表）
## 1. 写契约拍板            ← 方案 A/B 对比 + 拍板理由
## 2. 完整路由表            ← 读 N + 写 N + 特殊 N
## 3. 请求 / 响应 schema 草案
## 4. confirm 流与白名单    ← action 注册 + _validate/_preview 契约
## 5. 错误码注册            ← errors.py 追加的 DOMAIN_* 码
## 6. 权限矩阵（L2 准入）   ← project_scope 校验
## ...
```

### 2.3 代码接入 Checklist（照 Shop Calculation 抄）

| 步骤 | 位置 | 内容 |
|---|---|---|
| 1 | `backend/app/api/v1/endpoints/agent/<domain>.py` | 新域 router，`prefix="/projects/{project_id}/<资源>"`；读路由 + 写路由（写挂 `@require_confirmation`） |
| 2 | `backend/app/api/v1/endpoints/agent/__init__.py` | `include_router(...)` **必须插在兜底 404 路由之前**（该文件有警告注释，漏了会被静默吞成 404 壳） |
| 3 | `backend/app/api/agent/errors.py` | 域专属错误码按 `DOMAIN_*` 前缀注册，同步 `_HTTP_STATUS` / `_DEFAULTS` 映射 |
| 4 | confirm action | 点分命名 `<domain>.<verb>`，如 `shipment.create`、`shop_calculation.append` |
| 5 | `backend/tests/api/agent/test_<domain>_*.py` | 复用 `make_api_key` / conftest 里 `<domain>_env` fixture 模式（见 [test_shipments_confirm.py](../../../backend/tests/api/agent/test_shipments_confirm.py)） |
| 6 | 主设计稿 | §3.2 白名单追加域动作、§8 阶段表打勾、修订记录加版本 |

### 2.4 复用基建清单（agent_router 层共享，不用重复造）

- **鉴权**：`require_agent_credential`（agent_router 层已挂，新域自动继承）
- **限流**：`require_agent_read_rate_limit` / `require_agent_write_rate_limit`
- **confirm**：`@require_confirmation(action=..., build_preview=..., validate=...)`（action 字符串即注册）
- **响应壳**：`agent_ok` / `error_payload`
- **审计归因**：`append_operation_audit_log(...)` + `_audit_kwargs(request)`（`agent_id` + `idempotency_key`，`operator=NULL`）
- **缓存失效**：写后按域内 helper 处理（如 `_invalidate_shipment_caches`）
- **兜底 404**：agent_router 末尾的 `/{path:path}` 自动覆盖新域

### 2.5 命名与口径约定

- **confirm action**：`<domain>.<verb>`，`verb` 用动词（create / update / delete / append / transition / recalculate_costs）。
- **错误码唯一事实源**：`errors.py`（硬规则）。域专属码登记在**域 spec** 里，主设计稿只维护跨域通用码——避免文档漂移。
- **读路由不落审计**（设计稿 §3.3），只有写路由（含 confirm 回放成功那次）写 `operation_audit_logs`。
- **写路由必带** `Idempotency-Key`（confirm 重放保持原 key + 原请求体）。

---

## 三、已落地域索引（先例，新域照抄）

| 域 | 域 spec | 代码 | 测试 |
|---|---|---|---|
| shipment（货件） | [`2026-08-04-agent-readwrite-api-spec.md`](./2026-08-04-agent-readwrite-api-spec.md)（P0 基建 + P2 货件规格） | [`endpoints/agent/shipments.py`](../../../backend/app/api/v1/endpoints/agent/shipments.py) | `test_shipments_read / _confirm / _delete / _audit / shipment_errors` |
| shop_calculation（店铺测算） | [`2026-08-05-agent-shop-calculation-api.md`](./2026-08-05-agent-shop-calculation-api.md) | [`endpoints/agent/shop_calculations.py`](../../../backend/app/api/v1/endpoints/agent/shop_calculations.py) | `test_shop_calc_read / _compute / _confirm / _audit` |

**实施阶段对照**（主设计稿 §8）：P0 基建 → P1 路径迁移 → **P2 货件（已落地）** → **P3 定价/店铺/库存（店铺测算已落地）** → P4 AI Chat 工具注册。
