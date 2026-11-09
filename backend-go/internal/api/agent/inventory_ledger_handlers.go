package agent

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (h *Handler) ListInventoryLedgerMonths(w http.ResponseWriter, r *http.Request) {
	if h.stores.Ledger == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	resp, err := h.stores.Ledger.ListMonths(r.Context(), projectID, ledgerCountry(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, resp, "")
}

func (h *Handler) GetInventoryLedgerSnapshot(w http.ResponseWriter, r *http.Request) {
	if h.stores.Ledger == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	resp, err := h.stores.Ledger.GetSnapshot(
		r.Context(),
		projectID,
		ledgerCountry(r),
		ledgerPeriod(r, h.options.now()),
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, resp, "")
}

func (h *Handler) GetInventoryLedgerEvents(w http.ResponseWriter, r *http.Request) {
	if h.stores.Ledger == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	resp, err := h.stores.Ledger.GetEvents(
		r.Context(),
		projectID,
		ledgerCountry(r),
		ledgerPeriod(r, h.options.now()),
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, resp, "")
}

func (h *Handler) GetInventoryLedgerReceiptClusters(w http.ResponseWriter, r *http.Request) {
	if h.stores.Ledger == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	resp, err := h.stores.Ledger.GetClusters(
		r.Context(),
		projectID,
		ledgerCountry(r),
		ledgerPeriod(r, h.options.now()),
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, resp, "")
}

func (h *Handler) GetInventoryLedgerLocationDetail(w http.ResponseWriter, r *http.Request) {
	if h.stores.Ledger == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	resp, err := h.stores.Ledger.GetLocationDetail(
		r.Context(),
		projectID,
		ledgerCountry(r),
		ledgerPeriod(r, h.options.now()),
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, resp, "")
}

func (h *Handler) GetInventoryLedgerIntegrity(w http.ResponseWriter, r *http.Request) {
	if h.stores.Ledger == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	snapshot, err := h.stores.Ledger.GetSnapshot(
		r.Context(),
		projectID,
		ledgerCountry(r),
		ledgerPeriod(r, h.options.now()),
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if snapshot.Integrity == nil {
		writeOK(w, map[string]any{
			"report_month": snapshot.ReportMonth,
			"status":       "PENDING",
		}, "")
		return
	}
	writeOK(w, snapshot.Integrity, "")
}

func (h *Handler) GetInventoryLedgerTrend(w http.ResponseWriter, r *http.Request) {
	if h.stores.Ledger == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	resp, err := h.stores.Ledger.GetTrend(r.Context(), projectID, ledgerCountry(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if rawMonths := strings.TrimSpace(r.URL.Query().Get("months")); rawMonths != "" {
		if count, err := strconv.Atoi(rawMonths); err == nil && count > 0 && count < len(resp.Months) {
			resp.Months = resp.Months[len(resp.Months)-count:]
		}
	}
	writeOK(w, resp, "")
}

func (h *Handler) GetInventoryLedgerDetail(w http.ResponseWriter, r *http.Request) {
	if h.stores.Ledger == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	resp, err := h.stores.Ledger.GetDetail(
		r.Context(),
		projectID,
		ledgerCountry(r),
		ledgerPeriod(r, h.options.now()),
		optionalStringQuery(r, "msku"),
		optionalStringQuery(r, "event_type"),
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, resp, "")
}

func (h *Handler) GetInventoryLedgerSummary(w http.ResponseWriter, r *http.Request) {
	if h.stores.Ledger == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	resp, err := h.stores.Ledger.GetSummary(
		r.Context(),
		projectID,
		ledgerCountry(r),
		ledgerPeriod(r, h.options.now()),
		optionalStringQuery(r, "msku"),
		optionalStringQuery(r, "disposition"),
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, resp, "")
}

func (h *Handler) GetInventoryLedgerBatches(w http.ResponseWriter, r *http.Request) {
	if h.stores.Ledger == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	resp, err := h.stores.Ledger.ListBatches(r.Context(), projectID, ledgerCountry(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if rawLimit := strings.TrimSpace(r.URL.Query().Get("limit")); rawLimit != "" {
		if limit, err := strconv.Atoi(rawLimit); err == nil && limit > 0 && limit < len(resp.Batches) {
			resp.Batches = resp.Batches[:limit]
		}
	}
	writeOK(w, resp, "")
}

func (h *Handler) GetInventoryLedgerConsistency(w http.ResponseWriter, r *http.Request) {
	if h.stores.Ledger == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	resp, err := h.stores.Ledger.GetConsistency(
		r.Context(),
		projectID,
		ledgerCountry(r),
		ledgerPeriod(r, h.options.now()),
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, resp, "")
}

func ledgerCountry(r *http.Request) *string {
	value := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("country")))
	if value == "" {
		return nil
	}
	return &value
}

func ledgerPeriod(r *http.Request, now time.Time) string {
	period := strings.TrimSpace(r.URL.Query().Get("period"))
	if period == "" {
		period = strings.TrimSpace(r.URL.Query().Get("month"))
	}
	if period == "" {
		period = now.Format("2006-01")
	}
	return period
}
