/**
 * fetch wrapper with AbortController timeout.
 * Prevents requests from hanging indefinitely when the backend is slow or unresponsive.
 */

interface FetchWithTimeoutInit extends RequestInit {
  /** Timeout in milliseconds. Defaults to 5_000 ms (5s short timeout). */
  timeoutMs?: number
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: FetchWithTimeoutInit
): Promise<Response> {
  const { timeoutMs = 5_000, signal: userSignal, ...rest } = init ?? {}

  if (userSignal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // Forward user-initiated abort to our controller.
  const onUserAbort = () => controller.abort()
  userSignal?.addEventListener('abort', onUserAbort, { once: true })

  try {
    return await fetch(input, { ...rest, signal: controller.signal })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      if (userSignal?.aborted) {
        throw err // user cancelled — propagate as-is
      }
      throw new Error(`请求超时（${timeoutMs / 1000}秒），请稍后重试`)
    }
    throw err
  } finally {
    clearTimeout(timer)
    userSignal?.removeEventListener('abort', onUserAbort)
  }
}
