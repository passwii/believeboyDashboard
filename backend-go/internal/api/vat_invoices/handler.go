package vat_invoices

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Handler struct {
	store   Store
	auditor audit.Service
}

func NewHandler(store Store, auditor audit.Service) *Handler {
	return &Handler{store: store, auditor: auditor}
}

// ---------------------------------------------------------------------------
// Entity Endpoints
// ---------------------------------------------------------------------------

func (h *Handler) ListEntities(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	projectIDStr := r.URL.Query().Get("project_id")
	projectID, err := strconv.ParseInt(projectIDStr, 10, 64)
	if err != nil || projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than 0")
		return
	}

	if !identity.IsAdmin {
		if err := h.store.VerifyProjectAccess(r.Context(), projectID, identity.Operator, false); err != nil {
			if errors.Is(err, ErrProjectNotFound) {
				httpapi.WriteDetail(w, http.StatusNotFound, "project not found")
				return
			}
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
	}

	rows, err := h.store.ListEntities(r.Context(), projectID)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if rows == nil {
		rows = []VatEntityResponse{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, rows)
}

func (h *Handler) CreateEntity(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	var payload VatEntityCreate
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid JSON payload")
		return
	}

	if payload.ProjectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than 0")
		return
	}
	if len(strings.TrimSpace(payload.Country)) != 2 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "country must be 2 characters")
		return
	}
	if strings.TrimSpace(payload.CompanyName) == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "company_name is required")
		return
	}

	if !identity.IsAdmin {
		if err := h.store.VerifyProjectAccess(r.Context(), payload.ProjectID, identity.Operator, false); err != nil {
			if errors.Is(err, ErrProjectNotFound) {
				httpapi.WriteDetail(w, http.StatusNotFound, "project not found")
				return
			}
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
	}

	if err := h.store.EnsureVatEnabled(r.Context(), payload.ProjectID); err != nil {
		if errors.Is(err, ErrProjectNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "project not found")
			return
		}
		if errors.Is(err, ErrVatNotEnabled) {
			httpapi.WriteDetail(w, http.StatusForbidden, "VAT feature is not enabled for this project")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	row, err := h.store.UpsertEntity(r.Context(), payload)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if h.auditor != nil {
		targetID := strconv.FormatInt(row.ID, 10)
		entry := audit.Entry{
			Action:     "vat_entities.upsert",
			TargetType: "vat_entity",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON:  payload,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		_ = h.auditor.LogAction(r.Context(), entry)
	}

	_ = httpapi.WriteJSON(w, http.StatusCreated, row)
}

func (h *Handler) UpdateEntity(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	entityID, err := strconv.ParseInt(chi.URLParam(r, "entity_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid entity_id")
		return
	}

	existing, err := h.store.GetEntity(r.Context(), entityID)
	if err != nil {
		if errors.Is(err, ErrVatEntityNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "vat entity not found")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if !identity.IsAdmin {
		if err := h.store.VerifyProjectAccess(r.Context(), existing.ProjectID, identity.Operator, false); err != nil {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
	}

	if err := h.store.EnsureVatEnabled(r.Context(), existing.ProjectID); err != nil {
		if errors.Is(err, ErrVatNotEnabled) {
			httpapi.WriteDetail(w, http.StatusForbidden, "VAT feature is not enabled for this project")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	var payload VatEntityUpdate
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid JSON payload")
		return
	}

	updated, err := h.store.UpdateEntity(r.Context(), entityID, payload)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if h.auditor != nil {
		targetID := strconv.FormatInt(entityID, 10)
		entry := audit.Entry{
			Action:     "vat_entities.update",
			TargetType: "vat_entity",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON:  payload,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		_ = h.auditor.LogAction(r.Context(), entry)
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, updated)
}

func (h *Handler) DeleteEntity(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	entityID, err := strconv.ParseInt(chi.URLParam(r, "entity_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid entity_id")
		return
	}

	existing, err := h.store.GetEntity(r.Context(), entityID)
	if err != nil {
		if errors.Is(err, ErrVatEntityNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "vat entity not found")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if !identity.IsAdmin {
		if err := h.store.VerifyProjectAccess(r.Context(), existing.ProjectID, identity.Operator, false); err != nil {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
	}

	if err := h.store.EnsureVatEnabled(r.Context(), existing.ProjectID); err != nil {
		if errors.Is(err, ErrVatNotEnabled) {
			httpapi.WriteDetail(w, http.StatusForbidden, "VAT feature is not enabled for this project")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if err := h.store.DeleteEntity(r.Context(), entityID); err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if h.auditor != nil {
		targetID := strconv.FormatInt(entityID, 10)
		entry := audit.Entry{
			Action:     "vat_entities.delete",
			TargetType: "vat_entity",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		_ = h.auditor.LogAction(r.Context(), entry)
	}

	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Invoice Endpoints
// ---------------------------------------------------------------------------

func (h *Handler) ListInvoices(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	q := r.URL.Query()
	var projectID *int64
	if pidStr := q.Get("project_id"); pidStr != "" {
		if pid, err := strconv.ParseInt(pidStr, 10, 64); err == nil && pid > 0 {
			projectID = &pid
		}
	}

	if projectID != nil && !identity.IsAdmin {
		if err := h.store.VerifyProjectAccess(r.Context(), *projectID, identity.Operator, false); err != nil {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
	}

	limit := 100
	if l, err := strconv.Atoi(q.Get("limit")); err == nil && l >= 1 {
		limit = min(l, 500)
	}
	offset := 0
	if o, err := strconv.Atoi(q.Get("offset")); err == nil && o >= 0 {
		offset = o
	}

	var statusPtr, qPtr, dateFromPtr, dateToPtr *string
	if s := q.Get("status"); s != "" {
		statusPtr = &s
	}
	if queryVal := q.Get("q"); queryVal != "" {
		qPtr = &queryVal
	}
	if df := q.Get("date_from"); df != "" {
		dateFromPtr = &df
	}
	if dt := q.Get("date_to"); dt != "" {
		dateToPtr = &dt
	}

	filter := VatInvoiceFilter{
		ProjectID: projectID,
		Status:    statusPtr,
		Q:         qPtr,
		DateFrom:  dateFromPtr,
		DateTo:    dateToPtr,
		Limit:     limit,
		Offset:    offset,
		Operator:  identity.Operator,
		IsAdmin:   identity.IsAdmin,
	}

	items, err := h.store.ListInvoices(r.Context(), filter)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if items == nil {
		items = []VatInvoiceListItem{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, items)
}

func (h *Handler) CreateInvoice(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	var payload VatInvoiceCreate
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid JSON payload")
		return
	}

	if payload.ProjectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than 0")
		return
	}
	if len(payload.Lines) == 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "lines must not be empty")
		return
	}
	if len(payload.Currency) != 3 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "currency must be 3 characters")
		return
	}

	if !identity.IsAdmin {
		if err := h.store.VerifyProjectAccess(r.Context(), payload.ProjectID, identity.Operator, false); err != nil {
			if errors.Is(err, ErrProjectNotFound) {
				httpapi.WriteDetail(w, http.StatusNotFound, "project not found")
				return
			}
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
	}

	if err := h.store.EnsureVatEnabled(r.Context(), payload.ProjectID); err != nil {
		if errors.Is(err, ErrProjectNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "project not found")
			return
		}
		if errors.Is(err, ErrVatNotEnabled) {
			httpapi.WriteDetail(w, http.StatusForbidden, "VAT feature is not enabled for this project")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	createdBy := identity.Operator
	if createdBy == "" {
		createdBy = "system"
	}

	inv, err := h.store.CreateInvoice(r.Context(), payload, createdBy)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if h.auditor != nil {
		targetID := strconv.FormatInt(inv.ID, 10)
		entry := audit.Entry{
			Action:     "vat_invoices.create",
			TargetType: "vat_invoice",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON: map[string]any{
				"invoice_no": inv.InvoiceNo,
				"status":     inv.Status,
				"total_incl": inv.TotalIncl,
			},
			Result: "success",
		}
		entry.PopulateFromRequest(r)
		_ = h.auditor.LogAction(r.Context(), entry)
	}

	_ = httpapi.WriteJSON(w, http.StatusCreated, inv)
}

func (h *Handler) GetInvoice(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	invoiceID, err := strconv.ParseInt(chi.URLParam(r, "invoice_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid invoice_id")
		return
	}

	inv, err := h.store.GetInvoice(r.Context(), invoiceID)
	if err != nil {
		if errors.Is(err, ErrVatInvoiceNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "vat invoice not found")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if !identity.IsAdmin {
		if err := h.store.VerifyProjectAccess(r.Context(), inv.ProjectID, identity.Operator, false); err != nil {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, inv)
}

func (h *Handler) UploadInvoicePdf(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	invoiceID, err := strconv.ParseInt(chi.URLParam(r, "invoice_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid invoice_id")
		return
	}

	inv, err := h.store.GetInvoice(r.Context(), invoiceID)
	if err != nil {
		if errors.Is(err, ErrVatInvoiceNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "vat invoice not found")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if !identity.IsAdmin {
		if err := h.store.VerifyProjectAccess(r.Context(), inv.ProjectID, identity.Operator, false); err != nil {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
	}

	if err := h.store.EnsureVatEnabled(r.Context(), inv.ProjectID); err != nil {
		if errors.Is(err, ErrVatNotEnabled) {
			httpapi.WriteDetail(w, http.StatusForbidden, "VAT feature is not enabled for this project")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	var payload VatInvoicePdfUploadRequest
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid JSON payload")
		return
	}

	pdfBytes, err := base64.StdEncoding.DecodeString(payload.PdfBase64)
	if err != nil || len(pdfBytes) == 0 {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid pdf_base64")
		return
	}

	resp, err := h.store.AttachInvoicePdf(r.Context(), invoiceID, payload.Filename, pdfBytes)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if h.auditor != nil {
		targetID := strconv.FormatInt(invoiceID, 10)
		entry := audit.Entry{
			Action:     "vat_invoices.upload_pdf",
			TargetType: "vat_invoice",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON:  map[string]any{"r2_key": resp.R2Key},
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		_ = h.auditor.LogAction(r.Context(), entry)
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetInvoicePdf(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	invoiceID, err := strconv.ParseInt(chi.URLParam(r, "invoice_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid invoice_id")
		return
	}

	inv, err := h.store.GetInvoice(r.Context(), invoiceID)
	if err != nil {
		if errors.Is(err, ErrVatInvoiceNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "vat invoice not found")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if !identity.IsAdmin {
		if err := h.store.VerifyProjectAccess(r.Context(), inv.ProjectID, identity.Operator, false); err != nil {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
	}

	if inv.R2URL == nil || *inv.R2URL == "" {
		httpapi.WriteDetail(w, http.StatusConflict, "invoice has no pdf yet")
		return
	}

	http.Redirect(w, r, *inv.R2URL, http.StatusFound)
}

func (h *Handler) VoidInvoice(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	invoiceID, err := strconv.ParseInt(chi.URLParam(r, "invoice_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid invoice_id")
		return
	}

	inv, err := h.store.GetInvoice(r.Context(), invoiceID)
	if err != nil {
		if errors.Is(err, ErrVatInvoiceNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "vat invoice not found")
			return
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if !identity.IsAdmin {
		if err := h.store.VerifyProjectAccess(r.Context(), inv.ProjectID, identity.Operator, false); err != nil {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
	}

	var payload VatInvoiceVoidRequest
	_ = json.NewDecoder(r.Body).Decode(&payload)

	voided, err := h.store.VoidInvoice(r.Context(), invoiceID, payload.Reason)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if h.auditor != nil {
		targetID := strconv.FormatInt(invoiceID, 10)
		entry := audit.Entry{
			Action:     "vat_invoices.void",
			TargetType: "vat_invoice",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON:  map[string]any{"reason": payload.Reason},
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		_ = h.auditor.LogAction(r.Context(), entry)
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, voided)
}
