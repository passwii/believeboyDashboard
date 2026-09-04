'use client'

import { useEffect } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { COUNTRY_OPTIONS } from '@/lib/console-constants'
import { cn } from '@/lib/utils'

interface CountrySelectProps {
  value: string
  onChange: (value: string) => void
  options?: readonly { value: string; label: string }[]
  placeholder?: string
  className?: string
  triggerClassName?: string
  /**
   * 默认 true：当 value 为空（页面未预设国家）时,自动选中第一个真实站点
   * （跳过 ALL 全部站点,默认 US）,避免进入页面后无任何内容加载、减轻聚合负载。
   * 页面若需保持空白（如先选店铺再出国家）传 false 退出。
   */
  autoSelectFirst?: boolean
  /** 覆盖默认选中值；缺省取 options 中第一个 value !== 'ALL' 的项（即 US）。 */
  defaultValue?: string
}

export function CountrySelect({
  value,
  onChange,
  options = COUNTRY_OPTIONS,
  placeholder = '请选择国家站点',
  className,
  triggerClassName,
  autoSelectFirst = true,
  defaultValue,
}: CountrySelectProps) {
  // 默认选中第一个真实站点（跳过 ALL 全部站点），避免聚合负载过重
  const effectiveDefault =
    defaultValue ?? options.find((o) => o.value !== 'ALL')?.value ?? options[0]?.value

  useEffect(() => {
    if (autoSelectFirst && !value && effectiveDefault) {
      onChange(effectiveDefault)
    }
  }, [autoSelectFirst, value, effectiveDefault, onChange])

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        className={cn(
          // BLF-893：console 触发器统一 term 令牌 + 零圆角 + mono 字体。
          'h-9 border-term-border bg-term-bg font-mono text-xs leading-5 text-term-text shadow-none focus-visible:outline-none focus-visible:border-term-border-strong data-[state=open]:border-term-border-strong',
          triggerClassName
        )}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
