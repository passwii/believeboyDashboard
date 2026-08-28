'use client'

import * as React from 'react'
import { format } from 'date-fns'
import { Calendar as CalendarIcon } from 'lucide-react'
import type { DateRange } from 'react-day-picker'
import { useRef, useEffect, useState } from 'react'
import {
  subDays,
  subWeeks,
  startOfMonth,
  endOfMonth,
  startOfQuarter,
  endOfQuarter,
  startOfYear,
  endOfYear,
  startOfWeek,
  endOfWeek,
} from 'date-fns'

import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar-with-presets'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

// Country → IANA timezone mapping (matches backend interpretation)
export const COUNTRY_TIMEZONE_MAP: Record<string, string> = {
  US: 'America/Los_Angeles',
  DE: 'Europe/Berlin',
  UK: 'Europe/London',
}

/**
 * Returns today's calendar date as a Date object, calculated in the country's timezone.
 * This ensures "today" means the same calendar day as seen by the marketplace,
 * not the user's browser local time.
 */
export function getTodayInTimezone(tz: string): Date {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz }) // YYYY-MM-DD in target TZ
  const now = new Date()
  const [y, m, d] = formatter.format(now).split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

export type DatePickerMode = 'single' | 'range' | 'month'

type SharedDatePickerProps = {
  placeholder?: string
  className?: string
  disabled?: boolean
  fromDate?: Date
  toDate?: Date
  onApply?: () => void
  clearable?: boolean
  /** IANA timezone string (e.g. "America/Los_Angeles") for timezone-aware preset calculations. Defaults to browser local. */
  timezone?: string
}

type SingleDatePickerProps = SharedDatePickerProps & {
  mode?: 'single'
  value?: Date
  onChange?: (date?: Date) => void
}

/**
 * 第二个 onChange 参数 meta：调用方用来区分"用户点了 preset"和"手动选了日期"。
 *  - presetKey：触发的 preset 标签（与 buildPresets() 的 key 同名），手动选日期时为 undefined。
 */
export type DateRangePickerChangeMeta = { presetKey?: string }

type RangeDatePickerProps = SharedDatePickerProps & {
  mode: 'range'
  value?: DateRange
  onChange?: (range?: DateRange, meta?: DateRangePickerChangeMeta) => void
}

type MonthPickerProps = SharedDatePickerProps & {
  mode: 'month'
  value?: Date
  onChange?: (date?: Date) => void
}

export type DatePickerProps = SingleDatePickerProps | RangeDatePickerProps | MonthPickerProps

function safeDate(year: number, month: number, day: number) {
  const parsed = new Date(year, month - 1, day)
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return undefined
  }
  return parsed
}

export function parseDateInputValue(value?: string | null) {
  if (!value) return undefined
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return undefined
  return safeDate(year, month, day)
}

export function formatDateInputValue(value?: Date | null) {
  return value ? format(value, 'yyyy-MM-dd') : ''
}

export function parseMonthInputValue(value?: string | null) {
  if (!value) return undefined
  const [year, month] = value.split('-').map(Number)
  if (!year || !month) return undefined
  return safeDate(year, month, 1)
}

export function formatMonthInputValue(value?: Date | null) {
  return value ? format(value, 'yyyy-MM') : ''
}

export function parseDateRangeInputValue(from?: string | null, to?: string | null) {
  const start = parseDateInputValue(from)
  const end = parseDateInputValue(to)
  if (!start && !end) return undefined
  return {
    from: start,
    to: end,
  } satisfies DateRange
}

