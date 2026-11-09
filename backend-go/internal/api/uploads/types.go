package uploads

import "context"

// CacheInvalidator mirrors the Python daily-analysis invalidation contract.
// Upload commits must not report success when this dependency is missing.
type CacheInvalidator interface {
	InvalidateDailyAnalysis(context.Context, int64) error
}

type UploadResponse struct {
	FileID           string `json:"file_id"`
	FilePath         string `json:"file_path"`
	Filename         string `json:"filename"`
	OriginalFilename string `json:"original_filename"`
	Size             int64  `json:"size"`
}

type ProjectMatchSummary struct {
	Status            string   `json:"status"`
	ProjectName       *string  `json:"project_name"`
	CandidateProjects []string `json:"candidate_projects"`
	MatchedBy         *string  `json:"matched_by"`
	MatchedValues     []string `json:"matched_values"`
	Message           *string  `json:"message"`
}

type RecognitionResponse struct {
	TempFileID        string              `json:"temp_file_id"`
	OriginalFilename  string              `json:"original_filename"`
	Extension         string              `json:"extension"`
	ReportType        string              `json:"report_type"`
	MatchedColumns    []string            `json:"matched_columns"`
	Reason            string              `json:"reason"`
	Status            string              `json:"status"`
	Country           string              `json:"country"`
	DetectedCountries []string            `json:"detected_countries"`
	PrimaryCountry    *string             `json:"primary_country"`
	DateInputMode     string              `json:"date_input_mode"`
	DetectedDate      *string             `json:"detected_date"`
	DetectedStartDate *string             `json:"detected_start_date"`
	DetectedEndDate   *string             `json:"detected_end_date"`
	ProjectMatch      ProjectMatchSummary `json:"project_match"`
	RowCountPreview   *int                `json:"row_count_preview"`
	Warnings          []string            `json:"warnings"`
	Identifiers       []string            `json:"-"`
	MatchBy           string              `json:"-"`
}

type CommitRequest struct {
	TempFileID       string  `json:"temp_file_id"`
	ReportType       string  `json:"report_type"`
	OriginalFilename *string `json:"original_filename"`
	ProjectName      *string `json:"project_name"`
	ReportDate       *string `json:"report_date"`
	ReportStartDate  *string `json:"report_start_date"`
	ReportEndDate    *string `json:"report_end_date"`
	Country          string  `json:"country"`
	UsePeriodDates   bool    `json:"use_period_dates"`
	DryRun           bool    `json:"dry_run"`
}

type DuplicateWarning struct {
	ProjectName      string  `json:"project_name"`
	ReportType       string  `json:"report_type"`
	Country          string  `json:"country"`
	Period           string  `json:"period"`
	OriginalFilename *string `json:"original_filename"`
}

type CommitResponse struct {
	ReportType        string             `json:"report_type"`
	Status            string             `json:"status"`
	ProjectName       *string            `json:"project_name"`
	Country           string             `json:"country"`
	ReportDate        *string            `json:"report_date"`
	ReportStartDate   *string            `json:"report_start_date"`
	ReportEndDate     *string            `json:"report_end_date"`
	FileID            string             `json:"file_id"`
	FilePath          string             `json:"file_path"`
	PersistedSourceID *int64             `json:"persisted_source_id"`
	PersistedTable    *string            `json:"persisted_table"`
	Message           string             `json:"message"`
	DuplicateWarnings []DuplicateWarning `json:"duplicate_warnings"`
	RowsIngested      *int               `json:"rows_ingested"`
}

type StatusCell struct {
	ReportType       string  `json:"report_type"`
	Status           string  `json:"status"`
	DisplayDate      *string `json:"display_date"`
	ReportStartDate  *string `json:"report_start_date"`
	ReportEndDate    *string `json:"report_end_date"`
	SourceTable      *string `json:"source_table"`
	UpdatedAt        *string `json:"updated_at"`
	OriginalFilename *string `json:"original_filename"`
	Message          *string `json:"message"`
}

type ProjectStatusItem struct {
	ProjectID   int64                 `json:"project_id"`
	ProjectName string                `json:"project_name"`
	Statuses    map[string]StatusCell `json:"statuses"`
}

type StatusResponse struct {
	Country string              `json:"country"`
	Items   []ProjectStatusItem `json:"items"`
}

type TempFile struct {
	TempFileID       string
	OriginalFilename string
	Path             string
	Size             int64
}

type PreparedUpload struct {
	ObjectKey        string
	Filename         string
	LocalPath        string
	OriginalFilename string
}

type PreparedReportFile struct {
	FileID           string
	FilePath         string
	Filename         string
	OriginalFilename string
	Size             int64
	LocalPath        string
}
