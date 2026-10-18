#!/usr/bin/env node
/**
 * check-motion-tokens — 把「动效文档说的和代码做的不一致」从约定变成机器拦截（BLF-1361）。
 *
 * 背景（BLF-1359 / #737 transitions.dev 全量迁移）：那次迁移的主要债不是「漏了某个动效」，
 * 而是**悬空变量 / 死配置 / 零消费工具类**——`transition-duration: var(--motion-fast)`
 * 引用了已被删掉的自研 token（无 fallback → 整条声明 invalid at computed-value time →
 * 静默失效），`tailwind.config.ts` 里堆着 4 个零消费的 animation 条目。这类问题的共同点是
 * **没有任何测试会红**：CSS 不会报错，TS 不认识 CSS 变量，构建照过。
 *
 * 所以判据必须机械化，参照 `check-unstable-mocks.mjs`（BLF-1247）的屋风。
 *
 * ## 硬门禁（命中即 exit 1）
 *
 * 1. **悬空 CSS 变量**：`app/globals.css` 里每个 `var(--x)` 都必须有定义。
 *    - 定义来源有两处：CSS 文件里的 `--x: …` 声明，以及**运行时注入**
 *      （next/font 的 `variable: '--font-sans'`、内联样式 `'--i': index`、
 *      `setProperty('--x', …)`）——脚本会扫 `.ts/.tsx` 把这些认成已定义。
 *    - `var(--x, fallback)` 视为安全（有兜底），只在 `--json` 的 `fallbacks` 里报告。
 *    - 第三方运行时命名空间（`--radix-*` / `--tw-*`）按前缀排除。
 *
 * 2. **零消费 animation 配置**：`tailwind.config.ts` 的每个 `animation` 条目必须有
 *    `animate-<name>` 消费点。删掉配置不算修法，**加消费点或删配置**才算。
 *
 * ## 仅报告（不计入失败）
 *
 * 3. **off-scale 字面量时长**：`duration-200` / `duration-300` / `duration-700` / `duration-75`
 *    这类不在 transitions.dev 7 档尺度上的 Tailwind 字面量，按类计数 + 清单。
 *    给 `transitions-polish` 的「按 usage 匹配、不按数值就近」提供基线，**不做自动改写**——
 *    用途与任何 token 都不匹配的应当保持原样。
 *
 * 用法：
 *   node scripts/check-motion-tokens.mjs                # 人类可读输出
 *   node scripts/check-motion-tokens.mjs --json         # 机读输出
 *   node scripts/check-motion-tokens.mjs --root <dir>   # 换扫描根（默认 frontend/）
 *   node --test scripts/check-motion-tokens.test.mjs    # 判据自测（正例 + 反例）
 *
 * 退出码：0 = 无命中；1 = 有命中；2 = 用法 / 读文件出错。
 *
 * 设计约束（对齐 `check-unstable-mocks.mjs` / `backend/scripts/check_alembic.py`）：
 *  - **只用 `node:` 内置模块**，不引第三方解析器（因此 `pnpm install` 之前也能跑）；
 *  - 自带遮蔽器（注释 / 字符串）保留长度与换行，便于回溯行列号；
 *  - 判据由 `check-motion-tokens.test.mjs` 用已知正例 / 反例钉住，改脚本改坏会先红。
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

/**
 * 第三方运行时命名空间：由 Radix / Tailwind 自己在运行时往元素上写，
 * 仓库里本来就不该有定义。**只加真正第三方的前缀**——把项目自有 token
 * 塞进来就等于把门禁关掉。
 */
const THIRD_PARTY_VAR_PREFIXES = ['--radix-', '--tw-']

/** transitions.dev 的 7 档时长（ms）。落在尺度上的字面量不报告。 */
const ON_SCALE_MS = new Set([40, 80, 150, 250, 350, 400, 500])

/** 只统计这些「明显 off-scale」的 Tailwind 时长类，避免把 `duration-[var(--x)]` 误算。 */
const OFF_SCALE_DURATION_CLASSES = [75, 200, 300, 700, 1000]

// ─────────────────────────────────────────────────────────────────────────────
// 遮蔽器
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把 CSS / TS 注释的内容换成空格（保留长度与换行）。
 *
 * 只遮蔽注释，**不动字符串**：CSS 里的 token 名本来就在声明里（不在字符串里），
 * 而 `tailwind.config.ts` 的 keyframe / animation 名恰恰是**字符串字面量**
 * （`'accordion-down': …`），遮蔽掉就解析不出来了。
 *
 * 字符串是**跳过**而非遮蔽：不跳过的话，字符串里的块注释起号会被当成真注释开头，
 * 一路遮到下一个块注释闭号或 EOF，把后面的真注入整段吃掉 → 门禁①误报。
 *
 * 正则字面量同样是**跳过**（正则里的引号不是字符串起号、`\/` 不是注释起号）。
 */
