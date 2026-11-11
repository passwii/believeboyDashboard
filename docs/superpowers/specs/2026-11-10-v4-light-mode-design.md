# V4 Warm Ledger Light Mode 设计

日期：2026-11-10  
状态：设计方向已由用户确认并已实施 Batch 1（2026-11-10）  
配套文档：[V4 全局设计规范](../../../frontend/docs/design-spec.md)、[Warm Ledger Foundations](../../../docs/design-drafts/2026-11-01-operations-dashboard/components/foundations/spec.md)、[主题模式选择器](../../../frontend/components/terminal/theme-mode-picker.tsx)  
范围声明：定义 Warm Ledger V4 浅色主题及明暗模式边界；不改变业务数据、业务流程或主题选择器行为。

## 0. 决策摘要

| 议题 | 结论 |
| --- | --- |
| 适用范围 | 所有现有 Warm Ledger V4 运营与业务页面。 |
| 浅色视觉方向 | 采用“账本纸白”：中性近白工作面、轻暖灰侧栏、白色面板，以细边界和克制阴影区分层级。 |
| 浅色强调色 | Light Mode 中所有当前琥珀强调角色改用绿色，包括导航与控件选中态、焦点、关键数值、当前周期图表系列、Pending 强调及相应柔和区域。 |
| 深色主题 | 保留当前 Warm Ledger 暗色 token 和琥珀强调映射。 |
| 模式选择 | 沿用现有“浅色 / 深色 / 跟随系统”选择、系统适配与 next-themes 持久化。 |
| 例外区域 | AI Chat、登录、纸张文档画布、强制暗色数字大屏与投屏场景继续遵循各自现有规则。 |
| 页面范围 | 保持 V4 的桌面验收范围；不新增移动布局或断点。 |

## 1. 背景与目标

Warm Ledger 当前的基础规范以暗色为首版，Light Mode 当时被明确延期。全局主题能力已提供浅色、深色和系统模式，但 Warm Ledger 的 token 与原生控件色彩方案仍按暗色配置。用户已确认把 Light Mode 扩展到全部 Warm Ledger V4 页面，并沿用现有主题偏好。

Light Mode 的目标是在日间环境保持高密度运营信息的扫描性，同时保留 Warm Ledger 的克制层级、账本式信息组织、圆角工作窗和绿色数据强调。主题变化只影响视觉映射，不改变数据含义、页面结构或操作结果。

## 2. 范围与边界

### 2.1 纳入范围

- 所有当前使用 Warm Ledger 的 V4 运营与业务路由。
- Warm Ledger shell、导航、筛选控件、指标、图表、表格、弹层、菜单、通知及这些组件的 hover、selected、focus、disabled 状态。
- loading、empty、error、权限和长内容状态在 Light Mode 下的表面与文字映射。
- 手动浅色、手动深色和跟随系统三种模式下的 Warm Ledger 呈现。

### 2.2 独立主题边界

| 区域 | 规则 |
| --- | --- |
| AI Chat | 保留其独立的明暗主题与 Raycast 风玻璃 / 纸感设计。 |
| 登录 | 保留已有登录主题与布局，不套用 Warm Ledger 组件视觉。 |
| HTML 文档预览 | 白色 iframe 是纸张画布，继续保持白底；Markdown 内容按其主题 token 呈现。 |
| 数字大屏与投屏 | 保留强制暗色、全屏与现有展示行为。 |
| V3 Terminal 未迁移区域 | 保留存量主题及组件规则，不借 V4 Light Mode 改写全局旧 token。 |

桌面 V4 继续以 1440×900 作为验收视口。现有共享壳窄屏行为保持原样；本次不增加手机或平板布局。

### 2.3 非目标

- 不改变路由、导航条目、接口、筛选、排序、分页、权限、写操作、导出或业务公式。
- 不新增主题设置页、服务端偏好字段或独立存储 key。
- 不重做暗色主题，不修改全局 shadcn / Tailwind 默认值，不把 V4 样式迁回 V3 的零圆角 Terminal 体系。
- 不加入与真实字段、状态、导航或无障碍无关的装饰、数据或说明文案。

## 3. 浅色视觉系统

### 3.1 表面与层级

以用户选择的 B“账本纸白”为视觉基准：

