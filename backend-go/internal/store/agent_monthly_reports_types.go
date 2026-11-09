package store

import (
	"errors"
	"time"
)

var (
	ErrAgentMonthlyNotFound            = errors.New("agent monthly report resource not found")
	ErrAgentMonthlyConflict            = errors.New("agent monthly report conflict")
	ErrAgentMonthlyExpired             = errors.New("agent monthly report expired")
	ErrAgentMonthlyNotReady            = errors.New("agent monthly report not ready")
	ErrAgentMonthlyIdempotencyConflict = errors.New("agent monthly report idempotency conflict")
	ErrAgentMonthlyInvalidInput        = errors.New("agent monthly report invalid input")
	ErrAgentMonthlyDependency          = errors.New("agent monthly report dependency unavailable")
)

type AgentMonthlyReportItem struct {
	ID                 int64      `json:"id"`
	ProjectID          int64      `json:"project_id"`
	ProjectName        string     `json:"project_name"`
	Country            string     `json:"country"`
	ReportMonth        string     `json:"report_month"`
	Version            int        `json:"version"`
	IsCurrent          bool       `json:"is_current"`
	SupersededAt       *time.Time `json:"-"`
	Status             string     `json:"status"`
	SettlementID       *string    `json:"settlement_id"`
	TotalTransactions  int        `json:"total_transactions"`
	TotalOrders        int        `json:"total_orders"`
	TotalRefunds       int        `json:"total_refunds"`
	TotalAdjustments   int        `json:"total_adjustments"`
	TotalServiceFees   int        `json:"total_service_fees"`
	TotalTransFees     int        `json:"total_trans_fees"`
	ResultFilePath     *string    `json:"result_file_path"`
	ErrorMessage       *string    `json:"error_message"`
	CalculationVersion int        `json:"calculation_version"`
	ComputedAt         *time.Time `json:"-"`
	CreatedAt          *time.Time `json:"-"`
	UpdatedAt          *time.Time `json:"-"`
}

type AgentMonthlyReportDetail struct {
	Report AgentMonthlyReportItem `json:"report"`
	PT3    map[string]float64     `json:"pt3"`
	PT4    map[string]float64     `json:"pt4"`
}

type AgentMonthlyReportListFilter struct {
	ProjectID      int64
	Country        *string
	ReportMonth    *string
	IncludeHistory bool
}

type AgentMonthlyFinancialSeriesFilter struct {
	ProjectID   int64
	Country     string
	StartMonth  *string
	EndMonth    *string
	FillMissing bool
}

type AgentMonthlyFinancialSeriesRow struct {
	ReportMonth            string  `json:"report_month"`
	IncomeSales            float64 `json:"income_sales"`
	IncomeRefund           float64 `json:"income_refund"`
	IncomeAdjustment       float64 `json:"income_adjustment"`
	IncomeOther            float64 `json:"income_other"`
	ExpenseSellingFee      float64 `json:"expense_selling_fee"`
	ExpenseFBAFee          float64 `json:"expense_fba_fee"`
	ExpenseInventoryFee    float64 `json:"expense_inventory_fee"`
	ExpenseServiceFee      float64 `json:"expense_service_fee"`
	ExpenseAdvertising     float64 `json:"expense_advertising"`
	ExpenseOtherFees       float64 `json:"expense_other_fees"`
	IncomeTotal            float64 `json:"income_total"`
	ExpenseTotal           float64 `json:"expense_total"`
	AmazonPayBack          float64 `json:"amazon_pay_back"`
	IncomeVATTotal         float64 `json:"income_vat_total"`
	IncomeSalesWithTax     float64 `json:"income_sales_with_tax"`
	ExpenseVATTotal        float64 `json:"expense_vat_total"`
	CreditCardDeductionUSD float64 `json:"credit_card_deduction_usd"`
	FOBCostRMB             float64 `json:"fob_cost_rmb"`
	FirstLegCostRMB        float64 `json:"first_leg_cost_rmb"`
	HasSourceReport        bool    `json:"has_source_report"`
}

type AgentMonthlyFinancialTrendPoint struct {
	ReportMonth     string  `json:"report_month"`
	IncomeTotal     float64 `json:"income_total"`
	ExpenseTotal    float64 `json:"expense_total"`
	AmazonPayBack   float64 `json:"amazon_pay_back"`
	NetAmount       float64 `json:"net_amount"`
	VATTotal        float64 `json:"vat_total"`
	HasSourceReport bool    `json:"has_source_report"`
}

type AgentMonthlyFinancialTrend struct {
	IncomeTotalSum   float64                           `json:"income_total_sum"`
	ExpenseTotalSum  float64                           `json:"expense_total_sum"`
	AmazonPayBackSum float64                           `json:"amazon_pay_back_sum"`
	NetAmountSum     float64                           `json:"net_amount_sum"`
	Points           []AgentMonthlyFinancialTrendPoint `json:"points"`
}

type AgentMonthlyFinancialSeriesResponse struct {
	ProjectID   int64                            `json:"project_id"`
	ProjectName string                           `json:"project_name"`
	StartMonth  string                           `json:"start_month"`
	EndMonth    string                           `json:"end_month"`
	Rows        []AgentMonthlyFinancialSeriesRow `json:"rows"`
	Trend       AgentMonthlyFinancialTrend       `json:"trend"`
}

