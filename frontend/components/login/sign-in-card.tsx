'use client'

import React, { useRef, useEffect, useState, useMemo, useCallback, type FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { signIn } from 'next-auth/react'
import { useGlobalLoading } from '@/components/global-loading-provider'
import { LoginThemeToggle } from './login-theme-toggle'
import TerminalFormPanel from './terminal-form-panel'

const SIGNIN_LOADING_WATCHDOG_MS = 10000

/**
 * BelieveBoy 登录表单与 credentials 流程。
 * 认证、callback 安全校验和导航 loading 生命周期留在本组件，
 * 品牌布局由 LoginEntry / LoginBrandPanel 独立负责。
 */
const SignInCard = () => {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
    return () => {
      finishNavigationLoading()
    }
  }, [finishNavigationLoading])

  const handleSignIn = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)

    // NOTE: We intentionally do NOT start the global "navigation" spinner
    // here. The login HTTP round-trip itself is fast (~150–400ms server
    // side) and the button's local loading state is enough feedback for
    // that phase. Starting the navigation spinner now would cover the
    // upcoming `router.push` AND the preceding login — making the spinner
    // feel longer than it actually is. We start the navigation spinner
    // only at the moment we hand off to the router (see below).
    try {
      const result = await signIn('credentials', {
        email,
        password,
        callbackUrl,
        redirect: false,
      })

      const signInError = typeof result === 'string' ? result : result?.error
      if (signInError) {
        setSubmitting(false)
        const errorCode = typeof result === 'string' ? '' : result?.code?.toLowerCase()
        if (errorCode === 'network_error') {
          setError('无法连接到服务器，请检查后端服务是否启动。')
        } else {
          setError('邮箱或密码错误，或账号已停用。')
        }
        return
      }

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
      setSubmitting(false)
      setError('无法连接到服务器，请检查后端服务是否启动。')
      console.error('登录请求失败:', err)
    }
  }

  return (
    <section aria-labelledby="login-form-title" className="relative order-1 flex min-h-dvh flex-col bg-term-panel px-5 py-5 sm:px-8 sm:py-8 md:order-2 md:justify-between md:px-10 lg:px-14">
      <h1 className="sr-only md:hidden">彼励扶跨境</h1>
      <div className="flex items-center justify-between gap-3 md:justify-end">
        <div role="img" aria-label="BelieveBoy" className="flex items-center gap-3 md:hidden">
          <span aria-hidden="true" className="grid h-10 w-10 place-items-center border border-term-border-strong bg-term-raised font-mono text-sm font-semibold tracking-tight text-term-pos">
            BB
          </span>
          <span className="font-mono text-sm font-semibold tracking-[0.12em] text-term-text">BelieveBoy</span>
        </div>
        <LoginThemeToggle />
      </div>
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-8 md:flex-none md:py-12">
        <header className="mb-6 md:mb-8">
          <h2 id="login-form-title" className="md:text-3xl md:font-semibold md:tracking-tight md:text-term-text md:sm:text-4xl">
            登录工作区
          </h2>
          <p aria-hidden="true" className="text-3xl font-semibold tracking-tight text-term-text sm:text-4xl md:hidden">
            登录工作区
          </p>
          <p className="mt-3 text-sm leading-6 text-term-muted">
            使用企业邮箱和密码继续。
          </p>
        </header>
        <TerminalFormPanel
          email={email}
          setEmail={setEmail}
          password={password}
          setPassword={setPassword}
          submitting={submitting}
          error={error}
          onSubmit={handleSignIn}
        />
      </div>
      <footer className="flex items-center justify-between gap-4 border-t border-term-border pt-4 text-xs text-term-muted">
        <span>彼励扶跨境 · BelieveBoy</span>
        <span className="font-mono tabular-nums">账号安全登录</span>
      </footer>
    </section>
  )
}

export default SignInCard
