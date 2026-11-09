package system_management

import (
	"errors"
	"math"
	"net/http"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

func (h *Handler) ListCommissionProjectMonths(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	month, ok := parseReportMonth(w, r.URL.Query().Get("report_month"))
	if !ok {
		return
	}
	country := optionalQuery(r, "country")
	items, err := h.store.ListCommissionProjectMonths(r.Context(), month, country)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if items == nil {
		items = make([]CommissionProjectMonthItem, 0)
	}
	h.logView(
		r,
		"commission.project_months.view",
		"commission_project_month",
		operator,
		map[string]any{
			"report_month": month,
			"country":      country,
			"count":        len(items),
		},
	)
	_ = httpapi.WriteJSON(w, http.StatusOK, CommissionProjectMonthsResponse{
		ReportMonth: month,
		Items:       items,
	})
}

func (h *Handler) UpdateCommissionProjectPayment(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	projectMonthID, ok := parsePathID(w, r, "project_month_id")
	if !ok {
		return
	}
	var body UpdateCommissionProjectPaymentRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	if !validProjectPaymentStatus(body.PaymentStatus) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "payment_status must be paid, partial, or unpaid")
		return
	}
	if !finiteNonNegative(body.ReceivedRMB) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "received_rmb must be greater than or equal to 0")
		return
	}
	note, valid := normalizedOptionalText(body.Note, 500)
	if !valid {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "note must be at most 500 characters")
		return
	}
	mutation, err := h.store.UpdateCommissionProjectPayment(
		r.Context(),
		projectMonthID,
		body.PaymentStatus,
		body.ReceivedRMB,
		note,
		h.now(),
		operator,
	)
	if errors.Is(err, ErrNotFound) || (err == nil && mutation.After == nil) {
		httpapi.WriteDetail(w, http.StatusNotFound, "project month record not found")
		return
	}
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if !h.logAction(r, audit.Entry{
		Action:     "commission.project_commission.payment.update",
		TargetType: "commission_project_month",
		TargetID:   int64Pointer(projectMonthID),
		Operator:   operator,
		BeforeJSON: mutation.Before,
		AfterJSON:  mutation.After,
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, UpdateCommissionProjectPaymentResponse{
		Item: *mutation.After,
	})
}

func (h *Handler) ListCommissionRecords(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	month, ok := parseReportMonth(w, r.URL.Query().Get("report_month"))
	if !ok {
		return
	}
	country := normalizedQuery(r, "country")
	if country == "" {
		country = "US"
	}
	includeInactive, ok := parseOptionalBoolQuery(w, r, "include_inactive", false)
	if !ok {
		return
	}
	filter := CommissionRecordFilter{
		ReportMonth:     month,
		Country:         country,
		PersonName:      normalizedQuery(r, "person_name"),
		IncludeInactive: includeInactive,
	}
	items, err := h.store.ListCommissionRecords(r.Context(), filter)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if items == nil {
		items = make([]CommissionRecordItem, 0)
	}
	h.logView(
		r,
		"commission.bonus_records.view",
		"commission_bonus_record",
		operator,
		map[string]any{
			"report_month":     month,
			"country":          country,
			"person_name":      nullableString(filter.PersonName),
			"include_inactive": includeInactive,
			"count":            len(items),
		},
	)
	_ = httpapi.WriteJSON(w, http.StatusOK, CommissionRecordsResponse{
		ReportMonth: month,
		Items:       items,
	})
}

func (h *Handler) UpsertCommissionRecords(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	var body UpsertCommissionRecordsRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	month, ok := parseReportMonth(w, body.ReportMonth)
	if !ok {
		return
	}
	country := normalizedQuery(r, "country")
	if country == "" {
		country = "US"
	}
	for i := range body.Items {
		if detail := validateCommissionRecordUpsertItem(&body.Items[i]); detail != "" {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, detail)
			return
		}
	}
	items, err := h.store.UpsertCommissionRecords(
		r.Context(),
		month,
		country,
		body.Items,
		h.now(),
	)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if items == nil {
		items = make([]CommissionRecordItem, 0)
	}
	if !h.logAction(r, audit.Entry{
		Action:     "commission.bonus_records.upsert",
		TargetType: "commission_bonus_record",
		TargetID:   stringPointer(month),
		Operator:   operator,
		AfterJSON: map[string]any{
			"report_month":   month,
			"country":        country,
			"incoming_items": len(body.Items),
		},
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, CommissionRecordsResponse{
		ReportMonth: month,
		Items:       items,
	})
}

func (h *Handler) UpdateCommissionRecordPayment(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	recordID, ok := parsePathID(w, r, "record_id")
	if !ok {
		return
	}
	var body UpdateCommissionPaymentStatusRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	if !validRecordPaymentStatus(body.PaymentStatus) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "payment_status must be paid or unpaid")
		return
	}
	mutation, err := h.store.UpdateCommissionRecordPayment(
		r.Context(),
		recordID,
		body.PaymentStatus,
		h.now(),
		operator,
	)
	if errors.Is(err, ErrNotFound) || (err == nil && mutation.After == nil) {
		httpapi.WriteDetail(w, http.StatusNotFound, "record not found")
		return
	}
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if !h.logAction(r, audit.Entry{
		Action:     "commission.bonus_record.payment_status.update",
		TargetType: "commission_bonus_record",
		TargetID:   int64Pointer(recordID),
		Operator:   operator,
		BeforeJSON: mutation.Before,
		AfterJSON:  mutation.After,
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, UpdateCommissionPaymentStatusResponse{
		Item: *mutation.After,
	})
}

func validateCommissionRecordUpsertItem(item *CommissionRecordUpsertItem) string {
	item.ProjectName = strings.TrimSpace(item.ProjectName)
	item.PersonName = strings.TrimSpace(item.PersonName)
	item.IncomeCategory = strings.ToLower(strings.TrimSpace(item.IncomeCategory))
	item.BonusRatioSource = strings.ToLower(strings.TrimSpace(item.BonusRatioSource))
	if item.ProjectID <= 0 {
		return "project_id must be greater than 0"
	}
	if !validTextLength(item.ProjectName, 1, 255) {
		return "project_name must contain 1 to 255 characters"
	}
	if !validTextLength(item.PersonName, 1, 255) {
		return "person_name must contain 1 to 255 characters"
	}
	if !validIncomeCategory(item.IncomeCategory) {
		return "income_category must be operator or assistant"
	}
	if item.BonusRatioSource == "" {
		item.BonusRatioSource = "rule"
	}
	if !validRatioSource(item.BonusRatioSource) {
		return "bonus_ratio_source must be rule or manual"
	}
	if !finiteNonNegative(item.IncomeTotalUSD) {
		return "income_total_usd must be greater than or equal to 0"
	}
	if !validUnitRate(item.FactoryCommissionRate) {
		return "factory_commission_rate must be between 0 and 1"
	}
	if !validUnitRate(item.OperatorBonusRatio) {
		return "operator_bonus_ratio must be between 0 and 1"
	}
	if !finiteNonNegative(item.BonusAmountUSD) {
		return "bonus_amount_usd must be greater than or equal to 0"
	}
	if !finiteNonNegative(item.USDToRMBRate) {
		return "usd_to_rmb_rate must be greater than or equal to 0"
	}
	if !finiteNonNegative(item.BonusAmountRMB) {
		return "bonus_amount_rmb must be greater than or equal to 0"
	}
	if item.ManualBonusRatio != nil && !validUnitRate(*item.ManualBonusRatio) {
		return "manual_bonus_ratio must be between 0 and 1"
	}
	return ""
}

func validUnitRate(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= 1
}

func nullableString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
