package product_analysis_reports

import (
	"context"
	"errors"
)

const (
	JobType = "product_analysis"

	StatusPending = "pending"
	StatusRunning = "running"
	StatusSuccess = "success"
	StatusFailed  = "failed"
)

var (
	ErrProjectNotFound      = errors.New("project not found")
	ErrProjectForbidden     = errors.New("project forbidden")
	ErrTaskNotFound         = errors.New("product analysis task not found")
	ErrInvalidStoredPath    = errors.New("invalid stored path")
	ErrStorageNotConfigured = errors.New("result storage is not configured")
)

type CreateRequest struct {
	ProjectName           string  `json:"project_name"`
	ReportStartDate       string  `json:"report_start_date"`
	ReportEndDate         string  `json:"report_end_date"`
	BusinessReportFileID  string  `json:"business_report_file_id"`
	PaymentReportFileID   string  `json:"payment_report_file_id"`
	AdReportFileID        string  `json:"ad_report_file_id"`
	InventoryReportFileID *string `json:"inventory_report_file_id"`
	Country               string  `json:"country"`
}

type CreateInput struct {
	ProjectName           string
	ReportStartDate       string
	ReportEndDate         string
	BusinessReportFileID  string
	PaymentReportFileID   string
	AdReportFileID        string
	InventoryReportFileID *string
	Country               string
	Operator              string
	IsAdmin               bool
}

type Task struct {
	ID                 int64
	Status             string
	Stage              string
	Progress           int
	Message            *string
	ErrorMessage       *string
	PersistenceStatus  string
	PersistenceMessage *string
	CreatedAt          string
	UpdatedAt          string

	ProjectID   int64
	ProjectName string
	ResultPath  *string
}

type CreateResponse struct {
	JobID          int64   `json:"job_id"`
	StatusEndpoint *string `json:"status_endpoint"`
	ResultEndpoint *string `json:"result_endpoint"`
	Status         string  `json:"status"`
	CreatedAt      *string `json:"created_at"`
}

type TaskStatusResponse struct {
	TaskID             int64   `json:"task_id"`
	Status             string  `json:"status"`
	Stage              string  `json:"stage"`
	Progress           int     `json:"progress"`
	Message            *string `json:"message"`
	ErrorMessage       *string `json:"error_message"`
	PersistenceStatus  string  `json:"persistence_status"`
	PersistenceMessage *string `json:"persistence_message"`
	CreatedAt          string  `json:"created_at"`
	UpdatedAt          string  `json:"updated_at"`
}

type Store interface {
	CreateTask(ctx context.Context, input CreateInput) (*Task, error)
	GetTask(
		ctx context.Context,
		taskID int64,
		operator string,
		isAdmin bool,
	) (*Task, error)
	MarkTaskFailed(ctx context.Context, taskID int64, message string) error
}

// Enqueuer is transport-agnostic so the gateway can use Asynq without this
// domain package depending on queue implementation details.
type Enqueuer interface {
	EnqueueProductAnalysisReport(ctx context.Context, taskID int64) error
}

// ObjectURLBuilder resolves a server-generated object key to a public HTTPS URL.
// It is only consulted for non-local result paths.
type ObjectURLBuilder interface {
	PublicURL(ctx context.Context, key string) (string, error)
}