- Stage 使用浅中性灰；Window 接近中性白；Sidebar 保留轻微暖灰；Panel 使用白色；Raised 使用极淡灰绿中性色。
- 通过相邻表面亮度、细边界和短而柔和的阴影表达工作窗、侧栏、面板和控件层级。边界足够清楚以区分可交互控件；分隔线保持安静。
- 保留暗色版本的尺寸、圆角、留白、字体、数字格式、内容密度和 8px 桌面 stage inset，不为 Light Mode 另造页面布局。
- 下列颜色是视觉对照中的候选起点，实施前按实际相邻表面校准，不视为最终冻结值：Stage #eff0ed、Window #fbfcfa、Sidebar #f2f2ef、Panel #ffffff、Panel strong #f7f8f5、Raised #f1f3ef、Raised hover #e9ece7。

### 3.2 强调色映射

- Light Mode 的一般强调色使用深森林绿。初始候选为 #126a50；强强调色、柔和选中底色、图表面积色和焦点色从同一绿色阶梯派生。
- 所有当前由琥珀承担的一般强调角色在 Light Mode 映射至绿色：选中导航、筛选与控件、focus-visible、关键数值、当前周期图表系列、Pending 强调、选中区域和图表面积。
- Dark Mode 完整保留当前琥珀色阶和现有状态映射，浅色绿色不会泄漏到深色模式。
- 图表比较序列继续用中性灰虚线；图例文字、线型与数值格式保留，使本周与上周仍能脱离颜色辨认。

### 3.3 状态色语义

绿色强调与绿色正向状态在 Light Mode 下需要分成独立语义 token，并用色相 / 明度差异加以区分。正向和负向状态继续显示箭头、数值符号或明确文字；Pending 保留“待处理 / Pending”文字标签。颜色不得单独承载选中、成功、失败或待处理含义。负向状态继续使用红色语义色，并检查其在白色面板上的对比度。

## 4. 主题与组件契约

- 通过现有 ThemeProvider 的已解析主题驱动 Warm Ledger token；全站仍由现有选择器管理浅色、深色和 system 模式。
- 明暗 token 限定在 Warm Ledger 范围内。普通 V4 组件、图表、表格、菜单、弹层和 portal 内容都消费同一组语义 token；不在页面中复制一套硬编码颜色。
- Warm Ledger 根节点的 color-scheme 跟随已解析模式，确保原生表单控件和滚动区域采用匹配的配色。
- 暗色 token 继续以当前 Foundations 数值为 Dark 的唯一来源。本文作为 Light Mode 的增量设计补充；不改写 B0 已冻结的暗色基线。
- 主题切换沿用当前持久化和系统跟随行为，不引入每页独立模式状态。颜色过渡继续遵守现有 reduced-motion 约束，不改变布局或滚动位置。

## 5. 无障碍、状态与验收标准

1. 普通文字与背景达到至少 4.5:1 对比度；大号文字至少 3:1。辅助文字、禁用态和图表标签逐对检查；仅用于非文本网格的 faint 色不得用作可读标签。
2. 所有交互控件保留清晰的 focus-visible 环、键盘路径、选中标记和可访问名称。绿色不是唯一的选中 / 成功提示。
3. Loading、empty、error、zero-data、permission 和 stale-data 继续遵循现有数据契约；主题切换不改变状态内容或数据口径。
4. 图表提供文字图例与摘要；比较线型、正负方向符号和 PT 日期口径在两个主题下保持可辨。
5. Dark、Light、System 三种模式在 Warm Ledger 路由上稳定切换并保持偏好；用户进入独立主题区域时仍按该区域既有规则呈现。
6. 在桌面验收视口检查 Warm Ledger 首页和各类代表性表格、图表、筛选、菜单、弹层及数据状态；窄屏验收不扩展本阶段范围。

## 6. 建议落地顺序

1. 建立 Light / Dark 语义 token 对照表；列出全部 Warm Ledger 的颜色消费点，校准文字、交互边界、状态色和图表对比度。
2. 在 /dashboard 验证账本纸白表面层级、全绿 Light 强调和主题切换；Dark 必须与现行视觉一致。
3. 将同一 token 映射扩展到全部 Warm Ledger V4 页面、控件、弹层、图表和表格；保留页面的数据与交互契约。
4. 批量做 Light / Dark / System 状态巡检，检查对比度、键盘焦点、Pending / 正向语义、图表对比及主题例外区。

## 7. 风险与处理

