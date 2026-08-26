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
9. **顶部基准线贯通**：外壳各列（Rail / SubNav / Header 所在主列 / Inspector）顶部第一条横向分割线必须处于同一水平线上（见 §任务 1 的 Top Strip 规范）；任何新增的顶栏区块高度一律引用该常量，不得另起炉灶。
10. **微细节按阶梯取值**：字号 / 图标尺寸 / 控件高度 / 大小写字距一律从 §任务 1b 的阶梯表中选档，禁止组件内自创新值（如 `text-[13px]`、`w-[17px]` 这类档外魔法数）。

## 任务 0：全局放大一档（✅ 已完成，保留作历史参考）

**状态：已完成且超额——实际执行了「两档」放大**（一档 commit 31117bdc，二档 3bed4693，PR #395）。下表为原始规划值，最终落地的常量以 `frontend/components/terminal/terminal-constants.ts` 为准：TERMINAL_RAIL_WIDTH=64、SUBNAV_WIDTH=224（BLF-844：256 观感过宽，2026-08-26 用户反馈回调至中间档）、HEADER_HEIGHT=48、FOOTER_HEIGHT=32、INSPECTOR_WIDTH=360；SubNav 折叠宽度有意归零（整列收起，仅以 BLF-825 动效呈现，非窄图标列）。后续任何尺寸调整一律以该文件为唯一来源，勿再回改本表数值。

### 0a. 结构尺寸（`frontend/components/terminal/terminal-constants.ts`）

| 常量 | 现值 | 新值 |
|---|---|---|
| TERMINAL_RAIL_WIDTH | 50 | ~~56~~ → 最终 64 |
| TERMINAL_SUBNAV_WIDTH | 200 | ~~224~~ → 256 → **224**（BLF-844 回调） |
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

## 任务 1：顶部基准线对齐（⭐ 2026-08-25 用户复核提出，优先级最高）

### 问题实态（grep 已核实）

外壳四列的「顶部第一条横向分割线」目前各用各的高度，互不对齐：

| 列 | 顶部区块 | 当前高度 | 来源 |
|---|---|---|---|
| L1 Rail | Logo 位 | **64px** | `style={{ height: TERMINAL_RAIL_WIDTH }}`（借用了宽度常量，语义错位） |
| L2 SubNav | 组头（域名+折叠按钮） | **40px** | 组件内 `h-10` 字面量 |
| 主列 Header | 整条 Header | **48px** | `TERMINAL_HEADER_HEIGHT` ✓ 唯一正确引用 |
| Inspector | 标题条 | **40px** | 组件内 `h-10` 字面量 |

结果：SubNav 组头下边框（y=40）、Header 下边框（y=48）、Inspector 标题下边框（y=40）、Rail Logo 下边框（y=64）四条横线在视觉上错位成锯齿——这正是「head 高度和 sidebar 顶部分割线是否对齐」要解决的问题。

### 改造方案

1. `terminal-constants.ts` 新增唯一来源常量：
   ```ts
   /** 顶部基准带高度：各列顶部第一个区块（Rail Logo / SubNav 组头 / Inspector 标题）统一引用，保证横向分割线贯通 */
   export const TERMINAL_TOP_STRIP_HEIGHT = TERMINAL_HEADER_HEIGHT // = 48，跟随 Header 联动调整
   ```
   用 `= TERMINAL_HEADER_HEIGHT` 表达式绑定而非复制数值，未来调 Header 高度时三列自动跟随。
2. 替换四处实现：
   - `terminal-rail.tsx` Logo 位：`height: TERMINAL_RAIL_WIDTH` → `height: TERMINAL_TOP_STRIP_HEIGHT`（Logo 按钮 `h-10 w-10` 相应复核，48px 带内放 40px 按钮留 4px 上下呼吸即可）；
   - `terminal-subnav.tsx` 组头：`h-10` → `style={{ height: TERMINAL_TOP_STRIP_HEIGHT }}`（注意保持 BLF-825 动效类与 stagger 不变，只改高度值）；
   - `terminal-inspector.tsx` 标题条：`h-10` → `style={{ height: TERMINAL_TOP_STRIP_HEIGHT }}`；
   - `terminal-header.tsx` 不动（已是 `TERMINAL_HEADER_HEIGHT`）。
