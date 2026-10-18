/**
 * `check-motion-tokens` 判据自测（BLF-1361）。
 *
 * 这个脚本存在的唯一理由是「拦截悬空变量 / 死配置，且**不误报**」——误报会逼人绕过检查
 * （往脚本里塞白名单，门禁等于关掉），误漏则让 #737 那类「CSS 静默失效、构建照过」的债
 * 重新长回来。所以每条判据都用已知正例 / 反例钉在这里：以后有人改脚本改坏了，这里先红。
 *
 * 反例大多是从 main 上真实存在的写法里抄下来的（next/font 的 `variable:`、内联
 * `'--i': index`、`var(--x, fallback)`、`--radix-*` 运行时变量、keyframe 与 animation
 * 同名但只有后者是配置条目），不是凭空构造的。
 *
 * 跑法：`node --test scripts/check-motion-tokens.test.mjs`（`pnpm check:motion:test` 会带上）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  collectAnimationEntries,
  collectCssVarDefs,
  collectCssVarRefs,
  collectRuntimeVarDefs,
  countOffScaleDurations,
  findUnconsumedAnimations,
  findUndefinedVars,
  maskComments,
} from './check-motion-tokens.mjs'

// ─── 遮蔽器 ──────────────────────────────────────────────────────────────────

describe('maskComments：只遮注释，保留长度与换行', () => {
  it('遮蔽块注释与行注释，行数不变', () => {
    const src = `a { /* --ghost: 1; */ color: red; } // --ghost2: 2;\nb { }`
    const masked = maskComments(src)
    assert.equal(masked.length, src.length)
    assert.equal(masked.split('\n').length, src.split('\n').length)
    assert.ok(!masked.includes('--ghost'))
  })

  it('不遮蔽字符串字面量（tailwind 配置的 key 在字符串里）', () => {
    const src = `{ 'accordion-down': 'x' }`
    assert.ok(maskComments(src).includes("'accordion-down'"))
  })

  // 字符串里的 `/*` 不是注释起号。不跳过字符串的话会一路遮到下一个块注释闭号
  // 或 EOF，把后面的真注入整段吃掉 → 门禁①误报悬空变量（假红）。
  it('字符串里的块注释起号不开启遮蔽（glob / accept="image/*" 两种写法）', () => {
    const cases = [
      `const glob = './app/**/*.{ts}'\nel.style.setProperty('--motion-x', '10ms')`,
      `const accept = 'image/*'\nel.style.setProperty('--motion-x', '10ms')`,
    ]
    for (const src of cases) {
      assert.equal(maskComments(src), src, '字符串里的起号不得引起遮蔽')
      assert.deepEqual([...collectRuntimeVarDefs(src)], ['--motion-x'])
    }
  })

  it('字符串里的行注释起号不开启遮蔽（URL 里的 //）', () => {
    const src = `const url = 'https://example.com/x'\nel.style.setProperty('--motion-x', '10ms')`
    assert.equal(maskComments(src), src)
    assert.deepEqual([...collectRuntimeVarDefs(src)], ['--motion-x'])
  })

  it('字符串里的转义引号不结束字符串', () => {
    const src = `const s = 'it\\'s /* not a comment'\nel.style.setProperty('--motion-x', '10ms')`
    assert.deepEqual([...collectRuntimeVarDefs(src)], ['--motion-x'])
  })

  it('跳过字符串不影响真注释被遮蔽', () => {
    const src = [
      `const s = 'x/*y'`,
      `/* setProperty('--ghost', '1ms') */`,
      `// setProperty('--ghost2', '1ms')`,
      `el.style.setProperty('--real', '40ms')`,
    ].join('\n')
    assert.deepEqual([...collectRuntimeVarDefs(src)], ['--real'])
  })

  // 正则字面量里的引号不是字符串起号。不先跳过正则的话，quote 分支会从那个引号
  // 一路跳到后面注释里的同引号 → 注释没被遮蔽 → 被注释掉的注入被当成真注入
  // （门禁①假阴性，正是本脚本最该抓的形状）。
  it('正则里的引号不当字符串起始引号', () => {
    const cases = [
      `const quoteMatcher = /['"]/ // el.style.setProperty('--deleted', value)`,
      `const csv = /[",\\n]/ // el.style.setProperty('--deleted', value)`,
    ]
    for (const src of cases) {
      assert.deepEqual([...collectRuntimeVarDefs(src)], [], '注释里的注入不得算定义')
    }
  })

  // 正则里的 `\/` 与 `\/\/` 也不是注释起号；不跳过正则会把其后内容误遮（假红）。
  it('正则字面量整段被跳过（含转义斜杠与字符类里的斜杠）', () => {
    const src = [
      `const url = /^https?:\\/\\//i`,
      `const cls = /bg-secondary\\//`,
      `el.style.setProperty('--motion-x', '10ms')`,
    ].join('\n')
    assert.equal(maskComments(src), src, '正则里的斜杠不得引起遮蔽')
    assert.deepEqual([...collectRuntimeVarDefs(src)], ['--motion-x'])
  })

  // 箭头函数直接返回正则（`=> /[\'"]/`）：`>` 不是分隔符，得单独认，否则又回到假阴性。
  // 同时盯住反向：`a > b / 2` 里的 `/` 是除号，不得当正则跳过。
  it('箭头函数返回的正则也被跳过，比较运算符后的除号不被当正则', () => {
    const arrow = [
      `const f = (v) => /['"]/.test(v)`,
      `// el.style.setProperty('--ghost', '1ms')`,
      `el.style.setProperty('--real', '10ms')`,
    ].join('\n')
    assert.deepEqual([...collectRuntimeVarDefs(arrow)], ['--real'])

    const division = [
      `const x = a > b / 2`,
      `// el.style.setProperty('--ghost', '1ms')`,
      `el.style.setProperty('--real', '10ms')`,
    ].join('\n')
    assert.deepEqual([...collectRuntimeVarDefs(division)], ['--real'])
  })
})

