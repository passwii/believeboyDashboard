package crm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Optional[T any] struct {
	Set   bool
	Value *T
}

func (optional *Optional[T]) UnmarshalJSON(data []byte) error {
	optional.Set = true
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		optional.Value = nil
		return nil
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	optional.Value = &value
	return nil
}

func (optional Optional[T]) Get() (T, bool) {
	var zero T
	if optional.Value == nil {
		return zero, false
	}
	return *optional.Value, true
}

type CategoryBrief struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

type Category struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	SortOrder int    `json:"sort_order"`
	CreatedAt string `json:"created_at"`
}

type Customer struct {
	ID                int64           `json:"id"`
	Name              string          `json:"name"`
	ShortName         *string         `json:"short_name"`
	Industry          *string         `json:"industry"`
	CustomerType      *string         `json:"customer_type"`
	InterestedService *string         `json:"interested_service"`
	Rating            string          `json:"rating"`
	ScoreScale        *string         `json:"score_scale"`
	ScorePay          *string         `json:"score_pay"`
	ScoreFit          *string         `json:"score_fit"`
	ScoreCoop         *string         `json:"score_coop"`
	Categories        []CategoryBrief `json:"categories"`
	Status            string          `json:"status"`
	Source            *string         `json:"source"`
	OwnerID           *string         `json:"owner_id"`
	OwnerName         *string         `json:"owner_name"`
	ContactName       *string         `json:"contact_name"`
	ContactPhone      *string         `json:"contact_phone"`
	ContactEmail      *string         `json:"contact_email"`
	ContactWechat     *string         `json:"contact_wechat"`
	Address           *string         `json:"address"`
	Website           *string         `json:"website"`
	AnnualRevenue     *float64        `json:"annual_revenue"`
	EmployeeCount     *int            `json:"employee_count"`
	Remark            *string         `json:"remark"`
	LastFollowAt      *string         `json:"last_follow_at"`
	NextFollowAt      *string         `json:"next_follow_at"`
	CreatedBy         *string         `json:"created_by"`
	CreatedAt         string          `json:"created_at"`
	UpdatedAt         string          `json:"updated_at"`
}

type CustomerListFilter struct {
	Scope        string
	Keyword      *string
	Filters      []FilterCondition
	SortBy       string
	SortOrder    string
	Page         int
	PageSize     int
	CategoryID   *int64
	ExportFormat string
}

type Contact struct {
	ID         int64   `json:"id"`
	CustomerID int64   `json:"customer_id"`
	Name       string  `json:"name"`
	Phone      *string `json:"phone"`
	Email      *string `json:"email"`
	Wechat     *string `json:"wechat"`
	Title      *string `json:"title"`
	IsPrimary  bool    `json:"is_primary"`
	Remark     *string `json:"remark"`
	CreatedAt  string  `json:"created_at"`
	UpdatedAt  string  `json:"updated_at"`
}

type CustomerCreateInput struct {
	Name              string   `json:"name"`
	ShortName         *string  `json:"short_name"`
	Industry          *string  `json:"industry"`
	CustomerType      *string  `json:"customer_type"`
	InterestedService *string  `json:"interested_service"`
	Rating            string   `json:"rating"`
	Status            string   `json:"status"`
	Source            *string  `json:"source"`
	OwnerID           *string  `json:"owner_id"`
	Address           *string  `json:"address"`
	Website           *string  `json:"website"`
	AnnualRevenue     *float64 `json:"annual_revenue"`
	EmployeeCount     *int     `json:"employee_count"`
	Remark            *string  `json:"remark"`
	ContactName       *string  `json:"contact_name"`
	ContactPhone      *string  `json:"contact_phone"`
	ContactEmail      *string  `json:"contact_email"`
}

type CustomerUpdateInput struct {
	Name              Optional[string]  `json:"name"`
	ShortName         Optional[string]  `json:"short_name"`
	Industry          Optional[string]  `json:"industry"`
	CustomerType      Optional[string]  `json:"customer_type"`
	InterestedService Optional[string]  `json:"interested_service"`
	Rating            Optional[string]  `json:"rating"`
	Status            Optional[string]  `json:"status"`
	Source            Optional[string]  `json:"source"`
	OwnerID           Optional[string]  `json:"owner_id"`
	Address           Optional[string]  `json:"address"`
	Website           Optional[string]  `json:"website"`
	AnnualRevenue     Optional[float64] `json:"annual_revenue"`
	EmployeeCount     Optional[int]     `json:"employee_count"`
	Remark            Optional[string]  `json:"remark"`
}

