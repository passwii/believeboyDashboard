'use client'

import { Bot, User } from 'lucide-react'
import { AIChatMessageContent } from '@/components/ai-chat-message-content'
import { TypingIndicator } from './typing-indicator'
import type { ChatMessage } from '../types'

export function ChatMessageList({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {messages.map((msg, index) => (
        <div
          key={msg.id}
          className={`flex animate-enter ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          style={{ animationDelay: `${index * 60}ms` }}
        >
          <div className={`group relative max-w-[85%] flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.08] border border-white/[0.06]">
              {msg.role === 'assistant'
                ? <Bot className="h-4 w-4 text-blue-400/70" />
                : <User className="h-4 w-4 text-white/50" />
              }
            </div>
            <div className={`flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div
                className={`px-4 py-3 ${
                  msg.role === 'user'
                    ? 'bg-white/[0.08] rounded-2xl rounded-tr-md text-white'
                    : 'text-[#e0e0e0]'
                }`}
              >
                {msg.role === 'user' ? (
                  <p className="whitespace-pre-wrap break-words text-[15px] leading-7">{msg.content}</p>
                ) : msg.content ? (
                  <AIChatMessageContent content={msg.content} className="[&_p]:text-[15px] [&_p]:leading-7 [&_p]:text-[#e0e0e0] [&_h2]:text-white [&_h3]:text-white [&_li]:text-[#d0d0d0]" />
                ) : (
                  <TypingIndicator />
                )}
              </div>
              {msg.streaming && msg.content && (
                <span className="text-xs text-blue-400/50 flex items-center gap-1">
                  <span className="h-1 w-1 rounded-full bg-blue-400 animate-pulse" />
                  生成中...
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
