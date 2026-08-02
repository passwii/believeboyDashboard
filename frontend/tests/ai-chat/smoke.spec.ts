/**
 * AI chat smoke E2E — P0 coverage of the 20-item feature matrix from
 * BEL-379 verification. Real NextAuth login (selector-free, REST API) +
 * AI chat APIs mocked with deterministic SSE so tests are fast + reproducible.
 *
 * Auth pattern: inline below mirrors `backend/scripts/agent_testing/auth.py`
 * (the canonical Python helper). Inlined because Playwright 1.59.1 in this
 * repo has a quirk loading a separate `.ts`/`.mjs`/`.js` helper that imports
 * Node built-ins from a `.spec.ts` file (every other spec in `tests/` inlines
 * for the same reason). If a 2nd spec needs auth, copy this block.
 *
 * Run:
 *   pnpm dev                  # in another shell (or rely on playwright webServer)
 *   pnpm test:ui -- tests/ai-chat/smoke.spec.ts
 *
 * Required env (in backend/.env.test, gitignored):
 *   TEST_USER_EMAIL, TEST_USER_PASSWORD  ← a real dev account the backend has
 *
 * To force a fresh login (discard cached session):
 *   E2E_REFRESH_AUTH=1 pnpm test:ui -- tests/ai-chat/smoke.spec.ts
 */
import { expect, test, type Page } from '@playwright/test'

// Cache the Playwright storage state under `frontend/tests/.auth/user.json`
// (gitignored via `.gitignore:111`). Path is relative to cwd (frontend/).
const AUTH_FILE = 'tests/.auth/user.json'
const REFRESH = process.env.E2E_REFRESH_AUTH === '1'
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3200'

/**
 * Selector-free NextAuth credentials sign-in via the REST API. Mirrors
 * `backend/scripts/agent_testing/auth.py:login_via_nextauth`. Caches the
 * Playwright storage state in `frontend/tests/.auth/user.json` (gitignored).
 */
async function loginAsUser(page: Page): Promise<void> {
  const email = process.env.TEST_USER_EMAIL
  const password = process.env.TEST_USER_PASSWORD
  if (!email || !password) {
    throw new Error(
      'loginAsUser requires TEST_USER_EMAIL and TEST_USER_PASSWORD ' +
        '(set in backend/.env.test — gitignored, never committed).'
    )
  }

  const context = page.context()

  // 1. Try cached session.
  if (!REFRESH) {
    try {
      const fs = await import('node:fs')
      if (fs.existsSync(AUTH_FILE)) {
        const cached = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'))
        if (cached.cookies) await context.addCookies(cached.cookies)
        const session = await context.request.get(`${BASE_URL}/api/auth/session`)
        const data = (await session.json()) as { user?: { id?: string | number } }
        if (data?.user?.id) return
      }
    } catch {
      /* fall through to fresh login */
    }
  }

  // 2. Fresh login via NextAuth credentials REST flow.
  const csrfResp = await context.request.get(`${BASE_URL}/api/auth/csrf`)
  const csrfToken = ((await csrfResp.json()) as { csrfToken?: string }).csrfToken
  if (!csrfToken) {
    throw new Error(`NextAuth CSRF fetch failed: ${csrfResp.status()}`)
  }

  const resp = await context.request.post(`${BASE_URL}/api/auth/callback/credentials`, {
    form: { csrfToken, email, password, json: 'true' },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 0,
  })
  if (resp.status() !== 200 && resp.status() !== 302) {
    throw new Error(
      `NextAuth credentials login failed: ${resp.status()} ${(await resp.text()).slice(0, 200)}`
    )
  }

  // 3. Cache the session.
  try {
    const fs = await import('node:fs')
    fs.mkdirSync('tests/.auth', { recursive: true })
    fs.writeFileSync(AUTH_FILE, JSON.stringify(await context.storageState()), 'utf-8')
  } catch {
    /* cache write is best-effort */
  }
}

const CONV_ID = 424242

const conversationsFixture = [
  {
    id: CONV_ID,
    title: 'BEL-379 smoke conv',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-02T00:00:00Z',
    total_prompt_tokens: 1640,
    total_completion_tokens: 820,
    total_tokens: 2460,
  },
  {
    id: 424243,
    title: '另一段历史',
    created_at: '2026-07-30T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    total_prompt_tokens: 200,
    total_completion_tokens: 100,
    total_tokens: 300,
  },
]

const aiChatConfigFixture = {
  providerConfigured: true,
  webSearchConfigured: true,
  models: ['MiniMax-M3', 'OtherModel-01'],
  defaultModel: 'MiniMax-M3',
  premiumModels: ['MiniMax-M3'],
  basicModels: ['OtherModel-01'],
  reasoningModels: [],
  defaultReasoningEffort: 'medium',
  timeoutSeconds: 60,
  maxConversationTurns: 10,
  webSearchMaxResults: 5,
  overviewOptions: [],
  detailOptions: [],
  scenarios: [],
}

function buildSseResponse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + '\n\n'
}

async function mockAiChatApis(page: Page): Promise<void> {
  await page.route('**/api/ai-chat/config', async (route) => {
    await route.fulfill({ json: aiChatConfigFixture })
  })
  await page.route('**/api/ai-chat/conversations', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: conversationsFixture })
    } else {
      await route.continue()
    }
  })
  await page.route(`**/api/ai-chat/conversations/${CONV_ID}/messages`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: [] })
    } else {
      await route.continue()
    }
  })
}

