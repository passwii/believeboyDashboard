import { InsightHttpError, toInsightHttpError } from './sse'
import {
  isInsightErrorPayload,
  isInsightRunStartResponse,
  type InsightErrorPayload,
  type InsightRunStartResponse,
} from './protocol'

/**
 * 域级 run 入口（BLF-1016 / BLF-1017）。
 *
 * canonical 通用端点 `POST /insight/runs` 要求调用方自带 slots；广告 / 库存的
 * 业务口径（project/country/日期）必须在服务端收敛成权限可审计的 slot，因此
 * 域端点自己组装 slots 后再建 run。
 *
 * 本模块只做「提交一次域请求并拿到 run_id」这一件事，**不是**流生命周期：
 * 提交完由业务 adapter 交给 `useInsightStream().attach(runId)` 接管（detail +
 * SSE + resume + retry + cancel 全在共享 hook 里）。域适配器因此不持有
 * EventSource、不解析 SSE、不维护 provider/retry 状态。
 */

export const AD_ANALYSIS_RUN_PATH = '/api/backend/v1/insight/ad-analysis/runs'
export const INVENTORY_HEALTH_RUN_PATH = '/api/backend/v1/insight/inventory-health/runs'

/** 域开关未打开时后端返回的错误码（单写端保证：同一域任一时刻只有一个写端）。 */
export const DOMAIN_SWITCH_NOT_READY = 'DOMAIN_SWITCH_NOT_READY'

/** 提交域 run 本身失败（网络/代理/非 typed 错误）的兜底错误码。 */
export const DOMAIN_START_FAILED = 'DOMAIN_START_FAILED'

/** 广告分析提交口径（闭区间；后端限制单次最长 366 天）。 */
export type AdAnalysisRunInput = {
  project_id: number
  country: string
  start_date: string
  end_date: string
  model_id?: string
}

/** 库存健康提交口径（单日快照，缺省为最新快照日）。 */
export type InventoryHealthRunInput = {
  project_id: number
  country: string
  report_date?: string
  model_id?: string
}

export type StartDomainRunOptions = {
  fetch?: typeof fetch
  signal?: AbortSignal
}

/** 提交域 run，返回 canonical `InsightRunStartResponse`（含 run_id）。 */
export async function startDomainRun<TInput>(
  path: string,
  input: TInput,
  options: StartDomainRunOptions = {}
): Promise<InsightRunStartResponse> {
  const fetcher = options.fetch ?? fetch
  const response = await fetcher(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(input),
    signal: options.signal,
    cache: 'no-store',
  })

  if (!response.ok) throw await toInsightHttpError(response)

  const payload: unknown = await response.json()
  if (!isInsightRunStartResponse(payload)) {
    throw new InsightHttpError(response.status, '域端点未返回合法的 run 响应', {
      code: 'INVALID_RUN_RESPONSE',
    })
  }
  return payload
}

/** 该错误是否表示「域还没切到 canonical」（此时旧写端仍在线）。 */
export function isDomainSwitchNotReady(error: unknown): boolean {
  return error instanceof InsightHttpError && error.code === DOMAIN_SWITCH_NOT_READY
}

/**
 * 提交失败 → 面板可渲染的错误载荷。域端点把错误放在 FastAPI `detail` 里
 * （typed 409 `DOMAIN_SWITCH_NOT_READY` / 403 范围越权 / 422 口径非法），
 * `toInsightHttpError` 已解析；这里只负责收敛成统一形状，并把「域未切换」
 * 这类配置态错误换成运营可读的文案（原 message 是给开发看的）。
 */
export function toDomainStartError(candidate: unknown): InsightErrorPayload {
  const payload = ((): InsightErrorPayload => {
    if (isInsightErrorPayload(candidate)) return candidate
    if (candidate instanceof InsightHttpError) {
      return {
        code: candidate.code,
        message: candidate.message,
        retryable: candidate.retryable,
        retry_after_seconds: candidate.retryAfter,
        details: candidate.details,
      }
    }
    if (candidate instanceof Error) {
      return { code: DOMAIN_START_FAILED, message: candidate.message, retryable: false }
    }
    return { code: DOMAIN_START_FAILED, message: String(candidate), retryable: false }
  })()

  if (payload.code === DOMAIN_SWITCH_NOT_READY) {
    return {
      ...payload,
      message: '该分析域尚未切换到 canonical Insight，请联系管理员开启后再试',
    }
  }
  return payload
}
