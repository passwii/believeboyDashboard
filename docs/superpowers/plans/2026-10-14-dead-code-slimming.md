# 死代码瘦身 — 可执行删除清单 + 分批 PR 计划

> 生成日期：2026-10-14
> 状态：**待审核**（本文档只列清单与计划，尚未删除任何文件）
> 方法：后端 AST 可达性分析（入口 `app.main` / Celery app / 动态字符串引用）+ vulture 2.16；前端 import 图孤儿扫描 + 全仓符号引用计数。所有条目均已二次 grep 核实。

---

## 执行状态（2026-10-16 更新）

| 批次 | PR | 状态 | 验证 |
| --- | --- | --- | --- |
| A（后端整文件删除） | #723 | ✅ 已合并 `bb6aa95c` | OpenAPI 路由删除前后各 596 条完全一致；`tests/api` 回归 |
| B（未使用 import/变量） | #728 | ✅ 已合并 `675205cd` | vulture 24 → 3（仅剩刻意保留的 `ai_timeout` 兼容参数）；后端全量对账无新增失败 |
| C（前端孤儿模块） | #724 | ✅ 已合并 `2a60876b` | 删前逐文件复核 0 引用；前端全量 251 文件 / 1855 用例全绿 |
| D（仅测试引用的组件） | #727 | ✅ 已合并 `b532ce93` | 前端全量 244 文件 / 1827 用例全绿；已同步 `motion-system.md` / `FRONTEND-DESIGN-SPEC.md` |
| E（孤儿路由） | — | ✅ **核查后保留，收口**（见下） | 2 个为 301 重定向壳，2 个为 E2E 在用的 QA 沙箱 |
| F（仓库杂物） | — | 🟡 **部分执行**（见下） | 已清理本次 7 个临时 worktree；其余经核查为他人活跃工作，未动 |
| G（追加孤儿模块） | #730 | ✅ 已合并 `50303d74` | 可达性分析确认 0 引用；前端全量 251 文件 / 1855 用例全绿 |
| H（级联孤儿 + spotlight 残留） | #731 | ✅ 已合并 `af230d9f` | 可达性分析确认 0 引用；前端全量 243 文件 / 1824 用例全绿 |
| 附带：主线既有失败修复 | #722 | ✅ 已合并 `5251086d` | `tests/api` 1654 passed / 0 failed；VPS 已部署 |

**部署**：合并后由 `.github/workflows/deploy-vps.yml` 自动部署；因并发组只保留最后一个排队 run，实际手动 `workflow_dispatch` 补齐一次，VPS 已同步到 `50303d74`（批次 H 为纯前端，走 Vercel）。

**批次 F 核查结论（2026-10-16）**：计划里「`.worktrees/` 7 个残留」的前提**不成立**——实际是 6 个（5.1G）**活跃功能分支工作区**（`feat/amazon-review-tracking`、`feat/frontend-login-redesign`、`feat/brand-registration-example` 等，主工作区还有对应未跟踪计划文档），另有 codex / paseo / multica 三个工具的大量 worktree。除本次自己创建的 7 个临时 worktree（已 `worktree prune` + 移除）外，其余**一律不动**；`openSourceProjects/`（62M）、`gui/`（24M）、根 `node_modules/`、`.pnpm-store/`（19M）、`dump.rdb`、103 个 plan 归档、53 个 `backend/scripts/*.py` 均需单独确认后再处理。

**批次 E 核查结论（2026-10-16）**：`reports/report-reconciliation` 与 `crm/workbench` 是 301 重定向兼容壳（同 §0 明确保留的 `vat-invoices` 同类）；`table-showcase` 与顶层 `model-selector-test` 是 E2E 正在引用的 QA 沙箱（后者已带生产环境跳登录自保护）。删除需同步改 3 个 E2E spec + 1 个单测，收益低 → 建议保留、不产生 PR，除非确认废弃这些功能。

---

## 0. 总量概览

| 区域 | 规模 | 死代码候选 |
| --- | --- | --- |
| `backend/app` | 691 文件 / 164,321 行 | 整文件 11 个 + 24 处未使用符号 |
| `frontend` | 1041 文件 / 249,500 行 | 孤儿模块 ~30 + 孤儿路由 4 |
| npm 依赖 | 56 个 | **0**（全部有引用） |

