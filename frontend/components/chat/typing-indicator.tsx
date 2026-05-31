'use client'

export function TypingIndicator() {
  return (
    <div className="flex items-center gap-1.5 py-2">
      <span className="h-2 w-2 rounded-full bg-blue-400/60 animate-bounce" style={{ animationDelay: '0ms' }} />
      <span className="h-2 w-2 rounded-full bg-blue-400/60 animate-bounce" style={{ animationDelay: '150ms' }} />
      <span className="h-2 w-2 rounded-full bg-blue-400/60 animate-bounce" style={{ animationDelay: '300ms' }} />
    </div>
  )
}