type AgentMonthlyAccountingFilter struct {
	ProjectID   int64
	Country     string
	ReportMonth string
}

type AgentMonthlyFinancialAccountingLine struct {
	IncomeEN           string  `json:"income_en"`
	IncomeZH           string  `json:"income_zh"`
	IncomeAmountLocal  float64 `json:"income_amount_usd"`
	IncomeSource       string  `json:"income_source"`
	ExpenseEN          string  `json:"expense_en"`
	ExpenseZH          string  `json:"expense_zh"`
	ExpenseAmountLocal float64 `json:"expense_amount_usd"`
	ExpenseSource      string  `json:"expense_source"`
	CurrencyCode       *string `json:"currency_code"`
	Kind               string  `json:"kind"`
}

type AgentMonthlyFinancialAccountingDetailResponse struct {
	ProjectID   int64                                 `json:"project_id"`
	ProjectName string                                `json:"project_name"`
	ReportMonth string                                `json:"report_month"`
	Rows        []AgentMonthlyFinancialAccountingLine `json:"rows"`
}

type AgentMonthlyFileResult struct {
	Filename    string
	ContentType string
	Content     []byte
}

type AgentMonthlyStoredFile struct {
	Path        string
	Filename    string
	ContentType string
	Size        int64
}

type AgentMonthlyUpload struct {
	ID          int64
	AgentKeyID  int64
	AgentID     string
	ProjectID   int64
	ProjectName string
	Country     string
	ReportMonth string
	Status      string
	ExpiresAt   time.Time
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type AgentMonthlyUploadCreateInput struct {
	AgentKeyID  int64
	AgentID     string
	ProjectID   int64
	Country     string
	ReportMonth string
}

type AgentMonthlyUploadFileInput struct {
	AgentKeyID       int64
	UploadID         int64
	Kind             string
	OriginalFilename string
	ContentType      string
	TempPath         string
	MaxBytes         int64
}

type AgentMonthlyUploadedFile struct {
	UploadID         int64
	FileID           string
	Kind             string
	OriginalFilename string
	SHA256           string
	SizeBytes        int64
	Validation       map[string]any
}

type AgentMonthlyBuild struct {
	ID                      int64
	UploadID                int64
	AgentKeyID              int64
	AgentID                 string
	Status                  string
	ProjectID               int64
	ProjectName             string
	Country                 string
	ReportMonth             string
	InputSHA256             string
	SummaryPDFSHA256        *string
	IdempotencyKey          *string
	ResultDir               *string
	PayloadPath             *string
	PayloadSHA256           *string
	WorkbookPath            *string
	WorkbookSHA256          *string
	CalculationVersion      *int
	ReportID                *int64
	ConfirmedAt             *time.Time
	ErrorMessage            *string
	ExpiresAt               time.Time
	CreatedAt               time.Time
	UpdatedAt               time.Time
	ExistingSuccessReportID *int64
	BlockingReportID        *int64
	BlockingReportStatus    *string
}

type AgentMonthlyBuildCreateInput struct {
	AgentKeyID        int64
	UploadID          int64
	TransactionFileID string
	SummaryPDFFileID  *string
	IdempotencyKey    string
	RequestHash       string
}

type AgentMonthlyBuildPreview struct {
	Build             *AgentMonthlyBuild
	TransactionsCount int
	PT3               map[string]string
	PT4               map[string]string
}

type AgentMonthlyBuildConfirmInput struct {
	AgentKeyID     int64
	BuildID        int64
	IdempotencyKey string
	RequestHash    string
}

type AgentMonthlyConfirmResult struct {
	BuildID     int64
	ReportID    int64
	Replayed    bool
	ProjectID   int64
	ProjectName string
	Country     string
	ReportMonth string
	Version     int
	IsCurrent   bool
	Status      string
	ConfirmedAt *time.Time
}

type AgentMonthlyBuildClaim struct {
	Build           *AgentMonthlyBuild
	TransactionPath string
	SummaryPDFPath  string
}

type AgentMonthlyAutoReconcileInput struct {
	ReportID  int64
	Tolerance float64
	Country   *string
	AgentID   string
}

type AgentMonthlyManualReconcileInput struct {
	ReportID   int64
	Tolerance  float64
	AgentID    string
	ExcelBytes []byte
	PDFBytes   []byte
}

type AgentMonthlyReconciliationRecord struct {
	ID              int64          `json:"id"`
	ReportID        int64          `json:"report_id"`
	Mode            string         `json:"mode"`
	MatchRate       float64        `json:"match_rate"`
	MatchedItems    int            `json:"matched_items"`
	MismatchedItems int            `json:"mismatched_items"`
	MissingItems    int            `json:"missing_items"`
	TotalItems      int            `json:"total_items"`
	Summary         map[string]any `json:"summary"`
	Items           []any          `json:"items"`
	CreatedAt       string         `json:"created_at"`
}

type AgentMonthlyReconciliationHistory struct {
	Records []AgentMonthlyReconciliationRecord `json:"records"`
	Total   int64                              `json:"total"`
	Limit   int                                `json:"limit"`
	Offset  int                                `json:"offset"`
}
