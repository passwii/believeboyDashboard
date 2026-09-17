import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import {
  advanceInsightReveal,
  createInsightRevealState,
  enqueueInsightRevealDelta,
  hasInsightRevealBacklog,
  insightRevealFrameCap,
  normalizeInsightRevealOptions,
  revealAllInsightOutputs,
  revealedInsightOutputs,
  setInsightRevealTarget,
  type InsightRevealState,
} from './reveal-queue'

const FRAME_MS = 1000 / 60

/**
 * 真实 delta 到达节奏的确定性替身：provider 逐 token 发帧（1~3 字/帧），
 * 传输层把若干帧挤在同一时刻交付，并周期性出现 150~400ms 空档。
 * 用固定种子，保证每次运行同一条时间表。
 */
function arrivalTimetable(text: string, seed = 20_260_916) {
  let random = seed
  const next = () => {
    random = (random * 1_103_515_245 + 12_345) % 2_147_483_648
    return random / 2_147_483_648
  }
  const timetable: { atMs: number; delta: string }[] = []
  let cursor = 0
  let nowMs = 0
  while (cursor < text.length) {
    const size = 1 + Math.floor(next() * 3)
    timetable.push({ atMs: Math.round(nowMs), delta: text.slice(cursor, cursor + size) })
    cursor += size
    if (next() < 0.7) continue // 同一帧里再挤一帧
    nowMs += next() < 0.12 ? 150 + next() * 250 : 6 + next() * 30
  }
  return timetable
}

type Tick = { atMs: number; revealed: number; target: number; step: number; text: string }

/** 按 60fps 逐帧推进，返回每一帧的观测量。 */
function playTimetable(
  timetable: { atMs: number; delta: string }[],
  totalMs: number,
  slot = 'main'
): { ticks: Tick[]; fullText: string; arrivals: number } {
  let state: InsightRevealState = createInsightRevealState()
  const ticks: Tick[] = []
  let index = 0
  let previous = 0

  for (let atMs = 0; atMs <= totalMs; atMs += FRAME_MS) {
    while (index < timetable.length && timetable[index].atMs <= atMs) {
      state = enqueueInsightRevealDelta(state, slot, timetable[index].delta, atMs)
      index += 1
    }
    const advanced = advanceInsightReveal(state, atMs)
    state = advanced.state
    const revealed = revealedInsightOutputs(state)[slot] ?? ''
    ticks.push({
      atMs,
      revealed: revealed.length,
      target: state.slots[slot]?.target.length ?? 0,
      step: revealed.length - previous,
      text: revealed,
    })
    previous = revealed.length
  }

  return {
    ticks,
    fullText: state.slots[slot]?.target ?? '',
    arrivals: timetable.length,
  }
}

