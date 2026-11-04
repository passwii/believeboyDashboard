import { useId, type HTMLAttributes, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

import styles from './warm-crm-kit.module.css'

type WarmCrmPageProps = HTMLAttributes<HTMLDivElement>

export function WarmCrmPage({ className, children, ...props }: WarmCrmPageProps) {
  return (
    <div {...props} className={cn(styles.page, className)} data-warm-crm-page>
      {children}
    </div>
  )
}

type WarmCrmSectionProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  title?: ReactNode
  actions?: ReactNode
  bodyClassName?: string
}

export function WarmCrmSection({
  title,
  actions,
  bodyClassName,
  className,
  children,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  ...props
}: WarmCrmSectionProps) {
  const titleId = useId()

  return (
    <section
      {...props}
      aria-label={ariaLabel}
      aria-labelledby={title ? titleId : ariaLabelledBy}
      className={cn(styles.section, className)}
      data-warm-crm-section
    >
      {title || actions ? (
        <header className={styles.sectionHeader}>
          {title ? (
            <h2 className={styles.sectionTitle} id={titleId}>
              {title}
            </h2>
          ) : null}
          {actions ? <div className={styles.sectionActions}>{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn(styles.sectionBody, bodyClassName)} data-warm-crm-section-body>
        {children}
      </div>
    </section>
  )
}

type WarmCrmToolbarProps = {
  ariaLabel?: string
  start?: ReactNode
  end?: ReactNode
  className?: string
}

export function WarmCrmToolbar({ ariaLabel, start, end, className }: WarmCrmToolbarProps) {
  return (
    <div
      aria-label={ariaLabel}
      className={cn(styles.toolbar, className)}
      data-warm-crm-toolbar
      role={ariaLabel ? 'group' : undefined}
    >
      {start ? <div className={styles.toolbarStart}>{start}</div> : null}
      {end ? <div className={styles.toolbarEnd}>{end}</div> : null}
    </div>
  )
}

type WarmCrmTableFrameProps = HTMLAttributes<HTMLDivElement> & {
  footer?: ReactNode
}

export function WarmCrmTableFrame({
  footer,
  className,
  children,
  ...props
}: WarmCrmTableFrameProps) {
  return (
    <div {...props} className={cn(styles.tableFrame, className)} data-warm-crm-table-frame>
      {children}
      {footer ? <div className={styles.tableFooter}>{footer}</div> : null}
    </div>
  )
}

type WarmCrmTableScrollerProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'aria-label' | 'role' | 'tabIndex'
> & {
  ariaLabel: string
  interactiveRows?: boolean
}

export function WarmCrmTableScroller({
  ariaLabel,
  interactiveRows = false,
  className,
  children,
  ...props
}: WarmCrmTableScrollerProps) {
  return (
    <div
      {...props}
      aria-label={ariaLabel}
      className={cn(styles.tableScroller, interactiveRows && styles.interactiveRows, className)}
      data-interactive-rows={interactiveRows ? 'true' : undefined}
      data-table-scroll
      role="region"
      tabIndex={0}
    >
      {children}
    </div>
  )
}