| 风险 | 处理 |
| --- | --- |
| 一般强调绿色与正向状态绿色接近 | 使用独立 token 与不同的色相 / 明度，并始终保留箭头、符号或状态文字。 |
| Pending 使用绿色可能被误读为成功 | 绿色只承担强调角色，不表示业务状态；保留 Pending 文案与原有操作语义，并确保其视觉上下文不同于正向状态。 |
| 图表、下拉菜单或 portal 内存在硬编码暗色值 | 实施前盘点这些组件的颜色消费点，统一接入 Warm Ledger 语义 token。 |
| 浅色控件边界过淡 | 分开校准 quiet hairline 与交互边界；控件轮廓、focus-visible 和 selected 状态分别验收。 |

## 8. 拍板记录

- 2026-11-10：用户确认 Light Mode 覆盖所有 Warm Ledger V4 页面，并沿用现有全局主题偏好。
- 2026-11-10：用户选择 B“账本纸白”作为 Light Mode 表面方向。
- 2026-11-10：用户确认 Dark 保留琥珀，Light Mode 中所有琥珀强调角色替换为绿色。
- 本文当前状态：设计方向已确认，用户已批准开始实施。

## 9. 实施记录（Batch 1，2026-11-10）

本轮已完成 token 层与回归加固，页面层通过继承生效：

- `frontend/components/dashboard-v2/warm-ledger/shell/theme.css`：新增 `html.light .warm-ledger` 覆盖块（表面、文字、绿色强调、状态色、highlight、阴影、遮罩与 `color-scheme: light`）；暗色块数值未改。
- 抽出语义 token 并把字面值收敛：`--warm-ledger-color-on-accent`、`--warm-ledger-shadow-popover`、`--warm-ledger-shadow-dialog`、`--warm-ledger-color-backdrop`；替换下拉 / 日期浮层阴影、通知弹窗阴影与遮罩、强调按钮文字色。
- 新增 `frontend/components/dashboard-v2/warm-ledger/shell/warm-theme.test.ts`：锁暗色基线、浅色 token 完整性、色相分工、WCAG 对比、无残留硬编码阴影、无 `transition: all`。
- 文档同步：`frontend/docs/design-spec.md` §0.4.5、`components/foundations/spec.md` 的 Light Mode extension、`components/foundations/tokens.css` 的暗色新增 token + 浅色块。
- 审查修复（独立只读 Review）：新增 `frontend/lib/forced-dark.ts` 并接入数字大屏与投屏页，强制暗色时移除 `light` class、卸载时恢复原 class 与 `color-scheme`；19 处页面 CSS Module 琥珀字面值改为 `color-mix(in srgb, var(--warm-ledger-color-accent) N%, transparent)`（暗色合成等价、浅色自动转绿）；修正 `chart-code-block` 的 `--warm-ledger-color-faint` 拼写；补 `--warm-ledger-radius-pill` 与 `::backdrop` 回退。
- 测试加固：`warm-theme.test.ts` 冻结全部颜色 / 高光 / 阴影 token，扫描未定义 `var(--warm-ledger-*)` 引用与琥珀字面值，校验 next-themes class 契约与强制暗色页；新增 `frontend/lib/forced-dark.test.ts`。

## 10. 实施记录（Batch 2，2026-11-10）

按用户确认继续推进，本轮补齐浅色下的图表、导出与文字可读性：

- **分类图表色阶**：新增 `--warm-ledger-color-chart-1..5` 与 `--warm-ledger-color-chart-axis`。暗色沿用既有中性阶（`#f1ede5`…`#918a80`），浅色改为深中性阶（`#3f4a42`…`#87948b`），对白色面板 ≥ 3:1。退货原因饼图改为消费这组 token。
- **文字可读性**：浅色 `text-muted` 调整为 `#565f58`、`text-faint` 调整为 `#5f6860`，四个文字角色在 7 个浅色表面上均 ≥ 4.5:1；暗色文字值不变（暗色 faint 作为正文的历史偏差保留，需 B0 单独决策）。
- **导出 / 截图**：新增 `frontend/lib/warm-ledger-colors.ts`，从最近的 `.warm-ledger` 宿主读取已解析 token（SSR 与无宿主时回退暗色基线）。`chart-code-block` 的静态 SVG 与 AI 洞察 `toPng` 背景改为按当前主题取色，导出产物不再固定暗色。周度分析的 Tooltip 游标使用模式中立的半透明墨色（`rgba(15,23,42,0.18)`），两个主题下都成立，因此保持不变。
- **测试**：`warm-theme.test.ts` 增补 faint 4.5:1 与图表色 3:1 断言；新增 `frontend/lib/warm-ledger-colors.test.ts`（回退值、宿主解析、批量读取、空值处理）；退货分析饼图测试改为断言 token 引用。