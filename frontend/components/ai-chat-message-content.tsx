'use client'

import React, { useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Copy, Check, Eye, EyeOff } from 'lucide-react'

import { cn } from '@/lib/utils'

type AIChatMessageContentProps = {
  content: string
  className?: string
}

type CodeBlockProps = {
  language: string
  code: string
}

function CodeBlock({ language, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const [showHtmlPreview, setShowHtmlPreview] = useState(false)

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [code])

  const isHtml = language === 'html' || language === 'htm'

  return (
    <div className="group relative my-3 rounded-2xl border border-border/80 bg-surface-panel overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/60 bg-muted/30">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {language || 'text'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {isHtml && (
            <button
              onClick={() => setShowHtmlPreview(!showHtmlPreview)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-muted"
            >
              {showHtmlPreview ? (
                <>
                  <EyeOff className="w-3.5 h-3.5" />
                  <span>Hide</span>
                </>
              ) : (
                <>
                  <Eye className="w-3.5 h-3.5" />
                  <span>Preview</span>
                </>
              )}
            </button>
          )}
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-muted"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-green-500" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
      </div>

      <div className={cn(showHtmlPreview && isHtml && 'hidden')}>
        <Prism
          language={language}
          style={oneDark}
          showLineNumbers
          customStyle={{
            margin: 0,
            padding: '1rem',
            background: 'transparent',
            fontSize: '0.8125rem',
            lineHeight: '1.6',
          }}
          lineNumberStyle={{
            minWidth: '2.5em',
            paddingRight: '1em',
            color: '#6b7280',
            userSelect: 'none',
          }}
        >
          {code}
        </Prism>
      </div>

      {isHtml && showHtmlPreview && (
        <div className="p-3">
          <iframe
            srcDoc={code}
            sandbox="allow-scripts"
            className="w-full min-h-[200px] border border-border/60 rounded-lg bg-white dark:bg-[hsl(var(--surface-base))]"
            title="HTML Preview"
          />
        </div>
      )}
    </div>
  )
}

function InlineCode({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <code
      className={cn(
        'rounded-[0.4rem] bg-muted/70 px-1.5 py-0.5 font-mono text-[0.85em]',
        className
      )}
    >
      {children}
    </code>
  )
}

export function AIChatMessageContent({ content, className }: AIChatMessageContentProps) {
  return (
    <div
      className={cn(
        'min-w-0 text-sm leading-6 text-foreground',
        '[&_a]:text-primary [&_a]:underline-offset-4 hover:[&_a]:underline',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground',
        '[&_h1]:mt-5 [&_h1]:text-lg [&_h1]:font-semibold',
        '[&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold',
        '[&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-semibold',
        '[&_hr]:my-4 [&_hr]:border-border',
        '[&_li]:ml-5 [&_li]:list-disc',
        '[&_ol]:space-y-1 [&_ol]:pl-5 [&_ol>li]:list-decimal',
        '[&_p]:whitespace-pre-wrap [&_p]:break-words',
        '[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:overflow-hidden [&_table]:rounded-xl',
        '[&_tbody_tr]:border-t [&_tbody_tr]:border-border/60',
        '[&_td]:border [&_td]:border-border/60 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top',
        '[&_th]:border [&_th]:border-border/60 [&_th]:bg-muted/50 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium',
        '[&_ul]:space-y-1 [&_ul]:pl-5',
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '')
            const isInline = !match && !String(children).includes('\n')

            if (isInline) {
              return (
                <InlineCode className={className} {...props}>
                  {children}
                </InlineCode>
              )
            }

            const language = match ? match[1] : ''
            const code = String(children).replace(/\n$/, '')

            return <CodeBlock language={language} code={code} />
          },
          pre({ children }) {
            return <>{children}</>
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
