type BackendErrorPayload = { detail?: string; message?: string }

function trimTrailingSlash(value: string) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

export function getBackendBaseUrl() {
  const base =
    process.env.BACKEND_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    'http://127.0.0.1:8000'
  return trimTrailingSlash(base)
}

export function getBackendApiKey() {
  return process.env.BACKEND_API_KEY || process.env.NEXT_PUBLIC_BACKEND_API_KEY || ''
}

export async function backendFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getBackendBaseUrl()}${path}`, init)
  const data = (await response.json()) as T & BackendErrorPayload
  if (!response.ok) {
    throw new Error(data.message || data.detail || '请求后端失败')
  }
  return data
}
