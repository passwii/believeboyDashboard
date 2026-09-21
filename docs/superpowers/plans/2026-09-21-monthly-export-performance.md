# 月度核算明细导出性能修复实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复月度核算明细导出在中等数据量下被逐单元格 Excel 样式处理拖慢、超时后重复导出放大耗时的问题，并部署到生产。

**Architecture:** 保留现有 Excel 文件结构、字段和 18 张工作表（1 张核算汇总 + 17 张明细），仅重构样式应用：预先注册带奇偶行填充的样式，对每个单元格只替换字体、填充、边框和对齐组件，保留导出器已经写入的数字格式与保护属性。导出服务增加进程内核算导出串行保护，避免前一次超时后的重复请求或不同报表同时争用 openpyxl CPU；Next.js 后端代理将该接口纳入报表 60 秒超时档，给优化后的导出留出合理余量。

**Tech Stack:** Python 3.13、FastAPI、SQLAlchemy、openpyxl 3.1.5、pytest、Next.js、Vitest、Git deploy。

## Global Constraints

- 不修改数据库 schema，不新增迁移。
- 保持导出文件名、工作表名称、字段、数值和现有视觉样式语义不变。
- openpyxl 继续使用惰性导入，不恢复模块顶层重型导入。
- 后端测试使用 `BLF_test`，不得写入本地 `BLF`；生产验证只读或使用实际用户导出链路。
- Git 提交使用中文 Conventional Commit；生产部署必须从 `main` 执行 `git deploy`。

---

### Task 1: 建立性能与并发回归测试

**Files:**
- Modify: `backend/tests/services/test_report_export_styles.py`
- Create: `backend/tests/services/test_report_export_concurrency.py`
- Modify: `frontend/lib/server/backend-proxy-timeout-policy.test.ts`

**Interfaces:**
- Tests consume `_apply_monthly_like_styles` and `_accounting_export_guard` from the backend export service.
- Tests consume `getProxyTimeoutMs` from the frontend proxy timeout policy.
- Later tasks must make these tests pass without改变导出内容契约。

- [x] **Step 1: Write failing backend style assertions**

在现有样式测试中增加一个包含“报表核算”和“交易一览”两张表、表头和两行数据的 workbook，断言表头使用 `sty1`，偶数数据行使用 `sty2_even`，奇数数据行使用 `sty2_odd`，并断言两种数据样式的填充颜色分别为 `FFFFFFFF` 和 `FFF8FAFC`。当前实现没有奇偶行命名样式，测试必须先失败。

- [x] **Step 2: Write failing duplicate-export guard test**

新增测试调用：

```python
key = (18, "US", "2026-02", False)
with _accounting_export_guard(key):
    with pytest.raises(HTTPException) as error:
        with _accounting_export_guard(key):
            pass
assert error.value.status_code == 409
```

当前尚无该 guard，测试必须先失败。

- [x] **Step 3: Write failing frontend timeout assertion**

在现有 timeout policy 测试中加入：

```ts
expect(
  getProxyTimeoutMs(
    'api/v1/monthly-reports/financial-series/accounting-detail/export',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )
).toBe(60_000)
```

当前路径未进入 report tier，测试必须先失败并返回 5_000。

- [x] **Step 4: Run the focused red tests**

运行：

```bash
cd backend && pytest tests/services/test_report_export_styles.py tests/services/test_report_export_concurrency.py -q
cd .. && pnpm exec vitest run frontend/lib/server/backend-proxy-timeout-policy.test.ts --reporter=dot
```

预期：新增断言失败，原因分别是缺少 `sty2_even`/`sty2_odd`、缺少 guard、月度导出仍返回 5 秒。

### Task 2: 优化 Excel 样式热点

**Files:**
- Modify: `backend/app/services/report/export.py:402-481`

**Interfaces:**
- Preserve `_apply_monthly_like_styles(workbook: Workbook) -> None`.
- Add three registered style arrays: `sty1`, `sty2_even`, `sty2_odd`.
- Preserve existing `报表核算` special-row post-processing and all workbook output fields.

- [x] **Step 1: Register parity styles once**

在 `_apply_monthly_like_styles` 内保留现有 `sty1` 表头样式，新增带白色填充的 `sty2_even` 和带 `FFF8FAFC` 填充的 `sty2_odd`，每个样式只创建一次并取得其 `_style` 数组。

- [x] **Step 2: Replace per-cell multi-property writes**

使用 `ws.iter_rows()` 遍历已经存在的单元格，复制当前 `StyleArray` 后只替换视觉组件 ID；保留单元格原有的 `number_format`、保护属性和其它非视觉字段。保留行高、冻结窗格和列宽设置，避免对每个单元格分别触发多次样式对象分配。

- [x] **Step 3: Run the style tests green**

运行：

```bash
cd backend && pytest tests/services/test_report_export_styles.py -q
```

预期：样式行为测试通过，既有列宽断言仍通过。

### Task 3: 防止超时后的重复导出

**Files:**
- Modify: `backend/app/services/report/export.py`
- Create: `backend/tests/services/test_report_export_concurrency.py`

