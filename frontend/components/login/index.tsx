'use client'

import React from 'react'
import SignInCard from './sign-in-card'

/**
 * 登录页容器（BLF-965）。
 * 主题由 next-themes 的 class 策略全局驱动，终端窗口自带切换按钮，
 * 此处只提供 terminal 画布底色（--term-bg，深浅自动翻转）。
 */
const Index = () => {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-term-bg px-4 py-10 sm:p-6">
      <SignInCard />
    </div>
  )
}

export default Index
