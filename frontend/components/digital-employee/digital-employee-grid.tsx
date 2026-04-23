'use client'

import type { DigitalEmployee } from '@/types/digital-employee'
import { DigitalEmployeeCard } from './digital-employee-card'
import { cn } from '@/lib/utils'

interface DigitalEmployeeGridProps {
  employees: DigitalEmployee[]
  displayMode?: boolean
  onCardClick?: (id: number) => void
}

export function DigitalEmployeeGrid({ employees, displayMode = false, onCardClick }: DigitalEmployeeGridProps) {
  const columns = displayMode
    ? 'grid-cols-1 md:grid-cols-2'
    : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'

  return (
    <div className={cn('grid gap-4', columns)}>
      {employees.map((emp) => (
        <DigitalEmployeeCard
          key={emp.id}
          employee={emp}
          displayMode={displayMode}
          onClick={onCardClick}
        />
      ))}
    </div>
  )
}