describe('Insight 吐字节奏器', () => {
  it('到达只累积、不吐字，推进时才逐字揭示', () => {
    let state = createInsightRevealState()
    state = enqueueInsightRevealDelta(state, 'main', '第一段', 0)
    state = enqueueInsightRevealDelta(state, 'main', '第二段', 0)

    // 到达即整段可见的话，这里就会拿到全文 —— 节奏器的意义正是不这样做。
    expect(revealedInsightOutputs(state)).toEqual({})
    expect(state.slots.main.target).toBe('第一段第二段')
    expect(hasInsightRevealBacklog(state)).toBe(true)

    const first = advanceInsightReveal(state, FRAME_MS)
    expect(first.changed).toBe(true)
    expect(first.revealed.main).toBe('第')
    expect(first.pending).toBe(true)
  })

  it('小突发在 drainHorizonMs 内摊平，且任何一帧都不整块弹出', () => {
    // 「小」的定义：余量 ≤ maxCharsPerSecond × drainHorizonMs —— 此时速率由排空时距决定
    // （180 字/秒 × 0.24s = 43 字）。取 40 字刚好落在这一档。
    const options = normalizeInsightRevealOptions(null)
    const threshold = (options.maxCharsPerSecond * options.drainHorizonMs) / 1_000
    const text = '库'.repeat(Math.floor(threshold) - 3)
    const { ticks } = playTimetable([{ atMs: 0, delta: text }], 600)

    const drainedAt =
      ticks.filter((tick) => tick.revealed > 0).find((tick) => tick.revealed === text.length)?.atMs ??
      Infinity

    // 一帧到达整段：在 ~drainHorizon 内摊平吐完，允许 ±4 帧的取整误差。
    expect(drainedAt).toBeGreaterThan(options.drainHorizonMs - 4 * FRAME_MS)
    expect(drainedAt).toBeLessThan(options.drainHorizonMs + 4 * FRAME_MS)

    const maxStep = Math.max(...ticks.map((tick) => tick.step))
    const perFrameCap = insightRevealFrameCap(options, FRAME_MS)
    expect(maxStep).toBeLessThanOrEqual(perFrameCap)
    // 匀速感：没有任何一帧吐掉整段。
    expect(maxStep).toBeLessThan(text.length / 5)
  })

  it('大突发受速率上限约束：单帧仍只有几字，排空时间按 余量/速率上限 计', () => {
    const options = normalizeInsightRevealOptions(null)
    const threshold = (options.maxCharsPerSecond * options.drainHorizonMs) / 1_000
    // 远超阈值的一次性突发：不受排空时距支配，而是被速率上限抳住。
    const text = '库'.repeat(Math.round(threshold * 5))
    const { ticks } = playTimetable([{ atMs: 0, delta: text }], 3_000)

    const drainedAt =
      ticks.filter((tick) => tick.revealed > 0).find((tick) => tick.revealed === text.length)?.atMs ??
      Infinity
    const expectedDrainMs = (text.length / options.maxCharsPerSecond) * 1_000

    expect(drainedAt).toBeGreaterThan(options.drainHorizonMs)
    expect(drainedAt).toBeLessThan(expectedDrainMs + 6 * FRAME_MS)

    // 关键回归：再大的突发也还是逐字吐（每帧不超过速率上限对应的几个字）。
    const maxStep = Math.max(...ticks.map((tick) => tick.step))
    expect(maxStep).toBeLessThanOrEqual(insightRevealFrameCap(options, FRAME_MS))
    expect(maxStep).toBeLessThanOrEqual(4)
  })

  it('成簇到达被摊平：可见长度单调不减、始终是已到达内容的前缀，且单帧增量有上界', () => {
    const text = '## 结论\n销售增长稳健，广告 ACOS 回落 3.2 个百分点；库存健康，无滞销风险。\n'.repeat(12)
    const timetable = arrivalTimetable(text)
    const { ticks, fullText } = playTimetable(timetable, 6_000)

    expect(fullText).toBe(text)
    const options = normalizeInsightRevealOptions(null)
    const perFrameCap = insightRevealFrameCap(options, FRAME_MS)

    let previous = 0
    let previousText = ''
    for (const tick of ticks) {
      expect(tick.revealed).toBeGreaterThanOrEqual(previous)
      expect(tick.revealed).toBeLessThanOrEqual(tick.target)
      expect(tick.step).toBeLessThanOrEqual(perFrameCap)
      // 可见内容逐帧增长且永远是上一帧的续写：不出现回跳、重复或跳字。
      expect(tick.text.startsWith(previousText)).toBe(true)
      previous = tick.revealed
      previousText = tick.text
    }
    expect(previousText).toBe(fullText)
  })

  it('生成结束后迅速收敛到全文，且滞后不随全文变长而累积', () => {
    const short = '库存健康快照：在途 1,204 件、可售 8,731 件，周转天数 32 天。'.repeat(10)
    const long = short.repeat(3)
    const options = normalizeInsightRevealOptions(null)

    const measure = (text: string) => {
      const timetable = arrivalTimetable(text, 7_777)
      const lastArrival = timetable[timetable.length - 1].atMs
      const { ticks } = playTimetable(timetable, lastArrival + 3_000)
      const settled = ticks.find((tick) => tick.revealed === text.length)
      return {
        settleDelayMs: (settled?.atMs ?? Infinity) - lastArrival,
        maxLag: Math.max(...ticks.map((tick) => tick.target - tick.revealed)),
      }
    }

    const shortRun = measure(short)
    const longRun = measure(long)

    /**
     * 尾部余量 B 的排空时间上界：B ≤ 阈值时由 drainHorizonMs 支配，超阈后被速率上限抳住。
     * 用该次运行自己的峰值余量算，这样断言跟着模型走，不随档位或文案长度漂移。
     */
    const settleBudgetMs = (maxLag: number) =>
      Math.max(options.drainHorizonMs, (maxLag / options.maxCharsPerSecond) * 1_000) +
      3 * FRAME_MS

    // 最后一帧 delta 落地后不再有网络输入，余量必须按上式排空。
    expect(shortRun.settleDelayMs).toBeLessThanOrEqual(settleBudgetMs(shortRun.maxLag))
    expect(longRun.settleDelayMs).toBeLessThanOrEqual(settleBudgetMs(longRun.maxLag))

    // 滞后（已到达 - 已吐字）只由单次突发规模决定，不随全文长度累积。
    // 长文是短文的 3 倍长：若滞后会累积，longRun.maxLag 应接近 3 × shortRun.maxLag；
    // 实测两者同阶（差异只来自具名随机到达表里那一次突发的大小）。
    expect(longRun.maxLag).toBeLessThan(shortRun.maxLag * 1.6)
    expect(longRun.maxLag).toBeLessThan(long.length / 4)
  })

  it('低余量也保持推进（速率下限兜底），不会卡到下一批 delta 才出字', () => {
    let state = enqueueInsightRevealDelta(createInsightRevealState(), 'main', '字', 0)
    let revealedAt: number | null = null

    for (let frame = 1; frame <= 6 && revealedAt === null; frame += 1) {
      const advanced = advanceInsightReveal(state, frame * FRAME_MS)
      state = advanced.state
      if ((revealedInsightOutputs(state).main ?? '').length > 0) revealedAt = frame
    }

    // 60fps 下下限 = 每帧一个字：空闲后到达的单个 delta 下一帧就可见。
    expect(revealedAt).toBe(1)
  })

  it('持续超速到达时单帧仍然只吐速率上限那么多，不把攒下的余额整块弹出', () => {
    // 病态突发：每帧到达的字数（60）远超速率上限对应的一帧额度（180 字/秒 → 60fps 下 3 字/帧）。
    // 逐帧结算时会攒下余额，若不按速率上限截断，这些余额会在某一帧一次性落屏。
    let state = createInsightRevealState()
    const options = normalizeInsightRevealOptions(null)
    const perFrameCap = insightRevealFrameCap(options, FRAME_MS)
    let maxStep = 0
    let previous = 0

    for (let frame = 0; frame < 90; frame += 1) {
      state = enqueueInsightRevealDelta(state, 'main', '字'.repeat(60), frame * FRAME_MS)
      const advanced = advanceInsightReveal(state, frame * FRAME_MS, options)
      state = advanced.state
      const revealed = (revealedInsightOutputs(state).main ?? '').length
      maxStep = Math.max(maxStep, revealed - previous)
      previous = revealed
    }

    expect(maxStep).toBeLessThanOrEqual(perFrameCap)
    // 积压确实在涨（说明用例真的处在饱和区），但没有哪一帧把它整块吐出来。
    expect(state.slots.main.target.length - state.slots.main.revealed).toBeGreaterThan(1_000)
  })

  it('标签页挂起后按 maxTickMs 截断，不把积压一口气吐完', () => {
    const text = '长报告正文'.repeat(200)
    let state = enqueueInsightRevealDelta(createInsightRevealState(), 'main', text, 0)

    const options = normalizeInsightRevealOptions(null)
    const advanced = advanceInsightReveal(state, 5_000, options)
    state = advanced.state

    const perTickCap = insightRevealFrameCap(options, options.maxTickMs)
    expect(advanced.revealed.main?.length).toBeLessThanOrEqual(perTickCap)
    expect(advanced.pending).toBe(true)
    // 截掉的额度不丢：下一帧按同样的匀速继续推进。
    expect(advanceInsightReveal(state, 5_050, options).revealed.main?.length).toBeGreaterThan(0)
  })

  it('权威内容整段立即可见并封口，随后的 delta 仍继续累积', () => {
    let state = enqueueInsightRevealDelta(createInsightRevealState(), 'main', '半句话', 0)
    state = advanceInsightReveal(state, FRAME_MS).state
    expect((revealedInsightOutputs(state).main ?? '').length).toBeLessThan(3)

    state = setInsightRevealTarget(state, 'main', '服务端定稿的完整正文')
    expect(revealedInsightOutputs(state)).toEqual({ main: '服务端定稿的完整正文' })

    state = enqueueInsightRevealDelta(state, 'main', '，续写', 32)
    expect(state.slots.main.target).toBe('服务端定稿的完整正文，续写')
    // 已吐字永远是 target 前缀：权威内容不得被后续 delta 倒退回旧前缀。
    expect(revealedInsightOutputs(state).main).toBe('服务端定稿的完整正文')
  })

  it('终态收尾一次揭示所有余量，且不再有待推进内容', () => {
    let state = createInsightRevealState()
    state = enqueueInsightRevealDelta(state, 'main', '主槽正文', 0)
    state = enqueueInsightRevealDelta(state, 'chart', '副槽正文', 0)

    state = revealAllInsightOutputs(state)

    expect(revealedInsightOutputs(state)).toEqual({ main: '主槽正文', chart: '副槽正文' })
    expect(hasInsightRevealBacklog(state)).toBe(false)
    const advanced = advanceInsightReveal(state, 1_000)
    expect(advanced.changed).toBe(false)
    expect(advanced.pending).toBe(false)
  })

  it('normalize 兜住非法档位：下限不低于 1 字/秒，上限不低于下限', () => {
    const options = normalizeInsightRevealOptions({
      drainHorizonMs: 0,
      minCharsPerSecond: 0,
      maxCharsPerSecond: 0,
      maxTickMs: 0,
    })

    expect(options.drainHorizonMs).toBeGreaterThanOrEqual(16)
    expect(options.minCharsPerSecond).toBeGreaterThanOrEqual(1)
    expect(options.maxCharsPerSecond).toBeGreaterThanOrEqual(options.minCharsPerSecond)
    expect(options.maxTickMs).toBeGreaterThanOrEqual(16)
  })
})

