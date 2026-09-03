'use client'

import React from 'react'
import SignInCard from './sign-in-card'

/**
 * 登录页容器（BLF-965）。
 * 主题由 next-themes 的 class 策略全局驱动，终端窗口自带切换按钮，
 * 此处只提供中性灰画布：light 浅灰层叠，dark 炭灰层叠（无 navy、无纯黑）。
 */
const Index = () => {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-gradient-to-br from-neutral-100 via-neutral-50 to-neutral-200 px-4 py-10 sm:p-6 dark:from-[#1b1b1e] dark:via-[#232327] dark:to-[#1b1b1e]">
      <SignInCard />
    </div>
  )
}

export default Index
