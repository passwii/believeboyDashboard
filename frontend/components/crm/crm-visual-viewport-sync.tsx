'use client'

import { useEffect } from 'react'

const VIEWPORT_HEIGHT = '--crm-visual-viewport-height'
const VIEWPORT_OFFSET_TOP = '--crm-visual-viewport-offset-top'
const LAYOUT_HEIGHT = '--crm-layout-viewport-height'
const KEYBOARD_INSET_BOTTOM = '--crm-keyboard-inset-bottom'

const CRM_VIEWPORT_VARIABLES = [
  VIEWPORT_HEIGHT,
  VIEWPORT_OFFSET_TOP,
  LAYOUT_HEIGHT,
  KEYBOARD_INSET_BOTTOM,
] as const

/**
 * iOS Safari keeps fixed elements in the layout viewport when the software
 * keyboard shrinks the visual viewport (WebKit bug 259770). Mirror the
 * visualViewport geometry into CSS variables so CRM drawers and bottom sheets
 * can anchor to the actually visible area on WebKit as well as Chromium.
 */
export function CrmVisualViewportSync() {
  useEffect(() => {
    const root = document.documentElement
    const visualViewport = window.visualViewport ?? null

    const update = () => {
      const height = visualViewport?.height ?? window.innerHeight
      const offsetTop = visualViewport?.offsetTop ?? 0
      const layoutHeight = window.innerHeight
      const keyboardInsetBottom = Math.max(0, layoutHeight - offsetTop - height)

      root.style.setProperty(VIEWPORT_HEIGHT, `${height}px`)
      root.style.setProperty(VIEWPORT_OFFSET_TOP, `${offsetTop}px`)
      root.style.setProperty(LAYOUT_HEIGHT, `${layoutHeight}px`)
      root.style.setProperty(KEYBOARD_INSET_BOTTOM, `${keyboardInsetBottom}px`)
    }

    update()
    visualViewport?.addEventListener('resize', update)
    visualViewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)

    return () => {
      visualViewport?.removeEventListener('resize', update)
      visualViewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      for (const name of CRM_VIEWPORT_VARIABLES) {
        root.style.removeProperty(name)
      }
    }
  }, [])

  return null
}
