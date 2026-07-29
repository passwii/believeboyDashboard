# CRM 主线深入 Roadmap（2026-07-26）

> **For agentic workers:** 这是一份**多阶段 roadmap**，可独立执行。P5 详细到 TDD 任务级（立即可执行）；P6-P9 为各 phase 的**设计纲要 + task 骨架**（进入 phase 前需用 brainstorming 重新对齐 + 用 writing-plans 拆 micro-step，本 plan 只给到 high-level task）。**不要在不更新 plan 的情况下擅自展开 P6+ 的 micro-step**。
>
> **使用方式**：新会话 LLM 拿到本文件 + AGENTS.md + docs/REFERENCE.md + `main=df31d105`（P4 上线）即可工作。每完成一个 phase，在 plan 末尾"完成记录"里加一行。
>
> **范围决议**：
> - ✅ 含 P5（P4 review 留的 12 项 deferred 收尾，跟当前代码强耦合）
> - ✅ P6-P9（数据建模 / 任务系统 / 看板强化 / 自动化）
> - ❌ 不含：商机 Opportunity（用户已决定丢弃，wiki obs-2026-07-23-crm 记录）、公式引擎、合同/订单、自定义字段、表单设计器、审批流、移动端
> - ❌ 不展开：P6-P9 的 micro-step（待 brainstorming + writing-plans）
> - ❌ 不动：另一 agent 的 WIP（详见 Global Constraints）

---

## 业务背景（必读）

**CRM 现状**（main=df31d105, prod alembic=220, 2026-07-25 P4 上线）：

| 已完成 | 内容 |
|---|---|
| **P1**（P1a + P1b） | 漏斗 + 权限 + 公海 + lead→customer 转化 + 待跟进 |
| **P2**（P2a + P2b + P2c） | 待跟进视图 + 负责人选择 + 多联系人 |
| **P3**（P3a + P3b + P3c） | 公海自动回收 + CSV 导出 + 看板 |
| **P4** | 审计日志 + 高级筛选实用档 |

**业务形态**（用户裁决）：威森瑞跨境业务是「一个客户一锤子买卖」，**不需要单独管交易阶段**——漏斗简化为 `线索 Lead → 客户 Customer + 跟进 Follow`。所有 Opportunity 模块已砍。

**当前功能**：客户/线索 CRUD（含转化闭环）/ 多联系人 / 跟进 + 待跟进视图 / 公海（ownerId=null）+ 自动回收（Celery beat, 7 天无跟进回公海）+ CSV 导出 / 数据看板（recharts）/ 审计日志（抽屉 tab + 管理员页）/ 高级筛选（filterEngine 列白名单防注入 + 表头快捷筛选行）/ 用户/角色/隔离范围（owner/all/mine）。

---

## Global Constraints（贯穿 P5-P9，全部适用）

### 仓库与流程
- **分支**：默认 main 开发；feature 分支 `feat/crm-p<N>-<slug>`；合并一律 `--no-ff`；**绝不 rebase main**。
- **测试 DB**：`BLF_test` 持久化共享；CRM 测试 `truncate ... restart identity cascade` 隔离。**并行 subagent 不得跑 DB 测试**（会互冲）；DB 测试由主 agent 串行跑；subagent 只跑 lint/build/非 DB 单测/`pnpm test`。
- **后端测试**：`cd backend && .venv/bin/python -m pytest <path> -q`。
- **前端门禁顺序**：`cd frontend && pnpm lint && pnpm build && pnpm test`。
- **Subagent 工具选择**：本仓库 **pi subagent 工具比 Paseo 可靠**——Paseo 的 pi agent 撞上 edit 工具 `filePath` 参数 bug，且写完代码会 idle 不提交。默认派 pi subagent；Paseo 仅在用户明确指定时用。
- **WIP 保护**：主工作区常驻另一 agent 未提交 WIP（≥13 个 backend 测试文件 + pyproject.toml）。**git add 只加本任务文件**，严禁 `git add -A/-u/commit -a`；操作 WIP 文件前先 `git status -sb` 核对。
- **部署**：用 `git deploy`（= `git push origin main` 后脚本判断是否含 `backend/` 自动部署）。纯前端改动不触发 VPS。

### 命名与代码
- **迁移命名**：文件名 `YYYYMMDD_NNN_description.py`，revision id 纯数字短 ID，`NNN` 从最新递增。**当前 head=220**：
  - P5 预计 ≤3 个迁移（contacts 字段增强 / audit log 增强 / 任务系统可能用 221-223）
  - **建前**：`git fetch origin && git rebase origin/main` 取单链；`alembic heads` 确认单 head。
  - **多 worktree 防撞**：建迁移前必看 `alembic heads` 单链；撞车汇合后用 `alembic merge heads --rev-id <下一序号>`。
  - **严禁**裸跑 `alembic revision -m "..."`（生成随机 hash）。
  - **已部署到 prod 的迁移禁止改 revision id**（prod `alembic_version` 按 id 追踪）。
  - 主键统一 `Integer`。
