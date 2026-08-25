# BelieveBoy Dashboard 终端化推进 Master Prompt

> 用途：在任意 AI 编码工具（Claude Code / Cursor / Codex 等）中作为完整工作指令使用。
> 使用方式：把本文件全文作为首条任务提示词发给工具，或按 §任务 分批发给它。
> 前置事实：终端外壳已合入 main（commit `9e47d99a`，PR #379）。此后已追加落地：全局放大两档（31117bdc / 3bed4693）、Footer 多频道 Ticker（BLF-816，#390）、订单信息页终端化（BLF-817，#392）、Top Header 全局筛选四件套（BLF-819，f8ef897c）、页面顶部胶囊去重（BLF-824）、L2 SubNav 折叠动效（BLF-825，#397）、桌面端 GUI Stage12 二十模块迁移（#398）。

---

## 0. 角色与项目背景（必读）

你是资深前端工程师，负责 **BelieveBoy Dashboard**（跨境电商多品牌运营中台）的 Web 前端。技术栈：Next.js App Router + TypeScript + Tailwind CSS + shadcn/ui + Radix + Vitest/@testing-library/react。仓库根目录 `frontend/` 下为前端代码。

本项目正在执行「高密度交易终端」设计改造：把传统网页升级为桌面级工作站——100vh 钉死无页面滚动、1px 边框平铺禁阴影、微间距、等宽字体数值、语义涨跌色。该外壳已落地：

- 设计令牌：`frontend/app/globals.css` 中 `--term-*`（明暗两套）+ Tailwind `term` 色组
- 外壳组件：`frontend/components/terminal/`（terminal-shell / terminal-rail / terminal-subnav / terminal-header / terminal-inspector / terminal-footer / term-panel / term-table / terminal-constants / header-filter-suite / global-filter-context）
- 布局骨架：L1 主轨 64px → L2 子导航 256px（可折叠，折叠动效见 `TERMINAL_SUBNAV_MOTION`）→ Top Header 48px → Main Canvas（`#main-content` 独立滚动）→ Right Inspector 360px（⌘B）→ Global Footer 32px（多频道滚动 Ticker）
- 全局筛选：`global-filter-context.tsx` 提供 Project/Site/Date 全局态；页面经 `header-filter-suite.tsx` 的 Header 组件族消费，页面级重复胶囊/筛选条应逐步移除（BLF-826 集中规划中）
- 页面试点：首页 `app/dashboard/page.tsx`、`reports/order-info`（Pattern A 高密度大表）、`operations/daily-analysis`（head 筛选集成）、`ad-analysis`（term-chrome）已终端化；桌面端 GUI 另有 20 模块套用同套模板

**硬约束（任何任务都不得违反）：**
1. document/window 不出现滚动条；只有 Canvas 内部区域滚动。
2. 禁用 Box-Shadow 与圆角（`rounded-none`）；面板分割一律 `border border-term-border`（1px solid var(--term-border)）。
3. 所有数值/金额/订单号/时间戳必须 `font-mono tabular-nums`，并按 `--term-pos/warn/neg` 语义着色。
4. Padding/Gap 只允许 4 / 8 / 12px 档位（个别紧凑处可 2px）。
5. 尺寸常量只从 `terminal-constants.ts` 引用，禁止组件内硬编码宽度/高度字面量。
6. 明暗两套主题都必须适配（`--term-*` 双套已存在，新增颜色必须同时补两套）。
7. 每个 PR：先跑 `pnpm lint && pnpm build && pnpm test` 全绿；涉及公共组件/hook 用 CodeGraph 或全局搜索确认调用方；commit 信息中文 Conventional Commits。
8. 移动端（<md）行为保持现状：L1/L2 收进左侧 Sheet 抽屉，Footer 隐藏。

## 任务 0：全局放大一档（✅ 已完成，保留作历史参考）

**状态：已完成且超额——实际执行了「两档」放大**（一档 commit 31117bdc，二档 3bed4693，PR #395）。下表为原始规划值，最终落地的常量以 `frontend/components/terminal/terminal-constants.ts` 为准：TERMINAL_RAIL_WIDTH=64、SUBNAV_WIDTH=256、HEADER_HEIGHT=48、FOOTER_HEIGHT=32、INSPECTOR_WIDTH=360；SubNav 折叠宽度有意归零（整列收起，仅以 BLF-825 动效呈现，非窄图标列）。后续任何尺寸调整一律以该文件为唯一来源，勿再回改本表数值。

