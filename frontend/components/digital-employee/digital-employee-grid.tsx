'use client'

import type { DigitalEmployee } from '@/types/digital-employee'
import { DigitalEmployeeCard } from './digital-employee-card'
import { cn } from '@/lib/utils'

interface DigitalEmployeeGridProps {
  employees: DigitalEmployee[]
  onCardClick?: (id: number) => void
  taskMap?: Record<number, { task_name: string; progress_percent: number; current_step: string | null; status: string }>
}

export function DigitalEmployeeGrid({ employees, onCardClick, taskMap }: DigitalEmployeeGridProps) {
  return (
    <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
      {employees.map((emp) => (
        <DigitalEmployeeCard
          key={emp.id}
          employee={emp}
          onClick={onCardClick}
          currentTask={taskMap?.[emp.id]}
        />
      ))}
    </div>
  )
}
