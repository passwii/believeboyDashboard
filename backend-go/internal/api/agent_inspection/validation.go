package agent_inspection

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
)

var healthFieldKeys = []string{
	"account_health_rating",
	"negative_feedback",
	"a2z_claims",
	"chargeback_claims",
	"late_shipment_rate",
	"pre_fulfillment_cancel_rate",
	"valid_tracking_rate",
	"on_time_delivery_rate",
}

var complianceFieldKeys = []string{
	"ip_infringement",
	"ip_complaints",
	"product_authenticity_complaints",
	"product_condition_complaints",
	"food_product_safety",
	"listing_policy_violations",
	"restricted_product_violations",
	"review_policy_violations",
	"other_policy_violations",
	"regulatory_compliance",
}

var accountHealthRatings = map[string]bool{
	"Healthy":  true,
	"Good":     true,
	"At Risk":  true,
	"Critical": true,
}

func validationFailure(detail string) error {
	return &agentauth.APIError{
		Status: http.StatusUnprocessableEntity,
		Code:   agentauth.ErrorCodeValidationFailed,
		Detail: detail,
	}
}

func unavailable(detail string) error {
	return &agentauth.APIError{
		Status: http.StatusServiceUnavailable,
		Code:   "SERVICE_UNAVAILABLE",
		Detail: detail,
	}
}

func readJSONObject(
	w http.ResponseWriter,
	r *http.Request,
	maxBytes int64,
) (map[string]json.RawMessage, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	payload, err := io.ReadAll(r.Body)
	if err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			return nil, &agentauth.APIError{
				Status: http.StatusRequestEntityTooLarge,
				Code:   agentauth.ErrorCodeValidationFailed,
				Detail: "request body too large",
			}
		}
		return nil, validationFailure("请求体读取失败")
	}
	if len(bytes.TrimSpace(payload)) == 0 {
		return map[string]json.RawMessage{}, nil
	}
	return parseJSONObjectPayload(payload)
}

func parseJSONObjectPayload(payload []byte) (map[string]json.RawMessage, error) {
	if len(bytes.TrimSpace(payload)) == 0 {
		return map[string]json.RawMessage{}, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	var object map[string]json.RawMessage
	if err := decoder.Decode(&object); err != nil {
		return nil, validationFailure("请求体必须是 JSON 对象")
	}
	if object == nil {
		return nil, validationFailure("请求体必须是 JSON 对象")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, validationFailure("请求体必须是单个 JSON 对象")
	}
	return object, nil
}

func decodeRaw(raw json.RawMessage, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("trailing JSON value")
	}
	return nil
}

func normalizeCountry(value string) (string, error) {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "US", "USA", "美国", "美国站":
		return "US", nil
	case "DE", "GERMANY", "德国", "德国站":
		return "DE", nil
	case "UK", "GB", "UNITED KINGDOM", "英国", "英国站":
		return "UK", nil
	default:
		return "", fmt.Errorf("country must be one of: DE, UK, US")
	}
}

func normalizeCountries(raw string, allowEmpty bool) ([]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		if allowEmpty {
			return nil, nil
		}
		return nil, validationFailure("country is required")
	}
	parts := strings.Split(raw, ",")
	seen := make(map[string]bool)
	countries := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		country, err := normalizeCountry(part)
		if err != nil {
			return nil, validationFailure(err.Error())
		}
		if !seen[country] {
			seen[country] = true
			countries = append(countries, country)
		}
	}
	if len(countries) == 0 {
		if allowEmpty {
			return nil, nil
		}
		return nil, validationFailure("country is required")
	}
	return countries, nil
}

func normalizeISO2Country(raw string) (string, error) {
	value := strings.ToUpper(strings.TrimSpace(raw))
	if len(value) != 2 {
		return "", validationFailure("country 必须是 ISO-2 国家代码（如 US/DE/UK）")
	}
	for _, character := range value {
		if character < 'A' || character > 'Z' {
			return "", validationFailure("country 必须是 ISO-2 国家代码（如 US/DE/UK）")
		}
	}
	return value, nil
}

func parsePositiveID(raw, field string) (int64, error) {
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || value < 1 {
		return 0, validationFailure(field + " must be a positive integer")
	}
	return value, nil
}

func parseOptionalPositiveID(raw, field string) (*int64, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	value, err := parsePositiveID(raw, field)
	if err != nil {
		return nil, err
	}
	return &value, nil
}