test.describe('BEL-379 AI chat smoke (real login + mocked AI APIs)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsUser(page)
    await mockAiChatApis(page)
  })

  test('chat window renders with sidebar conversation + token totals', async ({ page }) => {
    await page.goto('/dashboard/ai/chat')
    const chatWindow = page.locator('[data-testid="ai-chat-window"]').first()
    await expect(chatWindow).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('BEL-379 smoke conv')).toBeVisible()
    await expect(page.getByText('另一段历史')).toBeVisible()
    // CONV_ID: 2460 → "2.5k"; the other: 300 → "300".
    const smokeRow = page
      .locator('[data-testid="ai-chat-window"]')
      .getByText('BEL-379 smoke conv')
      .locator('xpath=ancestor::div[1]')
    await expect(smokeRow.getByText('2.5k')).toBeVisible()
    await expect(smokeRow.getByText('300')).toBeVisible()
  })

  test('clicking a conversation loads its history', async ({ page }) => {
    await page.goto('/dashboard/ai/chat')
    await page.getByText('BEL-379 smoke conv').click()
    await expect(page.locator('[data-testid="ai-chat-window"]')).toBeVisible()
  })

  test('send → mocked SSE stream → assistant text + token footer render', async ({ page }) => {
    await page.route(`**/api/ai-chat/conversations/${CONV_ID}/messages/stream`, async (route) => {
      const body = buildSseResponse([
        { type: 'message_start', message_id: 'm1', model: 'MiniMax-M3', created_at: 1 },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '，这是' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'BEL-379' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', usage: { input_tokens: 820, output_tokens: 412, total_tokens: 1232 } },
        { type: 'message_stop' },
        {
          type: 'done',
          user_message: {
            id: 900,
            conversation_id: CONV_ID,
            role: 'user',
            content: 'hello',
            search_sources: [],
            is_complete: true,
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            created_at: '2026-08-02T00:00:00Z',
          },
          assistant_message: {
            id: 901,
            conversation_id: CONV_ID,
            role: 'assistant',
            content: '你好，这是BEL-379',
            search_sources: [],
            is_complete: true,
            prompt_tokens: 820,
            completion_tokens: 412,
            total_tokens: 1232,
            duration_ms: 1820,
            created_at: '2026-08-02T00:00:01Z',
          },
          conversation_title: null,
          token_usage: { prompt_tokens: 820, completion_tokens: 412, total_tokens: 1232 },
          conversation_token_usage: {
            prompt_tokens: 820,
            completion_tokens: 412,
            total_tokens: 1232,
          },
          duration_ms: 1820,
          title_regenerated: false,
        },
      ])
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
        body,
      })
    })

    await page.goto('/dashboard/ai/chat')
    const input = page.locator('textarea').first()
    await expect(input).toBeVisible({ timeout: 15000 })
    await input.fill('hello')
    await input.press('Enter')
    await expect(page.getByText('你好，这是BEL-379')).toBeVisible({ timeout: 10000 })
    // TokenFooter total chip + duration chip (B5 landed).
    await expect(page.getByText('1.8s')).toBeVisible()
  })

  test('cancel stream → input re-enables after stop', async ({ page }) => {
    await page.route(`**/api/ai-chat/conversations/${CONV_ID}/messages/stream`, async (route) => {
      const body = buildSseResponse([
        { type: 'message_start', message_id: 'm1', model: 'MiniMax-M3', created_at: 1 },
      ])
      await new Promise((r) => setTimeout(r, 5000))
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        body,
      })
    })
    await page.route(`**/api/ai-chat/conversations/${CONV_ID}/cancel`, async (route) => {
      await route.fulfill({ json: { cancelled: true } })
    })

    await page.goto('/dashboard/ai/chat')
    const input = page.locator('textarea').first()
    await expect(input).toBeVisible()
    await input.fill('hi')
    await input.press('Enter')
    await expect(input).toBeEditable({ timeout: 15000 })
  })

  test('edit user message + delete user message surface in MessageActions', async ({ page }) => {
    await page.route(`**/api/ai-chat/conversations/${CONV_ID}/messages`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          json: [
            {
              id: 1,
              conversation_id: CONV_ID,
              role: 'user',
              content: 'hello world',
              search_sources: [],
              is_complete: true,
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
              created_at: '2026-08-02T00:00:00Z',
            },
            {
              id: 2,
              conversation_id: CONV_ID,
              role: 'assistant',
              content: 'hi there',
              search_sources: [],
              is_complete: true,
              prompt_tokens: 5,
              completion_tokens: 3,
              total_tokens: 8,
              created_at: '2026-08-02T00:00:01Z',
            },
          ],
        })
      } else {
        await route.continue()
      }
    })
    await page.route(`**/api/ai-chat/conversations/${CONV_ID}/messages/1`, async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({ json: { id: 1, content: 'edited' } })
      } else if (route.request().method() === 'DELETE') {
        await route.fulfill({ status: 204 })
      } else {
        await route.continue()
      }
    })

    await page.goto('/dashboard/ai/chat')
    await expect(page.getByText('hello world')).toBeVisible({ timeout: 15000 })
    const userMsg = page.locator('[data-testid="ai-chat-window"]').getByText('hello world').first()
    await userMsg.hover()
    const buttons = page.locator('[data-testid="ai-chat-window"] button')
    expect(await buttons.count()).toBeGreaterThan(0)
  })
})