# BelieveBoy Dashboard 终端化推进 Master Prompt

> 用途：在任意 AI 编码工具（Claude Code / Cursor / Codex 等）中作为完整工作指令使用。
> 使用方式：把本文件全文作为首条任务提示词发给工具，或按 §任务 分批发给它。
> 前置事实：终端外壳已合入 main（commit `9e47d99a`，PR #379），设计令牌、六区外壳组件、首页试点均已存在。

---

## 0. 角色与项目背景（必读）

你是资深前端工程师，负责 **BelieveBoy Dashboard**（跨境电商多品牌运营中台）的 Web 前端。技术栈：Next.js App Router + TypeScript + Tailwind CSS + shadcn/ui + Radix + Vitest/@testing-library/react。仓库根目录 `frontend/` 下为前端代码。

本项目正在执行「高密度交易终端」设计改造：把传统网页升级为桌面级工作站——100vh 钉死无页面滚动、1px 边框平铺禁阴影、微间距、等宽字体数值、语义涨跌色。该外壳已落地：

- 设计令牌：`frontend/app/globals.css` 中 `--term-*`（明暗两套）+ Tailwind `term` 色组
- 外壳组件：`frontend/components/terminal/`（terminal-shell / terminal-rail / terminal-subnav / terminal-header / terminal-inspector / terminal-footer / term-panel / term-table / terminal-constants）
- 布局骨架：L1 主轨 50px → L2 子导航 200px（可折叠）→ Top Header 36px → Main Canvas（`#main-content` 独立滚动）→ Right Inspector 280px（⌘B）→ Global Footer 24px
- 首页试点：`frontend/app/dashboard/page.tsx` 已终端化（KPI 等宽磁贴 + 高密度明细表）

**硬约束（任何任务都不得违反）：**
1. document/window 不出现滚动条；只有 Canvas 内部区域滚动。
2. 禁用 Box-Shadow 与圆角（`rounded-none`）；面板分割一律 `border border-term-border`（1px solid var(--term-border)）。
3. 所有数值/金额/订单号/时间戳必须 `font-mono tabular-nums`，并按 `--term-pos/warn/neg` 语义着色。
4. Padding/Gap 只允许 4 / 8 / 12px 档位（个别紧凑处可 2px）。
5. 尺寸常量只从 `terminal-constants.ts` 引用，禁止组件内硬编码宽度/高度字面量。
6. 明暗两套主题都必须适配（`--term-*` 双套已存在，新增颜色必须同时补两套）。
7. 每个 PR：先跑 `pnpm lint && pnpm build && pnpm test` 全绿；涉及公共组件/hook 用 CodeGraph 或全局搜索确认调用方；commit 信息中文 Conventional Commits。
8. 移动端（<md）行为保持现状：L1/L2 收进左侧 Sheet 抽屉，Footer 隐藏。

## 任务 0：全局放大一档（先做，独立 PR）

当前整体偏小（用户反馈）。采用**令牌级放大**（不改 zoom、不改 html font-size），按下表调整并同步更新相关测试快照/断言：

### 0a. 结构尺寸（`frontend/components/terminal/terminal-constants.ts`）

| 常量 | 现值 | 新值 |
|---|---|---|
| TERMINAL_RAIL_WIDTH | 50 | 56 |
| TERMINAL_SUBNAV_WIDTH | 200 | 224 |
| TERMINAL_HEADER_HEIGHT | 36 | 40 |
| TERMINAL_FOOTER_HEIGHT | 24 | 28 |
| TERMINAL_INSPECTOR_WIDTH | 288 | 320 |

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

### 验收标准

- [ ] `pnpm lint && pnpm build && pnpm test` 全绿（更新受影响断言）。
- [ ] 折叠态 L2 宽度 = 折叠图标列宽仍对齐 L1 主轨。
- [ ] 明暗主题切换后无对比度回退（新字号不改变颜色，仅复核视觉）。
- [ ] 1280×800 与 2560×1440 两档分辨率目测协调（截图留档）。
- [ ] 移动端 Sheet 抽屉回归一次（顺带补掉 BLF-809 遗留的移动端 Playwright 回归）。