// ── 用**真实录制的到达 trace** 把档位钉住（BLF-1072 验收 §1 §2）────────────────────────
//
// 上面那些用例用合成到达表验证数学性质；这一段回放一次真实 canonical run 的 delta 到达
// 时刻（`tests/fixtures/insight-delta-trace-blf1072.json`，469 帧 / 657 字 / 11.9s，实际到达率
// ≈ 55 字/秒，其中 32% 的帧挤在同一瞬间到达），在 60fps 下逐帧推进，把「屏幕上的单帧吐字量」
// 变成可回归的数字。
//
// 为什么需要它：档位（drainHorizonMs / min / maxCharsPerSecond）一旦被调回早期那组
// 「快排空」的值，突发里就会出现十几字的整块弹出——那正是本 Issue 要消掉的「突跳」，
// 而合成用例的 `step <= frameCap` 断言拦不住（frameCap 会跟着一起变大）。
const FIXTURE_PATH = path.join(__dirname, '../../tests/fixtures/insight-delta-trace-blf1072.json')

function loadRecordedDeltas(): { atMs: number; delta: string }[] {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf8')
  const parsed: unknown = JSON.parse(raw)
  const deltas = (parsed as { deltas?: unknown }).deltas
  if (!Array.isArray(deltas) || deltas.length === 0) throw new Error('delta trace fixture 形状不符')
  return deltas as { atMs: number; delta: string }[]
}