export function maskComments(source) {
  const chars = source.split('')
  const len = source.length

  const maskRange = (from, to) => {
    for (let k = from; k < to && k < len; k++) if (chars[k] !== '\n') chars[k] = ' '
  }

  let i = 0

  // 跳过字符串字面量（含闭引号）。**跳过、不是遮蔽**——定义本身就在字符串里
  // （`variable: '--font-sans'` / `setProperty('--x', …)` / `'accordion-down'`），
  // 遮蔽掉会把运行时定义全删光。不跳过的话，字符串里的块注释起号（`accept="image/*"`、
  // `'./app/**/*.{ts}'` 里的那个起号）会被当成真注释开头，一路遮到下一个闭号或 EOF，
  // 把后面的真注入整段吃掉 → 门禁①误报悬空变量。
  const skipString = (quote) => {
    let k = i + 1
    while (k < len) {
      if (source[k] === '\\') {
        k += 2
        continue
      }
      if (source[k] === quote) {
        k += 1
        break
      }
      k += 1
    }
    i = k
  }

  // 正则字面量里的引号（`/['"]/`、`/[",]/`）不是字符串起始引号：不先跳过正则，
  // quote 分支会从正则里那个引号一路跳到「下一个同引号字符」，而那个引号往往落在
  // 后面的注释里 → 注释不再被遮蔽，被注释掉的注入被当成真注入（门禁①假阴性）。
  // 判据：`/` 后不是 `*` / `/`，且处于表达式位置（前一个非空白字符是分隔符之一，
  // 或紧跟 return / typeof 这类只可能出现在表达式前的关键字，或箭头 `=>`）。
  const isRegexStart = () => {
    let k = i - 1
    while (
      k >= 0 &&
      (source[k] === ' ' || source[k] === '\t' || source[k] === '\n' || source[k] === '\r')
    ) {
      k -= 1
    }
    if (k < 0) return true
    const p = source[k]
    if (
      p === '(' || p === ',' || p === '=' || p === ':' || p === '[' ||
      p === '!' || p === '&' || p === '|' || p === '?' || p === '{' || p === ';'
    ) {
      return true
    }
    // 箭头函数直接返回正则：`=> /['"]/`。`>` 本身不是分隔符，单独认。
    if (p === '>') {
      let j = k - 1
      while (
        j >= 0 &&
        (source[j] === ' ' || source[j] === '\t' || source[j] === '\n' || source[j] === '\r')
      ) {
        j -= 1
      }
      return source[j] === '='
    }
    return /\b(return|typeof|case|in|of|delete|void|instanceof|yield)$/.test(
      source.slice(Math.max(0, k - 9), k + 1),
    )
  }

  // 跳到正则的闭斜杠 + flags。转义斜杠与字符类里的斜杠都不结束正则。
  const skipRegex = () => {
    let k = i + 1
    let inClass = false
    while (k < len) {
      const c = source[k]
      if (c === '\\') {
        k += 2
        continue
      }
      if (c === '\n') break
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) {
        k += 1
        break
      }
      k += 1
    }
    while (k < len && /[gimsuyvd]/.test(source[k])) k += 1
    i = k
  }

  while (i < len) {
    const c = source[i]
    if (c === '/' && source[i + 1] !== '*' && source[i + 1] !== '/' && isRegexStart()) {
      skipRegex()
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      skipString(c)
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
    if (c === '/' && source[i + 1] === '/') {
      // CSS 里没有行注释，但 `.ts` / `.tsx` 有；两种都遮蔽。
      let k = i
      while (k < len && source[k] !== '\n') k += 1
      maskRange(i, k)
      i = k
      continue
    }
    i += 1
  }
  return chars.join('')
}

// ─────────────────────────────────────────────────────────────────────────────
// 通用小工具
// ─────────────────────────────────────────────────────────────────────────────

export function lineOf(source, offset) {
  let line = 1
  for (let k = 0; k < offset && k < source.length; k++) if (source[k] === '\n') line += 1
  return line
}

export function columnOf(source, offset) {
  const nl = source.lastIndexOf('\n', offset - 1)
  return offset - nl
}

