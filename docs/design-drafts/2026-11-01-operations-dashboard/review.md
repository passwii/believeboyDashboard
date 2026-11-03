# 设计稿审阅记录

> 审阅方式：3 个独立子 Agent 并行审阅，只读不修改。
>
> 基线：`47920ed`。
>
> 状态：G0 已关闭；`/dashboard` 已按 Warm Ledger 直接生产实施，并完成代码、响应式、交互与构建验证。

## 1. 审阅分工

| Agent | 范围 | 结论 |
| --- | --- | --- |
| Lorentz | unslop 九轮与 checklist | 方向和记录成立，初稿未严格闭环；存在小字、对比度、X 轴错位、矮屏裁切等问题 |
| Aristotle | 旧草稿 vs 新草稿、可实现性 | 现有 React/Next.js 无技术阻断；核心业务能力可实现；静态稿有未实现交互与集成决策 |
| Gauss | 组件 inventory 与下一阶段批次 | B0 基础契约后，B1–B6 可并行；B7 最后做 assembly 与 QA |

第二轮由 Lorentz / Aristotle 针对当时列出的修复项复核。A0F 本轮补齐了后续发现的 Pending Critical、基础状态和批次 ownership；这些修订尚未由 R1 再次复核。

## 2. 结论

### unslop

初稿不是“九轮已闭环”，只是“明显去 slop 的视觉稿”。

修复后：

| 轮次 | 初稿 | 当前 | 处理 |
| --- | --- | --- | --- |
| Spacing | Fail | Pass | 核心 padding/gap 回到 4px 节奏 |
| Color | Partial | Pass | `--text-muted` 提高到 `#91887c`，panel 对比度约 5.17:1；faint 仅用于分隔线 |
| Icons | Partial | Pass | 图标尺寸统一到主线 18px，活动图标不再单独换 accent |
| Copy | Partial | Pass | 移除 ORD/PND 与 Pending 混用；口径统一为“待处理” |
| Type | Fail | Pass | 正文辅助字号下限 11px；40px 以下取消负字距 |
| Layout | Partial | Pass | `min-height` 使用可用视口高度，1280×600 不再裁切 |
| Details | Partial | Pass | X 轴与数据点按 7 个类别中心对齐；非交互行移除了 hover |
| Visuals | Pass | Pass | 真实数据与曲线承担视觉重点，无装饰生成图 |
| Motion | Partial | Pass | 仅保留工作窗一次入场，移除正文二次 stagger |

### 功能实现

现有 React/Next.js 技术栈没有阻断：

- 居中工作窗、单侧栏、响应式布局：可实现。
- 当前周 vs 上周双线、SVG/Recharts：可实现。
- 项目筛选、项目排序、订单流项目展开：草稿已给出可行交互。
- 日明细、经营辅助指标、国家份额：可复用现有字段与聚合逻辑。
- 移动抽屉、focus trap、Esc、焦点恢复：草稿已实现。
- loading / empty / error：已有组件与状态契约，正式实现时接入。

仍在组件阶段实现：

- 全局搜索、通知、用户菜单。
- 真实数据联动、刷新回调和接口错误提示。
- 图表 hover/focus tooltip。
- 加载、空、错误三种页面状态。

## 3. 已修复 findings

