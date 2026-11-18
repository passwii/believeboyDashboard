# 原生 `<select>` 审计（2026-11-18）

> 口径：`frontend/docs/design-spec.md` §0.4 —— **V4 Warm Ledger 是现行权威**。新增/迁移的筛选与表单控件走
> `components/dashboard-v2/warm-ledger/controls`（Radix Select / `role=combobox`），颜色只用 `--warm-ledger-*`，
> 禁止 `--term-*` 与硬编码色。原生 `<select>` 的弹层由浏览器/操作系统渲染，无法接入 Warm token，
> 且语义是 `select` 而不是 `combobox`，与 Warm 控件不可互操作。
>
> 范围：`frontend/**/*.tsx|*.ts`，排除 `node_modules` 与 `*.test.*`。

## 1. 汇总

| 指标 | 数值 |
|---|---|
| 审计前原生 `<select>` | **66 处 / 33 个文件** |
| 本轮已迁移（reports 模块 + 报表定价表格） | **13 处 / 4 个文件** |
| 剩余未迁移 | **53 处 / 29 个文件** |

审计命令：

```bash
cd frontend
grep -rn "<select" --include='*.tsx' --include='*.ts' . \
  | grep -v node_modules | grep -v '.test.'
```

### 本轮已迁移（保持 URL / 筛选 / 状态语义不变）

| 文件:行 | 位置 | 迁移方式 |
|---|---|---|
| `app/dashboard/reports/pricing-calculation/shop-calculation/shop-calculation-client.tsx:272` | header slot · 项目筛选 | `WarmSelect`（`hideLabel` + `ariaLabel`，空值用 sentinel） |
| `app/dashboard/reports/pricing-calculation/shop-calculation/shop-calculation-client.tsx:293` | header slot · 站点筛选 | `WarmSelect` |
| `app/dashboard/reports/pricing-calculation/shop-calculation/shop-calculation-client.tsx:314` | 移动筛选条 · 项目筛选 | `WarmSelect`（移动端共享外壳不变） |
| `app/dashboard/reports/pricing-calculation/shop-calculation/shop-calculation-client.tsx:335` | 移动筛选条 · 站点筛选 | `WarmSelect` |
| `app/dashboard/reports/monthly-report/generate/generate-client.tsx:892` | header slot · 项目筛选 | `WarmSelect`（首项「项目加载中… / 请选择项目名称」保留） |
| `app/dashboard/reports/monthly-report/generate/generate-client.tsx:906` | header slot · 国家站点 | `WarmSelect` |
| `app/dashboard/reports/monthly-report/generate/generate-client.tsx:938` | 移动筛选条 · 项目筛选 | `WarmSelect` |
| `app/dashboard/reports/monthly-report/generate/generate-client.tsx:952` | 移动筛选条 · 国家站点 | `WarmSelect` |
| `app/dashboard/reports/monthly-report/reconcile/page.tsx:106` | header slot · 项目筛选 | `WarmSelect`（`all` 保持为真实 value） |
| `app/dashboard/reports/monthly-report/reconcile/page.tsx:119` | header slot · 站点筛选 | `WarmSelect` |
| `app/dashboard/reports/monthly-report/reconcile/page.tsx:145` | 移动筛选条 · 项目筛选 | `WarmSelect` |
| `app/dashboard/reports/monthly-report/reconcile/page.tsx:158` | 移动筛选条 · 站点筛选 | `WarmSelect` |
| `components/dashboard/pricing-calculation/shop-calculation-table.tsx:775` | 表格行内「派送模式」 | `WarmSelect`（行级唯一 id + 紧凑样式） |

> 行号是审计前的行号；迁移后这四个文件已无 `<select>`。

## 2. WarmSelect 的紧凑形态（向后兼容）

`components/dashboard-v2/warm-ledger/controls/warm-controls.tsx` 新增可选属性，**原有调用签名与渲染不变**：

