# 设计规范（Design Spec）

> **适用版本：** V4 Warm Ledger（2026-11-04 起）
> **适用对象：** 在 `frontend/` 下新增或修改 UI 的工程师与 Agent Team
> **目标：** 明确 **V4 Warm Ledger 是现行权威**；V3 Terminal 降为历史与未迁移路由的维护规范。V4 不是 Terminal 的换肤，也不再以零圆角、全平铺和 `--term-*` 为设计前提。

---

## 0. 版本时间线与阶段沿革

### 0.0 一张表看懂

| 阶段 | 时间窗 | 设计语言 | 令牌 / 组件体系 | 状态 |
|---|---|---|---|---|
| **V1** 早期默认 | 2026-02 ~ 2026-07 中 | shadcn 开箱样式 + 各页自配色 | 默认 token + 局部硬编码 | 存档 |
| **V2** Geist Surface | 2026-07-16 ~ 2026-08-22 | 玻璃拟态、surface 阶梯、圆角与阴影 | `--surface-*` / `dashboard-surface` | 历史存量维护 |
| **V3** Terminal | 2026-08-23 ~ 2026-11-03 | 高密度终端：零圆角、零阴影、1px 平铺、双层导航 | `--term-*` / `components/terminal/*` | 历史规范；仅维护未迁移路由 |
| **V4** Warm Ledger | 2026-11-04 起 | 暖石墨浮窗、圆角、克制阴影、琥珀数据强调、账本式排版 | `--warm-ledger-*` / `components/dashboard-v2/warm-ledger/*` | **现行权威** |

**新人一句话：** Warm Ledger 路由的新页面、新组件和新迁移一律按 V4 写。看到尚未迁移的 Terminal 页面不是 V4 参照；不要为了“统一”把 V4 改回零圆角或混用 `--term-*`。

### 0.1 V1 —— 早期默认时代（存档）

- 2026-02 首批页面直接使用 shadcn/ui 默认令牌和页面级硬编码配色。
- 该阶段没有统一设计系统，已被 V2 / V3 重构覆盖，不再作为实现依据。

### 0.2 V2 —— Geist Surface（历史存量）

- 使用 `--surface-*`、`.dashboard-surface`、圆角、阴影和微交互。
- 仍可能出现在旧页面与共享基础组件中，但不是 V4 页面应模仿的视觉基准。

### 0.3 V3 —— Terminal 终端化（历史维护）

- 2026-08-23 至 2026-11-03 的现行体系，核心是零圆角、零阴影、1px 全平铺、双层 rail/subnav 和 `--term-*`。
- 自 2026-11-04 起，V3 不再是设计权威。`TerminalShell` 已从 dashboard 布局删除，所有 dashboard 页面统一由 Warm Ledger 边界承载；`components/terminal/*` 中仅保留 header-slot、global-filter 等兼容基础设施。
- 新 V4 页面不得使用 `--term-*` 作为新视觉的别名，也不得把 Terminal 控件默认样式直接当作 Warm Ledger 基底。
- `docs/terminal-design/master-prompt.md`、`frontend/docs/table-spec.md` 等 V3 文档保留为历史与存量维护资料；与 V4 冲突时，以本文档和 Warm Ledger foundations 为准。

### 0.4 V4 —— Warm Ledger（现行权威）★

V4 是 BelieveBoy 运营与业务页面的全新设计语言：暖石墨表面、浮在工作画布上的圆角工作窗、琥珀色数据强调、账本式信息层级、可读优先的高密度桌面布局。它有意区别于 V3 Terminal 的冷黑、零圆角和硬件终端气质。

**权威文档：**

- 本文档：全局版本、红线、例外与文档地图。
- `docs/design-drafts/2026-11-01-operations-dashboard/components/foundations/spec.md`：V4 视觉、尺寸、状态与无障碍契约。
- `docs/design-drafts/2026-11-01-operations-dashboard/components/foundations/freeze.md`：已批准的路由范围、桌面画布和冻结决定。
- `docs/design-drafts/2026-11-01-operations-dashboard/design.md`：Warm Ledger 的设计方向与页面基准。
- `docs/design-drafts/2026-11-01-operations-dashboard/components/rollout.md`：V4 类目迁移、Agent Team 与验收顺序。

#### 0.4.1 视觉纪律

