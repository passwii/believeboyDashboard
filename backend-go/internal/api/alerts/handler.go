package alerts

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Project struct {
	ProjectOperator   *string
	AssistantOperator *string
}

type RuleFilters struct {
	ProjectID *string
	Metric    *string
	IsActive  *bool
}

type EventFilters struct {
	ProjectID *string
	Severity  *string
	Status    *string
	Page      int
	PageSize  int
}

type Rule struct {
	ID                   int64
	Name                 string
	ProjectID            int64
	Country              string
	Metric               string
	TriggerType          string
	Condition            string
	Threshold            float64
	WindowDays           int
	Severity             string
	NotificationChannels string
	IsActive             bool
	CreatedBy            string
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

type Event struct {
	ID              int64
	RuleID          int64
	ProjectID       int64
	Metric          string
	CurrentValue    float64
	BaselineValue   float64
	DeviationPct    float64
	Severity        string
	Message         string
	Status          string
	TriggeredAt     time.Time
	AcknowledgedAt  *time.Time
	AcknowledgedBy  *string
	MatchRate       *float64
	MismatchedItems *int
	TotalDiff       *float64
	ReportMonth     *string
	ReportID        *int
}

type Stats struct {
	TotalActive       int
	CriticalCount     int
	WarningCount      int
	InfoCount         int
	AcknowledgedToday int
	ResolvedToday     int
}

type Store interface {
	GetProject(ctx context.Context, projectID string) (*Project, error)
	ListRules(ctx context.Context, filters RuleFilters) ([]Rule, error)
	ListEvents(ctx context.Context, filters EventFilters) ([]Event, int, error)
	Stats(ctx context.Context, projectID *string, today string) (Stats, error)
}

type Handler struct {
	store Store
}

func NewHandler(store Store) *Handler {
	return &Handler{store: store}
}

func (h *Handler) Metrics(w http.ResponseWriter, r *http.Request) {
	_ = httpapi.WriteJSON(w, http.StatusOK, metricOptionsResponse{
		Metrics: []metricOption{
			{Value: "sales_amount", Label: "销售额", Description: "每日销售总额"},
			{Value: "order_qty", Label: "订单量", Description: "每日订单总数"},
			{Value: "ad_spend", Label: "广告花费", Description: "每日广告总支出"},
			{Value: "acos", Label: "ACOS", Description: "广告销售成本比"},
			{Value: "return_rate", Label: "退货率", Description: "退货占总订单比例"},
			{Value: "inventory_risk", Label: "库存风险", Description: "库存缺货风险等级"},
			{Value: "reconciliation_mismatch", Label: "报表核对异常", Description: "PDF与数据库数据匹配率低于阈值"},
		},
	})
}

func (h *Handler) Rules(w http.ResponseWriter, r *http.Request) {
	projectID, ok := parseOptionalIntegerQuery(w, r, "project_id")
	if !ok {
		return
	}
	metric := optionalNonEmptyQuery(r, "metric")
	isActive, ok := httpapi.ParseOptionalBoolQuery(w, r, "is_active")
	if !ok {
		return
	}
	isAdmin, ok := adminHeader(w, r)
	if !ok {
		return
	}
	if projectID != nil && !h.requireProjectAccess(w, r, *projectID, isAdmin) {
		return
	}

	rows, err := h.store.ListRules(r.Context(), RuleFilters{
		ProjectID: projectID,
		Metric:    metric,
		IsActive:  isActive,
	})
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	items := make([]ruleResponse, 0, len(rows))
	for _, row := range rows {
		items = append(items, ruleResponse{
			Name:                 row.Name,
			ProjectID:            row.ProjectID,
			Country:              row.Country,
			Metric:               row.Metric,
			TriggerType:          row.TriggerType,
			Condition:            row.Condition,
			Threshold:            row.Threshold,
			WindowDays:           row.WindowDays,
			Severity:             row.Severity,
			NotificationChannels: row.NotificationChannels,
			ID:                   row.ID,
			IsActive:             row.IsActive,
			CreatedBy:            row.CreatedBy,
			CreatedAt:            httpapi.Timestamp(row.CreatedAt),
			UpdatedAt:            httpapi.Timestamp(row.UpdatedAt),
		})
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, items)
}

func (h *Handler) Events(w http.ResponseWriter, r *http.Request) {
	projectID, ok := parseOptionalIntegerQuery(w, r, "project_id")
	if !ok {
		return
	}
	severity := optionalNonEmptyQuery(r, "severity")
	status := optionalNonEmptyQuery(r, "status")
	pageParam, ok := httpapi.ParseIntegerQuery(w, r, "page")
	if !ok {
		return
	}
	page := 1
	if pageParam.Present {
		if !httpapi.ValidateIntegerMinimum(w, pageParam, "page", 1) {
			return
		}
		page = pageParam.IntSaturated()
	}
	pageSizeParam, ok := httpapi.ParseIntegerQuery(w, r, "page_size")
	if !ok {
		return
	}
	pageSize := 20
	if pageSizeParam.Present {
		if !httpapi.ValidateIntegerMinimum(w, pageSizeParam, "page_size", 1) ||
			!httpapi.ValidateIntegerMaximum(w, pageSizeParam, "page_size", 100) {
			return
		}
		pageSize = int(pageSizeParam.Value.Int64())
	}
	isAdmin, ok := adminHeader(w, r)
	if !ok {
		return
	}
	if projectID != nil && !h.requireProjectAccess(w, r, *projectID, isAdmin) {
		return
	}

	rows, total, err := h.store.ListEvents(r.Context(), EventFilters{
		ProjectID: projectID,
		Severity:  severity,
		Status:    status,
		Page:      page,
		PageSize:  pageSize,
	})
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	items := make([]eventResponse, 0, len(rows))
	for _, row := range rows {
		items = append(items, eventResponse{
			ID:              row.ID,
			RuleID:          row.RuleID,
			ProjectID:       row.ProjectID,
			Metric:          row.Metric,
			CurrentValue:    row.CurrentValue,
			BaselineValue:   row.BaselineValue,
			DeviationPct:    row.DeviationPct,
			Severity:        row.Severity,
			Message:         row.Message,
			Status:          row.Status,
			TriggeredAt:     httpapi.Timestamp(row.TriggeredAt),
			AcknowledgedAt:  httpapi.OptionalTimestamp(row.AcknowledgedAt),
			AcknowledgedBy:  row.AcknowledgedBy,
			MatchRate:       row.MatchRate,
			MismatchedItems: row.MismatchedItems,
			TotalDiff:       row.TotalDiff,
			ReportMonth:     row.ReportMonth,
			ReportID:        row.ReportID,
		})
	}
	pageNumber := pageParam.Canonical
	if !pageParam.Present {
		pageNumber = "1"
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, eventListResponse{
		Items:    items,
		Total:    total,
		Page:     json.Number(pageNumber),
		PageSize: pageSize,
	})
}

func (h *Handler) Stats(w http.ResponseWriter, r *http.Request) {
	projectID, ok := parseOptionalIntegerQuery(w, r, "project_id")
	if !ok {
		return
	}
	stats, err := h.store.Stats(
		r.Context(),
		projectID,
		time.Now().Format("2006-01-02"),
	)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, statsResponse{
		TotalActive:       stats.TotalActive,
		CriticalCount:     stats.CriticalCount,
		WarningCount:      stats.WarningCount,
		InfoCount:         stats.InfoCount,
		AcknowledgedToday: stats.AcknowledgedToday,
		ResolvedToday:     stats.ResolvedToday,
	})
}

