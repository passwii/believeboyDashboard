package internal_ad_data

import (
	"context"
	"errors"
)

var (
	ErrProjectNotFound  = errors.New("项目不存在")
	ErrProjectForbidden = errors.New("无权限访问该项目")
)

type AdUploadFileItem struct {
	FileID          int64  `json:"file_id"`
	ReportType      string `json:"report_type"`
	ReportLabel     string `json:"report_label"`
	Country         string `json:"country"`
	PeriodStartDate string `json:"period_start_date"`
	PeriodEndDate   string `json:"period_end_date"`
	Version         int    `json:"version"`
	IsCurrent       bool   `json:"is_current"`
	IngestionStatus string `json:"ingestion_status"`
	RowCountPreview *int   `json:"row_count_preview"`
	UploadedAt      string `json:"uploaded_at"`
}

type PeriodInfo struct {
	Type      string `json:"type"`
	Value     string `json:"value"`
	StartDate string `json:"start_date"`
	EndDate   string `json:"end_date"`
}

type RawSummary struct {
	TotalRows int      `json:"total_rows"`
	DateRange []string `json:"date_range"`
}

type RawResponse struct {
	ProjectID int64            `json:"project_id"`
	Period    PeriodInfo       `json:"period"`
	Country   string           `json:"country"`
	Data      []map[string]any `json:"data"`
	Summary   RawSummary       `json:"summary"`
}

type RawQueryFilter struct {
	ProjectID int64
	Endpoint  string
	Period    string
	StartDate *string
	EndDate   *string
	Country   string
	Limit     int
	Offset    int
	OrderBy   string
	OrderDir  string
}

type Store interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error
	ListAdUploadFiles(ctx context.Context, projectID int64, reportType, country *string, includeHistory bool, limit, offset int) ([]AdUploadFileItem, error)
	QueryRaw(ctx context.Context, filter RawQueryFilter) (*RawResponse, error)
}
