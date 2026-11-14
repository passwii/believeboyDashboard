'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { ArrowUpRight, FileText } from 'lucide-react'

import styles from './believeboy-models-warm.module.css'

type Props = {
  source: string
}

const DOC_META = [
  { label: '归档位', value: 'teamRock/BBCC-彼励扶基础设施/彼励扶_Believeboy模型选型方案.md' },
  { label: '归属', value: 'BBCC · 彼励扶基础设施 / 模型选型' },
]

export function BelieveboyModelsView({ source }: Props) {
  return (
    <div className={styles.page} data-warm-believeboy-models="true">
      <article className={styles.document}>
        <header className={styles.metaBar}>
          <div className={styles.metaList}>
            {DOC_META.map((item) => (
              <div key={item.label} className={styles.metaItem}>
                <span className={styles.metaLabel}>{item.label}</span>
                <span className={styles.metaValue}>{item.value}</span>
              </div>
            ))}
          </div>
          <a
            href="/docs/believeboy-models.md"
            target="_blank"
            rel="noreferrer"
            className={styles.rawLink}
          >
            <FileText aria-hidden="true" />
            查看原始 markdown
            <ArrowUpRight aria-hidden="true" />
          </a>
        </header>

        <div className={styles.prose}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              table: ({ children }) => (
                <div className={styles.tableScroll} data-testid="believeboy-models-table-scroll">
                  <table>{children}</table>
                </div>
              ),
            }}
          >
            {source}
          </ReactMarkdown>
        </div>
      </article>
    </div>
  )
}
