/**
 * BLF-1072 · 逐字吐字节奏器 —— 端到端吐字观测（真 provider delta）。
 *
 * 这不是「版式回归」，而是一台**观测仪器**：打开真实的广告分析生成弹窗，让 canonical
 * run 打到真实 provider，然后在浏览器里按帧采样屏幕上可见的 Markdown 文本，把
 * 「吐字连续不连续」变成可断言的数字。
 *
 * 为什么必须这样测：节奏器的正确性只有「屏幕每帧吐了多少字」能证明——单测能证明
 * 队列的数学（`reveal-queue.test.ts`），组件测能证明只重渲 tail，但「一条 469 帧的
 * 真实 delta 流落到屏幕上是不是连续吐字」只能在浏览器里按帧看。
 *
 * 运行（需要真实后端 + provider key 在本机 8101 上跑起来，见文件末尾说明）：
 *
 *   PLAYWRIGHT_PORT=3310 pnpm test:ui tests/dashboard/insight-typewriter-blf1072.spec.ts --project=chromium
 *
 * 产出：`test-results/blf1072/live.gif`（吐字过程录屏）、`*.png`（关键帧截图）、
 * 以及 stdout 的 `[BLF-1072] ...` 观测数字（帧数 / 单帧增量 / 空档分布）。
 */
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { encode } from 'next-auth/jwt'
import fs from 'node:fs'
import path from 'node:path'

import { BLF611_FIXTURE_SECRET } from '../setup/blf611-fixture'

const OUT_DIR = path.join(__dirname, '../../test-results/blf1072')

const SESSION = {
  user: {
    id: '1',
    name: 'E2E',
    email: 'e2e@example.com',
    roleType: 'admin',
    fullName: '纪亚伟',
  },
  expires: '2099-01-01T00:00:00.000Z',
}

const MANAGED_PROJECTS = [
  {
    id: 1,
    name: '铨富',
    brand_name: 'Quanfu',
    project_operator: '纪亚伟',
    is_active: true,
  },
]

/** 浏览器端按帧采样：记录每帧屏幕上的可见正文与位置。 */
type FrameSample = {
  t: number
  text: string
  /** 已节点化的稳定部分（`text` 去掉末尾 tail） */
  stable: string
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

type Probe = {
  start: number
  frames: FrameSample[]
  mutations: number
}

async function forgeSessionToken(): Promise<string> {
  return encode({
    token: {
      // 真实账号 + 与本地后端 Redis 中已登记的 session（`bb:session:<uid>:<sid>`）
      // 配套：中间件会用 X-Session-Id 去后端 `/auth/me` 复核，伪造 session 会被打回登录页。
      uid: '723c8e9a-8dbe-4b54-803e-0ec91430cee8',
      isAdmin: true,
      roleType: 'admin',
      // BLF-1441：显示名唯一来源 full_name（此用例走真实账号，值应与库里一致）
      fullName: '纪亚伟',
      sessionId: 'blf1072-e2e',
      name: 'Yawei',
      email: 'yawei@believeboy.com',
      sub: '723c8e9a-8dbe-4b54-803e-0ec91430cee8',
    },
    secret: BLF611_FIXTURE_SECRET,
    salt: 'authjs.session-token',
  })
}

/** 只 mock「鉴权与项目列表」这类周边读接口：run 与 SSE 走真实后端。 */
async function mockPeriphery(page: Page) {
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: SESSION }))
  await page.route('**/api/backend-base**', (route) => route.fulfill({ json: { base_url: '' } }))
  await page.route('**/api/backend/api/v1/projects/manage**', (route) =>
    route.fulfill({ json: MANAGED_PROJECTS })
  )
  await page.route('**/api/backend/v1/ai-insights**', (route) =>
    route.fulfill({ json: { items: [], total: 0 } })
  )
}

/**
 * 装观测器：从观察到 `[data-insight-tail]`/`[data-insight-markdown]` 开始，按 rAF
 * 采样可见正文（骨架文本 + tail 文本，就是用户眼睛里滚动的那串字）。
 */
