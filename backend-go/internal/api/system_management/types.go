package system_management

import (
	"context"
	"time"
)

type AuditLogFilter struct {
	Page       int
	PageSize   int
	Operator   string
	Action     string
	TargetType string
	Result     string
	Keyword    string
}

type AuditLogItem struct {
	ID            int64   `json:"id"`
	CreatedAt     string  `json:"created_at"`
	Operator      *string `json:"operator"`
	Action        string  `json:"action"`
	TargetType    string  `json:"target_type"`
	TargetID      *string `json:"target_id"`
	Result        string  `json:"result"`
	TraceID       *string `json:"trace_id"`
	RequestMethod *string `json:"request_method"`
	RequestPath   *string `json:"request_path"`
	IPAddress     *string `json:"ip_address"`
	UserAgent     *string `json:"user_agent"`
	BeforeJSON    any     `json:"before_json"`
	AfterJSON     any     `json:"after_json"`
	ErrorMessage  *string `json:"error_message"`
}

type AuditLogPage struct {
	Items    []AuditLogItem `json:"items"`
	Total    int            `json:"total"`
	Page     int            `json:"page"`
	PageSize int            `json:"page_size"`
	HasNext  bool           `json:"has_next"`
}

type AuditModuleSummary struct {
	Key          string `json:"key"`
	Label        string `json:"label"`
	Count        int    `json:"count"`
	SuccessCount int    `json:"success_count"`
	FailureCount int    `json:"failure_count"`
}

type AuditActionSummary struct {
	Action string `json:"action"`
	Count  int    `json:"count"`
}

type AuditLogSummary struct {
	Total               int                  `json:"total"`
	SuccessCount        int                  `json:"success_count"`
	FailureCount        int                  `json:"failure_count"`
	UniqueOperatorCount int                  `json:"unique_operator_count"`
	Modules             []AuditModuleSummary `json:"modules"`
	TopActions          []AuditActionSummary `json:"top_actions"`
}

type AgentAccessLogFilter struct {
	Page          int
	PageSize      int
	Keyword       string
	Method        string
	StatusCode    *int
	Result        string
	DateFrom      string
	DateTo        string
	ProjectID     *int64
	OperationType string
	Country       string
}

type AgentAccessLogItem struct {
	ID            int64   `json:"id"`
	CreatedAt     string  `json:"created_at"`
	Method        string  `json:"method"`
	Path          string  `json:"path"`
	StatusCode    int     `json:"status_code"`
	LatencyMS     int     `json:"latency_ms"`
	IPAddress     *string `json:"ip_address"`
	APIKeyID      *int64  `json:"api_key_id"`
	AgentID       *string `json:"agent_id"`
	KeyLabel      *string `json:"key_label"`
	ProjectID     *int64  `json:"project_id"`
	ProjectName   *string `json:"project_name"`
	OperationType *string `json:"operation_type"`
	Country       *string `json:"country"`
}

type AgentAccessLogPage struct {
	Items    []AgentAccessLogItem `json:"items"`
	Total    int                  `json:"total"`
	Page     int                  `json:"page"`
	PageSize int                  `json:"page_size"`
	HasNext  bool                 `json:"has_next"`
}

type AgentAccessSummaryItem struct {
	AgentID  string  `json:"agent_id"`
	KeyLabel *string `json:"key_label"`
	Count    int     `json:"count"`
}

type AgentAccessLogSummary struct {
	Total            int                      `json:"total"`
	SuccessCount     int                      `json:"success_count"`
	ErrorCount       int                      `json:"error_count"`
	UniqueAgentCount int                      `json:"unique_agent_count"`
	TopAgents        []AgentAccessSummaryItem `json:"top_agents"`
}

type AgentOperationLogFilter struct {
	Page      int
	PageSize  int
	AgentID   string
	ProjectID *int64
	Action    string
	Result    string
	DateFrom  string
	DateTo    string
	Keyword   string
}

