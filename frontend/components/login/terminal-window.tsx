'use client'

import React from 'react'
import { useTheme } from 'next-themes'
import { Moon, SunMedium } from 'lucide-react'

interface TerminalWindowProps {
  title?: string
  children: React.ReactNode
}

/**
 * macOS 风格终端窗口壳（BLF-965）。
 * 灰阶优先：light 用中性浅灰层叠，dark 用 #2x 系炭灰层叠（BLF-609 之后不再用 navy 渐变），
 * 不用纯黑，保证可读性。主题切换走 next-themes（class 策略），与全局一致。
 */
const TerminalWindow = ({ title = 'guest@believeboy: ~ — zsh', children }: TerminalWindowProps) => {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  const isDark = mounted && resolvedTheme === 'dark'

  return (
    <section
      aria-label="登录终端"
      className="animate-fade-slide-up w-full max-w-[min(94vw,58rem)] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl shadow-neutral-900/10 dark:border-white/10 dark:bg-[#2d2d30] dark:shadow-black/50"
    >
      {/* ── Title bar ─────────────────────────────────────────── */}
      <div className="flex items-center gap-3 border-b border-neutral-200 bg-[#e9e9ec] px-4 py-2.5 dark:border-white/10 dark:bg-[#383838]">
        {/* Traffic lights：纯装饰 */}
        <div aria-hidden="true" className="flex shrink-0 items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        </div>
        <p className="min-w-0 flex-1 truncate text-center font-mono text-xs text-neutral-500 dark:text-neutral-400">
          {title}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-full bg-emerald-500 dark:bg-emerald-400"
            title="session live"
          />
          {mounted ? (
            <button
              type="button"
              onClick={() => setTheme(isDark ? 'light' : 'dark')}
              aria-label={isDark ? '切换到浅色模式' : '切换到深色模式'}
              className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-black/5 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100"
            >
              {isDark ? <SunMedium size={15} /> : <Moon size={15} />}
            </button>
          ) : (
            <span aria-hidden="true" className="h-7 w-7" />
          )}
        </div>
      </div>

      {/* ── Tab strip：单会话 ─────────────────────────────────── */}
      <div className="flex items-center border-b border-neutral-200 bg-[#dedee2] dark:border-white/10 dark:bg-[#2f2f33]">
        <div
          aria-current="page"
          className="flex items-center gap-2 border-r border-neutral-200 bg-white px-4 py-1.5 font-mono text-xs text-neutral-700 dark:border-white/10 dark:bg-[#2d2d30] dark:text-neutral-200"
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          login — zsh
        </div>
      </div>

      {/* ── Body ──────────────────────────────────────────────── */}
      {children}

      {/* ── Status bar ────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-t border-neutral-200 bg-[#e9e9ec] px-4 py-1.5 font-mono text-[11px] text-neutral-500 dark:border-white/10 dark:bg-[#383838] dark:text-neutral-400">
        <span>— zsh — 80×24</span>
        <span>utf-8 · lf · tls1.3</span>
      </div>
    </section>
  )
}

export default TerminalWindow
