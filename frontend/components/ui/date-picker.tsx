"use client"

import * as React from "react"
import { format } from "date-fns"
import { Calendar as CalendarIcon } from "lucide-react"
import type { DateRange } from "react-day-picker"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

export type DatePickerMode = "single" | "range" | "month"

type SharedDatePickerProps = {
  placeholder?: string
  className?: string
  disabled?: boolean
  fromDate?: Date
  toDate?: Date
  onApply?: () => void
  clearable?: boolean
}

type SingleDatePickerProps = SharedDatePickerProps & {
  mode?: "single"
  value?: Date
  onChange?: (date?: Date) => void
}

type RangeDatePickerProps = SharedDatePickerProps & {
  mode: "range"
  value?: DateRange
  onChange?: (range?: DateRange) => void
}

type MonthPickerProps = SharedDatePickerProps & {
  mode: "month"
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
  const [year, month, day] = value.split("-").map(Number)
  if (!year || !month || !day) return undefined
  return safeDate(year, month, day)
}

export function formatDateInputValue(value?: Date | null) {
  return value ? format(value, "yyyy-MM-dd") : ""
}

export function parseMonthInputValue(value?: string | null) {
  if (!value) return undefined
  const [year, month] = value.split("-").map(Number)
  if (!year || !month) return undefined
  return safeDate(year, month, 1)
}

