package monthly_reports

import (
	"context"
	"errors"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"
)

const (
	MonthlyReportStatusPending = "pending"
	MonthlyReportStatusRunning = "running"
	MonthlyReportStatusSuccess = "success"
	MonthlyReportStatusFailed  = "failed"

	MonthlyReportStatusCalculating = MonthlyReportStatusRunning
	MonthlyReportStatusCompleted   = MonthlyReportStatusSuccess

	MonthlyReportExportFormatExcel = "excel"
	MonthlyReportExportFormatPDF   = "pdf"
)

var (
	ErrProjectNotFound         = errors.New("project not found")
	ErrProjectForbidden        = errors.New("project forbidden")
	ErrReportNotFound          = errors.New("monthly report not found")
	ErrReportNotReady          = errors.New("monthly report is not ready")
	ErrReportFinalized         = errors.New("monthly report is finalized")
	ErrAlreadyConfirmed        = errors.New("monthly report is already confirmed")
	ErrExportNotFound          = errors.New("monthly report export not found")
	ErrTransactionFileRequired = errors.New("transaction_file_id is required")
	ErrTaskNotFound            = errors.New("monthly report task not found")
	ErrTaskNotFinished         = errors.New("monthly report task is not finished")
	ErrInvalidFinancialRange   = errors.New("invalid monthly financial range")
)

type MonthlyReport struct {
	ID                 int64   `json:"id"`
	JobID              int64   `json:"-"`
	ProjectID          int64   `json:"project_id"`
	ProjectName        string  `json:"project_name"`
	Country            string  `json:"country"`
	ReportMonth        string  `json:"report_month"`
	Version            int     `json:"version"`
	IsCurrent          bool    `json:"is_current"`
	SupersededAt       *string `json:"superseded_at"`
	Status             string  `json:"status"`
	SettlementID       *string `json:"settlement_id"`
	TotalTransactions  int     `json:"total_transactions"`
	TotalOrders        int     `json:"total_orders"`
	TotalRefunds       int     `json:"total_refunds"`
	TotalAdjustments   int     `json:"total_adjustments"`
	TotalServiceFees   int     `json:"total_service_fees"`
	TotalTransFees     int     `json:"total_trans_fees"`
	ResultFilePath     *string `json:"result_file_path"`
	SummaryPDFR2URL    *string `json:"-"`
	ErrorMessage       *string `json:"error_message"`
	CalculationVersion int     `json:"calculation_version"`
	ComputedAt         *string `json:"computed_at"`
	CreatedAt          string  `json:"created_at"`
	UpdatedAt          string  `json:"updated_at"`

	ExportFilePath        *string `json:"-"`
	SummaryPDFStoragePath *string `json:"-"`
}

type MonthlyReportProject struct {
	ID                int64   `json:"id"`
	ProjectName       string  `json:"project_name"`
	Country           string  `json:"country"`
	ProjectOperator   *string `json:"project_operator"`
	AssistantOperator *string `json:"assistant_operator"`
}

type MonthlyReportSalesSummary struct {
	IncomeTotal        float64 `json:"income_total"`
	IncomeVATTotal     float64 `json:"income_vat_total"`
	IncomeSalesWithTax float64 `json:"income_sales_with_tax"`
	ExpenseTotal       float64 `json:"expense_total"`
	AmazonPayBack      float64 `json:"amazon_pay_back"`
	NetAmount          float64 `json:"net_amount"`
}

type MonthlyReportSettlementSummary struct {
	SettlementID      *string `json:"settlement_id"`
	TotalTransactions int     `json:"total_transactions"`
	TotalOrders       int     `json:"total_orders"`
	TotalRefunds      int     `json:"total_refunds"`
	TotalAdjustments  int     `json:"total_adjustments"`
	TotalServiceFees  int     `json:"total_service_fees"`
	TotalTransFees    int     `json:"total_trans_fees"`
}

type MonthlyReportFee struct {
	Key    string  `json:"key"`
	Label  string  `json:"label"`
	Amount float64 `json:"amount"`
}

type MonthlyReportPurchaseCost struct {
	FOBCostRMB      float64  `json:"fob_cost_rmb"`
	FirstLegCostRMB float64  `json:"first_leg_cost_rmb"`
	TotalCostRMB    float64  `json:"total_cost_rmb"`
	ExchangeRate    *float64 `json:"exchange_rate"`
	TotalCostLocal  *float64 `json:"total_cost_local"`
}