- **权限**：新端点必须经 `app/services/crm/permissions.py` 的 `require_admin` / `require_owner_or_admin` / `resolve_scope` / `filter_owned_ids`；不允许在 endpoint 层裸做权限判断。
- **身份**：`get_request_user_id`（UUID 字符串）、`get_request_is_admin`（bool）；`actor_name` 实时查 `public.user_accounts`（不快照，名字保持最新）。
- **审计**：所有写端点继续走 `audit_service.record_log`（P4 已建立）。写两遍 commit（service 写 + record_log 自带 commit）是 plan 选定 tradeoff，P5 第⑥项再考虑强一致。
- **Commit**：中文 + Conventional Commits（feat/fix/test/docs/chore/refactor…），scope 中文，subject 动宾短语 ≤50 字无句号。详见 `chinese-commit-conventions` skill。
- **TDD**：每个 task 先写失败测试 → 跑确认失败 → 最小实现 → 跑确认通过 → 提交。**绝不**先写实现再补测试。
- **Superpowers 流程**：默认 `subagent-driven-development`（每个 task 一个 implementer + 一个 reviewer；reviewer 抓 Critical/Important 后可走 fix loop，最多 5 轮）。P5 走完整 SDD；P6+ 可按 phase 灵活。

### 设计原则
- **抽象先行**：任何跨 phase 的能力（如 P5 的 `CONTACT_FIELD_LABELS`、P6 的 `customer_health` 计算、P7 的 task 通用 CRUD）先抽 service / util，再接端点 / UI。
- **防御深度**：白名单（filterEngine、审计 entity_type、permission roles）、深度上限（P5 第⑦项）、事务边界（P5 第⑥项）。
- **不破坏既有**：CRM 全套 214 测试已绿；每次提交后跑 CRM 回归确认 0 回归。
- **可独立取消**：每个 phase 内部 task 顺序有依赖；跨 phase 弱依赖（可调换或砍）。

---

## Phase 总览

| Phase | 名称 | 周期 | 任务数 | 关键产出 | 状态 |
|---|---|---|---|---|---|
| **P5** | P4 收尾（Deferred Minors） | 1-2 周 | 12 项 deferred | 12 项全清 | **待执行** |
| **P6** | 数据建模深化 | 2 周 | 8-10 task（待展开） | 客户标签 + 价值分档 + 健康度评分 | 设计纲要 |
| **P7** | 任务系统 | 2-3 周 | 10-12 task（待展开） | task 实体 + 看板 + 提醒 | 设计纲要 |
| **P8** | 数据看板强化 | 1-2 周 | 6-8 task（待展开） | 漏斗 + 业绩 + 生命周期 | 设计纲要 |
| **P9** | 工作流自动化 | 2-3 周 | 8-10 task（待展开） | 7 天无跟进 + 公海增强 + 规则引擎雏形 | 设计纲要 |

---

# Phase P5 · P4 Deferred Minors 收尾（详细 TDD）

> **目标**：清空 P4 review 留的 12 项 deferred minor，全部「可后续」转「已交付」。
>
> **BASE**：main = df31d105（P4 合并后）
>
> **分支**：`feat/crm-p5-cleanup`，合并 `--no-ff` 进 main。
>
> **预计周期**：8-12 工作日
>
> **测试基线**：开始时 `pytest tests/api/crm tests/services/crm -q` → **214 通过**（绿）；`pnpm test` → **223 通过**（绿）。
>
> **12 项 deferred** 来自 wiki `obs-2026-07-25-crm-p4-main-df31d105-12-deferred-minors` + P4 plan `.superpowers/sdd/2026-07-25-crm-p4-audit-and-filter/progress.md`。

## P5 任务清单

### P5-1 · CONTACT_FIELD_LABELS + 联系人字段级变更摘要（frontend #② / backend 联动）

**问题**：P4 的 `update_contact` 端点用静态摘要「编辑联系人 X」，无字段级变更；客户/线索都有 `_fmt(snake→中文)` 和 `CUSTOMER_FIELD_LABELS/LEAD_FIELD_LABELS`，联系人缺。

**Files**:
- Modify: `backend/app/services/crm/audit_service.py`（追加 `CONTACT_FIELD_LABELS` 常量 + `summarize_contact_update` 函数）
- Modify: `backend/app/services/crm/contact_service.py`（调用 `summarize_contact_update`）
- Modify: `backend/tests/services/crm/test_audit_service.py`（补 6 个用例：单字段 / 多字段 / None↔值 / 类型映射 / 联系人全字段覆盖 / 无变更返回 None）

**Labels 表**（必含字段，参考 `Customer`/`Lead` schema）：
```python
CONTACT_FIELD_LABELS = {
    "name": "姓名",
    "role": "职位",
    "phone": "电话",
    "email": "邮箱",
    "wechat": "微信",
    "is_primary": "主联系人",
    "note": "备注",
}
```

**接口**：
```python
def summarize_contact_update(before: dict, patch: dict) -> str | None:
    """比对联系人改前 vs patch，输出中文变更摘要如「主联系人: false→true」。"""
```

