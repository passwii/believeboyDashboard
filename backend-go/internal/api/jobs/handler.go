package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const maxJobBodyBytes = 1 << 20

type Store interface {
	CreateJob(context.Context, CreateInput, *string) (Job, error)
	GetJob(context.Context, int64) (*Job, error)
	ListRuns(context.Context, int64) ([]JobRun, error)
	LatestRun(context.Context, int64) (*JobRun, error)
	MarkEnqueueFailed(context.Context, int64, string) error
}

// JobEnqueuer is intentionally transport-agnostic so the gateway can use Asynq,
// Redis, or another queue without making this domain import queue internals.
type JobEnqueuer interface {
	EnqueueJob(context.Context, int64) error
}

type Handler struct {
	store      Store
	enqueuer   JobEnqueuer
	resultRoot string
	auditor    audit.Service
}

func NewHandler(store Store, enqueuer JobEnqueuer, resultRoot string, auditor audit.Service) *Handler {
	return &Handler{
		store:      store,
		enqueuer:   enqueuer,
		resultRoot: resultRoot,
		auditor:    auditor,
	}
}

func (handler *Handler) Create(w http.ResponseWriter, r *http.Request) {
	var payload CreateRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxJobBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	payload.JobType = strings.TrimSpace(payload.JobType)
	payload.FileID = strings.TrimSpace(payload.FileID)
	if payload.JobType == "" || len([]rune(payload.JobType)) > 128 || payload.FileID == "" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "job_type and file_id are required")
		return
	}
	if payload.Params == nil {
		payload.Params = map[string]any{}
	}
	if handler.enqueuer == nil {
		handler.auditFailure(r, "jobs.create", "job", nil, ErrEnqueuerNotConfigured())
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Job queue is not configured")
		return
	}

	identity, _ := auth.UserContextFromContext(r.Context())
	operator := optionalString(identity.Operator)
	job, err := handler.store.CreateJob(r.Context(), CreateInput{
		JobType: payload.JobType,
		FileID:  payload.FileID,
		Params:  payload.Params,
	}, operator)
	if err != nil {
		writeError(w, err)
		return
	}
	if err := handler.enqueuer.EnqueueJob(r.Context(), job.ID); err != nil {
		_ = handler.store.MarkEnqueueFailed(r.Context(), job.ID, err.Error())
		handler.auditFailure(r, "jobs.create", "job", &job.ID, err)
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Job queue unavailable")
		return
	}
	handler.auditSuccess(r, "jobs.create", "job", job.ID, job)
	_ = httpapi.WriteJSON(w, http.StatusOK, job)
}

func (handler *Handler) Get(w http.ResponseWriter, r *http.Request) {
	jobID, ok := parseJobID(w, r)
	if !ok {
		return
	}
	job, err := handler.store.GetJob(r.Context(), jobID)
	if err != nil {
		writeError(w, err)
		return
	}
	runs, err := handler.store.ListRuns(r.Context(), jobID)
	if err != nil {
		writeError(w, err)
		return
	}
	if runs == nil {
		runs = []JobRun{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, Detail{Job: *job, Runs: runs})
}

func (handler *Handler) DownloadResult(w http.ResponseWriter, r *http.Request) {
	jobID, ok := parseJobID(w, r)
	if !ok {
		return
	}
	job, err := handler.store.GetJob(r.Context(), jobID)
	if err != nil {
		writeError(w, err)
		return
	}
	if job.Status != "success" {
		httpapi.WriteDetail(w, http.StatusConflict, "Job not finished")
		return
	}
	run, err := handler.store.LatestRun(r.Context(), jobID)
	if err != nil {
		writeError(w, err)
		return
	}
	if run == nil || run.ResultPath == nil || strings.TrimSpace(*run.ResultPath) == "" {
		httpapi.WriteDetail(w, http.StatusNotFound, "Result not found")
		return
	}
	resolved, err := ResolveResultPath(handler.resultRoot, *run.ResultPath)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Result file missing")
		return
	}
	info, err := osStatRegular(resolved)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Result file missing")
		return
	}
	contentType := mime.TypeByExtension(filepath.Ext(resolved))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`, info.Name()))
	http.ServeFile(w, r, resolved)
}

func parseJobID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	raw := strings.TrimSpace(chi.URLParam(r, "job_id"))
	jobID, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || jobID <= 0 {
		httpapi.WriteDetail(w, http.StatusBadRequest, "job_id must be a positive integer")
		return 0, false
	}
	return jobID, true
}

func writeError(w http.ResponseWriter, err error) {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		httpapi.WriteDetail(w, apiErr.Status, apiErr.Detail)
		return
	}
	httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
}

func (handler *Handler) auditSuccess(
	r *http.Request,
	action string,
	targetType string,
	targetID int64,
	after any,
) {
	if handler.auditor == nil {
		return
	}
	id := strconv.FormatInt(targetID, 10)
	identity, _ := auth.UserContextFromContext(r.Context())
	entry := audit.Entry{
		Action: action, TargetType: targetType, TargetID: &id,
		Operator: optionalString(identity.Operator), Result: "success", AfterJSON: after,
	}
	entry.PopulateFromRequest(r)
	_ = handler.auditor.LogAction(r.Context(), entry)
}

func (handler *Handler) auditFailure(
	r *http.Request,
	action string,
	targetType string,
	targetID *int64,
	err error,
) {
	if handler.auditor == nil {
		return
	}
	var id *string
	if targetID != nil {
		value := strconv.FormatInt(*targetID, 10)
		id = &value
	}
	message := err.Error()
	identity, _ := auth.UserContextFromContext(r.Context())
	entry := audit.Entry{
		Action: action, TargetType: targetType, TargetID: id,
		Operator: optionalString(identity.Operator), Result: "failure",
		ErrorMessage: &message,
	}
	entry.PopulateFromRequest(r)
	_ = handler.auditor.LogAction(r.Context(), entry)
}

func optionalString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}
