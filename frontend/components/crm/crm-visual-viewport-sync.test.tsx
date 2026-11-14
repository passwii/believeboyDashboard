import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CrmVisualViewportSync } from './crm-visual-viewport-sync'

type Listener = (event: Event) => void

function installVisualViewport(height: number, offsetTop: number) {
  const listeners = new Map<string, Set<Listener>>()
  const viewport = {
    width: 393,
    height,
    offsetTop,
    offsetLeft: 0,
    scale: 1,
    addEventListener: (type: string, listener: Listener) => {
      const set = listeners.get(type) ?? new Set<Listener>()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener: (type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener)
    },
    dispatchEvent: () => true,
  } as unknown as VisualViewport

  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: viewport,
  })

  return {
    setHeight: (next: number) => {
      Object.defineProperty(viewport, 'height', { configurable: true, value: next })
    },
    setOffsetTop: (next: number) => {
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: next })
    },
    emitResize: () => {
      for (const listener of listeners.get('resize') ?? []) listener(new Event('resize'))
    },
  }
}

const originalInnerHeight = window.innerHeight

beforeEach(() => {
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: 851,
  })
})

afterEach(() => {
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: originalInnerHeight,
  })
  delete (window as { visualViewport?: VisualViewport }).visualViewport
  for (const name of [
    '--crm-visual-viewport-height',
    '--crm-visual-viewport-offset-top',
    '--crm-layout-viewport-height',
    '--crm-keyboard-inset-bottom',
  ]) {
    document.documentElement.style.removeProperty(name)
  }
})

describe('CrmVisualViewportSync', () => {
  it('mirrors the visual viewport height and derives the keyboard inset', () => {
    const fake = installVisualViewport(600, 0)

    render(<CrmVisualViewportSync />)

    const style = document.documentElement.style
    expect(style.getPropertyValue('--crm-visual-viewport-height')).toBe('600px')
    expect(style.getPropertyValue('--crm-visual-viewport-offset-top')).toBe('0px')
    expect(style.getPropertyValue('--crm-layout-viewport-height')).toBe('851px')
    expect(style.getPropertyValue('--crm-keyboard-inset-bottom')).toBe('251px')

    fake.setHeight(500)
    fake.emitResize()

    expect(style.getPropertyValue('--crm-visual-viewport-height')).toBe('500px')
    expect(style.getPropertyValue('--crm-keyboard-inset-bottom')).toBe('351px')
  })

  it('subtracts the visual viewport pan from the keyboard inset', () => {
    const fake = installVisualViewport(500, 100)

    render(<CrmVisualViewportSync />)

    const style = document.documentElement.style
    expect(style.getPropertyValue('--crm-visual-viewport-offset-top')).toBe('100px')
    expect(style.getPropertyValue('--crm-keyboard-inset-bottom')).toBe('251px')

    fake.setOffsetTop(150)
    fake.emitResize()

    expect(style.getPropertyValue('--crm-visual-viewport-offset-top')).toBe('150px')
    expect(style.getPropertyValue('--crm-keyboard-inset-bottom')).toBe('201px')
  })

  it('falls back to the layout viewport without a visualViewport API and cleans up', () => {
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: undefined,
    })

    const { unmount } = render(<CrmVisualViewportSync />)

    const style = document.documentElement.style
    expect(style.getPropertyValue('--crm-visual-viewport-height')).toBe('851px')
    expect(style.getPropertyValue('--crm-keyboard-inset-bottom')).toBe('0px')

    unmount()

    expect(style.getPropertyValue('--crm-visual-viewport-height')).toBe('')
    expect(style.getPropertyValue('--crm-keyboard-inset-bottom')).toBe('')
  })
})