- `label?: string`：由必填改为可选；
- `hideLabel?: boolean`：保留 `label` 作为无障碍名称，但不渲染可见标签；
- `ariaLabel?: string`：无可见标签时提供无障碍名称（缺省回退 `label`）。

有可见标签时仍渲染 `.warm-ledger__control-label` 并用 `aria-labelledby` 关联；紧凑形态则不再渲染标签节点，
直接在 trigger 上给 `aria-label`。头部筛选因此可以「无次级标签、横向排布」，屏幕阅读器仍读到「项目筛选 / 站点筛选」。

空值约定：Radix 禁止 value 为 `""` 的 option（会与「清空」语义冲突并抛错），所以原来
`<option value="">选择项目</option>` / `<option value="">请选择项目名称</option>` 这类「未选」项改成
非空 sentinel（`__no-project__`），`onChange` 时再映射回 `''`，页面 state / URL 契约完全不变。

## 3. 未迁移清单（53 处）

优先级定义：

- **P0**：顶部筛选 / 工具栏等高频可见控件，原生控件与 Warm 控件并排，视觉与交互断裂最明显；
- **P1**：表单 / 对话框内的字段下拉，标签完整、交互低频，替换风险中等；
- **P2**：表格行内、分页、包装组件、文档式页面或刻意例外区，替换成本 / 回归风险最高，放到最后。

### 3.1 P0 · 顶部筛选与工具栏（15 处）

| 文件:行 | 页面 | 用途 | 风险 | 建议 |
|---|---|---|---|---|
| `components/dashboard/ad-analysis/top-filters.tsx:170` | 广告分析 · 页面顶栏 | 项目筛选（URL `projectId`） | 与 Warm 顶栏控件并排、原生弹层不随主题；空值 option 需 sentinel | 换 `WarmSelect`（`hideLabel` + `ariaLabel="项目筛选"`），与路由级全局筛选样式对齐 |
| `components/dashboard/ad-analysis/top-filters.tsx:185` | 同上 | 站点筛选（URL `country`） | 同上 | 同上，注意保留 `updateSearchParam` 语义 |
| `components/dashboard/ad-analysis/top-filters.tsx:199` | 同上 | 日期快捷范围（preset） | 存在「自定义」空值项；preset → 日期区间是副作用逻辑 | 先换控件再把「自定义」映射到 sentinel；回归 `applyDatePreset` |
| `components/dashboard/ad-analysis/top-filters.tsx:270` | 同上 · 移动筛选条 | 项目筛选 | 移动端共享外壳逻辑，需保持触发条件不变 | 只换控件，不动 MobileFilterStrip 结构 |
| `components/dashboard/ad-analysis/top-filters.tsx:286` | 同上 | 站点筛选 | 同上 | 同上 |
| `components/dashboard/ad-analysis/top-filters.tsx:300` | 同上 | 日期快捷范围 | 同上 | 同上 |
| `app/dashboard/system/agent-management/agent-management-client.tsx:550` | 系统 · Agent 管理 | 密钥状态筛选（`nativeSelect`） | 工具条内与 Warm 按钮/输入混排 | 换 `WarmSelect`，删除 `nativeSelect` class |
| `app/dashboard/system/agent-management/agent-management-client.tsx:561` | 同上 | 业务域筛选 | 选项由 `AGENT_DOMAINS` 动态生成，空 value 不存在 | 同上 |
| `app/dashboard/system/logs/page.tsx:693` | 系统 · 操作日志 | 日志分类筛选（`all` 为真实值） | 页面为 Warm 面板，原生控件在筛选行内 | 换 `WarmSelect`（`all` 保留） |
| `app/dashboard/system/alerts/components/alert-events-tab.tsx:97` | 系统 · 告警事件 | 告警状态筛选（切换后 `setPage(1)`） | 分页副作用需保持 | 换 `WarmSelect`，回调里保留重置分页 |
| `app/dashboard/system/alerts/components/alert-events-tab.tsx:111` | 同上 | 告警级别筛选 | 同上 | 同上 |
| `app/dashboard/crm/proposals/page.tsx:246` | CRM · 方案列表 | 状态筛选（`StatusFilter`） | type cast 依赖 `e.target.value` | 改 `onChange(value)` 后 cast，保持 URL/state |
| `app/dashboard/crm/proposals/page.tsx:259` | 同上 | 类型筛选（`TypeFilter`） | 同上 | 同上 |
| `app/dashboard/crm/tasks/page.tsx:102` | CRM · 任务 | 任务类型筛选（`data-testid="task-type-filter"`） | 现有测试依赖 testid 与原生 select 交互 | 换 `WarmSelect` 并同步更新测试（click trigger + option） |
| `app/dashboard/operations/platform-inspection/components/inspection-history.tsx:370` | 运营 · 平台巡检历史 | 巡检周期选择（`htmlFor` 关联） | 有真实可见 label，需保留 `label` + `htmlFor` 视觉关系 | 用 `WarmSelect` 的 `label` 形态（不要 `hideLabel`） |

