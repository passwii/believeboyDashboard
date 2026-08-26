'use client'

/**
 * 客户端 markdown 渲染器。
 * 由 page.tsx 读取的 .md 字符串传进来，套上全站 Card 样式。
 * 与 special/markdown-to-word 用同一套 react-markdown + remark-gfm。
 */

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { cn } from '@/lib/utils'
import { ArrowUpRight, FileText } from 'lucide-react'
import { TermPanel } from '@/components/terminal/term-panel'

type Props = {
  source: string
}

const DOC_META = [
  { label: '归档位', value: 'teamRock/BBCC-彼励扶基础设施/彼励扶_Believeboy模型选型方案.md' },
  { label: '归属', value: 'BBCC · 彼励扶基础设施 / 模型选型' },
]

export function BelieveboyModelsView({ source }: Props) {
  return (
    // BLF-838：页面标题由面包屑承载；Card 换 TermPanel
    <div className="flex min-w-0 flex-col gap-2">
      <TermPanel bodyClassName="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-none border border-dashed border-term-border bg-term-bg px-4 py-3 text-xs text-term-muted">
            {DOC_META.map((item) => (
              <div key={item.label} className="flex items-center gap-1.5">
                <span className="font-mono uppercase tracking-[0.14em] text-[0.66rem] text-foreground/70">
                  {item.label}
                </span>
                <span className="font-mono">{item.value}</span>
              </div>
            ))}
            <a
              href="/docs/believeboy-models.md"
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex h-7 items-center gap-1 rounded-none border border-term-border bg-term-bg px-2 font-mono text-xs text-term-muted transition-colors hover:border-term-border-strong hover:text-term-text"
            >
              <FileText className="h-3 w-3" strokeWidth={1.75} />
              查看原始 markdown
              <ArrowUpRight className="h-3 w-3" strokeWidth={1.75} />
            </a>
          </div>

          <div
            className={cn(
              'believeboy-prose',
              // —— 基础排版 ——
              'text-sm leading-7 text-foreground md:text-[0.95rem] md:leading-[1.85]',
              // —— 标题 ——
              '[&_h1]:hidden',
              '[&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:border-b [&_h2]:border-border/70 [&_h2]:pb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:first:mt-0 md:[&_h2]:text-xl',
              '[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold',
              // —— 段落 ——
              '[&_p]:my-3 [&_p]:leading-[1.85] [&_p]:text-foreground/90',
              // —— 强调 ——
              '[&_strong]:font-semibold [&_strong]:text-foreground',
              // —— 引用 (放说明 / 注块) ——
              '[&_blockquote]:my-4 [&_blockquote]:rounded-none [&_blockquote]:border-l-4 [&_blockquote]:border-term-accent/50 [&_blockquote]:bg-term-bg [&_blockquote]:px-4 [&_blockquote]:py-3 [&_blockquote]:text-term-muted',
              '[&_blockquote_p]:my-1',
              // —— 列表 ——
              '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-6',
              '[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-6',
              '[&_li]:leading-[1.8]',
              '[&_li_ul]:my-1',
              // —— 行内 code ——
              '[&_:not(pre)>code]:rounded-none [&_:not(pre)>code]:bg-term-raised [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.85em] [&_:not(pre)>code]:text-foreground/85',
              // —— 任务列表 (gfm) ——
              '[&_input[type=checkbox]]:mr-2 [&_input[type=checkbox]]:accent-primary',
              // —— 表格 (gfm) ——
              '[&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_table]:overflow-hidden [&_table]:rounded-none [&_table]:border [&_table]:border-term-border [&_table]:text-left [&_table]:font-mono [&_table]:text-xs [&_table]:tabular-nums',
              '[&_thead]:bg-term-raised',
              '[&_th]:border-b [&_th]:border-term-border [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_th]:normal-case [&_th]:tracking-normal [&_th]:text-term-muted [&_th]:text-xs',
              '[&_td]:border-b [&_td]:border-term-border [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_td]:text-term-text',
              '[&_tr:last-child_td]:border-b-0',
              '[&_tbody_tr]:transition-colors [&_tbody_tr]:hover:bg-term-hover',
              // —— hr ——
              '[&_hr]:my-6 [&_hr]:border-border/70'
            )}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // 手机端 markdown 表格：包一层 overflow-x-auto，列宽不压缩（规则 10）
                table: ({ children }) => (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">{children}</table>
                  </div>
                ),
              }}
            >
              {source}
            </ReactMarkdown>
          </div>
      </TermPanel>
    </div>
  )
}
