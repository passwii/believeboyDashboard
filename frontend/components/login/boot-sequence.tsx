'use client'

import React from 'react'

interface BootLine {
  text: string
  tone: 'dim' | 'ok' | 'muted'
}

const BOOT_LINES: BootLine[] = [
  { text: '上次登录：今天，终端 ttys000', tone: 'dim' },
  { text: '✓ 会话已建立 · tls 1.3', tone: 'ok' },
  { text: '✓ 认证服务可达 · 延迟 38ms', tone: 'ok' },
  { text: '提示：账号为企业邮箱，密码区分大小写', tone: 'muted' },
]

/**
 * 开机自检输出（BLF-965）。
 * 纯展示型静态文本；动效一律走 CSS（globals fade-slide-up），
 * reduced-motion 下由全局 media query 自动关闭。
 * 着色走 terminal 令牌：成功态 text-term-pos，其余 text-term-muted/faint。
 */
const BootSequence = () => {
  return (
    <div aria-hidden="true" className="select-none font-mono text-[13px] leading-6">
      {BOOT_LINES.map((line, i) => (
        <p
          key={line.text}
          style={{ animationDelay: `${i * 90}ms` }}
          className={`animate-fade-slide-up ${
            line.tone === 'ok'
              ? 'text-term-pos'
              : line.tone === 'muted'
                ? 'text-term-faint'
                : 'text-term-muted'
          }`}
        >
          {line.text}
        </p>
      ))}
    </div>
  )
}

export default BootSequence
