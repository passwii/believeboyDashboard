#!/usr/bin/env node
/**
 * check-unstable-mocks — 把「mock 必须返回稳定引用」这条规则从文档约定变成机器拦截（BLF-1247）。
 *
 * 背景（BLF-1238 / BLF-1246）：组件普遍把 `useSession()` 的 `data`（= `session`）和
 * `useNotifications()` 的 `notify` 放进 `useEffect` / `useCallback` 依赖数组。真实实现里这两个
 * 引用是稳定的（next-auth v5 用 `useMemo` 缓存 session value；`NotificationsProvider` 的
 * `notify` 是 `useCallback(..., [])`）。测试若在 mock 工厂里**每次调用新建**这两个引用：
 *
 *   vi.mock('next-auth/react', () => ({
 *     useSession: () => ({ data: { user: { id: 'u1' } } }),   // ← 每次渲染新对象
 *   }))
 *   vi.mock('@/components/notifications', () => ({
 *     useNotifications: () => ({ notify: vi.fn() }),           // ← 每次渲染新函数
 *   }))
 *
 * 就会 effect 每轮重跑 → 无条件 `setState` → 无限渲染 → 微任务链饿死计时器 →
 * 该文件永不收敛、整轮 vitest 挂死（`--testTimeout` 都救不了，见 TESTING.md）。
 *
 * 本脚本扫描 `frontend/**\/*.test.{ts,tsx}`，命中即 exit 1（默认只查这两类内联字面量，
 * 判据收窄到不会误报；放宽正则会逼人绕过检查）。
 *
 * 命中的修法：改用 `@/test-utils/stable-mocks` 的 `stableSession()` / `stableNotifications()`
 * （同一入参返回同一引用），或在模块级用 `vi.hoisted` 定义常量再在工厂里引用。
 *
 * 用法：
 *   node scripts/check-unstable-mocks.mjs              # 人类可读输出，命中 exit 1
 *   node scripts/check-unstable-mocks.mjs --json       # 机读输出（CI / 工具链）
 *   node scripts/check-unstable-mocks.mjs --root <dir> # 换扫描根（默认 frontend/）
 *   node --test scripts/check-unstable-mocks.test.mjs  # 判据自测（正例 + 反例）
 *
 * 退出码：0 = 0 命中；1 = 有命中；2 = 用法 / 读文件出错。
 *
 * 设计约束（对齐 backend/scripts/check_alembic.py 的屋风）：
 *  - **只用 node: 内置模块**，不引第三方解析器（也因此在 `pnpm install` 之前就能跑）；
 *  - 所以自带一个「够用就好」的遮蔽器：把注释 / 字符串 / 模板字面量 / 正则字面量换成空格
 *    （保留长度与换行，便于回溯行列号），只对剩下的代码做结构化匹配；
 *  - 判据由 `check-unstable-mocks.test.mjs` 用已知正例 / 反例钉住，改脚本改坏会红。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const FRONTEND_ROOT = resolve(SCRIPT_DIR, '..')

/** 扫描时跳过的目录（node_modules 是 pnpm 的符号链接农场，进去会爆）。 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  '.turbo',
  '.vercel',
  'coverage',
  'dist',
  'out',
  'playwright-report',
  'test-results',
])

/** 只扫这两类文件：覆盖面足够，且不会误伤 helper / 脚本自身。 */
const TEST_FILE_RE = /\.test\.tsx?$/

/**
 * 两条判据。`prop` 是工厂返回对象里的关键引用，`valueIsUnstable` 判定该值是否
 * 「每次调用都新建」，`fix` 是修法提示。
 */
const HOOK_RULES = {
  useSession: {
    prop: 'data',
    kind: 'session-data-literal',
    what: 'useSession 的 data 是内联对象 / 数组字面量',
    fix: '改用 @/test-utils/stable-mocks 的 stableSession({...})（同一入参返回同一引用），或在模块级 vi.hoisted 定义常量后引用',
    valueIsUnstable: (value) => value.startsWith('{') || value.startsWith('['),
  },
  useNotifications: {
    prop: 'notify',
    kind: 'notify-inline-fn',
    what: 'useNotifications 的 notify 是内联新建的函数引用',
    fix: '改用 @/test-utils/stable-mocks 的 stableNotifications()（notify 为模块级单例），或在模块级 vi.hoisted 定义常量后引用',
    valueIsUnstable: (value) => INLINE_FN_RE.test(value),
  },
}