type AgentOperationLogItem struct {
	ID             int64   `json:"id"`
	CreatedAt      string  `json:"created_at"`
	AgentID        *string `json:"agent_id"`
	AgentName      *string `json:"agent_name"`
	Action         string  `json:"action"`
	TargetType     string  `json:"target_type"`
	TargetID       *string `json:"target_id"`
	TargetLabel    *string `json:"target_label"`
	Result         string  `json:"result"`
	ProjectID      *int64  `json:"project_id"`
	ProjectName    *string `json:"project_name"`
	OperationType  *string `json:"operation_type"`
	RequestPath    *string `json:"request_path"`
	RequestMethod  *string `json:"request_method"`
	BeforeJSON     any     `json:"before_json"`
	AfterJSON      any     `json:"after_json"`
	IdempotencyKey *string `json:"idempotency_key"`
	ErrorMessage   *string `json:"error_message"`
}

type AgentOperationLogPage struct {
	Items    []AgentOperationLogItem `json:"items"`
	Total    int                     `json:"total"`
	Page     int                     `json:"page"`
	PageSize int                     `json:"page_size"`
	HasNext  bool                    `json:"has_next"`
}

type AgentOperationSummaryItem struct {
	AgentID   string  `json:"agent_id"`
	AgentName *string `json:"agent_name"`
	Count     int     `json:"count"`
}

type AgentOperationActionSummaryItem struct {
	Action string `json:"action"`
	Count  int    `json:"count"`
}

type AgentOperationLogSummary struct {
	Total            int                               `json:"total"`
	SuccessCount     int                               `json:"success_count"`
	FailureCount     int                               `json:"failure_count"`
	UniqueAgentCount int                               `json:"unique_agent_count"`
	TopAgents        []AgentOperationSummaryItem       `json:"top_agents"`
	TopActions       []AgentOperationActionSummaryItem `json:"top_actions"`
}

type OperatorPerformanceItem struct {
	ID          int64   `json:"id"`
	ReportMonth string  `json:"report_month"`
	WeekIndex   int     `json:"week_index"`
	ProjectID   int64   `json:"project_id"`
	ProjectName string  `json:"project_name"`
	PersonName  string  `json:"person_name"`
	RoleType    string  `json:"role_type"`
	Score       int     `json:"score"`
	Note        *string `json:"note"`
	UpdatedBy   *string `json:"updated_by"`
	UpdatedAt   string  `json:"updated_at"`
}

type OperatorPerformanceResponse struct {
	ReportMonth string                    `json:"report_month"`
	Items       []OperatorPerformanceItem `json:"items"`
}

type OperatorPerformanceUpsertItem struct {
	ID          *int64  `json:"id"`
	ReportMonth string  `json:"report_month"`
	WeekIndex   int     `json:"week_index"`
	ProjectID   int64   `json:"project_id"`
	ProjectName string  `json:"project_name"`
	PersonName  string  `json:"person_name"`
	RoleType    string  `json:"role_type"`
	Score       int     `json:"score"`
	Note        *string `json:"note"`
}

type OperatorPerformanceUpsertRequest struct {
	Items []OperatorPerformanceUpsertItem `json:"items"`
}

type ClientActionRequest struct {
	Action       string  `json:"action"`
	TargetType   string  `json:"target_type"`
	TargetID     *string `json:"target_id"`
	Result       string  `json:"result"`
	After        any     `json:"after"`
	ErrorMessage *string `json:"error_message"`
}

type DataLifecycleStatus string

const (
	DataStatusActive      DataLifecycleStatus = "active"
	DataStatusMaintenance DataLifecycleStatus = "maintenance"
	DataStatusReadOnly    DataLifecycleStatus = "read_only"
	DataStatusPaused      DataLifecycleStatus = "paused"
)

type TableHealthStatus string

const (
	TableHealthy TableHealthStatus = "healthy"
	TableEmpty   TableHealthStatus = "empty"
	TableStale   TableHealthStatus = "stale"
	TableError   TableHealthStatus = "error"
)

type DatabaseStatus struct {
	Engine    string  `json:"engine"`
	Source    *string `json:"source"`
	Healthy   bool    `json:"healthy"`
	CheckedAt string  `json:"checked_at"`
}

