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
 * 配色走前端 terminal `--term-*` 令牌（与 TerminalShell / Header / Footer 同源），
 * 深浅主题由令牌自动翻转：浅 `#f5f5f7/#ffffff`，深 `#0c0c0e/#131316` 炭灰系，
 * 无 navy、无纯黑。主题切换走 next-themes（class 策略），与全局一致。
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
      className="animate-fade-slide-up w-full max-w-[min(94vw,58rem)] overflow-hidden rounded-lg border border-term-border bg-term-panel shadow-2xl shadow-black/10"
    >
      {/* ── Title bar ─────────────────────────────────────────── */}
      <div className="flex items-center gap-3 border-b border-term-border bg-term-raised px-4 py-2.5">
        {/* Traffic lights：纯装饰 */}
        <div aria-hidden="true" className="flex shrink-0 items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        </div>
        <p className="min-w-0 flex-1 truncate text-center font-mono text-xs text-term-muted">
          {title}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-term-pos" title="session live" />
          {mounted ? (
            <button
              type="button"
              onClick={() => setTheme(isDark ? 'light' : 'dark')}
              aria-label={isDark ? '切换到浅色模式' : '切换到深色模式'}
              className="flex h-7 w-7 items-center justify-center rounded-md text-term-muted transition-colors hover:bg-term-hover hover:text-term-text"
            >
              {isDark ? <SunMedium size={15} /> : <Moon size={15} />}
            </button>
          ) : (
            <span aria-hidden="true" className="h-7 w-7" />
          )}
        </div>
      </div>

      {/* ── Tab strip：单会话 ─────────────────────────────────── */}
      <div className="flex items-center border-b border-term-border bg-term-bg">
        <div
          aria-current="page"
          className="flex items-center gap-2 border-r border-term-border bg-term-panel px-4 py-1.5 font-mono text-xs text-term-text"
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-term-pos" />
          登录 — zsh
        </div>
      </div>

      {/* ── Body ──────────────────────────────────────────────── */}
      {children}

      {/* ── Status bar：与 TerminalFooter 同高同语汇（36px / mono / 中文状态） ── */}
      <div className="flex h-9 items-center justify-between border-t border-term-border bg-term-raised px-4 font-mono text-[11px] text-term-muted">
        <span>— zsh — 80×24</span>
        <span>utf-8 · lf · tls 1.3 · 会话正常</span>
      </div>
    </section>
  )
}

export default TerminalWindow
