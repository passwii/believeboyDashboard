'use client'

import React, { type FormEvent } from 'react'
import { ArrowRight, Eye, EyeOff } from 'lucide-react'

interface TerminalFormPanelProps {
  email: string
  setEmail: (v: string) => void
  password: string
  setPassword: (v: string) => void
  submitting: boolean
  retryAttempt: number
  maxRetryAttempts: number
  error: string | null
  onSubmit: (e: FormEvent<HTMLFormElement>) => void
}

const TerminalFormPanel = ({
  email, setEmail, password, setPassword, submitting, retryAttempt, maxRetryAttempts, error, onSubmit,
}: TerminalFormPanelProps) => {
  const [isPasswordVisible, setIsPasswordVisible] = React.useState(false)
  const status = submitting
    ? retryAttempt > 0
      ? `网络不稳定，正在重试（${retryAttempt}/${maxRetryAttempts}）…`
      : '正在安全验证登录信息…'
    : ''

  return (
    <form onSubmit={onSubmit} aria-busy={submitting} aria-describedby="login-form-description">
      <div className="field">
        <label htmlFor="email">企业邮箱</label>
        <input
          id="email" name="email" type="email" value={email}
          onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com"
          required autoComplete="email" disabled={submitting} className="login-input"
        />
      </div>
      <div className="field">
        <label htmlFor="password">登录密码</label>
        <div className="input-wrap">
          <input
            id="password" name="password" type={isPasswordVisible ? 'text' : 'password'}
            value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="请输入登录密码" required autoComplete="current-password"
            disabled={submitting} className="login-input"
          />
          <button
            className="password-toggle" type="button" disabled={submitting}
            onClick={() => setIsPasswordVisible(!isPasswordVisible)}
            aria-label={isPasswordVisible ? '隐藏密码' : '显示密码'} aria-pressed={isPasswordVisible}
          >
            {isPasswordVisible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </button>
        </div>
      </div>
      <p className="message" aria-live="polite" aria-atomic="true">{error}</p>
      <button
        className="submit-button"
        type="submit" disabled={submitting} aria-busy={submitting}
      >
        <span>{submitting ? '正在验证…' : '登录工作区'}</span>
        {submitting
          ? <span className="submit-indicator" aria-hidden="true" />
          : <span className="submit-arrow" aria-hidden="true"><ArrowRight /></span>}
      </button>
      <p className="form-status" role="status" aria-live="polite" aria-atomic="true">{status}</p>
    </form>
  )
}

export default TerminalFormPanel