type DataSummary struct {
	TotalTables int                 `json:"total_tables"`
	TotalRows   int64               `json:"total_rows"`
	StaleTables int                 `json:"stale_tables"`
	DataStatus  DataLifecycleStatus `json:"data_status"`
}

type DataState struct {
	Status    DataLifecycleStatus `json:"status"`
	Note      *string             `json:"note"`
	UpdatedAt *string             `json:"updated_at"`
	UpdatedBy *string             `json:"updated_by"`
}

type DataManagementSnapshot struct {
	ServerTime     string
	Database       DatabaseStatus
	Summary        DataSummary
	DataStatusNote *string
	DataStatusAt   *string
	DataStatusBy   *string
	Tables         []TableStatusItem
	RecentStatuses []RecentStatusItem
}

type DataManagementStatusResponse struct {
	ServerTime          string         `json:"server_time"`
	Database            DatabaseStatus `json:"database"`
	CacheEnabled        bool           `json:"cache_enabled"`
	Summary             DataSummary    `json:"summary"`
	DataStatusNote      *string        `json:"data_status_note"`
	DataStatusUpdatedAt *string        `json:"data_status_updated_at"`
	DataStatusUpdatedBy *string        `json:"data_status_updated_by"`
}

type TableStatusItem struct {
	TableName     string            `json:"table_name"`
	TableNameCN   *string           `json:"table_name_cn"`
	RowCount      *int64            `json:"row_count"`
	LastUpdatedAt *string           `json:"last_updated_at"`
	Status        TableHealthStatus `json:"status"`
	Note          *string           `json:"note"`
}

type RecentStatusItem struct {
	Source     string `json:"source"`
	Level      string `json:"level"`
	Message    string `json:"message"`
	OccurredAt string `json:"occurred_at"`
}

type DataManagementOverviewResponse struct {
	ServerTime          string             `json:"server_time"`
	Database            DatabaseStatus     `json:"database"`
	CacheEnabled        bool               `json:"cache_enabled"`
	Summary             DataSummary        `json:"summary"`
	DataStatusNote      *string            `json:"data_status_note"`
	DataStatusUpdatedAt *string            `json:"data_status_updated_at"`
	DataStatusUpdatedBy *string            `json:"data_status_updated_by"`
	Tables              []TableStatusItem  `json:"tables"`
	RecentStatuses      []RecentStatusItem `json:"recent_statuses"`
}

type UpdateDataStatusRequest struct {
	Status DataLifecycleStatus `json:"status"`
	Note   *string             `json:"note"`
}

type UpdateDataStatusResponse struct {
	Status    DataLifecycleStatus `json:"status"`
	Note      *string             `json:"note"`
	UpdatedAt string              `json:"updated_at"`
	UpdatedBy *string             `json:"updated_by"`
}

type ClearCacheResponse struct {
	DeletedCount int    `json:"deleted_count"`
	Message      string `json:"message"`
}

type CommissionRecordItem struct {
	ID                    int64    `json:"id"`
	ReportMonth           string   `json:"report_month"`
	Country               string   `json:"country"`
	ProjectID             int64    `json:"project_id"`
	ProjectName           string   `json:"project_name"`
	ProjectMonthID        *int64   `json:"project_month_id"`
	PersonName            string   `json:"person_name"`
	IncomeCategory        string   `json:"income_category"`
	IncomeTotalUSD        float64  `json:"income_total_usd"`
	FactoryCommissionRate float64  `json:"factory_commission_rate"`
	OperatorBonusRatio    float64  `json:"operator_bonus_ratio"`
	BonusAmountUSD        float64  `json:"bonus_amount_usd"`
	USDToRMBRate          float64  `json:"usd_to_rmb_rate"`
	BonusAmountRMB        float64  `json:"bonus_amount_rmb"`
	BonusRatioSource      string   `json:"bonus_ratio_source"`
	ManualBonusRatio      *float64 `json:"manual_bonus_ratio"`
	PaymentStatus         string   `json:"payment_status"`
	PaymentConfirmedAt    *string  `json:"payment_confirmed_at"`
	PaymentConfirmedBy    *string  `json:"payment_confirmed_by"`
	IsLocked              bool     `json:"is_locked"`
	LockedAt              *string  `json:"locked_at"`
	LockedBy              *string  `json:"locked_by"`
	IsActive              bool     `json:"is_active"`
	DeactivatedAt         *string  `json:"deactivated_at"`
	ComputedAt            string   `json:"computed_at"`
	UpdatedAt             string   `json:"updated_at"`
}