type CustomerSeaImportRow struct {
	Name              string   `json:"name"`
	ShortName         *string  `json:"short_name"`
	Industry          *string  `json:"industry"`
	CustomerType      *string  `json:"customer_type"`
	InterestedService *string  `json:"interested_service"`
	Rating            *string  `json:"rating"`
	Status            *string  `json:"status"`
	Source            *string  `json:"source"`
	Address           *string  `json:"address"`
	Website           *string  `json:"website"`
	AnnualRevenue     *float64 `json:"annual_revenue"`
	EmployeeCount     *int     `json:"employee_count"`
	Remark            *string  `json:"remark"`
	ContactName       *string  `json:"contact_name"`
	ContactPhone      *string  `json:"contact_phone"`
	ContactEmail      *string  `json:"contact_email"`
}

type CustomerSeaImportRequest struct {
	Rows []CustomerSeaImportRow `json:"rows"`
}

type CustomerSeaImportFail struct {
	Row    int     `json:"row"`
	Field  *string `json:"field"`
	Reason string  `json:"reason"`
}

type CustomerSeaImportResult struct {
	Created      int                     `json:"created"`
	SkippedDupes int                     `json:"skipped_dupes"`
	Failed       []CustomerSeaImportFail `json:"failed"`
}

type ValueScoresUpdateInput struct {
	ScoreScale *string `json:"score_scale"`
	ScorePay   *string `json:"score_pay"`
	ScoreFit   *string `json:"score_fit"`
	ScoreCoop  *string `json:"score_coop"`
}

type ContactCreateInput struct {
	Name      string  `json:"name"`
	Phone     *string `json:"phone"`
	Email     *string `json:"email"`
	Wechat    *string `json:"wechat"`
	Title     *string `json:"title"`
	IsPrimary bool    `json:"is_primary"`
	Remark    *string `json:"remark"`
}

type ContactUpdateInput struct {
	Name      Optional[string] `json:"name"`
	Phone     Optional[string] `json:"phone"`
	Email     Optional[string] `json:"email"`
	Wechat    Optional[string] `json:"wechat"`
	Title     Optional[string] `json:"title"`
	IsPrimary Optional[bool]   `json:"is_primary"`
	Remark    Optional[string] `json:"remark"`
}

type Lead struct {
	ID                    int64    `json:"id"`
	Name                  string   `json:"name"`
	Company               *string  `json:"company"`
	Phone                 *string  `json:"phone"`
	Email                 *string  `json:"email"`
	Wechat                *string  `json:"wechat"`
	Source                *string  `json:"source"`
	Status                string   `json:"status"`
	Intent                string   `json:"intent"`
	CustomerType          *string  `json:"customer_type"`
	InterestedService     *string  `json:"interested_service"`
	OwnerID               *string  `json:"owner_id"`
	OwnerName             *string  `json:"owner_name"`
	ExpectedAmount        *float64 `json:"expected_amount"`
	ExpectedCloseDate     *string  `json:"expected_close_date"`
	Remark                *string  `json:"remark"`
	NextFollowAt          *string  `json:"next_follow_at"`
	ConvertedToCustomerID *int64   `json:"converted_to_customer_id"`
	ConvertedAt           *string  `json:"converted_at"`
	EnteredStageAt        *string  `json:"entered_stage_at"`
	CreatedBy             *string  `json:"created_by"`
	CreatedAt             string   `json:"created_at"`
	UpdatedAt             string   `json:"updated_at"`
}

type LeadListFilter struct {
	Scope     string
	Keyword   *string
	Filters   []FilterCondition
	SortBy    string
	SortOrder string
	Page      int
	PageSize  int
}

type LeadCreateInput struct {
	Name              string   `json:"name"`
	Company           *string  `json:"company"`
	Phone             *string  `json:"phone"`
	Email             *string  `json:"email"`
	Wechat            *string  `json:"wechat"`
	Source            *string  `json:"source"`
	Status            string   `json:"status"`
	Intent            string   `json:"intent"`
	CustomerType      *string  `json:"customer_type"`
	InterestedService *string  `json:"interested_service"`
	OwnerID           *string  `json:"owner_id"`
	ExpectedAmount    *float64 `json:"expected_amount"`
	ExpectedCloseDate *string  `json:"expected_close_date"`
	Remark            *string  `json:"remark"`
}

