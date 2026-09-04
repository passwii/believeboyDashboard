'use client'

import { Sparkles } from 'lucide-react'

export function TypingIndicator({ label = '正在思考' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2.5 py-2">
      <span className="relative flex items-center gap-[3px]">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-[6px] w-[6px] rounded-full bg-blue-500/60 dark:bg-blue-400/60"
            style={{
              animation: `bb-thinking-pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
            }}
          />
        ))}
      </span>
      <span className="text-[13px] font-medium flex items-center gap-1.5 text-slate-500 dark:text-[#8a8a8f]">
        <Sparkles className="size-3 text-blue-500/60 dark:text-blue-400/50" aria-hidden />
        {label}
        <span className="inline-flex overflow-hidden">
          <span style={{ animation: 'bb-dot-fade 1.5s steps(4, end) infinite' }}>...</span>
        </span>
      </span>

      <style>{`
        @keyframes bb-thinking-pulse {
          0%, 100% {
            opacity: 0.3;
            transform: scale(0.85);
          }
          50% {
            opacity: 1;
            transform: scale(1);
          }
        }
        @keyframes bb-dot-fade {
          0%   { width: 0; }
          25%  { width: 0.6em; }
          50%  { width: 1.2em; }
          75%  { width: 0.6em; }
          100% { width: 0; }
        }
      `}</style>
    </div>
  )
}