type CommissionRecordUpsertItem struct {
	ProjectID             int64    `json:"project_id"`
	ProjectName           string   `json:"project_name"`
	PersonName            string   `json:"person_name"`
	IncomeCategory        string   `json:"income_category"`
	IncomeTotalUSD        float64  `json:"income_total_usd"`
	FactoryCommissionRate float64  `json:"factory_commission_rate"`
	OperatorBonusRatio    float64  `json:"operator_bonus_ratio"`
	BonusAmountUSD        float64  `json:"bonus_amount_usd"`
	USDToRMBRate          float64  `json:"usd_to_rmb_rate"`
	BonusAmountRMB        float64  `json:"bonus_amount_rmb"`
	BonusRatioSource      string   `json:"bonus_ratio_source"`
	ManualBonusRatio      *float64 `json:"manual_bonus_ratio"`
}

type UpsertCommissionRecordsRequest struct {
	ReportMonth string                       `json:"report_month"`
	Items       []CommissionRecordUpsertItem `json:"items"`
}

type CommissionRecordsResponse struct {
	ReportMonth string                 `json:"report_month"`
	Items       []CommissionRecordItem `json:"items"`
}

type UpdateCommissionPaymentStatusRequest struct {
	PaymentStatus string `json:"payment_status"`
}

type UpdateCommissionPaymentStatusResponse struct {
	Item CommissionRecordItem `json:"item"`
}

type CommissionRecordMutation struct {
	Before *CommissionRecordItem
	After  *CommissionRecordItem
}

type CommissionProjectMonthItem struct {
	ID                    int64   `json:"id"`
	ReportMonth           string  `json:"report_month"`
	Country               string  `json:"country"`
	ProjectID             int64   `json:"project_id"`
	ProjectName           string  `json:"project_name"`
	IncomeTotalUSD        float64 `json:"income_total_usd"`
	FactoryCommissionRate float64 `json:"factory_commission_rate"`
	USDToRMBRate          float64 `json:"usd_to_rmb_rate"`
	FactoryCommissionUSD  float64 `json:"factory_commission_usd"`
	FactoryCommissionRMB  float64 `json:"factory_commission_rmb"`
	PaymentStatus         string  `json:"payment_status"`
	ReceivedRMB           float64 `json:"received_rmb"`
	PaymentConfirmedAt    *string `json:"payment_confirmed_at"`
	PaymentConfirmedBy    *string `json:"payment_confirmed_by"`
	Note                  *string `json:"note"`
	ComputedAt            string  `json:"computed_at"`
	UpdatedAt             string  `json:"updated_at"`
}

type CommissionProjectMonthsResponse struct {
	ReportMonth string                       `json:"report_month"`
	Items       []CommissionProjectMonthItem `json:"items"`
}

type UpdateCommissionProjectPaymentRequest struct {
	PaymentStatus string  `json:"payment_status"`
	ReceivedRMB   float64 `json:"received_rmb"`
	Note          *string `json:"note"`
}

type UpdateCommissionProjectPaymentResponse struct {
	Item CommissionProjectMonthItem `json:"item"`
}

type CommissionProjectMonthMutation struct {
	Before *CommissionProjectMonthItem
	After  *CommissionProjectMonthItem
}

type CommissionRatioOverrideItem struct {
	ID             int64   `json:"id"`
	ReportMonth    string  `json:"report_month"`
	ProjectID      int64   `json:"project_id"`
	ProjectName    string  `json:"project_name"`
	PersonName     string  `json:"person_name"`
	IncomeCategory string  `json:"income_category"`
	OverrideRatio  float64 `json:"override_ratio"`
	Reason         *string `json:"reason"`
	UpdatedBy      *string `json:"updated_by"`
	UpdatedAt      string  `json:"updated_at"`
}

