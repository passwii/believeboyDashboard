import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import CrmTasksLoading from './loading'

const CSS_FILES = [
  'app/dashboard/crm/tasks/page.module.css',
  'app/dashboard/crm/tasks/loading.module.css',
  'app/dashboard/crm/tasks/components/task-card.module.css',
  'app/dashboard/crm/tasks/components/task-kanban.module.css',
  'app/dashboard/crm/tasks/components/task-list.module.css',
  'components/crm/crm-task-form/task-form.module.css',
  'components/crm/crm-task-tab.module.css',
]

describe('CRM tasks Warm contract', () => {
  it('uses Warm Ledger tokens without Terminal aliases and includes mobile responsive adaptations', () => {
    for (const file of CSS_FILES) {
      const css = readFileSync(resolve(process.cwd(), file), 'utf8')
      expect(css, file).toContain('--warm-ledger-')
      expect(css, file).not.toContain('--term-')
    }
    const kanbanCss = readFileSync(resolve(process.cwd(), 'app/dashboard/crm/tasks/components/task-kanban.module.css'), 'utf8')
    expect(kanbanCss).toMatch(/@media\s*\(max-width:\s*640px\)/)
  })

  it('preserves the three-column desktop board geometry while loading', () => {
    const { container } = render(<CrmTasksLoading />)

    expect(screen.getByRole('status')).toHaveTextContent('任务加载中')
    expect(container.querySelectorAll('section')).toHaveLength(3)
    expect(screen.getByText('待办')).toBeInTheDocument()
    expect(screen.getByText('进行中')).toBeInTheDocument()
    expect(screen.getByText('已完成')).toBeInTheDocument()
  })
})
