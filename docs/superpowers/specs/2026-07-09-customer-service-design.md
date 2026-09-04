# 设计文档：AI 面板「客服交流」页（话术打磨工作台）

- 关联 issue：BEL-308
- 状态：设计稿 v1（待用户审查）
- 范围：本次仅产出设计文档，**不写实现代码**
- 日期：2026-07-09

## 1. 目标与非目标

**目标**

- 在 AI 面板新增「客服交流」页，作为**话术打磨 / 优化**的工作台。
- 首个落地场景：**运营汇报话术**（亚马逊运营视角，向直属主管汇报数据与结论）。
- 建立**配置驱动的场景框架**，使后续场景（如邮件撰写）只需加一条配置，不写新页面。

**非目标（YAGNI，v1 不做）**

- 数据库持久化 / 登录态保存（v1 仅本地暂存草稿）。
- 「话术库」保存与复用（后续迭代）。
- 平台运营数据（月报 / 广告分析）自动拉取（v1 手动粘贴，验证价值后再接）。
- 真实面向消费者的邮件撰写场景（仅预留框架，v1 不实现）。

## 2. 已确认的关键决策

来自 issue 讨论，用户拍板：

| # | 问题 | 决策 |
|---|------|------|
| Q1 | 交互形态 | **B 双栏润色式**（左输入 / 右输出，最贴合"打磨"） |
| Q2 | 数据来源 | **手动粘贴**（不接平台数据） |
| Q3 | 输出形态 | **一次给 2-3 个语气备选**供挑选 |
| Q4 | 语言 | **明确的中 / 英切换**（toggle，不跟随输入） |

## 3. 信息架构与落点

- 在 sidebar 的 **AI面板** 分组（`frontend/lib/sidebar-config.ts` → `SIDEBAR_TOP_GROUPS` 的 `ai` 组）下新增入口：
  - 标题：`客服交流`
  - URL：`/dashboard/ai/customer-service`
  - 图标：复用现有 `lucide-react` 图标（建议 `MessagesSquare` 或 `PenLine`）
- 页面沿用 dashboard 布局（`app/dashboard/layout.tsx`），**不是** AI Chat 那种暗色全屏形态，是普通工作台。

**页面结构（自上而下）**

1. **场景选择条（顶部 tabs）**：`运营汇报话术`（启用）、`邮件撰写`（占位 / 即将上线，演示扩展性）。
2. **双栏工作区**：
   - 左栏「输入」：按场景渲染（见 §5）。
   - 右栏「输出」：2-3 个语气备选卡片（见 §4）。
3. **控件条（跨两栏顶部或左栏内）**：长度、语言（中 / 英 toggle）。

## 4. 交互设计（双栏润色式，运营汇报话术）

**左栏 · 输入**

- 自由粘贴区（textarea）：原始草稿 / 零散想法 / 原始数据。
- 可选引导字段（非必填，帮助 AI 补全结构）：
  - 汇报周期（如：本周 / 本月）
  - 核心指标（销售额 / 订单量 / ACOS / 广告花费 / 利润）
  - 重点事项或异常（库存告警、排名波动等）
  - 下一步计划
- 控件：**长度**（简报 / 标准 / 详细）、**语言**（中 / 英 toggle，应用到所有输出卡片）。

**右栏 · 输出（2-3 个语气备选卡片）**

- 每个卡片对应一个 `toneOption`：**简洁周报版 / 正式报告版 / 口头汇报版**（具体定义见 §8）。
- 单卡片内容结构：**结论先行 → 数据支撑 → 风险 / 异常 → 下一步建议**。
- 每卡片操作：`复制`、`导出（Markdown / 纯文本）`、`换一种语气重生成`。
- 全局操作：`重新生成全部`、`微调后再次润色`（在左栏追加修改意见后重新生成）。

> 说明：Q3 的"2-3 个语气备选"即由 `toneOptions` 直接渲染为多张卡片；因此不再单独设"语气下拉"，语气 = 卡片维度。语言 toggle 为跨卡片的横向控制。

## 5. 可扩展场景框架：`ScenarioPreset`

现有代码已有 `PromptPreset` 模式（`frontend/lib/server/ai-chat.ts`）。将其升级为通用、配置驱动的场景框架：

