import { Session } from 'next-auth'

export type ProjectContextResponse = {
  project_id: number
  project_name: string
  project_context: Record<string, unknown> | null
  sku_context: Record<string, unknown> | null
}

export type ProjectContextUpdate = {
  project_context?: Record<string, unknown>
  sku_context?: Record<string, unknown>
}

const API_BASE = '/api/backend'

export async function fetchProjectContext(
  projectId: number,
  _session: Session | null
): Promise<ProjectContextResponse> {
  const response = await fetch(`${API_BASE}/api/v1/projects/${projectId}/context`, {
    headers: {
      'Content-Type': 'application/json',
    },
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `Failed to fetch project context: ${response.status}`)
  }
  return response.json()
}

export async function updateProjectContext(
  projectId: number,
  payload: ProjectContextUpdate,
  _session: Session | null
): Promise<ProjectContextResponse> {
  const response = await fetch(`${API_BASE}/api/v1/projects/${projectId}/context`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `Failed to update project context: ${response.status}`)
  }
  return response.json()
}