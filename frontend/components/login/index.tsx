'use client'

import React, { useEffect, useState } from 'react'
import SignInCard from './sign-in-card'

const Index = () => {
  const [theme, setTheme] = useState<'light' | 'dark'>('light')

  useEffect(() => {
    const isDark = document.documentElement.classList.contains('dark')
    setTheme(isDark ? 'dark' : 'light')

    const observer = new MutationObserver(() => {
      const isDarkNow = document.documentElement.classList.contains('dark')
      setTheme(isDarkNow ? 'dark' : 'light')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  const outerBg =
    theme === 'dark' ? 'from-[hsl(220_25%_8%)] to-[hsl(233_30%_12%)]' : 'from-blue-50 to-indigo-100'

  return (
    <div
      className={`flex min-h-screen w-full items-center justify-center bg-gradient-to-br ${outerBg} sm:p-4 md:px-6 lg:px-8`}
    >
      <SignInCard theme={theme} />
    </div>
  )
}

export default Index
