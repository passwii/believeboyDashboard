export type PromptPresetSummary = {
  id: string
  label: string
  description: string
}

type PromptPreset = PromptPresetSummary & {
  content: string
}

const OVERVIEW_PROMPT_PRESETS: PromptPreset[] = [
  {
    id: 'overview-structured',
    label: '结构化·先说结论',
    description: '先给出结论要点，再展开说明。',
    content: '回答时先输出一个标题为”总结”的章节，用 3-5 条要点先给出结论、要点和主要建议。',
  },
  {
    id: 'overview-brief',
    label: '结构化·简洁',
    description: '用简洁的语言概括核心结论。',
    content: '回答时先输出一个标题为”总结”的章节，用精炼的语言概括核心结论和主要建议。',
  },
]

const DETAIL_PROMPT_PRESETS: PromptPreset[] = [
  {
    id: 'detail-standard',
    label: '展开·标准',
    description: '补充原因、证据和进一步说明。',
    content: '回答时还必须输出一个标题为”详细说明”的章节，展开说明原因拆解、关键依据和补充信息。',
  },
  {
    id: 'detail-stepped',
    label: '展开·分步骤',
    description: '按步骤或分点结构展开说明。',
    content: '回答时还必须输出一个标题为”详细说明”的章节，按”步骤/分点”结构展开每个要点。',
  },
]

export function getPromptPresetSummaries() {
  return {
    overviewOptions: OVERVIEW_PROMPT_PRESETS.map(({ id, label, description }) => ({
      id,
      label,
      description,
    })),
    detailOptions: DETAIL_PROMPT_PRESETS.map(({ id, label, description }) => ({
      id,
      label,
      description,
    })),
  }
}

function findPromptPreset(presets: PromptPreset[], id: string | null | undefined) {
  if (!id || id === 'none') {
    return null
  }
  return presets.find((item) => item.id === id) ?? null
}

export function buildSystemPrompt(
  overviewPromptId?: string | null,
  detailPromptId?: string | null
) {
  const baseInstruction =
    '你是一个乐于助人的智能助手。请使用中文回答问题，尽可能提供准确、有用的信息。如果不确定，请如实说明。'

  const overviewPreset = findPromptPreset(OVERVIEW_PROMPT_PRESETS, overviewPromptId)
  const detailPreset = findPromptPreset(DETAIL_PROMPT_PRESETS, detailPromptId)

  const parts = [baseInstruction]
  if (overviewPreset) {
    parts.push(overviewPreset.content)
  }
  if (detailPreset) {
    parts.push(detailPreset.content)
  }

  return parts.join('\n\n')
}

export function validatePromptPresetIds(
  overviewPromptId?: string | null,
  detailPromptId?: string | null
) {
  const overviewValid =
    !overviewPromptId ||
    overviewPromptId === 'none' ||
    Boolean(findPromptPreset(OVERVIEW_PROMPT_PRESETS, overviewPromptId))
  const detailValid =
    !detailPromptId ||
    detailPromptId === 'none' ||
    Boolean(findPromptPreset(DETAIL_PROMPT_PRESETS, detailPromptId))

  return overviewValid && detailValid
}

// =========================== ScenarioPreset（客服交流） ===========================

import { Mail, MessagesSquare } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

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
  icon?: LucideIcon
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
    icon: MessagesSquare,
    systemPrompt:
      '你是一名资深的亚马逊运营专家，擅长把运营数据转化为清晰、专业、有结论的汇报话术。受众是你的直属主管。请严格遵循结构：结论先行 → 数据支撑 → 风险/异常 → 下一步建议。',
    showFreeTextArea: true,
    inputSchema: [
      { key: 'period', label: '汇报周期', type: 'text', placeholder: '如：本周 / 本月' },
      {
        key: 'metrics',
        label: '核心指标',
        type: 'textarea',
        placeholder: '销售额 / 订单量 / ACOS / 广告花费 / 利润',
      },
      {
        key: 'risks',
        label: '重点事项或异常',
        type: 'textarea',
        placeholder: '库存告警、排名波动等',
      },
      { key: 'next', label: '下一步计划', type: 'textarea', placeholder: '准备做的事' },
    ],
    outputFormat: '结论先行 → 数据支撑 → 风险/异常 → 下一步建议',
    toneOptions: [
      {
        id: 'brief',
        label: '简洁周报版',
        description: '一句话结论 + 要点，适合群里快速同步',
        promptSuffix: '输出简洁的周报版：先一句话结论，再列 3-5 条要点，控制在 200 字以内。',
      },
      {
        id: 'formal',
        label: '正式报告版',
        description: '完整结构化报告，适合正式汇报',
        promptSuffix:
          '输出正式报告版：完整的结构化段落（结论 / 数据支撑 / 风险异常 / 下一步），用词正式、严谨。',
      },
      {
        id: 'verbal',
        label: '口头汇报版',
        description: '口语化、可照读',
        promptSuffix: '输出口头汇报版：口语化、自然，像当面汇报一样，可直接照着说。',
      },
    ],
    languageToggle: true,
  },
  {
    id: 'email-compose',
    label: '邮件撰写',
    description: '面向消费者的邮件拟定（即将上线）。',
    mode: 'compose',
    icon: Mail,
    systemPrompt:
      '你是一名专业的客服邮件撰写者，擅长根据上下文为真实消费者拟定邮件。受众是消费者。',
    showFreeTextArea: false,
    inputSchema: [
      {
        key: 'recipient',
        label: '收件人角色 / 场景',
        type: 'text',
        placeholder: '如：已下单未付款客户',
      },
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

export function findScenarioPreset(id: string | null | undefined): ScenarioPreset | null {
  if (!id) return null
  return SCENARIO_PRESETS.find((s) => s.id === id) ?? null
}

export function buildScenarioSystemPrompt(
  scenarioId?: string | null,
  toneId?: string | null,
  language?: string | null,
  length?: string | null
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

export function validateScenarioIds(scenarioId?: string | null, toneId?: string | null): boolean {
  if (!scenarioId) return true
  const scenario = findScenarioPreset(scenarioId)
  if (!scenario || scenario.disabled) return false
  if (!toneId) return true
  return scenario.toneOptions.some((t) => t.id === toneId)
}
