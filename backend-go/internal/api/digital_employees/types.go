package digital_employees

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"time"
)

const (
	EmployeeTypeAutoReportUpload = "auto_report_upload"
	EmployeeTypeScheduledJob     = "scheduled_job"
	EmployeeTypeRPABot           = "rpa_bot"
	EmployeeTypeAIAgent          = "ai_agent"
	EmployeeTypeMonitoring       = "monitoring"
	EmployeeTypeDatabase         = "database"
	EmployeeTypeCustom           = "custom"

	EmployeeStatusIdle      = "idle"
	EmployeeStatusRunning   = "running"
	EmployeeStatusSucceeded = "succeeded"
	EmployeeStatusFailed    = "failed"
	EmployeeStatusSuspended = "suspended"

	TaskStatusPending   = "pending"
	TaskStatusRunning   = "running"
	TaskStatusSucceeded = "succeeded"
	TaskStatusFailed    = "failed"
	TaskStatusCancelled = "cancelled"

	LogLevelDebug = "debug"
	LogLevelInfo  = "info"
	LogLevelWarn  = "warn"
	LogLevelError = "error"
)

var (
	ErrEmployeeNotFound = errors.New("Employee not found")
	ErrTaskNotFound     = errors.New("Task not found")
	ErrInvalidAPISecret = errors.New("Invalid api_secret")
	ErrInvalidStatus    = errors.New("Only SUSPENDED or IDLE allowed")
)

type DigitalEmployee struct {
	ID                            int64   `json:"id"`
	Name                          string  `json:"name"`
	AvatarURL                     *string `json:"avatar_url"`
	EmployeeType                  string  `json:"employee_type"`
	Status                        string  `json:"status"`
	Description                   *string `json:"description"`
	LastHeartbeatAt               *string `json:"last_heartbeat_at"`
	IsSilentAlertThresholdMinutes int     `json:"is_silent_alert_threshold_minutes"`
	CreatedAt                     string  `json:"created_at"`
	UpdatedAt                     string  `json:"updated_at"`
}

type DigitalEmployeeListResponse struct {
	Items []DigitalEmployee `json:"items"`
	Total int               `json:"total"`
}

type DigitalEmployeeCreate struct {
	Name         string
	AvatarURL    *string
	EmployeeType string
	Description  *string
}

type DigitalEmployeeTask struct {
	ID              int64          `json:"id"`
	TaskID          string         `json:"task_id"`
	TaskName        string         `json:"task_name"`
	TaskType        string         `json:"task_type"`
	Status          string         `json:"status"`
	ProgressPercent int            `json:"progress_percent"`
	CurrentStep     *string        `json:"current_step"`
	StartedAt       *string        `json:"started_at"`
	EndedAt         *string        `json:"ended_at"`
	ErrorMessage    *string        `json:"error_message"`
	MetadataJSON    map[string]any `json:"metadata_json"`
	CreatedAt       string         `json:"created_at"`
}

type DigitalEmployeeTaskListResponse struct {
	Items []DigitalEmployeeTask `json:"items"`
	Total int                   `json:"total"`
}

type DigitalEmployeeLog struct {
	ID        int64  `json:"id"`
	TaskID    *int64 `json:"task_id"`
	Level     string `json:"level"`
	Message   string `json:"message"`
	CreatedAt string `json:"created_at"`
}

type DigitalEmployeeLogListResponse struct {
	Items   []DigitalEmployeeLog `json:"items"`
	HasMore bool                 `json:"has_more"`
	Cursor  *string              `json:"cursor"`
}

type DigitalEmployeeRecentLogsResponse struct {
	Items []DigitalEmployeeLog `json:"items"`
}

type RegisterInput struct {
	Name                          string
	EmployeeType                  string
	Description                   *string
	IsSilentAlertThresholdMinutes int
}

type RegisterResponse struct {
	ID        int64  `json:"id"`
	APISecret string `json:"api_secret"`
}

type HeartbeatInput struct {
	EmployeeID      int64
	APISecret       *string
	TaskID          *string
	TaskName        *string
	TaskType        *string
	Status          *string
	ProgressPercent *int
	CurrentStep     *string
	Message         *string
	MetadataJSON    map[string]any
}

type HeartbeatResponse struct {
	OK             bool   `json:"ok"`
	AcknowledgedAt string `json:"acknowledged_at"`
}

type Store interface {
	ListEmployees(ctx context.Context, status, employeeType *string) ([]DigitalEmployee, error)
	GetEmployee(ctx context.Context, employeeID int64) (*DigitalEmployee, error)
	CreateEmployee(ctx context.Context, input DigitalEmployeeCreate, apiSecret string) (*DigitalEmployee, error)
	UpdateEmployeeStatus(ctx context.Context, employeeID int64, status string) (*DigitalEmployee, error)
	DeleteEmployee(ctx context.Context, employeeID int64) error
	ListTasks(ctx context.Context, employeeID int64, page, pageSize int) ([]DigitalEmployeeTask, int, error)
	GetTask(ctx context.Context, employeeID, taskID int64) (*DigitalEmployeeTask, error)
	ListLogs(
		ctx context.Context,
		employeeID, taskID int64,
		cursor *int64,
		limit int,
	) ([]DigitalEmployeeLog, bool, *int64, error)
	ListEmployeeLogs(ctx context.Context, employeeID int64, limit int) ([]DigitalEmployeeLog, error)
	RegisterEmployee(ctx context.Context, input RegisterInput, candidateSecret string) (int64, string, error)
	Heartbeat(ctx context.Context, input HeartbeatInput, now time.Time) (time.Time, error)
}

func NewAPISecret() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	// The current schema has only api_secret (no hash column). Keep the
	// FastAPI-compatible plaintext contract for now, but never weaken the
	// generator: 32 crypto-random bytes, URL-safe Base64 (43 characters).
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func ValidEmployeeType(value string) bool {
	switch value {
	case EmployeeTypeAutoReportUpload,
		EmployeeTypeScheduledJob,
		EmployeeTypeRPABot,
		EmployeeTypeAIAgent,
		EmployeeTypeMonitoring,
		EmployeeTypeDatabase,
		EmployeeTypeCustom:
		return true
	default:
		return false
	}
}

func ValidEmployeeStatus(value string) bool {
	switch value {
	case EmployeeStatusIdle,
		EmployeeStatusRunning,
		EmployeeStatusSucceeded,
		EmployeeStatusFailed,
		EmployeeStatusSuspended:
		return true
	default:
		return false
	}
}

func ValidTaskStatus(value string) bool {
	switch value {
	case TaskStatusPending,
		TaskStatusRunning,
		TaskStatusSucceeded,
		TaskStatusFailed,
		TaskStatusCancelled:
		return true
	default:
		return false
	}
}

func FilterEmployeeType(value string) *string {
	if !ValidEmployeeType(value) {
		return nil
	}
	return &value
}

func FilterEmployeeStatus(value string) *string {
	if !ValidEmployeeStatus(value) {
		return nil
	}
	return &value
}
