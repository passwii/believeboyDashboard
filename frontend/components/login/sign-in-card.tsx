'use client'

import React, { useRef, useEffect, useState, useMemo, useCallback, type FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { signIn } from 'next-auth/react'
import { useGlobalLoading } from '@/components/global-loading-provider'
import TerminalWindow from './terminal-window'
import BootSequence from './boot-sequence'
import TerminalFormPanel from './terminal-form-panel'

const SIGNIN_LOADING_WATCHDOG_MS = 10000

/**
 * Terminal 风格登录卡（BLF-965 重制）。
 * 登录逻辑（next-auth credentials + 全局 navigation loading + 错误映射）
 * 与旧版 sign-in-card 完全一致，仅表现层替换为终端窗口：
 * 左列 boot 输出 + 右列命令式表单，窄屏自动上下堆叠。
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
        const errorCode = signInError.toLowerCase()
        if (errorCode === 'network_error') {
          setError('无法连接到服务器，请检查后端服务是否启动。')
        } else {
          setError('邮箱或密码错误，或账号已停用。')
        }
        return
      }

      const fallbackPath = callbackUrl.startsWith('/') ? callbackUrl : '/dashboard'
      let nextPath = fallbackPath
      if (result.url) {
        try {
          const target = new URL(result.url, window.location.origin)
          if (target.origin === window.location.origin) {
            nextPath = `${target.pathname}${target.search}${target.hash}`
          }
        } catch {
          nextPath = fallbackPath
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
    <div className="flex h-full w-full items-center justify-center sm:px-2 md:px-4 lg:px-0">
      <TerminalWindow>
        <div className="grid bg-term-panel md:grid-cols-[1fr_1.2fr]">
          {/* 左：品牌 + boot 输出（窄屏隐藏 boot，保留品牌行） */}
          <div className="border-b border-term-border p-6 md:border-b-0 md:border-r">
            <p className="font-mono text-xs tracking-widest text-term-faint uppercase">
              believeboy · 跨境增长终端
            </p>
            <h1 className="mt-2 text-2xl font-bold text-term-text">彼励扶跨境</h1>
            <p className="mt-1 max-w-xs text-sm text-term-muted">
              为跨境销售与全球推广团队提供高效、可执行的品牌增长支持
            </p>
            <div className="mt-6 hidden md:block">
              <BootSequence />
            </div>
          </div>

          {/* 右：命令式表单 */}
          <div className="p-6 md:p-7">
            <TerminalFormPanel
              email={email}
              setEmail={setEmail}
              password={password}
              setPassword={setPassword}
              submitting={submitting}
              error={error}
              onSubmit={handleSignIn}
            />
            <p className="mt-5 border-t border-dashed border-term-border pt-3 text-center font-mono text-[11px] text-term-faint">
              品牌跨境 · 连接全球
            </p>
          </div>
        </div>
      </TerminalWindow>
    </div>
  )
}

export default SignInCard
