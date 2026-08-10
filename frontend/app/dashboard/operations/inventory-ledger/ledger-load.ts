/**
 * Minimal fetch wrapper for the inventory-ledger page (BEL-417 iteration 1).
 *
 * Why this exists: the page used to do `fetch(...).then(r => r.json())` with
 * no `r.ok` check and a silent catch — a backend 500 body such as
 * `{"detail":"Internal Server Error"}` was stored as page data and the
 * render crashed on `snapshot.skus.reduce(...)` (white screen). This helper
 * throws a readable error on non-2xx so callers can show a real error state.
 */

export class LedgerApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'LedgerApiError'
    this.status = status
  }
}

/**
 * Fetch `url` and parse JSON, throwing `LedgerApiError` on non-2xx.
 * The error message prefers the backend's `detail` / `message` field and
 * falls back to `请求失败（HTTP <status>）` when the body is not parseable.
 */
export async function fetchLedgerJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    let detail = `请求失败（HTTP ${res.status}）`
    try {
      const body: unknown = await res.json()
      if (body && typeof body === 'object') {
        const record = body as { detail?: unknown; message?: unknown }
        const candidate = record.detail ?? record.message
        if (typeof candidate === 'string' && candidate.trim()) {
          detail = candidate
        }
      }
    } catch {
      // Non-JSON error body — keep the generic HTTP status message.
    }
    throw new LedgerApiError(detail, res.status)
  }
  return (await res.json()) as T
}
