'use client'

import type { DateRange } from 'react-day-picker'

import { DateRangePicker, type DateRangePickerChangeMeta } from '@/components/ui/date-picker'

export interface DropdownRangeDatePickerProps {
  value?: DateRange
  onChange?: (value?: DateRange, meta?: DateRangePickerChangeMeta) => void
  onApply?: () => void
  className?: string
  disabled?: boolean
}

function DropdownRangeDatePicker(props: DropdownRangeDatePickerProps) {
  return <DateRangePicker {...props} />
}

export { DropdownRangeDatePicker }