function snippetOf(source, line) {
  const text = source.split('\n')[line - 1] ?? ''
  const trimmed = text.trim()
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed
}

/** 从 `s[start]`（左括号）出发，返回配对右括号的下标；找不到返回 -1。 */
export function matchDelimiter(s, start) {
  const pairs = { '(': ')', '[': ']', '{': '}' }
  const close = pairs[s[start]]
  if (!close) return -1
  const open = s[start]
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

// ─────────────────────────────────────────────────────────────────────────────
// 判据 1：悬空 CSS 变量
// ─────────────────────────────────────────────────────────────────────────────

const CSS_VAR_DEF_RE = /(^|[\s{;(,])(--[A-Za-z0-9_-]+)\s*:/g
const CSS_VAR_REF_RE = /var\(\s*(--[A-Za-z0-9_-]+)\s*/g

/** 收集 CSS 文本里的 `--x: …` 定义（返回 Set）。 */
export function collectCssVarDefs(cssText) {
  const masked = maskComments(cssText)
  const defs = new Set()
  let m
  CSS_VAR_DEF_RE.lastIndex = 0
  while ((m = CSS_VAR_DEF_RE.exec(masked)) !== null) defs.add(m[2])
  return defs
}

/**
 * 收集 CSS 文本里的 `var(--x)` 引用，带 `hasFallback` 标记与行列号。
 * `hasFallback` = 该 `var(` 的顶层参数里出现过逗号（`var(--x, 4px)`）。
 */
export function collectCssVarRefs(cssText) {
  const masked = maskComments(cssText)
  const refs = []
  let m
  CSS_VAR_REF_RE.lastIndex = 0
  while ((m = CSS_VAR_REF_RE.exec(masked)) !== null) {
    // 从 `var(` 的左括号开始配平，判断顶层是否出现过逗号。
    const parenStart = masked.indexOf('(', m.index)
    const parenEnd = matchDelimiter(masked, parenStart)
    const inner = parenEnd > 0 ? masked.slice(parenStart + 1, parenEnd) : ''
    let depth = 0
    let hasFallback = false
    for (const c of inner) {
      if (c === '(' || c === '[' || c === '{') depth += 1
      else if (c === ')' || c === ']' || c === '}') depth -= 1
      else if (c === ',' && depth === 0) hasFallback = true
    }
    const line = lineOf(cssText, m.index)
    refs.push({
      name: m[1],
      hasFallback,
      line,
      column: columnOf(cssText, m.index),
      snippet: snippetOf(cssText, line),
    })
  }
  return refs
}

/**
 * 在 `.ts` / `.tsx` 源码里找「运行时注入的 CSS 变量定义」。
 *
 * 认这三种写法（都是本仓库真实在用的）：
 *   next/font:   `variable: '--font-sans'`
 *   内联样式:     `'--i': index` / `"--subnav-delay": …`
 *   DOM API:     `setProperty('--x', …)`
 *
 * 不认 `var(--x)` 引用——那正是要被检查的东西。
 *
 * **先遮蔽注释**：被注释掉的注入不是注入。不遮蔽的话，`// el.style.setProperty('--x', …)`
 * 这种「真注入已删、只剩注释」的回归会被误认成已定义，门禁①静默放行——而这类回归
 * （注入没了、引用还在）恰恰是本脚本最该抓的形状。
 */
export function collectRuntimeVarDefs(source) {
  const masked = maskComments(source)
  const defs = new Set()
  const patterns = [
    /variable\s*:\s*['"](--[A-Za-z0-9_-]+)['"]/g,
    /['"](--[A-Za-z0-9_-]+)['"]\s*:/g,
    /setProperty\(\s*['"](--[A-Za-z0-9_-]+)['"]/g,
  ]
  for (const re of patterns) {
    let m
    re.lastIndex = 0
    while ((m = re.exec(masked)) !== null) defs.add(m[1])
  }
  return defs
}

/**
 * 找悬空变量：引用存在、但既没有 CSS 定义也没有运行时注入、且没有 fallback、
 * 也不属于第三方命名空间。
 *
 * @param {string} cssText
 * @param {{runtimeDefined?: Set<string>, thirdPartyPrefixes?: string[]}} options
 * @returns {{hits: object[], fallbacks: object[], totalRefs: number, totalDefs: number}}
 */
export function findUndefinedVars(cssText, options = {}) {
  const runtimeDefined = options.runtimeDefined ?? new Set()
  const thirdPartyPrefixes = options.thirdPartyPrefixes ?? THIRD_PARTY_VAR_PREFIXES

  const defs = collectCssVarDefs(cssText)
  const refs = collectCssVarRefs(cssText)

  const isThirdParty = (name) => thirdPartyPrefixes.some((p) => name.startsWith(p))
  const isDefined = (name) => defs.has(name) || runtimeDefined.has(name) || isThirdParty(name)

  const hits = []
  const fallbacks = []
  for (const ref of refs) {
    if (isDefined(ref.name)) continue
    if (ref.hasFallback) fallbacks.push(ref)
    else hits.push({ ...ref, kind: 'undefined-css-var' })
  }
  return { hits, fallbacks, totalRefs: refs.length, totalDefs: defs.size }
}

// ─────────────────────────────────────────────────────────────────────────────
// 判据 2：零消费 animation 配置
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从 `tailwind.config.ts` 里取出 `theme.extend.animation` 的条目名与行号。
 *
 * 用「找到 `animation: {` 再配平括号 + 顶层逗号切分」的方式，不引 TS 解析器。
 * 认三种 key 写法：`'accordion-down':` / `"x":` / `x:`。
 */
export function collectAnimationEntries(configText) {
  const masked = maskComments(configText)
  const keyRe = /(^|[\s{,])(['"]?)animation\2\s*:/g
  const entries = []
  let m
  while ((m = keyRe.exec(masked)) !== null) {
    let i = m.index + m[0].length
    while (i < masked.length && /\s/.test(masked[i])) i += 1
    if (masked[i] !== '{') continue
    const close = matchDelimiter(masked, i)
    if (close < 0) continue
    const inner = masked.slice(i + 1, close)

    // 按顶层逗号切分，每段取 key。
    let depth = 0
    let start = 0
    const chunks = []
    for (let k = 0; k < inner.length; k++) {
      const c = inner[k]
      if (c === '(' || c === '[' || c === '{') depth += 1
      else if (c === ')' || c === ']' || c === '}') depth -= 1
      else if (c === ',' && depth === 0) {
        chunks.push([start, k])
        start = k + 1
      }
    }
    chunks.push([start, inner.length])

    for (const [a, b] of chunks) {
      const chunk = inner.slice(a, b)
      const propMatch = /^\s*(['"]?)([A-Za-z0-9_-]+)\1\s*:/.exec(chunk)
      if (!propMatch) continue
      const nameOffset = i + 1 + a + propMatch[0].indexOf(propMatch[2])
      const line = lineOf(configText, nameOffset)
      entries.push({
        name: propMatch[2],
        line,
        column: columnOf(configText, nameOffset),
        snippet: snippetOf(configText, line),
      })
    }
  }
  return entries
}

/**
 * 找零消费的 animation 条目：`animate-<name>` 在消费者源码里一次都没出现。
 *
 * `consumerSources` 是 [{file, text}]；匹配按单词边界（`animate-fade-in-up` 不应被
 * `animate-fade-in-up-slow` 认成消费点）。
 */
export function findUnconsumedAnimations(entries, consumerSources) {
  const hits = []
  for (const entry of entries) {
    const re = new RegExp(`animate-${entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`)
    const usedBy = []
    for (const { file, text } of consumerSources) {
      if (re.test(text)) usedBy.push(file)
    }
    if (usedBy.length === 0) hits.push({ ...entry, kind: 'unconsumed-animation' })
  }
  return hits
}

// ─────────────────────────────────────────────────────────────────────────────
// 仅报告：off-scale 字面量时长
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 统计 Tailwind 字面量时长类（`duration-200` 等）的处数与清单。
 * 只认**裸数字**：`duration-[var(--duration-quick)]` 已在尺度上，不计。
 */
export function countOffScaleDurations(consumerSources) {
  const counts = {}
  const hits = []
  for (const { file, text } of consumerSources) {
    const lines = text.split('\n')
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx]
      for (const ms of OFF_SCALE_DURATION_CLASSES) {
        const re = new RegExp(`duration-${ms}(?![\\w\\[])`, 'g')
        const found = line.match(re)
        if (!found) continue
        counts[ms] = (counts[ms] ?? 0) + found.length
        for (let n = 0; n < found.length; n++) {
          hits.push({
            file,
            line: idx + 1,
            ms,
            // 同一行含 hover/focus 的是最明确的「该是 --duration-quick」集合。
            interaction: /(?:^|\s)(?:group-hover|hover|focus|focus-visible|active):/.test(line),
            snippet: snippetOf(text, idx + 1),
          })
        }
      }
    }
  }
  return { counts, hits, onScaleMs: [...ON_SCALE_MS].sort((a, b) => a - b) }
}

// ─────────────────────────────────────────────────────────────────────────────
// 扫描
// ─────────────────────────────────────────────────────────────────────────────

const CSS_FILE_RE = /\.css$/
const TS_FILE_RE = /\.(?:ts|tsx)$/
const CONSUMER_FILE_RE = /\.(?:ts|tsx|css|mdx)$/

function walk(root, accept) {
  const found = []
  const visit = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        visit(join(dir, entry.name))
      } else if (entry.isFile()) {
        const abs = join(dir, entry.name)
        const rel = relative(root, abs)
        if (accept(rel, entry.name)) found.push(rel)
      }
    }
  }
  visit(root)
  return found.sort()
}

/** 扫一个根目录，返回三组结果。 */
export function scanRoot(root = FRONTEND_ROOT) {
  const globalsPath = join(root, 'app/globals.css')
  const configPath = join(root, 'tailwind.config.ts')

  const cssFiles = walk(root, (rel) => CSS_FILE_RE.test(rel))
  const tsFiles = walk(root, (rel) => TS_FILE_RE.test(rel))
  const consumerFiles = walk(root, (rel) => CONSUMER_FILE_RE.test(rel))

  // 判据 1：globals.css 是 token 的单一真相源；其余 CSS 文件的定义也算（避免误报）。
  let globalsCss = ''
  try {
    globalsCss = readFileSync(globalsPath, 'utf8')
  } catch {
    throw new Error(`读不到 ${globalsPath}`)
  }
  const cssDefs = new Set(collectCssVarDefs(globalsCss))
  for (const rel of cssFiles) {
    if (rel === 'app/globals.css') continue
    const text = readFileSync(join(root, rel), 'utf8')
    for (const def of collectCssVarDefs(text)) cssDefs.add(def)
  }
  const runtimeDefined = new Set()
  for (const rel of tsFiles) {
    const text = readFileSync(join(root, rel), 'utf8')
    for (const def of collectRuntimeVarDefs(text)) runtimeDefined.add(def)
  }
  const undefinedVars = findUndefinedVars(globalsCss, { runtimeDefined })
  for (const hit of undefinedVars.hits) hit.file = 'app/globals.css'
  // 其它 CSS 文件里的悬空引用也一并检查：用合并后的定义集（globals.css 之外的文件可能
  // 定义自有变量），按各文件自身行号报告。
  for (const rel of cssFiles) {
    if (rel === 'app/globals.css') continue
    const text = readFileSync(join(root, rel), 'utf8')
    for (const ref of collectCssVarRefs(text)) {
      const defined =
        cssDefs.has(ref.name) ||
        runtimeDefined.has(ref.name) ||
        THIRD_PARTY_VAR_PREFIXES.some((p) => ref.name.startsWith(p))
      if (defined || ref.hasFallback) continue
      undefinedVars.hits.push({ ...ref, file: rel, kind: 'undefined-css-var' })
    }
  }

  // 判据 2：tailwind.config.ts 的 animation 条目必须有消费点。
  let configText = ''
  try {
    configText = readFileSync(configPath, 'utf8')
  } catch {
    throw new Error(`读不到 ${configPath}`)
  }
  const animationEntries = collectAnimationEntries(configText)
  const consumerSources = consumerFiles
    .filter((rel) => rel !== 'tailwind.config.ts')
    .map((rel) => ({ file: rel, text: readFileSync(join(root, rel), 'utf8') }))
  const unconsumed = findUnconsumedAnimations(animationEntries, consumerSources)

  // 仅报告：off-scale 时长（只扫代码，不扫 docs——文档里的示例不算实现）。
  const codeSources = consumerFiles
    .filter((rel) => /\.(?:ts|tsx)$/.test(rel) && !rel.startsWith('scripts/'))
    .map((rel) => ({ file: rel, text: readFileSync(join(root, rel), 'utf8') }))
  const offScale = countOffScaleDurations(codeSources)

  return {
    root,
    filesScanned: { css: cssFiles.length, ts: tsFiles.length, consumers: consumerFiles.length },
    cssVars: {
      totalDefs: cssDefs.size,
      totalRefs: undefinedVars.totalRefs,
      runtimeDefs: runtimeDefined.size,
      hits: undefinedVars.hits,
      fallbacks: undefinedVars.fallbacks,
    },
    animations: { entries: animationEntries, hits: unconsumed },
    offScale,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const HELP = `check-motion-tokens — 动效 token / 配置一致性机械检查（BLF-1361）

硬门禁（命中即 exit 1）：
  1. app/globals.css 里每个 var(--x) 必须有定义（CSS 声明 / 运行时注入 / 有 fallback）；
     第三方命名空间 --radix-* / --tw-* 除外。
  2. tailwind.config.ts 的每个 animation 条目必须有 animate-<name> 消费点。

仅报告（不计入失败）：
  3. off-scale 字面量时长（duration-75/200/300/700/1000）的处数与清单。

用法：
  node scripts/check-motion-tokens.mjs [--json] [--root <dir>]

退出码：0 = 0 命中；1 = 有命中；2 = 用法 / 读文件出错。
判据说明见 frontend/docs/motion-system.md §6 调试 checklist。
`

function renderHuman(result) {
  const { cssVars, animations, offScale } = result
  const lines = []

  lines.push(
    `[check-motion-tokens] 扫描 ${result.filesScanned.css} 个 CSS / ${result.filesScanned.ts} 个 TS / ` +
      `${result.filesScanned.consumers} 个消费文件`
  )
  lines.push('')

  // 判据 1
  lines.push(
    `① 悬空 CSS 变量：${cssVars.totalRefs} 个 var() 引用 / ${cssVars.totalDefs} 个 CSS 定义 / ` +
      `${cssVars.runtimeDefs} 个运行时注入 → ${cssVars.hits.length} 命中`
  )
  for (const hit of cssVars.hits) {
    lines.push(`   ${hit.file}:${hit.line}:${hit.column}  var(${hit.name}) 无定义且无 fallback`)
    lines.push(`      ${hit.line} | ${hit.snippet}`)
  }
  if (cssVars.fallbacks.length > 0) {
    const names = [...new Set(cssVars.fallbacks.map((f) => f.name))].sort()
    lines.push(`   （有 fallback 的未定义引用 ${cssVars.fallbacks.length} 处，视为安全：${names.join(', ')}）`)
  }
  lines.push('')

  // 判据 2
  lines.push(
    `② 零消费 animation 配置：${animations.entries.length} 个条目 → ${animations.hits.length} 命中`
  )
  for (const hit of animations.hits) {
    lines.push(`   tailwind.config.ts:${hit.line}:${hit.column}  '${hit.name}' 无 animate-${hit.name} 消费点`)
    lines.push(`      ${hit.line} | ${hit.snippet}`)
  }
  lines.push('')

  // 仅报告
  const counts = offScale.counts
  const parts = OFF_SCALE_DURATION_CLASSES.filter((ms) => counts[ms]).map((ms) => `${ms}×${counts[ms]}`)
  const interaction = offScale.hits.filter((h) => h.interaction).length
  lines.push(
    `③ off-scale 字面量时长（仅报告，不计入失败）：${offScale.hits.length} 处 / ` +
      `${new Set(offScale.hits.map((h) => h.file)).size} 个文件`
  )
  if (parts.length > 0) lines.push(`   ${parts.join(' / ')}；其中 ${interaction} 处同行含 hover/focus/group-hover`)
  lines.push(
    '   处置原则（transitions-polish）：按 usage 匹配 token，不按数值就近；' +
      '用途与任何 token 都不匹配的保持原样。'
  )

  const failed = cssVars.hits.length + animations.hits.length
  lines.push('')
  lines.push(failed === 0 ? '✅ 硬门禁全部通过' : `❌ 硬门禁 ${failed} 命中`)
  return lines.join('\n')
}

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
      process.stderr.write(`[check-motion-tokens] 未知参数：${arg}\n\n${HELP}`)
      return 2
    }
  }

  let result
  try {
    result = scanRoot(root)
  } catch (err) {
    process.stderr.write(`[check-motion-tokens] 扫描 ${root} 失败：${err?.message ?? err}\n`)
    return 2
  }

  const failed = result.cssVars.hits.length + result.animations.hits.length

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: failed === 0,
          root: result.root,
          filesScanned: result.filesScanned,
          undefinedVars: result.cssVars,
          unconsumedAnimations: result.animations,
          offScaleDurations: result.offScale,
        },
        null,
        2
      )}\n`
    )
  } else {
    process.stdout.write(`${renderHuman(result)}\n`)
  }

  return failed === 0 ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)))
}