// Build Chinese presets using the specified timezone (or browser local if undefined)
function buildPresets(today: Date) {
  const lastWeekStart = startOfWeek(subWeeks(today, 1), { weekStartsOn: 1 })
  const lastWeekEnd = endOfWeek(subWeeks(today, 1), { weekStartsOn: 1 })
  const lastMonthStart = startOfMonth(subDays(startOfMonth(today), 1))
  const lastMonthEnd = endOfMonth(subDays(startOfMonth(today), 1))
  return {
    今天: { from: today, to: today },
    昨天: { from: subDays(today, 1), to: subDays(today, 1) },
    上周: { from: lastWeekStart, to: lastWeekEnd },
    上个月: { from: lastMonthStart, to: lastMonthEnd },
    近7天: { from: subDays(today, 6), to: today },
    近14天: { from: subDays(today, 13), to: today },
    近30天: { from: subDays(today, 29), to: today },
    近90天: { from: subDays(today, 89), to: today },
    本月至今: { from: startOfMonth(today), to: today },
    本季度至今: { from: startOfQuarter(today), to: today },
    本年度至今: { from: startOfYear(today), to: today },
    上个季度: {
      from: startOfQuarter(subDays(startOfQuarter(today), 1)),
      to: endOfQuarter(subDays(startOfQuarter(today), 1)),
    },
    上年度: {
      from: startOfYear(subDays(startOfYear(today), 1)),
      to: endOfYear(subDays(startOfYear(today), 1)),
    },
  } as Record<string, { from: Date; to: Date }>
}

function usePresets(timezone?: string) {
  const tz = timezone ?? 'UTC'
  return React.useMemo(() => {
    const today = getTodayInTimezone(tz)
    return buildPresets(today)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz])
}

function formatTriggerValue(mode: DatePickerMode, value?: Date | DateRange, placeholder?: string) {
  if (mode === 'range') {
    const range = value as DateRange | undefined
    if (range?.from && range?.to) {
      return `${format(range.from, 'yyyy-MM-dd')} ~ ${format(range.to, 'yyyy-MM-dd')}`
    }
    if (range?.from) {
      return format(range.from, 'yyyy-MM-dd')
    }
    return placeholder ?? '选择日期范围'
  }

  const date = value as Date | undefined
  if (mode === 'month') {
    return date ? format(date, 'yyyy-MM') : (placeholder ?? '选择月份')
  }
  return date ? format(date, 'yyyy-MM-dd') : (placeholder ?? '选择日期')
}

function resolveAnchorDate(mode: DatePickerMode, value?: Date | DateRange) {
  if (mode === 'range') {
    const range = value as DateRange | undefined
    return range?.from ?? range?.to
  }
  return value as Date | undefined
}

const calendarClassNames = {
  months: 'flex w-full flex-col',
  month: 'w-full min-w-0',
  month_grid: 'w-full border-collapse',
  month_caption: 'relative mx-10 mb-2 flex h-8 items-center justify-center',
  caption_label: 'font-mono text-sm font-medium text-term-text tracking-[0.02em]',
  nav: 'absolute top-0 flex w-full justify-between',
  weekdays: 'grid w-full grid-cols-7 gap-1',
  weeks: 'w-full',
  weekday: 'h-9 w-full p-0 font-mono text-xs font-medium text-term-muted',
  week: 'mt-1 grid w-full grid-cols-7 gap-1',
  day: 'h-10 w-full px-0 font-mono text-sm',
  day_button:
    'relative flex h-10 w-full items-center justify-center rounded-none p-0 font-mono text-sm text-term-text outline-offset-2 transition-[color,background-color,box-shadow] duration-150 focus:outline-none hover:bg-term-hover group-data-[selected]:bg-primary group-data-[selected]:text-primary-foreground group-data-[selected]:shadow-none group-data-[disabled]:pointer-events-none group-data-[disabled]:text-term-faint group-data-[disabled]:line-through group-data-[outside]:text-term-faint group-data-[outside]:group-data-[selected]:text-primary-foreground group-[.range-start:not(.range-end)]:rounded-none group-[.range-end:not(.range-start)]:rounded-none group-[.range-middle]:rounded-none group-data-[selected]:group-[.range-middle]:bg-term-hover group-data-[selected]:group-[.range-middle]:text-term-text',
}