type LeadUpdateInput struct {
	Name              Optional[string]  `json:"name"`
	Company           Optional[string]  `json:"company"`
	Phone             Optional[string]  `json:"phone"`
	Email             Optional[string]  `json:"email"`
	Wechat            Optional[string]  `json:"wechat"`
	Source            Optional[string]  `json:"source"`
	Status            Optional[string]  `json:"status"`
	Intent            Optional[string]  `json:"intent"`
	CustomerType      Optional[string]  `json:"customer_type"`
	InterestedService Optional[string]  `json:"interested_service"`
	OwnerID           Optional[string]  `json:"owner_id"`
	ExpectedAmount    Optional[float64] `json:"expected_amount"`
	ExpectedCloseDate Optional[string]  `json:"expected_close_date"`
	Remark            Optional[string]  `json:"remark"`
}

type ConvertLeadInput struct {
	Name   *string `json:"name"`
	Rating *string `json:"rating"`
	Source *string `json:"source"`
	Remark *string `json:"remark"`
}

type ConvertLeadResponse struct {
	Lead     Lead     `json:"lead"`
	Customer Customer `json:"customer"`
}

type Follow struct {
	ID            int64   `json:"id"`
	EntityType    string  `json:"entity_type"`
	EntityID      int64   `json:"entity_id"`
	Type          string  `json:"type"`
	Content       string  `json:"content"`
	NextFollowAt  *string `json:"next_follow_at"`
	CreatedBy     *string `json:"created_by"`
	CreatedByName *string `json:"created_by_name"`
	CreatedAt     string  `json:"created_at"`
}

type FollowCreateInput struct {
	EntityType   string     `json:"entity_type"`
	EntityID     int64      `json:"entity_id"`
	Type         string     `json:"type"`
	Content      string     `json:"content"`
	NextFollowAt *time.Time `json:"next_follow_at"`
}

type FollowUpItem struct {
	EntityType        string  `json:"entity_type"`
	EntityID          int64   `json:"entity_id"`
	Name              string  `json:"name"`
	Subtitle          *string `json:"subtitle"`
	OwnerID           *string `json:"owner_id"`
	OwnerName         *string `json:"owner_name"`
	NextFollowAt      string  `json:"next_follow_at"`
	LastFollowContent *string `json:"last_follow_content"`
	LastFollowAt      *string `json:"last_follow_at"`
	Rating            *string `json:"rating"`
	Status            *string `json:"status"`
	Intent            *string `json:"intent"`
}

type FollowUpGroups struct {
	Overdue      []FollowUpItem `json:"overdue"`
	Today        []FollowUpItem `json:"today"`
	ThisWeek     []FollowUpItem `json:"this_week"`
	OverdueCount int            `json:"overdue_count"`
	TotalCount   int            `json:"total_count"`
}

type CRMUser struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Email    string  `json:"email"`
	RoleType *string `json:"role_type"`
	IsActive bool    `json:"is_active"`
}

type BatchTransferInput struct {
	IDs       []int64 `json:"ids"`
	ToOwnerID string  `json:"to_owner_id"`
}

type BatchIDsInput struct {
	IDs []int64 `json:"ids"`
}

type NewThisMonth struct {
	NewCustomers   int `json:"new_customers"`
	NewLeads       int `json:"new_leads"`
	ConvertedCount int `json:"converted_count"`
}

type FollowActivity struct {
	FollowCount7D int `json:"follow_count_7d"`
}

type OwnerPerformance struct {
	OwnerID            string  `json:"owner_id"`
	OwnerName          *string `json:"owner_name"`
	CustomerCount      int     `json:"customer_count"`
	ConvertedThisMonth int     `json:"converted_this_month"`
}

type DashboardStats struct {
	LeadFunnel     map[string]int     `json:"lead_funnel"`
	NewThisMonth   NewThisMonth       `json:"new_this_month"`
	FollowActivity FollowActivity     `json:"follow_activity"`
	PerOwner       []OwnerPerformance `json:"per_owner"`
}

type FunnelDimensionItem struct {
	Key    string         `json:"key"`
	Label  *string        `json:"label"`
	Funnel map[string]int `json:"funnel"`
}

type FunnelMetrics struct {
	Dimension string                `json:"dimension"`
	Total     map[string]int        `json:"total"`
	Items     []FunnelDimensionItem `json:"items"`
	StartAt   *string               `json:"start_at"`
	EndAt     *string               `json:"end_at"`
}

type StageLeadItem struct {
	ID                int64    `json:"id"`
	Name              string   `json:"name"`
	Company           *string  `json:"company"`
	OwnerID           *string  `json:"owner_id"`
	OwnerName         *string  `json:"owner_name"`
	Source            *string  `json:"source"`
	Intent            *string  `json:"intent"`
	EnteredStageAt    *string  `json:"entered_stage_at"`
	LastActionAt      *string  `json:"last_action_at"`
	LastActionContent *string  `json:"last_action_content"`
	NextFollowAt      *string  `json:"next_follow_at"`
	DwellDays         *float64 `json:"dwell_days"`
	IsStuck           bool     `json:"is_stuck"`
}

