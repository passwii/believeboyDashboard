/**
 * 拟人化文案模板 — 纯函数，把 (state, bucket) 渲染为中文文案。
 * 默认严谨型，未来可通过 employee.persona_style 切换为亲切/活泼等风格。
 */

import type { RhythmState, RhythmBucket } from './rhythm-player'

export interface TemplateContext {
  bucket: RhythmBucket | null
  employeeName: string
}

const TEMPLATES: Record<RhythmState, string> = {
  WORKING: '📊 正在核对【{{project_name}}】的 {{report_label}}，数据范围 {{date_range}}…',
  IDLE: '🍵 当前没有新报表，静候下一批任务…',
  OFFLINE: '🌙 今日工作告一段落，明日再续。',
}

const FAILED_TEMPLATE = '⚠️ 【{{project_name}}】的 {{report_label}} 入库失败，请人工确认'

function fillPlaceholders(template: string, bucket: RhythmBucket): string {
  return template
    .replace(/\{\{project_name\}\}/g, bucket.projectName)
    .replace(/\{\{report_label\}\}/g, bucket.reportLabel)
    .replace(/\{\{date_range\}\}/g, bucket.dateRange)
    .replace(/\{\{row_count\}\}/g, String(bucket.rowCountTotal))
}

export function renderState(state: RhythmState, ctx: TemplateContext): string {
  if (state === 'WORKING' && !ctx.bucket) {
    return renderState('IDLE', ctx)
  }
  if (state === 'IDLE' || state === 'OFFLINE') {
    return TEMPLATES[state]
  }
  if (ctx.bucket?.status === 'FAILED') {
    return fillPlaceholders(FAILED_TEMPLATE, ctx.bucket)
  }
  return fillPlaceholders(TEMPLATES[state], ctx.bucket!)
}
