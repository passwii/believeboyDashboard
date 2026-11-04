'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import styles from './page-renderer.module.css'

type Props = {
  content: string
  format: 'markdown' | 'html'
  title: string
}

/**
 * Client-side renderer for the public page.
 *
 * HTML stays inside a scripts-only sandbox and on the intentional white paper
 * canvas. Markdown follows the Warm Ledger document tokens.
 */
export default function PageRenderer({ content, format, title }: Props) {
  if (format === 'html') {
    return (
      <iframe
        sandbox="allow-scripts"
        srcDoc={content}
        title={title}
        data-preview-surface="paper"
        className={styles.htmlDocument}
      />
    )
  }

  return (
    <article
      className={styles.markdownDocument}
      data-preview-surface="warm"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </article>
  )
}