1. **暖石墨层次**：Stage / Window / Sidebar / Panel / Raised 使用 `--warm-ledger-*` 表面阶梯，不用近黑冷色堆叠。
2. **圆角与浮窗**：桌面工作窗保留 22px 圆角；面板 16px、主控件 10px、嵌套行 8px。浮窗使用克制的 exterior shadow 和顶部 inset highlight。
3. **等宽且有意义的留白**：桌面浮窗四边统一使用 8px stage inset，尽可能铺满视口；圆角、边界和阴影负责表达“悬浮画布”，不靠大面积空白。
4. **唯一数据强调色**：琥珀色用于当前周期、选中态、Pending 和少量关键数值；状态色必须同时带文字、符号或明确状态。
5. **数字可核对**：金额、数量、比例、日期和时间戳使用 DM Mono / numeric stack + `tabular-nums`；不使用 Terminal 的 `text-term-*` 类。
6. **文案克制**：每个可见元素必须可追溯到需求、真实字段 / 状态、导航或无障碍需要。避免无必要的次级标签和描述，让布局关系本身解释信息（“Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining”）。
7. **不做通用 SaaS 模板**：禁止紫色渐变、三张同形功能卡、营销副标题、假数据、装饰性 badge、客户 logo、无依据的统计数字和满屏 hover。

#### 0.4.2 桌面范围

- 2026-11-04 起的 Warm Ledger 运营及业务页面迁移**只做 desktop**。
- 不新增手机端、平板端或多断点页面适配，也不把手机视口纳入迁移验收。
- 共享壳已有的手机逻辑保持原样，但不得为了 V4 页面迁移扩大其范围或新增第二套移动布局。
- C3 的浏览器验收使用 `1440x900`；后续阶段如无新的用户决定，继续以桌面视口为门槛。
- 桌面浮窗使用等宽 8px 外沿；移除 1840px 宽 / 960px 高的窗口上限，让工作窗填满扣除外沿后的可用视口。

#### 0.4.3 组件与迁移边界

1. **页面先行，组件后置**：页面专用表格、筛选、上传流程、对话框和导出 UI 先留在页面目录，用 route-local CSS Module 实现。
2. **真实第二消费者才晋升**：只有一个页面使用时，不建立全局 Warm Button/Table/Chart 抽象；第二阶段集中排查后，若两个真实页面契约一致，再提交组件晋升。
3. **不混用体系**：V4 页面不得同时套 `--term-*`、Terminal 控件默认样式和 Warm token；共享业务 hook 可以复用，视觉表面必须保持 V4。
4. **业务契约不变**：视觉迁移不得静默改变 endpoint、URL、筛选语义、排序、分页、权限、写操作、公式、导出列或文件名。
5. **状态必须真实**：loading / error / empty / zero-data 分离；没有真实数据时不用装饰性样例填充。

#### 0.4.4 AI 协作

新增或重做 V4 UI 时，AI 必须先说明：

1. 用户任务、真实数据与文案来源；
2. 对齐的 Warm Ledger 页面 / 组件，而不是笼统的“modern”；
3. 唯一视觉与操作主角；
4. desktop 布局与受影响的 shell 区域；
5. 复用的 `--warm-ledger-*` token、Warm controls 与页面本地样式；
6. loading / empty / error / permission / long-content 状态；
7. 是否需要动效；没有明确收益就不加。

#### 0.4.5 明暗主题

V4 Warm Ledger 支持暗色、浅色与跟随系统三种模式，主题偏好沿用现有全局选择器（`light` / `dark` / `system`，由 next-themes 写入 `html` 的 `light` / `dark` class）。

1. **暗色是 B0 冻结基线**：暗色 token 值与 `2026-11-01` foundations 记录一致，不因浅色工作改动。
2. **浅色为“账本纸白”**：浅中性灰舞台、近白工作窗、微暖灰侧栏、白色面板；层级由表面差、细边界和克制阴影表达，不另造布局、圆角或密度。
3. **强调色按主题分工**：暗色一般强调保持琥珀 `#e8b35a`；浅色一般强调改为森林绿 `#0f6b57`。正向状态在浅色使用 `#2a7130`，与一般强调分开；负向状态保持红色语义。
4. **实现位置**：浅色覆盖写在 `components/dashboard-v2/warm-ledger/shell/theme.css` 的 `html.light .warm-ledger` 块，只覆盖 `--warm-ledger-*` 语义 token（含 `--warm-ledger-color-on-accent`、浮层阴影、遮罩）。
5. **不在主题切换中改变业务**：路由、数据、筛选、写操作与导出契约不随之变化。
6. **不覆盖例外区**：AI Chat、登录、纸张文档画布与强制暗色展示页继续遵循 §1 的独立规则。

新增或修改 V4 组件时，颜色一律走 `--warm-ledger-*` token；禁止在页面或组件里写死暗色 / 浅色字面值。明细见 `docs/superpowers/specs/2026-11-10-v4-light-mode-design.md`。

