package ad_upload

import (
	"context"
	"errors"
)

var (
	ErrProjectNotFound  = errors.New("项目不存在")
	ErrProjectForbidden = errors.New("无权限访问该项目")
	ErrTypeMismatch     = errors.New("report_type does not match recognized report")
)

type AdUploadProjectMatchSummary struct {
	Status            string   `json:"status"`
	ProjectName       *string  `json:"project_name"`
	CandidateProjects []string `json:"candidate_projects"`
	MatchedBy         *string  `json:"matched_by"`
	MatchedValues     []string `json:"matched_values"`
	Message           *string  `json:"message"`
}

type AdUploadRecognitionResponse struct {
	TempFileID         string                      `json:"temp_file_id"`
	OriginalFilename   string                      `json:"original_filename"`
	Extension          string                      `json:"extension"`
	ReportType         string                      `json:"report_type"`
	ReportLabel        string                      `json:"report_label"`
	MatchedColumns     []string                    `json:"matched_columns"`
	Reason             string                      `json:"reason"`
	Status             string                      `json:"status"`
	Country            string                      `json:"country"`
	DetectedReportDate *string                     `json:"detected_report_date"`
	DetectedStartDate  *string                     `json:"detected_start_date"`
	DetectedEndDate    *string                     `json:"detected_end_date"`
	ProjectMatch       AdUploadProjectMatchSummary `json:"project_match"`
	RowCountPreview    *int                        `json:"row_count_preview"`
	Warnings           []string                    `json:"warnings"`
}

type AdUploadCommitRequest struct {
	TempFileID       string  `json:"temp_file_id"`
	ReportType       string  `json:"report_type"`
	OriginalFilename *string `json:"original_filename,omitempty"`
	ProjectName      *string `json:"project_name,omitempty"`
	Country          string  `json:"country"`
	ReportDate       *string `json:"report_date,omitempty"`
	ReportStartDate  *string `json:"report_start_date,omitempty"`
	ReportEndDate    *string `json:"report_end_date,omitempty"`
	DryRun           bool    `json:"dry_run"`
}

type AdUploadCommitResponse struct {
	ID              int64   `json:"id"`
	ReportType      string  `json:"report_type"`
	ReportLabel     string  `json:"report_label"`
	IngestionStatus string  `json:"ingestion_status"`
	ProjectName     string  `json:"project_name"`
	Country         string  `json:"country"`
	ReportDate      *string `json:"report_date"`
	ReportStartDate string  `json:"report_start_date"`
	ReportEndDate   string  `json:"report_end_date"`
	FileID          string  `json:"file_id"`
	FilePath        string  `json:"file_path"`
	Version         int     `json:"version"`
	IsCurrent       bool    `json:"is_current"`
	Message         string  `json:"message"`
}

type AdUploadStatusItem struct {
	ID                int64    `json:"id"`
	ProjectName       string   `json:"project_name"`
	ReportType        string   `json:"report_type"`
	ReportLabel       string   `json:"report_label"`
	Country           string   `json:"country"`
	ReportDate        *string  `json:"report_date"`
	ReportStartDate   string   `json:"report_start_date"`
	ReportEndDate     string   `json:"report_end_date"`
	Version           int      `json:"version"`
	IsCurrent         bool     `json:"is_current"`
	RecognitionStatus string   `json:"recognition_status"`
	IngestionStatus   string   `json:"ingestion_status"`
	OriginalFilename  *string  `json:"original_filename"`
	RowCountPreview   *int     `json:"row_count_preview"`
	UpdatedAt         *string  `json:"updated_at"`
	Warnings          []string `json:"warnings"`
}

type AdUploadStatusResponse struct {
	Country string               `json:"country"`
	Items   []AdUploadStatusItem `json:"items"`
}

type AdUploadStatusFilter struct {
	Country     string
	ProjectName *string
	ReportType  *string
	ReportDate  *string
	Limit       int
	Operator    string
	IsAdmin     bool
}

type Store interface {
	Recognize(ctx context.Context, filename string, data []byte, country, operator string, isAdmin bool) (*AdUploadRecognitionResponse, error)
	Commit(ctx context.Context, req AdUploadCommitRequest, operator string, isAdmin bool) (*AdUploadCommitResponse, error)
	ListStatus(ctx context.Context, filter AdUploadStatusFilter) (*AdUploadStatusResponse, error)
}
