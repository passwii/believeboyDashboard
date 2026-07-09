# AI 面板「客服交流」页（话术打磨工作台）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 AI 面板新增「客服交流」页，以双栏润色式交互，让用户手动粘贴运营草稿 / 数据，一键生成 2-3 个语气备选的「运营汇报话术」（亚马逊运营视角，中 / 英可切换）。

**架构：** 复用现有 AI Chat 流式链路（`useChatStream` → `/api/ai-chat/.../stream` 路由在服务端用 `ScenarioPreset` 拼出 `system_prompt` → Python 后端流式返回 ndjson，前端 `consumeStream` 消费）。新增「场景框架」`ScenarioPreset`（config 驱动），首个场景 `ops-report`（refine 模式），`email-compose` 仅作禁用占位以证明可扩展。所有 AI 调用复用既有鉴权与后端，无需改动 Python 后端。

**技术栈：** Next.js App Router（frontend）、TypeScript、shadcn/ui（button/card/textarea/input/select/tabs/badge/skeleton/scroll-area/separator）、Vitest（jsdom）、现有 `consumeStream` / `useChatStream`。

---

## 文件结构

**新增**
- `frontend/lib/server/ai-chat.ts`（追加 `ScenarioPreset` 类型、`SCENARIO_PRESETS`、`buildScenarioSystemPrompt`、`validateScenarioIds`、`getScenarioPresetSummaries`）— 场景配置与 system prompt 拼装（纯函数，可单测）。
- `frontend/lib/server/ai-chat.test.ts` — 上述纯函数单测。
- `frontend/components/customer-service/customer-service-client.tsx` — 页面主组件：场景选择 + 双栏 + 状态。
- `frontend/components/customer-service/scenario-tabs.tsx` — 顶部场景 tab（含禁用占位）。
- `frontend/components/customer-service/input-pane.tsx` — 左栏：自由粘贴区 + 引导字段 + 语言 / 长度控件 + 生成按钮。
- `frontend/components/customer-service/tone-card.tsx` — 右栏单个语气备选卡片：流式渲染 + 复制 / 导出 / 重生成。
- `frontend/components/customer-service/build-prompt.ts` — `buildUserContent()` 把输入拼成用户消息。
- `frontend/components/customer-service/customer-service-client.test.tsx` — 渲染冒烟测试（mock 配置）。
- `frontend/app/dashboard/ai/customer-service/page.tsx` — 路由页（client，挂载主组件）。

**修改**
- `frontend/app/api/ai-chat/conversations/[conversationId]/messages/stream/route.ts` — 接收 `scenarioId/toneId/language/length`，服务端拼 `system_prompt`。
- `frontend/app/api/ai-chat/config/route.ts` — 响应新增 `scenarios`。
- `frontend/lib/api/ai-chat.ts` — `AIChatConfig` 增加 `scenarios` 类型。
- `frontend/components/chat/hooks/use-chat-stream.ts` — `ChatStreamOptions` 透传 `scenarioId/toneId/language/length`。
- `frontend/lib/sidebar-config.ts` — AI面板分组新增「客服交流」入口。

---

### 任务 1：场景配置 `ScenarioPreset` + 单元测试

**文件：**
- 修改：`frontend/lib/server/ai-chat.ts`（文件末尾追加）
- 测试：`frontend/lib/server/ai-chat.test.ts`（新建）

- [ ] **步骤 1：编写失败的测试**

```ts
// frontend/lib/server/ai-chat.test.ts
import { describe, it, expect } from 'vitest'
import {
  getScenarioPresetSummaries,
  buildScenarioSystemPrompt,
  validateScenarioIds,
} from './ai-chat'

describe('getScenarioPresetSummaries', () => {
  it('ops-report 启用、email-compose 禁用', () => {
    const { scenarios } = getScenarioPresetSummaries()
    const ops = scenarios.find((s) => s.id === 'ops-report')
    const email = scenarios.find((s) => s.id === 'email-compose')
    expect(ops?.disabled).toBe(false)
    expect(email?.disabled).toBe(true)
    expect(ops?.mode).toBe('refine')
    expect(email?.mode).toBe('compose')
  })
})

describe('buildScenarioSystemPrompt', () => {
  it('拼入 场景+语气+长度+语言 指令', () => {
    const sp = buildScenarioSystemPrompt('ops-report', 'brief', 'zh', 'brief')
    expect(sp).toContain('资深')
    expect(sp).toContain('一句话结论')
    expect(sp).toContain('快速同步')
    expect(sp).toContain('用中文输出')
  })
  it('未知场景回退兜底', () => {
    expect(buildScenarioSystemPrompt('nope')).toContain('乐于助人')
  })
})

describe('validateScenarioIds', () => {
  it('允许空场景', () => expect(validateScenarioIds(null, null)).toBe(true))
  it('拒绝未知场景', () => expect(validateScenarioIds('ghost', null)).toBe(false))
  it('拒绝场景内未知语气', () => expect(validateScenarioIds('ops-report', 'ghost')).toBe(false))
  it('接受已知语气', () => expect(validateScenarioIds('ops-report', 'formal')).toBe(true))
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd frontend && pnpm test lib/server/ai-chat.test.ts`
预期：FAIL，`Cannot find module './ai-chat'`（或找不到导出）

