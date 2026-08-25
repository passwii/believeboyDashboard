# 终端化设计 · 整体 Review（BLF-809 交付后复盘，2026-08-25）

> 范围：commit `9e47d99a`（高密度交易终端外壳）+ 后续 BLF-797/796/795 相关 GUI 组件。
> 结论先行：**架构方向正确、骨架质量高，可以在此底座上继续推进；主要问题是「密度过小」和「页面覆盖不均」，下一步先做全局放大一档，再逐页精细化打磨。**

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