/** `vi.fn()` / `vi.fn<...>()` / `vi.spyOn(...)` / 内联箭头 / 内联 function —— 都是每次调用新建。 */
const INLINE_FN_RE =
  /^(?:(?:vi|vitest)\s*\.\s*(?:fn|spyOn)\s*[<(]|(?:async\s+)?function\b|(?:async\s+)?\([^()]*\)\s*=>|(?:async\s+)?[A-Za-z_$][\w$]*\s*=>)/

/** 上一个有效字符属于这些之一时，`/` 只可能是正则字面量的开始（而非除号）。 */
const REGEX_PREFIX_CHARS = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  ';',
  '+',
  '-',
  '*',
  '%',
  '^',
  '~',
  '{',
  '>',
])

/** 同理：`return /re/`、`case /re/` 这类靠关键字判断。 */
const REGEX_PREFIX_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
])

const OPENERS = { '(': ')', '[': ']', '{': '}' }

/**
 * 把注释 / 字符串 / 模板字面量 / 正则字面量的内容换成空格（保留长度与换行）。
 *
 * 目的只有一个：让后面的结构化匹配不必和 JSX、正则、模板串里的括号 / 冒号打架。
 * 单双引号字符串遇到换行即视为结束——JS 字符串本来就不能跨行，这样 JSX 文本里的
 * 裸撇号（`<p>It's ok</p>`）最多污染本行，不会吞掉后面的代码。
 */
export function maskNonCode(source) {
  const chars = source.split('')
  const len = source.length

  const maskRange = (from, to) => {
    for (let k = from; k < to && k < len; k++) if (chars[k] !== '\n') chars[k] = ' '
  }

  const skipQuoted = (start) => {
    const quote = source[start]
    let k = start + 1
    while (k < len) {
      const c = source[k]
      if (c === '\\') {
        k += 2
        continue
      }
      if (c === quote) {
        maskRange(start + 1, k)
        return k + 1
      }
      if (c === '\n') {
        maskRange(start + 1, k)
        return k
      }
      k += 1
    }
    maskRange(start + 1, len)
    return len
  }

  // 只用于模板字面量的 ${...}：找到与之配对的 `}`（跳过内部字符串 / 模板 / 嵌套括号）。
  const skipBracedExpression = (start) => {
    let depth = 0
    let k = start
    while (k < len) {
      const c = source[k]
      if (c === '\\') {
        k += 2
        continue
      }
      if (c === "'" || c === '"') {
        k = skipQuoted(k)
        continue
      }
      if (c === '`') {
        k = skipTemplate(k)
        continue
      }
      if (c === '{') {
        depth += 1
        k += 1
        continue
      }
      if (c === '}') {
        depth -= 1
        k += 1
        if (depth === 0) return k
        continue
      }
      k += 1
    }
    return len
  }

  const skipTemplate = (start) => {
    let k = start + 1
    while (k < len) {
      const c = source[k]
      if (c === '\\') {
        k += 2
        continue
      }
      if (c === '`') {
        maskRange(start + 1, k)
        return k + 1
      }
      if (c === '$' && source[k + 1] === '{') {
        k = skipBracedExpression(k + 1)
        continue
      }
      k += 1
    }
    maskRange(start + 1, len)
    return len
  }

  // 返回 -1 表示「看着像正则其实不是」——正则字面量不能跨行，撞到换行就认输。
  const skipRegex = (start) => {
    let k = start + 1
    let inClass = false
    while (k < len) {
      const c = source[k]
      if (c === '\\') {
        k += 2
        continue
      }
      if (c === '\n') return -1
      if (inClass) {
        if (c === ']') inClass = false
        k += 1
        continue
      }
      if (c === '[') {
        inClass = true
        k += 1
        continue
      }
      if (c === '/') {
        maskRange(start + 1, k)
        return k + 1
      }
      k += 1
    }
    return -1
  }

  let i = 0
  let prevSignificant = ''
  let prevWord = ''
  while (i < len) {
    const c = source[i]

    if (c === '/' && source[i + 1] === '/') {
      let k = i
      while (k < len && source[k] !== '\n') k += 1
      maskRange(i, k)
      i = k
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      let k = i + 2
      while (k < len && !(source[k] === '*' && source[k + 1] === '/')) k += 1
      const end = Math.min(k + 2, len)
      maskRange(i, end)
      i = end
      continue
    }
    if (c === "'" || c === '"') {
      i = skipQuoted(i)
      prevSignificant = c
      prevWord = ''
      continue
    }
    if (c === '`') {
      i = skipTemplate(i)
      prevSignificant = '`'
      prevWord = ''
      continue
    }
    if (
      c === '/' &&
      (REGEX_PREFIX_CHARS.has(prevSignificant) || REGEX_PREFIX_KEYWORDS.has(prevWord))
    ) {
      const end = skipRegex(i)
      if (end > 0) {
        i = end
        prevSignificant = '/'
        prevWord = ''
        continue
      }
    }

    if (!/\s/.test(c)) prevSignificant = c
    if (/[A-Za-z0-9_$]/.test(c)) prevWord += c
    else prevWord = ''
    i += 1
  }

  return chars.join('')
}