type StageDetail struct {
	Stage        string          `json:"stage"`
	Count        int             `json:"count"`
	AvgDwellDays *float64        `json:"avg_dwell_days"`
	StuckCount   int             `json:"stuck_count"`
	Inflow       int             `json:"inflow"`
	Outflow      *int            `json:"outflow"`
	StuckDays    int             `json:"stuck_days"`
	Leads        []StageLeadItem `json:"leads"`
	Page         int             `json:"page"`
	PageSize     int             `json:"page_size"`
	Total        int             `json:"total"`
}

type PerformanceMetrics struct {
	NewCustomers   int      `json:"new_customers"`
	ConvertedCount int      `json:"converted_count"`
	FollowCount    int      `json:"follow_count"`
	CompletionRate *float64 `json:"completion_rate"`
}

type PerformanceRankItem struct {
	Rank           int      `json:"rank"`
	OwnerID        string   `json:"owner_id"`
	OwnerName      *string  `json:"owner_name"`
	NewCustomers   int      `json:"new_customers"`
	ConvertedCount int      `json:"converted_count"`
	FollowCount    int      `json:"follow_count"`
	CompletionRate *float64 `json:"completion_rate"`
}

type PerformanceBoard struct {
	Scope         string                `json:"scope"`
	Month         string                `json:"month"`
	Mine          PerformanceMetrics    `json:"mine"`
	MyRank        *int                  `json:"my_rank"`
	TotalUsers    int                   `json:"total_users"`
	GlobalMetrics *PerformanceMetrics   `json:"global_metrics"`
	Ranking       []PerformanceRankItem `json:"ranking"`
}

type LifecycleBucket struct {
	Label         string   `json:"label"`
	MinDays       float64  `json:"min_days"`
	MaxDays       *float64 `json:"max_days"`
	Count         int      `json:"count"`
	Pct           float64  `json:"pct"`
	CumulativePct float64  `json:"cumulative_pct"`
}

type LifecycleSummary struct {
	SampleCount int      `json:"sample_count"`
	TotalCount  int      `json:"total_count"`
	AvgDays     *float64 `json:"avg_days"`
	MedianDays  *float64 `json:"median_days"`
	P90Days     *float64 `json:"p90_days"`
	MaxDays     *float64 `json:"max_days"`
}

type LifecycleDistribution struct {
	Metric      string            `json:"metric"`
	Label       string            `json:"label"`
	Description string            `json:"description"`
	Buckets     []LifecycleBucket `json:"buckets"`
	Summary     LifecycleSummary  `json:"summary"`
}

type LifecycleBoard struct {
	FirstFollow LifecycleDistribution `json:"first_follow"`
	Conversion  LifecycleDistribution `json:"conversion"`
	Churn       LifecycleDistribution `json:"churn"`
	NowInSea    int                   `json:"now_in_sea"`
}

type AuditLog struct {
	ID         int64   `json:"id"`
	EntityType string  `json:"entity_type"`
	EntityID   int64   `json:"entity_id"`
	Action     string  `json:"action"`
	ActorID    *string `json:"actor_id"`
	ActorName  *string `json:"actor_name"`
	Summary    *string `json:"summary"`
	CreatedAt  string  `json:"created_at"`
}

type AuditLogFilter struct {
	EntityType  *string
	EntityID    *int64
	EntityTypes []string
	EntityIDs   []int64
	ActorID     *string
	Action      *string
	Page        int
	PageSize    int
}

type Task struct {
	ID           int64   `json:"id"`
	Title        string  `json:"title"`
	Description  *string `json:"description"`
	DueDate      *string `json:"due_date"`
	Priority     string  `json:"priority"`
	Status       string  `json:"status"`
	Type         string  `json:"type"`
	OwnerID      *string `json:"owner_id"`
	OwnerName    *string `json:"owner_name"`
	CustomerID   *int64  `json:"customer_id"`
	CustomerName *string `json:"customer_name"`
	LeadID       *int64  `json:"lead_id"`
	LeadName     *string `json:"lead_name"`
	RemindedAt   *string `json:"reminded_at"`
	CreatedBy    *string `json:"created_by"`
	CompletedAt  *string `json:"completed_at"`
	CreatedAt    string  `json:"created_at"`
	UpdatedAt    string  `json:"updated_at"`
}