### 0a. 结构尺寸（`frontend/components/terminal/terminal-constants.ts`）

| 常量 | 现值 | 新值 |
|---|---|---|
| TERMINAL_RAIL_WIDTH | 50 | ~~56~~ → 最终 64 |
| TERMINAL_SUBNAV_WIDTH | 200 | ~~224~~ → 最终 256 |
| TERMINAL_HEADER_HEIGHT | 36 | ~~40~~ → 最终 48 |
| TERMINAL_FOOTER_HEIGHT | 24 | ~~28~~ → 最终 32 |
| TERMINAL_INSPECTOR_WIDTH | 288 | ~~320~~ → 最终 360 |

同步排查组件内硬编码（如 subnav/header/footer 的 `w-[200px]`、`h-[36px]`），改为引用常量。

### 0b. 字号阶梯（全局统一上调一档）

| 用途 | 现值 | 新值 |
|---|---|---|
| 外壳基准字号（terminal-shell 根） | text-[13px] | text-sm (14px) |
| 徽标数字（header 未读数） | text-[9px] | text-[10px] |
| 辅助/kbd/面包屑分隔符 | text-[10px] | text-[11px] |
| 面板标题/SubNav 组名/Footer 文本/Inspector 标题 | text-[11px] | text-xs (12px) |
| 表格正文与控件文本 | text-xs (12px) | 保持 text-xs，但行高提升（见 0c） |
| Rail 图标按钮 | h-5 w-5 / text-[10px] | h-6 w-6 / text-[11px] |

### 0c. 控件与密度

| 项 | 现值 | 新值 |
|---|---|---|
| Header/Footer 内图标按钮 | h-6 w-6 | h-7 w-7（图标 h-3.5 → h-4） |
| 工具栏/筛选条高度 | h-7 | h-8 |
| 表格行高 | ~28px | ~32px（py 由 1 提到 1.5） |
| KPI 磁贴内主数值 | — | 上调至 text-base~text-lg 区间，等宽不变 |

### 验收标准（已全部达成，含移动端 Playwright 回归）

- [x] `pnpm lint && pnpm build && pnpm test` 全绿（更新受影响断言）。
- [x] 折叠态 L2 宽度 = 折叠图标列宽仍对齐 L1 主轨（后经 BLF-825 改为整列收起归零 + 动效）。
- [x] 明暗主题切换后无对比度回退。
- [x] 1280×800 与 2560×1440 两档分辨率目测协调。
- [x] 移动端 Sheet 抽屉回归完成。

## 任务 2：各页面精细化打磨（放大完成后分批做）

### 打磨单页 SOP（每页照此执行）

1. **盘点**：读目标页 `page.tsx` 及其子组件，列出旧风格残留（阴影、圆角、非 term 色、非 mono 数值、>12px 的 padding/gap、页面级滚动容器）。**同时检查页面级标题胶囊/筛选条是否与 Top Header 全局筛选重复**——重复的应移除，改接 `header-filter-suite` 组件族（BLF-824 已清一批，BLF-826 集中规划中，新页面直接按新范式写，不要再加页面级胶囊）。
2. **替换**：面板容器换 `TermPanel`；数据表换 `TermTable`（或按 TermTable 的样式规范改造现有表格）；筛选条对齐首页 h-8 工具栏规格；数值全部 `font-mono tabular-nums` + 语义色。
3. **滚动收口**：确认页面内容在 Canvas 内滚动（外层不产生 document 滚动条）；长列表优先虚拟化（参考首页 Pattern A 明细表做法）。
4. **状态完备**：loading（骨架用 term 色系）/ error（term-neg 行内提示）/ empty（term-faint 占位）三态齐备。
5. **测试**：为新改的表格/交互补最小单测（参照 `daily-analysis-table.test.tsx` 模式）；全量 `pnpm lint && pnpm build && pnpm test`。
6. **自查**：对照「硬约束」逐条过一遍，尤其明色主题下的效果。

