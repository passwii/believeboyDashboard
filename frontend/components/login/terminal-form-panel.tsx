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
 * `$ beliveboy login --email ▍` 提示行 + 带前缀图标的输入框，
 * `$` 回显提交按钮，错误以 `✗ error[Exxxx]` 行内输出。
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
    'w-full rounded-md border border-neutral-300 bg-neutral-50 py-2.5 pl-9 pr-10 font-mono text-sm text-neutral-800 caret-emerald-600 placeholder:font-sans placeholder:text-neutral-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-[#1e1e21] dark:text-neutral-100 dark:caret-emerald-400 dark:placeholder:text-neutral-500 dark:focus:border-emerald-500/60'

  return (
    <div className="font-mono text-sm">
      <p className="mb-2 text-[13px] text-neutral-500 dark:text-neutral-400">
        <span className="text-emerald-600 dark:text-emerald-400">$</span> believeboy login --email{' '}
        <span aria-hidden="true" className="animate-cursor-blink ml-0.5 inline-block h-3.5 w-[7px] translate-y-[3px] bg-emerald-600 dark:bg-emerald-400" />
      </p>
      <form onSubmit={onSubmit} noValidate={false}>
        {/* email */}
        <div className="relative mb-3">
          <label htmlFor="email" className="sr-only">
            企业邮箱
          </label>
          <Mail
            size={15}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500"
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
            className={inputClass}
          />
        </div>

        {/* password */}
        <div className="relative mb-1">
          <label htmlFor="password" className="sr-only">
            登录密码
          </label>
          <Lock
            size={15}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500"
          />
          <input
            id="password"
            type={isPasswordVisible ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
            autoComplete="current-password"
            disabled={submitting}
            className={inputClass}
          />
          <button
            type="button"
            onClick={() => setIsPasswordVisible(!isPasswordVisible)}
            aria-label={isPasswordVisible ? '隐藏密码' : '显示密码'}
            className="absolute inset-y-0 right-0 flex items-center pr-3 text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
          >
            {isPasswordVisible ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>

        {/* 错误输出行：保留空间避免布局抖动 */}
        <div aria-live="polite" className="min-h-[1.75rem] py-1">
          {error && (
            <p className="animate-fade-slide-up text-[13px] text-red-600 dark:text-red-400">
              <span aria-hidden="true">✗ </span>
              {error}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="mt-1 flex min-h-touch w-full items-center justify-center gap-2 rounded-md bg-emerald-600 py-2.5 font-mono text-sm font-medium text-white transition-colors hover:bg-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-emerald-500 dark:hover:bg-emerald-400 dark:focus-visible:ring-offset-[#2d2d30]"
        >
          {submitting ? (
            <>
              <span aria-hidden="true" className="inline-block animate-spin">
                ⠋
              </span>
              authenticating…
            </>
          ) : (
            <>
              <span aria-hidden="true">$</span> auth --submit
            </>
          )}
        </button>
      </form>
    </div>
  )
}

export default TerminalFormPanel