type CommissionRatioOverrideUpsertItem struct {
	ProjectID      int64   `json:"project_id"`
	ProjectName    string  `json:"project_name"`
	PersonName     string  `json:"person_name"`
	IncomeCategory string  `json:"income_category"`
	OverrideRatio  float64 `json:"override_ratio"`
	Reason         *string `json:"reason"`
}

type UpsertCommissionRatioOverridesRequest struct {
	ReportMonth string                              `json:"report_month"`
	Items       []CommissionRatioOverrideUpsertItem `json:"items"`
}

type CommissionRatioOverridesResponse struct {
	ReportMonth string                        `json:"report_month"`
	Items       []CommissionRatioOverrideItem `json:"items"`
}

type ProjectRoleAssignmentItem struct {
	ID                 int64   `json:"id"`
	ProjectID          int64   `json:"project_id"`
	RoleType           string  `json:"role_type"`
	PersonName         string  `json:"person_name"`
	EffectiveFromMonth string  `json:"effective_from_month"`
	EffectiveToMonth   *string `json:"effective_to_month"`
	UpdatedAt          string  `json:"updated_at"`
}

type ProjectRoleAssignmentUpsertItem struct {
	ID                 *int64  `json:"id"`
	ProjectID          int64   `json:"project_id"`
	RoleType           string  `json:"role_type"`
	PersonName         string  `json:"person_name"`
	EffectiveFromMonth string  `json:"effective_from_month"`
	EffectiveToMonth   *string `json:"effective_to_month"`
}

type UpsertProjectRoleAssignmentsRequest struct {
	Items []ProjectRoleAssignmentUpsertItem `json:"items"`
}

type ProjectRoleAssignmentsResponse struct {
	Items []ProjectRoleAssignmentItem `json:"items"`
}

type CommissionYearlyMonthlySummaryItem struct {
	ReportMonth          string  `json:"report_month"`
	IncomeTotalUSD       float64 `json:"income_total_usd"`
	FactoryCommissionUSD float64 `json:"factory_commission_usd"`
	FactoryCommissionRMB float64 `json:"factory_commission_rmb"`
	ReceivedRMB          float64 `json:"received_rmb"`
	ReceiveRate          float64 `json:"receive_rate"`
}

type CommissionYearlyMonthlySummaryResponse struct {
	Year  string                               `json:"year"`
	Items []CommissionYearlyMonthlySummaryItem `json:"items"`
}

type CommissionProjectMonthlySummaryMonthItem struct {
	ReportMonth          string  `json:"report_month"`
	IncomeTotalUSD       float64 `json:"income_total_usd"`
	FactoryCommissionRMB float64 `json:"factory_commission_rmb"`
	ReceivedRMB          float64 `json:"received_rmb"`
	ReceiveRate          float64 `json:"receive_rate"`
}

type CommissionProjectYearlySummaryItem struct {
	ProjectID          int64                                               `json:"project_id"`
	ProjectName        string                                              `json:"project_name"`
	Months             map[string]CommissionProjectMonthlySummaryMonthItem `json:"months"`
	TotalIncomeUSD     float64                                             `json:"total_income_usd"`
	TotalCommissionRMB float64                                             `json:"total_commission_rmb"`
	TotalReceivedRMB   float64                                             `json:"total_received_rmb"`
	ReceiveRate        float64                                             `json:"receive_rate"`
}

type CommissionProjectYearlySummaryResponse struct {
	Year  string                               `json:"year"`
	Items []CommissionProjectYearlySummaryItem `json:"items"`
}

type RecomputeCommissionRequest struct {
	ReportMonth string `json:"report_month"`
}

type RecomputeCommissionResponse struct {
	ReportMonth       string `json:"report_month"`
	ProjectMonthCount int    `json:"project_month_count"`
	RecordCount       int    `json:"record_count"`
	LockedRecordCount int    `json:"locked_record_count"`
	ComputedAt        string `json:"computed_at"`
}