3. 测试护栏：`terminal-subnav.test.tsx` 补断言「组头高度 === TERMINAL_TOP_STRIP_HEIGHT」锁契约；rail / inspector 如无测试文件则随本项补最小单测。
4. 验收：明暗两主题下目测四列顶部分割线连成一气；折叠 SubNav 后 Rail Logo 与 Header 分割线仍对齐（折叠不影响垂直尺寸）。

> 注意与 BLF-804 / BLF-826 并行改造的协调：本项只动三个组件的**顶部区块高度**，不碰页面内容与筛选集成，冲突面极小；但若两者同分支排队，先合本项（纯外壳、零页面依赖）。

## 任务 1b：外壳微细节规范——字号 / 图标 / 控件高度 / 字距（⭐ 2026-08-25 用户复核提出）

> 背景用户原话：「分割线只是一个举例，更多在 sidebar / layout 上面这类型细节，字号、icon 等都需要打磨写好规范。」
> 本节先给出**规范阶梯**（今后所有新代码照此取值），再附**现状审计表**（grep 已核实的偏离点，实施 PR 逐处替换收编）。

### 1b-1. 字号阶梯（Shell 全域唯一取值表）

| 档位 | 用途（穷举角色，不开放新档） |
|---|---|
| `text-xs`（12px） | 表格正文（term-table 已是）、kbd 快捷键、通知未读角标数字、下拉菜单次要说明、时间戳辅助文本 |
| `text-sm`（14px） | Shell 基准字号：导航项文字、面板/组标题、面包屑、Footer Ticker、Inspector 条目、按钮与菜单项正文 |
| `text-base`（16px） | KPI 磁贴主数值、Rail Logo 字符（仅此两处） |
| `text-lg`（18px） | KPI 磁贴强调数值（上限，页面级不得再大） |

规则：数值/金额/订单号/时间戳在以上任一档位上都叠加 `font-mono tabular-nums`；中文文案**不用** mono（Footer 当前把「快报」等中文标签也 mono 化了，见审计表 A5，应改为中文走默认字体栈、仅数值 mono）。

### 1b-2. 图标阶梯（lucide-react，两档 + 一条例外）

| 档位 | 尺寸 | strokeWidth | 适用场景 |
|---|---|---|---|
| L-图标 | `h-[18px] w-[18px]` | **1.75** | 独立图标按钮（Header 工具钮、Rail 业务域图标）——按钮内的主视觉图标 |
| M-图标 | `h-4 w-4`（16px） | **1.75** | 行内伴随图标（SubNav 列表项前缀、Inspector 区块标题前缀、菜单项前缀） |
| S-例外 | `h-3.5 w-3.5`（14px） | 1.75 | 仅限 Footer Ticker 行内小图标（32px 高度带内的贴身装饰），其他位置禁用 |

规则：① strokeWidth 全域统一 1.75，**不允许依赖 lucide 默认值 2**（当前 Header 全部图标都没显式设置，见审计表 A1）；② 尺寸写在图标 className 上，但档位以本表为准，禁止出现 17px / 20px 等中间值。

### 1b-3. 控件高度阶梯

| 档位 | 用途 |
|---|---|
| `h-4`（16px） | 徽标本体（min-w-4）、状态点 |
| `h-7`（28px） | 紧凑场景小方钮：仅限「已被更高档包裹的第二层控件」（如 SubNav 顶部基准带内的折叠钮）——**若该钮与 Header 同排对齐则必须升到 h-8** |
| `h-8`（32px） | 标准图标按钮（Header/Inspector 工具钮）、SubNav 列表项、筛选条工具栏 |
| `h-9`（36px） | 输入类与标题条：搜索触发框、TermPanel 标题条、TermTable 表头与行、Rail 底部次级钮 |
| `h-10`（40px） | 主导航大按钮：Rail 业务域钮、Rail Logo 位 |

规则：同一水平带上并排的可点击控件必须同档（顶部基准带内 SubNav 折叠钮 h-7 与 Header 内 h-8 并存即违反此条，见审计表 A3）；触控命中区最小 24px 不因档位放宽。

