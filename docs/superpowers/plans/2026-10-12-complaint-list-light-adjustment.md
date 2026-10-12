# 客诉列表轻量调整实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让客诉明细默认跨巡检日期显示，处理中记录优先，并从日度总览直接进入全部客诉。

**Architecture:** 保留现有对话级数据模型和日度巡检总览。列表请求默认不传巡检日期，后端查询按状态分组、组内按最近买家消息日期排序；总览增加明细入口，并统一使用本地日历日期生成查询值。

**Tech Stack:** Next.js、React、TypeScript、FastAPI、SQLAlchemy、PostgreSQL。

## 全局约束

- `pending`、`drafted`、`replied` 属于处理中；`resolved`、`closed_no_response` 属于已完成。
- 已完成记录保留在列表后部；处理中和已完成的排序分组对所有排序方式保持稳定。
- 轻量方案按 `message_date`（最近买家消息日期）排序，不新增数据库列或迁移。
- 总览继续按巡检日展示日度指标；客诉明细默认跨日期查询。
- 不改造项目分组、巡检历史或支付明细。
- 依仓库与会话约束，不新增或运行测试；提交 PR 后检查远端自动检查结果。

---

## 文件职责

- `backend/app/services/complaint_center_service.py`：客诉查询和排序，负责保证活跃状态优先。
- `frontend/app/dashboard/operations/complaint-center/list/complaint-list-client.tsx`：客诉筛选器、默认查询日期和列表默认排序。
- `frontend/app/dashboard/operations/complaint-center/complaint-center-client.tsx`：日度总览的日期序列化和进入全部明细的入口。

### Task 1: 稳定后端状态分组排序

**文件：** `backend/app/services/complaint_center_service.py`

- [x] 在 `fetch_complaints` 的排序分支前定义状态优先级：`pending`、`drafted`、`replied` 为 0；其他状态为 1。
- [x] 把该优先级作为所有现有排序分支的首个 `order_by` 项；`date_desc` 分支随后按 `Complaint.message_date.desc()`、`Complaint.id.asc()` 排序，SLA 分支保持原 SLA 次序。
- [x] 当 `sort is None` 时同样按状态优先级、`message_date DESC`、`id ASC` 排序。
- [x] 通过代码检查确认 SLA 升序 / 降序不会把已完成记录排到处理中记录前面。

SQLAlchemy 状态分组表达式：

```python
active_first = sql_case(
    (Complaint.status.in_(('pending', 'drafted', 'replied')), 0),
    else_=1,
)
```

### Task 2: 明细页默认查询全部日期

**文件：** `frontend/app/dashboard/operations/complaint-center/list/complaint-list-client.tsx`

- [x] 把巡检日期状态改为 `Date | null`，初值设为 `null`；传给 `SingleDatePicker` 的值使用 `date ?? undefined`。
- [x] 在 `filters` 中，仅当日期存在时生成 `date: toYmdLocal(date)`；日期为空时不传 `date`，使后端返回所有巡检批次的对话。
- [x] 日期选择控件旁添加“全部日期”操作；点击后将日期设回 `null` 并把分页重置为第 1 页。初始无日期时该状态应清楚显示为全部日期。
- [x] 默认排序从 `sla_asc` 改为 `date_desc`；保留现有 SLA 排序按钮。后端状态优先级应在用户切换 SLA 排序后仍生效。
- [x] 保留项目、状态、分类、关键词、首次咨询日期、分页、详情和状态变更行为。

### Task 3: 总览增加明细入口并修正本地日期

**文件：** `frontend/app/dashboard/operations/complaint-center/complaint-center-client.tsx`

- [x] 增加本地 `YYYY-MM-DD` 格式化 helper，使用 `getFullYear()`、`getMonth() + 1`、`getDate()` 和两位数补零。
- [x] 用该 helper 替换请求参数和日期标签中的 `toISOString().slice(0, 10)`，确保 Asia/Shanghai 选择日期不被转成前一天。
- [x] 在“店铺健康”卡片标题操作区增加“查看全部客诉”链接，目标为 `/dashboard/operations/complaint-center/list`。
- [x] 保留总览的日度巡检筛选、指标、趋势和店铺健康表。

### Task 4: 检查变更并提交 PR

- [ ] 运行 `git diff --check`，检查前后端 diff、日期参数是否可选、状态分组是否覆盖五种状态。
- [ ] 提交中文 Conventional Commit，例如：`feat(客诉中心): 默认展示跨日期待处理客诉`。
- [ ] 推送分支 `codex/complaint-all-dates` 并创建中文标题 PR；PR 描述使用中文分节，列出背景、改动、验证和风险。
- [ ] 等待 PR 自动检查结束；若失败，只依据具体失败信息修复。
- [ ] 检查合并目标和 PR 状态后合并 PR，并确认合并结果。

## 验收清单

- 默认明细请求不带 `date`，跨巡检日期记录可见。
- 列表默认状态次序为处理中在前、已完成在后；每组最近买家消息日期倒序。
- 选定巡检日可以筛选该批次；“全部日期”恢复跨批次结果。
- 总览链接可进入全部明细，且日期控件的显示日期与请求日期一致。
- PR 标题与分节标题为中文；合并目标为 `main`，合并状态可确认。