func parseBoundedInt(raw string, fallback, minimum, maximum int, field string) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value < minimum || value > maximum {
		return 0, validationFailure(fmt.Sprintf("%s must be between %d and %d", field, minimum, maximum))
	}
	return value, nil
}

func parseNonNegativeInt(raw string, field string) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return 0, nil
	}
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value < 0 {
		return 0, validationFailure(field + " must be a non-negative integer")
	}
	return value, nil
}

func parseBool(raw string, fallback bool, field string) (bool, error) {
	if strings.TrimSpace(raw) == "" {
		return fallback, nil
	}
	value, err := strconv.ParseBool(strings.TrimSpace(raw))
	if err != nil {
		return false, validationFailure(field + " must be a boolean")
	}
	return value, nil
}

func validateIdempotencyKey(r *http.Request) (*string, error) {
	values, exists := r.Header[http.CanonicalHeaderKey("Idempotency-Key")]
	if !exists && len(values) == 0 {
		return nil, nil
	}
	value := ""
	if len(values) > 0 {
		value = values[0]
	}
	if strings.TrimSpace(value) == "" {
		return nil, validationFailure("Idempotency-Key 不能为空字符串")
	}
	if len(value) > 64 {
		return nil, validationFailure("Idempotency-Key 长度不能超过 64 字符")
	}
	return &value, nil
}

func parseReportPatch(body map[string]json.RawMessage) (ReportPatch, error) {
	var patch ReportPatch
	if raw, ok := body["health_data"]; ok {
		if !isJSONNull(raw) {
			values, err := parseHealthBlock(raw)
			if err != nil {
				return patch, err
			}
			patch.HealthDataSet = true
			patch.HealthData = values
		}
	}
	if raw, ok := body["compliance_data"]; ok {
		if !isJSONNull(raw) {
			values, err := parseComplianceBlock(raw)
			if err != nil {
				return patch, err
			}
			patch.ComplianceDataSet = true
			patch.ComplianceData = values
		}
	}
	if raw, ok := body["status_summary"]; ok {
		patch.StatusSummarySet = true
		if !isJSONNull(raw) {
			var summary string
			if err := decodeRaw(raw, &summary); err != nil {
				return patch, validationFailure("status_summary must be a string or null")
			}
			patch.StatusSummary = &summary
		}
	}
	return patch, nil
}

func parseHealthBlock(raw json.RawMessage) (map[string]any, error) {
	var object map[string]json.RawMessage
	if err := decodeRaw(raw, &object); err != nil || object == nil {
		return nil, validationFailure("health_data must be an object")
	}
	result := make(map[string]any)
	for _, key := range healthFieldKeys {
		value, ok := object[key]
		if !ok {
			continue
		}
		if isJSONNull(value) {
			result[key] = nil
			continue
		}
		switch key {
		case "account_health_rating":
			var rating string
			if err := decodeRaw(value, &rating); err != nil || !accountHealthRatings[rating] {
				return nil, validationFailure(
					"account_health_rating 必须是 [At Risk Critical Good Healthy] 之一",
				)
			}
			result[key] = rating
		case "negative_feedback", "a2z_claims", "chargeback_claims":
			number, err := parseIntegerValue(value)
			if err != nil {
				return nil, validationFailure(key + " must be an integer or null")
			}
			result[key] = number
		default:
			number, err := parseFloatValue(value)
			if err != nil {
				return nil, validationFailure(key + " must be a number or null")
			}
			result[key] = number
		}
	}
	return result, nil
}

func parseComplianceBlock(raw json.RawMessage) (map[string]any, error) {
	var object map[string]json.RawMessage
	if err := decodeRaw(raw, &object); err != nil || object == nil {
		return nil, validationFailure("compliance_data must be an object")
	}
	result := make(map[string]any)
	for _, key := range complianceFieldKeys {
		value, ok := object[key]
		if !ok {
			continue
		}
		if isJSONNull(value) {
			result[key] = nil
			continue
		}
		number, err := parseIntegerValue(value)
		if err != nil {
			return nil, validationFailure(key + " must be an integer or null")
		}
		result[key] = number
	}
	return result, nil
}

func parseIntegerValue(raw json.RawMessage) (any, error) {
	var number json.Number
	if err := decodeRaw(raw, &number); err != nil {
		return nil, err
	}
	if value, err := strconv.ParseInt(number.String(), 10, 64); err == nil {
		return value, nil
	}
	return nil, fmt.Errorf("not an integer")
}

