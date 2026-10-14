import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

import {
  SHARED_REPORT_PROJECT_STORAGE_KEY,
  readSharedReportProjectId,
  useSharedReportProject,
  writeSharedReportProjectId,
} from './shared-project'

/**
 * BLF-1344 · 月报板块三个 tab 共享「当前项目」的契约。
 *
 * 三个 tab 是同级路由，切 tab 会重挂载页面组件，所以共享只能靠存储 + 读取优先级。
 * 这里锁住读取优先级（页面显式值 > 共享记忆）与回写时机（任何一次有效选择都留给其它 tab）。
 */

function renderShared(initialProjectId: string) {
  // 页面侧「显式选择」的替身：记录页面 setter 收到的值
  const explicitSetCalls: string[] = []
  const handleExplicitSet = (value: string) => {
    explicitSetCalls.push(value)
  }

  const view = renderHook(
    ({ explicit }: { explicit: string }) =>
      useSharedReportProject({ projectId: explicit, setProjectId: handleExplicitSet }),
    { initialProps: { explicit: initialProjectId } }
  )

  return { ...view, explicitSetCalls }
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('共享记忆读写', () => {
  it('写入后可读回，空串视为清除', () => {
    writeSharedReportProjectId('2')
    expect(readSharedReportProjectId()).toBe('2')
    expect(window.localStorage.getItem(SHARED_REPORT_PROJECT_STORAGE_KEY)).toBe('2')

    writeSharedReportProjectId('')
    expect(readSharedReportProjectId()).toBe('')
    expect(window.localStorage.getItem(SHARED_REPORT_PROJECT_STORAGE_KEY)).toBeNull()
  })

  it('存储内容只剩余白时退化成没选过，不抛错', () => {
    window.localStorage.setItem(SHARED_REPORT_PROJECT_STORAGE_KEY, '   ')
    expect(readSharedReportProjectId()).toBe('')
  })
})

describe('useSharedReportProject', () => {
  it('页面没显式选择时沿用共享记忆，并把选择写回页面显式值', async () => {
    writeSharedReportProjectId('2')

    const { result, explicitSetCalls } = renderShared('')

    await waitFor(() => expect(result.current.ready).toBe(true))
    await waitFor(() => expect(result.current.projectId).toBe('2'))
    expect(explicitSetCalls).toContain('2')
    expect(readSharedReportProjectId()).toBe('2')
  })

  it('页面显式选择优先于共享记忆，并写回共享记忆', async () => {
    writeSharedReportProjectId('2')

    const { result, explicitSetCalls } = renderShared('1')

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.projectId).toBe('1')
    await waitFor(() => expect(readSharedReportProjectId()).toBe('1'))
    expect(explicitSetCalls).toEqual([])
  })

  it('没选过时保持空值，不自己造默认项目', async () => {
    const { result, explicitSetCalls } = renderShared('')

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.projectId).toBe('')
    expect(explicitSetCalls).toEqual([])
    expect(readSharedReportProjectId()).toBe('')
  })

  it('页面选择变化后共享记忆跟着变（供其它 tab 沿用）', async () => {
    const { result, rerender } = renderShared('1')
    await waitFor(() => expect(readSharedReportProjectId()).toBe('1'))

    rerender({ explicit: '3' })

    await waitFor(() => expect(readSharedReportProjectId()).toBe('3'))
    expect(result.current.projectId).toBe('3')
  })
})
