'use client'

import { useState, useEffect } from 'react'
import { Check, ChevronsUpDown, Loader2, Search } from 'lucide-react'
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Badge } from '@/components/ui/badge'
import { CountrySelect } from '@/components/dashboard/console'
import { RefreshButton } from '@/components/dashboard/console'
import { DateRangePicker } from '@/components/ui/date-picker'
import type { DateRange } from 'react-day-picker'
import { useRouter } from 'next/navigation'

interface PortfolioFiltersProps {
  projectIds: number[]
  onProjectIdsChange: (ids: number[]) => void
  country: string
  onCountryChange: (country: string) => void
  startDate: string
  onStartDateChange: (date: string) => void
  endDate: string
  onEndDateChange: (date: string) => void
  onRefresh: () => void
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
  onRefresh,
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
    return () => { active = false }
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
    <div className='flex flex-wrap items-center gap-3'>
      {/* Multi-project selector */}
      <div className='w-72'>
        {loadingProjects ? (
          <Skeleton className='h-10 w-full rounded-lg' />
        ) : (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                variant='outline'
                role='combobox'
                className={cn(
                  'h-10 w-full justify-between font-normal',
                  projectIds.length === 0 && 'text-muted-foreground'
                )}
              >
                {projectIds.length === 0 ? (
                  '选择项目（多选）'
                ) : (
                  <span className='flex flex-wrap gap-1 overflow-hidden'>
                    {selectedProjects.length <= 3 ? (
                      selectedProjects.map((p) => (
                        <Badge key={p.id} variant='secondary' className='h-5 text-xs'>
                          {p.name}
                        </Badge>
                      ))
                    ) : (
                      <Badge variant='secondary' className='h-5 text-xs'>
                        已选 {selectedProjects.length} 个项目
                      </Badge>
                    )}
                  </span>
                )}
                <ChevronsUpDown className='ml-2 h-4 w-4 shrink-0 opacity-50' />
              </Button>
            </PopoverTrigger>
            <PopoverContent className='w-72 p-0' align='start'>
              <Command>
                <CommandInput placeholder='搜索项目...' />
                <CommandList>
                  <CommandEmpty>未找到项目</CommandEmpty>
                  <CommandGroup>
                    {projects.map((p) => (
                      <CommandItem
                        key={p.id}
                        value={String(p.id)}
                        onSelect={() => toggleProject(p.id)}
                        className='cursor-pointer'
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

      <CountrySelect value={country} onChange={onCountryChange} />

      <DateRangePicker
        value={
          startDate || endDate
            ? { from: parseDate(startDate), to: parseDate(endDate) }
            : undefined
        }
        onChange={handleDateRangeChange}
        className='w-64'
        placeholder='日期范围'
      />

      <RefreshButton onClick={onRefresh} loading={loading} />
    </div>
  )
}