- [ ] **步骤 3：编写最少实现代码**（在 `frontend/lib/server/ai-chat.ts` 末尾追加）

```ts
// =========================== ScenarioPreset（客服交流） ===========================

export type ScenarioMode = 'refine' | 'compose'

export type ScenarioFieldType = 'textarea' | 'text' | 'select'

export interface ScenarioField {
  key: string
  label: string
  type: ScenarioFieldType
  placeholder?: string
  options?: { value: string; label: string }[]
  required?: boolean
}

export interface ToneOption {
  id: string
  label: string
  description: string
  /** 注入 system prompt 的语气指令 */
  promptSuffix: string
}

export interface ScenarioPreset {
  id: string
  label: string
  description: string
  mode: ScenarioMode
  icon?: string
  /** 基础指令：受众 / 视角 / 输出结构 */
  systemPrompt: string
  /** 左栏字段；refine 模式可结合 showFreeTextArea */
  inputSchema: ScenarioField[]
  /** 是否显示自由粘贴区（refine=true） */
  showFreeTextArea: boolean
  outputFormat: string
  toneOptions: ToneOption[]
  languageToggle: boolean
  /** 占位但未上线（如邮件撰写） */
  disabled?: boolean
}

const LENGTH_INSTRUCTIONS: Record<string, string> = {
  brief: '篇幅尽量短：结论 + 要点，适合快速同步。',
  standard: '篇幅适中：结构完整但不冗长。',
  detailed: '篇幅可以较长：展开原因、依据与细节。',
}

const LANGUAGE_INSTRUCTIONS: Record<string, string> = {
  zh: '用中文输出。',
  en: 'Respond in English.',
}

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  {
    id: 'ops-report',
    label: '运营汇报话术',
    description: '亚马逊运营视角，向直属主管汇报数据与结论。',
    mode: 'refine',
    icon: 'MessagesSquare',
    systemPrompt:
      '你是一名资深的亚马逊运营专家，擅长把运营数据转化为清晰、专业、有结论的汇报话术。受众是你的直属主管。请严格遵循结构：结论先行 → 数据支撑 → 风险/异常 → 下一步建议。',
    showFreeTextArea: true,
    inputSchema: [
      { key: 'period', label: '汇报周期', type: 'text', placeholder: '如：本周 / 本月' },
      { key: 'metrics', label: '核心指标', type: 'textarea', placeholder: '销售额 / 订单量 / ACOS / 广告花费 / 利润' },
      { key: 'risks', label: '重点事项或异常', type: 'textarea', placeholder: '库存告警、排名波动等' },
      { key: 'next', label: '下一步计划', type: 'textarea', placeholder: '准备做的事' },
    ],
    outputFormat: '结论先行 → 数据支撑 → 风险/异常 → 下一步建议',
    toneOptions: [
      { id: 'brief', label: '简洁周报版', description: '一句话结论 + 要点，适合群里快速同步', promptSuffix: '输出简洁的周报版：先一句话结论，再列 3-5 条要点，控制在 200 字以内。' },
      { id: 'formal', label: '正式报告版', description: '完整结构化报告，适合正式汇报', promptSuffix: '输出正式报告版：完整的结构化段落（结论 / 数据支撑 / 风险异常 / 下一步），用词正式、严谨。' },
      { id: 'verbal', label: '口头汇报版', description: '口语化、可照读', promptSuffix: '输出口头汇报版：口语化、自然，像当面汇报一样，可直接照着说。' },
    ],
    languageToggle: true,
  },
  {
    id: 'email-compose',
    label: '邮件撰写',
    description: '面向消费者的邮件拟定（即将上线）。',
    mode: 'compose',
    icon: 'Mail',
    systemPrompt:
      '你是一名专业的客服邮件撰写者，擅长根据上下文为真实消费者拟定邮件。受众是消费者。',
    showFreeTextArea: false,
    inputSchema: [
      { key: 'recipient', label: '收件人角色 / 场景', type: 'text', placeholder: '如：已下单未付款客户' },
      { key: 'purpose', label: '邮件目的', type: 'text', placeholder: '催付 / 安抚 / 召回 / 通知' },
      { key: 'points', label: '关键内容要点', type: 'textarea', placeholder: '要传达的核心信息' },
    ],
    outputFormat: '主题 + 正文',
    toneOptions: [],
    languageToggle: true,
    disabled: true,
  },
]

export interface ScenarioSummary {
  id: string
  label: string
  description: string
  mode: ScenarioMode
  disabled: boolean
}

export function getScenarioPresetSummaries(): { scenarios: ScenarioSummary[] } {
  return {
    scenarios: SCENARIO_PRESETS.map(({ id, label, description, mode, disabled }) => ({
      id,
      label,
      description,
      mode,
      disabled: Boolean(disabled),
    })),
  }
}

function findScenarioPreset(id: string | null | undefined): ScenarioPreset | null {
  if (!id) return null
  return SCENARIO_PRESETS.find((s) => s.id === id) ?? null
}

export function buildScenarioSystemPrompt(
  scenarioId?: string | null,
  toneId?: string | null,
  language?: string | null,
  length?: string | null,
): string {
  const scenario = findScenarioPreset(scenarioId)
  if (!scenario) {
    return '你是一个乐于助人的智能助手。请使用中文回答问题，尽可能提供准确、有用的信息。'
  }
  const parts: string[] = [scenario.systemPrompt]
  const tone = scenario.toneOptions.find((t) => t.id === toneId)
  if (tone) parts.push(tone.promptSuffix)
  if (length && LENGTH_INSTRUCTIONS[length]) parts.push(LENGTH_INSTRUCTIONS[length])
  if (language && LANGUAGE_INSTRUCTIONS[language]) parts.push(LANGUAGE_INSTRUCTIONS[language])
  return parts.join('\n\n')
}

export function validateScenarioIds(
  scenarioId?: string | null,
  toneId?: string | null,
): boolean {
  const scenario = findScenarioPreset(scenarioId)
  if (!scenario) return !scenarioId
  if (!toneId) return true
  return scenario.toneOptions.some((t) => t.id === toneId)
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd frontend && pnpm test lib/server/ai-chat.test.ts`
预期：PASS（3 个 describe 全绿）

