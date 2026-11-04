import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ReportStatusCard } from './report-status-card'
import type { RecognitionResponse, ReportCardConfig, ReportCardState } from './types'

const CONFIG: ReportCardConfig = {
  type: 'business_report',
  title: '业务报告',
  subtitle: '流量、销量、会话数据',
  dateHint: '单日',
  projectHint: 'ASIN 匹配项目',
}

function recognition(tempFileId: string, originalFilename: string): RecognitionResponse {
  return {
    temp_file_id: tempFileId,
    original_filename: originalFilename,
    extension: 'csv',
    report_type: 'business_report',
    matched_columns: [],
    reason: '',
    status: 'recognized',
    country: 'US',
    detected_countries: ['US'],
    primary_country: 'US',
    date_input_mode: 'single_auto',
    detected_date: '2026-10-20',
    detected_start_date: null,
    detected_end_date: null,
    project_match: {
      status: 'matched',
      project_name: 'Project A',
      candidate_projects: [],
      matched_by: 'ASIN',
      matched_values: [],
      message: null,
    },
    row_count_preview: 10,
    warnings: [],
  }
}

const CANDIDATES = [
  recognition('business-temp-1', 'business.csv'),
  recognition('business-temp-2', 'business-copy.csv'),
]

const STATE: ReportCardState = {
  recognition: CANDIDATES[1]!,
  candidates: CANDIDATES,
  activeTempFileId: CANDIDATES[1]!.temp_file_id,
  selectedProject: 'Project A',
  reportDate: '2026-10-20',
  reportStartDate: '',
  reportEndDate: '',
  commitStatus: 'idle',
  commitMessage: null,
}

function renderCard(selectContentClassName?: string) {
  return render(
    <ReportStatusCard
      config={CONFIG}
      state={STATE}
      projects={['Project A', 'Project B']}
      onPickCandidate={vi.fn()}
      onProjectChange={vi.fn()}
      onDateChange={vi.fn()}
      onCommit={vi.fn()}
      canCommit
      datesLocked
      periodLabel="2026-10-20"
      selectContentClassName={selectContentClassName}
    />
  )
}

describe('ReportStatusCard select portals', () => {
  it('applies the optional content class to both candidate-file and project portals', async () => {
    const user = userEvent.setup()
    renderCard('warm-status-select-content')

    const comboboxes = screen.getAllByRole('combobox')
    expect(comboboxes).toHaveLength(2)
    expect(comboboxes[0]).toHaveTextContent('business-copy.csv')

    await user.click(comboboxes[0]!)
    expect(screen.getByRole('listbox')).toHaveClass('warm-status-select-content')

    await user.keyboard('{Escape}')
    await user.click(comboboxes[1]!)
    expect(screen.getByRole('listbox')).toHaveClass('warm-status-select-content')
  })

  it('keeps the shared select content classes when the optional hook is omitted', async () => {
    const user = userEvent.setup()
    renderCard()

    await user.click(screen.getAllByRole('combobox')[0]!)
    const content = screen.getByRole('listbox')
    expect(content).not.toHaveClass('warm-status-select-content')
    expect(content).toHaveClass('rounded-none', 'border-term-border', 'bg-term-panel')
  })
})
