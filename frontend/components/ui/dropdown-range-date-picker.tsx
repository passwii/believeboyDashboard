"use client"

import type { DateRange } from "react-day-picker"

import { DateRangePicker } from "@/components/ui/date-picker"

export interface DropdownRangeDatePickerProps {
  value?: DateRange
  onChange?: (value?: DateRange) => void
  onApply?: () => void
  className?: string
  disabled?: boolean
}

function DropdownRangeDatePicker(props: DropdownRangeDatePickerProps) {
  return <DateRangePicker {...props} />
}

export { DropdownRangeDatePicker }