### 1b-4. 大小写与字距（英文标签专用，中文不适用）

| 角色 | 规范 |
|---|---|
| 面板/分组标题（SubNav 组头、Inspector 标题条、TermPanel h2、Footer 频道标签） | `uppercase tracking-wider`（0.05em）+ `font-semibold` + `text-term-muted` |
| Inspector 区块小标题（最近访问 / 快捷操作这类二级标题） | 同上四件套，但降一级视觉权重：颜色用 `text-term-faint`、保留 `font-semibold`（现状漏了 semibold，见审计表 A2） |
| 面包屑组名 | `uppercase tracking-wider`（现状是 tracking-wide，见审计表 A4，统一到 wider） |
| 正文 / 导航项 / 数据单元格 | 不加 uppercase、不加 tracking（数据单元格保持 term-table 的 normal-case tracking-normal） |

### 1b-5. 字体族规范（⭐ 2026-08-26 用户确认：中文走各系统默认，不额外统一）

三套字体已就位（`frontend/app/layout.tsx`，next/font latin 子集按需加载）：

| 变量 | 字体 | 用途 |
|---|---|---|
| `--font-sans` | Manrope | 正文、导航、按钮、表格中文本 |
| `--font-display` | Space Grotesk | 页面/面板标题（h1–h4、dashboard-display） |
| `--font-mono` | JetBrains Mono | 数值/金额/订单号/时间戳（叠 `tabular-nums`） |

**中文回退栈**（已落地 `tailwind.config.ts` 三条 fontFamily + `globals.css` 三处 font-family）：

```
"PingFang SC"（macOS）→ "Microsoft YaHei"（Windows）→ "Noto Sans SC"（Linux 兜底）→ sans-serif
```

规则：① **不引入中文 webfont**——12~14px 高密度字号段系统字体渲染最优（微软雅黑为 ClearType 调优），全量 10~20MB 体积不值（用户拍板）；② mono 栈尾部同样补中文回退，mono 场景里的中文（如 Footer 标签）稳定落到系统黑体；③ 中文文案不用 uppercase / tracking / mono（1b-4 与硬约束第 3 条既有规则不变）。

### 1b-6. kbd 快捷键规范（提取共享组件）

现状两处手写 `<kbd>` 且细节漂移（subnav 带 `leading-4`、header 不带）。规范：新建 `frontend/components/terminal/term-kbd.tsx`，唯一实现 `border border-term-border px-1 font-mono text-xs leading-4 text-term-faint`；SubNav 搜索框与 Header 用户菜单两处替换为 `<TermKbd>⌘K</TermKbd>` 形态，后续 ⌘B 等提示复用。

### 1b-7. 现状审计表（grep 核实，实施时逐处收编）

| # | 偏离点 | 证据（file:line） | 应改为 |
|---|---|---|---|
| A1 | Header 全部图标未显式设 strokeWidth（吃到 lucide 默认 2），与 Rail/SubNav 的 1.75 不一致 | `terminal-header.tsx:107,116,188,190,201,213,243,255` | 统一补 `strokeWidth={1.75}` |
| A2 | Inspector 二级标题缺 `font-semibold`，与面板标题族不一致 | `terminal-inspector.tsx:67,84` | 补 `font-semibold`（保持 text-term-faint） |
| A3 | SubNav 折叠钮 h-7 与 Header 同排 h-8 图标钮不同档 | `terminal-subnav.tsx:74` | 升为 `h-8 w-8`（随 §任务 1 顶部基准带改造一起做） |
| A4 | 面包屑组名 `tracking-wide`，其余标题族均为 `tracking-wider` | `terminal-header.tsx:122` | 改 `tracking-wider` |
| A5 | Footer 整条 `font-mono` 把中文标签也 mono 化 | `terminal-footer.tsx:220` | 中文标签走默认字体栈（去整条 mono，仅在数值 span 上加 `font-mono tabular-nums`） |
| A6 | kbd 两处手写实现漂移（leading-4 有无） | `terminal-subnav.tsx:90`、`terminal-header.tsx:268` | 提取 `<TermKbd>` 共享组件替换 |
| A7 | Footer Bell h-3.5 属 S-例外档，但 LogOut 在 Header 下拉里也是 h-3.5（M 档场景用了 S 档） | `terminal-footer.tsx:265`、`terminal-header.tsx:284` | LogOut 升 `h-4 w-4`；Bell 维持例外档并在本表留档 |

