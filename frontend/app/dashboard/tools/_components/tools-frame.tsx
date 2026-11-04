import type { HTMLAttributes, ReactNode } from 'react'

import { cn } from '@/lib/utils'

import styles from './tools-frame.module.css'

type ToolsPageFrameProps = HTMLAttributes<HTMLDivElement> & {
  layout?: 'stack' | 'split'
}

export function ToolsPageFrame({
  layout = 'stack',
  className,
  children,
  ...props
}: ToolsPageFrameProps) {
  return (
    <div
      {...props}
      className={cn(styles.frame, className)}
      data-layout={layout}
      data-tools-page-frame="true"
    >
      {children}
    </div>
  )
}

type ToolsPanelProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  title: string
  actions?: ReactNode
  bodyClassName?: string
}

export function ToolsPanel({
  title,
  actions,
  bodyClassName,
  className,
  children,
  ...props
}: ToolsPanelProps) {
  return (
    <section
      {...props}
      aria-label={props['aria-label'] ?? title}
      className={cn(styles.panel, className)}
      data-tools-panel="true"
    >
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>{title}</h2>
        {actions ? <div className={styles.panelActions}>{actions}</div> : null}
      </header>
      <div
        className={cn(styles.panelBody, bodyClassName)}
        data-tools-panel-body="true"
      >
        {children}
      </div>
    </section>
  )
}