/** 从 `s[start]`（左括号）出发，返回配对右括号的下标；找不到返回 -1。 */
function matchDelimiter(s, start) {
  const open = s[start]
  const close = OPENERS[open]
  if (!close) return -1
  let depth = 0
  for (let k = start; k < s.length; k++) {
    const c = s[k]
    if (c === open) depth += 1
    else if (c === close) {
      depth -= 1
      if (depth === 0) return k
    }
  }
  return -1
}

/** 顶层是否有 `key:` 或 `...`——用来区分「对象字面量」和「函数体块」。 */
function hasTopLevelProperty(inner) {
  let depth = 0
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k]
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') depth -= 1
    else if (depth === 0 && c === ':') return true
    else if (depth === 0 && c === '.' && inner.startsWith('...', k)) return true
  }
  return false
}

/**
 * 从箭头函数体起点取出「工厂返回的那个对象字面量」的内容区间。
 * 支持 `() => ({...})`（主流写法）与 `() => ({...} as const)`；`() => MOCK` /
 * `() => stableSession()` / `() => ({...})` 之外的东西一律返回 null（不判命中）。
 */
function extractFactoryObject(masked, bodyStart) {
  const c = masked[bodyStart]
  if (c === '(') {
    const close = matchDelimiter(masked, bodyStart)
    if (close < 0) return null
    let k = bodyStart + 1
    while (k < close && /\s/.test(masked[k])) k += 1
    if (masked[k] !== '{') return null
    const objClose = matchDelimiter(masked, k)
    if (objClose < 0 || objClose > close) return null
    const rest = masked.slice(objClose + 1, close).trim()
    if (rest !== '' && !/^(as|satisfies)\b/.test(rest)) return null
    return { contentStart: k + 1, contentEnd: objClose }
  }
  if (c === '{') {
    const close = matchDelimiter(masked, bodyStart)
    if (close < 0) return null
    const inner = masked.slice(bodyStart + 1, close)
    if (!hasTopLevelProperty(inner)) return null
    return { contentStart: bodyStart + 1, contentEnd: close }
  }
  return null
}

/** 按顶层逗号切分对象字面量内容，返回每段的 [start, end) 区间（相对 content）。 */
function splitTopLevel(content) {
  const parts = []
  let depth = 0
  let start = 0
  for (let k = 0; k < content.length; k++) {
    const c = content[k]
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') depth -= 1
    else if (c === ',' && depth === 0) {
      parts.push([start, k])
      start = k + 1
    }
  }
  parts.push([start, content.length])
  return parts
}

const PROP_KEY_RE = /^\s*([A-Za-z_$][\w$]*)\s*:/

function lineOf(source, offset) {
  let line = 1
  for (let k = 0; k < offset && k < source.length; k++) if (source[k] === '\n') line += 1
  return line
}

function columnOf(source, offset) {
  const nl = source.lastIndexOf('\n', offset - 1)
  return offset - nl
}

function snippetOf(source, line) {
  const text = source.split('\n')[line - 1] ?? ''
  const trimmed = text.trim()
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed
}

/**
 * 在源码里找出所有「mock 工厂内联新建关键引用」的位置。
 *
 * 判据（不命中即不报，宁可漏也不误报——误报会逼人绕过检查）：
 *  命中：`useSession: () => ({ data: { … } | [ … ] })`、`useNotifications: () => ({ notify: vi.fn() })`
 *  不命中：`data: null`、`data: SOME_MODULE_CONST`、`data: mockUseSession()`（复用同一对象）、
 *          `notify: mockNotify`、`notify`（简写）、`() => stableSession({...})`、注释 / 字符串里的样例。
 *
 * @returns {{line:number, column:number, hook:string, prop:string, kind:string, snippet:string}[]}
 */
