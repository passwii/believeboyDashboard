'use client'

import * as React from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { DayPicker } from 'react-day-picker'
import { zhCN } from 'react-day-picker/locale'

import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'

export type CalendarProps = React.ComponentProps<typeof DayPicker>

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  components: userComponents,
  ...props
}: CalendarProps) {
  const defaultClassNames = {
    months: 'relative flex flex-col sm:flex-row gap-4',
    month: 'w-full',
    month_caption: 'relative mx-10 mb-1 flex h-9 items-center justify-center z-20',
    caption_label: 'text-sm font-medium',
    nav: 'absolute top-0 flex w-full justify-between z-10',
    button_previous: cn(
      buttonVariants({ variant: 'ghost' }),
      'size-9 text-muted-foreground/80 hover:text-foreground p-0'
    ),
    button_next: cn(
      buttonVariants({ variant: 'ghost' }),
      'size-9 text-muted-foreground/80 hover:text-foreground p-0'
    ),
    weekdays: 'grid grid-cols-7 text-center text-xs font-medium uppercase text-muted-foreground/80',
    weekday: 'py-1',
    week: 'grid grid-cols-7',
    day_button:
      'relative flex size-9 items-center justify-center rounded-full text-sm transition-all ' +
      'hover:bg-accent hover:text-accent-foreground ' +
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 ' +
      'group-data-[selected]:bg-primary group-data-[selected]:text-primary-foreground ' +
      'group-data-[selected]:shadow-md ' +
      'group-data-[disabled]:opacity-40 group-data-[disabled]:cursor-not-allowed group-data-[disabled]:hover:bg-transparent group-data-[disabled]:hover:text-muted-foreground/40',
    day: 'text-center',
    range_start:
      'rounded-full bg-primary text-primary-foreground shadow-md dark:bg-primary dark:text-primary-foreground',
    range_end:
      'rounded-full bg-primary text-primary-foreground shadow-md dark:bg-primary dark:text-primary-foreground',
    range_middle: 'bg-accent text-foreground rounded-none transition-colors',
    today:
      'after:absolute after:bottom-1 after:left-1/2 after:-translate-x-1/2 after:w-1.5 after:h-1.5 after:rounded-full after:bg-primary',
    outside: 'text-muted-foreground/50 hover:text-accent-foreground hover:bg-accent/30',
    hidden: 'invisible',
    week_number: 'size-9 p-0 text-xs font-medium text-muted-foreground/80',
  }

  const mergedClassNames = Object.keys(defaultClassNames).reduce(
    (acc, key) => ({
      ...acc,
      [key]: classNames?.[key as keyof typeof classNames]
        ? cn(
            defaultClassNames[key as keyof typeof defaultClassNames],
            classNames[key as keyof typeof classNames]
          )
        : defaultClassNames[key as keyof typeof defaultClassNames],
    }),
    {} as typeof defaultClassNames
  )

  const defaultComponents = {
    Chevron: ({ orientation, ...props }: any) => {
      const Icon = orientation === 'left' ? ChevronLeft : ChevronRight
      return <Icon size={18} strokeWidth={2} {...props} aria-hidden="true" />
    },
  }

  const mergedComponents = {
    ...defaultComponents,
    ...userComponents,
  }

  return (
    <DayPicker
      locale={zhCN}
      weekStartsOn={1}
      showOutsideDays={showOutsideDays}
      className={cn('w-fit p-3', className)}
      classNames={mergedClassNames}
      components={mergedComponents}
      {...props}
    />
  )
}

Calendar.displayName = 'Calendar'

export { Calendar }