## 任务 2：各页面精细化打磨（放大完成后分批做)

### 打磨单页 SOP（每页照此执行）

1. **盘点**：读目标页 `page.tsx` 及其子组件，列出旧风格残留（阴影、圆角、非 term 色、非 mono 数值、>12px 的 padding/gap、页面级滚动容器）。
2. **替换**：面板容器换 `TermPanel`；数据表换 `TermTable`（或按 TermTable 的样式规范改造现有表格）；筛选条对齐首页 h-8 工具栏规格；数值全部 `font-mono tabular-nums` + 语义色。
3. **滚动收口**：确认页面内容在 Canvas 内滚动（外层不产生 document 滚动条）；长列表优先虚拟化（参考首页 Pattern A 明细表做法）。
4. **状态完备**：loading（骨架用 term 色系）/ error（term-neg 行内提示）/ empty（term-faint 占位）三态齐备。
5. **测试**：为新改的表格/交互补最小单测（参照 `daily-analysis-table.test.tsx` 模式）；全量 `pnpm lint && pnpm build && pnpm test`。
6. **自查**：对照「硬约束」逐条过一遍，尤其明色主题下的效果。

### 批次划分（按业务价值排序，每批一个 PR）

- 批次 A（高频数据页）：`operations/daily-analysis` → `operations/inventory-analysis` → `operations/portfolio-overview`
- 批次 B（广告）：`advertising/ad-analysis` → `advertising/ad-data`
- 批次 C（财务）：`finance/platform-revenue` → `finance/exchange-rate` → `finance/commission-management` → `finance/vat-invoices`
- 批次 D（报表）：`reports/scheduled-reports` → `reports/order-info` → `reports/product-analysis` → 其余 reports 页
- 批次 E（CRM）：`crm/customers` → `crm/leads` → `crm/dashboard` → 其余 crm 页
- 批次 F（系统/AI/工具）：`system/*` → `ai/*` → `tools/*`

每批次验收：该域下所有路由目测风格一致（截图对比）、无旧风格残留、测试全绿。

## 任务 3：外壳增强项（可选，穿插进行)

以下为已记录的外壳后续优化点，可在页面批次间隙穿插：

- Footer 多频道 ticker：汇率之外增加滚动显示的更多系统信息频道（BLF-816 方向）。
- Top Header 全局筛选四件套接入更多页面（BLF-819 方向：Project / Site / Date / Status）。
- ⌘K 命令面板结果加入「最近访问」（localStorage `bb.terminal.recents` 已有数据）。
- Inspector 内容源扩展：当前 Live Stream / Quick Actions 可接真实数据。

## 附录：关键文件速查

```
frontend/
├── app/globals.css                          # --term-* 设计令牌（明暗两套）+ .term-scroll/.term-marquee-track
├── components/terminal/
│   ├── terminal-shell.tsx                   # 六区组合外壳（入口）
│   ├── terminal-rail.tsx                    # L1 主轨
│   ├── terminal-subnav.tsx                  # L2 子导航
│   ├── terminal-header.tsx                  # Top Header（面包屑/搜索/通知/Inspector开关/用户）
│   ├── terminal-inspector.tsx               # 右侧 Inspector（⌘B）
│   ├── terminal-footer.tsx                  # Global Footer（汇率 ticker/同步状态/时钟）
│   ├── term-panel.tsx / term-table.tsx      # 通用面板与高密度表格
│   ├── terminal-constants.ts                # ★ 全部结构尺寸常量（任务0主战场）
│   └── use-terminal-layout.ts               # 折叠状态持久化 hook
├── components/dashboard/search-command.tsx  # ⌘K 命令面板
├── lib/sidebar-config.ts                    # 导航分组配置（Rail/SubNav 数据源）
├── lib/hooks/use-exchange-rate-ticker.ts    # Footer 汇率轮询
└── app/dashboard/page.tsx                   # 首页试点（页面打磨的参照样板）
```