// ─── 判据 1：悬空 CSS 变量 ───────────────────────────────────────────────────

describe('正例：悬空变量必须命中', () => {
  it('引用存在、无定义、无 fallback（BLF-1361 的真回归形状）', () => {
    const css = `
      :root { --duration-quick: 150ms; }
      .x { transition-duration: var(--motion-fast) !important; }
    `
    const { hits } = findUndefinedVars(css)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].name, '--motion-fast')
    assert.equal(hits[0].line, 3)
  })

  it('定义被删掉但引用还在（迁移残留）', () => {
    const css = `:root { --a: 1ms; }\n.x { transition: color var(--b); }`
    const { hits } = findUndefinedVars(css)
    assert.deepEqual(
      hits.map((h) => h.name),
      ['--b']
    )
  })

  it('多个悬空引用全部报出（不是只报第一个）', () => {
    const css = `.x { a: var(--p); b: var(--q); }`
    assert.equal(findUndefinedVars(css).hits.length, 2)
  })

  it('注释里提到的变量不算定义（注释被遮蔽）', () => {
    const css = `/* --ghost: 1ms; */\n.x { a: var(--ghost); }`
    assert.equal(findUndefinedVars(css).hits.length, 1)
  })
})

describe('反例：以下写法不得命中（否则会逼人绕过检查）', () => {
  it('同文件有定义', () => {
    const css = `:root { --duration-quick: 150ms; }\n.x { a: var(--duration-quick); }`
    assert.equal(findUndefinedVars(css).hits.length, 0)
  })

  it('定义在别处（!important / 带空格 / 在 media 块里）', () => {
    const css = `
      @media (min-width: 1px) {
        :root { --x: 1ms !important; }
      }
      .a { b: var(--x); }
    `
    assert.equal(findUndefinedVars(css).hits.length, 0)
  })

  it('有 fallback（var(--x, 4px)）→ 安全，只进 fallbacks', () => {
    const css = `.a { width: var(--sidebar-rail-width, 68px); }`
    const result = findUndefinedVars(css)
    assert.equal(result.hits.length, 0)
    assert.equal(result.fallbacks.length, 1)
    assert.equal(result.fallbacks[0].name, '--sidebar-rail-width')
  })

  it('嵌套 fallback（var(--a, var(--b))）：外层算有兜底，内层仍是真引用', () => {
    const css = `:root { --duration-fast: 250ms; }\n.a { transition: width var(--subnav-duration, var(--duration-fast)) linear; }`
    const result = findUndefinedVars(css)
    assert.equal(result.hits.length, 0, '内层 --duration-fast 已定义，外层有兜底 → 全部安全')
    assert.deepEqual(
      result.fallbacks.map((f) => f.name),
      ['--subnav-duration']
    )
  })

  it('嵌套 fallback 的内层变量无定义时仍要报（兜底不能吞掉真引用）', () => {
    const css = `.a { transition: width var(--subnav-duration, var(--ghost)) linear; }`
    const result = findUndefinedVars(css)
    assert.deepEqual(
      result.hits.map((h) => h.name),
      ['--ghost']
    )
  })

  it('第三方运行时命名空间 --radix-* / --tw-* 不报', () => {
    const css = `.a { transform-origin: var(--radix-popper-transform-origin, center top); }`
    assert.equal(findUndefinedVars(css).hits.length, 0)
    const css2 = `.b { color: var(--tw-ring-color); }`
    assert.equal(findUndefinedVars(css2).hits.length, 0)
  })

  it('运行时注入的变量（next/font 的 variable:）算已定义', () => {
    const css = `.a { font-family: var(--font-sans), sans-serif; }`
    assert.equal(findUndefinedVars(css).hits.length, 1, '没有注入信息时应当命中')
    const runtimeDefined = new Set(['--font-sans'])
    assert.equal(findUndefinedVars(css, { runtimeDefined }).hits.length, 0)
  })

  it('运行时注入的变量（内联样式 --i）算已定义', () => {
    const css = `.u-stagger-item { animation-delay: calc(var(--i, 0) * 40ms); }`
    // 这条本身就有 fallback，但即便没有也应当被运行时注入认掉
    const runtimeDefined = new Set(['--i'])
    assert.equal(findUndefinedVars(css, { runtimeDefined }).hits.length, 0)
  })
})

