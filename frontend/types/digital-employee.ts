export type DigitalEmployeeStatus = 'IDLE' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SUSPENDED'
export type EmployeeType = 'AUTO_REPORT_UPLOAD' | 'SCHEDULED_JOB' | 'RPA_BOT' | 'AI_AGENT' | 'MONITORING' | 'DATABASE' | 'CUSTOM'
export type TaskStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

export interface DigitalEmployeeTask {
  id: number
  task_id: string
  task_name: string
  task_type: string
  status: TaskStatus
  progress_percent: number
  current_step: string | null
  started_at: string | null
  ended_at: string | null
  error_message: string | null
  metadata_json: Record<string, unknown> | null
  created_at: string
}

export interface DigitalEmployeeLog {
  id: number
  task_id: number | null
  level: LogLevel
  message: string
  created_at: string
}

export interface DigitalEmployee {
  id: number
  name: string
  description: string | null
  avatar_url: string | null
  employee_type: EmployeeType
  status: DigitalEmployeeStatus
  last_heartbeat_at: string | null
  is_silent_alert_threshold_minutes: number
  created_at: string
  updated_at: string
}

export interface DigitalEmployeeListResponse {
  items: DigitalEmployee[]
  total: number
}

export interface TaskListResponse {
  items: DigitalEmployeeTask[]
  total: number
}

export interface LogListResponse {
  items: DigitalEmployeeLog[]
  has_more: boolean
  cursor: string | null
}

export interface DigitalEmployeeStats {
  totalTasks: number
  successRate: number
  todayTasks: number
}