**TDD**：
1. 写 `test_summarize_contact_update_single_field`（phone 改 +86-138…）
2. 写 `test_summarize_contact_update_multi_field`（phone + role 同时改）
3. 写 `test_summarize_contact_update_none_to_value`（email 从 None 改成 x@y）
4. 写 `test_summarize_contact_update_is_primary_toggle`（false→true）
5. 写 `test_summarize_contact_update_no_change_returns_none`
6. 写 `test_summarize_contact_update_unknown_field_skipped`（patch 里有未声明字段 → 跳过不抛）
7. 跑确认 6 红 → 实现 → 跑确认 6 绿
8. 串行跑 `pytest tests/services/crm/test_audit_service.py -q` → 全绿

**Acceptance**：6 个测试通过，`contact_service.update_contact` 调用 `summarize_contact_update` 替代静态字符串。

---

### P5-2 · convert_lead 补新建 customer/contact 的 create 留痕（frontend #③）

**问题**：P4 的 `convert_lead` 端点只在 lead 侧写一条 `convert` 审计；转化生成的客户（及其默认联系人）没 `create` 审计 → 客户审计时间线无起点。

**Files**:
- Modify: `backend/app/api/v1/endpoints/crm.py`（`convert_lead` 端点，在 `service.convert()` 成功后，对新 customer + 默认 contact 各调一次 `record_log(action="create")`）
- Modify: `backend/tests/api/crm/test_audit_api.py`（补 1 用例：`test_convert_lead_creates_customer_and_contact_audit_logs`）

**注意点**：
- service.convert() 已经创建 customer + 主 contact；端点拿到这两个实体 id 后追加 `record_log`。
- actor_id 与 lead 的 convert 留痕用同一个（同一操作用户）。
- 不要修改 service.convert 的实现（保持纯业务 + 单一 commit）；audit 留痕继续在 endpoint 层做（与 P4 约定一致）。

**TDD**：
1. 写 `test_convert_lead_creates_customer_and_contact_audit_logs`：调 `/crm/leads/{id}/convert` → 查询 `crm_audit_logs` 应至少包含 3 条（lead convert + customer create + contact create）
2. 跑确认红 → 实现 → 跑确认绿

**Acceptance**：转化后审计时间线（客户抽屉）显示「客户创建」作为起点。

---

### P5-3 · contains 转义 `%`/`_`（frontend #⑥）

**问题**：`filter_engine.apply_filters` 的 `contains` 算子直接用 SQL `LIKE` 拼接用户输入，未转义 SQL 通配符 `%`/`_`。安全不破（value 是绑定参数，非字符串拼接），但 UX 差——用户搜 `%` 会匹配过多，搜 `_` 会匹配任意单字符。

**Files**:
- Modify: `backend/app/services/crm/filter_engine.py`（`contains` 分支增加 `value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")` + 在 SQL 模板里加 `ESCAPE '\\'`）
- Modify: `backend/tests/services/crm/test_filter_engine.py`（补 3 用例：`test_contains_escapes_percent`、`test_contains_escapes_underscore`、`test_contains_literal_percent_does_not_match_all`）

**SQL 模板修改**（含 ESCAPE）：
```python
# 旧：column.ilike(f"%{value}%")
# 新：column.ilike(f"%{escaped}%", escape="\\")
```

**TDD**：
1. 写 `test_contains_literal_percent_does_not_match_all`：插 2 条客户（一个 name 含 `%`，一个 name 含 `a%b` 字面），筛选 `contains(name, "%")` → 应只匹配 name 含字面 `%` 的
2. 写 `test_contains_escapes_underscore`：类似，搜 `_` 不应匹配所有
3. 写 `test_contains_backslash_escape_works`：搜 `\%` 应匹配字面 `\%`
4. 跑确认 3 红 → 实现 → 跑确认 3 绿

**Acceptance**：用户搜 `%`/`_` 行为符合直觉（字面匹配）。

---

### P5-4 · select 受控 value（深链显示同步）（frontend #⑦ 第一半）

**问题**：CrmTable 筛选行用 `defaultValue` 非受控——用户带 `?filters=…` 进入页面，下拉显示「全部」但数据已筛选。要么改受控，要么初始化时从 table.filters 反推 defaultValue。

**方案**：在 `CrmTable` 渲染筛选行时，从 `table.filters` 计算每个字段的 `defaultValue`（不存 state，每次 render 重算），传给 Radix Select 的 `value`（受控）。

**Files**:
- Modify: `frontend/components/crm/crm-table/index.tsx`（筛选行渲染处：每字段的 `Select` 改 `value`（受控），值从 `table.filters` 中反向查询；onValueChange 走 `handleFilterChange`）
- Modify: `frontend/components/crm/crm-table/crm-table-filters.test.tsx`（补 2 用例：`test_filter_select_shows_initial_filter_from_url`、`test_filter_select_updates_when_url_changes`）

**实现要点**：
- `value` 来自 `table.filters.find(f => f.field === key)?.value ?? "__all__"`
- "__all__" 是清空占位；onValueChange 收到 "__all__" → 不写入 conditions
- 翻页瞬时多余 fetch（B3 review 留的 B 隐患）保留现状，依赖 `reqIdRef` 防陈旧；不修

