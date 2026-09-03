'use client'

import React, { type FormEvent } from 'react'
import { Eye, EyeOff, Lock, Mail } from 'lucide-react'

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
 * 终端命令式登录表单（BLF-965）：
 * 中文标签 + mono 命令注释行 + 带前缀图标的输入框，
 * 提交按钮中文为主（`登录`），命令以注释形式点缀；错误以 `✗` 行内输出。
 * id 保持 email / password 不变，保证浏览器密码管理器与测试选择器兼容。
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

  const inputClass =
    'w-full rounded-md border border-term-border-strong bg-term-bg py-2.5 pl-9 pr-10 text-sm text-term-text caret-term-pos placeholder:text-term-faint focus:border-term-pos focus:outline-none focus:ring-2 focus:ring-term-pos/25 disabled:cursor-not-allowed disabled:opacity-50'

  return (
    <div className="text-sm">
      <p className="mb-4 text-[13px] text-term-muted">
        <span className="font-mono text-term-pos" aria-hidden="true">
          $
        </span>{' '}
        登录到彼励扶终端{' '}
        <span className="font-mono text-[12px] text-term-faint"># believeboy login</span>
      </p>
      <form onSubmit={onSubmit} noValidate={false}>
        {/* 邮箱 */}
        <div className="mb-3">
          <label htmlFor="email" className="mb-1.5 block text-[13px] font-medium text-term-text">
            企业邮箱
          </label>
          <div className="relative">
            <Mail
              size={15}
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
        <div className="mb-1">
          <label htmlFor="password" className="mb-1.5 block text-[13px] font-medium text-term-text">
            登录密码
          </label>
          <div className="relative">
            <Lock
              size={15}
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
              className="absolute inset-y-0 right-0 flex items-center pr-3 text-term-faint hover:text-term-text"
            >
              {isPasswordVisible ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        {/* 错误输出行：保留空间避免布局抖动 */}
        <div aria-live="polite" className="min-h-[1.75rem] py-1">
          {error && (
            <p className="animate-fade-slide-up text-[13px] text-term-neg">
              <span aria-hidden="true">✗ </span>
              {error}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="mt-1 flex min-h-touch w-full items-center justify-center gap-2 rounded-md bg-term-pos py-2.5 text-sm font-medium text-white transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-term-pos focus-visible:ring-offset-2 focus-visible:ring-offset-term-panel disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? (
            <>
              <span aria-hidden="true" className="inline-block animate-spin">
                ⠋
              </span>
              登录中…
            </>
          ) : (
            <>
              登录
              <span aria-hidden="true" className="font-mono text-xs opacity-70">
                $ auth
              </span>
            </>
          )}
        </button>
      </form>
    </div>
  )
}

export default TerminalFormPanel