func (h *Handler) requireProjectAccess(
	w http.ResponseWriter,
	r *http.Request,
	projectID string,
	isAdmin bool,
) bool {
	project, err := h.store.GetProject(r.Context(), projectID)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return false
	}
	if project == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
		return false
	}
	if isAdmin {
		return true
	}
	operator := requestOperator(r)
	if operator == "" ||
		(!textContainsName(project.ProjectOperator, operator) &&
			!textContainsName(project.AssistantOperator, operator)) {
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
		return false
	}
	return true
}

func parseOptionalIntegerQuery(
	w http.ResponseWriter,
	r *http.Request,
	name string,
) (*string, bool) {
	param, ok := httpapi.ParseIntegerQuery(w, r, name)
	if !ok {
		return nil, false
	}
	if !param.Present {
		return nil, true
	}
	value := param.Canonical
	return &value, true
}

func optionalNonEmptyQuery(r *http.Request, name string) *string {
	values, present := r.URL.Query()[name]
	if !present {
		return nil
	}
	raw := ""
	if len(values) > 0 {
		raw = values[len(values)-1]
	}
	if raw == "" {
		return nil
	}
	return &raw
}

func adminHeader(w http.ResponseWriter, r *http.Request) (bool, bool) {
	value, ok := httpapi.ParseOptionalBoolHeader(w, r, "X-Is-Admin")
	if !ok {
		return false, false
	}
	return value != nil && *value, true
}

