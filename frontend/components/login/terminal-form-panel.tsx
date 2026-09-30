'use client'

import React, { type FormEvent } from 'react'
import { ArrowRight, Eye, EyeOff, Lock, Mail } from 'lucide-react'

interface TerminalFormPanelProps {
  email: string
  setEmail: (v: string) => void
  password: string
  setPassword: (v: string) => void
  submitting: boolean
  error: string | null
  onSubmit: (e: FormEvent<HTMLFormElement>) => void
}

/**
 * Brand-led 登录入口中的账号密码表单。
 * 稳定字段 id / autocomplete 保持浏览器密码管理器与自动化选择器兼容。
 */
const TerminalFormPanel = ({
  email,
  setEmail,
  password,
  setPassword,
  submitting,
  error,
  onSubmit,
}: TerminalFormPanelProps) => {
  const [isPasswordVisible, setIsPasswordVisible] = React.useState(false)

  // 刻意不带 `u-interactive`：该类会让输入框 hover 时上浮 1px；输入框是静态书写面，
  // hover 只允许 0 位移，仅保留 focus 的边框/光环过渡作为状态反馈。
  const inputClass =
    '[focus-visible]:outline [focus-visible]:outline-2 [focus-visible]:outline-term-accent [focus-visible]:outline-offset-2 h-12 w-full rounded-none border border-term-border-strong bg-term-bg pl-10 pr-10 text-sm text-term-text caret-term-pos transition-[border-color,box-shadow] [transition-duration:var(--motion-fast)] [transition-timing-function:var(--motion-ease-out)] placeholder:text-term-placeholder focus:border-term-pos focus:outline-none focus:ring-2 focus:ring-term-pos/25 disabled:cursor-not-allowed disabled:opacity-50'

  return (
    <div className="text-sm">
      <form onSubmit={onSubmit} noValidate={false} className="space-y-5">
        <div>
          <label htmlFor="email" className="mb-2 block text-sm font-medium text-term-text">
            企业邮箱
          </label>
          <div className="relative">
            <Mail
              size={18}
              strokeWidth={1.75}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-term-faint"
            />
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              required
              autoComplete="email"
              disabled={submitting}
              className={`${inputClass} font-mono`}
            />
          </div>
        </div>

        {/* 密码 */}
        <div>
          <label htmlFor="password" className="mb-2 block text-sm font-medium text-term-text">
            登录密码
          </label>
          <div className="relative">
            <Lock
              size={18}
              strokeWidth={1.75}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-term-faint"
            />
            <input
              id="password"
              type={isPasswordVisible ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入登录密码"
              required
              autoComplete="current-password"
              disabled={submitting}
              className={inputClass}
            />
            <button
              type="button"
              onClick={() => setIsPasswordVisible(!isPasswordVisible)}
              aria-label={isPasswordVisible ? '隐藏密码' : '显示密码'}
              className="[focus-visible]:outline [focus-visible]:outline-2 [focus-visible]:outline-term-accent [focus-visible]:outline-offset-2 absolute right-0 top-0 flex h-12 w-12 items-center justify-center bg-transparent text-term-faint transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-term-accent"
            >
              {isPasswordVisible ? <EyeOff size={18} strokeWidth={1.75} /> : <Eye size={18} strokeWidth={1.75} />}
            </button>
          </div>
        </div>

        {/* 错误反馈固定占位，避免提交失败时表单跳动 */}
        <div aria-live="polite" className="min-h-7">
          {error && (
            <p className="animate-fade-slide-up flex items-start gap-2 text-sm leading-6 text-term-neg">
              <span aria-hidden="true" className="font-mono">!</span>
              <span>{error}</span>
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="mt-2 flex h-12 w-full items-center justify-center gap-3 border border-term-action bg-term-action px-4 text-sm font-semibold text-term-action-text transition-[filter,transform] hover:brightness-95 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-term-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? (
            <>
              <span aria-hidden="true" className="inline-block h-4 w-4 animate-spin border-2 border-term-bg/40 border-t-term-bg" />
              正在验证…
            </>
          ) : (
            <>
              登录工作区
              <span aria-hidden="true" className="font-mono text-xs opacity-80">
                <ArrowRight size={16} strokeWidth={1.75} />
              </span>
            </>
          )}
        </button>
      </form>
    </div>
  )
}

export default TerminalFormPanel
