package complaints

import (
	"context"
	"errors"
)

type Triage struct {
	Category  string `json:"category"`
	HasOrder  bool   `json:"has_order"`
	SummaryZH string `json:"summary_zh"`
}

type OrderInfo struct {
	OrderID      string  `json:"order_id"`
	ASIN         string  `json:"asin"`
	ProductTitle string  `json:"product_title"`
	Qty          int     `json:"qty"`
	PurchasedAt  *string `json:"purchased_at"`
	ShippedAt    *string `json:"shipped_at"`
	DeliveredAt  *string `json:"delivered_at"`
}

type SlaInfo struct {
	ReplyDeadline *string `json:"reply_deadline"`
	ExpiresSoon   bool    `json:"expires_soon"`
}

type ComplaintStatusHistoryEntry struct {
	From       *string `json:"from,omitempty"`
	FromStatus *string `json:"from_status,omitempty"`
	To         string  `json:"to"`
	ToStatus   string  `json:"to_status,omitempty"`
	At         string  `json:"at"`
	Timestamp  string  `json:"timestamp,omitempty"`
	By         string  `json:"by"`
	Operator   string  `json:"operator,omitempty"`
	Note       *string `json:"note,omitempty"`
}

type ComplaintListItem struct {
	ID               int64                         `json:"id"`
	RunID            int64                         `json:"run_id"`
	ProjectID        int64                         `json:"project_id"`
	ProjectName      string                        `json:"project_name"`
	Country          string                        `json:"country"`
	BuyerName        string                        `json:"buyer_name"`
	FirstMessageDate string                        `json:"first_message_date"`
	MessageDate      string                        `json:"message_date"`
	Subject          string                        `json:"subject"`
	Category         string                        `json:"category"`
	HasOrder         bool                          `json:"has_order"`
	Status           string                        `json:"status"`
	Triage           Triage                        `json:"triage"`
	OrderInfo        *OrderInfo                    `json:"order_info"`
	SLA              *SlaInfo                      `json:"sla"`
	StatusHistory    []ComplaintStatusHistoryEntry `json:"status_history"`
	DraftPath        *string                       `json:"draft_path"`
	ReplySentAt      *string                       `json:"reply_sent_at"`
	HandlerNote      *string                       `json:"handler_note"`
	MessageCount     int                           `json:"message_count"`
	CreatedAt        string                        `json:"created_at"`
	UpdatedAt        string                        `json:"updated_at"`
}

type ComplaintDetail struct {
	ComplaintListItem
	MessageBody string `json:"message_body"`
	Messages    []any  `json:"messages"`
}

type ComplaintListResponse struct {
	Items     []ComplaintListItem `json:"items"`
	Total     int                 `json:"total"`
	Page      int                 `json:"page"`
	PageSize  int                 `json:"page_size"`
	SpamCount int                 `json:"spam_count"`
}

type OverviewMetrics struct {
	TotalNeedsReply         int `json:"total_needs_reply"`
	TotalReportedUnresolved int `json:"total_reported_unresolved"`
	TotalResolved           int `json:"total_resolved"`
	SLADueSoon              int `json:"sla_due_soon"`
	SLAOverdue              int `json:"sla_overdue"`
}

type OverviewTrendPoint struct {
	Date       string `json:"date"`
	NeedsReply int    `json:"needs_reply"`
}

type OverviewProjectRow struct {
	ProjectID   int64  `json:"project_id"`
	ProjectName string `json:"project_name"`
	Country     string `json:"country"`
	CheckStatus string `json:"check_status"`
	NeedsReply  int    `json:"needs_reply"`
	Resolved    int    `json:"resolved"`
	SLADueSoon  int    `json:"sla_due_soon"`
	SLAOverdue  int    `json:"sla_overdue"`
}

type OverviewResponse struct {
	Date     string               `json:"date"`
	Metrics  OverviewMetrics      `json:"metrics"`
	Trend    []OverviewTrendPoint `json:"trend"`
	Projects []OverviewProjectRow `json:"projects"`
}

type ComplaintPatchRequest struct {
	Status      *string `json:"status"`
	DraftPath   *string `json:"draft_path"`
	ReplySentAt *string `json:"reply_sent_at"`
	HandlerNote *string `json:"handler_note"`
}

type ComplaintFilter struct {
	Date             *string
	ProjectID        *int64
	ProjectIDs       []int64
	Category         *string
	Status           *string
	Country          *string
	Keyword          *string
	FirstMessageDate *string
	Sort             string
	Page             int
	PageSize         int
	Operator         string
	IsAdmin          bool
}

type Store interface {
	GetOverview(ctx context.Context, targetDate string, country *string) (OverviewResponse, error)
	ListComplaints(ctx context.Context, filter ComplaintFilter) (ComplaintListResponse, error)
	GetComplaint(ctx context.Context, id int64) (*ComplaintDetail, error)
	PatchComplaint(ctx context.Context, id int64, req ComplaintPatchRequest, op string) (*ComplaintDetail, error)
	VerifyProjectAccess(ctx context.Context, projectID int64, op string, isAdmin bool) error
}

var (
	ErrProjectNotFound  = errors.New("项目不存在")
	ErrProjectForbidden = errors.New("无权限访问该项目")
)

type accessibleProjectIDsContextKey struct{}

func WithAccessibleProjectIDs(ctx context.Context, ids []int64) context.Context {
	return context.WithValue(ctx, accessibleProjectIDsContextKey{}, ids)
}

func AccessibleProjectIDsFromContext(ctx context.Context) ([]int64, bool) {
	ids, ok := ctx.Value(accessibleProjectIDsContextKey{}).([]int64)
	return ids, ok
}

var ComplaintStatusOrder = []string{
	"pending",
	"drafted",
	"replied",
	"resolved",
	"closed_no_response",
}

func StatusIndex(status string) int {
	for i, s := range ComplaintStatusOrder {
		if s == status {
			return i
		}
	}
	return -1
}

func CanTransition(fromStatus, toStatus string) bool {
	fromIdx := StatusIndex(fromStatus)
	toIdx := StatusIndex(toStatus)
	if fromIdx == -1 || toIdx == -1 {
		return false
	}
	return toIdx >= fromIdx
}
