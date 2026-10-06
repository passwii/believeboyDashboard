/**
 * `check-unstable-mocks` 判据自测（BLF-1247）。
 *
 * 这个脚本存在的唯一理由是「拦截内联新建引用，且**不误报**」——误报会逼人绕过检查
 * （往脚本里塞白名单），误漏则让 BLF-1238 的无限渲染挂死重新长回来。所以把两类判据
 * 都用已知正例 / 反例钉在这里：以后有人改脚本改坏了，这里先红。
 *
 * 反例大多是从 main 上真实存在的写法里抄下来的（模块级常量 / `vi.hoisted` /
 * `mockUseSession()` / `notify` 简写），不是凭空构造的。
 *
 * 跑法：`node --test scripts/check-unstable-mocks.test.mjs`（`pnpm check:mocks` 会带上）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { findUnstableMocks, isTestFile, maskNonCode } from './check-unstable-mocks.mjs'

/** 断言：这段源码应当命中（可选校验命中的 hook / prop / 行号）。 */
function assertHit(source, expected = {}) {
  const hits = findUnstableMocks(source)
  assert.ok(hits.length > 0, `期望命中，实际 0 命中：\n${source}`)
  if (expected.hook) assert.equal(hits[0].hook, expected.hook)
  if (expected.prop) assert.equal(hits[0].prop, expected.prop)
  if (expected.line) assert.equal(hits[0].line, expected.line)
  return hits
}

/** 断言：这段源码不应当命中。 */
function assertClean(source) {
  const hits = findUnstableMocks(source)
  assert.equal(
    hits.length,
    0,
    `期望 0 命中，实际 ${hits.length} 命中：${JSON.stringify(hits, null, 2)}\n${source}`
  )
}

describe('正例：内联新建关键引用必须命中', () => {
  it('useSession 工厂里内联 data 对象字面量（单行）', () => {
    assertHit(
      `vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'u1' } }, status: 'authenticated' }),
}))`,
      { hook: 'useSession', prop: 'data', line: 2 }
    )
  })

  it('useSession 工厂里内联 data 对象字面量（多行）', () => {
    const hits = assertHit(
      `vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: {
      user: { name: '测试用户' },
    },
    status: 'authenticated' as const,
  }),
}))`,
      { hook: 'useSession', prop: 'data' }
    )
    assert.equal(hits[0].line, 3)
  })

  it('useSession 工厂里 data 是内联数组字面量', () => {
    assertHit(`const m = { useSession: () => ({ data: [{ id: 1 }], status: 'authenticated' }) }`, {
      hook: 'useSession',
    })
  })

  it('useSession 工厂里 data 是内联字面量 + spread', () => {
    assertHit(`useSession: () => ({ ...base, data: { ...SESSION, roleType: 'admin' } })`, {
      hook: 'useSession',
    })
  })

  it('useSession 工厂里 data 内联字面量带 as 断言', () => {
    assertHit(`useSession: () => ({ data: { user: null } } as unknown as SessionValue)`, {
      hook: 'useSession',
    })
  })

  it('useNotifications 工厂里 notify 内联 vi.fn()', () => {
    assertHit(
      `vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: vi.fn() }),
}))`,
      { hook: 'useNotifications', prop: 'notify', line: 2 }
    )
  })

  it('useNotifications 工厂里 notify 内联 vi.fn()（多行 + 其它属性）', () => {
    assertHit(
      `vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({
    notify: vi.fn(),
    dismissToast: () => {},
  }),
}))`,
      { hook: 'useNotifications', prop: 'notify' }
    )
  })

  it('notify 内联 vi.fn(实现) / vi.fn().mockReturnValue(...)', () => {
    assertHit(`useNotifications: () => ({ notify: vi.fn(() => 'id') })`)
    assertHit(`useNotifications: () => ({ notify: vi.fn().mockReturnValue('id') })`)
    assertHit(`useNotifications: () => ({ notify: vi.fn<(o: unknown) => string>() })`)
  })

  it('notify 内联箭头 / function 表达式', () => {
    assertHit(`useNotifications: () => ({ notify: () => {} })`)
    assertHit(`useNotifications: () => ({ notify: (opts) => String(opts) })`)
    assertHit(`useNotifications: () => ({ notify: async () => {} })`)
    assertHit(`useNotifications: () => ({ notify: function () {} })`)
  })

  it('vi.hoisted 里展开再内联新建（crm 风格）', () => {
    assertHit(
      `vi.mock('@/components/notifications', async (importOriginal) => {
  const a = await importOriginal()
  return { ...a, useNotifications: () => ({ notify: vi.fn() }) }
})`,
      { hook: 'useNotifications' }
    )
  })

  it('一个工厂同时命中两条判据时分别报告', () => {
    const hits = findUnstableMocks(
      `useSession: () => ({ data: { user: null } })
useNotifications: () => ({ notify: vi.fn() })`
    )
    assert.deepEqual(
      hits.map((h) => h.kind),
      ['session-data-literal', 'notify-inline-fn']
    )
  })

  it('行号精确指向属性键所在行（不是工厂起点）', () => {
    const source = `// 头部注释
import { vi } from 'vitest'

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    status: 'authenticated',
    data: { user: { id: 'u1' } },
  }),
}))`
    const hits = findUnstableMocks(source)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].line, 7)
  })
})

