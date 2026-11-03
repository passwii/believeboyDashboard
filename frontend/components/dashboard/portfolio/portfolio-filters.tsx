'use client'

import { useEffect, useId, useState } from 'react'
import { ChevronsUpDown, Search } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  COUNTRY_TIMEZONE_MAP,
  DateRangePicker,
  formatDateInputValue,
  parseDateRangeInputValue,
} from '@/components/ui/date-picker'
import { COUNTRY_OPTIONS } from '@/lib/console-constants'
import { WarmSelect } from '@/components/dashboard-v2/warm-ledger/controls'
import type { DateRange } from 'react-day-picker'

import styles from './portfolio-filters-warm.module.css'

interface PortfolioFiltersProps {
  projectIds: number[]
  onProjectIdsChange: (ids: number[]) => void
  country: string
  onCountryChange: (country: string) => void
  startDate: string
  onStartDateChange: (date: string) => void
  endDate: string
  onEndDateChange: (date: string) => void
  projects: PortfolioProjectOption[]
  loadingProjects: boolean
  retryingProjects: boolean
  projectError: string | null
  onRetryProjects: () => void
}

export type PortfolioProjectOption = { id: number; name: string }

export function PortfolioFilters({
  projectIds,
  onProjectIdsChange,
  country,
  onCountryChange,
  startDate,
  onStartDateChange,
  endDate,
  onEndDateChange,
  projects,
  loadingProjects,
  retryingProjects,
  projectError,
  onRetryProjects,
}: PortfolioFiltersProps) {
  const countrySelectId = useId()
  const projectOptionsId = useId()
  const [open, setOpen] = useState(false)
  const [projectSearch, setProjectSearch] = useState('')
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)

  useEffect(() => {
    setPortalContainer(document.getElementById('warm-ledger-portal-root'))
  }, [])

  function toggleProject(id: number) {
    if (projectIds.includes(id)) {
      onProjectIdsChange(projectIds.filter((projectId) => projectId !== id))
    } else {
      onProjectIdsChange([...projectIds, id])
    }
  }

  function handleDateRangeChange(range: DateRange | undefined) {
    onStartDateChange(formatDateInputValue(range?.from))
    onEndDateChange(formatDateInputValue(range?.to))
  }

  const selectedProjects = projects.filter((project) => projectIds.includes(project.id))
  const normalizedSearch = projectSearch.trim().toLocaleLowerCase()
  const filteredProjects = projects.filter((project) => {
    if (!normalizedSearch) return true
    return (
      project.name.toLocaleLowerCase().includes(normalizedSearch) ||
      String(project.id).includes(normalizedSearch)
    )
  })
  let projectEmptyMessage = '未找到项目'
  if (projectError) projectEmptyMessage = '项目列表加载失败'
  else if (projects.length === 0) projectEmptyMessage = '暂无可用项目'
  const timezone = COUNTRY_TIMEZONE_MAP[country === 'ALL' ? 'US' : country] ?? COUNTRY_TIMEZONE_MAP.US

  return (
    <div data-testid="portfolio-filter-controls" className={styles.filters}>
      <div className={styles.projectField} aria-busy={loadingProjects || undefined}>
        <Popover
          open={open}
          onOpenChange={(nextOpen) => {
            setOpen(nextOpen)
            if (!nextOpen) setProjectSearch('')
          }}
        >
          <PopoverTrigger asChild>
            <button
              data-testid="portfolio-project-trigger"
              type="button"
              className={styles.projectTrigger}
              aria-controls={projectOptionsId}
              data-invalid={projectError ? 'true' : undefined}
              aria-describedby={projectError ? `${projectOptionsId}-error` : undefined}
              disabled={loadingProjects}
            >
              <span className={styles.projectTriggerValue}>
                {loadingProjects && projectIds.length === 0 ? (
                  '加载项目…'
                ) : projectIds.length === 0 ? (
                  '选择项目（多选）'
                ) : selectedProjects.length > 0 && selectedProjects.length === projectIds.length && selectedProjects.length <= 3 ? (
                  selectedProjects.map((project) => (
                    <span className={styles.projectChip} key={project.id}>
                      {project.name}
                    </span>
                  ))
                ) : (
                  `已选 ${projectIds.length} 个项目`
                )}
              </span>
              <ChevronsUpDown className={styles.projectChevron} aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            portalContainer={portalContainer}
            className={styles.projectPopover}
            align="start"
            aria-label="选择项目"
          >
            <div className={styles.projectPopoverBody} id={projectOptionsId}>
              <label className={styles.projectSearch}>
                <Search aria-hidden="true" />
                <input
                  type="search"
                  value={projectSearch}
                  onChange={(event) => setProjectSearch(event.target.value)}
                  placeholder="搜索项目"
                  aria-label="搜索项目"
                />
              </label>
              <div className={styles.projectOptions} role="group" aria-label="项目列表">
                {filteredProjects.length > 0 ? (
                  filteredProjects.map((project) => (
                    <label className={styles.projectOption} key={project.id}>
                      <input
                        className={styles.projectCheckbox}
                        type="checkbox"
                        checked={projectIds.includes(project.id)}
                        onChange={() => toggleProject(project.id)}
                      />
                      <span>{project.name}</span>
                    </label>
                  ))
                ) : (
                  <div className={styles.projectEmpty} role="status">
                    {projectEmptyMessage}
                  </div>
                )}
              </div>
            </div>
          </PopoverContent>
        </Popover>
        {projectError || retryingProjects ? (
          <div className={styles.projectError} role={projectError ? 'alert' : 'status'}>
            <span id={`${projectOptionsId}-error`}>
              {projectError ? `项目列表加载失败：${projectError}` : '正在重试项目列表'}
            </span>
            {projectError ? (
              <button
                type="button"
                className={styles.retryButton}
                disabled={loadingProjects}
                onClick={onRetryProjects}
                aria-label="重试加载项目列表"
              >
                {loadingProjects ? '重试中' : '重试'}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <WarmSelect
        id={`portfolio-country-${countrySelectId}`}
        label="站点筛选"
        value={country}
        options={COUNTRY_OPTIONS}
        onChange={onCountryChange}
        className={styles.countrySelect}
      />

      <DateRangePicker
        value={parseDateRangeInputValue(startDate, endDate)}
        onChange={handleDateRangeChange}
        className={styles.dateTrigger}
        placeholder="日期范围"
        timezone={timezone}
        portalContainer={portalContainer}
        popoverClassName={`${styles.datePopover} warm-ledger__date-picker-content`}
      />
    </div>
  )
}