- [ ] **步骤 5：Commit**

```bash
git add frontend/lib/server/ai-chat.ts frontend/lib/server/ai-chat.test.ts
git commit -m "feat(客服交流): 新增 ScenarioPreset 场景配置与 system prompt 拼装"
```

---

### 任务 2：流式路由支持 scenario / tone / language / length

**文件：**
- 修改：`frontend/app/api/ai-chat/conversations/[conversationId]/messages/stream/route.ts`

- [ ] **步骤 1：扩展请求体类型与校验、拼装 system prompt**

把文件顶部 import 改为同时引入场景函数，并替换 `system_prompt` 计算逻辑：

```ts
import { buildSystemPrompt, validatePromptPresetIds, buildScenarioSystemPrompt, validateScenarioIds } from '@/lib/server/ai-chat'
```

在 `body` 类型中新增（放在 `detailPromptId` 之后）：

```ts
    scenarioId?: string | null
    toneId?: string | null
    language?: string | null
    length?: string | null
```

在 `validatePromptPresetIds` 校验之后新增：

```ts
  if (!validateScenarioIds(body.scenarioId, body.toneId)) {
    return NextResponse.json({ message: '场景或语气选项无效' }, { status: 400 })
  }
```

把原来传给上游的 `system_prompt: buildSystemPrompt(body.overviewPromptId, body.detailPromptId),` 替换为：

```ts
        system_prompt: body.scenarioId
          ? buildScenarioSystemPrompt(body.scenarioId, body.toneId, body.language, body.length)
          : buildSystemPrompt(body.overviewPromptId, body.detailPromptId),
```

- [ ] **步骤 2：运行 lint 确认类型正确**

运行：`cd frontend && pnpm lint`
预期：0 error（场景参数已并入请求体并透传到上游）

- [ ] **步骤 3：Commit**

```bash
git add frontend/app/api/ai-chat/conversations/\[conversationId\]/messages/stream/route.ts
git commit -m "feat(客服交流): 流式路由支持 scenario/tone/language/length 并服务端拼 system prompt"
```

---

### 任务 3：config 路由 + 前端类型

**文件：**
- 修改：`frontend/app/api/ai-chat/config/route.ts`
- 修改：`frontend/lib/api/ai-chat.ts`

- [ ] **步骤 1：config 路由返回 `scenarios`**

在 `config/route.ts` 顶部 import 增加：

```ts
import { getPromptPresetSummaries, getScenarioPresetSummaries } from '@/lib/server/ai-chat'
```

