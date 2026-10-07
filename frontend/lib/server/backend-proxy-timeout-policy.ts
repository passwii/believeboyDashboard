/**
 * Endpoint-tiered timeout policy for the backend proxy.
 *
 * Why a tier table instead of one fixed number?
 * The default 5s is good for short, high-frequency reads but starves
 * legitimately long endpoints (AI generation, report assembly, email
 * dispatch). A path-pattern tier table lets us pick a sane per-endpoint
 * timeout without scattering `if (path === '/foo')` checks through the
 * proxy route.
 *
 * Matching rules (first match wins — order matters, most-specific first):
 *   1. Streaming endpoints (SSE / NDJSON) → 0 (no timeout)
 *   2. Long-running report / email endpoints → 60_000
 *   3. AI / insight generation → 30_000
 *   4. Statistics / aggregations → 15_000
 *   5. Detail endpoints (single-resource GET) → 10_000
 *   6. List endpoints (collection GET) → 5_000
 *   7. Default → 5_000
 *
 * Streams are also detected by `Accept: text/event-stream` or
 * `application/x-ndjson` — the caller's `Accept` is the most reliable
 * signal because it works for endpoints that are not yet on the
 * `STREAM_PATH_PATTERNS` list.
 */
export type TimeoutTier = {
  /** Human-readable label — used for log lines and review breadcrumbs. */
  readonly label: string
  /** Regex tested against the normalized backend path (e.g. `api/v1/...`). */
  readonly pathPattern?: RegExp
  /**
   * If set, the tier matches when the request's `Accept` header contains
   * any of these substrings. Case-insensitive. This is the only way to
   * identify streaming endpoints that the path pattern does not cover.
   */
  readonly acceptContains?: ReadonlyArray<string>
  /** Timeout in ms. `0` means "no timeout" — let the connection close naturally. */
  readonly timeoutMs: number
}

const STREAM_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\/ai-insights\/.+\/stream$/,
  /\/ai-insights\/generate\/stream$/,
  /\/insight\/runs\/[^/]+\/stream$/,
]

const STREAM_ACCEPT_TOKENS: ReadonlyArray<string> = ['text/event-stream', 'application/x-ndjson']

const REPORT_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\/scheduled-reports\/test-email$/,
  /\/scheduled-reports\/.+\/run$/,
  // 月度核算明细会同步生成多工作表 Excel，不能走默认 5s 档。
  /\/monthly-reports\/financial-series\/accounting-detail\/export$/,
  // BEL-417: `report-upload/commit` ingests large files (e.g. inventory ledger
  // monthly reports 30-50k rows). Bumping to 60s so 1× monthly upload survives
  // the 5s default. Pair with the `COPY FROM STDIN` rewrite of
  // `ingest_ledger_csv` for throughput — see commit `2026-08-03-bel-417-*`.
  /\/report-upload\/commit$/,
]

const AI_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\/ai-chat\//,
  /\/ai-insights\/generate$/,
  /\/ai-insights\/.+\/regenerate$/,
  // BLF-1016/1017：canonical 域 run 入口（广告分析 / 库存健康）在服务端要
  // 先收敛口径再建 run，默认 5s 档会超时（run 创建后正文走 SSE，不受影响）。
  /\/insight\/(ad-analysis|inventory-health)\/runs$/,
]

// BLF-1262 Stage 1：后端 overview 对单条 SQL 设 15s statement_timeout；给代理
// 留出 5s 让后端返回有说明的 504，而不是让代理先掐断并留下后台查询。
const ORDER_INFO_OVERVIEW_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\/order-info\/overview(?:\?.*)?$/,
]

const STATS_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\/metrics\//,
  /\/aggregations\//,
  /\/dashboard\/summary$/,
  // BLF-1019：order-info/filter-options 是 3 个 distinct 全表扫（3-6s），
  // 默认 5s 档必超时 → 前端下拉永久空白。给 15s stats 档。
  /\/order-info\/filter-options$/,
  // 退货分析原始行：一次返回整周期无分页明细，属统计量级而非单资源 detail；
  // `$` 锚定保证不误伤 /return-analysis 主端点（那仍走默认 5s 档）。
  /\/return-analysis\/raw-rows$/,
]

const DETAIL_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\/projects\/[^/]+$/,
  /\/sku-info\/[^/]+$/,
  /\/products\/[^/]+$/,
  /\/inventory-replenishment-snapshots\/[^/]+$/,
  /\/inventory-replenishment-snapshots\/[^/]+\/items$/,
]

const LIST_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\/projects\/manage$/,
  /\/projects\/$/,
  /\/daily-analysis\/all$/,
  /\/exchange-rates$/,
  /\/inventory-replenishment-snapshots$/,
  /\/inventory-replenishment-snapshots\?/,
]

export const TIMEOUT_TIERS: ReadonlyArray<TimeoutTier> = [
  {
    label: 'stream',
    pathPattern: matchAny(STREAM_PATH_PATTERNS),
    acceptContains: STREAM_ACCEPT_TOKENS,
    timeoutMs: 0,
  },
  { label: 'report', pathPattern: matchAny(REPORT_PATH_PATTERNS), timeoutMs: 60_000 },
  { label: 'ai', pathPattern: matchAny(AI_PATH_PATTERNS), timeoutMs: 30_000 },
  {
    label: 'order-info-overview',
    pathPattern: matchAny(ORDER_INFO_OVERVIEW_PATH_PATTERNS),
    timeoutMs: 20_000,
  },
  { label: 'stats', pathPattern: matchAny(STATS_PATH_PATTERNS), timeoutMs: 15_000 },
  { label: 'detail', pathPattern: matchAny(DETAIL_PATH_PATTERNS), timeoutMs: 10_000 },
  { label: 'list', pathPattern: matchAny(LIST_PATH_PATTERNS), timeoutMs: 5_000 },
  { label: 'default', timeoutMs: 5_000 },
]

const DEFAULT_TIMEOUT_MS = 5_000

/**
 * Returns the timeout (ms) the proxy should use for the given backend path
 * and inbound `Accept` header. `0` means "no timeout" (let the connection
 * close naturally — used for SSE / NDJSON streams).
 *
 * The first matching tier wins; the `stream` tier is the only one that
 * consults the `Accept` header, and it short-circuits every other check.
 */
export function getProxyTimeoutMs(backendPath: string, acceptHeader: string | null): number {
  const accept = (acceptHeader || '').toLowerCase()

  for (const tier of TIMEOUT_TIERS) {
    if (tier.acceptContains && tier.acceptContains.some((token) => accept.includes(token))) {
      return tier.timeoutMs
    }
    if (tier.pathPattern && tier.pathPattern.test(backendPath)) {
      return tier.timeoutMs
    }
  }

  return DEFAULT_TIMEOUT_MS
}

function matchAny(patterns: ReadonlyArray<RegExp>): RegExp {
  if (patterns.length === 0) {
    // Callers always pass a non-empty list — an empty match would silently
    // match the default tier and is almost certainly a bug. Fail loud.
    throw new Error('[timeout-policy] matchAny called with empty pattern list')
  }
  return new RegExp(patterns.map((p) => p.source).join('|'))
}