**明确不是死代码（勿删）**：`app/api/v1/router_groups/*`（字符串动态加载）、4 个 Celery 任务（`celery_shared.py` beat 表）、`app/api/v1/endpoints/external_retired.py`（410 兜底）、`app/dashboard/finance/vat-invoices/page.tsx`（301 重定向）。这些静态扫描都会误报，已人工排除。

---

## 1. 可执行删除清单

### 批次 A — 后端：整文件 0 引用（按钮级低风险）

| # | 文件 | 行数 | 判定证据 |
| --- | --- | --- | --- |
| A1 | `backend/app/utils/validators.py` | 181 | 全仓 0 import（8 个函数 `validate_page` 等） |
| A2 | `backend/app/schemas/daily_report.py` | 35 | 3 个 schema 全仓 0 引用 |
| A3 | `backend/app/schemas/portfolio.py` | 39 | 2 个 schema（`ProjectPortfolioKPI`/`PortfolioSummary`）0 引用 |
| A4 | `backend/app/schemas/system_management/role_assignments.py` | 30 | 顶层模块 0 引用；真正在用的是 `commission/role_assignments.py` |
| A5 | `backend/app/scripts/recompute_all_countries.py` | 140 | 无脚本 / 命令 / import 引用 |
| A6 | `backend/app/services/daily/ad_analysis.py` | 12 | 已是 `DeprecationWarning` compat shim，0 消费者 |
| A7 | `backend/app/services/infra/job.py` | 3 | 空壳，仅 docstring + `# TODO: migrate` |
| A8 | `backend/app/services/product/reports.py` | 3 | 同上 |
| A9 | `backend/app/services/data/exchange_rate.py` | 3 | 同上 |
| A10 | `backend/app/services/data/project.py` | 3 | 同上 |
| A11 | `backend/app/utils/models.py` | 20 | 自述 DEPRECATED；**唯一引用**在 `tests/.../test_dedup.py`（需改 1 行 import） |

> A11 附带改动：`backend/tests/services/data/upload/test_dedup.py:7` 从 `app.utils.models` 改为 `from app.models import AnalysisSourceFile`。

### 批次 B — 后端：未使用 import / 变量（vulture ≥90%）

24 处，示例（删的是符号引用，不是整个文件）：

- `app/api/v1/endpoints/ai_insight.py:23` 未使用 import `InsightChunkResponse` / `InsightDoneResponse`
- `app/api/v1/endpoints/alerts.py:27` 未使用 import `dispatch_alert`
- `app/api/v1/endpoints/internal/ad_data.py:121` 未使用 import `Param`
- `app/db/session.py:75`、`app/db/query_timeout.py:69` 未使用变量
- `app/services/ad/helpers.py:9,168`、`app/services/ai/llm.py:360`、`app/services/insight/provider.py:26`
- 三个 `report_builder_{daily,monthly,weekly}.py` 的 `ai_timeout` 未使用变量
- `app/services/shipment/fba_box_export.py:108` 未使用变量 `fp` / `newurl`
- （完整 24 条见 `vulture app --min-confidence 80` 输出）

> ⚠️ 批次 B 会触碰多模块 import 行 → 按 T3 判档跑**后端全量**。

### 批次 C — 前端：孤儿模块（0 引用，连测试都没有）

| # | 路径 | 说明 |
| --- | --- | --- |
| C1 | `components/report-upload/report-upload-dropzone.tsx` | 0 引用 |
| C2 | `components/ui/dropdown-range-date-picker.tsx` | 0 引用 |
| C3 | `components/ui/full-screen-signup.tsx` | 0 引用 |
| C4 | `components/dashboard/portfolio/index.tsx` | 0 引用（同目录 `portfolio-filters` 等仍被用） |
| C5 | `components/dashboard/project-context/cards/*.tsx`（6 个） | `factory/growth/notes/seasonality/sku-context/status-card`，0 引用 |
| C6 | `components/digital-employee/progress-bar.tsx` | 0 引用 |
| C7 | `config/changelog.ts` | 0 引用 |
| C8 | `lib/recent-pages.tsx` | 0 引用 |
| C9 | `lib/crm/method/customer-name.ts`、`follow-icon.ts` | 0 引用（同目录其他 method 仍被用） |
| C10 | `lib/hooks/index.ts` | 空 barrel，`export { useUrlParam }` 但 0 消费者 |
| C11 | `lib/crm/api/index.ts` | 0 精确引用 |