在成功分支返回的 `NextResponse.json({...})` 对象里（与 `...promptPresets` 并列）加入 `...getScenarioPresetSummaries()`；同样在 `apiKeyOrResponse.error` 分支与 `catch` 分支的兜底对象里加入 `...getScenarioPresetSummaries()`。

- [ ] **步骤 2：前端 `AIChatConfig` 增加 `scenarios`**

在 `frontend/lib/api/ai-chat.ts` 顶部新增类型导入（仅类型，不会打包服务端运行时）：

```ts
import type { ScenarioSummary } from '@/lib/server/ai-chat'
```

在 `AIChatConfig` 接口末尾新增字段：

```ts
  overviewOptions: PromptPresetOption[]
  detailOptions: PromptPresetOption[]
  scenarios: ScenarioSummary[]
```

- [ ] **步骤 3：运行 lint + build 确认类型贯通**

运行：`cd frontend && pnpm lint && pnpm build`
预期：lint 0 error；build 通过（config 响应与前端类型一致）

- [ ] **步骤 4：Commit**

```bash
git add frontend/app/api/ai-chat/config/route.ts frontend/lib/api/ai-chat.ts
git commit -m "feat(客服交流): config 暴露场景列表并补充前端类型"
```

---

### 任务 4：`useChatStream` 透传场景参数

**文件：**
- 修改：`frontend/components/chat/hooks/use-chat-stream.ts`

- [ ] **步骤 1：扩展 `ChatStreamOptions` 与请求体**

在 `ChatStreamOptions` 接口（textarea 等之后）新增：

```ts
  scenarioId?: string | null
  toneId?: string | null
  language?: string | null
  length?: string | null
```

在 `send` 内的 `body: JSON.stringify({...})` 中，于 `detailPromptId` 之后加入：

```ts
              scenarioId: options.scenarioId ?? null,
              toneId: options.toneId ?? null,
              language: options.language ?? null,
              length: options.length ?? null,
```

- [ ] **步骤 2：运行 lint**

运行：`cd frontend && pnpm lint`
预期：0 error

- [ ] **步骤 3：Commit**

```bash
git add frontend/components/chat/hooks/use-chat-stream.ts
git commit -m "feat(客服交流): useChatStream 透传 scenario/tone/language/length"
```

---

### 任务 5：sidebar 入口

**文件：**
- 修改：`frontend/lib/sidebar-config.ts`

- [ ] **步骤 1：新增图标与入口**

在文件顶部 lucide 导入列表中加入 `MessagesSquare`，并在 `IconMap` 对象中加入 `MessagesSquare`。

在 `ai` 分组的 `items` 数组末尾（`模型选型` 之后）新增：

```ts
  { title: '客服交流', url: '/dashboard/ai/customer-service', icon: IconMap.MessagesSquare },
```

- [ ] **步骤 2：运行 lint + build**

运行：`cd frontend && pnpm lint && pnpm build`
预期：通过；侧边栏「AI面板」出现「客服交流」

- [ ] **步骤 3：Commit**

```bash
git add frontend/lib/sidebar-config.ts
git commit -m "feat(客服交流): 在侧边栏 AI面板 分组新增入口"
```

---

### 任务 6：页面骨架与场景 tabs

**文件：**
- 新建：`frontend/app/dashboard/ai/customer-service/page.tsx`
- 新建：`frontend/components/customer-service/customer-service-client.tsx`
- 新建：`frontend/components/customer-service/scenario-tabs.tsx`

- [ ] **步骤 1：路由页**

```tsx
// frontend/app/dashboard/ai/customer-service/page.tsx
'use client'
import { CustomerServiceClient } from '@/components/customer-service/customer-service-client'

export default function CustomerServicePage() {
  return <CustomerServiceClient />
}
```

- [ ] **步骤 2：场景 tabs 组件**

```tsx
// frontend/components/customer-service/scenario-tabs.tsx
'use client'
import type { ScenarioSummary } from '@/lib/server/ai-chat'

export function ScenarioTabs({
  scenarios,
  selectedId,
  onSelect,
}: {
  scenarios: ScenarioSummary[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  return (
    <div className='flex flex-wrap gap-2'>
      {scenarios.map((s) => {
        const active = s.id === selectedId
        return (
          <button
            key={s.id}
            type='button'
            disabled={s.disabled}
            onClick={() => !s.disabled && onSelect(s.id)}
            className={[
              'rounded-full border px-4 py-1.5 text-sm transition-colors',
              active ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground',
              s.disabled ? 'cursor-not-allowed opacity-50' : 'hover:border-primary/50',
            ].join(' ')}
            title={s.disabled ? '即将上线' : s.description}
          >
            {s.label}
            {s.disabled ? '（即将上线）' : ''}
          </button>
        )
      })}
    </div>
  )
}
```