**TDD**：
1. 写 `test_filter_select_shows_initial_filter_from_url`：mock `useCrmTable` 让 `filters=[{field:"status",op:"eq",value:"active"}]`，渲染 → 断言 status Select 的 `value === "active"`（不是 "__all__"）
2. 写 `test_filter_select_updates_when_url_changes`：rerender 时 filters 变化 → 断言 Select value 跟着变
3. 跑确认 2 红 → 实现 → 跑确认 2 绿
4. 跑全量 `pnpm test` → 223+2 通过（不回归）

**Acceptance**：深链 `?filters=…` 进入页面，下拉显示与筛选结果一致。

---

### P5-5 · customerType / interestedService 抽共享常量（frontend #⑧）

**问题**：B4 在 `customer-table.tsx` 和 `lead-table.tsx` 各自硬编码 `customerType` 和 `interestedService` 的选项。两表重复、未来加值改两处。

**Files**:
- Create: `frontend/lib/crm/constants/options.ts`（导出 `CUSTOMER_TYPE_OPTIONS`、`INTERESTED_SERVICE_OPTIONS` 两个 `Array<{value:string, label:string}>`）
- Modify: `frontend/components/crm/customer-table.tsx`（import 共享常量替换硬编码）
- Modify: `frontend/components/crm/lead-table.tsx`（同上）
- Modify: `frontend/lib/crm/enums/customer.enum.ts`（若有 `CUSTOMER_TYPE` 枚举常量，优先复用；如未定义则保持硬编码但抽到 constants/options.ts 共享）

**注意**：
- 先检查 `frontend/lib/crm/enums/` 现有枚举；若已定义 `CUSTOMER_TYPE_LABELS` / `INTERESTED_SERVICE_LABELS` → 直接用 `Object.entries(...).map(...)` 生成 options；若无 → 在 constants/options.ts 集中定义。
- 客户 + 线索的 customerType / interestedService 当前用同一组值（共享），如未来分歧需拆分（本日不拆）。

**TDD / 验证**：
- 不需新单测（纯抽常量），靠 lint + 全量测试不回归
- 跑 `pnpm lint && pnpm build && pnpm test` → 全绿

**Acceptance**：customer-table / lead-table 引用共享常量；改一处两表生效。

---

### P5-6 · 审计强一致（同事务 flush / endpoint 层统一 commit）（frontend #⑨）

**问题**：P4 的 endpoint 层留痕是两次独立 commit（service 写自带 commit → record_log 自带 commit）。commit#2 失败 → 业务变更落库但漏审计（非损坏，但合规风险）。

**方案**：把 record_log 改为**不自带 commit**（返回 audit log 实例），由 endpoint 层统一 `db.commit()`。所有写端点改为：service 写 → 构造 audit log 对象 → 一次性 commit。

**Files**:
- Modify: `backend/app/services/crm/audit_service.py`（`record_log` 改为不 commit，仅 `db.add(log)` + `db.flush()` + `db.refresh(log)`，返回 log 实例；新增参数 `commit: bool = False`）
- Modify: `backend/app/api/v1/endpoints/crm.py`（所有调 record_log 的写端点改为：service 写完后构造 log → 不 commit；端点末尾统一 `db.commit()`）
- Modify: `backend/tests/services/crm/test_audit_service.py`（补测试：`test_record_log_no_commit_by_default`、`test_record_log_commit_true_commits`）
- Modify: `backend/tests/api/crm/test_audit_api.py`（跑回归，确认所有写端点审计仍正常）

**注意**：
- 业务 service（如 customer_service.update）有自己的 commit；端点不能再额外 commit 业务对象（否则双重 commit 报错）。需要 service 改为 flush only，端点 commit。
- 这个改动**较大**——会影响所有写端点。建议：先在 `create_customer` / `update_customer` 两个端点做样板，跑通后再批量推广到其余 13 个写端点。
- 改动后所有 CRM 写测试重跑。

**TDD**：
1. 写 `test_record_log_no_commit_by_default`：service 调 record_log 后不 commit → 查 audit 表为空；外部 commit 后 → 有记录
2. 写 `test_record_log_commit_true_commits`：传 commit=True → 自动 commit
3. 写 `test_create_customer_writes_audit_in_same_tx`：create_customer 端点：成功后业务表 + audit 表都有；模拟 audit 失败 → 业务表无记录（事务回滚）
4. 跑全量 CRM 测试 → 214+3 通过

**Acceptance**：业务写入与审计写入原子化（要么都有，要么都无）。

---

### P5-7 · and/or 递归深度上限（frontend #⑫）

**问题**：`filter_engine._parse_condition` 的 `and`/`or` 递归无深度上限。低风险 DoS（恶意客户端构造深嵌套可致栈溢出/查询超大）。