| 严重度 | 问题 | 修复 |
| --- | --- | --- |
| Critical | 移动导航没有焦点管理 | 增加 `aria-expanded/controls`、`aria-hidden`、`inert`、焦点陷阱、Esc、焦点恢复 |
| Critical | 9–10px 辅助文本和低对比度 | 文本下限 11px；muted 调整为 `#91887c` |
| Important | 图表 X 轴与数据点错位 | 数据点、网格和结束标记改到 7 个类别中心 |
| Important | 矮屏桌面裁切 | `min-height` 改为 `min(740px, calc(100vh - 40px))` |
| Important | 静态口径伪装成控件 | 数据区间与站点改成纯文本 scope metadata |
| Important | 侧栏和顶栏重复项目选择 | 侧栏改成“工作区范围”静态摘要；顶栏保留唯一项目筛选 |
| Important | 项目排行不能排序 | 增加销售额/广告花费排序并重新渲染表格 |
| Important | 订单流不能展开 | 项目分组改成可展开 `details`，保留订单号、SKU、金额、状态、时间 |
| Important | 状态栏有无来源数据 | 按用户反馈彻底移除底部数据滚动条与状态栏 |
| Minor | 非交互行有 hover | 移除日明细和项目排行的假点击反馈 |
| Minor | 广告花费排序时排行条仍按销售额 | 排行条改为跟随当前排序指标 |
| Minor | 跨断点关闭抽屉时焦点留在隐藏按钮 | 宽屏切换时焦点移到可见工作区 |
| Critical | KPI 使用日快照、订单流 headline 使用 count/list，Pending 展示口径相互混淆 | KPI 与订单流 headline 统一使用相同项目筛选及 7 天 PT 范围的 count/list API；日表列明确为“待处理（日快照）”，不再将快照相加 |
| Important | 状态画廊缺 Button loading、Select error、OrderGroup 计数 / 列表状态及长 ID / SKU 换行案例 | 补齐状态样例，并把导航链接改为真实产品路由 |
| Important | 控件、token 与跨组件 props 没有唯一实现 owner | B2 控件归 A1 的 Warm controls wrapper；A2–A5 只消费；共享 props 类型由 A6 维护；foundations 文件对 A1–A5 只读 |

## 4. Damon 已确认的方向

- Warm Ledger 作为完整首页设计方向。
- 保留 `DiagnosticStrip` 和项目排行排序。
- 订单分组默认收起。
- 首版深色-only；浅色主题延期。
- Pending KPI 与订单流 headline 使用同一 count/list API、同一项目筛选和 7 天 PT 窗口；日表 Pending 明确为逐日快照。

## 5. G0 已关闭

1. 新增“运营总览” → `/dashboard`，保留“数据流总览”；四个 QuickLink 已固定。
2. 生产直接使用新设计，不设 feature flag。
3. 项目级 Pending 分布暂不展示，直到完整 API-backed 项目总数就绪。
4. 精确 `/dashboard` 旁路 `TerminalShell`；首页数据层已抽离。

## 6. 验证

- 真实生产构建：1440×900、1280×720、1280×600、1024×768、821×720、820×720、390×844、320×568。
- 所有断点 `scrollWidth === innerWidth`；桌面菜单 / 抽屉关闭按钮不可见；移动端菜单、Esc、sidebar `aria-hidden` 与焦点恢复通过。
- 项目筛选实际发出当前 / 对比销售数据、当前 / 对比国家数据和 Pending 订单请求。
- 排序、刷新、搜索、通知、个人资料、项目排行下钻、Pending 订单跳转与今日出单跳转均通过真实浏览器检查。
- 底部数据滚动条和状态栏不存在，`tickerCount = 0`。
- 浏览器无产品错误；仅本地 Vercel Analytics / Speed Insights 请求 404。
- `pnpm test`：295 files / 2308 tests passed。
- `pnpm build`、目标 ESLint、`git diff --check` 通过。

## 7. 对旧稿的判断

应保留的旧稿优点：

- 深色工作窗和 272px 侧栏。
- 大号周期标题与非对称指标卡。
- 安静的表面、等宽数字和单一主图。

不应保留的旧稿内容：

- 银行卡 stack、虚构 Plans。
- 3M/6M/12M 假周期。
- 四色彩虹线、glow、mirror。
- 无动作的币种选择器和 `⌘K` 装饰。

## 8. A0F 修订记录

- KPI、订单流 headline 和日快照分开定义；index 中的 `73` 只表示 count API 在当前项目 / 日期范围的总数示意，不再对应日快照加总或项目分组加总。
- `1050px` 统一为堆叠断点；窄屏标题移除负字距；工作窗入场只保留 fade 与 translate。
- `states.html` 补齐 Button loading、Select error、OrderGroup count 0 / list loading / empty / error、长 Order ID / SKU 示例。
- 4px spacing、<=820px 触控目标和导航焦点双向迁移同步写入 foundations 契约。

