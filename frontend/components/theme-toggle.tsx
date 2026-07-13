'use client'

import * as React from 'react'
import { Check, Monitor, Moon, SunMedium } from 'lucide-react'
import { useTheme } from 'next-themes'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export function ThemeToggle() {
  const { resolvedTheme, theme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  const currentTheme = mounted ? theme : 'system'
  const showDark = mounted && resolvedTheme === 'dark'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="relative h-10 w-10 rounded-xl border-border/65 bg-[hsl(var(--surface-subtle))] shadow-none"
        >
          <SunMedium
            className={`h-[1.05rem] w-[1.05rem] transition-all ${showDark ? 'rotate-90 scale-0 opacity-0' : 'rotate-0 scale-100 opacity-100'}`}
          />
          <Moon
            className={`absolute h-[1.05rem] w-[1.05rem] transition-all ${showDark ? 'rotate-0 scale-100 opacity-100' : '-rotate-90 scale-0 opacity-0'}`}
          />
          <span className="sr-only">切换主题</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44 rounded-xl">
        <DropdownMenuItem onClick={() => setTheme('light')} className="justify-between">
          浅色
          {currentTheme === 'light' ? <Check className="h-4 w-4" /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')} className="justify-between">
          深色
          {currentTheme === 'dark' ? <Check className="h-4 w-4" /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')} className="justify-between">
          <span className="inline-flex items-center gap-2">
            跟随系统
            <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
          {currentTheme === 'system' ? <Check className="h-4 w-4" /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
