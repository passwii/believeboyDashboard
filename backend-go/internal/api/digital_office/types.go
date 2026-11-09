package digital_office

import (
	"context"
	"time"
)

const MaxPendingTasks = 200

type RealTask struct {
	TaskID          string
	TaskName        string
	TaskType        string
	Status          string
	ProgressPercent int
	CurrentStep     *string
	StartedAt       time.Time
	EndedAt         *time.Time
	Metadata        map[string]any
}

type PlaybackState struct {
	EmployeeID       int64
	VirtualIndex     int
	CurrentTaskID    *string
	VirtualProgress  float64
	DisplayStartedAt *time.Time
	DisplayDurationS float64
	PauseUntil       *time.Time
	Pace             float64
	BusyLevel        string
	LastAdvancedAt   *time.Time
}

type VirtualSnapshot struct {
	EmployeeID      int64
	DisplayStatus   string
	CurrentTask     *RealTask
	VirtualProgress float64
	StepLabel       string
	Pace            float64
	BusyLevel       string
	QueuedCount     int
}

type PlaybackConfig struct {
	StretchFactor float64
	MinDisplayS   float64
	MaxDisplayS   float64
	CalmQueue     int
	PacePerExtra  float64
	MaxPace       float64
	PauseMinS     float64
	PauseMaxS     float64
	OfflineAfterS float64
}

var DefaultConfig = PlaybackConfig{
	StretchFactor: 12,
	MinDisplayS:   1800,
	MaxDisplayS:   7200,
	CalmQueue:     1,
	PacePerExtra:  0.5,
	MaxPace:       6,
	PauseMinS:     90,
	PauseMaxS:     300,
	OfflineAfterS: 1800,
}

type Persona struct {
	Emoji    string `json:"emoji"`
	ColorKey string `json:"color_key"`
	Tagline  string `json:"tagline"`
}

type CurrentTask struct {
	TaskID   string `json:"task_id"`
	TaskName string `json:"task_name"`
	Status   string `json:"status"`
}

type WorkItem struct {
	ProjectName *string `json:"project_name"`
	ReportLabel *string `json:"report_label"`
}

type EmployeeSnapshot struct {
	EmployeeID      int64        `json:"employee_id"`
	Name            string       `json:"name"`
	Persona         Persona      `json:"persona"`
	DisplayStatus   string       `json:"display_status"`
	BusyLevel       string       `json:"busy_level"`
	QueuedCount     int          `json:"queued_count"`
	Pace            float64      `json:"pace"`
	CurrentTask     *CurrentTask `json:"current_task"`
	WorkItem        WorkItem     `json:"work_item"`
	VirtualProgress float64      `json:"virtual_progress"`
	StepLabel       string       `json:"step_label"`
	TodayDone       int          `json:"today_done"`
	SuccessRate     float64      `json:"success_rate"`
	LastHeartbeatAt *string      `json:"last_heartbeat_at"`
}

type ChatterEvent struct {
	EmployeeID int64  `json:"employee_id"`
	Name       string `json:"name"`
	Emoji      string `json:"emoji"`
	EventType  string `json:"event_type"`
	Text       string `json:"text"`
	Timestamp  string `json:"timestamp"`
}

type WallSnapshot struct {
	ServerTime string             `json:"server_time"`
	Employees  []EmployeeSnapshot `json:"employees"`
}

type Store interface {
	BuildWallSnapshot(
		ctx context.Context,
		now time.Time,
	) ([]EmployeeSnapshot, []ChatterEvent, error)
}
