const BACKEND_UNAVAILABLE_PATTERNS = [
  'fetch failed',
  'failed to fetch',
  'networkerror',
  'network request failed',
  'load failed',
  'proxy request failed',
  'econnrefused',
  'socket hang up',
  'backend unavailable',
] as const

export const BACKEND_UNAVAILABLE_TITLE = '后端服务暂时不可用'
export const BACKEND_UNAVAILABLE_MESSAGE =
  '当前无法连接后端服务，请稍后重试；如果问题持续出现，请联系管理员检查服务状态。'
export const GENERIC_ERROR_TITLE = '页面暂时不可用'
export const GENERIC_ERROR_MESSAGE =
  '页面遇到异常，请刷新后重试；如果仍然无法恢复，请联系管理员协助处理。'

function toErrorText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  if (value && typeof value === 'object') {
    const maybeMessage = 'message' in value ? value.message : ''
    if (typeof maybeMessage === 'string') return maybeMessage
  }
  return ''
}

export function isBackendUnavailableError(value: unknown): boolean {
  const text = toErrorText(value).trim().toLowerCase()
  if (!text) return false
  return BACKEND_UNAVAILABLE_PATTERNS.some((pattern) => text.includes(pattern))
}

export function normalizeErrorMessage(value: unknown, fallback = GENERIC_ERROR_MESSAGE): string {
  if (isBackendUnavailableError(value)) {
    return BACKEND_UNAVAILABLE_MESSAGE
  }

  const text = toErrorText(value).trim()
  return text || fallback
}

const ERROR_CODE_MESSAGES: Record<string, string> = {
  QUERY_DEADLINE_EXCEEDED: '查询超时，请收窄筛选条件',
  BACKEND_TIMEOUT: '后端响应超时，请稍后重试',
}

export function parseErrorText(text: string, fallback: string, status?: number): string {
  const raw = text.trim()
  if (!raw) {
    return status ? `请求失败 (${status})` : fallback
  }

  try {
    const payload = JSON.parse(raw) as {
      code?: unknown
      detail?: unknown
      message?: unknown
      error?: unknown
    }
    const codeMessage = typeof payload.code === 'string' ? ERROR_CODE_MESSAGES[payload.code] : undefined
    return normalizeErrorMessage(
      codeMessage ?? payload.detail ?? payload.message ?? payload.error ?? raw,
      fallback
    )
  } catch {
    return normalizeErrorMessage(raw, fallback)
  }
}

export async function parseResponseError(response: Response, fallback: string): Promise<string> {
  const raw = await response.text()
  return parseErrorText(raw, fallback, response.status)
}