type TaskCreateInput struct {
	Title       string     `json:"title"`
	Description *string    `json:"description"`
	DueDate     *time.Time `json:"due_date"`
	Priority    string     `json:"priority"`
	Type        string     `json:"type"`
	OwnerID     *string    `json:"owner_id"`
	CustomerID  *int64     `json:"customer_id"`
	LeadID      *int64     `json:"lead_id"`
}

type TaskUpdateInput struct {
	Title       Optional[string]    `json:"title"`
	Description Optional[string]    `json:"description"`
	DueDate     Optional[time.Time] `json:"due_date"`
	Priority    Optional[string]    `json:"priority"`
	Type        Optional[string]    `json:"type"`
	OwnerID     Optional[string]    `json:"owner_id"`
	CustomerID  Optional[int64]     `json:"customer_id"`
	LeadID      Optional[int64]     `json:"lead_id"`
}

type TaskStatusInput struct {
	Status string `json:"status"`
}

type TaskCompleteInput struct {
	NextFollowAt *time.Time `json:"next_follow_at"`
	Note         *string    `json:"note"`
}

type TaskListFilter struct {
	Scope      string
	Type       *string
	Status     *string
	Priority   *string
	OwnerID    *string
	CustomerID *int64
	LeadID     *int64
	SortBy     string
	SortOrder  string
	Page       int
	PageSize   int
}

type TaskReminder struct {
	TaskID  int64   `json:"task_id"`
	Title   string  `json:"title"`
	DueDate *string `json:"due_date"`
}

type FollowUpReminder struct {
	EntityType string `json:"entity_type"`
	EntityID   int64  `json:"entity_id"`
	Name       string `json:"name"`
	Days       int    `json:"days"`
}

type RuleConditionInput struct {
	Field     string  `json:"field"`
	Operator  string  `json:"operator"`
	Value     *string `json:"value"`
	SortOrder int     `json:"sort_order"`
}

type RuleActionInput struct {
	ActionType string         `json:"action_type"`
	Params     map[string]any `json:"params"`
	SortOrder  int            `json:"sort_order"`
}

type RuleCondition struct {
	ID        int64   `json:"id"`
	Field     string  `json:"field"`
	Operator  string  `json:"operator"`
	Value     *string `json:"value"`
	SortOrder int     `json:"sort_order"`
}

type RuleAction struct {
	ID         int64          `json:"id"`
	ActionType string         `json:"action_type"`
	Params     map[string]any `json:"params"`
	SortOrder  int            `json:"sort_order"`
}

type Rule struct {
	ID          int64           `json:"id"`
	Name        string          `json:"name"`
	Description *string         `json:"description"`
	EntityType  string          `json:"entity_type"`
	EventType   string          `json:"event_type"`
	Enabled     bool            `json:"enabled"`
	Priority    int             `json:"priority"`
	CreatedBy   *string         `json:"created_by"`
	CreatedAt   string          `json:"created_at"`
	UpdatedAt   string          `json:"updated_at"`
	Conditions  []RuleCondition `json:"conditions"`
	Actions     []RuleAction    `json:"actions"`
}

type RuleCreateInput struct {
	Name        string               `json:"name"`
	Description *string              `json:"description"`
	EntityType  string               `json:"entity_type"`
	EventType   string               `json:"event_type"`
	Enabled     bool                 `json:"enabled"`
	Priority    int                  `json:"priority"`
	Conditions  []RuleConditionInput `json:"conditions"`
	Actions     []RuleActionInput    `json:"actions"`
}

type RuleUpdateInput struct {
	Name        Optional[string]               `json:"name"`
	Description Optional[string]               `json:"description"`
	EntityType  Optional[string]               `json:"entity_type"`
	EventType   Optional[string]               `json:"event_type"`
	Enabled     Optional[bool]                 `json:"enabled"`
	Priority    Optional[int]                  `json:"priority"`
	Conditions  Optional[[]RuleConditionInput] `json:"conditions"`
	Actions     Optional[[]RuleActionInput]    `json:"actions"`
}

type WorkflowSettings struct {
	StaleDays         int  `json:"stale_days"`
	StaleEmailEnabled bool `json:"stale_email_enabled"`
}

type WorkflowSettingsUpdate struct {
	StaleDays         Optional[int]  `json:"stale_days"`
	StaleEmailEnabled Optional[bool] `json:"stale_email_enabled"`
}

type CategoryCreateInput struct {
	Name      string `json:"name"`
	SortOrder int    `json:"sort_order"`
}

type CategoryUpdateInput struct {
	Name      Optional[string] `json:"name"`
	SortOrder Optional[int]    `json:"sort_order"`
}