export function formatMonthInputValue(value?: Date | null) {
  return value ? format(value, "yyyy-MM") : ""
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

function formatTriggerValue(mode: DatePickerMode, value?: Date | DateRange, placeholder?: string) {
  if (mode === "range") {
    const range = value as DateRange | undefined
    if (range?.from && range?.to) {
      return `${format(range.from, "yyyy-MM-dd")} ~ ${format(range.to, "yyyy-MM-dd")}`
    }
    if (range?.from) {
      return format(range.from, "yyyy-MM-dd")
    }
    return placeholder ?? "选择日期范围"
  }

  const date = value as Date | undefined
  if (mode === "month") {
    return date ? format(date, "yyyy-MM") : (placeholder ?? "选择月份")
  }
  return date ? format(date, "yyyy-MM-dd") : (placeholder ?? "选择日期")
}

function resolveAnchorDate(mode: DatePickerMode, value?: Date | DateRange) {
  if (mode === "range") {
    const range = value as DateRange | undefined
    return range?.from ?? range?.to
  }
  return value as Date | undefined
}

const calendarClassNames = {
  months: "flex w-full flex-col",
  month: "w-full min-w-0",
  month_grid: "w-full border-collapse",
  month_caption: "relative mx-10 mb-2 flex h-9 items-center justify-center",
  caption_label: "text-sm font-semibold tracking-[0.02em]",
  nav: "absolute top-0 flex w-full justify-between",
  weekdays: "grid w-full grid-cols-7 gap-1",
  weeks: "w-full",
  weekday: "h-9 w-full p-0 text-xs font-medium text-muted-foreground/80",
  week: "mt-1 grid w-full grid-cols-7 gap-1",
  day: "h-10 w-full px-0 text-sm",
  day_button:
    "relative flex h-10 w-full items-center justify-center rounded-xl p-0 text-foreground outline-offset-2 transition-[color,background-color,box-shadow,border-radius] duration-150 focus:outline-none hover:bg-accent group-data-[selected]:bg-primary group-data-[selected]:text-primary-foreground group-data-[selected]:shadow-sm group-data-[disabled]:pointer-events-none group-data-[disabled]:text-foreground/30 group-data-[disabled]:line-through group-data-[outside]:text-foreground/30 group-data-[outside]:group-data-[selected]:text-primary-foreground group-[.range-start:not(.range-end)]:rounded-r-md group-[.range-end:not(.range-start)]:rounded-l-md group-[.range-middle]:rounded-md group-data-[selected]:group-[.range-middle]:bg-accent group-data-[selected]:group-[.range-middle]:text-foreground",
}

export function DatePicker(props: DatePickerProps) {
  const {
    mode = "single",
    value,
    onChange,
    onApply,
    placeholder,
    className,
    disabled = false,
    fromDate,
    toDate,
    clearable = true,
  } = props

  const today = new Date()
  const [open, setOpen] = React.useState(false)
  const [internalValue, setInternalValue] = React.useState<Date | DateRange | undefined>(value)
  const [month, setMonth] = React.useState(today.getMonth())
  const [year, setYear] = React.useState(today.getFullYear())

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
  const hasValue = mode === "range"
    ? Boolean((currentValue as DateRange | undefined)?.from || (currentValue as DateRange | undefined)?.to)
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
    if (mode === "range") {
      ;(onChange as ((range?: DateRange) => void) | undefined)?.(internalValue as DateRange | undefined)
    } else {
      ;(onChange as ((date?: Date) => void) | undefined)?.(internalValue as Date | undefined)
    }
    onApply?.()
    setOpen(false)
  }

  const handleClear = () => {
    setInternalValue(undefined)
    if (mode === "range") {
      ;(onChange as ((range?: DateRange) => void) | undefined)?.(undefined)
      return
    }
    ;(onChange as ((date?: Date) => void) | undefined)?.(undefined)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn("h-10 w-full justify-start text-left font-normal", className)}
          disabled={disabled}
        >
          <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
          <span className="truncate overflow-hidden">{triggerLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className={cn(
          "rounded-2xl border border-border/70 bg-background/95 p-4 shadow-xl backdrop-blur-sm",
          mode === "range" ? "w-[380px]" : "w-[320px]",
        )}
        align="start"
      >
        <div className="space-y-3">
          <div className={cn("grid gap-3", mode === "month" ? "grid-cols-1" : "grid-cols-2")}>
            <Select value={year.toString()} onValueChange={(nextValue) => setYear(Number(nextValue))}>
              <SelectTrigger className="h-10 w-full rounded-xl border-border/70 bg-muted/20">
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

            {mode !== "month" ? (
              <Select value={month.toString()} onValueChange={(nextValue) => setMonth(Number(nextValue))}>
                <SelectTrigger className="h-10 w-full rounded-xl border-border/70 bg-muted/20">
                  <SelectValue placeholder="Month" />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 12 }, (_, index) => (
                    <SelectItem key={index} value={index.toString()}>
                      {`${String(index + 1).padStart(2, "0")}月`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>

          {mode === "month" ? (
            <div className="grid grid-cols-3 gap-2 rounded-2xl border border-border/70 bg-muted/10 p-3">
              {Array.from({ length: 12 }, (_, index) => {
                const candidate = new Date(year, index, 1)
                const isSelected =
                  currentValue instanceof Date &&
                  currentValue.getFullYear() === year &&
                  currentValue.getMonth() === index
                const minMonth = fromDate ? new Date(fromDate.getFullYear(), fromDate.getMonth(), 1) : undefined
                const maxMonth = toDate ? new Date(toDate.getFullYear(), toDate.getMonth(), 1) : undefined
                const isDisabled = (minMonth && candidate < minMonth) || (maxMonth && candidate > maxMonth)

                return (
                  <Button
                    key={index}
                    type="button"
                    variant={isSelected ? "default" : "outline"}
                    className={cn(
                      "h-11 rounded-xl border-border/70 px-0",
                      !isSelected && "bg-background/80 hover:bg-accent",
                    )}
                    disabled={Boolean(isDisabled)}
                    onClick={() => {
                      setMonth(index)
                      handleSingleSelect(candidate)
                    }}
                  >
                    {`${String(index + 1).padStart(2, "0")}月`}
                  </Button>
                )
              })}
            </div>
          ) : mode === "range" ? (
            <Calendar
              mode="range"
              month={displayMonth}
              onMonthChange={(date) => {
                setMonth(date.getMonth())
                setYear(date.getFullYear())
              }}
              selected={currentValue as DateRange | undefined}
              onSelect={handleRangeSelect}
              fromDate={fromDate}
              toDate={toDate}
              className="w-full min-w-0 rounded-2xl border border-border/70 bg-muted/10 p-3"
              classNames={calendarClassNames}
            />
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
              className="w-full min-w-0 rounded-2xl border border-border/70 bg-muted/10 p-3"
              classNames={calendarClassNames}
            />
          )}

          <div className="flex items-center justify-between border-t border-border/60 pt-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-9 rounded-lg px-3"
              onClick={handleClear}
              disabled={!clearable || !hasValue}
            >
              清除
            </Button>
            <Button
              size="sm"
              className="h-9 rounded-lg px-4"
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

export function SingleDatePicker(props: Omit<SingleDatePickerProps, "mode">) {
  return <DatePicker {...props} mode="single" />
}

export function DateRangePicker(props: Omit<RangeDatePickerProps, "mode">) {
  return <DatePicker {...props} mode="range" />
}

export function MonthPicker(props: Omit<MonthPickerProps, "mode">) {
  return <DatePicker {...props} mode="month" />
}