**Files**:
- Modify: `backend/app/services/crm/filter_engine.py`（`apply_filters` 入口加深度计数；递归时 +1；超 `MAX_DEPTH=8` → 抛 `ValueError`）
- Modify: `backend/tests/services/crm/test_filter_engine.py`（补 3 用例：`test_and_or_max_depth_allowed`、`test_and_or_exceeds_depth_raises_value_error`、`test_and_or_nested_at_max_depth_works`）

**常量**：
```python
MAX_FILTER_DEPTH = 8
```

**实现要点**：
```python
def apply_filters(query, conditions, depth=0):
    if depth > MAX_FILTER_DEPTH:
        raise ValueError(f"filters 嵌套深度超过 {MAX_FILTER_DEPTH}")
    ...
```

**TDD**：
1. 写 `test_and_or_max_depth_allowed`：构造 8 层嵌套 → 不报错
2. 写 `test_and_or_exceeds_depth_raises_value_error`：9 层 → ValueError
3. 写 `test_and_or_nested_at_max_depth_works`：刚好 8 层 + 叶子条件 → 正常过滤
4. 跑确认 3 红 → 实现 → 跑确认 3 绿

**Acceptance**：恶意深嵌套请求 400 而非 500 / OOM。

---

### P5-8 · set_primary 死枚举清理（frontend #⑩）

**问题**：前端 `AuditAction` 枚举含 `set_primary`，但后端从不 emit（无独立 set-primary 端点，设主联系人走 `update_contact` 的 `update` action）。前端 label / badge 预置无害，但属死代码。

**Files**:
- Modify: `frontend/lib/crm/types/audit.ts`（`AuditAction` 联合类型移除 `set_primary`；删除对应 label / badge 映射）
- Modify: `frontend/components/crm/crm-audit-timeline/index.tsx`（清理引用 `set_primary` 的 if/switch 分支）
- Modify: `backend/app/models/crm.py`（CrmAuditLog.action 字段注释列出真实可能值：`create / update / delete / transfer / move_sea / claim / convert`）

**注意**：
- 后端 action 字段是 String(30)，不影响 schema。
- 若未来真做 set-primary 独立端点，再加回。

**验证**：
- 跑 `pnpm test` → 不回归
- 跑 `pytest tests/services/crm/test_audit_service.py -q` → 不回归

**Acceptance**：`set_primary` 从前端枚举消失；后端注释列出真实 action 集。

---

### P5-9 · 联系人审计抽屉入口（frontend #⑪）

**问题**：contact 的 create/update/delete 审计 `entity_type="contact"` 留痕，但 UI 只在管理员审计页（对象=联系人）可查。客户抽屉的「操作记录」tab 查 `entity_type=customer`，看不到该客户下联系人的审计。

**Files**:
- Modify: `frontend/components/crm/crm-overview-drawer/index.tsx`（客户抽屉的「操作记录」tab：在客户审计列表下方追加「联系人审计」分组；同一时间线风格；用 `entity_id in [contact.id for contact in customer.contacts]` 过滤）
- Modify: `frontend/components/crm/crm-audit-timeline/index.tsx`（新增可选 props：`entityTypes: ('customer'|'contact')[]`、`extraEntityIds: number[]`，支持跨实体查询）
- Modify: `frontend/lib/crm/api/http-crm-client.ts`（`listAuditLogs` 实现支持多 entity_type + entity_id 过滤——查后端 `entity_types` + `entity_ids` 参数，若后端未支持则扩展 endpoint）

**后端配套**（如未支持）：
- Modify: `backend/app/api/v1/endpoints/crm.py`（`GET /crm/audit-logs` 增加 `entity_types: list[str] = Query(None)` + `entity_ids: list[int] = Query(None)` 查询参数；service 层 `list_audit_logs` 支持 IN 查询）
- Modify: `backend/app/services/crm/audit_service.py`（`list_audit_logs` 函数签名加 `entity_types` / `entity_ids` 参数）
- Modify: `backend/tests/api/crm/test_audit_api.py`（补测试：跨实体查询返回正确记录）

**TDD**：
1. 写后端测试：`test_list_audit_logs_filter_by_entity_types_and_ids` → 同时查 customer 和 contact 的 audit
2. 写前端测试：`test_customer_drawer_audit_tab_shows_contact_audits` → 渲染客户抽屉 → 断言联系人审计可见
3. 跑全量 → 全绿

**Acceptance**：客户抽屉「操作记录」tab 既显示客户自己的，也显示其下联系人的审计。

---

### P5-10 · summarize_update None↔"" 显示「空→空」修复（frontend #①）

**问题**：P4 的 `_fmt` 把 None 和空字符串都归「空」，触发显示「空→空」（如某字段从 None 改成 ""），用户困惑。

**Files**:
- Modify: `backend/app/services/crm/audit_service.py`（`_fmt` 函数：增加 `is_empty` 判断；只有「两侧都非空且值不同」时才输出条目；或 None ↔ "" 视为「无变更」跳过该字段）
- Modify: `backend/tests/services/crm/test_audit_service.py`（补 2 用例：`test_summarize_update_none_to_empty_string_skipped`、`test_summarize_update_empty_string_to_none_skipped`）

