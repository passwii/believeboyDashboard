'use client'

import { useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'

export default function AiChatLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { status } = useSession()
  const router = useRouter()

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace('/login')
    }
  }, [status, router])

  // Loading state
  if (status === 'loading') {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#0f0f0f]">
        <div className="flex flex-col items-center gap-4">
          <div className="size-8 animate-spin rounded-full border-2 border-white/20 border-t-blue-400" />
          <p className="text-sm text-white/40">加载中...</p>
        </div>
      </div>
    )
  }

  // Not authenticated — will redirect via useEffect
  if (status === 'unauthenticated') {
    return null
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#0f0f0f]">
      {children}
    </div>
  )
}