### 批次划分（按业务价值排序，每批一个 PR）

> 进度标注（2026-08-25 复核）：批次 A 的 daily-analysis 已完成 head 筛选集成；批次 B 的 ad-analysis 已套 term-chrome；批次 D 的 order-info 已终端化。其余按表推进，**开工前先查 BLF-804 / BLF-826 是否已覆盖该页**，避免重复改造。

- 批次 A（高频数据页）：`operations/daily-analysis` ✅ → `operations/inventory-analysis` ⬜ → `operations/portfolio-overview` ⬜
- 批次 B（广告）：`advertising/ad-analysis` ✅（term-chrome）→ `advertising/ad-data` ⬜
- 批次 C（财务）：`finance/platform-revenue` → `finance/exchange-rate` → `finance/commission-management` → `finance/vat-invoices`
- 批次 D（报表）：`reports/scheduled-reports` ⬜ → `reports/order-info` ✅ → `reports/product-analysis` ⬜ → 其余 reports 页
- 批次 E（CRM）：`crm/customers` → `crm/leads` → `crm/dashboard` → 其余 crm 页
- 批次 F（系统/AI/工具）：`system/*` → `ai/*` → `tools/*`

每批次验收：该域下所有路由目测风格一致（截图对比）、无旧风格残留、测试全绿。

## 任务 3：外壳增强项（部分已完成，余项继续穿插）

- ✅ Footer 多频道 ticker（BLF-816 已完成，#390）：汇率 / 全局快报 / 同步时刻 / 更新日志四频道，频道开关集中在 `TERMINAL_TICKER.channels`，新增/下线频道只改常量不动组件。
- 🔶 Top Header 全局筛选四件套接入更多页面（BLF-819 试点完成；BLF-826 正在集中规划 HeaderSlot 集成方案，推进前先看该 issue 结论）。
- ⬜ ⌘K 命令面板「最近访问」：数据侧已就绪——`readRecents()`/`pushRecent()` 已在 shell 与 Inspector 落地，但 `search-command.tsx` 尚未消费 recents，补上即可闭环。
- ⬜ Inspector 内容源扩展：Live Stream / Quick Actions 接真实数据。
- ⬜ SubNav 动效后续：BLF-825 已交付常驻挂载 + 壳层 width 过渡（260ms ease-out-expo 类），如需「窄图标列」形态另开 issue。

## 附录：关键文件速查

```
frontend/
├── app/globals.css                          # --term-* 设计令牌（明暗两套）+ .term-scroll/.term-marquee-track + SubNav 折叠动效类
├── components/terminal/
│   ├── terminal-shell.tsx                   # 六区组合外壳（入口）
│   ├── terminal-rail.tsx                    # L1 主轨
│   ├── terminal-subnav.tsx                  # L2 子导航（含 BLF-825 折叠动效）
│   ├── terminal-header.tsx                  # Top Header（面包屑/搜索/通知/Inspector开关/用户）
│   ├── terminal-inspector.tsx               # 右侧 Inspector（⌘B）
│   ├── terminal-footer.tsx                  # Global Footer（多频道 Ticker，BLF-816）
│   ├── term-panel.tsx / term-table.tsx      # 通用面板与高密度表格
│   ├── header-filter-suite.tsx              # ★ Header 全局筛选组件族（Project/Country/DateRange/KPI 磁贴）
│   ├── global-filter-context.tsx            # ★ 全局筛选态 Context（页面消费入口）
│   ├── terminal-constants.ts                # ★ 全部结构尺寸/Ticker/动效常量（唯一尺寸来源）
│   └── use-terminal-layout.ts               # 折叠状态持久化 hook
├── components/dashboard/search-command.tsx  # ⌘K 命令面板（待接 readRecents 最近访问）
├── lib/sidebar-config.ts                    # 导航分组配置（Rail/SubNav 数据源）
├── lib/hooks/use-exchange-rate-ticker.ts    # Footer 汇率轮询
└── app/dashboard/page.tsx                   # 首页（页面打磨参照样板）；reports/order-info 为 Pattern A 大表样板
```
