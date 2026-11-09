package system_management

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

func (h *Handler) DataManagementStatus(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	snapshot, err := h.store.InspectDataManagement(r.Context())
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if h.databaseURL != "" {
		engine, source := databaseDescription(h.databaseURL)
		snapshot.Database.Engine = engine
		snapshot.Database.Source = source
	}
	h.logView(
		r,
		"system.data_management.status.view",
		"system_management",
		operator,
		map[string]any{
			"data_status":      snapshot.Summary.DataStatus,
			"database_healthy": snapshot.Database.Healthy,
		},
	)
	_ = httpapi.WriteJSON(w, http.StatusOK, DataManagementStatusResponse{
		ServerTime:          snapshot.ServerTime,
		Database:            snapshot.Database,
		CacheEnabled:        false,
		Summary:             snapshot.Summary,
		DataStatusNote:      snapshot.DataStatusNote,
		DataStatusUpdatedAt: snapshot.DataStatusAt,
		DataStatusUpdatedBy: snapshot.DataStatusBy,
	})
}

func (h *Handler) DataManagementOverview(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	snapshot, err := h.store.InspectDataManagement(r.Context())
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if h.databaseURL != "" {
		engine, source := databaseDescription(h.databaseURL)
		snapshot.Database.Engine = engine
		snapshot.Database.Source = source
	}
	tables := snapshot.Tables
	if tables == nil {
		tables = make([]TableStatusItem, 0)
	}
	recent := snapshot.RecentStatuses
	if recent == nil {
		recent = make([]RecentStatusItem, 0)
	}
	h.logView(
		r,
		"system.data_management.overview.view",
		"system_management",
		operator,
		map[string]any{
			"total_tables":        snapshot.Summary.TotalTables,
			"total_rows":          snapshot.Summary.TotalRows,
			"stale_tables":        snapshot.Summary.StaleTables,
			"recent_status_count": len(recent),
		},
	)
	_ = httpapi.WriteJSON(w, http.StatusOK, DataManagementOverviewResponse{
		ServerTime:          snapshot.ServerTime,
		Database:            snapshot.Database,
		CacheEnabled:        false,
		Summary:             snapshot.Summary,
		DataStatusNote:      snapshot.DataStatusNote,
		DataStatusUpdatedAt: snapshot.DataStatusAt,
		DataStatusUpdatedBy: snapshot.DataStatusBy,
		Tables:              tables,
		RecentStatuses:      recent,
	})
}

func (h *Handler) UpdateDataStatus(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	var body UpdateDataStatusRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	if !validDataStatus(body.Status) {
		httpapi.WriteDetail(
			w,
			http.StatusUnprocessableEntity,
			"status must be active, maintenance, read_only, or paused",
		)
		return
	}
	note, valid := normalizedOptionalText(body.Note, 500)
	if !valid {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "note must be at most 500 characters")
		return
	}
	before, err := h.store.GetDataStatus(r.Context())
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	after, err := h.store.SetDataStatus(r.Context(), body.Status, note, operator)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if after.UpdatedAt == nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if !h.logAction(r, audit.Entry{
		Action:     "system.data_status.update",
		TargetType: "system_management_data_state",
		TargetID:   stringPointer("1"),
		Operator:   operator,
		BeforeJSON: before,
		AfterJSON:  after,
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, UpdateDataStatusResponse{
		Status:    after.Status,
		Note:      after.Note,
		UpdatedAt: *after.UpdatedAt,
		UpdatedBy: after.UpdatedBy,
	})
}

func (h *Handler) ClearAllCaches(w http.ResponseWriter, r *http.Request) {
	operator, ok := requireAdminOperator(w, r)
	if !ok {
		return
	}
	if h.cache == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Cache manager unavailable")
		return
	}
	deleted, err := h.cache.ClearAll(r.Context())
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if !h.logAction(r, audit.Entry{
		Action:     "system.cache.clear_all",
		TargetType: "redis_cache",
		TargetID:   stringPointer("all"),
		Operator:   operator,
		AfterJSON:  map[string]any{"deleted_count": deleted},
	}) {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, ClearCacheResponse{
		DeletedCount: deleted,
		Message:      fmt.Sprintf("成功清理 %d 个缓存键", deleted),
	})
}

func databaseDescription(databaseURL string) (string, *string) {
	trimmed := strings.TrimSpace(databaseURL)
	if trimmed == "" {
		return "unknown", nil
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Hostname() == "" {
		return "unknown", nil
	}
	host := parsed.Hostname()
	source := host
	if database := strings.TrimPrefix(parsed.Path, "/"); database != "" {
		source = host + "/" + database
	}
	return host, &source
}