async function installProbe(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __blf1072: Probe }
    w.__blf1072 = { start: performance.now(), frames: [], mutations: 0 }
    const readText = () => {
      const panel = document.querySelector('[data-insight-scroll]')
      if (!panel) return null
      // 采样 `[role=document]`：排除「复制 / 导出」工具栏文本（同上）。
      const root = panel.querySelector('[role="document"]')
      if (!root) return null
      const text = (root.textContent ?? '').replace(/\u200b/g, '')
      const tail =
        (root.querySelector('[data-insight-tail]') as HTMLElement | null)?.textContent ?? ''
      return {
        text,
        // stable = 已节点化的部分；tail 是渲染器声明的「半行」缓冲区，稳定性只看 stable。
        stable: tail && text.endsWith(tail) ? text.slice(0, text.length - tail.length) : text,
        scrollTop: panel.scrollTop,
        scrollHeight: panel.scrollHeight,
        clientHeight: panel.clientHeight,
      }
    }
    const observer = new MutationObserver((records) => {
      w.__blf1072.mutations += records.length
    })
    const tick = () => {
      const snapshot = readText()
      if (snapshot) {
        w.__blf1072.frames.push({
          t: Math.round(performance.now() - w.__blf1072.start),
          text: snapshot.text,
          stable: snapshot.stable,
          scrollTop: Math.round(snapshot.scrollTop),
          scrollHeight: Math.round(snapshot.scrollHeight),
          clientHeight: Math.round(snapshot.clientHeight),
        })
        observer.observe(
          document.querySelector('[role="document"]') ?? document.body,
          { childList: true, subtree: true, characterData: true }
        )
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function readProbe(page: Page): Promise<Probe> {
  return page.evaluate(() => (window as unknown as { __blf1072: Probe }).__blf1072)
}

test.describe('BLF-1072 逐字吐字（真实 delta）', () => {
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
    await mockPeriphery(page)
    fs.mkdirSync(OUT_DIR, { recursive: true })
  })

  test('真实 run 逐帧吐字：连续、无整块弹出、滚动不打架', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', '按桌面视口观测（记录帧随时长线性增长）')
    // 这个用例靠**真实 provider** 跑（无 fixture、无 mock）：它需要本机后端 + provider key，
    // 因此默认跳过，只在显式 `BLF1072_LIVE=1` 时执行，不给常规 playwright 套件制造假失败。
    // 确定性的回归靠 `insight-typewriter-fixture-blf1072.spec.ts`（回放录制 trace）。
    test.skip(process.env.BLF1072_LIVE !== '1', '需真实后端 + provider key，用 BLF1072_LIVE=1 显式开启')
    test.setTimeout(240_000)

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/dashboard/ai/ad-analysis')
    await installProbe(page)

    // 打开生成弹窗 = 提交真实 canonical 域 run（此处开始收到真 provider delta）。
    await expect(page.getByRole('button', { name: '立即生成' })).toBeEnabled({ timeout: 30_000 })
    await page.getByRole('button', { name: '立即生成' }).click()

    const markdown = page.locator('[data-insight-markdown]').first()
    await markdown.waitFor({ state: 'visible', timeout: 90_000 })

    // 吐字进行中截一张（第一章标题应该已经出现，正文仍在长）。
    await page.waitForTimeout(3_500)
    await page.screenshot({ path: path.join(OUT_DIR, 'typing.png'), fullPage: false })

    // 等到终态：状态区出现「已完成」或按钮变成「重试」/正文稳定。
    await expect(page.locator('[data-insight-panel]').first()).toBeVisible()
    const settled = await page
      .waitForFunction(
        () => {
          const w = window as unknown as { __blf1072: Probe }
          const frames = w.__blf1072.frames
          if (frames.length < 60) return false
          // 连续 45 帧（~0.75s）文本长度不变 = 吐字停止。
          const tail = frames.slice(-45)
          return (
            tail.every((f) => f.text.length === tail[0].text.length) && tail[0].text.length > 300
          )
        },
        undefined,
        { timeout: 180_000, polling: 250 }
      )
      .then(() => true)
      .catch(() => false)

    await page.screenshot({ path: path.join(OUT_DIR, 'settled.png'), fullPage: false })
    const probe = await readProbe(page)

    const frames = probe.frames.filter((f) => f.text.length > 0)
    expect(frames.length).toBeGreaterThan(120)
    expect(settled, '吐字应在超时前收敛（正文停止增长）').toBe(true)

    const finalFrame = frames[frames.length - 1]

    // ── 观测 1：单调 + 稳定区不回跳 + 单帧增量有界 ──
    // 整段 textContent 不做前缀比较：Markdown 语法标记（`###`、列表编号）会被渲染成
    // 节点而离开文本流，那是正确渲染，不是回跳。真正要守的是「稳定区只增不减、且始终是
    // 终态稳定区的前缀」，以及「可见长度不回退」。
    let maxStep = 0
    const steps: number[] = []
    let previous = frames[0]
    for (const frame of frames) {
      expect(frame.text.length, '可见文本长度不应回退').toBeGreaterThanOrEqual(
        previous.text.length
      )
      expect(frame.stable.length, '稳定区不应缩短（已渲染的正文不回跳）').toBeGreaterThanOrEqual(
        previous.stable.length
      )
      expect(
        finalFrame.stable.startsWith(frame.stable),
        '每一帧的稳定区都应是终态稳定区的前缀（不重复、不跳字）'
      ).toBe(true)
      const step = frame.text.length - previous.text.length
      steps.push(step)
      maxStep = Math.max(maxStep, step)
      previous = frame
    }

    // ── 观测 2：吐字连续性 —— 有增量的帧应远多于「一帧到位」──
    const total = finalFrame.text.length
    const nonEmptySteps = steps.filter((s) => s > 0)
    const zeroSteps = steps.filter((s) => s === 0).length

    // ── 观测 3：滚动跟随 —— 内容超出视口时应始终贴底（不打架）──
    const scrollFrames = frames.filter((f) => f.scrollHeight > f.clientHeight + 8)
    const atBottom = scrollFrames.filter(
      (f) => f.scrollHeight - f.scrollTop - f.clientHeight <= 48
    )
    const followRatio = scrollFrames.length > 0 ? atBottom.length / scrollFrames.length : 1

    const summary = {
      frames: frames.length,
      domMutations: probe.mutations,
      chars: total,
      maxStep,
      avgStepOnActiveFrames: Number(
        (nonEmptySteps.reduce((a, b) => a + b, 0) / Math.max(1, nonEmptySteps.length)).toFixed(2)
      ),
      idleFrameShare: Number((zeroSteps / steps.length).toFixed(3)),
      activeFrames: nonEmptySteps.length,
      followRatio: Number(followRatio.toFixed(3)),
      durationMs: frames[frames.length - 1].t,
    }
    console.log(`[BLF-1072] live-typing ${JSON.stringify(summary)}`)
    fs.writeFileSync(
      path.join(OUT_DIR, 'probe.json'),
      JSON.stringify({ summary, frames: frames.length > 4000 ? [] : frames }, null, 2)
    )

    // 断言（阈值取「明显宽于实测」的量级，避免把正常抖动判成回归）：
    expect(total, '正文量应达到一篇真实 Markdown 摘要的量级').toBeGreaterThan(400)
    expect(maxStep, '单帧不应整块弹出').toBeLessThan(total / 8)
    // 吐字是真的分帧推进的：出现增量的帧应远多于「一帧到位」。
    expect(nonEmptySteps.length).toBeGreaterThan(80)
    expect(frames.length, '帧采样数应与吐字时长同量级（不是只有几帧）').toBeGreaterThan(120)
    // 滚动跟随：贴底率应接近 1（用户没有上移）。
    expect(followRatio).toBeGreaterThan(0.9)
  })
})
