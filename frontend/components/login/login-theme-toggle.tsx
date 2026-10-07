'use client'

import React from 'react'
import { useTheme } from 'next-themes'
import { Moon, SunMedium } from 'lucide-react'

export function LoginThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  const isDark = mounted && resolvedTheme === 'dark'

  if (!mounted) {
    return <span aria-hidden="true" className="theme-button" />
  }

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      aria-label={isDark ? '切换到浅色模式' : '切换到深色模式'}
      aria-pressed={isDark}
      className="theme-button"
    >
      {isDark ? <SunMedium size={20} strokeWidth={1.75} /> : <Moon size={20} strokeWidth={1.75} />}
    </button>
  )
}
