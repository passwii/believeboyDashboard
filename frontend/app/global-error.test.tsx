import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import GlobalErrorPage from './global-error'

describe('global error page', () => {
  it('keeps the document structure and renders V4 home/retry actions', () => {
    const markup = renderToStaticMarkup(
      <GlobalErrorPage error={new Error('root layout failed')} reset={() => undefined} />
    )

    expect(markup).toContain('<html lang="zh-CN">')
    expect(markup).toContain('<body class="min-h-screen antialiased">')
    expect(markup).toContain('class="warm-ledger')
    expect(markup).toContain('页面暂时不可用')
    expect(markup).toContain('返回首页')
    expect(markup).toContain('重新加载')
    expect(markup).not.toContain('term-')
  })
})