### 3.2 P1 · 表单 / 对话框字段（25 处）

| 文件:行 | 页面 | 用途 | 风险 | 建议 |
|---|---|---|---|---|
| `app/dashboard/system/alerts/components/alert-rule-dialog.tsx:127` | 系统 · 告警规则弹窗 | 项目选择 | 项目 id 为数字，`set('project_id', Number(...))` 需在字符串回调里转换 | `WarmSelect` + 回调内 `Number()` |
| `app/dashboard/system/alerts/components/alert-rule-dialog.tsx:151` | 同上 | 指标选择 | 选项为动态 `metrics` | `WarmSelect` |
| `app/dashboard/system/alerts/components/alert-rule-dialog.tsx:164` | 同上 | 条件选择 | 固定 4 项 | `WarmSelect` |
| `app/dashboard/system/alerts/components/alert-rule-dialog.tsx:200` | 同上 | 级别选择 | 固定 3 项 | `WarmSelect` |
| `app/dashboard/system/alerts/components/alert-rule-dialog.tsx:214` | 同上 | 通知通道 | 固定 3 项，值 `both` 等 | `WarmSelect` |
| `app/dashboard/system/alerts/components/alert-preferences-tab.tsx:110` | 系统 · 告警偏好 | 最低告警级别（`htmlFor="alert-min-severity"`） | 表单字段与保存按钮联动 | `WarmSelect`（可见 label） |
| `app/dashboard/system/account-management/page.tsx:514` | 系统 · 账号管理 | 新建用户 · 角色类型 | 创建表单校验 | `WarmSelect` |
| `app/dashboard/system/account-management/page.tsx:633` | 同上 | 编辑用户 · 角色类型 | 编辑表单校验 | `WarmSelect` |
| `components/crm/crm-lead-form/index.tsx:161` | CRM · 线索表单 | 来源（react-hook-form `field.value`） | RHF `Controller` 受控，改控件需同步 `field.onChange` 与空值 | `WarmSelect` + `Controller` 适配（传 `field.value`/`field.onChange`） |
| `components/crm/crm-lead-form/index.tsx:186` | 同上 | 线索状态 | 同上 | 同上 |
| `components/crm/crm-lead-form/index.tsx:209` | 同上 | 意向级别 | 同上 | 同上 |
| `components/crm/crm-lead-form/index.tsx:234` | 同上 | 负责人（`''` 表示未选） | `''` 需 sentinel，且 `field.onChange(value || null)` | sentinel + 回调转换，保留 `null` 语义 |
| `components/crm/proposal/upload-form.tsx:170` | CRM · 方案上传 | 方案类型（`disabled={submitting}`） | 上传中禁用状态必须保留 | `WarmSelect disabled={submitting}` |
| `components/crm/proposal/upload-form.tsx:186` | 同上 | 关联客户（「不关联」空值） | 空值项 + 客户列表动态 | sentinel 表示「不关联」 |
| `app/dashboard/crm/proposals/[id]/page.tsx:446` | CRM · 方案详情 | 编辑态 · 类型 | 行内编辑，受控值 + 保存按钮 | `WarmSelect`（可见 label） |
| `app/dashboard/crm/proposals/[id]/page.tsx:460` | 同上 | 编辑态 · 状态 | 同上 | 同上 |
| `app/dashboard/crm/proposals/[id]/page.tsx:475` | 同上 | 编辑态 · 关联客户 | 同上，含空值 | 同上 + sentinel |
| `components/crm/crm-rule-editor/index.tsx:134` | CRM · 规则编辑器 | 对象类型（`form.register('entityType')`） | 非受控 register，`WarmSelect` 需改成受控 + `Controller` 或 `setValue/watch` | 先小范围改 `Controller`，再换控件 |
| `app/dashboard/operations/project-launch/templates/workflow-template-editor.tsx:379` | 运营 · 流程模板 | 新建模板 · 流程类型（单行压缩 JSX） | 代码是一行 JSX，改动可读性差，需先展开 | 展开 JSX 后换 `WarmSelect` |
| `app/dashboard/operations/project-launch/templates/workflow-template-editor.tsx:462` | 同上 | 阶段 · 固定资料（「不关联」空值） | 同上 + 空值 `''` | sentinel + 展开 JSX |
| `app/dashboard/operations/project-launch/create-workflow-dialog.tsx:195` | 运营 · 新建流程弹窗 | 模板选择（空态「暂无可用模板」） | 空态 option 与禁用条件 | 空态改 placeholder，`disabled` 保留 |
| `app/dashboard/operations/project-launch/project-launch-client.tsx:794` | 运营 · 项目启动 | 项目选择（空态「暂无待启动项目」） | 同上；`Number(value) || null` 需在回调内转换 | placeholder + 回调转换 |
| `app/dashboard/crm/intent/_components/intent-profile-form.tsx:297` | CRM · 意向详情 | 意向级别 | 受控 form state | `WarmSelect` |
| `app/dashboard/crm/intent/_components/intent-record-drawer.tsx:870` | CRM · 意向抽屉 | 跟进状态（`readOnly` 时禁用） | 只读态禁用必须保留 | `WarmSelect disabled={readOnly}` |
| `app/dashboard/crm/tasks/components/task-list.tsx:455` | CRM · 任务列表 | 通用 `FilterSelect`（label + 下拉） | 页面本地小组件，多个实例共用 | 改这个小组件即可一次性覆盖其所有调用点 |

