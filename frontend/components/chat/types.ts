import type { ReactNode } from 'react'

export interface Model {
  id: string
  name: string
  shortName?: string
  description: string
  icon: ReactNode
  badge?: string
}

export interface TextSegment {
  text: string
  highlight?: boolean
  speed: number
}

export type Phase = 'landing' | 'transitioning' | 'chat'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  error?: boolean
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  messageCount: number
}

export interface AIChatWindowProps {
  title?: string
  titleHighlight?: string
  subtitle?: string
  announcementText?: string
  announcementHref?: string
  placeholder?: string
  showInput?: boolean
  onSend?: (message: string) => void
}

export type StreamCallbacks = {
  onChunk: (delta: string) => void
  onDone: () => void
  onError: (error: string) => void
}
