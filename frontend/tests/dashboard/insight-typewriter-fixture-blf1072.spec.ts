/**
 * BLF-1072 · 高频 delta 下的逐帧吐字 —— 用**录制的高频 delta fixture** 回放。
 *
 * 与 `insight-typewriter-blf1072.spec.ts` 的分工：
 * - 那个跑真实 provider（观感 / 端到端），但每次文案与耗时都不同，只能断言量级；
 * - 这个回放**实测录制的到达时刻**（`insight-delta-trace-blf1072.json`，469 帧 /
 *   657 字 / 32% 的帧挤在 ≤2ms 内到达），因此「成簇到达会不会整块弹出」「可见内容
 *   会不会回跳」都能给出稳定可复现的数字。
 *
 * ## 为什么断言的是「稳定区递增 + tail 是原文子串」而不是「逐字相等」
 *
 * 渲染器把 Markdown 语法节点化（`### 1. 销售表现` → `<h3>1. 销售表现</h3>`），因此
 * DOM `textContent` **不是** Markdown 原文的前缀投影：`### ` 在节点化瞬间消失。这是
 * 渲染正确的表现，不是回跳。
 *
 * 也正因为如此，**总可见长度不是单调不减的**——一行的标记被节点化时 `textContent`
 * 会恰好短掉这几个标记的长度。“全程不丢字”得拆成三个真的成立的不变量：
 *
 * 1. **稳定区单调不减且是终态前缀**：`finalStable.startsWith(frameStable)` —— 已渲染的
 *    正文只会往后长，不回跳、不重复、不跳字（这才是“不抖动”的实质保证）；
 * 2. **tail 是终态原文的子串**：还没节点化的半行是原文片段，不串字、不乱序；
 * 3. **总长度回落有界**：回落量不得超过“本行标记被节点化”的长度，正文不会凭空少一大截。
 *
 * （早期版本直接断言 `textContent.length` 逐帧不下降——它与上面第 3 条的机理相矛盾，
 * 只因当时吐字颗粒度大、采样没撞上节点化瞬间而“碰巧恒过”。）
 *
 * 「单帧吐字量有界」（不整块弹出）用**帧间真实增长量**度量，并单独统计「节点化跳变」
 * （语法标记从 tail 进入稳定节点）造成的少量正跳变，以便区分解释器抖动与真正的整块弹出。
 *
 * 两个步长指标分工不同：`maxTailStepPerFrame` 才是**吐字颗粒度**（tail 每帧长几个字，
 * 实测 ≤ 4）；`maxStepPerFrame` 是整个 `[role=document]` 的 textContent 长度差，它在
 * 某个块被节点化瞬间会跳一下（例如未闭合围栏整体收进稳定区），因此不适合当作吐字上界。
 *
 * fixture 的 delta 文本与到达间隔均取自一次本地真实 canonical run
 * （GPT-5.6-Luna，见 fixture 内 `meta`），用例只做时间轴缩放，不改文案。
 *
 * 回放机制：`route.continue({ url })` 把应用的 SSE 请求重定向到本文件内的 Node
 * SSE 服务（Playwright 的 `route.fulfill` 不支持流式 body，而批次窗口 / 节奏器
 * 的正确性恰恰依赖「若干帧挤在一起」的到达结构，所以必须真流式）。
 *
 * 运行：`PLAYWRIGHT_PORT=3310 pnpm test:ui tests/dashboard/insight-typewriter-fixture-blf1072.spec.ts --project=chromium`
 */
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { encode } from 'next-auth/jwt'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

import { BLF611_FIXTURE_SECRET } from '../setup/blf611-fixture'
import trace from '../fixtures/insight-delta-trace-blf1072.json'

const OUT_DIR = path.join(__dirname, '../../test-results/blf1072')

/**
 * 回放倍速：真实 19s 太长，默认按 4× 压缩（帧间隔同比例缩短，突发结构不变）。
 *
 * 验收时用 `BLF1072_SPEED=1` 按**真实到达节奏**跑一遍：4× 会把突发之间的空档
 * 一起压掉，让「排空后空闲」的帧占比虚高，据此判断吐字连续性会偏悲观。
 */
const SPEED = Number(process.env.BLF1072_SPEED ?? 4)

const RUN_ID = 'blf1072-fixture-run'
const FULL_TEXT = trace.deltas.map((d) => d.delta).join('')
/** 最后一个 delta 的绝对时刻，以及首个 delta 的（回放时间轴的零点）。 */
const LAST_AT_MS = trace.deltas[trace.deltas.length - 1].atMs
const ORIGIN_AT_MS = trace.deltas[0].atMs
/** 回放结束（最后一个 delta 落地）时刻 */
const REPLAY_END_MS = (LAST_AT_MS - ORIGIN_AT_MS) / SPEED