- [ ] **步骤 3：主组件（状态 + 双栏 + 草稿暂存）**

```tsx
// frontend/components/customer-service/customer-service-client.tsx
'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ensureConfigLoaded, getConfig } from '@/lib/api/ai-chat-config-store'
import type { ScenarioSummary } from '@/lib/server/ai-chat'
import { ScenarioTabs } from './scenario-tabs'
import { InputPane } from './input-pane'
import { ToneCard } from './tone-card'
import { findScenarioPreset } from '@/lib/server/ai-chat'

const DRAFT_KEY = 'cs-draft-v1'

type Draft = {
  scenarioId: string
  freeText: string
  guidedFields: Record<string, string>
  language: 'zh' | 'en'
  length: 'brief' | 'standard' | 'detailed'
}

export function CustomerServiceClient() {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([])
  const [selectedId, setSelectedId] = useState('ops-report')
  const [freeText, setFreeText] = useState('')
  const [guidedFields, setGuidedFields] = useState<Record<string, string>>({})
  const [language, setLanguage] = useState<'zh' | 'en'>('zh')
  const [length, setLength] = useState<'brief' | 'standard' | 'detailed'>('standard')
  const [generateToken, setGenerateToken] = useState(0)
  const [isGenerating, setIsGenerating] = useState(false)
  const reqIdRef = useRef(0)

  // 加载场景配置
  useEffect(() => {
    let alive = true
    ensureConfigLoaded()
      .then(() => {
        if (!alive) return
        const list = getConfig()?.scenarios ?? []
        setScenarios(list)
        const firstEnabled = list.find((s) => !s.disabled)
        if (firstEnabled) setSelectedId(firstEnabled.id)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // 草稿暂存（sessionStorage）
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY)
      if (raw) {
        const d = JSON.parse(raw) as Draft
        setSelectedId(d.scenarioId)
        setFreeText(d.freeText)
        setGuidedFields(d.guidedFields)
        setLanguage(d.language)
        setLength(d.length)
      }
    } catch {}
  }, [])
  useEffect(() => {
    const d: Draft = { scenarioId: selectedId, freeText, guidedFields, language, length }
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d))
    } catch {}
  }, [selectedId, freeText, guidedFields, language, length])

  const scenario = useMemo(() => findScenarioPreset(selectedId), [selectedId])
  const canGenerate = Boolean(freeText.trim() || Object.values(guidedFields).some((v) => v.trim()))

  const handleGenerate = () => {
    if (!canGenerate || isGenerating) return
    reqIdRef.current += 1
    setGenerateToken(reqIdRef.current)
  }

  return (
    <div className='flex h-full flex-col gap-4'>
      <ScenarioTabs scenarios={scenarios} selectedId={selectedId} onSelect={setSelectedId} />
      <div className='grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2'>
        <InputPane
          scenario={scenario}
          freeText={freeText}
          setFreeText={setFreeText}
          guidedFields={guidedFields}
          setGuidedFields={setGuidedFields}
          language={language}
          setLanguage={setLanguage}
          length={length}
          setLength={setLength}
          onGenerate={handleGenerate}
          isGenerating={isGenerating}
          canGenerate={canGenerate}
        />
        <div className='flex min-h-0 flex-col gap-3 overflow-y-auto pr-1'>
          {scenario?.toneOptions.map((tone) => (
            <ToneCard
              key={tone.id}
              scenarioId={scenario.id}
              tone={tone}
              freeText={freeText}
              guidedFields={guidedFields}
              language={language}
              length={length}
              schema={scenario.inputSchema}
              generateToken={generateToken}
              onStreamingChange={setIsGenerating}
            />
          ))}
          {!scenario && <p className='text-sm text-muted-foreground'>请选择一个场景。</p>}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **步骤 4：运行 lint + build**

运行：`cd frontend && pnpm lint && pnpm build`
预期：build 通过（此时 ToneCard / InputPane 尚未创建，会报找不到模块——先创建占位或在任务 7/8 后再 build。建议：**先创建本任务的 Task 7/8 文件后再统一 build**，或本步仅 `pnpm lint` 忽略未创建导入。）

- [ ] **步骤 5：Commit**（与任务 7/8 一起统一 commit 更稳，见任务 8 步骤 5）

---

### 任务 7：输入栏 `InputPane` 与 `buildUserContent`

**文件：**
- 新建：`frontend/components/customer-service/build-prompt.ts`
- 新建：`frontend/components/customer-service/input-pane.tsx`
- 测试：`frontend/components/customer-service/build-prompt.test.ts`

- [ ] **步骤 1：编写失败测试**

```ts
// frontend/components/customer-service/build-prompt.test.ts
import { describe, it, expect } from 'vitest'
import { buildUserContent } from './build-prompt'
import type { ScenarioField } from '@/lib/server/ai-chat'

