'use client'

import React from 'react'

interface BootLine {
  text: string
  tone: 'dim' | 'ok' | 'muted'
}

const BOOT_LINES: BootLine[] = [
  { text: 'Last login: today on ttys000', tone: 'dim' },
  { text: '✓ session established · tls 1.3', tone: 'ok' },
  { text: '✓ idp reachable · latency 38ms', tone: 'ok' },
  { text: 'tip: 账号为企业邮箱，密码区分大小写', tone: 'muted' },
]

/**
 * 开机自检输出（BLF-965）。
 * 纯展示型静态文本；动效一律走 CSS（globals fade-slide-up），
 * reduced-motion 下由全局 media query 自动关闭。
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
              ? 'text-emerald-600 dark:text-emerald-400'
              : line.tone === 'muted'
                ? 'text-neutral-400 dark:text-neutral-500'
                : 'text-neutral-500 dark:text-neutral-400'
          }`}
        >
          {line.text}
        </p>
      ))}
    </div>
  )
}

export default BootSequence