## 9. 生产实施复核

最终复核补修了以下问题：

| 严重度 | 问题 | 修复 |
| --- | --- | --- |
| High | 筛选变化时 Pending 旧列表在新请求期间残留 | 入参变化立即清空旧 `items/total/error`，再拉第 1 页 |
| High | 加载下一页时 “加载更多” 未禁用，可能跳页 | `listLoading` 合并 `loadingMore`；加载更多不再触发指标骨架 |
| Medium | 旁路 `TerminalShell` 后全局搜索按钮无监听器 | 精确 `/dashboard` 分支单独挂载 `SearchCommand`，补 layout 测试 |
| Medium | 通知入口缺失 | 接真实通知 Provider，增加 Warm 通知面板、未读 badge、全部已读和通知跳转 |
| Medium | 项目排行与今日出单没有下钻 | 项目名按钮进入销售数据；今日出单携带订单号进入订单信息，order-info 已支持 URL 预填 |
| Medium | 项目列表失败时筛选器仍像有效控件 | 禁用筛选、`aria-invalid`、关联错误说明 |
| Medium | 同一 Pending 请求重复播报 loading / alert | count 与 list 共用请求时只保留一条状态 / 错误播报 |
| Medium | 跨断点时焦点先落入 inert sidebar | 先迁移菜单焦点，再设置 `inert` |
| Low | 根文档语言为 `en`，字体 token 使用未加载字体 | 根语言改为 `zh-CN`；Warm token 使用项目实际自托管的 font 变量 |

## 10. 上线后视觉精修

Damon 反馈生产 dark mode 表面过黑、画布利用率偏低、侧栏图标与标题对齐需打磨，并要求项目筛选不要继续使用原生 HTML 下拉。本轮修订：

- 暖灰阶整体提亮，补开工作窗、侧栏、面板与抬起状态之间的层次；顶部内高光增强，外阴影减轻。
- 桌面外沿改为 12px、窗口最大宽度 1680px、正文水平内边距 24px。
- 侧栏调整为 280px，导航固定 18px 图标轨道并给 Lucide SVG 显式设 18px / 1.55 stroke。
- 项目筛选替换为 Warm Select：自绘菜单、当前项勾选、键盘导航、Esc 关闭、44px 触控目标和错误描述由 Radix Select 提供。
- 独立设计 HTML 同步为自绘 listbox，并确认 20 个项目选项、选择联动、Esc 关闭且无脚本错误。
- 当前生产构建通过；本次未重跑测试套件。

## 11. 2026-11-02 深色层次与画布精修

生产使用反馈指出原表面仍偏黑、桌面内容空间偏窄、侧栏图标与标题列需要更稳定的对齐。本轮调整：

- 灰阶提升到 Stage `#1c1d1d`、Window `#242525`、Panel `#2b2c2b`、Raised `#3b3c3b`，并提高 hairline 与顶部高光层级；琥珀数据色保持不变。
- 工作窗最大宽度改为 1840px，外沿 8px，正文内边距 20px；首页内容容器最大宽度改为 1600px。
- 侧栏导航和 QuickLink 统一 20px 图标轨道、8px 图文间距和 36px 行高，分组标签沿标题列起始线排布。
- 首页项目下拉已由 Radix Select 实现 Warm 视觉与键盘交互。未迁移页面的原生下拉会在相应页面批次中按业务语义逐项替换。
- Muted 文本 `#a9a297` 对 Panel `#2b2c2b` 的对比度为 5.54:1，对 Window `#242525` 为 6.08:1。
- 独立 HTML 预览已在 1440×900 和 390×844 复查，并更新桌面 / 移动截图；生产组件的整批浏览器 QA 留到 C1 页面稳定后一起做。

以上代码改动尚待生产组件的整批视觉复核；本节记录设计决策，不代表上线状态或最终验收。
