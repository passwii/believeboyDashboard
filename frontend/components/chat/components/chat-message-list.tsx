'use client'

import { Bot, User } from 'lucide-react'
import { AIChatMessageContent } from '@/components/ai-chat-message-content'
import { TypingIndicator } from './typing-indicator'
import type { ChatMessage } from '../types'

export function ChatMessageList({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="mx-auto max-w-3xl space-y-4 sm:space-y-6">
      {messages.map((msg, index) => (
        <div
          key={msg.id}
          className={`flex animate-enter ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          style={{ animationDelay: `${index * 60}ms` }}
        >
          <div className={`group relative max-w-[88%] sm:max-w-[85%] flex gap-2 sm:gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
            {/* Avatar - 移动端稍小 */}
            <div className="flex h-7 w-7 sm:h-8 sm:w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.08] border border-white/[0.06]">
              {msg.role === 'assistant'
                ? <Bot className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-blue-400/70" />
                : <User className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-white/50" />
              }
            </div>
            {/* Message bubble */}
            <div className={`flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div
                className={`px-3 sm:px-4 py-2.5 sm:py-3 ${
                  msg.role === 'user'
                    ? 'bg-white/[0.08] rounded-2xl rounded-tr-md text-white'
                    : 'text-[#e0e0e0]'
                }`}
              >
                {msg.role === 'user' ? (
                  <p className="whitespace-pre-wrap break-words text-[14px] sm:text-[15px] leading-6 sm:leading-7">{msg.content}</p>
                ) : msg.content ? (
                  <AIChatMessageContent 
                    content={msg.content} 
                    className="[&_p]:text-[14px] sm:[&_p]:text-[15px] [&_p]:leading-6 sm:[&_p]:leading-7 [&_p]:text-[#e0e0e0] [&_h2]:text-white [&_h3]:text-white [&_li]:text-[#d0d0d0]" 
                  />
                ) : (
                  <TypingIndicator />
                )}
              </div>
              {/* Streaming indicator */}
              {msg.streaming && msg.content && (
                <span className="text-xs text-blue-400/50 flex items-center gap-1 px-1">
                  <span className="h-1 w-1 rounded-full bg-blue-400 animate-pulse" />
                  <span className="hidden sm:inline">生成中...</span>
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
