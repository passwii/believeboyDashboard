import { describe, expect, it, vi } from 'vitest'
import type { DragEndEvent } from '@dnd-kit/core'
import type { Task } from '@/lib/crm/types'
import {
  applyStatusMove,
  createDragEndHandler,
  isBoardStatus,
  type SetTasksFn,
} from './board'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    title: '测试任务',
    priority: 'medium',
    status: 'pending',
    type: 'follow_up',
    ownerId: 'u-001',
    createdAt: '2026-08-01T00:00:00+00:00',
    updatedAt: '2026-08-01T00:00:00+00:00',
    ...overrides,
  }
}

function makeDragEndEvent(activeId: string, overId: string | null): DragEndEvent {
  return {
    active: { id: activeId } as DragEndEvent['active'],
    over: overId ? ({ id: overId } as DragEndEvent['over']) : null,
    delta: { x: 0, y: 0 },
  } as DragEndEvent
}

describe('isBoardStatus', () => {
  it('看板三列合法，cancelled 不入看板', () => {
    expect(isBoardStatus('pending')).toBe(true)
    expect(isBoardStatus('in_progress')).toBe(true)
    expect(isBoardStatus('done')).toBe(true)
    expect(isBoardStatus('cancelled')).toBe(false)
    expect(isBoardStatus('nonsense')).toBe(false)
  })
})

describe('applyStatusMove', () => {
  it('纯函数：仅目标任务改状态，原数组不变', () => {
    const tasks = [makeTask({ id: 'a', status: 'pending' }), makeTask({ id: 'b', status: 'done' })]
    const next = applyStatusMove(tasks, 'a', 'in_progress')
    expect(next.find((t) => t.id === 'a')?.status).toBe('in_progress')
    expect(next.find((t) => t.id === 'b')?.status).toBe('done')
    expect(tasks.find((t) => t.id === 'a')?.status).toBe('pending') // 不修改入参
  })
})

describe('createDragEndHandler', () => {
  it('拖拽落列 → 调 setTaskStatus(id, 目标状态) + 乐观更新', async () => {
    const tasks = [makeTask({ id: 'a', status: 'pending' })]
    const setTaskStatus = vi.fn().mockResolvedValue(makeTask({ id: 'a', status: 'done' }))
    const onError = vi.fn()
    const updates: Task[][] = []
    const setTasks: SetTasksFn = (updater) => {
      updates.push(typeof updater === 'function' ? (updater as (p: Task[]) => Task[])(updates[updates.length - 1] ?? tasks) : updater)
    }
    const handler = createDragEndHandler(tasks, setTasks, { setTaskStatus, onError })

    await handler(makeDragEndEvent('a', 'done'))

    expect(setTaskStatus).toHaveBeenCalledWith('a', 'done')
    // 乐观更新已把任务移入 done 列（handler 返回前，服务端结果尚未覆盖）
    expect(updates[0].find((t) => t.id === 'a')?.status).toBe('done')
    // 服务端结果合并：completed_at 等以后端为准
    expect(updates.at(-1)?.find((t) => t.id === 'a')?.status).toBe('done')
    expect(onError).not.toHaveBeenCalled()
  })

  it('成功用服务端返回合并本地（如 completed_at）', async () => {
    const tasks = [makeTask({ id: 'a', status: 'pending' })]
    const server = makeTask({ id: 'a', status: 'done', completedAt: '2026-08-08T10:00:00+00:00' })
    const setTaskStatus = vi.fn().mockResolvedValue(server)
    let applied: Task[] = []
    const setTasks: SetTasksFn = (updater) => {
      applied = typeof updater === 'function' ? (updater as (p: Task[]) => Task[])(applied.length ? applied : tasks) : updater
    }
    const handler = createDragEndHandler(tasks, setTasks, {
      setTaskStatus,
      onError: vi.fn(),
    })
    await handler(makeDragEndEvent('a', 'done'))
    expect(applied.find((t) => t.id === 'a')?.completedAt).toBe('2026-08-08T10:00:00+00:00')
  })

  it('失败回滚到原列表并提示错误', async () => {
    const tasks = [makeTask({ id: 'a', status: 'pending' })]
    const setTaskStatus = vi.fn().mockRejectedValue(new Error('网络错误'))
    const onError = vi.fn()
    const updates: Task[][] = []
    const setTasks: SetTasksFn = (updater) => {
      updates.push(typeof updater === 'function' ? (updater as (p: Task[]) => Task[])(updates.at(-1) ?? tasks) : updater)
    }
    const handler = createDragEndHandler(tasks, setTasks, { setTaskStatus, onError })

    await handler(makeDragEndEvent('a', 'done'))

    expect(setTaskStatus).toHaveBeenCalledWith('a', 'done')
    // 最后状态 = 回滚后的原列表（pending）
    expect(updates.at(-1)?.find((t) => t.id === 'a')?.status).toBe('pending')
    expect(onError).toHaveBeenCalledWith('网络错误')
  })

  it('目标列非看板列/相同状态/无任务 → 不调 API', async () => {
    const tasks = [makeTask({ id: 'a', status: 'pending' })]
    const setTaskStatus = vi.fn()
    const onError = vi.fn()
    const handler = createDragEndHandler(tasks, () => {}, { setTaskStatus, onError })

    await handler(makeDragEndEvent('a', 'cancelled')) // cancelled 不入看板
    await handler(makeDragEndEvent('a', 'pending')) // 状态未变
    await handler(makeDragEndEvent('missing', 'done')) // 任务不存在
    await handler(makeDragEndEvent('a', null)) // 未落到列

    expect(setTaskStatus).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })
})
