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
    return <span aria-hidden="true" className="h-10 w-10" />
  }

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      aria-label={isDark ? '切换到浅色模式' : '切换到深色模式'}
      className="[focus-visible]:outline [focus-visible]:outline-2 [focus-visible]:outline-term-accent [focus-visible]:outline-offset-2 flex h-10 w-10 items-center justify-center border border-term-border bg-term-panel text-term-muted transition-[background-color,color,transform] hover:bg-term-hover hover:text-term-text active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-term-accent"
    >
      {isDark ? <SunMedium size={20} strokeWidth={1.75} /> : <Moon size={20} strokeWidth={1.75} />}
    </button>
  )
}
