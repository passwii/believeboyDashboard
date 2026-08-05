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
  agent_id: string | null
  is_revoked: boolean
  expires_at: string | null
  created_at: string
  last_used_at: string | null
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

export async function listAgentApiKeys(): Promise<AgentApiKeyItem[]> {
  const res = await fetch(`${API_BASE}/api/v1/internal/api-keys`, {
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
}): Promise<AgentApiKeyCreateResult> {
  const res = await fetch(`${API_BASE}/api/v1/internal/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`凭据创建失败：HTTP ${res.status}`)
  return res.json()
}

export async function revokeAgentApiKey(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/internal/api-keys/${id}/revoke`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`凭据吊销失败：HTTP ${res.status}`)
}