### 实施与验收

- 一个 PR 收编 A1–A7（纯样式类名与一处小组件抽取，无逻辑变更，可与 §任务 1 同分支先后合入）；A5 涉及 Footer 渲染结构调整，跑 `terminal-footer` 现有单测并补「数值 span 含 font-mono、中文标签不含」断言。
- 验收 grep：`grep -rn "strokeWidth" frontend/components/terminal/` 只允许 1.75；`text-[13px]` / `text-[15px]` 等 12/14 之外的正文档位为零；`<kbd` 在 terminal 目录下仅存在于 term-kbd.tsx。
- 明暗两主题各目测一遍：图标粗细观感一致、标题字距一致、kbd 无错位。


## 任务 2：各页面精细化打磨（放大完成后分批做）

### 打磨单页 SOP

1. **盘点**：读目标页 `page.tsx` 及其子组件，列出旧风格残留（阴影、圆角、非 term 色、非 mono 数值、>12px 的 padding/gap、页面级滚动容器）。**同时检查页面级标题胶囊/筛选条是否与 Top Header 全局筛选重复**——重复的应移除，改接 `header-filter-suite` 组件族（BLF-824 已清一批，BLF-826 集中规划中，新页面直接按新范式写，不要再加页面级胶囊）。
2. **替换**：面板容器换 `TermPanel`；数据表换 `TermTable`（或按 TermTable 的样式规范改造现有表格）；筛选条对齐首页 h-8 工具栏规格；数值全部 `font-mono tabular-nums` + 语义色。
3. **滚动收口**：确认页面内容在 Canvas 内滚动（外层不产生 document 滚动条）；长列表优先虚拟化（参考首页 Pattern A 明细表做法）。
4. **状态完备**：loading（骨架用 term 色系）/ error（term-neg 行内提示）/ empty（term-faint 占位）三态齐备。
5. **测试**：为新改的表格/交互补最小单测（参照 `daily-analysis-table.test.tsx` 模式）；全量 `pnpm lint && pnpm build && pnpm test`。
6. **自查**：对照「硬约束」逐条过一遍，尤其明色主题下的效果。

### 批次划分（按业务价值排序，每批一个 PR）

> 进度标注（2026-08-26 复核）：批次 A–F 全部完成——批次 A 的 daily-analysis 已完成 head 筛选集成；批次 A 余量与批次 B/C/D/E/F 分别随 BLF-834/835/836/837/838 合入。**全站 52 模块终端化收官**，新页面直接按本 SOP + `term-controls` 原语写，开工前仍先查 BLF-804 / BLF-826 是否已覆盖该页，避免重复改造。

- 批次 A（高频数据页）：`operations/daily-analysis` ✅ → `operations/inventory-analysis` ✅ → `operations/portfolio-overview` ✅
- 批次 B（广告）：`advertising/ad-analysis` ✅（term-chrome）→ `advertising/ad-data` ✅
- 批次 C（财务）：`finance/platform-revenue` ✅ → `finance/exchange-rate` ✅ → `finance/commission-management` ✅ → `finance/vat-invoices` ✅
- 批次 D（报表）：`reports/scheduled-reports` ✅ → `reports/order-info` ✅ → `reports/product-analysis` ✅ → 其余 reports 页 ✅
- 批次 E（CRM）：`crm/customers` ✅ → `crm/leads` ✅ → `crm/dashboard` ✅ → 其余 crm 页 ✅
- 批次 F（系统/AI/工具）：`system/*` ✅ → `ai/*` ✅ → `tools/*` ✅（BLF-838 收官；共享原语上收至 `components/terminal/term-controls.tsx`，附 7 条契约单测）

每批次验收：该域下所有路由目测风格一致（截图对比）、无旧风格残留、测试全绿。

