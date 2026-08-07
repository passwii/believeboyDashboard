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
  /** Agent 中文显示名（BLF-471）：英文 agent_id 的对应中文名，运营可读 */
  agent_name: string | null
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
  agent_name?: string | null
  expires_at: string | null
  project_scope: string
  business_scope: string
}): Promise<AgentApiKeyCreateResult> {
  const res = await fetch(`${API_BASE}/api/v1/internal/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`凭据创建失败：HTTP ${res.status}`)
  return res.json()
}

/** 更新 Agent 中文显示名（BLF-471）；运营/管理员可随时修正/回填中文名。 */
export async function updateAgentApiKeyName(
  id: number,
  agentName: string
): Promise<{ id: number; agent_id: string | null; agent_name: string | null }> {
  const res = await fetch(`${API_BASE}/api/v1/internal/api-keys/${id}/agent-name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_name: agentName }),
  })
  if (!res.ok) throw new Error(`Agent 名称更新失败：HTTP ${res.status}`)
  return res.json()
}

export async function deactivateAgentApiKey(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/internal/api-keys/${id}/deactivate`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`凭据停用失败：HTTP ${res.status}`)
}

export async function activateAgentApiKey(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/internal/api-keys/${id}/activate`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`凭据激活失败：HTTP ${res.status}`)
}

export async function deleteAgentApiKey(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/internal/api-keys/${id}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`凭据删除失败：HTTP ${res.status}`)
}

/** 兼容别名（BLF-468）：旧调用方仍可用，语义等同停用。 */
export async function revokeAgentApiKey(id: number): Promise<void> {
  return deactivateAgentApiKey(id)
}
