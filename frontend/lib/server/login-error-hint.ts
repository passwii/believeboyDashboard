import { cookies } from 'next/headers'

import {
  LOGIN_ERROR_HINT_COOKIE,
  LOGIN_ERROR_HINT_MAX_AGE_SECONDS,
  encodeLoginErrorHint,
  type LoginErrorHint,
} from '@/lib/auth/login-error-hint'

/**
 * 在 `authorize()` 失败时把排查线索写进短 TTL cookie（BLF-1383）。
 *
 * `cookies().set()` 在 App Router 的 Route Handler 里是受支持的（Next 会把 mutable
 * cookies 合并进最终响应），Auth.js 的 credentials callback 正跑在同一个请求作用域内。
 * 但它并非所有运行环境都可写，因此在登录这种关键路径上**绝不因为写 cookie 失败而
 * 改变登录结果**——静默降级为「没有请求 ID 可展示」。
 */
export async function rememberLoginErrorHint(hint: LoginErrorHint): Promise<void> {
  const value = encodeLoginErrorHint(hint)
  if (!value) return
  try {
    const cookieJar = await cookies()
    cookieJar.set(LOGIN_ERROR_HINT_COOKIE, value, {
      // 与 clearLoginErrorHint() 的 Path 保持一致，否则清不掉、旧请求 ID 会挂 2 分钟。
      path: '/',
      maxAge: LOGIN_ERROR_HINT_MAX_AGE_SECONDS,
      sameSite: 'lax',
      // 只是 code / 请求 ID / 等待秒数，无凭据；浏览器需要读出来展示。
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
    })
  } catch {
    // 例如在无法写 cookie 的上下文里执行 —— 忽略即可，登录结果不受影响。
  }
}
