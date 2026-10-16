import { describe, expect, it } from 'vitest'

import { applyPreviewTheme } from './preview'

const DOC = '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8"></head><body>x</body></html>'

describe('applyPreviewTheme', () => {
  it('给 <html> 注入 data-bb-theme（暗色）', () => {
    const out = applyPreviewTheme(DOC, 'dark')
    expect(out).toContain('<html lang="zh-CN" data-bb-theme="dark">')
    expect(out).not.toContain('data-bb-theme="light"')
  })

  it('覆盖已有的 data-bb-theme，不重复属性', () => {
    const withLight = DOC.replace('<html', '<html data-bb-theme="light"')
    const out = applyPreviewTheme(withLight, 'dark')
    expect(out.match(/data-bb-theme=/g)).toHaveLength(1)
    expect(out).toContain('data-bb-theme="dark"')
  })

  it('保留 <html> 上其它属性与文档其余内容', () => {
    const doc = DOC.replace('<html', '<html class="proposal"')
    const out = applyPreviewTheme(doc, 'light')
    expect(out).toContain('class="proposal"')
    expect(out).toContain('data-bb-theme="light"')
    expect(out).toContain('<body>x</body>')
  })

  it('没有 <html> 时包一层完整文档', () => {
    const out = applyPreviewTheme('<h1>片段</h1>', 'light')
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(out).toContain('data-bb-theme="light"')
    expect(out).toContain('<h1>片段</h1>')
  })
})