describe('collectCssVarDefs / collectCssVarRefs 基本正确性', () => {
  it('定义里不会被当成引用，引用里不会被当成定义', () => {
    const css = `:root { --a: 1ms; }\n.x { transition: color var(--a); }`
    assert.deepEqual([...collectCssVarDefs(css)], ['--a'])
    assert.deepEqual(
      collectCssVarRefs(css).map((r) => r.name),
      ['--a']
    )
  })

  it('同一变量多次引用全部收集', () => {
    const css = `.a { x: var(--a); }\n.b { y: var(--a); }`
    assert.equal(collectCssVarRefs(css).length, 2)
  })
})

describe('collectRuntimeVarDefs：认三种运行时注入写法', () => {
  it("next/font 的 variable: '--font-sans'", () => {
    const src = `const manrope = localFont({ variable: '--font-sans' })`
    assert.deepEqual([...collectRuntimeVarDefs(src)], ['--font-sans'])
  })

  it("内联样式对象 '--i': index", () => {
    const src = `<div style={{ '--i': index } as CSSProperties} />`
    assert.deepEqual([...collectRuntimeVarDefs(src)], ['--i'])
  })

  it("setProperty('--x', …)", () => {
    const src = `el.style.setProperty('--subnav-delay', '40ms')`
    assert.deepEqual([...collectRuntimeVarDefs(src)], ['--subnav-delay'])
  })

  it('引用（var(--x)）不算定义', () => {
    const src = `const s = 'var(--ghost)'`
    assert.equal(collectRuntimeVarDefs(src).size, 0)
  })

  // 反例：被注释掉的注入不是注入。真实回归形状是「真注入删了、只剩一行注释」，
  // 不遮蔽注释就会误判成已定义 → 门禁①静默放行。
  it('注释里的注入不算定义（行注释 / 块注释 / JSDoc 三种写法）', () => {
    const src = [
      `// el.style.setProperty('--motion-x', '10ms')`,
      `/* <div style={{ '--motion-y': index }} /> */`,
      `/** localFont({ variable: '--motion-z' }) */`,
      `const real = 1`,
    ].join('\n')
    assert.deepEqual([...collectRuntimeVarDefs(src)], [])
  })

  it('注释遮蔽后不影响同一文件里真实的注入', () => {
    const src = `// setProperty('--ghost', '1ms')\nel.style.setProperty('--subnav-delay', '40ms')`
    assert.deepEqual([...collectRuntimeVarDefs(src)], ['--subnav-delay'])
  })
})

// ─── 判据 1 与运行时注入的交叉：注释不能洗白悬空引用 ────────────────────────

describe('注释里的注入不能洗白悬空引用', () => {
  it('真注入只剩注释时，引用仍必须命中', () => {
    const css = `.x { transition-duration: var(--motion-x); }`
    const source = `// el.style.setProperty('--motion-x', '10ms')`
    const { hits } = findUndefinedVars(css, { runtimeDefined: collectRuntimeVarDefs(source) })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].name, '--motion-x')
  })
})

// ─── 判据 2：零消费 animation 配置 ───────────────────────────────────────────