### 批次 D — 前端：仅被自身测试引用的组件（删组件须同时删测试）

| # | 组件 | 伴随测试 |
| --- | --- | --- |
| D1 | `components/ui/page-header.tsx` | `page-header.test.tsx` |
| D2 | `components/ui/breadcrumb.tsx` | `breadcrumb.test.tsx` |
| D3 | `components/dashboard/dashboard-surface-card.tsx` | `dashboard-surface-card.test.tsx` |
| D4 | `components/motion/MotionFade.tsx` + `MotionStagger.tsx` + `lib/motion/variants.ts` | `motion-fade.test.tsx` / `motion-stagger.test.tsx` |
| D5 | `components/dashboard-v2/use-processed-orders.ts` | `use-processed-orders.test.ts`（**注意**：`v2-order-flow-panel.test.tsx` 仍 mock 它，需一并处理） |
| D6 | `components/ui/collapsible.tsx` | 无测试；纯 shadcn re-export，0 引用 |

### 批次 E — 前端：孤儿路由（**需业务确认**，见 §4）

`table-showcase/`、`reports/report-reconciliation/`、`crm/workbench/`、`model-selector-test/`。

### 批次 F — 仓库杂物（非 PR，本地清理 + 少量 gitignore）

| 目标 | 大小 | 处置 |
| --- | --- | --- |
| `.worktrees/`（7 个残留 worktree） | — | `git worktree prune` + 手工删除 |
| `dump.rdb` | 3.5K | 未跟踪，可删 |
| 根目录 `node_modules/`、`.pnpm-store/` | — | 未跟踪缓存 |
| `openSourceProjects/`、`gui/` | 86M | 未跟踪（0 git files），本地参考物，建议移出仓库 |
| `docs/superpowers/plans/` 20+ 已完成 plan | — | 归档（按仓库 plans 约定） |
| `backend/scripts/*.py` 一次性迁移脚本 | 53 个 | 见 §4 待确认 |

---

## 2. 分批 PR 计划

| 批次 | 内容 | 判档 | 批数 |
| --- | --- | --- | --- |
| **PR-1** | 批次 A（后端整文件删除） | T1（叶子，无公共契约） | 1 |
| **PR-2** | 批次 B（未使用 import/变量） | T3（跨模块 import 行） | 1 |
| **PR-3** | 批次 C（前端孤儿模块） | T1/T2 | 1 |
| **PR-4** | 批次 D（前端仅测试引用组件） | T2（含删测试） | 1 |
| **PR-5** | 批次 E（孤儿路由，**确认后**） | T2 | 1 |
| 本地 | 批次 F（仓库杂物） | T0 | 不产生 PR |

**建议顺序**：PR-1 → PR-3（互不影响，可并行）→ PR-4 → PR-2 → PR-5。
每个 PR 独立可回滚；批次 E 未确认前不执行。

---

## 3. 验证命令（每批必跑）

### 3.1 后端基线快照（**批次 A/B 前先存，作为硬安全网**）

```bash
cd backend
.venv/bin/python - <<'PY' > /tmp/routes_before.txt
import sys; sys.path.insert(0, ".")
from app.main import app
for r in sorted(app.routes, key=lambda r: getattr(r, "path", "")):
    print(getattr(r, "path", ""), sorted(getattr(r, "methods", []) or []))
print("TOTAL", len(app.routes))
PY
```

删除后比对（**必须完全一致**，证明没有误删路由）：

