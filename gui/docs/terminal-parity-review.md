# Terminal UI 复刻度 Review（GUI vs Web 前端）

> 2026-08-30 · 应用户要求逐面核对桌面端是否全盘复刻 `frontend/components/terminal/*`
> 的终端化设计，尤其是 Top Header 的 slot 插槽架构。
> 基线：`terminal-constants.ts`（尺寸唯一权威）+ `globals.css --term-*`（色彩唯一权威）
> + `terminal-shell / rail / subnav / header / header-slot / inspector / footer`。

## 1. 对齐矩阵（shell 六区）

| 区 | Web 前端 | GUI 桌面端 | 状态 |
|---|---|---|---|
| L1 Rail | 64px 宽，图标 24px，8 组 | `master_rail` 64px / 24px（本次对齐 BLF-844/850/887） | ✅ 1:1 |
| L2 SubNav | 224px，折叠归零 + 动效 | `sub_nav` 基准 224（自适应 200~260）、折叠归零 + 宽度动画；**空态（着陆页）零占位**（本次修复：无选中分类列宽 0，选中分类带动画展开） | ✅ 1:1（空态行为 GUI 更贴合客户端） |
| Top Header | 56px，slot 插槽 | `console_bar`：面包屑 + 按页声明式筛选插槽（project/country/date/stat）+ 用户簇 + Windows caption buttons | ✅ 同构（详见 §2） |
| Inspector | 360px（⌘B） | 360px 默认、320~420 拖拽、⌘B 三态内容（运营/广告/AI 形态注册表） | ✅ 1:1（GUI 多拖拽调宽） |
| Footer | 36px 多频道 ticker | `footer`：汇率 ticker / DB 同步 / 未读徽标 / P95 延迟 | ✅ 1:1 |
| Canvas | 100vh 钉死、仅 Canvas 内滚 | 同（`shell-upper` 行 + `canvas` flex_1；本次修复 center-col 缺 `.flex()` 导致内容塌缩的 Block 布局 bug） | ✅（修复后） |

## 2. Top Header slot 插槽架构对照

Web 端：`terminal-header.tsx`（固定 chrome：面包屑/搜索/通知/用户）+
`terminal-header-slot.tsx`（`HeaderSlotMount` / `useTerminalHeaderSlot`：页面把内容
挂进头部）+ `header-filter-suite.tsx`（HeaderProjectSelect / HeaderCountrySelect /
HeaderDateRangePicker / HeaderSlotSelect / HeaderSlotDateRange / HeaderKpiTile 四件套
与自定义插槽）。

GUI 端：`widgets/console_bar.rs` —— `console_config_for_url(url)` 按页声明
`{project, country, date, stat}`（对齐 header-filter-suite 的四件套），页面经
`ConsoleStatsEvent` 把 KPI 推进头部 pill（对齐 HeaderKpiTile），切页由
`sync_console_config` 声明式换装且保留用户已选筛选值（对齐 global-filter-context 的
全局态语义）。

**结论：slot 思想一致——「头部是壳，内容由页面声明」。差异：**
- Web 的 slot 由页面组件任意挂载（HeaderSlotMount 完全自由）；GUI 目前收敛为
  四件套 + KPI pill 的固定插槽，自定义 slot 未开放（客户端收益高的下一步：把
  `ConsoleBarConfig` 扩展出页面自定义 slot 区）。
- Web Header 有全局搜索键（OPEN_SEARCH_EVENT）+ 通知铃铛 + 手动刷新；GUI 对应
  能力分别由 ⌘K 命令面板 / Footer 未读徽标 / 页面刷新按钮承担，头部未放同款图标。

## 3. 设计令牌

- 色彩：`--term-*` 明暗两套已 1:1 收口进 `theme.rs`（bg/panel/raised/hover/border/
  text/muted/faint/accent/pos/warn/neg），回归锁 `dark_utility_background_stack_contract`
  锁定。✅
- 数值排版：金额/订单号/时间戳 mono + tabular（JetBrains Mono 内嵌）+ pos/warn/neg
  语义色，表头/行共享水平度量（CELL_PX/COL_GAP 单一来源）。✅
- 间距：4/8/12 档位 + 控件高两档 24/28。✅
- **已知差异 ①（待收口）**：Web 终端硬约束「禁圆角」（rounded-none）、层级全靠
  1px 边界；GUI 保留 gpui-component 主题圆角（radius 6/8px），KPI 磁贴 / 卡片 /
  按钮仍带圆角。需按「圆角归零」专项逐批收口（radius token 源头改 0 即可全局生效，
  预计小改动，但涉及与 gpui-component 组件观感的一致性，建议单独 issue）。
- **已知差异 ②**：Web 明暗两套主题活跃（明暗切换）；GUI 锁深色（BLF-792 决策，
  浅色板休眠但已同步 term 明色集）。

## 4. GUI 超出 Web 的客户端增强（不违背终端风格）

- ⌘K 命令面板（52 模块检索跳转）
- 三档密度（紧凑/标准/宽松，rem 驱动全局缩放）
- Inspector 拖拽调宽（320~420）+ 偏好持久化
- 平台 chrome：macOS traffic lights / Win11 Fluent 自绘 caption buttons（最小化/
  最大化(带 Snap Layouts 浮层)/关闭）+ 窗口拖拽区 + 双击最大化
- 登录页记住密码（系统凭据库）

## 5. 跟进清单

1. **DataGrid 表头折叠坍塌（P1，本次遗留）**：已修复表体塌缩（center-col 缺
   `.flex()` 的 Block 布局根因 + hscroll flex 链补齐）——行数据/滚动/分页/聚合
   全部正常；**表头行仍被布局成 ~6px 细条**（列名被竖向裁剪叠字）。实锤证据：
   进入表格页时运行日志出现大量 `can't render at a zero size`（表头单元格拿到
   0×0 bounds），而数据行与表头读同一 `widths` 向量且正常 → 嫌疑集中在表头
   `h_flex` 行的布局请求链（28px 固定高被上层 0 约束覆盖）。建议专项：dev 构建
   逐层着色/用 gpui inspector 定位给零约束的父层。
2. 圆角归零专项（对齐 web `rounded-none` 硬约束）。
3. Header 自定义 slot 开放（`ConsoleBarConfig` 扩展页面私有插槽区）。
4. 命令面板二次 ⌘K 不弹（首次可用；重启恢复，待查焦点链）。
5. DataGrid 视觉回归锁定：表头修复后补一张全高度渲染截图基线进 `docs/`。
