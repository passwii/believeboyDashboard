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