完整反 AI Slop 规则继续适用于 V4；但 V3 的零圆角、`--term-*`、1px 全平铺和 Terminal 组件清单不再是 V4 的设计要求。

---

## 1. 刻意例外清单（Deliberate Exceptions）

以下区域使用独立视觉或保留历史体系，不是漏改。修改前先读对应条目。

### 1.1 AI Chat 双主题独立设计区（`components/chat/*`）

- `components/chat/*`、`app/dashboard/ai/page.tsx` 与 `app/dashboard/ai/chat/*` 是独立设计语言，不走 Warm Ledger token。
- 现状跟随系统 light / dark，保留 Raycast 风玻璃与纸感；若统一，需先做整页设计决策。

### 1.2 文档渲染白底（`page-render` / `page-renderer`）

- HTML 预览 iframe 的 `bg-white` 是“纸张画布”底色；Markdown 分支继续走主题 token。
- 保持现状，避免用户上传文档的观感被主题污染。

### 1.3 数字大屏与投屏模式

- `system/digital-display` 与 `ai/digital-employees/office?mode=presentation` 是恒暗展示页，保留强制 dark 和全屏行为。

### 1.4 dashboard 外壳覆盖

- 所有 dashboard 页面均已纳入 Warm Ledger；路由级加载骨架也使用 Warm Ledger 表面。
- dashboard 布局不再提供旧 Terminal 外壳回退。AI Chat、数字大屏与虚拟办公室投屏使用 Warm standalone 边界，保留各自的全屏/强制暗色行为。
- V3 文档与截图只作历史追溯，不得作为新页面实现依据。

### 1.5 `dashboard-v2` 目录命名

- `components/dashboard-v2/` 是历史目录名；其下的 `warm-ledger/*` 已属于 V4。
- 目录名不代表设计版本，也不构成把 Warm Ledger 保持在“实验性”状态的理由。

---

## 2. Token 使用红线（V4 口径）

1. **新 V4 UI 只用 `--warm-ledger-*`**：不得新写 `--term-*`、`term` Tailwind 色组或 Terminal 默认组件样式来替代 Warm token。
2. **不裸用硬编码色**：页面 CSS Module 使用 Warm token；确有图表或第三方样式无法接入 token 时，必须在局部注释说明来源与作用域。
3. **不覆盖全局默认**：不得为了单页效果改 `components/ui/*`、`--term-*`、全局 `--background*` 或其他路由的默认样式。
4. **浮窗几何**：四边 8px stage inset、可用视口铺满、22px 窗口圆角；禁止重新引入 1840px / 960px 的桌面上限。
5. **表格粘性表头**：使用 Warm 的不透明 Panel / Raised 表面，避免滚动时透出下层；禁止用 `bg-term-*` 修补 V4 表格。
6. **状态与数值色**：琥珀、Positive、Negative 等只按语义使用；颜色不能单独承载意义。
7. **圆角 / 阴影**：新代码使用明确的 Warm radius / shadow token；不新增随机像素值，不把全站改回 V3 零圆角。
8. **桌面优先**：新增 V4 页面样式不写手机端 media query；必须先解决桌面信息层级，再谈未来是否单独立项适配。

---

## 3. 文档地图

| 主题 | 文档 | 说明 |
|---|---|---|
| V4 全局设计规范 | `frontend/docs/design-spec.md` | 版本权威、红线、例外 |
| V4 Warm Ledger foundations | `docs/design-drafts/2026-11-01-operations-dashboard/components/foundations/spec.md` | token、布局、字体、状态、桌面契约 |
| V4 冻结与批准记录 | `docs/design-drafts/2026-11-01-operations-dashboard/components/foundations/freeze.md` | exact routes、desktop canvas、用户决策 |
| V4 页面基准 | `docs/design-drafts/2026-11-01-operations-dashboard/design.md` | Warm Ledger 方向与页面结构 |
| V4 推广 / Agent Team | `docs/design-drafts/2026-11-01-operations-dashboard/components/rollout.md` | 类目批次、并行边界、DeepSeek Max 实施与 Luna Max 审阅 |
| V3 Terminal 历史 | `docs/terminal-design/master-prompt.md` | 历史与未迁移路由维护，不再是 V4 设计权威 |
| V3 表格历史 | `frontend/docs/table-spec.md` | V3 存量表格契约；V4 页面不直接沿用 |
| 动效基础 | `frontend/docs/motion-system.md` | `u-*` / duration / ease 可复用；视觉表面按 V4 重写 |
| V2 总纲（存档） | `docs/FRONTEND-DESIGN-SPEC.md` | 历史记录；与 V4 冲突时以本文档为准 |