type CustomerCategoriesInput struct {
	CategoryIDs []int64 `json:"category_ids"`
}

type SavedView struct {
	ID         int64             `json:"id"`
	Name       string            `json:"name"`
	EntityType string            `json:"entity_type"`
	Scope      string            `json:"scope"`
	Keyword    *string           `json:"keyword"`
	Filters    []FilterCondition `json:"filters"`
	SortBy     string            `json:"sort_by"`
	SortOrder  string            `json:"sort_order"`
	IsShared   bool              `json:"is_shared"`
	OwnerID    *string           `json:"owner_id"`
	OwnerName  *string           `json:"owner_name"`
	CreatedAt  string            `json:"created_at"`
	UpdatedAt  string            `json:"updated_at"`
}

type SavedViewCreateInput struct {
	Name       string            `json:"name"`
	EntityType string            `json:"entity_type"`
	Scope      string            `json:"scope"`
	Keyword    *string           `json:"keyword"`
	Filters    []FilterCondition `json:"filters"`
	SortBy     string            `json:"sort_by"`
	SortOrder  string            `json:"sort_order"`
	IsShared   bool              `json:"is_shared"`
}

type SavedViewUpdateInput struct {
	Name      Optional[string]            `json:"name"`
	Scope     Optional[string]            `json:"scope"`
	Keyword   Optional[string]            `json:"keyword"`
	Filters   Optional[[]FilterCondition] `json:"filters"`
	SortBy    Optional[string]            `json:"sort_by"`
	SortOrder Optional[string]            `json:"sort_order"`
	IsShared  Optional[bool]              `json:"is_shared"`
}

type FilterCondition struct {
	Field string            `json:"field"`
	Op    string            `json:"op"`
	Value any               `json:"value"`
	And   []FilterCondition `json:"and"`
	Or    []FilterCondition `json:"or"`
}

type ProposalVersion struct {
	ID               int64   `json:"id"`
	VersionNo        int     `json:"version_no"`
	OriginalFilename string  `json:"original_filename"`
	ContentType      string  `json:"content_type"`
	FileSize         int64   `json:"file_size"`
	ChangeNote       *string `json:"change_note"`
	CreatedBy        *string `json:"created_by"`
	CreatedByName    *string `json:"created_by_name"`
	CreatedAt        string  `json:"created_at"`
}

type Proposal struct {
	ID               int64   `json:"id"`
	Title            string  `json:"title"`
	ProposalType     string  `json:"proposal_type"`
	Status           string  `json:"status"`
	CustomerID       *int64  `json:"customer_id"`
	CustomerName     *string `json:"customer_name"`
	OwnerID          *string `json:"owner_id"`
	OwnerName        *string `json:"owner_name"`
	CurrentVersionNo int     `json:"current_version_no"`
	VersionCount     int     `json:"version_count"`
	CreatedBy        *string `json:"created_by"`
	CreatedAt        string  `json:"created_at"`
	UpdatedAt        string  `json:"updated_at"`
}

type ProposalDetail struct {
	Proposal
	Versions []ProposalVersion `json:"versions"`
}

type ProposalListFilter struct {
	Scope     string
	Keyword   *string
	Filters   map[string]any
	SortBy    string
	SortOrder string
	Page      int
	PageSize  int
}

type ProposalUpdateInput struct {
	Title        Optional[string] `json:"title"`
	ProposalType Optional[string] `json:"proposal_type"`
	Status       Optional[string] `json:"status"`
	CustomerID   Optional[int64]  `json:"customer_id"`
}

type ProposalContentResponse struct {
	ProposalID int64  `json:"proposal_id"`
	VersionNo  int    `json:"version_no"`
	Title      string `json:"title"`
	Content    string `json:"content"`
}

type ProposalUploadResponse struct {
	Proposal Proposal        `json:"proposal"`
	Version  ProposalVersion `json:"version"`
	Warnings []string        `json:"warnings"`
}

type ProposalCreateInput struct {
	Title        *string
	ProposalType string
	CustomerID   *int64
	Filename     string
	ContentType  string
	RawBytes     []byte
	AdaptedBytes []byte
	Warnings     []string
}

type ProposalAddVersionInput struct {
	Filename     string
	ContentType  string
	RawBytes     []byte
	AdaptedBytes []byte
	Warnings     []string
	ChangeNote   *string
}

type ProposalVersionRecord struct {
	ProposalID       int64
	VersionNo        int
	RawKey           string
	AdaptedKey       string
	OriginalFilename string
	ContentType      string
}

