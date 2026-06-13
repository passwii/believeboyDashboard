/**
 * AI Chat config store — tiny, dependency-free client cache.
 *
 * Why a hand-rolled store instead of zustand / react-query?
 * - The /api/ai-chat/config payload is small, fetched at most once per
 *   session, and read by both <ModelSelector /> and the input.
 * - React Query / zustand add bundle weight and another mental model for a
 *   value that is essentially a process-level singleton.
 * - This 70-line store gives us the same "fetch once, share across components"
 *   guarantee with zero deps and full type safety.
 *
 * Wire-up:
 *   - `AIChatWindow` calls `ensureConfigLoaded()` in an effect; once the
 *     config lands, every consumer of `getConfig()` sees the same data.
 *   - The store is module-scoped, so it survives Fast Refresh and is shared
 *     across all components in the bundle.
 */

import { fetchAIChatConfig, type AIChatConfig } from './ai-chat'

type State = {
  config: AIChatConfig | null
  loading: boolean
  error: string | null
  /** Subscribers notified whenever the config changes. */
  listeners: Set<() => void>
}

const state: State = {
  config: null,
  loading: false,
  error: null,
  listeners: new Set(),
}

let inFlight: Promise<AIChatConfig> | null = null

function notify() {
  for (const fn of state.listeners) {
    try {
      fn()
    } catch {
      // Listener errors must not break the rest.
    }
  }
}

/**
 * Idempotent: callers may invoke this many times — only one network request
 * is ever in flight, and subsequent calls resolve with the cached value.
 */
export async function ensureConfigLoaded(force = false): Promise<AIChatConfig> {
  if (state.config && !force) return state.config
  if (inFlight) return inFlight

  state.loading = true
  state.error = null
  notify()

  inFlight = fetchAIChatConfig()
    .then((config) => {
      state.config = config
      state.error = null
      return config
    })
    .catch((err) => {
      state.error = err instanceof Error ? err.message : '加载 AI 配置失败'
      throw err
    })
    .finally(() => {
      state.loading = false
      inFlight = null
      notify()
    })

  return inFlight
}

export function getConfig(): AIChatConfig | null {
  return state.config
}

/**
 * React-side subscription helper. Returns a `subscribe` function for
 * `useSyncExternalStore`; consumers should pass `getSnapshot` separately
 * if they need fine-grained re-renders.
 */
export function subscribe(listener: () => void): () => void {
  state.listeners.add(listener)
  return () => {
    state.listeners.delete(listener)
  }
}