type CommissionRecordFilter struct {
	ReportMonth     string
	Country         string
	PersonName      string
	IncludeInactive bool
}

type RecomputeCommissionInput struct {
	ReportMonth string
	Country     *string
	Now         time.Time
}

type RecomputeCommissionResult struct {
	ProjectMonthCount int
	RecordCount       int
	LockedRecordCount int
}

type CacheClearer interface {
	ClearAll(ctx context.Context) (int, error)
}

type Store interface {
	ListAuditLogs(ctx context.Context, filter AuditLogFilter) (AuditLogPage, error)
	AuditLogSummary(ctx context.Context, filter AuditLogFilter) (AuditLogSummary, error)
	ListAgentAccessLogs(ctx context.Context, filter AgentAccessLogFilter) (AgentAccessLogPage, error)
	AgentAccessLogSummary(ctx context.Context, filter AgentAccessLogFilter) (AgentAccessLogSummary, error)
	ListAgentOperationLogs(ctx context.Context, filter AgentOperationLogFilter) (AgentOperationLogPage, error)
	AgentOperationLogSummary(ctx context.Context, filter AgentOperationLogFilter) (AgentOperationLogSummary, error)
	ListOperatorPerformance(ctx context.Context, reportMonth string, projectID *int64) ([]OperatorPerformanceItem, error)
	UpsertOperatorPerformance(ctx context.Context, items []OperatorPerformanceUpsertItem, operator *string) (string, []OperatorPerformanceItem, error)
	GetDataStatus(ctx context.Context) (DataState, error)
	InspectDataManagement(ctx context.Context) (DataManagementSnapshot, error)
	SetDataStatus(ctx context.Context, status DataLifecycleStatus, note *string, operator *string) (DataState, error)
	ListCommissionRecords(ctx context.Context, filter CommissionRecordFilter) ([]CommissionRecordItem, error)
	UpsertCommissionRecords(ctx context.Context, reportMonth, country string, items []CommissionRecordUpsertItem, now time.Time) ([]CommissionRecordItem, error)
	UpdateCommissionRecordPayment(ctx context.Context, recordID int64, status string, now time.Time, operator *string) (CommissionRecordMutation, error)
	ListCommissionProjectMonths(ctx context.Context, reportMonth string, country *string) ([]CommissionProjectMonthItem, error)
	UpdateCommissionProjectPayment(ctx context.Context, projectMonthID int64, status string, receivedRMB float64, note *string, now time.Time, operator *string) (CommissionProjectMonthMutation, error)
	ListCommissionRatioOverrides(ctx context.Context, reportMonth string) ([]CommissionRatioOverrideItem, error)
	UpsertCommissionRatioOverrides(ctx context.Context, reportMonth string, items []CommissionRatioOverrideUpsertItem, operator *string) ([]CommissionRatioOverrideItem, error)
	ListProjectRoleAssignments(ctx context.Context, reportMonth *string, projectID *int64) ([]ProjectRoleAssignmentItem, error)
	UpsertProjectRoleAssignments(ctx context.Context, items []ProjectRoleAssignmentUpsertItem) ([]ProjectRoleAssignmentItem, error)
	GetCommissionMonthlySummary(ctx context.Context, year string, country *string) ([]CommissionYearlyMonthlySummaryItem, error)
	GetCommissionProjectSummary(ctx context.Context, year string, country *string) ([]CommissionProjectYearlySummaryItem, error)
	RecomputeCommission(ctx context.Context, input RecomputeCommissionInput) (RecomputeCommissionResult, error)
}

type Option func(*options)

type options struct {
	databaseURL string
	cache       CacheClearer
	now         func() time.Time
}

func WithDatabaseURL(value string) Option {
	return func(options *options) { options.databaseURL = value }
}

func WithCacheClearer(value CacheClearer) Option {
	return func(options *options) { options.cache = value }
}

func WithNow(value func() time.Time) Option {
	return func(options *options) {
		if value != nil {
			options.now = value
		}
	}
}
