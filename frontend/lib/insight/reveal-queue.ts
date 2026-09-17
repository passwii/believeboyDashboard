/**
 * Insight 吐字节奏器（BLF-1072）——把「网络到达」与「屏幕吐字」解耦。
 *
 * 背景：BLF-1071 之后 provider 真逐 token 发 `content.delta`，但到达是**成簇**的
 * ——SSE 一帧一个 token，浏览器/网络会把若干帧挤在同一帧时间里交付，中间还夹着
 * 100~400ms 的空档。到达即渲染的话，屏幕上就是「一顿一突」：一批字整块弹出 →
 * 静止 → 又整块弹出。BLF-1013 的 draft/final 分层解决了「未闭合 fence 被误解析」，
 * 但没有解决**节奏**；调小批处理窗口只能让块更小、更频繁，仍然不是匀速吐字。
 *
 * 这里把两件事拆开：
 *
 * - **到达（target）**：delta 只做字符串累积，不触发渲染；
 * - **吐字（revealed）**：按帧推进，速率 = `max(当前余量, 本轮积压峰值) / drainHorizonMs`，
 *   再夹在 `[minCharsPerSecond, maxCharsPerSecond]` 之间，于是**每一批积压都在 ~drainHorizonMs
 *   内匀速排空**：既不会越积越落后于生成，也不会整块弹出。
 *
 *   为什么用「本轮积压峰值」而不是当前余量：速率若正比于**当前**余量，就是指数衰减
 *   （`B(t) = B₀·e^(-t/H)`，尾巴要 3~5 个 H 才掉干净），一批字会先快后慢地拖尾。锁定
 *   该批积压的峰值后速率恒定，排空是**线性**的：一批字正好用 ~H 摊平，字与字之间的
 *   间隔恒定，这才是「匀速吐字」的观感。峰值在余量归零时复位，因此空闲后到达的一个字
 *   由下限兜底（~1 字/帧）而不是被旧峰值拖着猛冲。帧内余额用浮点 `carry` 累积，低速时
 *   表现为「每 1~2 帧稳定出一个字」，不会有取整造成的顿挫。
 *
 * 两个兜底：
 *
 * - `maxTickMs`：标签页被挂起 / 主线程长任务后，`nowMs` 会一次跳几百毫秒；截断它
 *   可以避免「回来时一口气吐完」的突跳。截掉的额度不丢——`lastTickMs` 前移，后续
 *   每帧继续按同样速率推进。
 * - `frameCap`：一次推进最多吐 `ceil(maxCharsPerSecond * dt)` 个字。`carry` 在低速时
 *   可能攒下额度（每次都取整扔掉零头，余数留到下一帧；长时间小 budget 会攒成一笔
 *   可观余额），只按 `floor(budget)` 结算就可能在某一帧整块弹出。上限与速率上限
 *   同源，保证「任何一帧的吐字量都能用 maxCharsPerSecond 解释」，也让
 *   「单帧增量 ≤ 速率上限 × 帧时长」成为可测的不变量。
 * - `floor`：一次推进取整吞掉不足一个字的零头，绝不因为结算误差变大块。
 *
 * 该模块是纯数据 + 纯函数（无 React、无计时器、无 DOM）：帧调度由
 * `useInsightStream` 负责，单测可以注入 `nowMs` 确定性推进。
 */
import type { InsightOutputs } from './protocol'

export type InsightRevealOptions = {
  /** 目标排空时距（毫秒）：余量按此时距摊平 */
  drainHorizonMs: number
  /** 吐字速率下限（字/秒）：保证低余量时也在稳定推进，不「半天不出一字」 */
  minCharsPerSecond: number
  /** 吐字速率上限（字/秒）：病态大余量时不整块弹出 */
  maxCharsPerSecond: number
  /** 单次推进最多计入的时间（毫秒）：防挂起回来后一次吐完 */
  maxTickMs: number
}

