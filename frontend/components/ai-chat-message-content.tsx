'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { cn } from '@/lib/utils'

type AIChatMessageContentProps = {
  content: string
  className?: string
}

export function AIChatMessageContent({ content, className }: AIChatMessageContentProps) {
  return (
    <div
      className={cn(
        'min-w-0 text-sm leading-6 text-foreground',
        '[&_a]:text-primary [&_a]:underline-offset-4 hover:[&_a]:underline',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground',
        '[&_code]:rounded-[0.4rem] [&_code]:bg-muted/70 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]',
        '[&_h1]:mt-5 [&_h1]:text-lg [&_h1]:font-semibold',
        '[&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold',
        '[&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-semibold',
        '[&_hr]:my-4 [&_hr]:border-border',
        '[&_li]:ml-5 [&_li]:list-disc',
        '[&_ol]:space-y-1 [&_ol]:pl-5 [&_ol>li]:list-decimal',
        '[&_p]:whitespace-pre-wrap [&_p]:break-words',
        '[&_pre]:overflow-x-auto [&_pre]:rounded-2xl [&_pre]:border [&_pre]:bg-slate-950 [&_pre]:p-3 [&_pre]:text-slate-50',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit',
        '[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:overflow-hidden [&_table]:rounded-xl',
        '[&_tbody_tr]:border-t [&_tbody_tr]:border-border/60',
        '[&_td]:border [&_td]:border-border/60 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top',
        '[&_th]:border [&_th]:border-border/60 [&_th]:bg-muted/50 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium',
        '[&_ul]:space-y-1 [&_ul]:pl-5',
        className
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
}