### 3.3 P2 · 表格行内 / 分页 / 包装组件 / 文档页 / 例外区（13 处）

| 文件:行 | 页面 | 用途 | 风险 | 建议 |
|---|---|---|---|---|
| `components/crm/crm-table/index.tsx:452` | CRM · 通用表格 | 每页条数（`pageSize`） | 表格分页契约；`TerminalSelectNative` 与 Warm 双主题分支 | 与 `table.setPageSize` 契约一起改，需先确认表格组件是否仍承载 Terminal 路由 |
| `components/crm/crm-table/index.tsx:528` | 同上 | 列筛选（动态 `f.options`） | 列配置驱动、多个筛选并存 | 同上，先做单表试点 |
| `components/crm/lead-table.tsx:385` | CRM · 线索表 | 每页条数 | 同分页契约 | 与 crm-table 一并处理 |
| `components/crm/lead-table.tsx:467` | 同上 | 字段筛选（`handleFilterChange`） | 动态列 + 筛选清空语义 | 单独批次 |
| `app/dashboard/crm/intent/_components/intent-table.tsx:82` | CRM · 意向表 | 行内跟进状态（`pendingIds` 中禁用） | 表格单元格内 Radix 弹层 + 行级禁用态 | 行级唯一 id，先验证 portal 不被单元格裁剪 |
| `app/dashboard/operations/project-launch/project-workflow-list.tsx:124` | 运营 · 流程列表 | 阶段状态（`data-testid` 被测试依赖） | 行内控件 + 测试依赖 testid | 换控件时保留 testid，同步测试 |
| `components/system/agent-access-logs-panel.tsx:427` | 系统 · Agent 访问日志 | 请求方法筛选（label 包裹） | 包裹式 `<label>` 在 Radix 下需改为 `ariaLabel` / `label` | `WarmSelect` |
| `components/system/agent-access-logs-panel.tsx:442` | 同上 | 结果筛选 | 同上 | 同上 |
| `components/system/agent-access-logs-panel.tsx:464` | 同上 | 操作类型筛选（`AGENT_DOMAINS`） | 同上 | 同上 |
| `components/system/agent-operation-logs-panel.tsx:481` | 系统 · Agent 操作日志 | 结果筛选 | 同上 | 同上 |
| `app/dashboard/operations/research-analysis/page.tsx:509` | 运营 · 调研分析 | 页面内通用筛选包装组件（解析 children 推断 placeholder/options） | **耦合了 children 解析逻辑**，直接换控件会破坏包装契约 | 先重写包装组件 API（options/value/placeholder 显式），再迁移调用点 |
| `app/dashboard/system/agent-management/agent-usage-guide.tsx:1234` | 系统 · Agent 使用说明 | 业务域切换（文档页内嵌导航控件） | 文档式页面，控件与正文排版耦合 | `WarmSelect`（`hideLabel` + `ariaLabel="选择业务域"`），随文档页改版处理 |
| `app/dashboard/system/digital-display/page.tsx:232` | 系统 · 数字大屏 | 投屏项目选择 | §1.3「恒暗展示页」刻意例外，控件跟随大屏视觉 | 保持原生或随大屏单独设计，不在 Warm 批次内改 |