func parseFloatValue(raw json.RawMessage) (any, error) {
	var number json.Number
	if err := decodeRaw(raw, &number); err != nil {
		return nil, err
	}
	return strconv.ParseFloat(number.String(), 64)
}

func isJSONNull(raw json.RawMessage) bool {
	return strings.EqualFold(strings.TrimSpace(string(raw)), "null")
}

type rawRunSummary struct {
	TotalNeedsReply         *int `json:"total_needs_reply"`
	TotalReportedUnresolved *int `json:"total_reported_unresolved"`
	ShopsWithPending        *int `json:"shops_with_pending"`
}

type rawShopMetrics struct {
	NeedsReply         *int `json:"needs_reply"`
	ReportedUnresolved *int `json:"reported_unresolved"`
	ResolvedTotal      *int `json:"resolved_total"`
	ResolvedToday      *int `json:"resolved_today"`
}

type rawIdentityCheck struct {
	ExpectedAlias   *string   `json:"expected_alias"`
	ObservedAlias   *string   `json:"observed_alias"`
	ObservedCountry *[]string `json:"observed_country"`
	Verified        *bool     `json:"verified"`
	Source          *string   `json:"source"`
}

type rawShopCheck struct {
	ProjectID     *int64            `json:"project_id"`
	Country       *string           `json:"country"`
	CheckStatus   *string           `json:"check_status"`
	ErrorMessage  *string           `json:"error_message"`
	IdentityCheck *rawIdentityCheck `json:"identity_check"`
	Metrics       *rawShopMetrics   `json:"metrics"`
}

type rawTriage struct {
	Category  *string `json:"category"`
	HasOrder  *bool   `json:"has_order"`
	SummaryZH *string `json:"summary_zh"`
}

type rawOrderInfo struct {
	OrderID      *string `json:"order_id"`
	ASIN         *string `json:"asin"`
	ProductTitle *string `json:"product_title"`
	Qty          *int    `json:"qty"`
	PurchasedAt  *string `json:"purchased_at"`
	ShippedAt    *string `json:"shipped_at"`
	DeliveredAt  *string `json:"delivered_at"`
}

type rawSLAInfo struct {
	ReplyDeadline *string `json:"reply_deadline"`
	ExpiresSoon   *bool   `json:"expires_soon"`
}

type rawComplaint struct {
	ProjectID        *int64        `json:"project_id"`
	Country          *string       `json:"country"`
	FirstMessageDate *string       `json:"first_message_date"`
	MessageDate      *string       `json:"message_date"`
	BuyerName        *string       `json:"buyer_name"`
	Subject          *string       `json:"subject"`
	MessageBody      *string       `json:"message_body"`
	Triage           *rawTriage    `json:"triage"`
	Order            *rawOrderInfo `json:"order"`
	SLA              *rawSLAInfo   `json:"sla"`
	MessageCount     *int          `json:"message_count"`
}

type rawComplaintBatch struct {
	RunDate      *string         `json:"run_date"`
	Trigger      *string         `json:"trigger"`
	ShopsTotal   *int            `json:"shops_total"`
	ShopsChecked *int            `json:"shops_checked"`
	ShopsFailed  *[]string       `json:"shops_failed"`
	Summary      *rawRunSummary  `json:"summary"`
	ShopChecks   *[]rawShopCheck `json:"shop_checks"`
	Complaints   *[]rawComplaint `json:"complaints"`
}