**方案选择**：
- 选项 A：None ↔ "" 视为无变更（更严格）
- 选项 B：显示为「清空字段」（显示意图）
- 推荐选 A（最少噪音）；P5 选 A。

**TDD**：
1. 写 `test_summarize_update_none_to_empty_string_skipped`：phone 从 None → "" → 摘要 None
2. 写 `test_summarize_update_empty_string_to_none_skipped`：反向同理
3. 跑确认 2 红 → 实现 → 跑确认 2 绿

**Acceptance**：None ↔ "" 不产生噪音变更条目。

---

### P5-11 · 审计页 catch 无条件 setForbidden 修复（frontend #⑤ 第一半）

**问题**：审计页 catch 块无条件 `setForbidden()`（任何错误都显示「无权限」），且 request helper 不暴露 status。

**方案**：request helper 改为抛带 status 的 Error；catch 分支按 status 区分（401/403 → 提示登录/无权限；5xx → 提示刷新；network → 提示重试）。

**Files**:
- Modify: `frontend/lib/crm/api/http-crm-client.ts`（请求函数：捕获非 2xx 响应时抛 `ApiError(status, body)`；不再是抛裸 Error）
- Modify: `frontend/components/crm/crm-audit-timeline/index.tsx` 或审计页（catch 块按 ApiError.status 分支处理）
- Modify: `frontend/lib/crm/api/http-crm-client.ts` 导出 `ApiError` 类
- Modify: `frontend/components/crm/crm-audit-timeline/index.tsx` 或对应页面测试文件（补测试：mock 500 → 显示「服务器错误」；mock 401 → 显示「请重新登录」）

**TDD**：
1. 写 `test_audit_page_5xx_shows_error_message_not_forbidden`
2. 写 `test_audit_page_401_shows_login_required`
3. 写 `test_audit_page_network_error_shows_retry_hint`
4. 跑确认 3 红 → 实现 → 跑确认 3 绿

**Acceptance**：审计页错误提示按 status 区分，不再一律「无权限」。

---

### P5-12 · 翻页瞬时多余 fetch 修复（frontend #⑦ 第二半，B3 隐患）

**问题**：B3 review 提到 page>1 时筛选变更会触发一次瞬时多余 fetch（reqIdRef 防陈旧仅闪烁），依赖运气。

**方案**：在 CrmTable 把「筛选变更 + 重置 page」改为**原子 URL 写**——用 `router.replace({ filters, page: 1 }, ...)` 一次性写入，触发一次 effect → 一次 fetch。

**Files**:
- Modify: `frontend/components/crm/crm-table/index.tsx`（筛选行 onChange：调 `handleFilterChange(field, op, value)` 时**同时**调 `setPage(1)` 在同一次 URL 写里完成）
- Modify: `frontend/components/crm/crm-table/crm-table-filters.test.tsx`（补 1 用例：`test_filter_change_resets_page_atomically_no_extra_fetch`）

**注意**：
- 既有「用 JSON.stringify 内容比较」修法保留（防御性）；原子写是更根本的修复。
- 如果 hooks（useCrmTable）封装的 setFilters 已经原子，组件层无需做；否则组件层组合两个 setState 到同一次 router.replace。

**TDD**：
1. 写 `test_filter_change_resets_page_atomically_no_extra_fetch`：从 page=3 改筛选 → fetchPage 应只被调 1 次（而非 2 次：先改筛选 + 再 reset page）
2. 跑确认 1 红 → 实现 → 跑确认 1 绿

**Acceptance**：筛选变更只触发一次 fetch，无闪烁。

---

## P5 验收门禁

完成后必须满足：

1. **后端测试**：`cd backend && .venv/bin/python -m pytest tests/api/crm tests/services/crm -q` → **≥230 通过**（214 基线 + 12 项新增 ≥16 测试用例）
2. **前端测试**：`cd frontend && pnpm test` → **≥235 通过**（223 基线 + ≥12 新增）
3. **lint + build**：`pnpm lint 0 errors && pnpm build ✓`
4. **迁移**：若 P5-2 改了 audit / contact / 等需要迁移 → 新增迁移编号递增（**当前 head=220**，预计下一个 221）；合并进 main 后 `alembic heads` 仍单链
5. **SDD 流程**：每个 task 一个 implementer + reviewer；review 抓出 ≥1 个 bug 是常态（B3 Critical、前 review 的 500 缺口）
6. **WIP 保护**：另一 agent 的 ≥13 文件全程未被 git add
7. **Deploy**：用 `git deploy`；因含 backend 改动 → 触发 VPS 部署；prod `alembic_version` 同步到最新

---

# Phase P6 · 数据建模深化（设计纲要）

> **⚠️ 本 phase 仅为设计纲要**。进 phase 前必须用 `brainstorming` skill 重新对齐需求（标签粒度、价值分档规则、健康度公式），再用 `writing-plans` 拆 micro-step。本 plan 不展开 TDD 任务。
>
> **目标**：把客户从「基本资料 + 跟进」升级到「带价值 + 标签 + 健康度」的可分析实体。

## P6 设计方向

