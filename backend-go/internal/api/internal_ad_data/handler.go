package internal_ad_data

import (
	"errors"
	"fmt"
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

func (h *Handler) checkAccess(w http.ResponseWriter, r *http.Request, projectID int64, identity auth.UserContext) bool {
	err := h.store.VerifyProjectAccess(r.Context(), projectID, identity.Operator, identity.IsAdmin)
	if err != nil {
		if errors.Is(err, ErrProjectNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, fmt.Sprintf("project %d not found", projectID))
			return false
		}
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
		return false
	}
	return true
}

func (h *Handler) GetOverview(w http.ResponseWriter, _ *http.Request) {
	_ = httpapi.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok", "module": "internal_ad_data"})
}

func (h *Handler) ListUploadFiles(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "project_id")
	projectID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || projectID < 1 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid project_id")
		return
	}

	identity, _ := auth.UserContextFromContext(r.Context())
	if !h.checkAccess(w, r, projectID, identity) {
		return
	}

	var reportType *string
	if v := strings.TrimSpace(r.URL.Query().Get("report_type")); v != "" {
		reportType = &v
	}
	var country *string
	if v := strings.TrimSpace(r.URL.Query().Get("country")); v != "" {
		c := strings.ToUpper(v)
		country = &c
	}
	includeHistory := strings.EqualFold(r.URL.Query().Get("include_history"), "true")

	limit := 100
	if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 500 {
			limit = n
		}
	}
	offset := 0
	if v := strings.TrimSpace(r.URL.Query().Get("offset")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			offset = n
		}
	}

	files, err := h.store.ListAdUploadFiles(r.Context(), projectID, reportType, country, includeHistory, limit, offset)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, files)
}

func (h *Handler) QueryRaw(endpoint string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		idStr := chi.URLParam(r, "project_id")
		projectID, err := strconv.ParseInt(idStr, 10, 64)
		if err != nil || projectID < 1 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid project_id")
			return
		}

		identity, _ := auth.UserContextFromContext(r.Context())
		if !h.checkAccess(w, r, projectID, identity) {
			return
		}

		period := strings.TrimSpace(r.URL.Query().Get("period"))
		var startDate *string
		if v := strings.TrimSpace(r.URL.Query().Get("start_date")); v != "" {
			startDate = &v
		}
		var endDate *string
		if v := strings.TrimSpace(r.URL.Query().Get("end_date")); v != "" {
			endDate = &v
		}
		country := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("country")))
		if country == "" {
			country = "US"
		}

		limit := 10000
		if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 50000 {
				limit = n
			}
		}
		offset := 0
		if v := strings.TrimSpace(r.URL.Query().Get("offset")); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n >= 0 {
				offset = n
			}
		}
		orderBy := strings.TrimSpace(r.URL.Query().Get("order_by"))
		if orderBy == "" {
			orderBy = "report_end_date"
		}
		orderDir := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("order_dir")))
		if orderDir != "asc" && orderDir != "desc" {
			orderDir = "desc"
		}

		filter := RawQueryFilter{
			ProjectID: projectID,
			Endpoint:  endpoint,
			Period:    period,
			StartDate: startDate,
			EndDate:   endDate,
			Country:   country,
			Limit:     limit,
			Offset:    offset,
			OrderBy:   orderBy,
			OrderDir:  orderDir,
		}

		resp, err := h.store.QueryRaw(r.Context(), filter)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
			return
		}
		_ = httpapi.WriteJSON(w, http.StatusOK, resp)
	}
}