func parseComplaintBatch(body map[string]json.RawMessage) (ComplaintBatchInput, error) {
	var raw rawComplaintBatch
	payload, err := json.Marshal(body)
	if err != nil {
		return ComplaintBatchInput{}, validationFailure("请求体必须是 JSON 对象")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	if err := decoder.Decode(&raw); err != nil {
		return ComplaintBatchInput{}, validationFailure("请求参数校验失败")
	}
	if raw.RunDate == nil {
		return ComplaintBatchInput{}, validationFailure("run_date is required")
	}
	if err := validateDate(*raw.RunDate); err != nil {
		return ComplaintBatchInput{}, validationFailure("run_date 格式非法（期望 YYYY-MM-DD）")
	}
	if raw.ShopsTotal == nil || *raw.ShopsTotal < 0 {
		return ComplaintBatchInput{}, validationFailure("shops_total must be a non-negative integer")
	}
	if raw.ShopsChecked == nil || *raw.ShopsChecked < 0 {
		return ComplaintBatchInput{}, validationFailure("shops_checked must be a non-negative integer")
	}

	trigger := "autopilot"
	if raw.Trigger != nil {
		trigger = strings.TrimSpace(*raw.Trigger)
	}
	if trigger != "autopilot" && trigger != "manual" {
		return ComplaintBatchInput{}, validationFailure("trigger must be autopilot or manual")
	}

	input := ComplaintBatchInput{
		RunDate:      *raw.RunDate,
		Trigger:      trigger,
		ShopsTotal:   *raw.ShopsTotal,
		ShopsChecked: *raw.ShopsChecked,
		ShopsFailed:  []string{},
		ShopChecks:   []ShopCheckInput{},
		Complaints:   []ComplaintInput{},
	}
	if raw.ShopsFailed != nil {
		input.ShopsFailed = append([]string(nil), (*raw.ShopsFailed)...)
	}
	if raw.Summary != nil {
		input.Summary.TotalNeedsReply = intValue(raw.Summary.TotalNeedsReply)
		input.Summary.TotalReportedUnresolved = intValue(raw.Summary.TotalReportedUnresolved)
		input.Summary.ShopsWithPending = intValue(raw.Summary.ShopsWithPending)
	}
	if raw.ShopChecks != nil {
		for _, item := range *raw.ShopChecks {
			check, err := parseShopCheck(item)
			if err != nil {
				return ComplaintBatchInput{}, err
			}
			input.ShopChecks = append(input.ShopChecks, check)
		}
	}
	if raw.Complaints != nil {
		for _, item := range *raw.Complaints {
			complaint, err := parseComplaint(item)
			if err != nil {
				return ComplaintBatchInput{}, err
			}
			input.Complaints = append(input.Complaints, complaint)
		}
	}
	return input, nil
}

func parseShopCheck(raw rawShopCheck) (ShopCheckInput, error) {
	if raw.ProjectID == nil || *raw.ProjectID < 1 {
		return ShopCheckInput{}, validationFailure("shop_checks.project_id must be a positive integer")
	}
	country := "US"
	if raw.Country != nil {
		normalized, err := normalizeCountry(*raw.Country)
		if err != nil {
			return ShopCheckInput{}, validationFailure(err.Error())
		}
		country = normalized
	}
	status := "ok"
	if raw.CheckStatus != nil {
		status = strings.TrimSpace(*raw.CheckStatus)
	}
	switch status {
	case "ok", "login_page", "launch_fail", "identity_mismatch":
	default:
		return ShopCheckInput{}, validationFailure("shop_checks.check_status is invalid")
	}
	input := ShopCheckInput{
		ProjectID:    *raw.ProjectID,
		Country:      country,
		CheckStatus:  status,
		ErrorMessage: raw.ErrorMessage,
	}
	if raw.Metrics != nil {
		input.Metrics = ShopMetrics{
			NeedsReply:         intValue(raw.Metrics.NeedsReply),
			ReportedUnresolved: intValue(raw.Metrics.ReportedUnresolved),
			ResolvedTotal:      intValue(raw.Metrics.ResolvedTotal),
			ResolvedToday:      intValue(raw.Metrics.ResolvedToday),
		}
	}
	if raw.IdentityCheck != nil {
		source := "amazon_seller_central_account_switcher"
		if raw.IdentityCheck.Source != nil {
			source = *raw.IdentityCheck.Source
		}
		observed := []string{}
		if raw.IdentityCheck.ObservedCountry != nil {
			observed = append([]string(nil), (*raw.IdentityCheck.ObservedCountry)...)
		}
		verified := false
		if raw.IdentityCheck.Verified != nil {
			verified = *raw.IdentityCheck.Verified
		}
		input.IdentityCheck = &IdentityCheck{
			ExpectedAlias:   raw.IdentityCheck.ExpectedAlias,
			ObservedAlias:   raw.IdentityCheck.ObservedAlias,
			ObservedCountry: observed,
			Verified:        verified,
			Source:          source,
		}
	}
	return input, nil
}

func parseComplaint(raw rawComplaint) (ComplaintInput, error) {
	if raw.ProjectID == nil || *raw.ProjectID < 1 {
		return ComplaintInput{}, validationFailure("complaints.project_id must be a positive integer")
	}
	country := "US"
	if raw.Country != nil {
		normalized, err := normalizeCountry(*raw.Country)
		if err != nil {
			return ComplaintInput{}, validationFailure(err.Error())
		}
		country = normalized
	}
	if raw.FirstMessageDate == nil || validateDate(*raw.FirstMessageDate) != nil {
		return ComplaintInput{}, validationFailure("complaints.first_message_date must be YYYY-MM-DD")
	}
	if raw.MessageDate == nil || validateDate(*raw.MessageDate) != nil {
		return ComplaintInput{}, validationFailure("complaints.message_date must be YYYY-MM-DD")
	}
	if raw.BuyerName == nil || strings.TrimSpace(*raw.BuyerName) == "" || len(*raw.BuyerName) > 255 {
		return ComplaintInput{}, validationFailure("complaints.buyer_name is required and must be <= 255 characters")
	}
	if raw.Subject == nil || len(*raw.Subject) > 512 {
		return ComplaintInput{}, validationFailure("complaints.subject is required and must be <= 512 characters")
	}
	if raw.MessageBody == nil {
		return ComplaintInput{}, validationFailure("complaints.message_body is required")
	}
	if raw.Triage == nil || raw.Triage.Category == nil {
		return ComplaintInput{}, validationFailure("complaints.triage.category is required")
	}
	category := strings.TrimSpace(*raw.Triage.Category)
	switch category {
	case "with_order", "no_order_info", "spam":
	default:
		return ComplaintInput{}, validationFailure("complaints.triage.category is invalid")
	}
	if raw.Triage.HasOrder == nil {
		return ComplaintInput{}, validationFailure("complaints.triage.has_order is required")
	}
	summaryZH := ""
	if raw.Triage.SummaryZH != nil {
		summaryZH = *raw.Triage.SummaryZH
	}
	messageCount := 1
	if raw.MessageCount != nil {
		messageCount = *raw.MessageCount
	}
	if messageCount < 1 {
		return ComplaintInput{}, validationFailure("complaints.message_count must be >= 1")
	}

	var order map[string]any
	if raw.Order != nil {
		if raw.Order.OrderID == nil || raw.Order.ASIN == nil || raw.Order.ProductTitle == nil {
			return ComplaintInput{}, validationFailure("complaints.order requires order_id, asin, product_title")
		}
		for field, value := range map[string]*string{
			"purchased_at": raw.Order.PurchasedAt,
			"shipped_at":   raw.Order.ShippedAt,
			"delivered_at": raw.Order.DeliveredAt,
		} {
			if value != nil && *value != "" {
				if _, err := time.Parse(time.RFC3339, *value); err != nil {
					return ComplaintInput{}, validationFailure("complaints.order." + field + " must be RFC3339")
				}
			}
		}
		qty := 1
		if raw.Order.Qty != nil {
			qty = *raw.Order.Qty
		}
		order = map[string]any{
			"order_id":      *raw.Order.OrderID,
			"asin":          *raw.Order.ASIN,
			"product_title": *raw.Order.ProductTitle,
			"qty":           qty,
			"purchased_at":  raw.Order.PurchasedAt,
			"shipped_at":    raw.Order.ShippedAt,
			"delivered_at":  raw.Order.DeliveredAt,
		}
	}
	var sla map[string]any
	if raw.SLA != nil {
		if raw.SLA.ReplyDeadline != nil && *raw.SLA.ReplyDeadline != "" {
			if _, err := time.Parse(time.RFC3339, *raw.SLA.ReplyDeadline); err != nil {
				return ComplaintInput{}, validationFailure("complaints.sla.reply_deadline must be RFC3339")
			}
		}
		expiresSoon := false
		if raw.SLA.ExpiresSoon != nil {
			expiresSoon = *raw.SLA.ExpiresSoon
		}
		sla = map[string]any{"expires_soon": expiresSoon}
		if raw.SLA.ReplyDeadline != nil {
			sla["reply_deadline"] = *raw.SLA.ReplyDeadline
		}
	}

	return ComplaintInput{
		ProjectID:        *raw.ProjectID,
		Country:          country,
		FirstMessageDate: *raw.FirstMessageDate,
		MessageDate:      *raw.MessageDate,
		BuyerName:        *raw.BuyerName,
		Subject:          *raw.Subject,
		MessageBody:      *raw.MessageBody,
		Triage: Triage{
			Category:  category,
			HasOrder:  *raw.Triage.HasOrder,
			SummaryZH: summaryZH,
		},
		Order:        order,
		SLA:          sla,
		MessageCount: messageCount,
	}, nil
}

func intValue(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}

func validateDate(value string) error {
	_, err := time.Parse("2006-01-02", strings.TrimSpace(value))
	return err
}
