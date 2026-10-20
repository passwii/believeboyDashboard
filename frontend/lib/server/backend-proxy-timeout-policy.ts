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
 *
 * Some endpoints share one path across methods and need **different**
 * budgets (BLF-1404: `POST /crm/proposals` = 20MB HTML upload, but
 * `GET /crm/proposals` = cheap list). Path alone cannot tell them apart,
 * so a tier may narrow itself with `methods` — such a tier is skipped when
 * the request method is not in the list, and matching continues with the
 * next tier.
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
  /**
   * If set, the tier only applies to these HTTP methods (uppercase).
   * Used to split same-path endpoints with different cost profiles
   * (see `crm-proposal-upload` vs the `list` tier).
   */
  readonly methods?: ReadonlyArray<string>
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
  // 产品标签制作：服务端要跑 pypdf + pdfplumber + reportlab 的完整叠加管线，
  // 冷启动导入这三个库本身就占掉大部分 5s 预算，默认档必超时。
  /\/product-label\/generate$/,
]

// BLF-1404：客户方案上传（单个自包含 HTML，上限 20MB）。
// 后端链路 = 读流 → 解析 HTML → 找相对引用 → 适配主题 → 传 R2（raw + adapted
// 两份）。20MB 内联 base64 图的文档光传输就吃掉数秒，默认 5s 档必然掐断。
//
// ⚠️ 建方案与列表**同路径**（`GET|POST api/v1/crm/proposals`），路径正则无法
// 区分 → 本档用 `methods: ['POST']` 收窄（见 TimeoutTier.methods）。
// 追加版本 `POST api/v1/crm/proposals/{id}/versions` 同理。
const CRM_PROPOSAL_UPLOAD_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\/crm\/proposals(?:\/[^/]+\/versions)?$/,
]

const AI_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\/ai-chat\//,
  /\/ai-insights\/generate$/,
  /\/ai-insights\/.+\/regenerate$/,
  // BLF-1016/1017：canonical 域 run 入口（广告分析 / 库存健康）在服务端要
  // 先收敛口径再建 run，默认 5s 档会超时（run 创建后正文走 SSE，不受影响）。
  /\/insight\/(ad-analysis|inventory-health)\/runs$/,
]

// BLF-1262 Stage 1：后端 order-info 只读查询有 15s 单语句 statement_timeout，代理 20s
// 通常可以先透传后端的说明性 504；但后端没有请求级 deadline，多条 SQL 串行时最坏路径下
// 代理仍可能先返回自己的 504。Export 不在此范围：它是显式用户操作，不应未经证据提高 deadline。
const ORDER_INFO_READ_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\/order-info\/(?:page|list|stats|overview|filter-options|live-stream)(?:\?.*)?$/,
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
  // BLF-1404：方案列表与建方案同路径，靠 `crm-proposal-upload` 档的 method
  // 收窄把 POST 分流走，GET 落到这里（5s）。
  /\/crm\/proposals$/,
]

export const TIMEOUT_TIERS: ReadonlyArray<TimeoutTier> = [
  {
    label: 'stream',
    pathPattern: matchAny(STREAM_PATH_PATTERNS),
    acceptContains: STREAM_ACCEPT_TOKENS,
    timeoutMs: 0,
  },
  { label: 'report', pathPattern: matchAny(REPORT_PATH_PATTERNS), timeoutMs: 60_000 },
  {
    // BLF-1404：方案上传 20MB HTML。必须排在 `list` 档之前 —— 同路径的 GET
    // 会被 `methods` 跳过并继续往下匹配到 list 档（5s）。
    label: 'crm-proposal-upload',
    pathPattern: matchAny(CRM_PROPOSAL_UPLOAD_PATH_PATTERNS),
    methods: ['POST'],
    timeoutMs: 60_000,
  },
  { label: 'ai', pathPattern: matchAny(AI_PATH_PATTERNS), timeoutMs: 30_000 },
  {
    label: 'order-info-read',
    pathPattern: matchAny(ORDER_INFO_READ_PATH_PATTERNS),
    timeoutMs: 20_000,
  },
  { label: 'stats', pathPattern: matchAny(STATS_PATH_PATTERNS), timeoutMs: 15_000 },
  { label: 'detail', pathPattern: matchAny(DETAIL_PATH_PATTERNS), timeoutMs: 10_000 },
  { label: 'list', pathPattern: matchAny(LIST_PATH_PATTERNS), timeoutMs: 5_000 },
  { label: 'default', timeoutMs: 5_000 },
]

const DEFAULT_TIMEOUT_MS = 5_000

/** 兜底档（无 pathPattern、无 methods）—— 与 TIMEOUT_TIERS 末尾的 default 同源。 */
const DEFAULT_TIER: TimeoutTier = { label: 'default', timeoutMs: DEFAULT_TIMEOUT_MS }

/**
 * Returns the timeout (ms) the proxy should use for the given backend path,
 * inbound `Accept` header and HTTP method. `0` means "no timeout" (let the
 * connection close naturally — used for SSE / NDJSON streams).
 *
 * The first matching tier wins; the `stream` tier is the only one that
 * consults the `Accept` header, and it short-circuits every other check.
 * A tier that declares `methods` is skipped when the request method does
 * not match, so matching continues with the next tier.
 */
export function getProxyTimeoutMs(
  backendPath: string,
  acceptHeader: string | null,
  method: string
): number {
  return resolveProxyTimeoutTier(backendPath, acceptHeader, method).timeoutMs
}

/**
 * Same matching as `getProxyTimeoutMs`, but returns the matched tier itself
 * (label + timeout) instead of just the milliseconds.
 *
 * Why expose the tier: several endpoints deliberately share one path across
 * methods (BLF-1404 `POST|GET /crm/proposals`), so "the timeout is 60_000"
 * alone does not prove *which* branch of the table produced it. Tests assert
 * on `label` to pin the routing decision itself.
 */
export function resolveProxyTimeoutTier(
  backendPath: string,
  acceptHeader: string | null,
  method: string
): TimeoutTier {
  const accept = (acceptHeader || '').toLowerCase()
  const httpMethod = (method || 'GET').toUpperCase()

  for (const tier of TIMEOUT_TIERS) {
    if (tier.acceptContains && tier.acceptContains.some((token) => accept.includes(token))) {
      return tier
    }
    if (!tier.pathPattern || !tier.pathPattern.test(backendPath)) continue
    if (tier.methods && !tier.methods.includes(httpMethod)) continue
    return tier
  }

  return DEFAULT_TIER
}

function matchAny(patterns: ReadonlyArray<RegExp>): RegExp {
  if (patterns.length === 0) {
    // Callers always pass a non-empty list — an empty match would silently
    // match the default tier and is almost certainly a bug. Fail loud.
    throw new Error('[timeout-policy] matchAny called with empty pattern list')
  }
  return new RegExp(patterns.map((p) => p.source).join('|'))
}
