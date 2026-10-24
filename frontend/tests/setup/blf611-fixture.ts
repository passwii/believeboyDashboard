/**
 * BLF-611 手机端回归测试 fixture（仅供测试，非生产 secret）。
 *
 * playwright.config.ts（webServer.env）与 ad-mobile-blf611.spec.ts（伪造
 * next-auth session cookie）共用同一常量，避免两处漂移。
 */
import { encode } from 'next-auth/jwt'
import type { BrowserContext } from '@playwright/test'

export const BLF611_FIXTURE_SECRET =
  'blf611-e2e-fixture-secret-0123456789-abcdefghijklmnopqrstuvwxyz-42'

/** Install a signed local session cookie for self-contained authenticated E2E specs. */
export async function addBLF611FixtureAuth(context: BrowserContext): Promise<void> {
  const value = await encode({
    token: {
      uid: '1',
      isAdmin: true,
      roleType: 'admin',
      // BLF-1441：会话显示名唯一来源是 full_name；伪造 token 也带上，
      // 否则 E2E 走的是「旧 token」过渡分支，测不到新口径。
      fullName: 'E2E',
      sessionId: 'e2e-session',
      name: 'E2E',
      email: 'e2e@example.com',
      sub: '1',
    },
    secret: BLF611_FIXTURE_SECRET,
    salt: 'authjs.session-token',
  })

  await context.addCookies([
    {
      name: 'authjs.session-token',
      value,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
}
