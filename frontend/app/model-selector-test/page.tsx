'use client'

import { redirect } from 'next/navigation'

import { ModelSelector } from '@/components/chat/model-selector'

export default function ModelSelectorTestPage() {
  if (process.env.NODE_ENV === 'production') {
    redirect('/login')
  }

  return (
    <main className="min-h-screen bg-[#0f0f13] p-8">
      <ModelSelector selectedModel="MiniMax-M3" />
    </main>
  )
}
