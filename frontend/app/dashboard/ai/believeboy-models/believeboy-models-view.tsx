'use client'

/**
 * 客户端 markdown 渲染器。
 * 由 page.tsx 读取的 .md 字符串传进来，套上全站 Card 样式。
 * 与 special/markdown-to-word 用同一套 react-markdown + remark-gfm。
 */

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { cn } from '@/lib/utils'
import { ArrowUpRight, FileText } from 'lucide-react'

type Props = {
  source: string
}

const DOC_META = [
  { label: '归档位', value: 'teamRock/BBCC-彼励扶基础设施/彼励扶_Believeboy模型选型方案.md' },
  { label: '归属', value: 'BBCC · 彼励扶基础设施 / 模型选型' },
]

export function BelieveboyModelsView({ source }: Props) {
  return (
    <div className="space-y-6 md:space-y-7">
      <PageHeader
        title="彼励扶 Believeboy 模型选型方案"
        description="汇总 Believeboy 系列大模型的规格与定位，以表格形式对比各档位模型在 名称 / 架构 / 大小 / 上下文 / 背后模型 五个维度的差异，便于算力选型、 推理部署、对外展示时快速查阅。（最后更新 2026-07-07）"
      />

      <Card className="dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
        <CardContent className="space-y-5 p-5 md:p-7">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-dashed border-border/70 bg-background/72 px-4 py-3 text-xs text-muted-foreground dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.84)]">
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
              className="ml-auto inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2.5 py-1 font-mono text-[0.7rem] text-foreground/80 transition-colors hover:border-primary/40 hover:text-primary dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.78)]"
            >
              <FileText className="h-3 w-3" />
              查看原始 markdown
              <ArrowUpRight className="h-3 w-3" />
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
              '[&_blockquote]:my-4 [&_blockquote]:rounded-r-2xl [&_blockquote]:border-l-4 [&_blockquote]:border-primary/45 [&_blockquote]:bg-primary/5 [&_blockquote]:px-4 [&_blockquote]:py-3 [&_blockquote]:text-muted-foreground',
              '[&_blockquote_p]:my-1',
              // —— 列表 ——
              '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-6',
              '[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-6',
              '[&_li]:leading-[1.8]',
              '[&_li_ul]:my-1',
              // —— 行内 code ——
              '[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.85em] [&_:not(pre)>code]:text-foreground/85',
              // —— 任务列表 (gfm) ——
              '[&_input[type=checkbox]]:mr-2 [&_input[type=checkbox]]:accent-primary',
              // —— 表格 (gfm) ——
              '[&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_table]:overflow-hidden [&_table]:rounded-2xl [&_table]:border [&_table]:border-border/70 [&_table]:text-left [&_table]:text-[0.9em]',
              '[&_thead]:bg-[hsl(var(--surface-soft)/0.85)]',
              '[&_th]:border-b [&_th]:border-border/70 [&_th]:px-4 [&_th]:py-2.5 [&_th]:text-left [&_th]:font-semibold [&_th]:text-foreground [&_th]:text-xs [&_th]:uppercase [&_th]:tracking-[0.12em]',
              '[&_td]:border-b [&_td]:border-border/60 [&_td]:px-4 [&_td]:py-2.5 [&_td]:align-top [&_td]:text-foreground/90',
              '[&_tr:last-child_td]:border-b-0',
              '[&_tbody_tr]:transition-colors [&_tbody_tr]:hover:bg-primary/5',
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
        </CardContent>
      </Card>
    </div>
  )
}