> 分类计数：P0 15 处、P1 25 处、P2 13 处，合计 53 处。

## 4. 迁移模式（给后续批次复用）

1. **控件**：`WarmSelect`（Radix，`role=combobox`）。头部/工具栏用 `hideLabel + ariaLabel` + 页面本地
   `className` 控制宽度；表单字段用 `label`（保留可见标签）。
2. **空值**：Radix 禁止 `value=""` 的 option。把「全部 / 未选 / 不关联」改成非空 sentinel，
   `onChange` 映射回原来的 `''` / `null` / `'all'`，**页面 state、URL、请求参数语义不变**。
3. **禁用**：`disabled` 原样传给 `WarmSelect`（如上传中、只读抽屉、空项目列表）。
4. **宽度/高度**：`className` 落在 `.warm-ledger__select-wrap`，通过页面 CSS Module 的
   `.xxx :global(.warm-ledger__select)` 调 `width / min-width / height`，只允许 `--warm-ledger-*` token。
5. **测试**：原生 select 的 `fireEvent.change` / `toHaveValue` 必须改成
   `await user.click(combobox)` + `await user.click(option)` / `toHaveTextContent(...)`；
   同时断言容器内 `querySelector('select') === null`。
6. **reports 模块验证命令**（本轮已跑）：

```bash
cd frontend
pnpm vitest run \
  app/dashboard/reports/pricing-calculation/shop-calculation/shop-calculation-client.test.tsx \
  app/dashboard/reports/monthly-report/generate/generate-client.test.tsx \
  app/dashboard/reports/monthly-report/reconcile/page.test.tsx \
  components/dashboard/pricing-calculation/shop-calculation-table.test.tsx \
  components/dashboard-v2/warm-ledger/controls/warm-controls.test.tsx
```

## 5. 未在本轮修复的原因

- 跨模块（system / crm / operations / ad-analysis）不在本任务边界内，避免与其他 Agent 并发改同一文件；
- 部分控件（表格分页、列筛选、包装组件）牵涉表格契约或 children 解析，需要先确认组件 API 再迁；
- `digital-display` 属于 §1.3 刻意例外，不按 Warm 规则强制迁移。
