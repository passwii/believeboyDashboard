'use client'

import React, { useRef, useEffect, useState, useMemo, useCallback, type FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { signIn } from 'next-auth/react'
import { useGlobalLoading } from '@/components/global-loading-provider'
import {
  clearLoginErrorHint,
  readLoginErrorHint,
  type LoginErrorHint,
} from '@/lib/auth/login-error-hint'
import { resolveLoginPageErrorCode, type ResolvedLoginPageErrorCode } from '@/lib/auth/login-error-code'
import { buildLoginErrorMessage } from '@/lib/auth/login-error-message'
import TerminalFormPanel from './terminal-form-panel'
import { LoginThemeToggle } from './login-theme-toggle'

const SIGN_IN_MINIMUM_DISPLAY_MS = 500
const SIGNIN_LOADING_WATCHDOG_MS = 10000
const SIGN_IN_MAX_ATTEMPTS = 3
const SIGN_IN_ATTEMPT_TIMEOUT_MS = 5000
const SIGN_IN_RETRY_DELAYS_MS = [500, 1000] as const
const RATE_LIMIT_TICK_MS = 1000

/**
 * 一次失败的登录尝试：页面只看 code 选文案（BLF-1383）。
 * `hint` 来自 authorize 失败时写入的短 TTL cookie（request_id / retry_after_seconds），
 * 因为 Auth.js 只把 code 透传到客户端。
 */
type LoginFailure = {
  code: ResolvedLoginPageErrorCode
  hint: LoginErrorHint | null
}

/**
 * BelieveBoy 登录表单与 credentials 流程。
 * 认证、callback 安全校验和导航 loading 生命周期留在本组件，
 * 品牌布局由 LoginEntry / LoginBrandPanel 独立负责。
 */

const SignInCard = () => {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [retryAttempt, setRetryAttempt] = useState(0)
  const [failure, setFailure] = useState<LoginFailure | null>(null)
  const [rateLimitDeadline, setRateLimitDeadline] = useState<number | null>(null)
  const [rateLimitRemaining, setRateLimitRemaining] = useState<number | null>(null)
  const mountedRef = useRef(true)
  const submittingRef = useRef(false)
  const verificationWaitRef = useRef<{ timer: number; resolve: () => void } | null>(null)
  const loadingPendingRef = useRef(false)
  const loadingWatchdogRef = useRef<number | null>(null)
  const router = useRouter()
  const searchParams = useSearchParams()
  const callbackUrl = useMemo(() => searchParams.get('callbackUrl') || '/dashboard', [searchParams])
  const { startGlobalLoading, endGlobalLoading } = useGlobalLoading()

  // Do not prefetch the callback route while the login page is still unauthenticated:
  // the request can be rewritten by middleware to the login page and poison the
  // App Router cache, which makes the post-sign-in navigation render stale login
  // content at the target URL.

  const finishNavigationLoading = useCallback(() => {
    if (!loadingPendingRef.current) return
    loadingPendingRef.current = false
    if (loadingWatchdogRef.current) {
      window.clearTimeout(loadingWatchdogRef.current)
      loadingWatchdogRef.current = null
    }
    endGlobalLoading('navigation')
  }, [endGlobalLoading])

  const beginNavigationLoading = useCallback(() => {
    if (loadingPendingRef.current) return
    loadingPendingRef.current = true
    startGlobalLoading('navigation')
    loadingWatchdogRef.current = window.setTimeout(() => {
      finishNavigationLoading()
    }, SIGNIN_LOADING_WATCHDOG_MS)
  }, [finishNavigationLoading, startGlobalLoading])

  useEffect(() => {
    if (!rateLimitDeadline) {
      setRateLimitRemaining(null)
      return
    }
    let timer: number | null = null
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((rateLimitDeadline - Date.now()) / 1000))
      if (!mountedRef.current) return
      setRateLimitRemaining(remaining > 0 ? remaining : null)
      if (remaining <= 0) {
        // 归零后停止每秒空转：remaining 已是 null，再 tick 也不会有任何变化。
        if (timer !== null) {
          window.clearInterval(timer)
          timer = null
        }
        return
      }
      // 惰性启动：deadline 已过期时不建 interval（
      // 否则要等下一次 tick 才把自己清掉）。
      if (timer === null) timer = window.setInterval(tick, RATE_LIMIT_TICK_MS)
    }
    tick()
    return () => {
      if (timer !== null) window.clearInterval(timer)
    }
  }, [rateLimitDeadline])

  // 文案完全由 code + 排查线索派生；倒计时每秒刷新一次，避免状态里存中文文案。
  const error = useMemo(() => {
    if (!failure) return null
    return buildLoginErrorMessage({
      code: failure.code,
      hint: failure.hint,
      rateLimitRemainingSeconds: rateLimitRemaining,
    })
  }, [failure, rateLimitRemaining])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (verificationWaitRef.current) {
        window.clearTimeout(verificationWaitRef.current.timer)
        verificationWaitRef.current.resolve()
        verificationWaitRef.current = null
      }
      finishNavigationLoading()
    }
  }, [finishNavigationLoading])

  const handleSignIn = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (submittingRef.current) return
    submittingRef.current = true
    const startedAt = performance.now()
    const waitForVerificationDisplay = async () => {
      if (!mountedRef.current) return
      const remaining = SIGN_IN_MINIMUM_DISPLAY_MS - (performance.now() - startedAt)
      if (remaining <= 0) return
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(() => {
          verificationWaitRef.current = null
          resolve()
        }, remaining)
        verificationWaitRef.current = { timer, resolve }
      })
    }
    setSubmitting(true)
    setRetryAttempt(0)
    setFailure(null)
    setRateLimitDeadline(null)

    // NOTE: We intentionally do NOT start the global "navigation" spinner
    // here. The login HTTP round-trip itself is fast (~150–400ms server
    // side) and the button's local loading state is enough feedback for
    // that phase. Starting the navigation spinner now would cover the
    // upcoming `router.push` AND the preceding login — making the spinner
    // feel longer than it actually is. We start the navigation spinner
    // only at the moment we hand off to the router (see below).
    try {
      let result: Awaited<ReturnType<typeof signIn>> | undefined
      let lastError: unknown
      let completed = false

      for (let attempt = 0; attempt < SIGN_IN_MAX_ATTEMPTS; attempt += 1) {
        if (!mountedRef.current) return

        try {
          lastError = undefined
          result = await new Promise<Awaited<ReturnType<typeof signIn>>>((resolve, reject) => {
            // Auth.js v5 signIn does not forward AbortSignal to fetch, so this
            // bounds our wait without claiming to cancel the underlying request.
            const timeoutId = window.setTimeout(
              () => reject(new DOMException('Sign-in attempt timed out', 'TimeoutError')),
              SIGN_IN_ATTEMPT_TIMEOUT_MS,
            )

            signIn('credentials', {
              email,
              password,
              callbackUrl,
              redirect: false,
            }).then(
              (value) => {
                window.clearTimeout(timeoutId)
                resolve(value)
              },
              (err: unknown) => {
                window.clearTimeout(timeoutId)
                reject(err)
              },
            )
          })
          completed = true
        } catch (err) {
          lastError = err
        }

        if (completed) {
          const resultCode = typeof result === 'string' ? '' : (result?.code?.toLowerCase() ?? '')
          if (resultCode !== 'network_error') break
        }

        if (attempt === SIGN_IN_MAX_ATTEMPTS - 1) {
          if (lastError) throw lastError
          break
        }

        if (!mountedRef.current) return
        setRetryAttempt(attempt + 1)
        await new Promise((resolve) => window.setTimeout(resolve, SIGN_IN_RETRY_DELAYS_MS[attempt]))
      }

      await waitForVerificationDisplay()
      if (!mountedRef.current) return
      setRetryAttempt(0)
      if (!result) {
        throw new Error('登录请求未返回结果')
      }
      const signInError = typeof result === 'string' ? result : result.error
      if (signInError) {
        submittingRef.current = false
        setSubmitting(false)
        const errorCode = typeof result === 'string' ? '' : result?.code
        // 401/429/500 是确定性失败：重试只会延长等待并加重限流计数（循环内已只对
        // network_error 重试）。这里按后端 code 选文案。
        const hint = readLoginErrorHint()
        clearLoginErrorHint()
        setFailure({ code: resolveLoginPageErrorCode(errorCode), hint })
        setRateLimitDeadline(
          hint?.retryAfterSeconds ? Date.now() + hint.retryAfterSeconds * 1000 : null,
        )
        return
      }

      // 登录成功就清掉上一条失败的排查线索：否则 120s 内紧接着的失败（例如
      // account_disabled）会显示上一次的请求 ID，误导排查。
      clearLoginErrorHint()
      let nextPath = '/dashboard'
      try {
        const callbackTarget = new URL(callbackUrl, window.location.origin)
        if (callbackTarget.origin === window.location.origin) {
          nextPath = `${callbackTarget.pathname}${callbackTarget.search}${callbackTarget.hash}`
        }
      } catch {
        nextPath = '/dashboard'
      }

      if (result.url) {
        try {
          const target = new URL(result.url, window.location.origin)
          if (target.origin === window.location.origin) {
            nextPath = `${target.pathname}${target.search}${target.hash}`
          }
        } catch {
          // Keep the validated same-origin callback or dashboard fallback.
        }
      }
      // Hand off to the router. Start the navigation spinner only now —
      // its job is to cover the dashboard RSC / client chunk load, not the
      // login HTTP we already finished.
      beginNavigationLoading()
      router.replace(nextPath)
    } catch (err) {
      await waitForVerificationDisplay()
      if (!mountedRef.current) return
      submittingRef.current = false
      setSubmitting(false)
      setRetryAttempt(0)
      // 走到这里是请求本身抛错（网络 / 超时）：沿用连接失败文案。
      setFailure({ code: 'network_error', hint: null })
      setRateLimitDeadline(null)
      console.error('登录请求失败:', err)
    }
  }

  return (
    <section aria-labelledby="login-form-title" className="form-panel">
      <div className="form-panel-top">
        <LoginThemeToggle />
      </div>
      <div className="form-main">
        <header className="form-heading">
          <h2 id="login-form-title">登录工作区</h2>
          <p id="login-form-description">
            {submitting ? '正在验证账号信息，请稍候。' : '使用企业邮箱和密码继续。'}
          </p>
        </header>
        <TerminalFormPanel
          email={email}
          setEmail={setEmail}
          password={password}
          setPassword={setPassword}
          submitting={submitting}
          error={error}
          retryAttempt={retryAttempt}
          maxRetryAttempts={SIGN_IN_MAX_ATTEMPTS - 1}
          onSubmit={handleSignIn}
        />
      </div>
      <footer className="form-footer">
        <span>账号安全登录</span>
        <span className="mono">EMAIL / PASSWORD</span>
      </footer>
    </section>
  )
}

export default SignInCard
