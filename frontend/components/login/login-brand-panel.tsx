'use client'

import React from 'react'

import { LOGIN_WORKSPACE_DOMAINS } from './login-workspace-domains'

/**
 * Brand-led introduction to the BelieveBoy operations workspace.
 *
 * 桌面左栏在窄屏隐藏；内容为品牌 + 「工作区地图」（登录后所在的 8 个业务域预览）。
 * 动效全部走 globals.css 的 `.login-*` 纯 CSS 类（零 JS、零计时器）：行巡览 + 栅格扫描，
 * 只动 opacity / transform / color，并在 `prefers-reduced-motion: reduce` 下整体关闭。
 * 行本身不可点击（未登录点击业务域只会被中间件弹回登录页），因此没有任何 hover 位移。
 */
export function LoginBrandPanel() {
  return (
    <section
      aria-labelledby="login-brand-title"
      className="relative order-2 hidden min-h-[18rem] flex-col justify-between overflow-hidden border-t border-term-border bg-term-raised p-6 sm:flex sm:p-8 md:order-1 md:flex md:min-h-dvh md:border-r md:border-t-0 md:p-10 lg:p-12"
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-40">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,var(--term-border)_1px,transparent_1px),linear-gradient(to_bottom,var(--term-border)_1px,transparent_1px)] bg-[size:32px_32px] [mask-image:linear-gradient(to_bottom,black,transparent_82%)]" />
        <div className="absolute inset-x-0 top-1/2 border-t border-term-border" />
        <div className="absolute left-1/2 top-0 h-full border-l border-term-border" />
        {/* 扫描线：一条 1px accent 横线沿栅格自上而下巡场，只做 transform/opacity */}
        <div className="login-grid-scan absolute inset-0 overflow-hidden">
          <div className="login-grid-scan-track absolute inset-x-0 top-0 h-full">
            <span className="login-grid-scan-line absolute inset-x-0 top-0 h-px bg-term-accent" />
          </div>
        </div>
      </div>

      <div className="relative z-10 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="grid h-10 w-10 place-items-center border border-term-border-strong bg-term-panel font-mono text-sm font-semibold tracking-tight text-term-pos">
            BB
          </span>
          <span className="font-mono text-sm font-semibold tracking-[0.12em] text-term-text">BelieveBoy</span>
        </div>
        <span className="font-mono text-xs tabular-nums text-term-muted">BB / WORKSPACE</span>
      </div>

      <div className="login-brand-stack animate-fade-slide-up relative z-10 flex flex-1 flex-col justify-center">
        <h1 id="login-brand-title" className="max-w-xl text-4xl font-semibold leading-[1.08] tracking-tight text-term-text sm:text-5xl lg:text-6xl">
          彼励扶跨境
        </h1>
        <p className="mt-5 max-w-md text-base leading-7 text-term-muted sm:text-lg">
          跨境电商运营工作区
        </p>

        <div className="login-brand-map w-full max-w-2xl border border-term-border bg-term-panel xl:max-w-3xl">
          <div className="flex items-center justify-between gap-4 border-b border-term-border px-4 py-2">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-term-muted">工作区地图</h2>
            <span className="font-mono text-[11px] tabular-nums text-term-muted">8 个业务域</span>
          </div>
          <ul className="divide-y divide-term-border">
            {LOGIN_WORKSPACE_DOMAINS.map((domain, index) => (
              <li
                key={domain.id}
                className="login-domain-row relative isolate flex items-center gap-3 pl-4 pr-4"
                style={{ '--login-domain-delay': `calc(${index} * 1s)` } as React.CSSProperties}
              >
                <domain.icon
                  size={16}
                  strokeWidth={1.75}
                  aria-hidden="true"
                  data-domain-hue="icon"
                  className="shrink-0 text-term-muted"
                />
                <span className="w-32 shrink-0 truncate text-[13px] leading-5 text-term-text lg:w-44">
                  {domain.label}
                </span>
                <span className="hidden min-w-0 flex-1 truncate font-mono text-[11px] leading-4 text-term-muted lg:block">
                  {domain.modules.join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="relative z-10 flex items-end justify-between gap-4 border-t border-term-border pt-4">
        <p className="max-w-xs text-sm leading-6 text-term-muted">
          为跨境电商团队组织日常运营与数据工作。
        </p>
        <span aria-hidden="true" className="hidden font-mono text-xs tabular-nums text-term-faint sm:block">
          01&nbsp; / &nbsp;GLOBAL
        </span>
      </div>
    </section>
  )
}
