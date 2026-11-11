package inventory_ledger

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Handler struct {
	store Store
}

func NewHandler(store Store) *Handler {
	return &Handler{store: store}
}

func (h *Handler) checkAccess(w http.ResponseWriter, r *http.Request, projectID int64) bool {
	if projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Missing or invalid project_id")
		return false
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	if identity.IsAdmin {
		return true
	}
	err := h.store.VerifyProjectAccess(r.Context(), projectID, identity.Operator, identity.IsAdmin)
	if err != nil {
		if errors.Is(err, ErrProjectNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return false
		}
		if errors.Is(err, ErrProjectForbidden) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return false
		}
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return false
	}
	return true
}

func parseProjectAndCountry(r *http.Request) (int64, *string) {
	projectID, _ := strconv.ParseInt(r.URL.Query().Get("project_id"), 10, 64)
	var country *string
	if v := strings.TrimSpace(r.URL.Query().Get("country")); v != "" {
		upper := strings.ToUpper(v)
		country = &upper
	}
	return projectID, country
}

func requirePeriodQuery(w http.ResponseWriter, r *http.Request) bool {
	if strings.TrimSpace(r.URL.Query().Get("period")) == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "period is required")
		return false
	}
	return true
}

func parseMonth(r *http.Request) string {
	m := strings.TrimSpace(r.URL.Query().Get("month"))
	if m == "" {
		m = strings.TrimSpace(r.URL.Query().Get("period"))
	}
	if m == "" {
		m = time.Now().Format("2006-01")
	}
	return m
}

func (h *Handler) ListMonths(w http.ResponseWriter, r *http.Request) {
	projectID, country := parseProjectAndCountry(r)
	if !h.checkAccess(w, r, projectID) {
		return
	}
	resp, err := h.store.ListMonths(r.Context(), projectID, country)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetSnapshot(w http.ResponseWriter, r *http.Request) {
	if !requirePeriodQuery(w, r) {
		return
	}
	projectID, country := parseProjectAndCountry(r)
	if !h.checkAccess(w, r, projectID) {
		return
	}
	month := parseMonth(r)
	resp, err := h.store.GetSnapshot(r.Context(), projectID, country, month)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetEvents(w http.ResponseWriter, r *http.Request) {
	if !requirePeriodQuery(w, r) {
		return
	}
	projectID, country := parseProjectAndCountry(r)
	if !h.checkAccess(w, r, projectID) {
		return
	}
	month := parseMonth(r)
	resp, err := h.store.GetEvents(r.Context(), projectID, country, month)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetClusters(w http.ResponseWriter, r *http.Request) {
	if !requirePeriodQuery(w, r) {
		return
	}
	projectID, country := parseProjectAndCountry(r)
	if !h.checkAccess(w, r, projectID) {
		return
	}
	month := parseMonth(r)
	resp, err := h.store.GetClusters(r.Context(), projectID, country, month)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetLocationDetail(w http.ResponseWriter, r *http.Request) {
	if !requirePeriodQuery(w, r) {
		return
	}
	projectID, country := parseProjectAndCountry(r)
	if !h.checkAccess(w, r, projectID) {
		return
	}
	month := parseMonth(r)
	resp, err := h.store.GetLocationDetail(r.Context(), projectID, country, month)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetTrend(w http.ResponseWriter, r *http.Request) {
	projectID, country := parseProjectAndCountry(r)
	if !h.checkAccess(w, r, projectID) {
		return
	}
	resp, err := h.store.GetTrend(r.Context(), projectID, country)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetDetail(w http.ResponseWriter, r *http.Request) {
	if !requirePeriodQuery(w, r) {
		return
	}
	projectID, country := parseProjectAndCountry(r)
	if !h.checkAccess(w, r, projectID) {
		return
	}
	month := parseMonth(r)
	var msku, eventType *string
	if v := strings.TrimSpace(r.URL.Query().Get("msku")); v != "" {
		msku = &v
	}
	if v := strings.TrimSpace(r.URL.Query().Get("event_type")); v != "" {
		eventType = &v
	}
	resp, err := h.store.GetDetail(r.Context(), projectID, country, month, msku, eventType)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetSummary(w http.ResponseWriter, r *http.Request) {
	if !requirePeriodQuery(w, r) {
		return
	}
	projectID, country := parseProjectAndCountry(r)
	if !h.checkAccess(w, r, projectID) {
		return
	}
	month := parseMonth(r)
	var msku, disposition *string
	if v := strings.TrimSpace(r.URL.Query().Get("msku")); v != "" {
		msku = &v
	}
	if v := strings.TrimSpace(r.URL.Query().Get("disposition")); v != "" {
		disposition = &v
	}
	resp, err := h.store.GetSummary(r.Context(), projectID, country, month, msku, disposition)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) ListBatches(w http.ResponseWriter, r *http.Request) {
	projectID, country := parseProjectAndCountry(r)
	if !h.checkAccess(w, r, projectID) {
		return
	}
	resp, err := h.store.ListBatches(r.Context(), projectID, country)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetConsistency(w http.ResponseWriter, r *http.Request) {
	if !requirePeriodQuery(w, r) {
		return
	}
	projectID, country := parseProjectAndCountry(r)
	if !h.checkAccess(w, r, projectID) {
		return
	}
	month := parseMonth(r)
	resp, err := h.store.GetConsistency(r.Context(), projectID, country, month)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetMonthAnalysis(w http.ResponseWriter, r *http.Request) {
	if !requirePeriodQuery(w, r) {
		return
	}
	projectID, country := parseProjectAndCountry(r)
	if !h.checkAccess(w, r, projectID) {
		return
	}
	month := parseMonth(r)
	resp, err := h.store.GetMonthAnalysis(r.Context(), projectID, country, month)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}