type ChunkUploadInitInput struct {
	OwnerID      *string
	Filename     string
	Size         int64
	ContentType  string
	Title        *string
	ProposalType *string
	CustomerID   *int64
	ChangeNote   *string
	ProposalID   *int64
}

type ChunkUploadMeta struct {
	UploadID        string
	OwnerID         *string
	Filename        string
	Size            int64
	ContentType     string
	Title           *string
	ProposalType    *string
	CustomerID      *int64
	ProposalID      *int64
	ChangeNote      *string
	Status          string
	ChunkSize       int64
	TotalChunks     int
	ExpiresAt       string
	FinalProposalID *int64
	FinalVersionNo  *int
}

type ChunkUploadInitResponse struct {
	UploadID    string `json:"upload_id"`
	ChunkSize   int64  `json:"chunk_size"`
	TotalChunks int    `json:"total_chunks"`
	ExpiresAt   string `json:"expires_at"`
}

type ChunkUploadResponse struct {
	Received int   `json:"received"`
	Size     int64 `json:"size"`
}

type ProposalStorage interface {
	PutObject(ctx context.Context, key string, data []byte, contentType string) error
	GetObject(ctx context.Context, key string) ([]byte, error)
	DeleteObject(ctx context.Context, key string) error
	InitChunkUpload(ctx context.Context, input ChunkUploadInitInput) (ChunkUploadMeta, error)
	WriteChunk(ctx context.Context, uploadID string, index int, data []byte, ownerID *string, isAdmin bool) (int64, error)
	ReadChunkUpload(ctx context.Context, uploadID string, ownerID *string, isAdmin bool) (ChunkUploadMeta, error)
	AssembleChunkUpload(ctx context.Context, uploadID string, ownerID *string, isAdmin bool) ([]byte, ChunkUploadMeta, error)
	MarkChunkUploadFinalized(ctx context.Context, uploadID string, proposalID int64, versionNo int) error
}

type Paginated[T any] struct {
	Items    []T `json:"items"`
	Total    int `json:"total"`
	Page     int `json:"page"`
	PageSize int `json:"page_size"`
}