**Interfaces:**
- Add `_accounting_export_guard(key: tuple[int, str, str, bool])` as a context manager.
- The active same-report key raises `409`; a different report while any export is active raises `429`; the registry is always released in `finally`.
- Wrap `export_financial_accounting_detail_workbook` with the guard after report month normalization and before expensive workbook generation.

- [x] **Step 1: Add process-local in-flight registry**

使用模块级 `threading.Lock` 和 `set[tuple[int, str, str, bool]]`，当前进程内一次只允许一个核算明细导出；当前生产 API 明确运行 `--workers 1`。guard 退出时无论导出成功还是抛异常都移除 key。若未来改为多进程或多实例，需在扩容前替换为共享锁或任务队列。

- [x] **Step 2: Wrap the expensive export body**

将现有 `month = _parse_report_month(report_month)` 作为 guard key 的标准化月份，并用 `with _accounting_export_guard(...):` 包住读取数据、生成 workbook、保存 bytes 的完整逻辑。

- [x] **Step 3: Run concurrency tests green**

运行：

```bash
cd backend && pytest tests/services/test_report_export_concurrency.py -q
```

预期：重复 key 返回 409，不同 key 在活动导出期间返回 429，异常退出后同 key 可以再次进入，真实导出函数也受 guard 保护。

### Task 4: 调整代理超时并完成回归验证

**Files:**
- Modify: `frontend/lib/server/backend-proxy-timeout-policy.ts`
- Modify: `frontend/lib/server/backend-proxy-timeout-policy.test.ts`

**Interfaces:**
- Add an exact `$`-anchored pattern for `/monthly-reports/financial-series/accounting-detail/export` to `REPORT_PATH_PATTERNS`.
- The path must resolve to 60,000 ms without changing sibling monthly report endpoints.

- [x] **Step 1: Add the exact report pattern**

将月度核算明细导出加入报表 tier，保持 `accounting-detail` 查询接口和其它月度接口不被误匹配。

- [x] **Step 2: Run frontend policy tests**

运行：

```bash
pnpm exec vitest run frontend/lib/server/backend-proxy-timeout-policy.test.ts --reporter=dot
```

预期：全部 timeout policy 测试通过。

- [x] **Step 3: Run backend focused and full tests**

运行：

```bash
cd backend && pytest tests/services/test_report_export_styles.py tests/services/test_report_export_concurrency.py -q
cd backend && pytest
```

结果：相关导出与财务回归测试 45/45 通过；全量测试 3474 通过、275 失败，失败集中在本地 Redis 未启动、R2/外部依赖和既有测试环境数据，不涉及本次改动。前端目标 timeout policy 测试 21/21 通过；完整前端 Vitest 在本地单 worker 超过 10 分钟并占用约 1.4GB 内存后手动停止，未将其计为通过。

- [x] **Step 4: Run static checks and inspect the diff**

运行：

```bash
cd backend && ruff check app/services/report/export.py tests/services/test_report_export_styles.py tests/services/test_report_export_concurrency.py
git diff --check
git diff --stat
```

结果：新增测试已通过格式检查与 F821 检查，`git diff --check` 通过；`export.py` 仍有基线 Ruff 告警（未在本次改动中扩大清理范围）。diff 只涉及计划文件、导出服务、测试和 timeout policy。

- [x] **Step 5: Run a production-like read-only benchmark**

在本地生产快照 `BLF` 上只读调用生产导出函数，记录 `_apply_monthly_like_styles` 和总耗时；不得写数据库。结果：样式阶段从基线 62.09 秒降至 0.562 秒，总耗时 4.960 秒；重新打开生成的 1.83 MB xlsx，18 张工作表和 3,739 行交易明细校验通过。

### Task 5: 提交、合并并部署生产

**Files:**
- No additional files; integrate the verified changes.

- [x] **Step 1: Commit the verified changes**

提交信息：

```text
perf(月度报表): 优化核算明细导出并防止重复执行
```

- [x] **Step 2: Request a focused code review**

审查发现完整 `StyleArray` 替换会覆盖数字格式，且原并发测试覆盖不足；已改为保留非视觉样式字段，补充保存/重新加载、异常释放、线程竞争、真实导出函数和邻近路径反向匹配测试，并完成复审验证。

- [x] **Step 3: Cherry-pick the commit onto the clean `main` checkout**

保留 `/Users/damon/DamonProjects/believeboyDashboard` 中用户已有的未提交改动，仅将本次 commit 应用到 main；已无冲突，main 提交为 `7a1e55dd`，用户原有改动均保留。

- [x] **Step 4: Run `git deploy` from `main`**

已按仓库规则从 `main` 执行 `git deploy`：VPS 拉取、Alembic 检查、API/Celery/Beat 重启和健康检查均成功；前端 timeout policy 由 Vercel 自动部署。

- [x] **Step 5: Verify production**

VPS commit 为 `7a1e55dd`，`believeboy-api`、两个 Celery worker 和 Beat 均为 active。生产只读导出验收：样式阶段 1.473 秒、总耗时 9.789 秒、1.83MB、18 张工作表、`交易一览` 3,739 行；部署后日志无 `NameError`、500 或 timeout。
