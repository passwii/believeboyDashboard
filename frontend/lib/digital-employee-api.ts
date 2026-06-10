const API_BASE = '/api/backend'

function resolveApiUrl(path: string) {
  const base = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE
  return `${base}${path}`
}

// Backend sends lowercase enum values (e.g. "idle"), frontend uses uppercase (e.g. "IDLE")
function normalizeEmployee(data: Record<string, unknown>) {
  return {
    ...data,
    status: (data.status as string)?.toUpperCase() ?? data.status,
    employee_type: (data.employee_type as string)?.toUpperCase() ?? data.employee_type,
  }
}

function normalizeResponse(data: { items: unknown[]; total: number }) {
  return {
    ...data,
    items: data.items.map((item) => normalizeEmployee(item as Record<string, unknown>)),
  }
}

export async function fetchDigitalEmployees(signal?: AbortSignal): Promise<{
  items: import('@/types/digital-employee').DigitalEmployee[]
  total: number
}> {
  const res = await fetch(resolveApiUrl('/api/v1/digital-employees'), {
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  })
  if (res.status === 401) {
    window.location.href = '/login'
    return { items: [], total: 0 }
  }
  if (!res.ok) throw new Error('Failed to fetch digital employees')
  return normalizeResponse(await res.json()) as unknown as {
    items: import('@/types/digital-employee').DigitalEmployee[]
    total: number
  }
}

export async function fetchDigitalEmployee(id: number) {
  const res = await fetch(resolveApiUrl(`/api/v1/digital-employees/${id}`), { cache: 'no-store' })
  if (res.status === 401) {
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }
  if (!res.ok) throw new Error('Failed to fetch digital employee')
  return normalizeEmployee(await res.json()) as import('@/types/digital-employee').DigitalEmployee
}

export async function fetchEmployeeTasks(id: number) {
  const res = await fetch(resolveApiUrl(`/api/v1/digital-employees/${id}/tasks`), { cache: 'no-store' })
  if (res.status === 401) {
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }
  if (!res.ok) throw new Error('Failed to fetch tasks')
  return normalizeResponse(await res.json()) as unknown as {
    items: import('@/types/digital-employee').DigitalEmployeeTask[]
    total: number
  }
}

export async function fetchEmployeeLogs(employeeId: number, taskId: number) {
  const res = await fetch(resolveApiUrl(`/api/v1/digital-employees/${employeeId}/tasks/${taskId}/logs`), { cache: 'no-store' })
  if (res.status === 401) {
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }
  if (!res.ok) throw new Error('Failed to fetch logs')
  return res.json()
}

export async function fetchEmployeeRecentLogs(employeeId: number, limit = 20) {
  const res = await fetch(resolveApiUrl(`/api/v1/digital-employees/${employeeId}/recent-logs?limit=${limit}`), {
    cache: 'no-store',
  })
  if (res.status === 401) {
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }
  if (!res.ok) throw new Error('Failed to fetch recent logs')
  return res.json() as Promise<{ items: import('@/types/digital-employee').DigitalEmployeeLog[] }>
}

export async function suspendEmployee(id: number) {
  const res = await fetch(resolveApiUrl(`/api/v1/digital-employees/${id}/status`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'SUSPENDED' }),
  })
  if (!res.ok) throw new Error('Failed to suspend')
}

export async function resumeEmployee(id: number) {
  const res = await fetch(resolveApiUrl(`/api/v1/digital-employees/${id}/status`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'IDLE' }),
  })
  if (!res.ok) throw new Error('Failed to resume')
}