```bash
cd backend
.venv/bin/python - <<'PY' > /tmp/routes_after.txt
import sys; sys.path.insert(0, ".")
from app.main import app
for r in sorted(app.routes, key=lambda r: getattr(r, "path", "")):
    print(getattr(r, "path", ""), sorted(getattr(r, "methods", []) or []))
print("TOTAL", len(app.routes))
PY
diff /tmp/routes_before.txt /tmp/routes_after.txt && echo "✅ 路由零变化"
.venv/bin/python -c "import sys; sys.path.insert(0,'.'); import app.main; print('✅ app.main 导入 OK')"
```

### 3.2 各批次

**PR-1（批次 A）**
```bash
cd backend
.venv/bin/python -c "import sys; sys.path.insert(0,'.'); import app.main; print('import ok')"
pytest tests/services/data/upload/test_dedup.py -q        # A11 受影响测试
pytest tests/api -q                                        # 端点集合回归（T1 目标集）
# 全量（若对 A11 shim 删除存疑）：pytest -q
```

**PR-2（批次 B）**
```bash
cd backend
.venv/bin/vulture app --min-confidence 80   # 期望：条目数下降、无新增
pytest -q                                    # T3 判档 → 后端全量（单次；失败集对账）
```

**PR-3（批次 C）**
```bash
cd frontend
pnpm check:mocks
pnpm lint
vitest run components/dashboard components/digital-employee lib/crm   # 目标目录回归
# 全量：pnpm test
```

**PR-4（批次 D）**
```bash
cd frontend
vitest run components/ui components/motion components/dashboard-v2
pnpm lint
# 确认 v2-order-flow-panel 相关用例仍绿：
vitest run components/dashboard-v2/v2-order-flow-panel.test.tsx
```

**PR-5（批次 E，确认后）**
```bash
cd frontend
# 删除路由后，crawl 发现的 URL 列表须同步更新，否则 discovery.spec 会 404
grep -rn "table-showcase\|report-reconciliation\|crm/workbench\|model-selector-test" tests/
pnpm lint && pnpm test
```

### 3.3 通用收尾（每个 PR）
```bash
cd frontend && pnpm gen:api-types:check   # 若触碰后端 schema，确保契约同步
cd backend && python scripts/check_alembic.py   # 若触碰迁移相关
```

---

## 4. 需你业务确认（代码无法判定）

| # | 事项 | 疑点 |
| --- | --- | --- |
| Q1 | `model-selector-test/` 页 | 仅测试用；保留作 QA 沙箱 or 删？ |
| Q2 | `crm/workbench/`、`table-showcase/`、`reports/report-reconciliation/` 路由 | 无导航入口、无内部链接；是否废弃功能？ |
| Q3 | `reports/monthly-report/generate/`、`scheduled-reports/subscriptions/` | 仅移动端/crawl 测试引用，但 `generate-client` 逻辑完整——疑似**仍是活功能但缺导航入口**，倾向**保留** |
| Q4 | `app/api/external_security.py` | 无端点使用，但 `tests/api/conftest.py` 用它重置限流器；删需改 conftest。是否保留作测试基建？ |
| Q5 | `components/crm/**`（含 15+ 未被页面引用的 `crm-*/index.tsx`） | CRM 域疑似在建中半成品，删前需确认 |
| Q6 | `backend/scripts/` 53 个一次性脚本（最早 2026-02） | 是否归档到 `scripts/archive/` 或删除？ |
| Q7 | `docs/superpowers/plans/` 已完成 plan | 归档还是保留？ |

---

## 5. 风险与注意事项

1. **动态加载逃逸**：`importlib`、字符串 `include_lazy_router`、`vi.mock` 会逃过静态扫描——本清单已人工排查这些热点，但删除前仍以 §3.1 路由 diff 为准。
2. **测试专用页**：`model-selector-test` 等被 E2E 直接 `page.goto`，删页面会让对应 spec 失败，需同步更新（批次 E）。
3. **判档**：批次 B 触碰公共模块 import 行 → T3 全量；批次 A/C 为叶子 → T1/T2。
4. **不可逆**：删文件是破坏性操作。**每批一个 branch + 一个 PR**，A/C 可并行，B/D 菜后。
5. **回滚**：逐批提交，`git revert` 单批即可。