### P6.1 客户标签（Tags）
- **形态**：多对多标签。客户 ↔ 标签（label + 颜色）
- **schema**：新增 `customer_tags`（id, name, color, created_at）+ `customer_tag_links`（customer_id, tag_id）
- **UI**：客户抽屉增「标签」field（多选 chip）；客户表可按标签筛选（P5 已具备表头筛选基础设施；标签作为可选字段）
- **权限**：标签 CRUD 仅管理员；客户可为自己加/去自己的标签
- **审计**：标签变更走 record_log（action=`tag_add` / `tag_remove`）
- **预计迁移**：1 个

### P6.2 价值分档（Tier）
- **形态**：客户分 S/A/B/C 四档（或五档），按销售额 + 利润 + 复购频次自动算（或手动）
- **schema**：customer 加 `value_tier: enum('S','A','B','C')` + `lifetime_value: Decimal`
- **计算**：cron 任务每日扫一遍客户 → 重算（event-driven 也行：订单/财务事件触发）
- **UI**：客户抽屉展示分档徽章；客户表加 `valueTier` 筛选
- **预计迁移**：1 个

### P6.3 健康度评分（Health Score）
- **公式**：`score = f(最近跟进天数, 跟进频次, 公海停留时长, 价值分档)`
- **schema**：customer 加 `health_score: int (0-100)` + `health_updated_at: datetime`
- **刷新**：实时算（每次查表）或定时（celery beat 每小时刷一次）——选定时以减小开销
- **UI**：客户抽屉健康度进度条；客户表加「健康度」列 + 排序
- **预计迁移**：1 个 + celery 任务

## P6 task 骨架（待 brainstorming 展开）

1. **P6-1** 客户标签表 + schema + CRUD（标签管理页）
2. **P6-2** 客户-标签多对多 + 抽屉 UI + 审计
3. **P6-3** 客户表 tag 筛选 + 标签聚合看板入口
4. **P6-4** 客户 value_tier + lifetime_value 字段 + 迁移
5. **P6-5** 价值计算 service（订单/财务事件触发）+ 定时 cron
6. **P6-6** 健康度公式 + service + celery beat
7. **P6-7** 客户抽屉价值/健康度展示 + 审计
8. **P6-8** 客户表 health/value 列 + 排序 + 筛选

**预计 8-10 task，2 周。**

---

# Phase P7 · 任务系统（设计纲要）

> **⚠️ 本 phase 仅为设计纲要**。进 phase 前需 brainstorming 对齐：任务由谁创建、谁来认领、提醒机制、是否与跟进合并。

## P7 设计方向

### P7.1 Task 实体
- **schema**：`crm_tasks`（id, title, description, due_date, priority, status, owner_id, customer_id?, lead_id?, type, created_at, completed_at）
- **type**：follow_up（跟进）/ call（电话）/ visit（拜访）/ custom（自定义）
- **status**：pending / in_progress / done / cancelled
- **priority**：low / medium / high / urgent

### P7.2 看板（Kanban）
- 已有 `crm-stage-board` 组件？P1 时砍了——本 phase 重建
- 按状态分列：pending → in_progress → done
- 拖拽改状态（react-dnd / @dnd-kit/core）
- 每列卡片显示：标题 + 客户/线索 + 截止 + 优先级色

### P7.3 提醒（Reminder）
- **形态**：到期前 24h 推送通知（站内 Toast + 可选邮件）
- **存储**：celery beat 每小时扫到期任务 → 触发 SSE 事件 → 前端 toast
- **不引入**：外部推送（微信/钉钉）——太重

### P7.4 看板与 P1/P2 衔接
- 跟进 = 一种 task（type=follow_up）
- 看板视图可按 type 筛选
- task 与 follow 双写？或 follow 改用 task 统一？→ **重要决策点**，需 brainstorming

## P7 task 骨架

1. **P7-1** Task 模型 + schema + 迁移 + 基础 CRUD service
2. **P7-2** Task 端点（list/create/update/complete/cancel）+ 权限
3. **P7-3** Task 与客户/线索关联（FK）
4. **P7-4** Task 看板页面 + 拖拽（@dnd-kit/core）
5. **P7-5** Task 提醒 celery beat + SSE 事件
6. **P7-6** Task 列表组件 + 抽屉集成（任务在客户/线索抽屉可见）
7. **P7-7** Task 表头筛选 + 排序
8. **P7-8** 跟进与 task 整合方案（决策点）
9. **P7-9** Task 审计（接 P5 record_log）
10. **P7-10** Task 单元/集成测试

**预计 10-12 task，2-3 周。**

---

# Phase P8 · 数据看板强化（设计纲要）

> **⚠️ 本 phase 仅为设计纲要**。需 brainstorming 对齐：看板的核心问题、用户角色差异（销售看个人 vs 老板看全局）。

## P8 设计方向

### P8.1 漏斗看板（Funnel）
- **指标**：线索数 → 转化率 → 客户数 → 待跟进 → 公海
- **已实现**：P3c 的 dashboard 页面有基础版本
- **深化**：按月/按人/按来源分组；recharts 漏斗图

