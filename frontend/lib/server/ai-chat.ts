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
    content:
      '回答时先输出一个标题为”总结”的章节，用 3-5 条要点先给出结论、要点和主要建议。',
  },
  {
    id: 'overview-brief',
    label: '结构化·简洁',
    description: '用简洁的语言概括核心结论。',
    content:
      '回答时先输出一个标题为”总结”的章节，用精炼的语言概括核心结论和主要建议。',
  },
]

const DETAIL_PROMPT_PRESETS: PromptPreset[] = [
  {
    id: 'detail-standard',
    label: '展开·标准',
    description: '补充原因、证据和进一步说明。',
    content:
      '回答时还必须输出一个标题为”详细说明”的章节，展开说明原因拆解、关键依据和补充信息。',
  },
  {
    id: 'detail-stepped',
    label: '展开·分步骤',
    description: '按步骤或分点结构展开说明。',
    content:
      '回答时还必须输出一个标题为”详细说明”的章节，按”步骤/分点”结构展开每个要点。',
  },
]

export function getPromptPresetSummaries() {
  return {
    overviewOptions: OVERVIEW_PROMPT_PRESETS.map(({ id, label, description }) => ({ id, label, description })),
    detailOptions: DETAIL_PROMPT_PRESETS.map(({ id, label, description }) => ({ id, label, description })),
  }
}

function findPromptPreset(presets: PromptPreset[], id: string | null | undefined) {
  if (!id || id === 'none') {
    return null
  }
  return presets.find((item) => item.id === id) ?? null
}

export function buildSystemPrompt(overviewPromptId?: string | null, detailPromptId?: string | null) {
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

export function validatePromptPresetIds(overviewPromptId?: string | null, detailPromptId?: string | null) {
  const overviewValid = !overviewPromptId || overviewPromptId === 'none' || Boolean(findPromptPreset(OVERVIEW_PROMPT_PRESETS, overviewPromptId))
  const detailValid = !detailPromptId || detailPromptId === 'none' || Boolean(findPromptPreset(DETAIL_PROMPT_PRESETS, detailPromptId))

  return overviewValid && detailValid
}
