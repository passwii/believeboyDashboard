'use client'

import { useEffect, useState } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useDebounce } from '@/hooks/use-debounce'

export interface CrmSearchInputProps {
  value: string
  onChange: (next: string) => void
  placeholder?: string
}

/** 防抖搜索框：local text → useDebounce(300ms) → 与 value 不同才 onChange；value 外部变化时回填。 */
export function CrmSearchInput({ value, onChange, placeholder = '搜索…' }: CrmSearchInputProps) {
  const [text, setText] = useState(value)
  const debounced = useDebounce(text, 300)

  useEffect(() => {
    if (debounced !== value) onChange(debounced)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在防抖值变化时写回
  }, [debounced])

  useEffect(() => {
    setText(value)
  }, [value])

  return (
    // 移动规则 2：手机端搜索框全宽（网格 col-span-2），桌面 md+ 恢复 224px 固定宽
    <div className="relative w-full md:w-56">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-term-faint" />
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        className="h-8 rounded-none border-term-border bg-term-bg pl-7 pr-7 font-mono text-sm text-term-text shadow-none placeholder:font-sans placeholder:text-term-faint focus-visible:ring-0 focus-visible:ring-offset-0"
        aria-label={placeholder}
      />
      {text && (
        <button
          type="button"
          aria-label="清空搜索"
          onClick={() => setText('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-term-faint transition-colors hover:text-term-text"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