export const DEFAULT_INSIGHT_REVEAL_OPTIONS: InsightRevealOptions = {
  // 240ms ≈ 一个「字块」在屏幕上摊开的观感尺度；再小会显得追不上生成，再大则有滞后感。
  drainHorizonMs: 240,
  // 60 字/秒 = 60fps 下每帧一个字：低余量（空闲后单个 delta）时首字也只需 1 帧。
  minCharsPerSecond: 60,
  /**
   * 180 字/秒 = 60fps 下每帧最多 3 个字。
   *
   * 这个上限是**用录制真实 trace 量出来的**（`tests/fixtures/insight-delta-trace-blf1072.json`，
   * 469 帧 / 657 字 / 11.9s，实际到达 ≈ 55 字/秒）：
   *
   * - 正常流速下到达率（≈55 字/秒）远低于该上限，吐字由到达驱动 —— 实测每帧 **1~2 字**
   *   （单帧增量 p50 = 1、p90 = 2），就是「逐字吐」的观感；
   * - 上限只在**成簇突发**时生效：旧值 1200 字/秒 允许单帧吐 20 字，实测突发里出现
   *   **11~15 字/帧**的整块弹出，正是要消掉的「突跳」；压到 180 后实测单帧上限 3 字
   *   （p50 = 1、p90 = 3）。
   *
   * 代价是突发时滞后变大（实测峰值余量 144 → 183 字，约多 ~600ms 排空）。但因
   * 180 仍 ≫ 实测到达率 55 字/秒，排空速度始终快于到达，不会累积着掉队。
   *
   * 若换成明显更快的 provider，先量到达率再定这两个值：`maxCharsPerSecond` 需要
   * 明显大于到达率（否则滞后会累积），而 `minCharsPerSecond` 决定低余量时的最低吐出速度。
   */
  maxCharsPerSecond: 180,
  // 单帧最多计入 100ms：标签页挂起 / 主线程长任务回来时不一口气吐完。
  maxTickMs: 100,
}

export function normalizeInsightRevealOptions(
  overrides?: Partial<InsightRevealOptions> | null
): InsightRevealOptions {
  const merged = { ...DEFAULT_INSIGHT_REVEAL_OPTIONS, ...(overrides ?? {}) }
  return {
    drainHorizonMs: Math.max(16, merged.drainHorizonMs),
    minCharsPerSecond: Math.max(1, merged.minCharsPerSecond),
    maxCharsPerSecond: Math.max(Math.max(1, merged.minCharsPerSecond), merged.maxCharsPerSecond),
    maxTickMs: Math.max(16, merged.maxTickMs),
  }
}

export type InsightRevealSlotState = {
  /** 已到达的全文（delta 累积或权威内容） */
  target: string
  /** 已吐字到第几个字符（`target` 的前缀长度） */
  revealed: number
  /** 不足一个字的吐字余额 */
  carry: number
  /** 本轮（自上一次性排空以来）积压峰值：匀速排空的速率基准 */
  peakBacklog: number
}

export type InsightRevealState = {
  slots: Record<string, InsightRevealSlotState>
  /** 上一次推进的时间点；null = 还没有内容到达过 */
  lastTickMs: number | null
}

export type InsightRevealAdvance = {
  /** 推进后的状态（无论有没有变化都要用返回值覆盖旧状态） */
  state: InsightRevealState
  /** 本次推进后每槽的可见内容；没有变化时是空对象（调用方据此跳过 setState） */
  revealed: InsightOutputs
  changed: boolean
  /** 是否仍有未吐完的余量（调用方需要继续排帧） */
  pending: boolean
}

export function createInsightRevealState(): InsightRevealState {
  return { slots: {}, lastTickMs: null }
}

/**
 * 一帧 delta 到达：只累积到 `target`，不推进吐字进度。
 *
 * `revealed` 只会被夹到 `target` 长度以内——权威内容先到、随后又来了 delta 时，
 * 保证「已吐字」永远是 `target` 的前缀（渲染层依赖这个不变量）。
 */
export function enqueueInsightRevealDelta(
  state: InsightRevealState,
  slot: string,
  delta: string,
  nowMs: number
): InsightRevealState {
  if (!slot || !delta) return state
  const previous = state.slots[slot] ?? { target: '', revealed: 0, carry: 0, peakBacklog: 0 }
  const target = previous.target + delta
  const revealed = Math.min(previous.revealed, target.length)
  return {
    slots: {
      ...state.slots,
      [slot]: {
        ...previous,
        target,
        revealed,
        peakBacklog: Math.max(previous.peakBacklog, target.length - revealed),
      },
    },
    lastTickMs: state.lastTickMs ?? nowMs,
  }
}

/**
 * 权威内容到达（`content.snapshot` / `done` / `attach` 回读的 detail）：整段立即可见。
 *
 * 这些帧不是「新吐出来的字」，而是服务端对某槽的定稿（delta 链在此封口），
 * 再逐字吐一遍只会让画面从权威内容倒退回旧前缀——所以直接揭示。
 */
