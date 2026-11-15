'use client'

import React from 'react'

import {
  GlassReveal21st,
  type GlassReveal21stProps,
} from '@/components/ui/liquid-glass-logo-reveal'

/**
 * 上游 `liquid-glass-logo-reveal.tsx` 自带的 demo 用法（原 `demo.tsx` 内容）。
 *
 * 保留它的唯一目的是**对照**：草稿页把「未改任何 tuning 的默认露出动画」
 * 和三个 Believeboy 变体并排，方便判断「变化效果」到底改了什么、值不值得。
 * 不要把这个默认用法直接接到品牌位。
 */
export function GlassReveal21stDemo({ className, ...props }: GlassReveal21stProps) {
  return <GlassReveal21st className={className} {...props} />
}

export default GlassReveal21stDemo
