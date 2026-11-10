import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { forceDarkDocument } from './forced-dark'

describe('forceDarkDocument', () => {
  beforeEach(() => {
    document.documentElement.className = 'light'
    document.documentElement.style.colorScheme = 'light'
  })

  afterEach(() => {
    document.documentElement.className = ''
    document.documentElement.style.colorScheme = ''
  })

  it('replaces the light theme class with dark while mounted', () => {
    const restore = forceDarkDocument()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.classList.contains('light')).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe('dark')
    restore()
  })

  it('restores the previous theme classes and colour scheme on cleanup', () => {
    const restore = forceDarkDocument()
    restore()
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('leaves no class attribute behind when the page started without one', () => {
    document.documentElement.className = ''
    const restore = forceDarkDocument()
    restore()
    expect(document.documentElement.getAttribute('class')).toBe('')
  })
})