const CONFIG_WITH_TWO = `const config = {
  theme: {
    extend: {
      keyframes: {
        'accordion-down': { from: { height: '0' } },
        'switch-snap': { '0%': { transform: 'none' } },
      },
      animation: {
        'accordion-down': 'accordion-down 250ms',
        'switch-snap': 'switch-snap 280ms ease-out',
      },
    },
  },
}`

describe('正例：零消费 animation 条目必须命中', () => {
  it('配置了但全仓无 animate-<name>', () => {
    const entries = collectAnimationEntries(CONFIG_WITH_TWO)
    assert.deepEqual(
      entries.map((e) => e.name),
      ['accordion-down', 'switch-snap']
    )
    const hits = findUnconsumedAnimations(entries, [
      { file: 'components/ui/accordion.tsx', text: `className="animate-accordion-down"` },
    ])
    assert.deepEqual(
      hits.map((h) => h.name),
      ['switch-snap']
    )
  })

  it('只配置 keyframes、没配 animation → 不算 animation 条目（不误报）', () => {
    const entries = collectAnimationEntries(`theme: { extend: { keyframes: { 'x': {} } } }`)
    assert.equal(entries.length, 0)
  })

  it('行号指向 animation 条目所在行', () => {
    const entries = collectAnimationEntries(CONFIG_WITH_TWO)
    const snap = entries.find((e) => e.name === 'switch-snap')
    assert.equal(CONFIG_WITH_TWO.split('\n')[snap.line - 1].trim(), `'switch-snap': 'switch-snap 280ms ease-out',`)
  })
})

describe('反例：有消费点的 animation 不得命中', () => {
  it('消费点在 CSS（.animate-shimmer）', () => {
    const entries = collectAnimationEntries(`animation: { shimmer: 'shimmer 1s' }`)
    const hits = findUnconsumedAnimations(entries, [
      { file: 'app/globals.css', text: `.animate-shimmer { animation: shimmer 1s; }` },
    ])
    assert.equal(hits.length, 0)
  })

  it('消费点在 TSX className', () => {
    const entries = collectAnimationEntries(`animation: { 'fade-in-up': 'x 1s' }`)
    const hits = findUnconsumedAnimations(entries, [
      { file: 'a.tsx', text: `<div className="animate-fade-in-up" />` },
    ])
    assert.equal(hits.length, 0)
  })

  it('前缀相同的更长类名不算消费（animate-x 不被 animate-x-slow 认领）', () => {
    const entries = collectAnimationEntries(`animation: { x: 'x 1s' }`)
    const hits = findUnconsumedAnimations(entries, [
      { file: 'a.tsx', text: `<div className="animate-x-slow" />` },
    ])
    assert.equal(hits.length, 1)
  })

  it('注释里提到的不算消费（避免用注释糊弄门禁）', () => {
    const entries = collectAnimationEntries(`animation: { ghost: 'g 1s' }`)
    // 这里消费者文本原样传入（脚本本身不遮蔽消费者源码——注释里写 animate-ghost
    // 会被当成消费点，属已知取舍：宁可漏报也不因遮蔽过度而误报）。
    const hits = findUnconsumedAnimations(entries, [{ file: 'a.tsx', text: `// animate-ghost` }])
    assert.equal(hits.length, 0)
  })
})

// ─── 仅报告：off-scale 时长 ─────────────────────────────────────────────────

describe('countOffScaleDurations：只计数，不判失败', () => {
  it('统计 off-scale 字面量并标记交互行', () => {
    const result = countOffScaleDurations([
      {
        file: 'a.tsx',
        text: [
          `<div className="transition-colors duration-200 hover:bg-x" />`,
          `<div className="transition-opacity duration-300" />`,
        ].join('\n'),
      },
    ])
    assert.equal(result.counts[200], 1)
    assert.equal(result.counts[300], 1)
    assert.equal(result.hits.filter((h) => h.interaction).length, 1)
  })

  it('已在尺度上的 duration-150 / duration-500 不报', () => {
    const result = countOffScaleDurations([
      { file: 'a.tsx', text: `<div className="duration-150 duration-500" />` },
    ])
    assert.equal(result.hits.length, 0)
  })

  it('token 形式的 duration-[var(--duration-quick)] 不报', () => {
    const result = countOffScaleDurations([
      { file: 'a.tsx', text: `<div className="duration-[var(--duration-quick)]" />` },
    ])
    assert.equal(result.hits.length, 0)
  })

  it('数字前缀相同的更长类名不误算（duration-2000）', () => {
    const result = countOffScaleDurations([{ file: 'a.tsx', text: `duration-2000` }])
    assert.equal(result.hits.length, 0)
  })
})