func requestOperator(r *http.Request) string {
	values, present := r.Header["X-Operator"]
	if !present {
		values, present = r.Header["X-User-Name"]
	}
	if !present || len(values) == 0 {
		return ""
	}
	value := auth.DecodeHeaderValue(values[0])
	if value == "" {
		return ""
	}
	return truncateRunes(value, 255)
}

func textContainsName(value *string, target string) bool {
	target = strings.TrimSpace(target)
	if target == "" || value == nil {
		return false
	}
	for _, name := range splitMultiNames(*value) {
		if name == target {
			return true
		}
	}
	return false
}

func splitMultiNames(value string) []string {
	names := strings.FieldsFunc(value, func(char rune) bool {
		switch char {
		case '、', ',', '，', ';', '\n':
			return true
		default:
			return false
		}
	})
	result := make([]string, 0, len(names))
	for _, name := range names {
		if name = strings.TrimSpace(name); name != "" {
			result = append(result, name)
		}
	}
	return result
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}

type metricOptionsResponse struct {
	Metrics []metricOption `json:"metrics"`
}

type metricOption struct {
	Value       string `json:"value"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

type ruleResponse struct {
	Name                 string  `json:"name"`
	ProjectID            int64   `json:"project_id"`
	Country              string  `json:"country"`
	Metric               string  `json:"metric"`
	TriggerType          string  `json:"trigger_type"`
	Condition            string  `json:"condition"`
	Threshold            float64 `json:"threshold"`
	WindowDays           int     `json:"window_days"`
	Severity             string  `json:"severity"`
	NotificationChannels string  `json:"notification_channels"`
	ID                   int64   `json:"id"`
	IsActive             bool    `json:"is_active"`
	CreatedBy            string  `json:"created_by"`
	CreatedAt            string  `json:"created_at"`
	UpdatedAt            string  `json:"updated_at"`
}

type eventListResponse struct {
	Items    []eventResponse `json:"items"`
	Total    int             `json:"total"`
	Page     json.Number     `json:"page"`
	PageSize int             `json:"page_size"`
}

type eventResponse struct {
	ID              int64    `json:"id"`
	RuleID          int64    `json:"rule_id"`
	ProjectID       int64    `json:"project_id"`
	Metric          string   `json:"metric"`
	CurrentValue    float64  `json:"current_value"`
	BaselineValue   float64  `json:"baseline_value"`
	DeviationPct    float64  `json:"deviation_pct"`
	Severity        string   `json:"severity"`
	Message         string   `json:"message"`
	Status          string   `json:"status"`
	TriggeredAt     string   `json:"triggered_at"`
	AcknowledgedAt  *string  `json:"acknowledged_at"`
	AcknowledgedBy  *string  `json:"acknowledged_by"`
	MatchRate       *float64 `json:"match_rate"`
	MismatchedItems *int     `json:"mismatched_items"`
	TotalDiff       *float64 `json:"total_diff"`
	ReportMonth     *string  `json:"report_month"`
	ReportID        *int     `json:"report_id"`
}

type statsResponse struct {
	TotalActive       int `json:"total_active"`
	CriticalCount     int `json:"critical_count"`
	WarningCount      int `json:"warning_count"`
	InfoCount         int `json:"info_count"`
	AcknowledgedToday int `json:"acknowledged_today"`
	ResolvedToday     int `json:"resolved_today"`
}
