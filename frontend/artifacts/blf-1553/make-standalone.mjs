/**
 * 把 draft/index.html + draft.css + dist/draft.js + 字体 合成**单个自包含 HTML**，
 * 供用户直接下载双击打开（Multica 附件只能挂单个文件，不能挂目录）。
 * 运行：node artifacts/blf-1553/make-standalone.mjs
 *
 * 注意：替换内容用**函数式** replacer —— bundle 与 CSS 里含 `$&` / `$'` 这类序列，
 * 用字符串 replacer 会被 String.replace 当成特殊替换模式，导致产出被截断。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const base = resolve(here, 'draft')

const html = readFileSync(resolve(base, 'index.html'), 'utf8')
const css = readFileSync(resolve(base, 'draft.css'), 'utf8')
const js = readFileSync(resolve(base, 'dist/draft.js'), 'utf8')

const fonts = [
  ['manrope-400.woff2', 'Manrope', 400],
  ['manrope-500.woff2', 'Manrope', 500],
  ['manrope-600.woff2', 'Manrope', 600],
  ['manrope-700.woff2', 'Manrope', 700],
  ['jetbrains-mono-400.woff2', 'JetBrains Mono', 400],
  ['jetbrains-mono-500.woff2', 'JetBrains Mono', 500],
]

const faces = fonts
  .map(([file, family, weight]) => {
    const data = readFileSync(resolve(base, 'fonts', file)).toString('base64')
    return `@font-face { font-family: "${family}"; src: url("data:font/woff2;base64,${data}") format("woff2"); font-weight: ${weight}; font-style: normal; font-display: swap; }`
  })
  .join('\n')

// 防止 bundle 里的字符串提前闭合 <script>
const safeJs = js.replace(/<\/script>/gi, '<\\/script>')

let out = html.replace(/    <style>[\s\S]*?<\/style>/, () => `    <style>\n${faces}\n    </style>`)
out = out.replace('    <link rel="stylesheet" href="./draft.css" />', () => `    <style>\n${css}\n    </style>`)
out = out.replace('    <script src="./dist/draft.js"></script>', () => `    <script>\n${safeJs}\n    </script>`)

writeFileSync(resolve(here, 'believeboy-logo-draft.html'), out)
console.log('standalone bytes:', out.length, '| contains bundle:', out.includes('createRoot'), '| has script tag end:', out.trimEnd().endsWith('</html>'))
