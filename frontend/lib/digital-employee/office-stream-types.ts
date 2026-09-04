export type DisplayStatus = 'WORKING' | 'PAUSING' | 'IDLE' | 'OFFLINE' | 'FAILED'
export type BusyLevel = 'IDLE' | 'NORMAL' | 'BUSY' | 'SWAMPED'

export interface OfficePersona {
  emoji: string
  color_key: string
  tagline: string
}

export interface OfficeEmployee {
  employee_id: number
  name: string
  persona: OfficePersona
  display_status: DisplayStatus
  busy_level: BusyLevel
  queued_count: number
  pace: number
  current_task: { task_id: string; task_name: string; status: string } | null
  work_item: { project_name: string | null; report_label: string | null }
  virtual_progress: number
  step_label: string
  today_done: number
  success_rate: number
  last_heartbeat_at: string | null
}

export interface OfficeSnapshot {
  server_time: string
  employees: OfficeEmployee[]
}

export type ChatterEventType =
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'pause_started'
  | 'went_offline'
  | 'came_online'

export interface ChatterEvent {
  employee_id: number
  name: string
  emoji: string
  event_type: ChatterEventType
  text: string
  timestamp: string
}

export function parseSnapshot(raw: string): OfficeSnapshot | null {
  try {
    const data = JSON.parse(raw) as OfficeSnapshot
    if (!Array.isArray(data.employees)) return null
    return data
  } catch {
    return null
  }
}

export function parseChatter(raw: string): ChatterEvent | null {
  try {
    const data = JSON.parse(raw) as ChatterEvent
    if (!data.event_type || !data.text) return null
    return data
  } catch {
    return null
  }
}
