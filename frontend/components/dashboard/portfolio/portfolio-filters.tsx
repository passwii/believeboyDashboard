'use client'

import { useState, useEffect } from 'react'
import { Check, ChevronsUpDown, Search } from 'lucide-react'
import { useSession } from 'next-auth/react'
import { cn } from '@/lib/utils'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CountrySelect } from '@/components/dashboard/console'
import { DateRangePicker } from '@/components/ui/date-picker'
import type { DateRange } from 'react-day-picker'

interface PortfolioFiltersProps {
  projectIds: number[]
  onProjectIdsChange: (ids: number[]) => void
  country: string
  onCountryChange: (country: string) => void
  startDate: string
  onStartDateChange: (date: string) => void
  endDate: string
  onEndDateChange: (date: string) => void
  loading: boolean
}

type ProjectOption = { id: number; name: string }

export function PortfolioFilters({
  projectIds,
  onProjectIdsChange,
  country,
  onCountryChange,
  startDate,
  onStartDateChange,
  endDate,
  onEndDateChange,
  loading,
}: PortfolioFiltersProps) {
  const { data: session } = useSession()
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [loadingProjects, setLoadingProjects] = useState(true)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let active = true
    setLoadingProjects(true)
    void (async () => {
      try {
        const data = await fetchManagedProjectsCached<ProjectOption[]>(session)
        if (!active) return
        setProjects(data)
      } finally {
        if (active) setLoadingProjects(false)
      }
    })()
    return () => {
      active = false
    }
  }, [session])

  function toggleProject(id: number) {
    if (projectIds.includes(id)) {
      onProjectIdsChange(projectIds.filter((p) => p !== id))
    } else {
      onProjectIdsChange([...projectIds, id])
    }
  }

  function handleDateRangeChange(range: DateRange | undefined) {
    if (range?.from) onStartDateChange(range.from.toISOString().split('T')[0])
    else onStartDateChange('')
    if (range?.to) onEndDateChange(range.to.toISOString().split('T')[0])
    else onEndDateChange('')
  }

  function parseDate(str: string): Date | undefined {
    return str ? new Date(str) : undefined
  }

  const selectedProjects = projects.filter((p) => projectIds.includes(p.id))

  return (
    // BLF-614：手机端 2 列网格（总则 1 / 规则 2）——项目多选与日期范围占满整行，国家/刷新同行；
    // md+ 还原横向 flex 排列，桌面布局零回归。
    <div
      data-testid="portfolio-filter-controls"
      className="grid grid-cols-2 items-center gap-2 md:flex md:flex-wrap md:items-center md:gap-3"
    >
      {/* Multi-project selector */}
      <div className="col-span-2 w-full md:col-span-1 md:w-72">
        {loadingProjects ? (
          <Skeleton className="h-10 w-full rounded-none" />
        ) : (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                data-testid="portfolio-project-trigger"
                variant="outline"
                role="combobox"
                className={cn(
                  // BLF-893：portfolio 筛选终端化——零圆角、term 触发器基线（h-10）。
                  'h-10 w-full justify-between rounded-none border border-term-border bg-term-bg font-mono text-xs leading-5 text-term-text shadow-none hover:border-term-border-strong',
                  projectIds.length === 0 && 'text-term-muted'
                )}
              >
                {projectIds.length === 0 ? (
                  '选择项目（多选）'
                ) : (
                  <span className="flex flex-wrap gap-1 overflow-hidden">
                    {selectedProjects.length <= 3 ? (
                      selectedProjects.map((p) => (
                        <span
                          key={p.id}
                          className="inline-flex h-5 items-center rounded-none border border-term-border bg-term-panel px-1.5 font-mono text-[11px] leading-4 text-term-text"
                        >
                          {p.name}
                        </span>
                      ))
                    ) : (
                      <span className="inline-flex h-5 items-center rounded-none border border-term-border bg-term-panel px-1.5 font-mono text-[11px] leading-4 text-term-text">
                        已选 {selectedProjects.length} 个项目
                      </span>
                    )}
                  </span>
                )}
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-0" align="start">
              <Command>
                <CommandInput placeholder="搜索项目..." />
                <CommandList>
                  <CommandEmpty>未找到项目</CommandEmpty>
                  <CommandGroup>
                    {projects.map((p) => (
                      <CommandItem
                        key={p.id}
                        value={String(p.id)}
                        onSelect={() => toggleProject(p.id)}
                        className="cursor-pointer"
                      >
                        <Check
                          className={cn(
                            'mr-2 h-4 w-4',
                            projectIds.includes(p.id) ? 'opacity-100' : 'opacity-0'
                          )}
                        />
                        {p.name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        )}
      </div>

      <CountrySelect
        value={country}
        onChange={onCountryChange}
        triggerClassName="h-10 w-full md:h-9 md:w-auto"
      />

      <DateRangePicker
        value={
          startDate || endDate ? { from: parseDate(startDate), to: parseDate(endDate) } : undefined
        }
        onChange={handleDateRangeChange}
        className="col-span-2 h-10 w-full md:col-span-1 md:h-9 md:w-64"
        placeholder="日期范围"
      />

    </div>
  )
}
