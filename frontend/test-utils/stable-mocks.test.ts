/**
 * `stable-mocks` 自身的防回归自测（BLF-1246）。
 *
 * 这个 helper 存在的唯一理由就是「引用恒定」；一旦有人把它改成每次新建对象，
 * 存量测试会重新回到 BLF-1238 的无限渲染挂死，而且很难定位。所以把不变式钉在这里。
 */

import { describe, expect, it } from 'vitest'

import { notify, stableNotifications, stableSession } from './stable-mocks'

describe('stableSession', () => {
  it('无入参：多次调用返回同一对象（data 引用恒定）', () => {
    const a = stableSession()
    const b = stableSession()
    expect(a).toBe(b)
    expect(a.data).toBe(b.data)
    expect(a.status).toBe('authenticated')
  })

  it('相同入参：data 引用恒定，且 user 被浅合并', () => {
    const a = stableSession({ user: { isAdmin: true } })
    const b = stableSession({ user: { isAdmin: true } })
    expect(a).toBe(b)
    expect(a.data).toBe(b.data)
    expect((a.data?.user as Record<string, unknown>).isAdmin).toBe(true)
    // 默认 user 字段仍在
    expect((a.data?.user as Record<string, unknown>).name).toBe('测试用户')
  })

  it('入参不同：返回不同对象（session 真变了才换引用）', () => {
    const admin = stableSession({ user: { roleType: 'admin' } })
    const operator = stableSession({ user: { roleType: 'operator' } })
    expect(admin).not.toBe(operator)
    expect(admin.data).not.toBe(operator.data)
  })

  it('入参写法变化但值相同：仍复用同一引用（不按对象身份，按值缓存）', () => {
    const a = stableSession({ user: { id: 'user-1', roleType: 'admin' } })
    const b = stableSession({ user: { id: 'user-1', roleType: 'admin' } })
    expect(a).toBe(b)
  })

  it('支持 data: null + status: unauthenticated', () => {
    const a = stableSession({ data: null, status: 'unauthenticated' })
    const b = stableSession({ data: null, status: 'unauthenticated' })
    expect(a).toBe(b)
    expect(a.data).toBeNull()
    expect(a.status).toBe('unauthenticated')
  })

  it('user: null 时 data.user 为 null', () => {
    const value = stableSession({ user: null })
    expect(value.data?.user).toBeNull()
  })
})

describe('stableNotifications', () => {
  it('多次调用返回同一对象，notify 引用恒定', () => {
    const a = stableNotifications()
    const b = stableNotifications()
    expect(a).toBe(b)
    expect(a.notify).toBe(b.notify)
    expect(a.notify).toBe(notify)
  })

  it('notify 返回非空字符串 id（贴近真实 notify 契约）', () => {
    const id = stableNotifications().notify({ type: 'success', title: 'x' })
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })
})
