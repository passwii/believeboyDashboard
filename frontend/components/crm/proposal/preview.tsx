'use client'

import { useMemo } from 'react'
import { useTheme } from 'next-themes'

/**
 * 客户方案预览（单个 HTML）。
 *
 * 安全边界与工具箱的 page-render 一致：内容放进 `sandbox="allow-scripts"` 的
 * iframe（srcDoc），脚本无法触达父文档。**不** sanitize 掉 `<script>`——
 * 那会破坏文档功能，沙箱才是主防线。
 *
 * 主题：冻结的适配产物自带 light/dark 双令牌（`prefers-color-scheme` +
 * `data-bb-theme`）。iframe 是独立文档、读不到父页面的 `.dark` class，所以这里
 * 用**查看侧**改写把 app 当前主题强制注入（`applyPreviewTheme`）——只影响预览，
 * 下载产物保持双模式不变。
 */

/** 把 app 当前主题强制写进 HTML 根标签（纯函数，便于单测）。 */
export function applyPreviewTheme(content: string, theme: 'light' | 'dark'): string {
  const attr = `data-bb-theme="${theme}"`
  const htmlTag = /<html\b([^>]*)>/i
  const match = htmlTag.exec(content)

  if (!match) {
    return `<!DOCTYPE html><html ${attr}><head><meta charset="utf-8"></head><body>${content}</body></html>`
  }

  // 去掉已有的 data-bb-theme，避免重复属性
  const attrs = match[1].replace(/\s*data-bb-theme\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, '')
  const head = content.slice(0, match.index)
  const tail = content.slice(match.index + match[0].length)
  return `${head}<html${attrs} ${attr}>${tail}`
}

export interface ProposalPreviewProps {
  content: string
  title: string
  className?: string
  /** 高度用 CSS 高度类控制；默认 70vh。 */
  heightClassName?: string
}

export function ProposalPreview({
  content,
  title,
  className,
  heightClassName = 'min-h-[70vh]',
}: ProposalPreviewProps) {
  const { resolvedTheme } = useTheme()
  const theme = resolvedTheme === 'dark' ? 'dark' : 'light'
  const doc = useMemo(() => applyPreviewTheme(content, theme), [content, theme])

  return (
    <iframe
      title={title}
      sandbox="allow-scripts"
      srcDoc={doc}
      className={`w-full rounded-none border border-term-border bg-white dark:bg-term-bg ${heightClassName} ${
        className ?? ''
      }`}
    />
  )
}