export function DatePicker(props: DatePickerProps) {
  const {
    mode = 'single',
    value,
    onChange,
    onApply,
    placeholder,
    className,
    disabled = false,
    fromDate,
    toDate,
    clearable = true,
    timezone,
  } = props

  const today = new Date()
  const [open, setOpen] = React.useState(false)
  const [internalValue, setInternalValue] = React.useState<Date | DateRange | undefined>(value)
  const [month, setMonth] = React.useState(today.getMonth())
  const [year, setYear] = React.useState(today.getFullYear())

  const presets = usePresets(timezone)

  React.useEffect(() => {
    setInternalValue(value)
  }, [value])

  const currentValue = value !== undefined ? value : internalValue

  React.useEffect(() => {
    const anchorDate = resolveAnchorDate(mode, currentValue)
    if (!anchorDate) return
    setMonth(anchorDate.getMonth())
    setYear(anchorDate.getFullYear())
  }, [currentValue, mode])

  const displayMonth = new Date(year, month, 1)
  const triggerLabel = formatTriggerValue(mode, currentValue, placeholder)
  const hasValue =
    mode === 'range'
      ? Boolean(
          (currentValue as DateRange | undefined)?.from ||
            (currentValue as DateRange | undefined)?.to
        )
      : Boolean(currentValue)

  const handleSingleSelect = (selected?: Date) => {
    setInternalValue(selected)
    ;(onChange as ((date?: Date) => void) | undefined)?.(selected)
  }

  const handleRangeSelect = (selected?: DateRange) => {
    setInternalValue(selected)
    ;(onChange as ((range?: DateRange) => void) | undefined)?.(selected)
  }

  const handleApply = () => {
    if (mode === 'range') {
      ;(onChange as ((range?: DateRange) => void) | undefined)?.(
        internalValue as DateRange | undefined
      )
    } else {
      ;(onChange as ((date?: Date) => void) | undefined)?.(internalValue as Date | undefined)
    }
    onApply?.()
    setOpen(false)
  }

  const handleClear = () => {
    setInternalValue(undefined)
    if (mode === 'range') {
      ;(onChange as ((range?: DateRange) => void) | undefined)?.(undefined)
      return
    }
    ;(onChange as ((date?: Date) => void) | undefined)?.(undefined)
  }

  // For range mode, render the preset calendar
  if (mode === 'range') {
    return (
      <RangeDatePickerWithPresets
        value={value as DateRange | undefined}
        onChange={
          onChange as ((range?: DateRange, meta?: DateRangePickerChangeMeta) => void) | undefined
        }
        onApply={onApply}
        className={className}
        disabled={disabled}
        presets={presets}
        timezone={timezone}
      />
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn('h-8 w-full justify-start rounded-none border border-term-border bg-term-bg text-left font-mono text-sm leading-5 text-term-text shadow-none focus-visible:border-term-border-strong u-focus-glow', className)}
          disabled={disabled}
        >
          <CalendarIcon className="mr-2 h-4 w-4 shrink-0 text-term-muted" />
          <span className="truncate overflow-hidden">{triggerLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[320px] rounded-none border border-term-border bg-term-panel p-4 text-term-text shadow-none"
        align="start"
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Select
              value={year.toString()}
              onValueChange={(nextValue) => setYear(Number(nextValue))}
            >
              <SelectTrigger className="h-8 w-full rounded-none border border-term-border bg-term-bg font-mono text-sm shadow-none">
                <SelectValue placeholder="Year" />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 40 }, (_, index) => year - 20 + index).map((item) => (
                  <SelectItem key={item} value={item.toString()}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={month.toString()}
              onValueChange={(nextValue) => setMonth(Number(nextValue))}
            >
              <SelectTrigger className="h-8 w-full rounded-none border border-term-border bg-term-bg font-mono text-sm shadow-none">
                <SelectValue placeholder="Month" />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 12 }, (_, index) => (
                  <SelectItem key={index} value={index.toString()}>
                    {`${String(index + 1).padStart(2, '0')}月`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {mode === 'month' ? (
            <div className="grid grid-cols-3 gap-2 rounded-none border border-term-border bg-term-raised p-3">
              {Array.from({ length: 12 }, (_, index) => {
                const candidate = new Date(year, index, 1)
                const isSelected =
                  currentValue instanceof Date &&
                  currentValue.getFullYear() === year &&
                  currentValue.getMonth() === index
                const minMonth = fromDate
                  ? new Date(fromDate.getFullYear(), fromDate.getMonth(), 1)
                  : undefined
                const maxMonth = toDate
                  ? new Date(toDate.getFullYear(), toDate.getMonth(), 1)
                  : undefined
                const isDisabled =
                  (minMonth && candidate < minMonth) || (maxMonth && candidate > maxMonth)

                return (
                  <Button
                    key={index}
                    type="button"
                    variant={isSelected ? 'default' : 'outline'}
                    className={cn(
                      'h-8 rounded-none border-term-border px-0 font-mono text-sm shadow-none',
                      !isSelected && 'bg-term-panel hover:bg-term-hover'
                    )}
                    disabled={Boolean(isDisabled)}
                    onClick={() => {
                      setMonth(index)
                      handleSingleSelect(candidate)
                    }}
                  >
                    {`${String(index + 1).padStart(2, '0')}月`}
                  </Button>
                )
              })}
            </div>
          ) : (
            <Calendar
              mode="single"
              month={displayMonth}
              onMonthChange={(date) => {
                setMonth(date.getMonth())
                setYear(date.getFullYear())
              }}
              selected={currentValue as Date | undefined}
              onSelect={handleSingleSelect}
              fromDate={fromDate}
              toDate={toDate}
              className="w-full min-w-0 rounded-none border border-term-border bg-term-raised p-3"
              classNames={calendarClassNames}
            />
          )}

          <div className="flex items-center justify-between border-t border-term-border pt-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-8 rounded-none px-3 font-mono"
              onClick={handleClear}
              disabled={!clearable || !hasValue}
            >
              清除
            </Button>
            <Button
              size="sm"
              className="h-8 rounded-none px-4 font-mono"
              onClick={handleApply}
              disabled={!hasValue}
            >
              完成
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// Range DatePicker with presets
interface RangeDatePickerWithPresetsProps {
  value?: DateRange
  onChange?: (range?: DateRange, meta?: DateRangePickerChangeMeta) => void
  onApply?: () => void
  className?: string
  disabled?: boolean
  presets: Record<string, { from: Date; to: Date }>
  timezone?: string
}

function RangeDatePickerWithPresets({
  value,
  onChange,
  onApply,
  className,
  disabled,
  presets,
  timezone,
}: RangeDatePickerWithPresetsProps) {
  const tz = timezone ?? 'UTC'
  const todayInTz = getTodayInTimezone(tz)
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState<DateRange | undefined>(value || presets['近7天'])
  const [month, setMonth] = useState<Date>(value?.to ?? todayInTz)

  // Sync with external value
  useEffect(() => {
    if (value) {
      setDate(value)
      if (value.to) setMonth(value.to)
    }
  }, [value])

  // Dynamic height lock (presets sidebar matches calendar height)
  const calendarRef = useRef<HTMLDivElement>(null)
  const [calendarHeight, setCalendarHeight] = useState<number>(0)

  useEffect(() => {
    if (calendarRef.current) {
      setCalendarHeight(calendarRef.current.offsetHeight)
    }
  }, [month])

  const handlePresetClick = (preset: { from: Date; to: Date }, presetKey: string) => {
    setDate(preset)
    setMonth(preset.to)
    onChange?.(preset, { presetKey })
  }

  const handleDateSelect = (selected?: DateRange) => {
    setDate(selected)
    onChange?.(selected, undefined)
  }

  const triggerLabel =
    date?.from && date?.to
      ? `${format(date.from, 'yyyy-MM-dd')} ~ ${format(date.to, 'yyyy-MM-dd')}`
      : date?.from
        ? format(date.from, 'yyyy-MM-dd')
        : '选择日期范围'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn('h-8 w-full justify-start rounded-none border border-term-border bg-term-bg text-left font-mono text-sm leading-5 text-term-text shadow-none focus-visible:border-term-border-strong u-focus-glow', className)}
          disabled={disabled}
        >
          <CalendarIcon className="mr-2 h-4 w-4 shrink-0 text-term-muted" />
          <span className="truncate overflow-hidden">{triggerLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto max-h-[460px] rounded-none border border-term-border bg-term-panel p-0 text-term-text shadow-none"
        align="start"
      >
        <div className="flex max-sm:flex-col max-h-[420px]">
          {/* Sidebar Presets with Scroll */}
          <div
            className="sm:w-44 border-r border-term-border pr-2 max-sm:border-b max-sm:mb-2 overflow-y-auto shrink-0 term-scroll"
            style={{ maxHeight: Math.max(calendarHeight, 300) }}
          >
            <div className="flex flex-col gap-1 py-2">
              {Object.entries(presets).map(([label, range]) => {
                const isActive =
                  date?.from?.toDateString() === range.from.toDateString() &&
                  date?.to?.toDateString() === range.to.toDateString()
                return (
                  <Button
                    key={label}
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'justify-start w-full rounded-none text-xs',
                      isActive && 'bg-term-hover text-term-text font-medium'
                    )}
                    onClick={() => handlePresetClick(range, label)}
                  >
                    {label}
                  </Button>
                )
              })}
            </div>
          </div>

          <Separator orientation="vertical" className="sm:hidden my-2 bg-term-border" />

          {/* Calendar */}
          <div className="flex-1 flex justify-center min-w-0" ref={calendarRef}>
            <Calendar
              mode="range"
              month={month}
              onMonthChange={setMonth}
              selected={date}
              onSelect={handleDateSelect}
              className="bg-transparent p-2"
              disabled={[{ after: todayInTz }]}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// Single DatePicker with presets (reuses the same component)
interface SingleDatePickerWithPresetsProps {
  value?: Date
  onChange?: (date?: Date) => void
  onApply?: () => void
  className?: string
  disabled?: boolean
  fromDate?: Date
  toDate?: Date
  timezone?: string
}

function SingleDatePickerWithPresets({
  value,
  onChange,
  onApply,
  className,
  disabled,
  fromDate,
  toDate,
  timezone,
}: SingleDatePickerWithPresetsProps) {
  const tz = timezone ?? 'UTC'
  const todayInTz = getTodayInTimezone(tz)
  const [open, setOpen] = useState(false)
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(value)
  const [month, setMonth] = useState<Date>(value ?? todayInTz)

  // Sync with external value
  useEffect(() => {
    setSelectedDate(value)
    if (value) setMonth(value)
  }, [value])

  const calendarRef = useRef<HTMLDivElement>(null)
  const [calendarHeight, setCalendarHeight] = useState<number>(0)

  useEffect(() => {
    if (calendarRef.current) {
      setCalendarHeight(calendarRef.current.offsetHeight)
    }
  }, [month])

  const presets = usePresets(timezone)

  const handlePresetClick = (preset: { from: Date; to: Date }) => {
    setSelectedDate(preset.from)
    setMonth(preset.from)
    onChange?.(preset.from)
    onApply?.()
    setOpen(false)
  }

  const handleDateSelect = (selected?: Date) => {
    setSelectedDate(selected)
    onChange?.(selected)
    onApply?.()
    setOpen(false)
  }

  const triggerLabel = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : '选择日期'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn('h-8 w-full justify-start rounded-none border border-term-border bg-term-bg text-left font-mono text-sm leading-5 text-term-text shadow-none focus-visible:border-term-border-strong u-focus-glow', className)}
          disabled={disabled}
        >
          <CalendarIcon className="mr-2 h-4 w-4 shrink-0 text-term-muted" />
          <span className="truncate overflow-hidden">{triggerLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto max-h-[460px] rounded-none border border-term-border bg-term-panel p-0 text-term-text shadow-none"
        align="start"
      >
        <div className="flex max-sm:flex-col max-h-[420px]">
          {/* Sidebar Presets with Scroll */}
          <div
            className="sm:w-44 border-r border-term-border pr-2 max-sm:border-b max-sm:mb-2 overflow-y-auto shrink-0 term-scroll"
            style={{ maxHeight: Math.max(calendarHeight, 300) }}
          >
            <div className="flex flex-col gap-1 py-2">
              {Object.entries(presets).map(([label, range]) => {
                const isActive = selectedDate?.toDateString() === range.from.toDateString()
                return (
                  <Button
                    key={label}
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'justify-start w-full rounded-none font-mono text-xs',
                      isActive && 'bg-term-hover text-term-text font-medium'
                    )}
                    onClick={() => handlePresetClick(range)}
                  >
                    {label}
                  </Button>
                )
              })}
            </div>
          </div>

          <Separator orientation="vertical" className="sm:hidden my-2 bg-term-border" />

          {/* Calendar */}
          <div className="flex-1 flex justify-center min-w-0" ref={calendarRef}>
            <Calendar
              mode="single"
              month={month}
              onMonthChange={setMonth}
              selected={selectedDate}
              onSelect={handleDateSelect}
              className="bg-transparent p-2"
              fromDate={fromDate}
              toDate={toDate ?? todayInTz}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// Simple SingleDatePicker without presets sidebar
interface SimpleDatePickerProps {
  value?: Date
  onChange?: (date?: Date) => void
  className?: string
  disabled?: boolean
  fromDate?: Date
  toDate?: Date
}

function SimpleDatePickerInternal({
  value,
  onChange,
  className,
  disabled,
  fromDate,
  toDate,
}: SimpleDatePickerProps) {
  const today = new Date()
  const [open, setOpen] = useState(false)
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(value)
  const [month, setMonth] = useState<Date>(value ?? today)

  // Sync with external value
  useEffect(() => {
    setSelectedDate(value)
    if (value) setMonth(value)
  }, [value])

  const handleDateSelect = (selected?: Date) => {
    setSelectedDate(selected)
    onChange?.(selected)
    setOpen(false)
  }

  const triggerLabel = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : '选择日期'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn('h-8 rounded-none border border-term-border bg-term-bg px-2 justify-start text-left font-mono text-xs leading-4 text-term-text shadow-none focus-visible:border-term-border-strong u-focus-glow', className)}
          disabled={disabled}
        >
          <CalendarIcon className="mr-1.5 h-3.5 w-3.5 shrink-0 text-term-muted" />
          <span
            className={cn('text-xs', selectedDate ? 'text-term-text' : 'text-term-faint')}
          >
            {triggerLabel}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto rounded-none border border-term-border bg-term-panel p-3 text-term-text shadow-none"
        align="start"
        side="bottom"
      >
        <div className="flex justify-center min-w-0">
          <Calendar
            mode="single"
            month={month}
            onMonthChange={setMonth}
            selected={selectedDate}
            onSelect={handleDateSelect}
            className="bg-transparent p-0"
            fromDate={fromDate}
            toDate={toDate}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

export { SimpleDatePickerInternal as SimpleDatePicker }

export function SingleDatePicker(props: Omit<SingleDatePickerProps, 'mode'>) {
  return <SingleDatePickerWithPresets {...props} timezone={props.timezone} />
}

export function DateRangePicker(props: Omit<RangeDatePickerProps, 'mode'>) {
  return <DatePicker {...props} mode="range" />
}

export function MonthPicker(props: Omit<MonthPickerProps, 'mode'>) {
  return <DatePicker {...props} mode="month" />
}