type Store interface {
	ListCustomers(context.Context, CustomerListFilter, string, bool) (Paginated[Customer], error)
	CreateCustomer(context.Context, CustomerCreateInput, string) (*Customer, error)
	ImportCustomersToSea(context.Context, []CustomerSeaImportRow, string) (CustomerSeaImportResult, error)
	GetCustomer(context.Context, int64) (*Customer, error)
	UpdateCustomer(context.Context, int64, CustomerUpdateInput, string) (*Customer, error)
	UpdateCustomerValueScores(context.Context, int64, ValueScoresUpdateInput, string) (*Customer, error)
	DeleteCustomer(context.Context, int64, string) error
	BatchTransferCustomers(context.Context, []int64, string, string) error
	BatchMoveCustomersToSea(context.Context, []int64, string, bool, string) error
	ClaimCustomer(context.Context, int64, string) (*Customer, error)
	ListContacts(context.Context, int64) ([]Contact, error)
	CreateContact(context.Context, int64, ContactCreateInput, string) (*Contact, error)
	UpdateContact(context.Context, int64, ContactUpdateInput, string) (*Contact, error)
	DeleteContact(context.Context, int64, string) error
	ListCRMUsers(context.Context) ([]CRMUser, error)
	GetCRMUser(context.Context, string) (*CRMUser, error)
	ListLeads(context.Context, LeadListFilter, string) (Paginated[Lead], error)
	CreateLead(context.Context, LeadCreateInput, string) (*Lead, error)
	GetLead(context.Context, int64) (*Lead, error)
	UpdateLead(context.Context, int64, LeadUpdateInput, string) (*Lead, error)
	BatchTransferLeads(context.Context, []int64, string, string) error
	BatchMoveLeadsToPool(context.Context, []int64, string, bool, string) error
	ClaimLead(context.Context, int64, string) (*Lead, error)
	ConvertLead(context.Context, int64, *ConvertLeadInput, string) (*ConvertLeadResponse, error)
	ListFollows(context.Context, string, int64) ([]Follow, error)
	CreateFollow(context.Context, FollowCreateInput, string) (*Follow, error)
	ListFollowUps(context.Context, string, string, bool) (FollowUpGroups, error)
	ListAuditLogs(context.Context, AuditLogFilter) (Paginated[AuditLog], error)
	GetDashboardStats(context.Context) (DashboardStats, error)
	GetFunnelMetrics(context.Context, string, *time.Time, *time.Time, *string, *string) (FunnelMetrics, error)
	GetStageDetail(context.Context, string, string, int, *time.Time, *time.Time, *string, *string, int, int) (StageDetail, error)
	GetPerformanceBoard(context.Context, string, string, *string, string) (PerformanceBoard, error)
	GetLifecycleBoard(context.Context) (LifecycleBoard, error)
	ListTasks(context.Context, TaskListFilter, string, bool) (Paginated[Task], error)
	CreateTask(context.Context, TaskCreateInput, string, bool) (*Task, error)
	GetTask(context.Context, int64) (*Task, error)
	UpdateTask(context.Context, int64, TaskUpdateInput, string, bool) (*Task, error)
	SetTaskStatus(context.Context, int64, string, string) (*Task, error)
	CompleteTask(context.Context, int64, *TaskCompleteInput, string) (*Task, error)
	CancelTask(context.Context, int64, string) (*Task, error)
	ListTaskReminders(context.Context, *string) ([]TaskReminder, error)
	ListFollowUpReminders(context.Context, string, int) ([]FollowUpReminder, error)
	ListRules(context.Context) ([]Rule, error)
	CreateRule(context.Context, RuleCreateInput, string) (*Rule, error)
	UpdateRule(context.Context, int64, RuleUpdateInput, string) (*Rule, error)
	DeleteRule(context.Context, int64, string) error
	GetWorkflowSettings(context.Context) (WorkflowSettings, error)
	UpdateWorkflowSettings(context.Context, WorkflowSettingsUpdate, string) (WorkflowSettings, error)
	ListCategories(context.Context) ([]Category, error)
	CreateCategory(context.Context, CategoryCreateInput, string) (*Category, error)
	UpdateCategory(context.Context, int64, CategoryUpdateInput, string) (*Category, error)
	DeleteCategory(context.Context, int64, string) error
	SetCustomerCategories(context.Context, int64, []int64, string) (*Customer, error)
	ListSavedViews(context.Context, *string, string, bool) ([]SavedView, error)
	CreateSavedView(context.Context, SavedViewCreateInput, string, bool) (*SavedView, error)
	UpdateSavedView(context.Context, int64, SavedViewUpdateInput, string, bool) (*SavedView, error)
	DeleteSavedView(context.Context, int64, string, bool) error
	ListProposals(context.Context, ProposalListFilter, *string, bool) (Paginated[Proposal], error)
	GetProposal(context.Context, int64) (*ProposalDetail, error)
	CreateProposal(context.Context, ProposalCreateInput, string, bool, ProposalStorage) (ProposalUploadResponse, error)
	AddProposalVersion(context.Context, int64, ProposalAddVersionInput, string, ProposalStorage) (ProposalUploadResponse, error)
	UpdateProposal(context.Context, int64, ProposalUpdateInput, string, bool) (*Proposal, error)
	DeleteProposal(context.Context, int64, string, ProposalStorage) error
	GetProposalVersionRecord(context.Context, int64, int) (*ProposalVersionRecord, error)
}

type APIError struct {
	Status int
	Detail string
}

func (err *APIError) Error() string {
	return err.Detail
}

func NewAPIError(status int, detail string) error {
	return &APIError{Status: status, Detail: detail}
}

func WriteError(w http.ResponseWriter, err error) {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		httpapi.WriteDetail(w, apiErr.Status, apiErr.Detail)
		return
	}
	httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
}

func RequireAdmin(identity Identity) error {
	if !identity.IsAdmin {
		return NewAPIError(http.StatusForbidden, "Admin required")
	}
	return nil
}

func RequireOwnerOrAdmin(ownerID *string, identity Identity) error {
	if identity.IsAdmin {
		return nil
	}
	if ownerID == nil || *ownerID != identity.UserID {
		return NewAPIError(http.StatusForbidden, "Not the record owner")
	}
	return nil
}

func ResolveScope(scope string, isAdmin bool) string {
	switch scope {
	case "":
		scope = "all"
	}
	if scope == "all" && !isAdmin {
		return "mine"
	}
	return scope
}

func ResolveProposalScope(scope string) (string, error) {
	if scope == "" {
		scope = "all"
	}
	if scope != "mine" && scope != "all" {
		return "", NewAPIError(http.StatusBadRequest, "不支持的 scope: "+scope)
	}
	return scope, nil
}

type Identity struct {
	UserID    string
	Operator  string
	IsAdmin   bool
	Email     string
	Name      string
	RoleType  string
	SessionID string
}

func optionalString(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	cleaned := strings.TrimSpace(value)
	return &cleaned
}

func ensureSlice[T any](items []T) []T {
	if items == nil {
		return []T{}
	}
	return items
}