type Sample = {
  t: number
  /** 渲染器声明的内容状态（draft / final）：final = 权威内容一次性渲染 */
  state: string | null
  /** `[role=document]` 的完整可见文本（稳定节点 + tail） */
  text: string
  /** 已节点化的稳定部分（`text` 去掉末尾 tail） */
  stable: string
  /** 尾部纯文本（尚未节点化的半行 / 未闭合围栏） */
  tail: string
}

/**
 * 录制回放服务：按 fixture 的到达时刻逐帧写出 `content.delta`，最后写 `done`。
 *
 * 用 `setTimeout` 而不是等间隔定时器 —— 成簇到达（多帧同一时刻）与 100ms+ 空档
 * 正是要回放的结构，等间隔会让用例测不到节奏器的真正难点。
 */
async function startReplayServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url?.includes('/stream') !== true) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    })

    let seq = 0
    const frame = (payload: Record<string, unknown>) => {
      seq += 1
      res.write(
        `id: ${RUN_ID}:1:${seq}\ndata: ${JSON.stringify({
          schema_version: 1,
          run_id: RUN_ID,
          attempt: 1,
          ...payload,
        })}\n\n`
      )
    }

    frame({ seq: ++seq, type: 'status', status: 'generating', stage: 'generating', progress_percent: 40 })

    let accumulated = ''
    const timers: NodeJS.Timeout[] = []
    /**
     * 按**绝对**到达时刻排定时器（`delta.atMs` 减去首个 delta 的时刻，再按 SPEED 缩放）。
     *
     * 这里必须用绝对时刻，不能用「距上一帧的间隔」当延迟：间隔不是单调的，
     * 以间隔作延迟会让大空档后面的 delta 被排在前面，delta 乱序到达、拼接出乱码，
     * 而真 SSE 是 TCP 有序的，永远不会乱序——那测的是不存在的场景。
     */
    const originAtMs = ORIGIN_AT_MS
    for (const delta of trace.deltas) {
      const atMs = Math.max(0, Math.round((delta.atMs - originAtMs) / SPEED))
      timers.push(
        setTimeout(() => {
          if (res.writableEnded) return
          accumulated += delta.delta
          frame({ seq: ++seq, type: 'content.delta', slot: 'main', format: 'markdown', delta: delta.delta })
        }, atMs)
      )
    }
    timers.push(
      setTimeout(() => {
        if (res.writableEnded) return
        frame({
          seq: ++seq,
          type: 'done',
          status: 'completed',
          outputs: { main: { format: 'markdown', content: accumulated } },
        })
        res.end()
      }, REPLAY_END_MS + 300)
    )

    res.on('close', () => {
      for (const timer of timers) clearTimeout(timer)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

async function forgeSessionToken(): Promise<string> {
  return encode({
    token: {
      uid: '723c8e9a-8dbe-4b54-803e-0ec91430cee8',
      isAdmin: true,
      roleType: 'admin',
      operatorNameZh: '纪亚伟',
      sessionId: 'blf1072-e2e',
      name: 'Yawei',
      email: 'yawei@believeboy.com',
      sub: '723c8e9a-8dbe-4b54-803e-0ec91430cee8',
    },
    secret: BLF611_FIXTURE_SECRET,
    salt: 'authjs.session-token',
  })
}

async function installProbe(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __blf1072f: { start: number; frames: Sample[] } }
    w.__blf1072f = { start: performance.now(), frames: [] }
    const tick = () => {
      const panel = document.querySelector('[data-insight-scroll]')
      // 采样 `[role=document]` 而不是整个 markdown 容器：容器里还挂着「复制 / 导出」
      // 工具栏，它的文本会混进逐帧比较，把观测污染成假回跳。
      const root = panel?.querySelector('[role="document"]')
      if (panel && root) {
        const text = (root.textContent ?? '').replace(/\u200b/g, '')
        const tail = (root.querySelector('[data-insight-tail]') as HTMLElement | null)?.textContent ?? ''
        // stable 与 tail 的分界就在渲染器的 `[data-insight-tail]` 节点上；
        // tail 是渲染器自己承认的「半行」，稳定性断言只看 stable 部分。
        const stable = tail && text.endsWith(tail) ? text.slice(0, text.length - tail.length) : text
        w.__blf1072f.frames.push({
          t: Math.round(performance.now() - w.__blf1072f.start),
          state: root.getAttribute('data-state'),
          text,
          stable,
          tail,
        })
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

test.describe('BLF-1072 高频 delta 回放', () => {
  test.beforeEach(async ({ context, page }) => {
    await context.addCookies([
      {
        name: 'authjs.session-token',
        value: await forgeSessionToken(),
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ])
    fs.mkdirSync(OUT_DIR, { recursive: true })

    await page.route('**/api/auth/session', (route) =>
      route.fulfill({
        json: {
          user: {
            id: '723c8e9a-8dbe-4b54-803e-0ec91430cee8',
            name: 'Yawei',
            email: 'yawei@believeboy.com',
            roleType: 'admin',
            operatorNameZh: '纪亚伟',
          },
          expires: '2099-01-01T00:00:00.000Z',
        },
      })
    )
    await page.route('**/api/backend-base**', (route) => route.fulfill({ json: { base_url: '' } }))
    await page.route('**/api/backend/api/v1/projects/manage**', (route) =>
      route.fulfill({
        json: [
          { id: 1, name: '铨富', brand_name: 'Quanfu', project_operator: '纪亚伟', is_active: true },
        ],
      })
    )
    await page.route('**/api/backend/v1/ai-insights**', (route) =>
      route.fulfill({ json: { items: [], total: 0 } })
    )
    await page.route('**/api/backend/v1/insight/ad-analysis/runs', (route) =>
      route.fulfill({
        json: { schema_version: 1, run_id: RUN_ID, attempt: 1, status: 'queued', replayed: false },
      })
    )
    await page.route(`**/api/backend/v1/insight/runs/${RUN_ID}`, (route) =>
      route.fulfill({
        json: {
          schema_version: 1,
          run_id: RUN_ID,
          attempt: 1,
          status: 'generating',
          stage: 'generating',
          progress_percent: 40,
          outputs: {},
          resume: { latest_event_id: null, current_attempt: 1, history_available: true },
        },
      })
    )
  })

  test('469 帧成簇到达下：逐帧连续吐字、可见内容不回跳、单帧增量有界', async ({ page, context }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', '桌面视口观测')
    test.setTimeout(240_000)

    const replay = await startReplayServer()
    try {
      // 应用的 SSE 请求改道到回放服务（跨域靠 replay 的 CORS 头放行）。
      await context.route(`**/api/backend/v1/insight/runs/${RUN_ID}/stream`, (route) =>
        route.continue({ url: `http://127.0.0.1:${replay.port}/stream` })
      )

      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto('/dashboard/ai/ad-analysis')
      await installProbe(page)

      await expect(page.getByRole('button', { name: '立即生成' })).toBeEnabled({ timeout: 30_000 })
      await page.getByRole('button', { name: '立即生成' }).click()

      await expect(page.locator('[data-insight-markdown]').first()).toBeVisible({ timeout: 30_000 })
      // 吐字中途截一张图（此时正文应已开始出现但未结束）。
      await page.waitForTimeout(2_000)
      await page.screenshot({ path: path.join(OUT_DIR, 'fixture-typing.png') })
      await page.waitForTimeout(REPLAY_END_MS + 4_000)

      const frames = await page.evaluate(
        () => (window as unknown as { __blf1072f: { frames: Sample[] } }).__blf1072f.frames
      )
      const visible = frames.filter((f) => f.text.length > 0)
      expect(visible.length, '采样帧数应与吐字时长同量级').toBeGreaterThan(60)

      const finalFrame = visible[visible.length - 1]

      let previous = visible[0]
      let maxStep = 0
      let maxTailStep = 0
      let maxShrink = 0
      const steps: number[] = []
      const tailMismatches: {
        t: number
        tailLen: number
        matchedPrefixLen: number
        fixtureAt: number
        domAround: string
        rawAround: string
      }[] = []
      for (const frame of visible) {
        // 不变量 1：稳定区（已节点化的正文）只增不减，且始终是终态稳定区的前缀。
        // 这是「不抖动 / 不回跳」真正成立的断言——tail 本身是渲染器声明的"半行"缓冲区，
        // 它的内容会随节点化被收进稳定区（`### 1. 销售` → `<h3>1. 销售</h3>`），
        // 因此不能拿整段 textContent 直接做前缀比较。
        expect(
          frame.stable.length,
          '稳定区不应缩短（已渲染的正文不回跳）'
        ).toBeGreaterThanOrEqual(previous.stable.length)
        expect(
          finalFrame.stable.startsWith(frame.stable),
          '每一帧的稳定区都应是终态稳定区的前缀（不重复、不跳字）'
        ).toBe(true)

        // 不变量 2：未节点化的 tail 必须始终是终态原文的子串（不串字、不乱序）。
        if (frame.tail && !FULL_TEXT.includes(frame.tail)) {
          // 定位「从第几个字开始对不上」，便于区分丢字 / 串字 / 多字节截断。
          let matched = 0
          while (matched < frame.tail.length && FULL_TEXT.includes(frame.tail.slice(0, matched + 1))) {
            matched += 1
          }
          const at = FULL_TEXT.indexOf(frame.tail.slice(0, matched))
          tailMismatches.push({
            t: frame.t,
            tailLen: frame.tail.length,
            matchedPrefixLen: matched,
            fixtureAt: at,
            domAround: frame.tail.slice(Math.max(0, matched - 8), matched + 8),
            rawAround: FULL_TEXT.slice(Math.max(0, at + matched - 8), at + matched + 8),
          })
        }

        // 不变量 3：总可见长度只在「本行 Markdown 标记被节点化」时小幅回落
        // （`### ` / `- ` / 表格分隔符等消失），回落量有界。
        const step = frame.text.length - previous.text.length
        if (step < 0) maxShrink = Math.max(maxShrink, -step)
        steps.push(step)
        maxStep = Math.max(maxStep, step)
        maxTailStep = Math.max(maxTailStep, frame.tail.length - previous.tail.length)
        previous = frame
      }

      const finalLen = finalFrame.text.length
      const active = steps.filter((s) => s > 0)

      /** 只在「可见文本变了」的那些帧上记一条：吐字时间线，用于看节奏是否均匀。 */
      const timeline: { t: number; len: number; step: number }[] = []
      for (let index = 0; index < visible.length; index += 1) {
        if (steps[index] <= 0) continue
        timeline.push({ t: visible[index].t, len: visible[index].text.length, step: steps[index] })
      }
      const gaps = timeline.slice(1).map((entry, index) => entry.t - timeline[index].t)
      const sortedGaps = [...gaps].sort((a, b) => a - b)
      const percentile = (p: number) =>
        sortedGaps.length === 0
          ? 0
          : (sortedGaps[Math.min(sortedGaps.length - 1, Math.floor(sortedGaps.length * p))] ?? 0)

      const summary = {
        speed: SPEED,
        /** 终态渲染文本里必须包含原文的连续正文（验证链路没丢字 / 没串字） */
        finalHasProse: finalFrame.text.includes('成交规模萎缩'),
        finalState: finalFrame.state,
        sampledFrames: visible.length,
        deltaFrames: trace.deltas.length,
        recordedChars: FULL_TEXT.length,
        revealedChars: finalLen,
        maxStepPerFrame: maxStep,
        maxTailStepPerFrame: maxTailStep,
        maxShrinkPerFrame: maxShrink,
        avgStepOnActiveFrames: Number(
          (active.reduce((a, b) => a + b, 0) / Math.max(1, active.length)).toFixed(2)
        ),
        activeFrames: active.length,
        idleFrameShare: Number(((steps.length - active.length) / steps.length).toFixed(3)),
        revealUpdates: timeline.length,
        revealUpdatesPerSecond: Number(
          (timeline.length / Math.max(1, finalFrame.t)).toFixed(1)
        ),
        revealGapMs: {
          p50: percentile(0.5),
          p90: percentile(0.9),
          p99: percentile(0.99),
          max: sortedGaps[sortedGaps.length - 1] ?? 0,
        },
        longestStallMs: sortedGaps[sortedGaps.length - 1] ?? 0,
      }
      console.log(`[BLF-1072] fixture-replay ${JSON.stringify(summary)}`)
      fs.writeFileSync(path.join(OUT_DIR, 'fixture-probe.json'), JSON.stringify(summary, null, 2))
      fs.writeFileSync(
        path.join(OUT_DIR, 'fixture-reveal-timeline.json'),
        JSON.stringify({ summary, timeline }, null, 2)
      )
      fs.writeFileSync(
        path.join(OUT_DIR, 'fixture-final-dom.json'),
        JSON.stringify({ finalState: finalFrame.state, domChars: finalFrame.text.length, text: finalFrame.text, raw: FULL_TEXT }, null, 2)
      )

      // 断言放在证据落盘之后：失败时也能拿到实测数字与时间线，不用重跑。
      expect(finalFrame.state, '终态应以 final 状态渲染权威全文').toBe('final')
      expect(
        summary.finalHasProse,
        '终态渲染文本必须包含原文连续正文（链路不丢字、不串字）'
      ).toBe(true)
      expect(tailMismatches, 'tail 必须是终态原文的子串').toEqual([])
      expect(maxShrink, '总长度回落不得超过本行标记被节点化的长度').toBeLessThanOrEqual(6)
      // 到达的 657 个字最终必须吐完（部分 Markdown 标记被节点化，故留 10% 余量）。
      expect(finalLen).toBeGreaterThan(FULL_TEXT.length * 0.9)
      // 「不整块弹出」：任何一帧的增量都远小于全文（全文 ~640 字，单帧上限取 1/8）。
      expect(maxStep).toBeLessThan(finalLen / 8)
      // 吐字是真分帧的：有增量的帧数应与全文长度同阶（而不是个位数）。
      expect(active.length).toBeGreaterThan(60)
    } finally {
      await replay.close()
    }
  })
})
