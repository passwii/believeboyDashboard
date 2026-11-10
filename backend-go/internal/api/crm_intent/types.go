// Package crm_intent implements the CRM 意向客户工作台 (intent workbench)
// domain: user routes under /api/v1/crm/intent/* and agent routes under
// /api/v1/agent/crm-intent/*.
package crm_intent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const (
	// ModuleName is the GO_API_OWNED switch for this domain.
	ModuleName = "crm_intent"
	// BusinessScope is the agent business_scope code required for agent routes.
	BusinessScope = "crm_intent"

	userPrefix  = "/api/v1/crm/intent"
	agentPrefix = "/api/v1/agent/crm-intent"

	maxCompaniesPerBatch = 2000
	maxPoolPerBatch      = 5000
	maxExportRows        = 50000
	maxPhonePageSize     = 100
	maxBatchPageSize     = 100
)

// Followup states（8 态，与迁移 CHECK 一致）.
const (
	StateNone        = "none"
	StateContacted   = "contacted"
	StateWechat      = "wechat"
	StateQuoted      = "quoted"
	StateNegotiating = "negotiating"
	StateWon         = "won"
	StateHold        = "hold"
	StateMismatch    = "mismatch"
)

// Intent levels.
const (
	LevelA = "A"
	LevelB = "B"
	LevelC = "C"
	LevelD = "D"
)

// Batch sources.
const (
	BatchSourceAI     = "ai"
	BatchSourceManual = "manual"
)

// Phone sources.
const (
	PhoneSourceList   = "list"
	PhoneSourceManual = "manual"
	PhoneSourceAI     = "ai"
)

// Pool statuses.
const (
	PoolPending  = "pending"
	PoolScreened = "screened"
	PoolIgnored  = "ignored"
)

// Batch statuses.
const (
	BatchProcessing = "processing"
	BatchCompleted  = "completed"
	BatchFailed     = "failed"
)

// Import actor kinds.
const (
	ActorKindAgent = "agent"
	ActorKindUser  = "user"
)

// Import modes.
const (
	ModeUpsert     = "upsert"
	ModeInsertOnly = "insert_only"
)

var followupStateOrder = []string{
	StateNone, StateContacted, StateWechat, StateQuoted,
	StateNegotiating, StateWon, StateHold, StateMismatch,
}

var intentLevelOrder = []string{LevelA, LevelB, LevelC, LevelD}

var followupStateLabels = map[string]string{
	StateNone:        "未联系",
	StateContacted:   "已联系",
	StateWechat:      "已加微信",
	StateQuoted:      "已报价",
	StateNegotiating: "谈判中",
	StateWon:         "已成交",
	StateHold:        "暂搁置",
	StateMismatch:    "不匹配",
}

var intentLevelLabels = map[string]string{
	LevelA: "强意向",
	LevelB: "可培育",
	LevelC: "信息不足",
	LevelD: "暂不匹配",
}

// FollowupStates 返回 8 态（稳定顺序）。
func FollowupStates() []string {
	result := make([]string, len(followupStateOrder))
	copy(result, followupStateOrder)
	return result
}

// IntentLevels 返回 A/B/C/D（稳定顺序）。
func IntentLevels() []string {
	result := make([]string, len(intentLevelOrder))
	copy(result, intentLevelOrder)
	return result
}

func FollowupStateLabel(state string) string {
	if label, ok := followupStateLabels[state]; ok {
		return label
	}
	return state
}

func IntentLevelLabel(level string) string {
	if label, ok := intentLevelLabels[level]; ok {
		return label
	}
	return level
}

func ValidFollowupState(state string) bool {
	_, ok := followupStateLabels[state]
	return ok
}

func ValidIntentLevel(level string) bool {
	_, ok := intentLevelLabels[level]
	return ok
}

func ValidPoolStatus(status string) bool {
	return status == PoolPending || status == PoolScreened || status == PoolIgnored
}

// StateFacet is one followup state option with its Chinese label.
type StateFacet struct {
	Code  string `json:"code"`
	Label string `json:"label"`
}