type MonthlyReportProfit struct {
	Currency      string   `json:"currency"`
	NetProfit     float64  `json:"net_profit"`
	NetProfitRMB  float64  `json:"net_profit_rmb"`
	NetProfitUSD  *float64 `json:"net_profit_usd"`
	NetProfitRate float64  `json:"net_profit_rate"`
}

type MonthlyReportDetail struct {
	Report       MonthlyReport                  `json:"report"`
	Project      MonthlyReportProject           `json:"-"`
	Year         int                            `json:"-"`
	Month        int                            `json:"-"`
	SalesSummary MonthlyReportSalesSummary      `json:"-"`
	Settlement   MonthlyReportSettlementSummary `json:"-"`
	PlatformFees []MonthlyReportFee             `json:"-"`
	RefundFees   []MonthlyReportFee             `json:"-"`
	PurchaseCost MonthlyReportPurchaseCost      `json:"-"`
	Profit       MonthlyReportProfit            `json:"-"`
	PT3          map[string]float64             `json:"pt3"`
	PT4          map[string]float64             `json:"pt4"`
}

type MonthlyReportStatusResponse struct {
	ReportID     int64   `json:"report_id"`
	Status       string  `json:"status"`
	Stage        string  `json:"stage"`
	Progress     int     `json:"progress"`
	Message      *string `json:"message"`
	ErrorMessage *string `json:"error_message"`
	CreatedAt    string  `json:"created_at"`
	UpdatedAt    string  `json:"updated_at"`
}

type MonthlyReportListFilter struct {
	ProjectID      *int64
	Country        *string
	ReportMonth    *string
	Year           *int
	Month          *int
	Status         *string
	IncludeHistory bool
	Operator       string
	IsAdmin        bool
	Limit          *int
	Offset         int
}

type MonthlyReportGenerateInput struct {
	ProjectID           *int64
	ProjectName         *string
	Country             string
	ReportMonth         string
	TransactionFileID   *string
	TransactionFilePath *string
	SummaryPDFFileID    *string
	SummaryPDFFilePath  *string
	Async               bool
	Operator            string
	IsAdmin             bool
}

type GenerateMonthlyReportResponse struct {
	ReportID       int64  `json:"report_id"`
	Status         string `json:"status"`
	StatusEndpoint string `json:"status_endpoint"`
	CreatedAt      string `json:"created_at"`
}

type MonthlyReportResponse struct {
	JobID           int64   `json:"job_id"`
	MonthlyReportID *int64  `json:"monthly_report_id"`
	StatusEndpoint  *string `json:"status_endpoint"`
	ResultEndpoint  string  `json:"result_endpoint"`
	Status          string  `json:"status"`
	CreatedAt       *string `json:"created_at"`
}

type MonthlyFinancialSeriesFilter struct {
	ProjectID   int64
	Country     string
	StartMonth  string
	EndMonth    string
	FillMissing bool
}

type MonthlyFinancialSeriesResponse struct {
	ProjectID   int64                       `json:"project_id"`
	ProjectName string                      `json:"project_name"`
	StartMonth  string                      `json:"start_month"`
	EndMonth    string                      `json:"end_month"`
	Rows        []MonthlyFinancialSeriesRow `json:"rows"`
	Trend       MonthlyFinancialTrend       `json:"trend"`
}

