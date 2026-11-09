package pricing_calculation_snapshots

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
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

type transactionRunner interface {
	RunInTx(
		ctx context.Context,
		fn func(context.Context, pgx.Tx, Store) error,
	) error
}

func (h *Handler) writeAccessError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrProjectNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
	case errors.Is(err, ErrProjectForbidden):
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
	case errors.Is(err, ErrNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "快照不存在")
	case errors.Is(err, ErrSourceEmpty):
		httpapi.WriteDetail(w, http.StatusNotFound, "没有可快照的核算记录")
	default:
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
	}
}

func (h *Handler) checkProjectAccess(w http.ResponseWriter, r *http.Request, projectID int64) bool {
	identity, _ := auth.UserContextFromContext(r.Context())
	if projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than zero")
		return false
	}
	if err := h.store.VerifyProjectAccess(r.Context(), projectID, identity.Operator, identity.IsAdmin); err != nil {
		h.writeAccessError(w, err)
		return false
	}
	return true
}

func (h *Handler) checkSnapshotAccess(w http.ResponseWriter, r *http.Request, snapshotID int64) bool {
	projectID, err := h.store.ProjectID(r.Context(), snapshotID)
	if err != nil {
		h.writeAccessError(w, err)
		return false
	}
	return h.checkProjectAccess(w, r, projectID)
}

func (h *Handler) auditTx(
	ctx context.Context,
	r *http.Request,
	tx pgx.Tx,
	entry audit.Entry,
) error {
	if h.auditor == nil {
		return errors.New("audit service is nil")
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	entry.Operator = stringPtr(strings.TrimSpace(identity.Operator))
	entry.Result = "success"
	entry.PopulateFromRequest(r)
	return h.auditor.LogActionTx(ctx, tx, entry)
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	projectID, err := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("project_id")), 10, 64)
	if err != nil || projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than zero")
		return
	}
	if !h.checkProjectAccess(w, r, projectID) {
		return
	}
	country, ok := snapshotCountry(w, r.URL.Query().Get("country"))
	if !ok {
		return
	}
	page, ok := snapshotQueryInt(w, r, "page", 1, 1, int(^uint(0)>>1))
	if !ok {
		return
	}
	pageSize, ok := snapshotQueryInt(w, r, "page_size", 50, 1, 100)
	if !ok {
		return
	}
	items, err := h.store.List(r.Context(), projectID, country, page, pageSize)
	if err != nil {
		h.writeAccessError(w, err)
		return
	}
	if items == nil {
		items = []SnapshotListItem{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, items)
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	snapshotID, err := parseID(chi.URLParam(r, "snapshot_id"))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid snapshot_id")
		return
	}
	if !h.checkSnapshotAccess(w, r, snapshotID) {
		return
	}
	detail, err := h.store.Get(r.Context(), snapshotID)
	if err != nil {
		h.writeAccessError(w, err)
		return
	}
	if detail == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "快照不存在")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, detail)
}