## 任务 3：外壳增强项（部分已完成，余项继续穿插）

- ✅ Footer 多频道 ticker（BLF-816 已完成，#390）：汇率 / 全局快报 / 同步时刻 / 更新日志四频道，频道开关集中在 `TERMINAL_TICKER.channels`，新增/下线频道只改常量不动组件。
- 🔶 Top Header 全局筛选四件套接入更多页面（BLF-819 试点完成；BLF-826 正在集中规划 HeaderSlot 集成方案，推进前先看该 issue 结论）。

### 3a. ⌘K 命令面板「最近访问」（⭐ 优先：数据侧已就绪，纯前端小改）

**现状（grep 已核实）**：`readRecents()`/`pushRecent()` 已在两处落地——shell 路由变化即写入（`terminal-shell.tsx` useEffect），Inspector 已消费展示；但 `search-command.tsx` 完全未引用 recents，用户在 ⌘K 里看不到刚去过的页面。

**改造要点**：
1. `SearchCommand` 打开时（cmdk open 态或 Dialog onOpenChange）调一次 `readRecents()` 存入本地 state——不要订阅路由变化，避免每次导航重渲染面板；
2. 在搜索结果列表顶部加「最近访问」分组（`CommandGroup heading="最近访问"`）：无输入词（`search === ''`）时展示全部 recents（最多 8 条）；有输入词时按标题/pathname 过滤后并入结果；
3. 每项渲染 `item.title` + pathname 尾段（font-mono text-term-faint），回车跳转复用现有 router.push + 关闭逻辑；
4. 空状态兜底：recents 为空时整个分组不渲染，不显示占位文案；
5. 测试：`search-command` 如已有测试文件则补「打开面板 → 最近访问分组出现且顺序与 readRecents 一致」断言。

### 3b. Inspector 内容源扩展（Live Stream / Quick Actions 接真实数据）

**现状**：Live Stream 与 Quick Actions 区块仍是占位文案，Inspector 目前只有「最近访问」是真数据。

**改造建议（按性价比排序）**：
1. **Quick Actions 先做**：静态配置驱动即可闭环——快捷入口清单（新建订单 / 上传报表 / 汇率管理 / 补货分析等）直接映射到既有路由，点击跳转 + 收起 Inspector；无需新接口，半天工作量；
2. **Live Stream 后做**：接「今日出单流」需要后端配合（轮询或 SSE 推送最近 N 条订单事件）。前端先把区块改成可配置数据源（props 传入 items + empty 占位），后端就绪前用空态 + 「同步中」骨架占位，避免硬编码假数据误导用户；
3. 若需后端新端点，按职责边界在 issue 中 @后端工程师 提需求，不自己动 backend/。

### 3c. Footer Ticker 新频道预案

频道开关已收敛到 `TERMINAL_TICKER.channels`。下一个候选频道：**库存预警**（低于安全库存的 SKU 数，数据可复用现有 inventory API）。新增步骤只三步：常量加 key → footer 组件内加对应取数 hook + 渲染分支 → 测试补一条频道开关断言。等库存侧确认预警口径后再排期。

### 3d. SubNav 动效后续

BLF-825 已交付常驻挂载 + 壳层 width 过渡（260ms ease-out-expo 类）。如需「窄图标列」折叠形态另开 issue，不在当前批次内推进。

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
│   ├── term-controls.tsx                     # ★ 批次 F 上收的页面级控件基类（TERM_BUTTON/INPUT 等 + TermKpiTile/TermTabBar，BLF-838）
│   ├── term-kbd.tsx                          # kbd 快捷键共享组件（§任务 1b-5 新增）
│   └── use-terminal-layout.ts               # 折叠状态持久化 hook
├── components/dashboard/search-command.tsx  # ⌘K 命令面板（待接 readRecents 最近访问）
├── lib/sidebar-config.ts                    # 导航分组配置（Rail/SubNav 数据源）
├── lib/hooks/use-exchange-rate-ticker.ts    # Footer 汇率轮询
└── app/dashboard/page.tsx                   # 首页（页面打磨参照样板）；reports/order-info 为 Pattern A 大表样板
```