func stateFacets() []StateFacet {
	result := make([]StateFacet, 0, len(followupStateOrder))
	for _, state := range followupStateOrder {
		result = append(result, StateFacet{Code: state, Label: FollowupStateLabel(state)})
	}
	return result
}

// Optional mirrors PATCH semantics: Set=false means "field absent", Set=true
// with Value=nil means explicit null.
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

// OptionalTime is a presence-aware timestamp (nil value = clear).
type OptionalTime struct {
	Set   bool
	Value *time.Time
}

// Actor identifies who performed a write.
type Actor struct {
	Kind    string
	ID      string
	IsAdmin bool
}

func (actor Actor) IsAgent() bool { return actor.Kind == ActorKindAgent }

func (actor Actor) IsAdminActor() bool {
	return actor.Kind == ActorKindUser && actor.IsAdmin
}

// Scope is the resolved CRM visibility scope.
type Scope struct {
	Name    string
	UserID  string
	IsAdmin bool
}

const (
	ScopeMine = "mine"
	ScopeAll  = "all"
	ScopeSea  = "sea"
)

// ResolveScope mirrors the existing CRM scope semantics: only admins get all.
func ResolveScope(scope string, isAdmin bool) string {
	switch strings.TrimSpace(scope) {
	case "":
		scope = ScopeAll
	case ScopeMine, ScopeAll, ScopeSea:
	default:
		return ""
	}
	if scope == ScopeAll && !isAdmin {
		return ScopeMine
	}
	return scope
}

// ---------- DTOs ----------

type OwnerBrief struct {
	ID   string  `json:"id"`
	Name *string `json:"name"`
}

type Phone struct {
	ID              int64   `json:"id"`
	CompanyID       *int64  `json:"company_id"`
	PoolID          *int64  `json:"pool_id"`
	PhoneRaw        string  `json:"phone_raw"`
	PhoneNormalized string  `json:"phone_normalized"`
	Source          string  `json:"source"`
	IsValid         bool    `json:"is_valid"`
	CreatedBy       *string `json:"created_by"`
	CreatedAt       string  `json:"created_at"`
}

type Followup struct {
	CompanyID     int64    `json:"company_id"`
	State         string   `json:"state"`
	StateLabel    string   `json:"state_label"`
	Note          string   `json:"note"`
	LastContactAt *string  `json:"last_contact_at"`
	NextContactAt *string  `json:"next_contact_at"`
	ValidPhones   []string `json:"valid_phones"`
	Version       int      `json:"version"`
	UpdatedBy     *string  `json:"updated_by"`
	UpdatedAt     string   `json:"updated_at"`
}

type SharedPhoneCompany struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	IntentLevel string `json:"intent_level"`
}