describe('Insight 吐字节奏器 · 真实到达 trace 回归', () => {
  it('按录制到达节奏回放：单帧吐字有硬上界（逐字吐，不整块弹出）', () => {
    const deltas = loadRecordedDeltas()
    const base = deltas[0].atMs
    const last = deltas[deltas.length - 1].atMs - base
    const options = normalizeInsightRevealOptions(null)

    let state = createInsightRevealState()
    let index = 0
    let previous = 0
    let maxStep = 0
    const steps: number[] = []
    let maxLag = 0

    // 1x 真实节奏，逐帧推进到最后一个 delta 之后再等 1.5s 排空。
    for (let atMs = 0; atMs <= last + 1_500; atMs += FRAME_MS) {
      while (index < deltas.length && deltas[index].atMs - base <= atMs) {
        state = enqueueInsightRevealDelta(state, 'main', deltas[index].delta, atMs)
        index += 1
      }
      state = advanceInsightReveal(state, atMs, options).state
      const slot = state.slots.main
      const backlog = slot.target.length - slot.revealed
      maxLag = Math.max(maxLag, backlog)
      const revealedLength = slot.revealed
      if (revealedLength > previous) {
        const step = revealedLength - previous
        steps.push(step)
        maxStep = Math.max(maxStep, step)
        previous = revealedLength
      }
    }

    // 657 字全部吐完，一帧不漏。
    expect(state.slots.main.target.length).toBe(657)
    expect(state.slots.main.revealed).toBe(657)

    // 核心回归断言：60fps 下单帧最多吐 4 字（实测 p50 = 1、p90 = 3、max = 3）。
    // 上界 4 留一字取整余量；早期档位（maxCharsPerSecond = 1200）在这里会到 11~15 字。
    const perFrameCap = insightRevealFrameCap(options, FRAME_MS)
    expect(perFrameCap).toBeLessThanOrEqual(4)
    expect(maxStep).toBeLessThanOrEqual(perFrameCap)

    const sorted = [...steps].sort((a, b) => a - b)
    const percentile = (q: number) => sorted[Math.floor(sorted.length * q)] ?? 0
    expect(percentile(0.5)).toBe(1)
    expect(percentile(0.9)).toBeLessThanOrEqual(3)
    // 更新次数与字数同阶：吐字是逐帧发生的，不是少数几次大块落地。
    expect(steps.length).toBeGreaterThan(400)
    // 突发时的峰值滞后有界：排空快于到达，不会越积越落后。
    expect(maxLag).toBeLessThan(260)
  })
})