export function findUnstableMocks(source) {
  const masked = maskNonCode(source)
  const hits = []

  for (const [hook, rule] of Object.entries(HOOK_RULES)) {
    // 前面不能是标识符字符或 `.`，避免把 `myUseSession:` / `obj.useSession:` 当成 mock 键。
    const keyRe = new RegExp(`(^|[^\\w$.])${hook}\\s*:`, 'g')
    let m
    while ((m = keyRe.exec(masked)) !== null) {
      let i = m.index + m[0].length
      while (i < masked.length && /\s/.test(masked[i])) i += 1
      if (masked[i] !== '(') continue // `useSession: mockUseSession` 之类，不是工厂
      const paramClose = matchDelimiter(masked, i)
      if (paramClose < 0) continue
      let j = paramClose + 1
      while (j < masked.length && /\s/.test(masked[j])) j += 1
      if (masked[j] !== '=' || masked[j + 1] !== '>') continue // 不是箭头函数
      let bodyStart = j + 2
      while (bodyStart < masked.length && /\s/.test(masked[bodyStart])) bodyStart += 1

      const obj = extractFactoryObject(masked, bodyStart)
      if (!obj) continue
      const content = masked.slice(obj.contentStart, obj.contentEnd)

      for (const [a, b] of splitTopLevel(content)) {
        const chunk = content.slice(a, b)
        const propMatch = PROP_KEY_RE.exec(chunk)
        if (!propMatch) continue // 简写属性 / `...spread` / 方法，都不是内联字面量
        if (propMatch[1] !== rule.prop) continue
        const value = chunk.slice(propMatch[0].length).trim()
        if (!rule.valueIsUnstable(value)) continue

        const propKeyOffset = obj.contentStart + a + propMatch[0].indexOf(propMatch[1])
        const line = lineOf(source, propKeyOffset)
        hits.push({
          line,
          column: columnOf(source, propKeyOffset),
          hook,
          prop: rule.prop,
          kind: rule.kind,
          snippet: snippetOf(source, line),
        })
      }
    }
  }

  hits.sort((x, y) => x.line - y.line || x.column - y.column)
  return hits
}

/** 是否是本检查要扫的测试文件（纯函数，便于自测）。 */
export function isTestFile(relPath) {
  const parts = relPath.split(/[\\/]/)
  if (parts.some((p) => SKIP_DIRS.has(p))) return false
  return TEST_FILE_RE.test(parts[parts.length - 1] ?? '')
}

/** 递归收集扫描根下的测试文件（相对扫描根的路径，稳定排序）。 */
export function collectTestFiles(root) {
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name))
      } else if (entry.isFile()) {
        const rel = relative(root, join(dir, entry.name))
        if (isTestFile(rel)) found.push(rel)
      }
    }
  }
  walk(root)
  return found.sort()
}

/** 扫描一个根目录，返回 { root, filesScanned, hits }。 */
export function scanRoot(root = FRONTEND_ROOT) {
  const files = collectTestFiles(root)
  const hits = []
  for (const rel of files) {
    const source = readFileSync(join(root, rel), 'utf8')
    for (const hit of findUnstableMocks(source)) hits.push({ file: rel, ...hit })
  }
  return { root, filesScanned: files.length, hits }
}

const HELP = `check-unstable-mocks — mock 稳定性机械检查（BLF-1247）

扫描 frontend/**/*.test.{ts,tsx}，拦截 mock 工厂里内联新建关键引用的写法
（useSession 的 data 对象字面量 / useNotifications 的 notify: vi.fn()）——
它们是 BLF-1238「全量 vitest 不收敛」的原料。

用法：
  node scripts/check-unstable-mocks.mjs [--json] [--root <dir>]

退出码：0 = 0 命中；1 = 有命中；2 = 用法 / 读文件出错。
修法见 TESTING.md §mock 稳定性，helper 在 frontend/test-utils/stable-mocks.ts。
`

function main(argv) {
  let json = false
  let root = FRONTEND_ROOT

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') json = true
    else if (arg === '--root') {
      root = resolve(argv[i + 1] ?? '')
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(HELP)
      return 0
    } else {
      process.stderr.write(`[check-unstable-mocks] 未知参数：${arg}\n\n${HELP}`)
      return 2
    }
  }

  let result
  try {
    result = scanRoot(root)
  } catch (err) {
    process.stderr.write(`[check-unstable-mocks] 读取 ${root} 失败：${err?.message ?? err}\n`)
    return 2
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.hits.length === 0,
          root: result.root,
          filesScanned: result.filesScanned,
          hitCount: result.hits.length,
          hits: result.hits,
        },
        null,
        2
      )}\n`
    )
  } else if (result.hits.length === 0) {
    process.stdout.write(
      `[check-unstable-mocks] 扫描 ${result.filesScanned} 个测试文件，0 命中 ✅\n`
    )
  } else {
    const lines = [
      `[check-unstable-mocks] 扫描 ${result.filesScanned} 个测试文件，${result.hits.length} 命中 ❌`,
      '',
    ]
    for (const hit of result.hits) {
      const rule = HOOK_RULES[hit.hook]
      lines.push(`${hit.file}:${hit.line}:${hit.column}  ${rule.what}`)
      lines.push(`    ${hit.line} | ${hit.snippet}`)
      lines.push(`  修法：${rule.fix}`)
      lines.push('')
    }
    lines.push(
      '为什么必须修：内联新建 → 组件 effect 依赖每轮抖动 → 无条件 setState → 无限渲染 →',
      '微任务链饿死计时器 → 该文件永不收敛、整轮 vitest 挂死（BLF-1238）。'
    )
    process.stdout.write(`${lines.join('\n')}\n`)
  }

  return result.hits.length === 0 ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)))
}
