const API_BASE = '/api/backend/api/v1'

type ClientAuditPayload = {
  action: string
  targetType: string
  targetId?: string | number | null
  result?: 'success' | 'failure'
  after?: Record<string, unknown> | unknown[] | null
  errorMessage?: string | null
}

export async function logClientOperation(payload: ClientAuditPayload): Promise<void> {
  try {
    await fetch(`${API_BASE}/system-management/operation-audit-logs/client-actions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: payload.action,
        target_type: payload.targetType,
        target_id: payload.targetId == null ? null : String(payload.targetId),
        result: payload.result ?? 'success',
        after: payload.after ?? null,
        error_message: payload.errorMessage ?? null,
      }),
    })
  } catch {
    // Best effort only. Client-side exports should not fail because audit logging failed.
  }
}