func (h *Handler) GetItems(w http.ResponseWriter, r *http.Request) {
	snapshotID, err := parseID(chi.URLParam(r, "snapshot_id"))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid snapshot_id")
		return
	}
	if !h.checkSnapshotAccess(w, r, snapshotID) {
		return
	}
	items, err := h.store.GetItems(r.Context(), snapshotID)
	if err != nil {
		h.writeAccessError(w, err)
		return
	}
	if items == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "快照不存在")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, items)
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	projectID, err := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("project_id")), 10, 64)
	if err != nil || projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than zero")
		return
	}
	if !h.checkProjectAccess(w, r, projectID) {
		return
	}
	country, ok := snapshotCountry(w, r.URL.Query().Get("country"))
	if !ok {
		return
	}
	var payload *CreateSnapshotRequest
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil && !errors.Is(err, io.EOF) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	var name, description *string
	if payload != nil {
		name = trimOptional(payload.Name)
		description = trimOptional(payload.Description)
	}
	if !validateSnapshotText(w, name, 255, "name") || !validateSnapshotText(w, description, 4000, "description") {
		return
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	var detail *SnapshotDetail
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		snapshotID, createErr := txStore.Create(ctx, projectID, country, name, description, identity.Operator)
		if createErr != nil {
			return createErr
		}
		var getErr error
		detail, getErr = txStore.Get(ctx, snapshotID)
		if getErr != nil {
			return getErr
		}
		if detail == nil {
			return ErrNotFound
		}
		targetID := strconv.FormatInt(snapshotID, 10)
		return h.auditTx(ctx, r, tx, audit.Entry{
			Action:     "pricing_calculation_snapshot.create",
			TargetType: "pricing_calculation_snapshot",
			TargetID:   &targetID,
			AfterJSON: map[string]any{
				"id": snapshotID, "project_id": detail.ProjectID, "country": detail.Country,
				"name": detail.Name, "row_count": detail.RowCount,
			},
		})
	})
	if err != nil {
		h.writeAccessError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusCreated, detail)
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	if !identity.IsAdmin {
		httpapi.WriteDetail(w, http.StatusForbidden, "仅管理员可修改快照")
		return
	}
	snapshotID, err := parseID(chi.URLParam(r, "snapshot_id"))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid snapshot_id")
		return
	}
	var payload UpdateSnapshotRequest
	if err := decodeUpdateSnapshotRequest(r, &payload); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if !validateSnapshotText(w, payload.Name, 255, "name") || !validateSnapshotText(w, payload.Description, 4000, "description") {
		return
	}
	var updated *SnapshotListItem
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		var updateErr error
		updated, updateErr = txStore.Update(
			ctx,
			snapshotID,
			preserveOptional(payload.Name),
			preserveOptional(payload.Description),
			identity.Operator,
		)
		if updateErr != nil {
			return updateErr
		}
		if updated == nil {
			return ErrNotFound
		}
		targetID := strconv.FormatInt(snapshotID, 10)
		return h.auditTx(ctx, r, tx, audit.Entry{
			Action:     "pricing_calculation_snapshot.update",
			TargetType: "pricing_calculation_snapshot",
			TargetID:   &targetID,
			AfterJSON: map[string]any{
				"snapshot_id": snapshotID, "name": updated.Name, "description": updated.Description,
			},
		})
	})
	if err != nil {
		h.writeAccessError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, updated)
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	identity, _ := auth.UserContextFromContext(r.Context())
	if !identity.IsAdmin {
		httpapi.WriteDetail(w, http.StatusForbidden, "仅管理员可删除快照")
		return
	}
	snapshotID, err := parseID(chi.URLParam(r, "snapshot_id"))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid snapshot_id")
		return
	}
	var detail *SnapshotDetail
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		var getErr error
		detail, getErr = txStore.Get(ctx, snapshotID)
		if getErr != nil {
			return getErr
		}
		if detail == nil {
			return ErrNotFound
		}
		deleted, deleteErr := txStore.Delete(ctx, snapshotID)
		if deleteErr != nil {
			return deleteErr
		}
		if !deleted {
			return ErrNotFound
		}
		targetID := strconv.FormatInt(snapshotID, 10)
		return h.auditTx(ctx, r, tx, audit.Entry{
			Action:     "pricing_calculation_snapshot.delete",
			TargetType: "pricing_calculation_snapshot",
			TargetID:   &targetID,
			AfterJSON:  map[string]any{"snapshot_id": snapshotID, "project_id": detail.ProjectID},
		})
	})
	if err != nil {
		h.writeAccessError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) runInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, Store) error,
) error {
	runner, ok := h.store.(transactionRunner)
	if !ok {
		return errors.New("pricing calculation snapshot store does not support transactions")
	}
	return runner.RunInTx(ctx, fn)
}

func decodeUpdateSnapshotRequest(r *http.Request, target *UpdateSnapshotRequest) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func parseID(raw string) (int64, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || id <= 0 {
		return 0, fmt.Errorf("invalid id")
	}
	return id, nil
}

func normalizeCountry(raw string) string {
	country := strings.ToUpper(strings.TrimSpace(raw))
	if country == "GB" {
		return "UK"
	}
	return country
}

func snapshotCountry(w http.ResponseWriter, raw string) (string, bool) {
	country := normalizeCountry(raw)
	if country == "" {
		country = "US"
	}
	if len(country) > 8 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "country must contain at most 8 characters")
		return "", false
	}
	return country, true
}

func validateSnapshotText(w http.ResponseWriter, value *string, limit int, field string) bool {
	if value == nil || len([]rune(*value)) <= limit {
		return true
	}
	httpapi.WriteDetail(w, http.StatusUnprocessableEntity, field+" is too long")
	return false
}

func snapshotQueryInt(
	w http.ResponseWriter,
	r *http.Request,
	name string,
	fallback, minimum, maximum int,
) (int, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return fallback, true
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, name+" is out of range")
		return 0, false
	}
	return value, true
}

func trimOptional(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func preserveOptional(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	return &trimmed
}

func stringPtr(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
