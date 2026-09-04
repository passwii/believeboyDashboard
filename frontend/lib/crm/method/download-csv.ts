/**
 * CRM CSV 导出下载工具（P3b）。
 *
 * 经 Next 代理 `/api/backend/v1/crm/...` 拉取后端 CSV（代理注入鉴权头，
 * 故不能用 window.open——它带不上 session），fetch 拿到 blob 后触发浏览器下载。
 */
const BASE = '/api/backend/v1/crm'

export type CrmExportEntity = 'customers' | 'leads'

export interface CrmExportParams {
  scope?: 'mine' | 'all' | 'sea'
  keyword?: string
}

function todayStamp(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function defaultFilename(entity: CrmExportEntity): string {
  return `${entity === 'customers' ? '客户' : '线索'}_${todayStamp()}.csv`
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/**
 * 下载客户/线索 CSV。失败抛 Error（消息取自后端 detail 或通用文案）。
 */
export async function downloadCrmCsv(entity: CrmExportEntity, params: CrmExportParams = {}): Promise<void> {
  const qs = new URLSearchParams()
  if (params.scope) qs.set('scope', params.scope)
  if (params.keyword) qs.set('keyword', params.keyword)
  const query = qs.toString()
  const url = `${BASE}/${entity}/export${query ? `?${query}` : ''}`

  const res = await fetch(url)
  if (!res.ok) {
    let message = `导出失败（${res.status}）`
    try {
      const body = await res.json()
      if (typeof body?.detail === 'string') message = body.detail
      else if (typeof body?.message === 'string') message = body.message
    } catch {
      // 非 JSON 错误体，保留默认消息
    }
    throw new Error(message)
  }
  const blob = await res.blob()
  triggerDownload(blob, defaultFilename(entity))
}