```ts
type ScenarioMode = 'refine' | 'compose'

interface ScenarioField {
  key: string
  label: string
  type: 'textarea' | 'text' | 'select'
  placeholder?: string
  options?: { value: string; label: string }[]
  required?: boolean
}

interface ToneOption {
  id: string
  label: string        // 如「简洁周报版」
  description: string  // 如「一句话结论 + 要点，适合群里快速同步」
  promptSuffix: string // 注入 system prompt 的语气指令
}

interface ScenarioPreset {
  id: string
  label: string
  description: string
  mode: ScenarioMode          // refine=润色已有草稿；compose=按上下文拟定
  icon?: string               // lucide 图标名
  systemPrompt: string        // 基础指令（含受众 / 视角 / 输出结构）
  inputSchema: ScenarioField[]// 左栏字段（compose 模式为主，refine 可留空+自由区）
  showFreeTextArea: boolean   // 是否显示自由粘贴区（refine=true）
  outputFormat: string        // 输出结构指引
  toneOptions: ToneOption[]   // 2-3 个语气备选
  languageToggle: boolean     // 是否显示中/英切换（v1 全为 true）
}
```

**新增场景的成本** = 在 `SCENARIO_PRESETS` 数组中加一条配置（含 mode / inputSchema / toneOptions），无需新建页面或路由。

## 6. 未来场景：邮件撰写（compose 模式，v1 不实现但框架已预留）

- **受众**：真实消费者。
- **输入（compose 模式左栏）**：结构化上下文字段——
  - 收件人角色 / 场景（如：已下单未付款客户 / 售后投诉客户）
  - 邮件目的（催付 / 安抚 / 召回 / 通知）
  - 关键内容要点
  - 期望语气
  - 语言（中 / 英）
- **输出**：完整邮件（主题 + 正文），同样支持 2-3 语气备选、复制 / 导出。
- **与 refine 的差异**：左栏由"自由粘贴区"变为"结构化上下文字段"；`mode: 'compose'` 驱动这一渲染差异。v1 在场景条上以禁用占位 tab 出现，证明框架可扩展，待该场景启动时再细化 `inputSchema`。

## 7. 数据流与技术实现要点（方向，非代码）

- **后端复用**：沿用现有 `/api/ai-chat` 对话 + 流式接口。每次生成 = 一条消息，其 system prompt = `scenario.systemPrompt` + 选中 `toneOption.promptSuffix` + 语言指令（中 / 英）。
- **流式输出**：复用 `frontend/lib/api/ai-chat` 的客户端与 `useChatStream` 流能力；双栏页新建专用组件，但底层流调用保持一致，避免重复造轮子。
- **2-3 语气备选的生成**：推荐对 `toneOptions` 中每个语气**并发**发起独立生成（各自 loading 态），互不阻塞；若成本敏感可降级为单条结构化输出（用分隔符切分）。具体在 writing-plans 阶段定。
- **本地暂存**：当前输入草稿存 `sessionStorage`（会话内不丢）；可选 `localStorage` 存"最近草稿"。无数据库写入。
- **配置位置**：`ScenarioPreset[]` 放 `frontend/lib/server/ai-chat.ts`（与现有 `PromptPreset` 同文件或相邻），前端经 `/api/ai-chat/config` 的 summaries 拉取场景列表。

## 8. 待细化项（v1 kickoff 时定）

- `运营汇报话术` 三个 `toneOptions` 的精确定义（简洁周报 / 正式报告 / 口头汇报）与各自 `promptSuffix`。
- 2-3 并发生成的成本与延迟权衡（并发 vs 单条结构化）。
- 邮件撰写 `inputSchema` 字段细节（待该场景启动）。
- 导出格式细节（Markdown / 纯文本 / 复制为微信友好纯文本）。

## 9. v1 验收标准

1. AI面板侧边栏出现「客服交流」入口，打开 `/dashboard/ai/customer-service`。
2. 场景条显示`运营汇报话术`（启用）+ `邮件撰写`（占位禁用）。
3. 手动粘贴草稿 / 填引导字段 → 点「生成」→ 右栏渲染 2-3 个语气备选卡片。
4. 中 / 英 toggle 生效，切换所有卡片语言。
5. 每卡片可`复制` / `导出`；可`重新生成` / `换语气`。
6. 后续新增「邮件撰写」只需在 `SCENARIO_PRESETS` 加一条配置，不新建页面。
