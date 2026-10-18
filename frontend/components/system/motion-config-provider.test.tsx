import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

/**
 * BLF-1361 §5：全局 reduced-motion 收口。
 *
 * 这个 provider 的全部职责就是「把 `reducedMotion="user"` 交给 framer-motion 的
 * `MotionConfig`」——所以这里断言的就是这个契约：prop 值正确、子节点原样透传。
 *
 * 不在这里复验 framer-motion 的行为（`reducedMotion="user"` 时 transform / layout
 * 动画降为瞬时是它的官方语义）。实测发现：直接拿真实的 `useReducedMotion()` 做观测点
 * 会被 framer-motion 的模块级缓存污染——`prefers-reduced-motion` 的订阅状态存在模块
 * 作用域里，`vi.resetModules()` 也清不掉，第二个用例会读到第一个用例的结果。
 * 那种写法测的是 framer 内部缓存，不是本仓库的代码，所以改成断言契约。
 */

const motionConfigProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))

vi.mock('framer-motion', () => ({
  MotionConfig: (props: Record<string, unknown>) => {
    motionConfigProps.current = props
    return <>{props.children}</>
  },
}))

describe('MotionConfigProvider', () => {
  it('把 reducedMotion="user" 交给 framer-motion 的 MotionConfig', async () => {
    const { MotionConfigProvider } = await import('./motion-config-provider')
    render(
      <MotionConfigProvider>
        <span data-testid="child" />
      </MotionConfigProvider>
    )
    expect(motionConfigProps.current?.reducedMotion).toBe('user')
  })

  it('原样透传子节点（不改变结构、不吞内容）', async () => {
    const { MotionConfigProvider } = await import('./motion-config-provider')
    render(
      <MotionConfigProvider>
        <span data-testid="child">内容</span>
      </MotionConfigProvider>
    )
    expect(screen.getByTestId('child').textContent).toBe('内容')
  })
})