export function setInsightRevealTarget(
  state: InsightRevealState,
  slot: string,
  content: string
): InsightRevealState {
  if (!slot) return state
  return {
    slots: {
      ...state.slots,
      [slot]: { target: content, revealed: content.length, carry: 0, peakBacklog: 0 },
    },
    lastTickMs: state.lastTickMs,
  }
}

/** 终态收尾：把所有还没吐完的余量一次揭示（失败/取消同样适用，不留半截字）。 */
export function revealAllInsightOutputs(state: InsightRevealState): InsightRevealState {
  let changed = false
  const slots: Record<string, InsightRevealSlotState> = {}
  for (const [slot, previous] of Object.entries(state.slots)) {
    if (previous.revealed >= previous.target.length) {
      slots[slot] = previous
      continue
    }
    changed = true
    slots[slot] = { ...previous, revealed: previous.target.length, carry: 0, peakBacklog: 0 }
  }
  return changed ? { slots, lastTickMs: state.lastTickMs } : state
}

/** 当前可见内容（已吐字部分）；还没吐出任何字的槽不出现。 */
export function revealedInsightOutputs(state: InsightRevealState): InsightOutputs {
  const outputs: InsightOutputs = {}
  for (const [slot, slotState] of Object.entries(state.slots)) {
    if (slotState.revealed <= 0) continue
    outputs[slot] = slotState.target.slice(0, slotState.revealed)
  }
  return outputs
}

/**
 * 单帧吐字上限（字数）。与 `maxCharsPerSecond` 同源：任何一帧的吐字量都必须能被
 * 速率上限解释，界面因此不会出现「一帧弹出半段」的突跳。
 *
 * `ceil` 前先把结果量化到 1e-6：60fps 下 `180 × 16.666666666666668 / 1000` 是
 * `2.9999999999999996`，而另一帧算出来可能刚好是 `3.0000000000000004`——直接 `ceil`
 * 会让限额在 3 / 4 之间抖动，配合逐帧累加的 `carry`，就放出了偶发的 4 字帧。
 * 量化后同一「字/秒 + 帧时长」组合恒得到同一个整数，上界才是真的上界。
 */
export function insightRevealFrameCap(options: InsightRevealOptions, dtMs: number): number {
  const raw = (options.maxCharsPerSecond * Math.max(dtMs, 0)) / 1_000
  return Math.max(1, Math.ceil(Number(raw.toFixed(6))))
}

export function hasInsightRevealBacklog(state: InsightRevealState): boolean {
  return Object.values(state.slots).some((slot) => slot.revealed < slot.target.length)
}

/** 推进一帧吐字。调用方每帧调用一次，并按 `pending` 决定是否继续排帧。 */
export function advanceInsightReveal(
  state: InsightRevealState,
  nowMs: number,
  options: InsightRevealOptions = DEFAULT_INSIGHT_REVEAL_OPTIONS
): InsightRevealAdvance {
  if (state.lastTickMs === null) {
    return { state, revealed: {}, changed: false, pending: hasInsightRevealBacklog(state) }
  }

  const dtMs = Math.min(Math.max(nowMs - state.lastTickMs, 0), options.maxTickMs)
  const slots: Record<string, InsightRevealSlotState> = {}
  let changed = false
  let pending = false

  for (const [slot, previous] of Object.entries(state.slots)) {
    const backlog = previous.target.length - previous.revealed
    if (backlog <= 0) {
      // 排空即复位峰值：下一批积压重新按自己的规模定速，不被旧峰值拖着猛冲。
      slots[slot] = { ...previous, carry: 0, peakBacklog: 0 }
      continue
    }

    const basis = Math.max(backlog, previous.peakBacklog)
    const rate = Math.min(
      Math.max(basis / (options.drainHorizonMs / 1_000), options.minCharsPerSecond),
      options.maxCharsPerSecond
    )
    const budget = previous.carry + (rate * dtMs) / 1_000
    const take = Math.min(Math.floor(budget), insightRevealFrameCap(options, dtMs), backlog)
    const drained = backlog - take <= 0
    slots[slot] = {
      ...previous,
      revealed: previous.revealed + take,
      carry: drained ? 0 : budget - take,
      peakBacklog: drained ? 0 : basis,
    }
    if (take > 0) changed = true
    if (!drained) pending = true
  }

  const nextState: InsightRevealState = { slots, lastTickMs: nowMs }
  return {
    state: nextState,
    revealed: changed ? revealedInsightOutputs(nextState) : {},
    changed,
    pending,
  }
}
