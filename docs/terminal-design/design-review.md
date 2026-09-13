# 终端化设计 · 整体 Review（BLF-809 交付后复盘，2026-08-25）

> ⚠️ 历史文档：文中「GUI / 桌面端」指已删除的 `gui/`（Rust + GPUI）方案 —— 该目录已于 2026-09-13 整体删除（BLF-1041），桌面端路线改为 SwiftUI，见 [`macos/PLAN.md`](../../macos/PLAN.md)。本文的 **Web 端**终端化结论仍然有效。

> 范围：commit `9e47d99a`（高密度交易终端外壳）+ 后续 BLF-797/796/795 相关 GUI 组件。2026-08-25 二次复核见文末第五节。
> 结论先行：**架构方向正确、骨架质量高，可以在此底座上继续推进；主要问题是「密度过小」和「页面覆盖不均」，下一步先做全局放大一档，再逐页精细化打磨。**（更新：放大已完成两档，密度问题闭环；当前主要矛盾转为页面覆盖不均与跨 issue 改造协调。）

## 一、做对了的（保留，不要推翻）

1. **设计令牌体系成立**
   - `frontend/app/globals.css` 中 `--term-*` 明暗两套（bg #0c0c0e / panel #131316 / raised #1a1a1e / hover #232329 / 双层 border），语义微色三件套 `--term-pos/warn/neg` + `--term-accent`，Tailwind `term` 色组已接入。
   - 数值统一 `font-mono`（JetBrains Mono）+ `tabular-nums`，符合金融终端规范。
2. **外壳组件化清晰**
   - `components/terminal/terminal-shell.tsx` 组合 rail / subnav / header / canvas / inspector / footer 六区；尺寸集中在 `terminal-constants.ts`（TERMINAL_RAIL_WIDTH=50、SUBNAV=200、HEADER=36、FOOTER=24、INSPECTOR=288）单一来源。
   - 折叠状态 localStorage 持久化（`bb.terminal.*`）、⌘K 命令面板、⌘B Inspector 开关均已接通。
3. **Viewport-Bound 达成**
   - 外壳 `h-dvh + overflow-hidden`，document 不出现滚动条；Canvas 内 `#main-content` 独立滚动 + `term-scroll` 自定义滚动条。
4. **视觉纪律执行到位**
   - 无 Box-Shadow、`rounded-none`、全部 `1px solid var(--term-border)` 分割，符合规范第 1 条。
5. **有测试护栏**
   - terminal-footer / terminal-subnav / use-terminal-layout / daily-analysis-table 均有单测，改尺寸时先跑测试再动。

## 二、问题清单（本次要解决的）

| # | 问题 | 证据 | 影响 | 处理 |
|---|------|------|------|------|
| P1 | **元素整体偏小** | 基准字号 13px；徽标 9px、辅助文本 10px、面板标题 11px；控件 h-6/h-7；行高 ~28px | 长时间阅读疲劳，低分屏/外接显示器更明显 | **全局放大约 +15%（见 master-prompt §任务 0 的对照表）** |
| P2 | **尺寸双源漂移风险** | `terminal-constants.ts` 有常量，但组件里仍有硬编码 `w-[200px]`、`h-[36px]` 类 | 放大时改一处漏一处 | 放大时以 constants 为源，组件内一律引用常量或 CSS 变量 |
| P3 | **页面覆盖不均** | 仅首页（dashboard/page.tsx）试点终端化；operations / advertising / finance / reports / crm / system 大部分页面仍是旧风格 | 视觉割裂 | 按 master-prompt §任务 2 分批逐页打磨 |
| P4 | **可访问性欠账** | 9–10px 文本、h-6 点击目标偏小、部分 focus 态依赖默认 ring 被 `focus:ring-0` 关闭 | 可用性 | 放大后复核；交互控件最小 24px 命中区、键盘焦点必须有可见样式 |
| P5 | **移动端回归未完成** | metadata 记录「移动端 Playwright 回归待补跑」 | 折叠 Sheet 路径未验证 | 打磨批次中安排一次 |

## 三、放大策略选型（已定：B 方案）

- ~~方案 A：根元素 zoom / html font-size 整体缩放~~ —— 快但钝，会把第三方弹层、ECharts 提示框一起放大，且与 shadcn 组件像素规格打架。
- **方案 B（采用）：令牌级放大** —— 直接调 `TERMINAL_*` 常量 + 字号阶梯 + 控件高度三组值，一次 PR 完成，可控、可测、不伤第三方 UI。具体数值见 `master-prompt.md` §任务 0。

## 四、后续推进方式

本 issue（BLF-809 主框架）已完成交付并 done。后续工作不在本 issue 内开新 stage，由 Yawei 携带 `docs/terminal-design/master-prompt.md` 到外部工具直接推进；如需回到 Multica 拆 issue，按该文件的批次表建子 issue 即可。

## 五、2026-08-25 二次复核增量（本轮打磨）

对两份文档与代码实态逐项比对后的结论：

