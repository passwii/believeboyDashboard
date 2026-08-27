/**
 * Agent API 凭据管理封装（对应后端 /api/v1/internal/api-keys）。
 *
 * 走 /api/backend 代理；X-Is-Admin 由代理按 session 自动注入
 * （lib/backend-auth.ts buildBackendAuthHeaders），客户端不需要也不允许自造。
 */

const API_BASE = '/api/backend'

export type AgentApiKeyItem = {
  id: number
  key_prefix: string
  label: string
  scope: string
  project_scope: string
  business_scope: string
  agent_id: string | null
  is_revoked: boolean
  expires_at: string | null
  created_at: string
  last_used_at: string | null
  /** 软删除 tombstone（BLF-468）；默认列表隐藏，`?include_deleted=true` 全量 */
  deleted_at: string | null
}

export type AgentApiKeyCreateResult = AgentApiKeyItem & {
  plaintext_key: string
}

/**
 * 归一化项目范围：空串 / '*' → '*'（全项目，服务端哨兵值）；
 * 其余保持 ',' 分隔的 project_id 白名单。
 */
export function normalizeProjectScope(scope: string | undefined | null): string {
  if (!scope) return '*'
  const trimmed = scope.trim()
  if (!trimmed || trimmed === '*') return '*'
  return trimmed
}

/**
 * 归一化业务域范围：空串 / '*' → '*'（全业务域，服务端哨兵值）；
 * 其余保持 ',' 分隔的域 code 白名单。
 */
export function normalizeBusinessScope(scope: string | undefined | null): string {
  if (!scope) return '*'
  const trimmed = scope.trim()
  if (!trimmed || trimmed === '*') return '*'
  return trimmed
}

export async function listAgentApiKeys(includeDeleted = false): Promise<AgentApiKeyItem[]> {
  const query = includeDeleted ? '?include_deleted=true' : ''
  const res = await fetch(`${API_BASE}/api/v1/internal/api-keys${query}`, {
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`凭据列表加载失败：HTTP ${res.status}`)
  return res.json()
}

export async function createAgentApiKey(input: {
  label: string
  agent_id: string
  expires_at: string | null
  project_scope: string
  business_scope: string
}): Promise<AgentApiKeyCreateResult> {
  const res = await fetch(`${API_BASE}/api/v1/internal/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) await throwWithDetail(res, '凭据创建失败')
  return res.json()
}

/**
 * 编辑凭据的权限与业务范围（BLF-480）。
 *
 * PATCH 语义：仅更新显式传入的字段。后端把空串归一为 '*'（全项目 / 全域），
 * 编辑即刻生效——鉴权路径每请求实时读列，无需重建凭据。
 */
export async function updateAgentApiKey(
  id: number,
  input: { label?: string; project_scope?: string; business_scope?: string }
): Promise<AgentApiKeyItem> {
  const res = await fetch(`${API_BASE}/api/v1/internal/api-keys/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) await throwWithDetail(res, '凭据更新失败')
  return res.json()
}

export async function deactivateAgentApiKey(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/internal/api-keys/${id}/deactivate`, {
    method: 'POST',
  })
  if (!res.ok) await throwWithDetail(res, '凭据停用失败')
}

export async function activateAgentApiKey(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/internal/api-keys/${id}/activate`, {
    method: 'POST',
  })
  if (!res.ok) await throwWithDetail(res, '凭据激活失败')
}

export async function deleteAgentApiKey(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/internal/api-keys/${id}`, {
    method: 'DELETE',
  })
  if (!res.ok) await throwWithDetail(res, '凭据删除失败')
}

/** 兼容别名（BLF-468）：旧调用方仍可用，语义等同停用。 */
export async function revokeAgentApiKey(id: number): Promise<void> {
  return deactivateAgentApiKey(id)
}

/** Agent ID 校验：小写字母/数字开头，a-z0-9-_，3-128（与后端 provisioning.py 对齐）。 */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,127}$/
export const AGENT_ID_HINT = '小写字母/数字开头，a-z0-9-_，3-128 字符'
export function isValidAgentId(value: string): boolean {
  return AGENT_ID_PATTERN.test(value)
}

async function throwWithDetail(res: Response, prefix: string): Promise<never> {
  let detail: string | null = null
  try {
    const data = await res.clone().json()
    if (typeof data?.detail === 'string' && data.detail) detail = data.detail
    else if (typeof data?.error?.human_message === 'string' && data.error.human_message) detail = data.error.human_message
    else if (typeof data?.error?.message === 'string' && data.error.message) detail = data.error.message
    else if (typeof data?.message === 'string' && data.message) detail = data.message
  } catch {
    // ignore parse failure, fallback to status
  }
  const suffix = detail ? detail : `HTTP ${res.status}`
  const err = new Error(`${prefix}：${suffix}`)
  ;(err as unknown as Record<string, unknown>).status = res.status
  ;(err as unknown as Record<string, unknown>).httpStatus = res.status
  throw err
}