type SharedPhonePool struct {
	ID     int64  `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

type SharedPhoneGroup struct {
	PhoneNormalized string               `json:"phone_normalized"`
	Raw             string               `json:"raw"`
	Companies       []SharedPhoneCompany `json:"companies"`
	Pool            []SharedPhonePool    `json:"pool"`
}

type Company struct {
	ID                   int64              `json:"id"`
	BatchID              *int64             `json:"batch_id"`
	ExternalID           *string            `json:"external_id"`
	Name                 string             `json:"name"`
	CreditCode           *string            `json:"credit_code"`
	LegalPerson          *string            `json:"legal_person"`
	Province             *string            `json:"province"`
	City                 *string            `json:"city"`
	FoundedYear          *int               `json:"founded_year"`
	RegisteredCapitalWan *float64           `json:"registered_capital_wan"`
	Products             *string            `json:"products"`
	Category             *string            `json:"category"`
	Channel              *string            `json:"channel"`
	Channels             []string           `json:"channels"`
	ChannelSource        *string            `json:"channel_source"`
	Trademarks           []string           `json:"trademarks"`
	TrademarkCount       int                `json:"trademark_count"`
	IntentLevel          string             `json:"intent_level"`
	IntentLevelLabel     string             `json:"intent_level_label"`
	IntentScore          *int               `json:"intent_score"`
	IntentBasis          *string            `json:"intent_basis"`
	AmazonFit            *string            `json:"amazon_fit"`
	WalmartFit           *string            `json:"walmart_fit"`
	Sources              []string           `json:"sources"`
	Risks                *string            `json:"risks"`
	ScreenedAt           *string            `json:"screened_at"`
	PhoneNote            *string            `json:"phone_note"`
	Owner                *OwnerBrief        `json:"owner"`
	HumanTouched         bool               `json:"human_touched"`
	HumanTouchedAt       *string            `json:"human_touched_at"`
	ConvertedCustomerID  *int64             `json:"converted_customer_id"`
	ConvertedAt          *string            `json:"converted_at"`
	Phones               []Phone            `json:"phones"`
	Followup             Followup           `json:"followup"`
	CreatedAt            string             `json:"created_at"`
	UpdatedAt            string             `json:"updated_at"`
	SharedPhones         []SharedPhoneGroup `json:"shared_phones,omitempty"`
}

type PoolItem struct {
	ID                int64    `json:"id"`
	BatchID           *int64   `json:"batch_id"`
	ExternalID        *string  `json:"external_id"`
	Name              string   `json:"name"`
	LegalPerson       *string  `json:"legal_person"`
	Phones            []Phone  `json:"phones"`
	Website           *string  `json:"website"`
	Channel           *string  `json:"channel"`
	Channels          []string `json:"channels"`
	ChannelSource     *string  `json:"channel_source"`
	Status            string   `json:"status"`
	ScreenedCompanyID *int64   `json:"screened_company_id"`
	CreatedAt         string   `json:"created_at"`
	UpdatedAt         string   `json:"updated_at"`
}

type Batch struct {
	ID                 int64   `json:"id"`
	BatchDate          string  `json:"batch_date"`
	Source             string  `json:"source"`
	SourceLabel        string  `json:"source_label"`
	SourceFileName     *string `json:"source_file_name"`
	R2Key              *string `json:"r2_key"`
	ContentSHA256      *string `json:"content_sha256"`
	TotalCompanies     int     `json:"total_companies"`
	TotalPool          int     `json:"total_pool"`
	CreatedCount       int     `json:"created_count"`
	UpdatedCount       int     `json:"updated_count"`
	SkippedLockedCount int     `json:"skipped_locked_count"`
	RejectedCount      int     `json:"rejected_count"`
	Status             string  `json:"status"`
	ErrorDetail        *string `json:"error_detail"`
	CreatedBy          *string `json:"created_by"`
	CreatedAt          string  `json:"created_at"`
	CompletedAt        *string `json:"completed_at"`
}

type BatchBrief struct {
	ID        int64   `json:"id"`
	BatchDate *string `json:"batch_date"`
	UpdatedAt *string `json:"updated_at"`
	Total     int     `json:"total"`
	PoolTotal int     `json:"pool_total"`
}

type RejectedRow struct {
	Scope      string  `json:"scope"`
	Index      int     `json:"index"`
	ExternalID *string `json:"external_id"`
	Reason     string  `json:"reason"`
}

// BatchRow is one row-level ingest outcome persisted in batches.result_json.
type BatchRow struct {
	Scope      string  `json:"scope"`
	Index      int     `json:"index"`
	ExternalID *string `json:"external_id"`
	Status     string  `json:"status"`
	Reason     string  `json:"reason,omitempty"`
	CompanyID  *int64  `json:"company_id,omitempty"`
	PoolID     *int64  `json:"pool_id,omitempty"`
}

type BatchDetail struct {
	Batch
	Rejected      []RejectedRow `json:"rejected"`
	Rows          []BatchRow    `json:"rows"`
	RowsTruncated bool          `json:"rows_truncated"`
}

type Stats struct {
	Total      int            `json:"total"`
	ByLevel    map[string]int `json:"by_level"`
	WithPhone  int            `json:"with_phone"`
	Contacted  int            `json:"contacted"`
	FollowedUp int            `json:"followed_up"`
	PoolTotal  int            `json:"pool_total"`
	DupGroups  int            `json:"dup_groups"`
	DueCount   int            `json:"due_count"`
}

type FacetCities struct {
	Province string   `json:"province"`
	Cities   []string `json:"cities"`
}

type Facets struct {
	Levels     []string      `json:"levels"`
	Categories []string      `json:"categories"`
	Channels   []string      `json:"channels"`
	Provinces  []string      `json:"provinces"`
	Cities     []FacetCities `json:"cities"`
	States     []StateFacet  `json:"states"`
}

type MetaResponse struct {
	Batch       *BatchBrief `json:"batch"`
	Stats       Stats       `json:"stats"`
	Facets      Facets      `json:"facets"`
	DataRev     int64       `json:"data_rev"`
	FollowupRev int64       `json:"followup_rev"`
	Changed     bool        `json:"changed"`
	ServerTime  string      `json:"server_time"`
}

type MetaData struct {
	Batch  *BatchBrief
	Stats  Stats
	Facets Facets
}

type BoardItem struct {
	ID               int64       `json:"id"`
	Name             string      `json:"name"`
	IntentLevel      string      `json:"intent_level"`
	IntentLevelLabel string      `json:"intent_level_label"`
	IntentScore      *int        `json:"intent_score"`
	NextContactAt    *string     `json:"next_contact_at"`
	Owner            *OwnerBrief `json:"owner"`
	UpdatedAt        string      `json:"updated_at"`
}

type BoardColumn struct {
	State      string      `json:"state"`
	StateLabel string      `json:"state_label"`
	Count      int         `json:"count"`
	Items      []BoardItem `json:"items"`
}

// Agent read view: deliberately excludes note / followup timestamps.
type AgentCompanyItem struct {
	ID                  int64    `json:"id"`
	Name                string   `json:"name"`
	CreditCode          *string  `json:"credit_code"`
	Phones              []string `json:"phones"`
	IntentLevel         string   `json:"intent_level"`
	IntentScore         *int     `json:"intent_score"`
	HumanTouched        bool     `json:"human_touched"`
	OwnerID             *string  `json:"owner_id"`
	State               string   `json:"state"`
	ConvertedCustomerID *int64   `json:"converted_customer_id"`
	UpdatedAt           string   `json:"updated_at"`
}

// ---------- inputs ----------

// CompanyInput is the single shared company payload for AI batches, single
// creates, pool screening and file imports (spec §3.1).
type CompanyInput struct {
	ExternalID           *string  `json:"external_id"`
	Name                 *string  `json:"name"`
	CreditCode           *string  `json:"credit_code"`
	LegalPerson          *string  `json:"legal_person"`
	Phones               []string `json:"phones"`
	Province             *string  `json:"province"`
	City                 *string  `json:"city"`
	FoundedYear          *int     `json:"founded_year"`
	RegisteredCapitalWan *float64 `json:"registered_capital_wan"`
	Products             *string  `json:"products"`
	Category             *string  `json:"category"`
	Channel              *string  `json:"channel"`
	Channels             []string `json:"channels"`
	ChannelSource        *string  `json:"channel_source"`
	Trademarks           []string `json:"trademarks"`
	TrademarkCount       *int     `json:"trademark_count"`
	IntentLevel          *string  `json:"intent_level"`
	IntentScore          *int     `json:"intent_score"`
	IntentBasis          *string  `json:"intent_basis"`
	AmazonFit            *string  `json:"amazon_fit"`
	WalmartFit           *string  `json:"walmart_fit"`
	Sources              []string `json:"sources"`
	Risks                *string  `json:"risks"`
	ScreenedAt           *string  `json:"screened_at"`
	PhoneNote            *string  `json:"phone_note"`
}

type PoolInput struct {
	ExternalID    *string  `json:"external_id"`
	Name          *string  `json:"name"`
	LegalPerson   *string  `json:"legal_person"`
	Phones        []string `json:"phones"`
	Website       *string  `json:"website"`
	Channel       *string  `json:"channel"`
	Channels      []string `json:"channels"`
	ChannelSource *string  `json:"channel_source"`
}

type BatchCreate struct {
	BatchDate      time.Time
	Source         string
	SourceFileName *string
	CreatedBy      *string
}

type IngestRequest struct {
	BatchID   int64
	Mode      string
	Companies []CompanyInput
	Pool      []PoolInput
	Rejected  []RejectedRow
	Actor     Actor
}

type IngestResult struct {
	BatchID         int64         `json:"batch_id"`
	Status          string        `json:"status"`
	Created         int           `json:"created"`
	Updated         int           `json:"updated"`
	SkippedLocked   int           `json:"skipped_locked"`
	SkippedExisting int           `json:"skipped_existing"`
	Rejected        []RejectedRow `json:"rejected"`
	RejectedCount   int           `json:"rejected_count"`
	Rows            []BatchRow    `json:"rows,omitempty"`
	RowsTruncated   bool          `json:"rows_truncated,omitempty"`
	CompaniesTotal  int           `json:"companies_total"`
	PoolTotal       int           `json:"pool_total"`
	DataRev         int64         `json:"data_rev"`
	RequestID       string        `json:"request_id,omitempty"`
}

// AgentUpsertResult is returned by POST /agent/crm-intent/companies.
type AgentUpsertResult struct {
	CompanyID int64 `json:"company_id"`
	Created   bool  `json:"created"`
	DataRev   int64 `json:"data_rev"`
}

type AgentScreenResult struct {
	CompanyID  int64  `json:"company_id"`
	PoolID     int64  `json:"pool_id"`
	Created    bool   `json:"created"`
	PoolStatus string `json:"pool_status"`
	DataRev    int64  `json:"data_rev"`
}

// ConvertResult is the outcome of 转为客户.
type ConvertResult struct {
	CompanyID  int64    `json:"company_id"`
	CustomerID int64    `json:"customer_id"`
	Company    *Company `json:"company"`
	DataRev    int64    `json:"data_rev"`
}

// ImportRequestState is the idempotency reservation result.
type ImportRequestState struct {
	ID       int64
	Replay   bool
	Response json.RawMessage
}

// ---------- filters / writes ----------

type CompanyFilter struct {
	Scope     Scope
	Query     *string
	Level     *string
	Category  *string
	Channel   *string
	Province  *string
	City      *string
	State     *string
	WithPhone *bool
	Dup       *bool
	Due       *bool
	Sort      string
	Page      int
	PageSize  int
}

type PoolFilter struct {
	Query    *string
	Status   *string
	BatchID  *int64
	Since    *time.Time
	Page     int
	PageSize int
}

type AgentCompanyFilter struct {
	Page         int
	PageSize     int
	Since        *time.Time
	Level        *string
	State        *string
	Owner        *string
	HumanTouched *bool
	Converted    *bool
	BatchID      *int64
}

type FollowupWrite struct {
	State           *string
	Note            *string
	LastContactAt   OptionalTime
	NextContactAt   OptionalTime
	ValidPhones     *[]string
	ExpectedVersion *int
}

type PhoneCreate struct {
	PhoneRaw string
	Source   string
	IsValid  bool
}

type PhoneUpdate struct {
	PhoneRaw Optional[string]
	IsValid  Optional[bool]
}

// ProfileUpdateInput carries human profile edits (all optional).
type ProfileUpdateInput struct {
	Name                 Optional[string]   `json:"name"`
	CreditCode           Optional[string]   `json:"credit_code"`
	LegalPerson          Optional[string]   `json:"legal_person"`
	Province             Optional[string]   `json:"province"`
	City                 Optional[string]   `json:"city"`
	FoundedYear          Optional[int]      `json:"founded_year"`
	RegisteredCapitalWan Optional[float64]  `json:"registered_capital_wan"`
	Products             Optional[string]   `json:"products"`
	Category             Optional[string]   `json:"category"`
	Trademarks           Optional[[]string] `json:"trademarks"`
	TrademarkCount       Optional[int]      `json:"trademark_count"`
	IntentLevel          Optional[string]   `json:"intent_level"`
	IntentScore          Optional[int]      `json:"intent_score"`
	IntentBasis          Optional[string]   `json:"intent_basis"`
	AmazonFit            Optional[string]   `json:"amazon_fit"`
	WalmartFit           Optional[string]   `json:"walmart_fit"`
	Sources              Optional[[]string] `json:"sources"`
	Risks                Optional[string]   `json:"risks"`
	ScreenedAt           Optional[string]   `json:"screened_at"`
	PhoneNote            Optional[string]   `json:"phone_note"`
}

// FollowupUpdateInput is the JSON body of PATCH /companies/{id}/followup.
type FollowupUpdateInput struct {
	State         Optional[string]   `json:"state"`
	Note          Optional[string]   `json:"note"`
	LastContactAt Optional[string]   `json:"last_contact_at"`
	NextContactAt Optional[string]   `json:"next_contact_at"`
	ValidPhones   Optional[[]string] `json:"valid_phones"`
	Version       Optional[int]      `json:"version"`
}

// AgentCompanyPatch is the AI profile patch payload; nil pointer = field
// absent, non-nil pointer = explicit value, non-nil slice pointer = set.
type AgentCompanyPatch struct {
	CreditCode           *string   `json:"credit_code"`
	LegalPerson          *string   `json:"legal_person"`
	Province             *string   `json:"province"`
	City                 *string   `json:"city"`
	FoundedYear          *int      `json:"founded_year"`
	RegisteredCapitalWan *float64  `json:"registered_capital_wan"`
	Products             *string   `json:"products"`
	Category             *string   `json:"category"`
	Channel              *string   `json:"channel"`
	Channels             *[]string `json:"channels"`
	ChannelSource        *string   `json:"channel_source"`
	Trademarks           *[]string `json:"trademarks"`
	TrademarkCount       *int      `json:"trademark_count"`
	IntentLevel          *string   `json:"intent_level"`
	IntentScore          *int      `json:"intent_score"`
	IntentBasis          *string   `json:"intent_basis"`
	AmazonFit            *string   `json:"amazon_fit"`
	WalmartFit           *string   `json:"walmart_fit"`
	Sources              *[]string `json:"sources"`
	Risks                *string   `json:"risks"`
	ScreenedAt           *string   `json:"screened_at"`
	PhoneNote            *string   `json:"phone_note"`
	Phones               []string  `json:"phones"`
}

type AgentPoolUpdate struct {
	Status        Optional[string]   `json:"status"`
	Channel       Optional[string]   `json:"channel"`
	Channels      Optional[[]string] `json:"channels"`
	ChannelSource Optional[string]   `json:"channel_source"`
	Website       Optional[string]   `json:"website"`
	LegalPerson   Optional[string]   `json:"legal_person"`
}

// Paginated is the shared list envelope {items,total,page,page_size}.
type Paginated[T any] struct {
	Items    []T `json:"items"`
	Total    int `json:"total"`
	Page     int `json:"page"`
	PageSize int `json:"page_size"`
}

// ---------- errors ----------

// DomainError is shared by user and agent handlers.
type DomainError struct {
	Status  int
	Code    string
	Message string
	Extra   map[string]any
	Current *Followup
}

func (err *DomainError) Error() string {
	if err == nil {
		return ""
	}
	if err.Code != "" {
		return err.Code + ": " + err.Message
	}
	return err.Message
}

func NewDomainError(status int, code, message string) *DomainError {
	return &DomainError{Status: status, Code: code, Message: message}
}

func newValidationError(message string) *DomainError {
	return NewDomainError(http.StatusUnprocessableEntity, "VALIDATION_FAILED", message)
}

func newNotFoundError(entity string, id int64) *DomainError {
	return &DomainError{
		Status:  http.StatusNotFound,
		Code:    "INTENT_NOT_FOUND",
		Message: fmt.Sprintf("%s %d 不存在", entity, id),
		Extra:   map[string]any{"id": id},
	}
}

func newLockedError(companyID int64) *DomainError {
	return &DomainError{
		Status:  http.StatusConflict,
		Code:    "INTENT_RECORD_LOCKED",
		Message: "该记录已被人工跟进，AI 不可修改",
		Extra:   map[string]any{"company_id": companyID},
	}
}

func newForbiddenError(message string) *DomainError {
	return NewDomainError(http.StatusForbidden, "FORBIDDEN", message)
}

func newConflictError(code, message string) *DomainError {
	return NewDomainError(http.StatusConflict, code, message)
}

// Exported constructors used by the pgx store implementation.
func NewValidationError(message string) *DomainError { return newValidationError(message) }

func NewNotFoundError(entity string, id int64) *DomainError { return newNotFoundError(entity, id) }

func NewLockedError(companyID int64) *DomainError { return newLockedError(companyID) }

func NewForbiddenError(message string) *DomainError { return newForbiddenError(message) }

func NewConflictError(code, message string) *DomainError { return newConflictError(code, message) }

// Store errors reused by handlers.
var (
	ErrIdempotencyConflict = &DomainError{
		Status:  http.StatusConflict,
		Code:    "IDEMPOTENCY_CONFLICT",
		Message: "Idempotency-Key 已被用于不同的请求体",
	}
	ErrIdempotencyInFlight = &DomainError{
		Status:  http.StatusConflict,
		Code:    "IDEMPOTENCY_IN_PROGRESS",
		Message: "相同 Idempotency-Key 的请求正在处理中，请稍后重试",
	}
)

// Store is the persistence surface for the crm_intent domain.
type Store interface {
	GetRevisions(ctx context.Context) (dataRev int64, followupRev int64, err error)
	GetMetaData(ctx context.Context, scope Scope) (MetaData, error)
	GetFacets(ctx context.Context, scope Scope) (Facets, error)
	GetBoard(ctx context.Context, scope Scope) ([]BoardColumn, error)

	ListCompanies(ctx context.Context, filter CompanyFilter) (Paginated[Company], error)
	ListCompaniesForExport(ctx context.Context, filter CompanyFilter) ([]Company, error)
	GetCompany(ctx context.Context, companyID int64, scope Scope) (*Company, error)

	ClaimCompany(ctx context.Context, companyID int64, actor Actor) (*Company, error)
	UpdateProfile(ctx context.Context, companyID int64, input ProfileUpdateInput, actor Actor) (*Company, error)
	UpdateFollowup(ctx context.Context, companyID int64, input FollowupWrite, actor Actor) (*Followup, error)
	AddPhone(ctx context.Context, companyID int64, input PhoneCreate, actor Actor) (*Company, error)
	UpdatePhone(ctx context.Context, companyID int64, phoneID int64, input PhoneUpdate, actor Actor) (*Company, error)
	DeletePhone(ctx context.Context, companyID int64, phoneID int64, actor Actor) (*Company, error)
	ConvertCompany(ctx context.Context, companyID int64, actor Actor) (*ConvertResult, error)

	ListPool(ctx context.Context, filter PoolFilter) (Paginated[PoolItem], error)

	ListBatches(ctx context.Context, page, pageSize int) (Paginated[Batch], error)
	GetBatch(ctx context.Context, batchID int64) (*BatchDetail, error)
	CreateBatch(ctx context.Context, input BatchCreate) (int64, error)
	AttachBatchArchive(ctx context.Context, batchID int64, r2Key, sha256 string) error
	FailBatch(ctx context.Context, batchID int64, detail string) error
	IngestBatch(ctx context.Context, request IngestRequest) (IngestResult, error)

	ReserveImportRequest(ctx context.Context, actorKind, actorID, idempotencyKey, requestHash string) (*ImportRequestState, error)
	CompleteImportRequest(ctx context.Context, actorKind, actorID, idempotencyKey string, response []byte) error
	DeleteImportRequest(ctx context.Context, actorKind, actorID, idempotencyKey string) error

	AgentUpsertCompany(ctx context.Context, input CompanyInput, mode string, actor Actor) (AgentUpsertResult, error)
	AgentPatchCompany(ctx context.Context, companyID int64, input AgentCompanyPatch, actor Actor) (*AgentCompanyItem, error)
	AgentListCompanies(ctx context.Context, filter AgentCompanyFilter) (Paginated[AgentCompanyItem], error)
	AgentGetCompany(ctx context.Context, companyID int64) (*AgentCompanyItem, error)
	AgentUpdatePool(ctx context.Context, poolID int64, input AgentPoolUpdate, actor Actor) (*PoolItem, error)
	AgentScreenPool(ctx context.Context, poolID int64, input CompanyInput, actor Actor) (AgentScreenResult, error)

	RecordExportAudit(ctx context.Context, actor Actor, scope string, filtersHash string, rows int) error
}
