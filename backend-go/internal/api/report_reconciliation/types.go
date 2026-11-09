package report_reconciliation

import (
	"context"
	"errors"
)

var (
	ErrReportNotFound   = errors.New("report not found")
	ErrPt3NotFound      = errors.New("PT3 calculation not found")
	ErrProjectForbidden = errors.New("无权限访问该项目")
)

type ReconciliationRecordItem struct {
	FieldName         string   `json:"field_name"`
	DBValue           *float64 `json:"db_value"`
	PDFValue          *float64 `json:"pdf_value"`
	Match             bool     `json:"match"`
	Difference        *float64 `json:"difference"`
	DifferencePercent *float64 `json:"difference_percent"`
}

type ReconciliationRecordSummary struct {
	DBTotalIncome   *float64 `json:"db_total_income"`
	DBTotalExpense  *float64 `json:"db_total_expense"`
	DBNetAmount     *float64 `json:"db_net_amount"`
	PDFTotalIncome  *float64 `json:"pdf_total_income"`
	PDFTotalExpense *float64 `json:"pdf_total_expense"`
	PDFNetAmount    *float64 `json:"pdf_net_amount"`
}

type ReconciliationRecordResponse struct {
	ID              int64                       `json:"id"`
	ReportID        int64                       `json:"report_id"`
	ProjectName     string                      `json:"project_name"`
	Country         string                      `json:"country"`
	ReportMonth     string                      `json:"report_month"`
	Operator        string                      `json:"operator"`
	Mode            string                      `json:"mode"`
	MatchRate       float64                     `json:"match_rate"`
	MatchedItems    int                         `json:"matched_items"`
	MismatchedItems int                         `json:"mismatched_items"`
	MissingItems    int                         `json:"missing_items"`
	TotalItems      int                         `json:"total_items"`
	Summary         ReconciliationRecordSummary `json:"summary"`
	DetailJSON      []ReconciliationRecordItem  `json:"detail_json"`
	CreatedAt       string                      `json:"created_at"`
}

type AvailableReportItem struct {
	ReportID               int64    `json:"report_id"`
	ProjectName            string   `json:"project_name"`
	Country                string   `json:"country"`
	ReportMonth            string   `json:"report_month"`
	HasSummaryPdf          bool     `json:"has_summary_pdf"`
	PdfURL                 *string  `json:"pdf_url"`
	PdfUploadedAt          *string  `json:"pdf_uploaded_at"`
	Pt3CalculationComplete bool     `json:"pt3_calculation_complete"`
	Pt4CalculationComplete bool     `json:"pt4_calculation_complete"`
	Status                 string   `json:"status"`
	PdfFileMissing         bool     `json:"pdf_file_missing"`
	HasTransactionCsv      bool     `json:"has_transaction_csv"`
	TransactionCsvMissing  bool     `json:"transaction_csv_missing"`
	Reconciled             bool     `json:"reconciled"`
	ReconcileMatchRate     *float64 `json:"reconcile_match_rate"`
	ReconcileRecordID      *int64   `json:"reconcile_record_id"`
}

type AvailableReportsResponse struct {
	Reports []AvailableReportItem `json:"reports"`
	Total   int                   `json:"total"`
}

type AutoReconcileRequest struct {
	ReportID  int64   `json:"report_id"`
	Tolerance float64 `json:"tolerance"`
	Country   *string `json:"country,omitempty"`
}

type ReconciliationHistoryResponse struct {
	Records []ReconciliationRecordResponse `json:"records"`
	Total   int                            `json:"total"`
}

type ReconcileResultItem struct {
	FieldName         string   `json:"field_name"`
	DBValue           *float64 `json:"db_value"`
	ExcelValue        *float64 `json:"excel_value,omitempty"`
	PDFValue          *float64 `json:"pdf_value"`
	Match             bool     `json:"match"`
	Difference        *float64 `json:"difference"`
	DifferencePercent *float64 `json:"difference_percent"`
}

type ReconcileResultResponse struct {
	Summary         ReconciliationRecordSummary `json:"summary"`
	TotalItems      int                         `json:"total_items"`
	MatchedItems    int                         `json:"matched_items"`
	MismatchedItems int                         `json:"mismatched_items"`
	MissingItems    int                         `json:"missing_items"`
	MatchRate       float64                     `json:"match_rate"`
	Items           []ReconcileResultItem       `json:"items"`
	RecordID        *int64                      `json:"record_id"`
}

type PDFUploadResponse struct {
	ReportID         int64  `json:"report_id"`
	PdfFileID        string `json:"pdf_file_id"`
	PdfFilePath      string `json:"pdf_file_path"`
	OriginalFilename string `json:"original_filename"`
	Size             int64  `json:"size"`
	Message          string `json:"message"`
}

type CSVUploadResponse struct {
	ReportID         int64  `json:"report_id"`
	CsvFileID        string `json:"csv_file_id"`
	CsvFilePath      string `json:"csv_file_path"`
	OriginalFilename string `json:"original_filename"`
	Size             int64  `json:"size"`
	Message          string `json:"message"`
}

type AvailableReportsFilter struct {
	ProjectID *int64
	Country   *string
	Month     *string
	Operator  string
	IsAdmin   bool
}

type HistoryFilter struct {
	ProjectID *int64
	Month     *string
	Limit     int
	Operator  string
	IsAdmin   bool
}

type Store interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error
	GetReportProjectID(ctx context.Context, reportID int64) (int64, error)
	GetAvailableReports(ctx context.Context, filter AvailableReportsFilter) ([]AvailableReportItem, error)
	AutoReconcile(ctx context.Context, req AutoReconcileRequest, operator string, isAdmin bool) (*ReconcileResultResponse, error)
	GetReconciliationHistory(ctx context.Context, filter HistoryFilter) ([]ReconciliationRecordResponse, error)
	ManualReconcile(ctx context.Context, reportID *int64, excelBytes []byte, pdfBytes []byte, tolerance float64, operator string, isAdmin bool) (map[string]any, error)
	UploadSummaryPdf(ctx context.Context, reportID int64, filename string, pdfBytes []byte, operator string, isAdmin bool) (*PDFUploadResponse, error)
	UploadTransactionCsv(ctx context.Context, reportID int64, filename string, csvBytes []byte, operator string, isAdmin bool) (*CSVUploadResponse, error)
	ExportPt3Data(ctx context.Context, reportID int64, operator string, isAdmin bool) (string, []byte, error)
	DownloadPdf(ctx context.Context, reportID int64, operator string, isAdmin bool) (string, []byte, error)
	DownloadCsv(ctx context.Context, reportID int64, operator string, isAdmin bool) (string, []byte, error)
}