type MonthlyFinancialSeriesRow struct {
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

type MonthlyFinancialTrend struct {
	IncomeTotalSum   float64                      `json:"income_total_sum"`
	ExpenseTotalSum  float64                      `json:"expense_total_sum"`
	AmazonPayBackSum float64                      `json:"amazon_pay_back_sum"`
	NetAmountSum     float64                      `json:"net_amount_sum"`
	Points           []MonthlyFinancialTrendPoint `json:"points"`
}

type MonthlyFinancialTrendPoint struct {
	ReportMonth     string  `json:"report_month"`
	IncomeTotal     float64 `json:"income_total"`
	ExpenseTotal    float64 `json:"expense_total"`
	AmazonPayBack   float64 `json:"amazon_pay_back"`
	NetAmount       float64 `json:"net_amount"`
	VATTotal        float64 `json:"vat_total"`
	HasSourceReport bool    `json:"has_source_report"`
}

type MonthlyFinancialAccountingFilter struct {
	ProjectID   int64
	Country     string
	ReportMonth string
	IsAdmin     bool
}

type MonthlyFinancialAccountingDetailResponse struct {
	ProjectID   int64                            `json:"project_id"`
	ProjectName string                           `json:"project_name"`
	ReportMonth string                           `json:"report_month"`
	Rows        []MonthlyFinancialAccountingLine `json:"rows"`
}

type MonthlyFinancialAccountingLine struct {
	IncomeEN         string  `json:"income_en"`
	IncomeZH         string  `json:"income_zh"`
	IncomeAmountUSD  float64 `json:"income_amount_usd"`
	IncomeSource     string  `json:"income_source"`
	ExpenseEN        string  `json:"expense_en"`
	ExpenseZH        string  `json:"expense_zh"`
	ExpenseAmountUSD float64 `json:"expense_amount_usd"`
	ExpenseSource    string  `json:"expense_source"`
	CurrencyCode     *string `json:"currency_code"`
	Kind             string  `json:"kind"`
}

type MonthlyReportTask struct {
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

	ProjectID      int64   `json:"-"`
	ResultFilePath *string `json:"-"`
}

type MonthlyReportExport struct {
	Filename    string  `json:"-"`
	ContentType string  `json:"-"`
	Path        string  `json:"-"`
	Content     []byte  `json:"-"`
	RedirectURL *string `json:"-"`
	ProjectID   int64   `json:"-"`
}

type JobEnqueuer interface {
	EnqueueRunJob(ctx context.Context, jobID int64) error
}

type GenerationFailureMarker interface {
	MarkGenerationFailed(ctx context.Context, reportID, jobID int64, message string) error
}

type Store interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error
	List(ctx context.Context, filter MonthlyReportListFilter) ([]MonthlyReport, error)
	GetReport(ctx context.Context, reportID int64) (*MonthlyReportDetail, error)
	Generate(ctx context.Context, input MonthlyReportGenerateInput) (*MonthlyReport, error)
	PromoteCompletedReport(ctx context.Context, reportID int64) error
	GetStatus(ctx context.Context, reportID int64) (*MonthlyReportStatusResponse, error)
	ConfirmReport(ctx context.Context, reportID int64) (*MonthlyReport, error)
	DeleteDraft(ctx context.Context, reportID int64) (*MonthlyReport, error)
	ExportReport(ctx context.Context, reportID int64, format string) (*MonthlyReportExport, error)
	RunInTx(
		ctx context.Context,
		fn func(context.Context, pgx.Tx, Store) error,
	) error
}

// ExtendedStore is the FastAPI-compatible read/export surface used by the
// canonical monthly-report routes. It is separate from Store so legacy
// registrars and test doubles keep compiling when they only exercise the
// original Go routes.
type ExtendedStore interface {
	Store
	ExportReportFile(ctx context.Context, reportID int64) (*MonthlyReportExport, error)
	GetFinancialSeries(
		ctx context.Context,
		filter MonthlyFinancialSeriesFilter,
	) (*MonthlyFinancialSeriesResponse, error)
	RecalculateFinancialSeries(
		ctx context.Context,
		filter MonthlyFinancialSeriesFilter,
	) (*MonthlyFinancialSeriesResponse, error)
	GetAccountingDetail(
		ctx context.Context,
		filter MonthlyFinancialAccountingFilter,
	) (*MonthlyFinancialAccountingDetailResponse, error)
	ExportAccountingDetail(
		ctx context.Context,
		filter MonthlyFinancialAccountingFilter,
	) (*MonthlyReportExport, error)
	GetTask(ctx context.Context, taskID int64) (*MonthlyReportTask, error)
	GetTaskResult(ctx context.Context, taskID int64) (*MonthlyReportExport, error)
}

// SafeSummaryPDFRedirect validates server-controlled PDF redirects before they
// are returned to the HTTP layer.
func SafeSummaryPDFRedirect(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.ContainsAny(raw, "\r\n") {
		return "", false
	}
	parsed, err := url.Parse(raw)
	if err != nil ||
		!strings.EqualFold(parsed.Scheme, "https") ||
		parsed.Host == "" ||
		parsed.Hostname() == "" ||
		parsed.User != nil ||
		parsed.Opaque != "" {
		return "", false
	}
	return parsed.String(), true
}