1. **任务 0 已超额完成**：实际落地两档放大（31117bdc / 3bed4693，#395），最终常量 64/256/48/32/360。master-prompt §任务 0 已改标「已完成」，并明确 `terminal-constants.ts` 为唯一尺寸来源，后续调整勿回改文档表格数值。
2. **尺寸双源风险基本消除（原 P2）**：框架级尺寸（rail/subnav/header/footer/inspector）已全部收敛到 `terminal-constants.ts`，组件内已无 `w-[200px]` / `h-[36px]` 类框架尺寸硬编码（grep 验证）。局部元素仍有字面量（图标 `h-[18px] w-[18px]`、弹层 `w-[300px]`/`w-[340px]` 等），属元素级有意为之；唯一保留小字号是 header 未读徽标 text-[11px]，属角标语义有意为之，不算回退。**但顶部区块高度仍有一处双源残留**：Rail Logo 位借用 `TERMINAL_RAIL_WIDTH` 当高度、SubNav 组头与 Inspector 标题条硬编码 `h-10`，与 Header 的 48px 不一致——详见第六节 P6。
3. **页面覆盖率仍低，且新增协调风险（原 P3 升级）**：Web 端仅 order-info / daily-analysis / ad-analysis 套用终端风格；桌面端 GUI Stage12 另有 20 模块迁移（#398）、Stage13 进行中（BLF-804），BLF-826 正在集中规划 Header 筛选集成。**剩余页面开工前必须先查这三个 issue 是否已覆盖该页**，否则会重复改造甚至互相冲突——这是当前最大的流程风险。
4. **可访问性改善中（原 P4）**：Rail/SubNav 焦点态已有 term-hover 可见样式；9-10px 文本已随两档放大消除。剩余欠账：部分交互控件命中区仍待复核 ≥24px。
5. **移动端回归（原 P5）**：已随任务 0 完成，闭环。
6. **新发现的可改进点（低成本高收益，建议排批次间隙优先）**：
   - ⌘K 命令面板未消费已有 recents 数据——readRecents/pushRecent 已在 shell 与 Inspector 落地，search-command.tsx 补一个「最近访问」分组即可闭环（改造要点已细化到 master-prompt §任务 3a）。
   - Inspector Live Stream / Quick Actions 仍是占位内容，可接真实数据源（Quick Actions 静态配置即可闭环，见 §任务 3b；Live Stream 需后端配合）。
   - Footer Ticker 频道开关已收敛到 TERMINAL_TICKER.channels，后续新增频道（如库存预警）只改常量即可，无需动组件（新频道预案见 §任务 3c）。

## 六、2026-08-25 三次复核增量：顶部基准线对齐（P6，用户复核提出）

用户复核指出「head 高度和 sidebar 顶部分割线是否对齐」，grep 核实属实：

| 列 | 顶部区块 | 当前高度 | 来源 |
|---|---|---|---|
| L1 Rail | Logo 位 | **64px** | `style={{ height: TERMINAL_RAIL_WIDTH }}`——借用宽度常量当高度，语义错位 |
| L2 SubNav | 组头 | **40px** | 组件内 `h-10` 字面量（terminal-subnav.tsx:64）|
| 主列 Header | 整条 | **48px** | `TERMINAL_HEADER_HEIGHT` ✓ 唯一正确引用 |
| Inspector | 标题条 | **40px** | 组件内 `h-10` 字面量（terminal-inspector.tsx:50）|

四列顶部第一条横向分割线落在 y=64/40/48/40 四个不同位置，视觉上锯齿错位。

**结论与方案**：新增 `TERMINAL_TOP_STRIP_HEIGHT = TERMINAL_HEADER_HEIGHT`（表达式绑定，跟随 Header 联动），四处顶部区块统一引用。完整改造步骤、测试护栏与验收标准已写入 master-prompt.md §任务 1。该项优先级高于其余外壳增强项（纯外壳改动、零页面依赖、视觉收益立竿见影）。

## 七、2026-08-25 四次复核增量：微细节系统化规范（P7，用户复核提出）

用户澄清：顶部分割线只是举例——sidebar / 外壳布局上的这类**微细节**（字号、图标等）需要系统性打磨并写好规范。

本轮对 shell 六区组件（rail / subnav / header / inspector / footer + term-panel/term-table/search-command）做了字号、图标尺寸、strokeWidth、控件高度、大小写字距的逐项 grep 审计，结论：

- **阶梯已隐式存在但未成文**：字号实际在 12/14/16 三档、图标在 14/16/18px 三档、控件在 h-4~h-10 五档上收敛，但从未写进文档，外部工具照 master-prompt 施工时无从遵守；
- **审计出 7 处偏离点（A1–A7）**：最实质的三处是 Header 全部图标漏设 strokeWidth（吃到 lucide 默认 2，与 Rail/SubNav 的 1.75 观感不一致）、Footer 整条 font-mono 把中文标签也 mono 化（违反硬约束第 3 条「仅数值 mono」的本义）、kbd 两处手写实现漂移；其余为字距/档位小漂移。

**交付物**：完整阶梯表（字号四档 / 图标三档 / 控件高度五档 / 字距规则 / kbd 共享组件方案）+ A1–A7 收编清单已写入 `master-prompt.md` §任务 1b；硬约束同步补第 10 条「微细节按阶梯取值」。实施建议：A1–A7 一个 PR 收编（可与 §任务 1 同分支先后合入）。
