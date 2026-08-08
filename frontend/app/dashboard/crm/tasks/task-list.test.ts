import { describe, expect, it } from 'vitest'
import type { Task } from '@/lib/crm/types'
import { EMPTY_TASK_FILTER, filterTasks, sortTasks } from './components/task-list'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    title: '测试任务',
    priority: 'medium',
    status: 'pending',
    type: 'follow_up',
    ownerId: 'u-001',
    ownerName: '张三',
    createdAt: '2026-08-01T00:00:00+00:00',
    updatedAt: '2026-08-01T00:00:00+00:00',
    ...overrides,
  }
}

const FIXTURES: Task[] = [
  makeTask({ id: 't-1', title: '确认报价单', status: 'pending', type: 'follow_up', priority: 'high', dueDate: '2026-08-10T10:00:00+00:00', ownerId: 'u-001', ownerName: '张三', customerId: 'c1', customerName: '客户A' }),
  makeTask({ id: 't-2', title: '电话回访', status: 'in_progress', type: 'call', priority: 'medium', dueDate: '2026-08-05T10:00:00+00:00', ownerId: 'u-002', ownerName: '李四' }),
  makeTask({ id: 't-3', title: '安排拜访', status: 'done', type: 'visit', priority: 'urgent', dueDate: '2026-08-01T10:00:00+00:00', ownerId: 'u-001', ownerName: '张三', completedAt: '2026-08-01T12:00:00+00:00', leadId: 'l1', leadName: '线索X' }),
  makeTask({ id: 't-4', title: '无截止任务', status: 'pending', type: 'custom', priority: 'low', createdAt: '2026-08-02T00:00:00+00:00' }),
]

describe('filterTasks（BLF-514 表头筛选）', () => {
  it('空筛选返回全量', () => {
    expect(filterTasks(FIXTURES, EMPTY_TASK_FILTER)).toHaveLength(4)
  })

  it('按 type / status / priority 组合筛选', () => {
    const r = filterTasks(FIXTURES, { ...EMPTY_TASK_FILTER, type: 'call', status: 'in_progress' })
    expect(r.map((t) => t.id)).toEqual(['t-2'])
    const byPriority = filterTasks(FIXTURES, { ...EMPTY_TASK_FILTER, priority: 'urgent' })
    expect(byPriority.map((t) => t.id)).toEqual(['t-3'])
  })

  it('按 ownerId 筛选', () => {
    const r = filterTasks(FIXTURES, { ...EMPTY_TASK_FILTER, ownerId: 'u-002' })
    expect(r.map((t) => t.id)).toEqual(['t-2'])
  })

  it('按关联客户/线索筛选（lead 用 lead: 前缀）', () => {
    const byCustomer = filterTasks(FIXTURES, { ...EMPTY_TASK_FILTER, customerId: 'c1' })
    expect(byCustomer.map((t) => t.id)).toEqual(['t-1'])
    const byLead = filterTasks(FIXTURES, { ...EMPTY_TASK_FILTER, customerId: 'lead:l1' })
    expect(byLead.map((t) => t.id)).toEqual(['t-3'])
  })
})

describe('sortTasks（BLF-514 排序）', () => {
  it('截止升序：有截止的在前按时间，无截止垫底', () => {
    const r = sortTasks(FIXTURES, 'dueDate', 'asc')
    const withDue = r.filter((t) => t.dueDate)
    const times = withDue.map((t) => new Date(t.dueDate!).getTime())
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    expect(r[r.length - 1].id).toBe('t-4') // 无截止最后
  })

  it('优先级降序：urgent > high > medium > low', () => {
    const r = sortTasks(FIXTURES, 'priority', 'desc')
    const order = r.map((t) => t.priority)
    expect(order).toEqual(['urgent', 'high', 'medium', 'low'])
  })

  it('创建时间升序', () => {
    const r = sortTasks(FIXTURES, 'createdAt', 'asc')
    expect(r[0].id).toBe('t-1')
    expect(r[r.length - 1].id).toBe('t-4')
  })
})