describe('反例：稳定写法一律不命中（误报代价高）', () => {
  it('data: null', () => {
    assertClean(`useSession: () => ({ data: null, status: 'unauthenticated' })`)
  })

  it('data 是模块级常量 / vi.hoisted 常量', () => {
    assertClean(`useSession: () => ({ data: SESSION_DATA, status: 'authenticated' })`)
    assertClean(
      `const { stableSession } = vi.hoisted(() => ({ stableSession: { user: { id: 'u1' } } }))
useSession: () => ({
  data: stableSession,
  status: 'authenticated' as const,
})`
    )
  })

  it('data 是复用同一对象的调用（mockUseSession / stableSession）', () => {
    assertClean(`useSession: () => mockUseSession()`)
    assertClean(`useSession: () => ({ data: mockUseSession() })`)
    assertClean(`useSession: () => stableSession({ user: { isAdmin: true } })`)
  })

  it('useSession 直接给常量 / 不是箭头工厂', () => {
    assertClean(`useSession: mockUseSession`)
    assertClean(`useSession: () => SESSION`)
    assertClean(`useSession: () => MOCK_SESSION`)
    assertClean(`useSession: () => sessionState`)
    assertClean(`useSession: () => session`)
  })

  it('notify 是模块级常量 / 简写 / helper', () => {
    assertClean(`useNotifications: () => ({ notify })`)
    assertClean(`useNotifications: () => ({ notify: mockNotify })`)
    assertClean(`useNotifications: () => ({ notify: notifyMock })`)
    assertClean(`useNotifications: () => ({ notify: NOTIFY })`)
    assertClean(`useNotifications: () => NOTIFY`)
    assertClean(`useNotifications: () => stableNotifications()`)
    assertClean(`useNotifications: () => ({ notify: stableNotifications().notify })`)
  })

  it('notification-toast 真实写法：toasts 内联但 notify 是模块级常量', () => {
    assertClean(
      `const { notify, dismissToast } = vi.hoisted(() => ({ notify: vi.fn(), dismissToast: vi.fn() }))
vi.mock('./notifications-context', () => ({
  useNotifications: () => ({
    toasts: [
      { id: 't1', type: 'warning', title: '任务即将到期', onClick: () => notify('clicked') },
      { id: 't2', type: 'info', title: '普通通知' },
    ],
    notify,
    dismissToast,
  }),
}))`
    )
  })

  it('注释里的反例不算命中', () => {
    assertClean(`// 反例：useSession: () => ({ data: { user: {} } }) 不要这么写
/* useNotifications: () => ({ notify: vi.fn() }) */
const ok = 1`)
  })

  it('字符串 / 模板字面量里的反例不算命中', () => {
    assertClean(`const doc = 'useSession: () => ({ data: { a: 1 } })'`)
    assertClean('const doc = `useNotifications: () => ({ notify: vi.fn() })`')
    assertClean(
      `const doc = \`\${'useSession: () => ({ data: { a: 1 } })'} 且 \${{ x: 'notify: vi.fn()' }.x}\``
    )
  })

  it('前面带标识符的相似键名不算命中（避免误伤）', () => {
    assertClean(`const m = { myUseSession: () => ({ data: { a: 1 } }) }`)
    assertClean(`const m = { useSessionState: () => ({ data: { a: 1 } }) }`)
  })

  it('工厂返回的不是对象字面量（函数体 / 变量）不算命中', () => {
    assertClean(`useSession: () => {
  return makeSession()
}`)
    assertClean(`useNotifications: () => {
  const value = { notify: vi.fn() }
  return value
}`)
  })

  it('data 是调用 / 条件 / 类型断言包裹的调用不算命中', () => {
    assertClean(`useSession: () => ({ data: makeSession({ id: 1 }) })`)
    assertClean(`useSession: () => ({ data: cond ? A : B })`)
    assertClean(`useSession: () => ({ data: (mockSession as unknown) })`)
  })

  it('正则字面量里的括号 / 花括号不破坏结构（前面是稳定写法）', () => {
    assertClean(
      `it('x', () => {
  expect(s).toMatch(/^\\d{1,2}\\/\\d{1,2}$/)
  expect(v).toMatch(/^min-w-\\[\\d+px\\]$/)
  const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(v)
  const session = { useSession: () => SESSION }
})`
    )
  })

  it('JSX 文本里的裸撇号不会吞掉后面的代码', () => {
    assertClean(
      `it('x', () => {
  render(<p>It's ok / 没问题</p>)
  const a = 1
  const session = { useSession: () => SESSION }
})`
    )
  })

  it('除法不会被当成正则起点', () => {
    assertClean(
      `const ratio = (a + b) / 2
const half = total / count
const scaled = arr[0] / 100
const m = { useSession: () => SESSION, useNotifications: () => NOTIFY }`
    )
  })

  it('真实存量写法：多行工厂 + 模块级常量（stage 1 之后的形态）', () => {
    assertClean(
      `vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: stableSession,
    status: 'authenticated' as const,
  }),
}))
vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: mockNotify }),
}))`
    )
  })
})

describe('遮蔽器与文件判定', () => {
  it('遮蔽保持长度与换行（行列号可回溯）', () => {
    const source = `const a = '字符串\\n里有换行转义'\nconst b = \`模板\n多行\`\n`
    const masked = maskNonCode(source)
    assert.equal(masked.length, source.length)
    assert.equal(masked.split('\n').length, source.split('\n').length)
    assert.ok(!masked.includes('字符串'))
    assert.ok(!masked.includes('模板'))
  })

  it('只扫 .test.ts / .test.tsx，跳过 node_modules 与构建产物', () => {
    assert.equal(isTestFile('app/dashboard/page.test.tsx'), true)
    assert.equal(isTestFile('test-utils/stable-mocks.test.ts'), true)
    assert.equal(isTestFile('test-utils/stable-mocks.ts'), false)
    assert.equal(isTestFile('scripts/check-unstable-mocks.test.mjs'), false)
    assert.equal(isTestFile('node_modules/foo/bar.test.ts'), false)
    assert.equal(isTestFile('.next/types/x.test.ts'), false)
  })
})
