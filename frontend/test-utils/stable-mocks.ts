/**
 * 稳定引用的测试 mock 工厂（BLF-1246，根因见 BLF-1238）。
 *
 * 背景：组件普遍把 `useSession()` 的 `data`（= `session`）和 `useNotifications()` 的
 * `notify` 放进 `useEffect` / `useCallback` 依赖数组。真实实现里这两个引用是**稳定**的：
 *  - next-auth v5 的 `SessionProvider` 用 `useMemo` 缓存 value，session 未变时 `data` 身份恒定；
 *  - `NotificationsProvider` 的 `notify` 是 `useCallback(..., [])`，身份恒定。
 *
 * 测试若写成 `useSession: () => ({ data: { ... } })` / `useNotifications: () => ({ notify: vi.fn() })`，
 * 每次渲染都是**新引用** → `[session]` / `[notify]` 依赖的 effect 每轮渲染重跑 →
 * effect 内无条件 `setState` → 无限渲染 → 微任务链饿死计时器 → 该文件永不收敛、
 * 整轮 vitest 挂死（`--testTimeout` 都救不了）。
 *
 * 用法（mock 工厂里直接调，不需要 `vi.hoisted`）：
 *
 * ```ts
 * import { stableNotifications, stableSession } from '@/test-utils/stable-mocks'
 *
 * vi.mock('next-auth/react', () => ({
 *   useSession: () => stableSession({ user: { isAdmin: true } }),
 * }))
 * vi.mock('@/components/notifications', () => ({
 *   useNotifications: () => stableNotifications(),
 * }))
 * ```
 *
 * 断言共享的 `notify` 时直接 import 本模块的 `notify`，并在 `beforeEach` 里
 * `vi.clearAllMocks()`（同一个测试文件内所有用例共享同一个 mock，不清理会串调用记录）。
 *
 * 不变式（本文件自带防回归自测，见 `stable-mocks.test.ts`）：
 * 同一入参下，`stableSession()` 返回的**整个对象**（含 `data`）与
 * `stableNotifications()` 返回的 `notify` **身份恒定**——本模块只缓存、不新建。
 */

import { vi, type Mock } from 'vitest'

import type { NotifyOptions } from '@/lib/notifications'

/** mock session 的 user 字段；浅合并进默认 user。 */
export type StableSessionUser = Record<string, unknown>

export interface StableSessionOptions {
  /** 浅合并进默认 user（`{ name: '测试用户' }`）；传 `null` 表示不带 user。 */
  user?: StableSessionUser | null
  /** 直接指定整个 `data`（例如 `null` 配 `status: 'unauthenticated'`）；给了它就忽略 `user`。 */
  data?: Record<string, unknown> | null
  /** 默认 `'authenticated'`。 */
  status?: 'authenticated' | 'unauthenticated' | 'loading'
}

export interface StableSessionValue {
  data: Record<string, unknown> | null
  status: 'authenticated' | 'unauthenticated' | 'loading'
}

const DEFAULT_USER: StableSessionUser = { name: '测试用户' }
const DEFAULT_EXPIRES = '2099-01-01T00:00:00.000Z'

/** 按入参缓存：同 key 复用同一个对象，绝不每次调用新建。 */
const sessionCache = new Map<string, StableSessionValue>()

/**
 * 返回稳定引用的 `useSession()` 结果。
 *
 * 同一入参（按 `JSON.stringify` 归一化）下重复调用返回**同一个对象**，
 * 因此可安全地放进 effect / useCallback 依赖数组。入参变化（如用例切换
 * `sessionRef.roleType`）才会产生新对象——这正好对应「session 真的变了」。
 */
export function stableSession(options: StableSessionOptions = {}): StableSessionValue {
  const status = options.status ?? 'authenticated'
  const key = JSON.stringify({ user: options.user, data: options.data, status })
  const cached = sessionCache.get(key)
  if (cached) return cached

  const data =
    options.data !== undefined
      ? options.data
      : {
          user: options.user === null ? null : { ...DEFAULT_USER, ...(options.user ?? {}) },
          expires: DEFAULT_EXPIRES,
        }

  const value: StableSessionValue = { data, status }
  sessionCache.set(key, value)
  return value
}

let notifySeq = 0

/**
 * 共享的 `notify` mock：身份恒定（模块级单例），调用记录可用
 * `expect(notify).toHaveBeenCalledWith(...)` 断言。
 *
 * ⚠️ 同一测试文件内跨用例共享 → 断言前请在 `beforeEach` 里 `vi.clearAllMocks()`。
 */
export const notify: Mock<(opts: NotifyOptions, duration?: number) => string> = vi.fn(
  () => `mock-notification-${++notifySeq}`
)

const notificationsValue = { notify }

/** 返回稳定引用的 `useNotifications()` 结果。 */
export function stableNotifications(): { notify: typeof notify } {
  return notificationsValue
}