const schema: ScenarioField[] = [
  { key: 'period', label: '汇报周期', type: 'text' },
  { key: 'metrics', label: '核心指标', type: 'textarea' },
]

describe('buildUserContent', () => {
  it('仅自由文本', () => {
    const out = buildUserContent({ freeText: '本周 ACOS 升高', guidedFields: {}, schema })
    expect(out).toContain('本周 ACOS 升高')
    expect(out).not.toContain('补充信息')
  })
  it('合并引导字段', () => {
    const out = buildUserContent({
      freeText: '草稿',
      guidedFields: { period: '本周', metrics: '销售额 1w' },
      schema,
    })
    expect(out).toContain('【原始内容】')
    expect(out).toContain('【补充信息】')
    expect(out).toContain('汇报周期：本周')
    expect(out).toContain('核心指标：销售额 1w')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd frontend && pnpm test components/customer-service/build-prompt.test.ts`
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现 `buildUserContent`**

```ts
// frontend/components/customer-service/build-prompt.ts
import type { ScenarioField } from '@/lib/server/ai-chat'

export function buildUserContent(input: {
  freeText: string
  guidedFields: Record<string, string>
  schema: ScenarioField[]
}): string {
  const sections: string[] = []
  const free = input.freeText.trim()
  if (free) sections.push(`【原始内容】\n${free}`)
  const filled = input.schema
    .map((f) => ({ label: f.label, value: (input.guidedFields[f.key] ?? '').trim() }))
    .filter((x) => x.value)
  if (filled.length) {
    const lines = filled.map((x) => `- ${x.label}：${x.value}`).join('\n')
    sections.push(`【补充信息】\n${lines}`)
  }
  return sections.join('\n\n')
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd frontend && pnpm test components/customer-service/build-prompt.test.ts`
预期：PASS

- [ ] **步骤 5：实现 `InputPane`**

```tsx
// frontend/components/customer-service/input-pane.tsx
'use client'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ScenarioPreset } from '@/lib/server/ai-chat'

export function InputPane({
  scenario,
  freeText,
  setFreeText,
  guidedFields,
  setGuidedFields,
  language,
  setLanguage,
  length,
  setLength,
  onGenerate,
  isGenerating,
  canGenerate,
}: {
  scenario: ScenarioPreset | null
  freeText: string
  setFreeText: (v: string) => void
  guidedFields: Record<string, string>
  setGuidedFields: (v: Record<string, string>) => void
  language: 'zh' | 'en'
  setLanguage: (v: 'zh' | 'en') => void
  length: 'brief' | 'standard' | 'detailed'
  setLength: (v: 'brief' | 'standard' | 'detailed') => void
  onGenerate: () => void
  isGenerating: boolean
  canGenerating?: boolean
  canGenerate: boolean
}) {
  if (!scenario) return null
  return (
    <div className='flex min-h-0 flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-[hsl(var(--surface-panel))] p-4'>
      {scenario.showFreeTextArea && (
        <Textarea
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          placeholder='粘贴你的原始草稿 / 数据 / 零散想法…'
          className='min-h-40 flex-1 resize-none'
        />
      )}
      {scenario.inputSchema.map((f) => (
        <div key={f.key} className='flex flex-col gap-1'>
          <label className='text-xs text-muted-foreground'>{f.label}</label>
          {f.type === 'textarea' ? (
            <Textarea
              value={guidedFields[f.key] ?? ''}
              onChange={(e) => setGuidedFields({ ...guidedFields, [f.key]: e.target.value })}
              placeholder={f.placeholder}
              className='min-h-16 resize-none'
            />
          ) : (
            <Input
              value={guidedFields[f.key] ?? ''}
              onChange={(e) => setGuidedFields({ ...guidedFields, [f.key]: e.target.value })}
              placeholder={f.placeholder}
            />
          )}
        </div>
      ))}
      <div className='mt-1 flex flex-wrap items-center gap-3'>
        <div className='flex overflow-hidden rounded-md border border-border'>
          <button
            type='button'
            onClick={() => setLanguage('zh')}
            className={['px-3 py-1 text-sm', language === 'zh' ? 'bg-primary/10 text-primary' : 'text-muted-foreground'].join(' ')}
          >
            中文
          </button>
          <button
            type='button'
            onClick={() => setLanguage('en')}
            className={['px-3 py-1 text-sm', language === 'en' ? 'bg-primary/10 text-primary' : 'text-muted-foreground'].join(' ')}
          >
            English
          </button>
        </div>
        <Select value={length} onValueChange={(v) => setLength(v as 'brief' | 'standard' | 'detailed')}>
          <SelectTrigger className='w-32'><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value='brief'>简报</SelectItem>
            <SelectItem value='standard'>标准</SelectItem>
            <SelectItem value='detailed'>详细</SelectItem>
          </SelectContent>
        </Select>
        <Button className='ml-auto' onClick={onGenerate} disabled={!canGenerate || isGenerating}>
          {isGenerating ? '生成中…' : '生成'}
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **步骤 6：Commit**（与任务 6/8 统一）

```bash
git add frontend/components/customer-service/build-prompt.ts frontend/components/customer-service/build-prompt.test.ts frontend/components/customer-service/input-pane.tsx frontend/components/customer-service/customer-service-client.tsx frontend/components/customer-service/scenario-tabs.tsx frontend/app/dashboard/ai/customer-service/page.tsx
git commit -m "feat(客服交流): 页面骨架、场景 tabs 与输入栏"
```

---

### 任务 8：语气卡片 `ToneCard`（流式渲染 + 复制 / 导出 / 重生成）

**文件：**
- 新建：`frontend/components/customer-service/tone-card.tsx`

- [ ] **步骤 1：实现 `ToneCard`**

```tsx
// frontend/components/customer-service/tone-card.tsx
'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useChatStream } from '@/components/chat/hooks/use-chat-stream'
import { createConversation } from '@/lib/api/ai-chat'
import { buildUserContent } from './build-prompt'
import type { ScenarioField, ToneOption } from '@/lib/server/ai-chat'

export function ToneCard({
  scenarioId,
  tone,
  freeText,
  guidedFields,
  language,
  length,
  schema,
  generateToken,
  onStreamingChange,
}: {
  scenarioId: string
  tone: ToneOption
  freeText: string
  guidedFields: Record<string, string>
  language: 'zh' | 'en'
  length: 'brief' | 'standard' | 'detailed'
  schema: ScenarioField[]
  generateToken: number
  onStreamingChange: (v: boolean) => void
}) {
  const [output, setOutput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const convIdRef = useRef<number | null>(null)
  const callbacksRef = useRef({
    onChunk: (delta: string) => setOutput((prev) => prev + delta),
    onDone: () => {
      setDone(true)
      onStreamingChange(false)
    },
    onError: (msg: string) => {
      setError(msg)
      onStreamingChange(false)
    },
  })
  const { send, isStreaming } = useChatStream(convIdRef, callbacksRef)

  const generate = useCallback(async () => {
    setOutput('')
    setError(null)
    setDone(false)
    onStreamingChange(true)
    const content = buildUserContent({ freeText, guidedFields, schema })
    // 每次生成用全新会话，避免历史污染
    const conv = await createConversation('客服交流')
    convIdRef.current = conv.id
    try {
      await send(content, { scenarioId, toneId: tone.id, language, length })
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setError(e instanceof Error ? e.message : '生成失败')
      onStreamingChange(false)
    }
  }, [freeText, guidedFields, schema, scenarioId, tone.id, language, length, send, onStreamingChange])

  // generateToken 变化触发生成（>0 才触发）
  useEffect(() => {
    if (generateToken > 0) void generate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generateToken])

  const copy = () => {
    if (output) void navigator.clipboard.writeText(output)
  }
  const exportMd = () => {
    if (!output) return
    const blob = new Blob([output], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${tone.label}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card className='shrink-0'>
      <CardHeader className='flex flex-row items-center justify-between gap-2 space-y-0 pb-2'>
        <div>
          <CardTitle className='text-sm'>{tone.label}</CardTitle>
          <p className='text-xs text-muted-foreground'>{tone.description}</p>
        </div>
        <div className='flex gap-1'>
          <Button size='sm' variant='ghost' onClick={copy} disabled={!output}>复制</Button>
          <Button size='sm' variant='ghost' onClick={exportMd} disabled={!output}>导出</Button>
          <Button size='sm' variant='outline' onClick={() => void generate()} disabled={isStreaming}>重生成</Button>
        </div>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className='text-sm text-destructive'>{error}</p>
        ) : isStreaming && !output ? (
          <div className='space-y-2'><Skeleton className='h-4 w-full' /><Skeleton className='h-4 w-5/6' /></div>
        ) : (
          <div className='whitespace-pre-wrap text-sm leading-relaxed'>
            {output || <span className='text-muted-foreground'>点击「生成」后在此查看{tone.label}。</span>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **步骤 2：统一 build + lint + test（含任务 6/7 文件）**

运行：`cd frontend && pnpm lint && pnpm build && pnpm test`
预期：lint 0 error；build 通过；test 全绿。

- [ ] **步骤 3：Commit**

```bash
git add frontend/components/customer-service/tone-card.tsx
git commit -m "feat(客服交流): 语气卡片流式渲染与复制/导出/重生成"
```

---

### 任务 9：页面渲染冒烟测试

**文件：**
- 新建：`frontend/components/customer-service/customer-service-client.test.tsx`

- [ ] **步骤 1：编写渲染测试（mock 配置仓库）**

```tsx
// frontend/components/customer-service/customer-service-client.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { CustomerServiceClient } from './customer-service-client'

vi.mock('@/lib/api/ai-chat-config-store', () => ({
  ensureConfigLoaded: vi.fn(() => Promise.resolve()),
  getConfig: () => ({
    providerConfigured: true,
    webSearchConfigured: false,
    models: [],
    defaultModel: '',
    premiumModels: [],
    basicModels: [],
    reasoningModels: [],
    defaultReasoningEffort: 'medium',
    timeoutSeconds: 90,
    maxConversationTurns: 10,
    webSearchMaxResults: 5,
    overviewOptions: [],
    detailOptions: [],
    scenarios: [
      { id: 'ops-report', label: '运营汇报话术', description: 'x', mode: 'refine', disabled: false },
      { id: 'email-compose', label: '邮件撰写', description: 'y', mode: 'compose', disabled: true },
    ],
  }),
}))

describe('CustomerServiceClient', () => {
  beforeEach(() => vi.clearAllMocks())
  it('渲染两个场景 tab 且邮件撰写标记即将上线', async () => {
    render(<CustomerServiceClient />)
    expect(await screen.findByText('运营汇报话术')).toBeTruthy()
    expect(await screen.findByText('邮件撰写（即将上线）')).toBeTruthy()
  })
})
```

- [ ] **步骤 2：运行测试**

运行：`cd frontend && pnpm test components/customer-service/customer-service-client.test.tsx`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add frontend/components/customer-service/customer-service-client.test.tsx
git commit -m "test(客服交流): 页面渲染冒烟测试"
```

---

### 任务 10：全量验收

- [ ] **步骤 1：lint + build + test 全绿**

运行：`cd frontend && pnpm lint && pnpm build && pnpm test`
预期：三项均通过，无 error。

- [ ] **步骤 2：手动验收清单（交给用户）**

1. 侧边栏「AI面板」出现「客服交流」，点击进入 `/dashboard/ai/customer-service`。
2. 顶部场景 tab 显示「运营汇报话术」（启用）与「邮件撰写（即将上线）」（禁用，不可点）。
3. 左栏粘贴草稿并填写「汇报周期 / 核心指标 / 异常 / 下一步」任意内容，点「生成」。
4. 右栏出现 3 张卡片：简洁周报版 / 正式报告版 / 口头汇报版，分别流式输出。
5. 切换「中文 / English」，重新生成，输出语言随之变化。
6. 切换「简报 / 标准 / 详细」，输出篇幅随之变化。
7. 每张卡片「复制」「导出」可用；「重生成」可刷新当前卡片。
8. 刷新页面后左栏草稿仍在（sessionStorage）。
9. 后续加场景只需在 `SCENARIO_PRESETS` 加一条配置，无需新建页面/路由。

---

## 自检

**1. 规格覆盖度**
- 落地位置（§3 任务 5 sidebar）：✅
- 双栏润色式（任务 6/7/8）：✅
- 手动粘贴（InputPane 自由粘贴区）：✅
- 2-3 语气备选（ToneCard × toneOptions）：✅
- 明确中英文切换（InputPane 语言 toggle → 路由 → system prompt）：✅
- 可扩展 ScenarioPreset 框架（任务 1）：✅
- 邮件撰写 compose 占位（disabled tab）：✅
- 本地草稿暂存（任务 6 sessionStorage）：✅
- 不做 DB / 话术库 / 平台拉取（YAGNI，均未实现）：✅

**2. 占位符扫描**：无「待定 / TODO / 后续实现」；每个代码步骤均有完整代码块。

**3. 类型一致性**：`ScenarioSummary` / `ScenarioField` / `ToneOption` 在 `lib/server/ai-chat.ts` 定义，`customer-service-client` / `input-pane` / `tone-card` / 测试统一从此导入；`useChatStream` 的 `ChatStreamOptions` 新增字段与路由 body 字段名一致（scenarioId/toneId/language/length）；`buildUserContent` 签名在测试与 ToneCard 中一致。

**4. 范围**：单计划可独立产出可工作软件；邮件撰写仅占位，不做实现，符合 v1 范围。
