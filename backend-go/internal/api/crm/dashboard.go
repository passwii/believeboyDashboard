package crm

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

func (handler *Handler) GetDashboardStats(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if err := RequireAdmin(identity); err != nil {
		WriteError(w, err)
		return
	}
	result, err := handler.store.GetDashboardStats(r.Context())
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (handler *Handler) GetFunnelMetrics(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if err := RequireAdmin(identity); err != nil {
		WriteError(w, err)
		return
	}
	dimension := strings.TrimSpace(r.URL.Query().Get("dimension"))
	if dimension != "owner" && dimension != "source" && dimension != "time" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "dimension must be owner, source, or time")
		return
	}
	startAt, err := parseTimeQuery(r, "start_at")
	if err != nil {
		WriteError(w, err)
		return
	}
	endAt, err := parseTimeQuery(r, "end_at")
	if err != nil {
		WriteError(w, err)
		return
	}
	result, err := handler.store.GetFunnelMetrics(
		r.Context(),
		dimension,
		startAt,
		endAt,
		optionalString(r.URL.Query().Get("owner_id")),
		optionalString(r.URL.Query().Get("source")),
	)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (handler *Handler) GetFunnelStageDetail(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if err := RequireAdmin(identity); err != nil {
		WriteError(w, err)
		return
	}
	stage := strings.TrimSpace(chiURLParam(r, "stage"))
	switch stage {
	case "new", "contacting", "qualified", "converted", "discarded":
	default:
		httpapi.WriteDetail(w, http.StatusBadRequest, "unknown stage: "+stage)
		return
	}
	sortBy := strings.TrimSpace(r.URL.Query().Get("sort_by"))
	if sortBy == "" {
		sortBy = "dwell"
	}
	if sortBy != "dwell" && sortBy != "recent" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "sort_by must be dwell or recent")
		return
	}
	stuckDays := 7
	if raw := strings.TrimSpace(r.URL.Query().Get("stuck_days")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 365 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "stuck_days must be between 1 and 365")
			return
		}
		stuckDays = value
	}
	startAt, err := parseTimeQuery(r, "start_at")
	if err != nil {
		WriteError(w, err)
		return
	}
	endAt, err := parseTimeQuery(r, "end_at")
	if err != nil {
		WriteError(w, err)
		return
	}
	page, pageSize, err := parsePage(r, 50, maxTaskPageSize)
	if err != nil {
		WriteError(w, err)
		return
	}
	result, err := handler.store.GetStageDetail(
		r.Context(),
		stage,
		sortBy,
		stuckDays,
		startAt,
		endAt,
		optionalString(r.URL.Query().Get("owner_id")),
		optionalString(r.URL.Query().Get("source")),
		page,
		pageSize,
	)
	if err != nil {
		WriteError(w, err)
		return
	}
	result.Leads = ensureSlice(result.Leads)
	writeJSON(w, http.StatusOK, result)
}

func (handler *Handler) GetPerformanceBoard(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	scope := strings.TrimSpace(r.URL.Query().Get("scope"))
	if scope == "" {
		scope = "mine"
	}
	if scope != "mine" && scope != "all" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "scope must be mine or all")
		return
	}
	if scope == "all" {
		if err := RequireAdmin(identity); err != nil {
			WriteError(w, err)
			return
		}
	}
	sortBy := strings.TrimSpace(r.URL.Query().Get("sort_by"))
	if sortBy == "" {
		sortBy = "converted_count"
	}
	switch sortBy {
	case "converted_count", "new_customers", "follow_count", "completion_rate":
	default:
		httpapi.WriteDetail(w, http.StatusBadRequest, "sort_by 须为 converted_count/new_customers/follow_count/completion_rate 之一")
		return
	}
	month := optionalString(r.URL.Query().Get("month"))
	if month != nil {
		if _, _, err := timeMonthRange(*month); err != nil {
			WriteError(w, err)
			return
		}
	}
	result, err := handler.store.GetPerformanceBoard(r.Context(), scope, sortBy, month, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	result.Ranking = ensureSlice(result.Ranking)
	writeJSON(w, http.StatusOK, result)
}

func (handler *Handler) GetLifecycleBoard(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if err := RequireAdmin(identity); err != nil {
		WriteError(w, err)
		return
	}
	result, err := handler.store.GetLifecycleBoard(r.Context())
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
