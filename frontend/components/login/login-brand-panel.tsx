'use client'

import React from 'react'

/** Brand-led introduction to the BelieveBoy operations workspace. */
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

      <div className="relative z-10 max-w-xl py-10 md:py-14">
        <h1 id="login-brand-title" className="text-4xl font-semibold leading-[1.08] tracking-tight text-term-text sm:text-5xl lg:text-6xl">
          彼励扶跨境
        </h1>
        <p className="mt-5 max-w-md text-base leading-7 text-term-muted sm:text-lg">
          跨境电商运营工作区
        </p>
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