### P8.2 业绩看板（Performance）
- **指标**：本月新增客户 / 转化数 / 跟进数 / 完成率 / 按人排名
- **数据源**：CRM + 财务（PT4 报表）
- **权限**：员工看自己，老板/管理员看全员

### P8.3 生命周期看板（Lifecycle）
- **指标**：客户从创建到首次跟进 / 到转化 / 到流失 的时间分布
- **数据**：审计 + 跟进 + 公海记录 联表分析

## P8 task 骨架

1. **P8-1** 漏斗指标 service（按时间/角色聚合）
2. **P8-2** 漏斗图表组件 + 页面深化
3. **P8-3** 业绩指标 service（个人 + 全局）
4. **P8-4** 业绩排名表 + 角色权限
5. **P8-5** 生命周期 service（事件序列分析）
6. **P8-6** 生命周期图表（直方图 / 漏斗叠加）

**预计 6-8 task，1-2 周。**

---

# Phase P9 · 工作流自动化（设计纲要）

> **⚠️ 本 phase 仅为设计纲要**。需 brainstorming 对齐：自动化是「硬规则触发」还是「可视化规则引擎」。

## P9 设计方向

### P9.1 7 天无跟进提醒
- **形态**：客户/线索超过 7 天无跟进 → 站内提醒 + 邮件
- **实现**：celery beat 每日扫 → 触发 SSE 事件
- **强化**：可在 admin 设置页调整天数

### P9.2 公海回收增强
- **现状**：P3a 已实现 7 天无跟进回公海
- **强化**：可按价值分档差异化（S/A 永不回公海，B/C 7 天回）；可在跟进成功时重置计时

### P9.3 规则引擎雏形
- **形态**：可视化「当 X 发生，做 Y」编辑器
- **MVP**：仅支持「客户创建 7 天内无跟进 → 提醒负责人」
- **不实现**：复杂条件 / 复合动作 / 与外部系统集成

## P9 task 骨架

1. **P9-1** 7 天无跟进 cron + SSE 事件
2. **P9-2** 7 天无跟进邮件（可关闭）
3. **P9-3** 公海回收按价值差异化（迁移 + celery 逻辑）
4. **P9-4** 公海重置机制（跟进成功 → 重置 7 天计时）
5. **P9-5** 规则引擎 schema（rule / condition / action 表）
6. **P9-6** 规则引擎执行器（celery beat 扫规则）
7. **P9-7** 规则编辑器 UI（admin 设置页）
8. **P9-8** 规则审计（创建/启停/触发结果）

**预计 8-10 task，2-3 周。**

---

# 跨 Phase 共同依赖

- **前端**：`recharts` 已装；`@dnd-kit/core`（P7 用）；`date-fns`（提醒/截止日期格式化）
- **后端**：`celery beat` 已部署（CRM 已有 sea-reclaim + office tick）；继续扩展 beat schedule
- **数据库**：customer 表持续加字段（迁移频率高）；关注 alembic heads 单链
- **权限**：`resolve_scope` 已支持 mine/all/admin 三档；新功能接入已有权限 helper
- **审计**：所有写操作走 `audit_service.record_log`（P5 强一致改造后）

---

# 完成记录

| Phase | 状态 | 合并 commit | Prod alembic | 备注 |
|---|---|---|---|---|
| P1 | ✅ 完成 | (历史) | (历史) | |
| P2 | ✅ 完成 | (历史) | (历史) | |
| P3 | ✅ 完成 | (历史) | (历史) | |
| P4 | ✅ 完成 | df31d105 | 220 | 2026-07-25 |
| P5 | ✅ 完成 | 918c019c + 6e5121b8（尾巴）| 220 | 12 项 deferred 全清；P5-6a 审计强一致 + P5-9 抽屉联系人审计 2026-07-29 补完 |
| P6 | 📐 纲要 | - | - | 数据建模深化，brainstorming 后展开 |
| P7 | 📐 纲要 | - | - | 任务系统，brainstorming 后展开 |
| P8 | 📐 纲要 | - | - | 数据看板强化，brainstorming 后展开 |
| P9 | 📐 纲要 | - | - | 工作流自动化，brainstorming 后展开 |

---

# 风险与待裁决

> 进 P5 之前不强制解决，但执行过程中可能触发。

1. **P5-6（审计强一致）影响面大**：14 个写端点全部要改。决定是否分两批：先 2 个端点样板 + 测试验证 → 跑通 → 推广。如批准可单独立 P5a 子 phase。
2. **P7-8 跟进与 task 整合**：跟进是否降级为 task 的一种 type？还是并存？影响 schema 和 UI，是重要产品决策。
3. **P9-3 公海回收差异化**：是否需要产品决策（不同价值分档行为差异）。可能延迟到 P9 末期做。
4. **跨 phase 排序**：P5 → P6 → P7 → P8 → P9 是不是最优？若 P7 任务系统是高频需求，可前置。
5. **数据建模深化（P6）的标签 vs 海运客户分类**：是否复用？现有海运客户分类字段在哪里？要 cross-check。