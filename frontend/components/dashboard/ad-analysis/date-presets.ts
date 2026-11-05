import {
  endOfMonth,
  endOfQuarter,
  endOfWeek,
  endOfYear,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
  subDays,
  subWeeks,
} from 'date-fns'

import { COUNTRY_TIMEZONE_MAP } from '@/components/ui/date-picker'

export type AdAnalysisDatePresetKey =
  | 'today'
  | 'yesterday'
  | 'last-week'
  | 'last-month'
  | 'last-7-days'
  | 'last-14-days'
  | 'last-30-days'
  | 'last-90-days'
  | 'mtd'
  | 'qtd'
  | 'ytd'
  | 'last-quarter'
  | 'last-year'

export type AdAnalysisDatePreset = {
  key: AdAnalysisDatePresetKey
  label: string
  dateFrom: string
  dateTo: string
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function formatCalendarDate(value: Date) {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

function calendarDateInTimezone(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return new Date(Number(values.year), Number(values.month) - 1, Number(values.day))
}

export function isAdAnalysisDateInput(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(year, month - 1, day)
  return (
    parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === day
  )
}

export function buildAdAnalysisDatePresets(
  country: string,
  now: Date = new Date()
): AdAnalysisDatePreset[] {
  const timezone = COUNTRY_TIMEZONE_MAP[country] ?? 'UTC'
  const today = calendarDateInTimezone(now, timezone)
  const lastWeek = subWeeks(today, 1)
  const lastMonth = subDays(startOfMonth(today), 1)
  const lastQuarter = subDays(startOfQuarter(today), 1)
  const lastYear = subDays(startOfYear(today), 1)

  return [
    { key: 'today', label: '今天', from: today, to: today },
    { key: 'yesterday', label: '昨天', from: subDays(today, 1), to: subDays(today, 1) },
    {
      key: 'last-week',
      label: '上周',
      from: startOfWeek(lastWeek, { weekStartsOn: 1 }),
      to: endOfWeek(lastWeek, { weekStartsOn: 1 }),
    },
    { key: 'last-month', label: '上个月', from: startOfMonth(lastMonth), to: endOfMonth(lastMonth) },
    { key: 'last-7-days', label: '近7天', from: subDays(today, 6), to: today },
    { key: 'last-14-days', label: '近14天', from: subDays(today, 13), to: today },
    { key: 'last-30-days', label: '近30天', from: subDays(today, 29), to: today },
    { key: 'last-90-days', label: '近90天', from: subDays(today, 89), to: today },
    { key: 'mtd', label: '本月至今', from: startOfMonth(today), to: today },
    { key: 'qtd', label: '本季度至今', from: startOfQuarter(today), to: today },
    { key: 'ytd', label: '本年度至今', from: startOfYear(today), to: today },
    {
      key: 'last-quarter',
      label: '上个季度',
      from: startOfQuarter(lastQuarter),
      to: endOfQuarter(lastQuarter),
    },
    { key: 'last-year', label: '上年度', from: startOfYear(lastYear), to: endOfYear(lastYear) },
  ].map(({ key, label, from, to }) => ({
    key: key as AdAnalysisDatePresetKey,
    label,
    dateFrom: formatCalendarDate(from),
    dateTo: formatCalendarDate(to),
  }))
}

export function activeAdAnalysisDatePreset(
  presets: AdAnalysisDatePreset[],
  dateFrom: string,
  dateTo: string
) {
  return presets.find((preset) => preset.dateFrom === dateFrom && preset.dateTo === dateTo)?.key
}
