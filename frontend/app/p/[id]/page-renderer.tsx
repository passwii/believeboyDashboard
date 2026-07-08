'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { cn } from '@/lib/utils'

type Props = {
  content: string
  format: 'markdown' | 'html'
  title: string
}

/**
 * Client-side renderer for the public page.
 *
 * - HTML: rendered inside a `sandbox="allow-scripts"` iframe (srcDoc) so
 *   untrusted markup cannot reach the parent document. The iframe title
 *   matches the page title for accessibility.
 * - Markdown: rendered via `react-markdown` (default-safe; raw HTML inside
 *   markdown is NOT enabled), wrapped in a prose-style class for readability.
 */
export default function PageRenderer({ content, format, title }: Props) {
  if (format === 'html') {
    return (
      <iframe
        sandbox="allow-scripts"
        srcDoc={content}
        title={title}
        className="w-full min-h-[80vh] rounded-lg border border-border/60 bg-white"
      />
    )
  }

  return (
    <article
      className={cn(
        'prose prose-slate max-w-none rounded-lg border border-border/60 bg-background p-6',
        'dark:prose-invert',
        '[&_a]:text-primary',
        '[&_blockquote]:border-l-4 [&_blockquote]:border-primary/40 [&_blockquote]:bg-primary/5 [&_blockquote]:py-1',
        '[&_table]:w-full [&_table]:overflow-hidden [&_table]:rounded-xl [&_table]:border [&_table]:border-border',
        '[&_th]:border [&_th]:border-border [&_th]:bg-muted/60 [&_th]:px-3 [&_th]:py-2 [&_th]:font-semibold',
        '[&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2',
        '[&_code]:rounded-md [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono',
        '[&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-slate-950 [&_pre]:p-4 [&_pre]:text-slate-100',
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </article>
  )
}