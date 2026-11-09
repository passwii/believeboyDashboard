package insight_runs

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const maxInsightRunBodyBytes = 768 << 10

var (
	idempotencyPattern  = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,64}$`)
	controlledIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	modelIDPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,63}$`)
)

type Handler struct {
	store    Store
	enqueuer ai_insight.JobEnqueuer
	provider ai.Provider
	events   EventStore
	cfg      Config
}

func NewHandler(store Store, enqueuer ai_insight.JobEnqueuer, provider ai.Provider, events EventStore, cfg Config) *Handler {
	return &Handler{
		store:    store,
		enqueuer: enqueuer,
		provider: provider,
		events:   events,
		cfg:      cfg.normalized(),
	}
}

func (handler *Handler) Create(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeCreateRequest(w, r)
	if !ok {
		return
	}
	identity := requestIdentity(r)
	project, err := handler.store.VerifyProjectAccess(r.Context(), body.ProjectID, identity.Operator, identity.IsAdmin)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if normalizeCountry(project.Country) != body.Country {
		WriteTypedError(w, http.StatusUnprocessableEntity, "COUNTRY_MISMATCH", fmt.Sprintf("Project country is %s, requested %s", normalizeCountry(project.Country), body.Country))
		return
	}
	if handler.provider == nil || !handler.provider.Configured() {
		WriteTypedError(w, http.StatusServiceUnavailable, "PROVIDER_UNAVAILABLE", "Insight AI provider is not configured")
		return
	}
	if handler.enqueuer == nil {
		WriteTypedError(w, http.StatusServiceUnavailable, "PROVIDER_UNAVAILABLE", "Insight job enqueuer is not configured")
		return
	}
	if err := validateRoleSlots(body.RoleID, body.RoleVersion, body.Slots); err != nil {
		var typedErr *validationError
		if errors.As(err, &typedErr) {
			WriteTypedError(w, typedErr.status, typedErr.code, typedErr.message)
		} else {
			WriteTypedError(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", err.Error())
		}
		return
	}
	if err := validateSlotScope(body.ProjectID, body.Country, body.Slots); err != nil {
		var typedErr *validationError
		if errors.As(err, &typedErr) {
			WriteTypedError(w, typedErr.status, typedErr.code, typedErr.message)
		} else {
			WriteTypedError(w, http.StatusUnprocessableEntity, "SCOPE_MISMATCH", err.Error())
		}
		return
	}
	fingerprint, slotsJSON, err := fingerprintRequest(body)
	if err != nil {
		WriteTypedError(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", "Request payload could not be serialized")
		return
	}
	endpointID := "default"
	if body.EndpointID != nil && strings.TrimSpace(*body.EndpointID) != "" {
		endpointID = *body.EndpointID
	}
	modelID := ""
	if body.ModelID != nil {
		modelID = strings.TrimSpace(*body.ModelID)
	}
	run, replayed, err := handler.store.CreateRun(r.Context(), CreateRunInput{
		RoleID:         body.RoleID,
		RoleVersion:    body.RoleVersion,
		ProjectID:      body.ProjectID,
		Country:        body.Country,
		Slots:          body.Slots,
		SlotsJSON:      slotsJSON,
		IdempotencyKey: body.IdempotencyKey,
		Fingerprint:    fingerprint,
		EndpointID:     endpointID,
		ModelID:        modelID,
		Capability:     "insight",
		Operator:       identity.Operator,
	}, ai_insight.MutationMetaFromRequest(r, identity.Operator))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if !replayed {
		if err := handler.enqueuer.EnqueueExecuteRun(r.Context(), ai_insight.ExecuteRunJob{RunID: run.RunID, Attempt: run.Attempt}); err != nil {
			_, _ = handler.store.RunTransition(r.Context(), run.RunID, run.Attempt, "failed", "queued", run.ProgressPercent, nil, nil, nil, &Error{
				Code: "PROVIDER_UNAVAILABLE", Message: "Insight job enqueue failed", Retryable: true,
			})
			WriteTypedError(w, http.StatusServiceUnavailable, "PROVIDER_UNAVAILABLE", "Insight job enqueue failed")
			return
		}
	}
	_ = httpapi.WriteJSON(w, http.StatusCreated, ToRunResponse(run, replayed))
}

func (handler *Handler) Get(w http.ResponseWriter, r *http.Request) {
	run, ok := handler.loadRun(w, r)
	if !ok {
		return
	}
	if !handler.authorizeRun(w, r, run) {
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, ToRunDetail(run))
}

func (handler *Handler) Cancel(w http.ResponseWriter, r *http.Request) {
	run, ok := handler.loadRun(w, r)
	if !ok {
		return
	}
	if !handler.authorizeRun(w, r, run) {
		return
	}
	identity := requestIdentity(r)
	cancelled, replay, err := handler.store.CancelRun(r.Context(), run.RunID, ai_insight.MutationMetaFromRequest(r, identity.Operator))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if handler.events != nil && !replay {
		_, _ = handler.events.Append(r.Context(), cancelled.RunID, Event{
			SchemaVersion: 1,
			RunID:         cancelled.RunID,
			Attempt:       cancelled.Attempt,
			Type:          "error",
			Status:        "cancelled",
			Error:         cancelledError(),
		})
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, ToActionResponse(cancelled, replay))
}

func (handler *Handler) Retry(w http.ResponseWriter, r *http.Request) {
	if handler.enqueuer == nil {
		WriteTypedError(w, http.StatusServiceUnavailable, "PROVIDER_UNAVAILABLE", "Insight job enqueuer is not configured")
		return
	}
	run, ok := handler.loadRun(w, r)
	if !ok {
		return
	}
	if !handler.authorizeRun(w, r, run) {
		return
	}
	identity := requestIdentity(r)
	retried, err := handler.store.RetryRun(r.Context(), run.RunID, ai_insight.MutationMetaFromRequest(r, identity.Operator))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if handler.events != nil {
		_ = handler.events.Reset(r.Context(), retried.RunID)
	}
	if err := handler.enqueuer.EnqueueExecuteRun(r.Context(), ai_insight.ExecuteRunJob{RunID: retried.RunID, Attempt: retried.Attempt}); err != nil {
		_, _ = handler.store.RunTransition(r.Context(), retried.RunID, retried.Attempt, "failed", "queued", 0, nil, nil, nil, &Error{
			Code: "PROVIDER_UNAVAILABLE", Message: "Insight job enqueue failed", Retryable: true,
		})
		WriteTypedError(w, http.StatusServiceUnavailable, "PROVIDER_UNAVAILABLE", "Insight job enqueue failed")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, ToActionResponse(retried, false))
}

func (handler *Handler) Stream(w http.ResponseWriter, r *http.Request) {
	run, ok := handler.loadRun(w, r)
	if !ok {
		return
	}
	if !handler.authorizeRun(w, r, run) {
		return
	}
	if handler.events == nil {
		WriteTypedError(w, http.StatusServiceUnavailable, "PROVIDER_UNAVAILABLE", "Insight stream transport is unavailable; retry shortly")
		return
	}
	if err := handler.events.Available(r.Context()); err != nil {
		WriteTypedError(w, http.StatusServiceUnavailable, "PROVIDER_UNAVAILABLE", "Insight stream transport is unavailable; retry shortly")
		return
	}
	cursor, ok := parseLastEventID(w, r.Header.Get("Last-Event-ID"), run)
	if !ok {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	isResume := cursor != nil
	_ = handler.store.RecordStreamMetric(r.Context(), run.RunID, isResume, false)
	current := ToRunDetail(run)
	lastSent := EventID("", 0, 0)
	terminalSent := false
	syntheticSeq := current.Attempt*1_000_000 + 1

	events, err := handler.events.ReadAfter(r.Context(), run.RunID, cursor)
	if err != nil {
		return
	}
	if len(events) > 0 {
		for _, event := range events {
			if event.Attempt != run.Attempt || event.Attempt < run.Attempt {
				continue
			}
			if event.SchemaVersion == 0 {
				event.SchemaVersion = 1
			}
			if event.RunID == "" {
				event.RunID = run.RunID
			}
			writeSSEEvent(w, event, true)
			lastSent = EventID(event.RunID, event.Attempt, event.Seq)
			if event.Type == "done" || event.Type == "error" {
				terminalSent = true
			}
		}
		flusher.Flush()
		if terminalSent {
			if isResume {
				_ = handler.store.RecordStreamMetric(r.Context(), run.RunID, false, true)
			}
			return
		}
	}
	if cursor == nil && lastSent == EventID("", 0, 0) {
		snapshot := snapshotEvent(current, syntheticSeq)
		writeSSEEvent(w, snapshot, false)
		flusher.Flush()
	}
	if isTerminal(current.Status) {
		terminal := terminalEvent(current, syntheticSeq+1)
		writeSSEEvent(w, terminal, false)
		flusher.Flush()
		if isResume {
			_ = handler.store.RecordStreamMetric(r.Context(), run.RunID, false, true)
		}
		return
	}

	ticker := time.NewTicker(handler.cfg.SSEPollInterval)
	defer ticker.Stop()
	timeout := time.NewTimer(handler.cfg.SSETimeout)
	defer timeout.Stop()
	lastStatus := current.Status
	lastStage := current.Stage
	lastProgress := current.ProgressPercent
	for {
		select {
		case <-r.Context().Done():
			return
		case <-timeout.C:
			seq := syntheticSeq + 10
			writeSSEEvent(w, Event{
				SchemaVersion: 1, RunID: run.RunID, Attempt: run.Attempt, Seq: seq,
				Type: "error", Status: "failed", Error: &Error{Code: "UPSTREAM_TIMEOUT", Message: "Insight stream timed out", Retryable: true},
			}, false)
			flusher.Flush()
			return
		case <-ticker.C:
			fresh, err := handler.store.GetRun(r.Context(), run.RunID)
			if err != nil {
				return
			}
			current = ToRunDetail(fresh)
			if current.Status != lastStatus || current.Stage != lastStage || current.ProgressPercent != lastProgress {
				syntheticSeq++
				if current.Status == "queued" || current.Status == "aggregating" || current.Status == "generating" || current.Status == "finalizing" {
					progress := current.ProgressPercent
					writeSSEEvent(w, Event{
						SchemaVersion: 1, RunID: current.RunID, Attempt: current.Attempt, Seq: syntheticSeq,
						Type: "status", Status: current.Status, Stage: current.Stage, ProgressPercent: &progress,
					}, false)
				}
				lastStatus = current.Status
				lastStage = current.Stage
				lastProgress = current.ProgressPercent
			}
			if events, _ := handler.events.ReadAfter(r.Context(), run.RunID, parseCursorValue(lastSent)); len(events) > 0 {
				for _, event := range events {
					if event.Attempt != current.Attempt {
						continue
					}
					if event.SchemaVersion == 0 {
						event.SchemaVersion = 1
					}
					if event.RunID == "" {
						event.RunID = current.RunID
					}
					writeSSEEvent(w, event, true)
					lastSent = EventID(event.RunID, event.Attempt, event.Seq)
					if event.Type == "done" || event.Type == "error" {
						terminalSent = true
					}
				}
			}
			if isTerminal(current.Status) && !terminalSent {
				syntheticSeq++
				writeSSEEvent(w, terminalEvent(current, syntheticSeq), false)
				terminalSent = true
			}
			if !terminalSent {
				syntheticSeq++
				writeSSEEvent(w, Event{
					SchemaVersion: 1, RunID: current.RunID, Attempt: current.Attempt, Seq: syntheticSeq, Type: "ping",
				}, false)
			}
			flusher.Flush()
			if terminalSent {
				if isResume {
					_ = handler.store.RecordStreamMetric(r.Context(), run.RunID, false, true)
				}
				return
			}
		}
	}
}

func (handler *Handler) loadRun(w http.ResponseWriter, r *http.Request) (*Run, bool) {
	runID := strings.TrimSpace(chi.URLParam(r, "run_id"))
	if err := ValidateRunID(runID); err != nil {
		WriteTypedError(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", "run_id must be a valid UUID")
		return nil, false
	}
	run, err := handler.store.GetRun(r.Context(), runID)
	if err != nil {
		writeStoreError(w, err)
		return nil, false
	}
	return run, true
}

func (handler *Handler) authorizeRun(w http.ResponseWriter, r *http.Request, run *Run) bool {
	identity := requestIdentity(r)
	_, err := handler.store.VerifyProjectAccess(r.Context(), run.ProjectID, identity.Operator, identity.IsAdmin)
	if err != nil {
		writeStoreError(w, err)
		return false
	}
	return true
}

func requestIdentity(r *http.Request) auth.UserContext {
	identity, ok := auth.UserContextFromContext(r.Context())
	if ok {
		return identity
	}
	return auth.UserContextFromRequest(r)
}

func normalizeCountry(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	if value == "GB" {
		return "UK"
	}
	return value
}

type validationError struct {
	status  int
	code    string
	message string
}

func (err *validationError) Error() string { return err.message }

func decodeCreateRequest(w http.ResponseWriter, r *http.Request) (CreateRunRequest, bool) {
	limited := http.MaxBytesReader(w, r.Body, maxInsightRunBodyBytes)
	raw, err := io.ReadAll(limited)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			WriteTypedError(w, http.StatusRequestEntityTooLarge, "REQUEST_TOO_LARGE", "Request body is too large")
		} else {
			WriteTypedError(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", "Request body must be JSON")
		}
		return CreateRunRequest{}, false
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		WriteTypedError(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", "Request body must be a JSON object")
		return CreateRunRequest{}, false
	}
	for _, key := range []string{"system_prompt", "instructions"} {
		if _, present := object[key]; present {
			WriteTypedError(w, http.StatusUnprocessableEntity, "SYSTEM_PROMPT_NOT_ALLOWED", "Client must not submit system prompt or instructions")
			return CreateRunRequest{}, false
		}
	}
	for _, key := range []string{"api_key", "base_url", "provider_url"} {
		if _, present := object[key]; present {
			WriteTypedError(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", "Field "+key+" is not allowed")
			return CreateRunRequest{}, false
		}
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	var request CreateRunRequest
	if err := decoder.Decode(&request); err != nil {
		WriteTypedError(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", "Invalid request body")
		return CreateRunRequest{}, false
	}
	if request.SchemaVersion != 1 {
		WriteTypedError(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", "schema_version must be 1")
		return CreateRunRequest{}, false
	}
	request.Country = normalizeCountry(request.Country)
	if request.Country != "US" && request.Country != "DE" && request.Country != "UK" {
		WriteTypedError(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", "country must be one of US, DE, UK")
		return CreateRunRequest{}, false
	}
	if request.ProjectID <= 0 {
		WriteTypedError(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", "project_id must be a positive integer")
		return CreateRunRequest{}, false
	}
	if request.RoleID == "" || request.RoleVersion <= 0 {
		WriteTypedError(w, http.StatusUnprocessableEntity, "UNKNOWN_ROLE", "role_id and positive role_version are required")
		return CreateRunRequest{}, false
	}
	if !idempotencyPattern.MatchString(request.IdempotencyKey) {
		WriteTypedError(w, http.StatusUnprocessableEntity, "IDEMPOTENCY_KEY_REQUIRED", "idempotency_key is required: ASCII 1-64 chars [A-Za-z0-9._:-]")
		return CreateRunRequest{}, false
	}
	if request.EndpointID != nil && *request.EndpointID != "" && !controlledIDPattern.MatchString(*request.EndpointID) {
		WriteTypedError(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", "endpoint_id is invalid")
		return CreateRunRequest{}, false
	}
	if request.ModelID != nil && *request.ModelID != "" && !modelIDPattern.MatchString(*request.ModelID) {
		WriteTypedError(w, http.StatusUnprocessableEntity, "MODEL_NOT_ALLOWED", "model_id is invalid")
		return CreateRunRequest{}, false
	}
	if request.ClientRequestID != nil && *request.ClientRequestID != "" && !validUUIDText(*request.ClientRequestID) {
		WriteTypedError(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", "client_request_id must be a UUID")
		return CreateRunRequest{}, false
	}
	return request, true
}

func validateRoleSlots(roleID string, version int, slots map[string]any) error {
	type roleSpec struct {
		required []string
		allowed  []string
	}
	specs := map[string]roleSpec{
		"schedule_report_summary": {
			required: []string{"report.context", "report.data"},
			allowed:  []string{"report.context", "report.data", "project.context", "sku.context"},
		},
		"ad_analysis": {
			required: []string{"ad.context", "ad.data"},
			allowed:  []string{"ad.context", "ad.data"},
		},
		"inventory_health": {
			required: []string{"inventory.context", "inventory.data"},
			allowed:  []string{"inventory.context", "inventory.data"},
		},
	}
	spec, ok := specs[roleID]
	if !ok {
		return &validationError{status: http.StatusUnprocessableEntity, code: "UNKNOWN_ROLE", message: "Unknown insight role"}
	}
	if version != 1 {
		return &validationError{status: http.StatusUnprocessableEntity, code: "ROLE_VERSION_UNSUPPORTED", message: "Unsupported insight role version"}
	}
	if slots == nil {
		slots = map[string]any{}
	}
	allowed := make(map[string]bool, len(spec.allowed))
	for _, name := range spec.allowed {
		allowed[name] = true
	}
	for name := range slots {
		if !allowed[name] {
			return &validationError{status: http.StatusUnprocessableEntity, code: "UNKNOWN_SLOT", message: "Unknown slot: " + name}
		}
	}
	for _, name := range spec.required {
		if _, ok := slots[name]; !ok {
			return &validationError{status: http.StatusUnprocessableEntity, code: "MISSING_REQUIRED_SLOT", message: "Missing required slot: " + name}
		}
	}
	for name, value := range slots {
		if err := validateSlotShape(name, value); err != nil {
			return err
		}
	}
	return nil
}

func validateSlotShape(name string, value any) error {
	slot, ok := value.(map[string]any)
	if !ok {
		return &validationError{status: http.StatusUnprocessableEntity, code: "SLOT_VALIDATION_FAILED", message: "Slot " + name + " must be a JSON object"}
	}
	versionValue, ok := slot["slot_version"].(float64)
	if !ok || versionValue != 1 {
		return &validationError{status: http.StatusUnprocessableEntity, code: "SLOT_VALIDATION_FAILED", message: "Slot " + name + " slot_version must be 1"}
	}
	if strings.HasSuffix(name, ".data") {
		if extra := firstUnknownSlotKey(slot, []string{"slot_version", "encoding", "payload"}); extra != "" {
			return &validationError{status: http.StatusUnprocessableEntity, code: "SLOT_VALIDATION_FAILED", message: "Slot " + name + " contains unknown field " + extra}
		}
		if encoding, _ := slot["encoding"].(string); encoding != "json" {
			return &validationError{status: http.StatusUnprocessableEntity, code: "SLOT_VALIDATION_FAILED", message: "Slot " + name + " encoding must be json"}
		}
		if _, ok := slot["payload"].(map[string]any); !ok {
			return &validationError{status: http.StatusUnprocessableEntity, code: "SLOT_VALIDATION_FAILED", message: "Slot " + name + " payload must be a JSON object"}
		}
		return nil
	}
	if name == "project.context" {
		if extra := firstUnknownSlotKey(slot, []string{"slot_version", "projects"}); extra != "" {
			return &validationError{status: http.StatusUnprocessableEntity, code: "SLOT_VALIDATION_FAILED", message: "Slot project.context contains unknown field " + extra}
		}
		if _, ok := slot["projects"].([]any); !ok {
			return &validationError{status: http.StatusUnprocessableEntity, code: "SLOT_VALIDATION_FAILED", message: "Slot project.context projects must be an array"}
		}
		return nil
	}
	if name == "sku.context" {
		if extra := firstUnknownSlotKey(slot, []string{"slot_version", "skus"}); extra != "" {
			return &validationError{status: http.StatusUnprocessableEntity, code: "SLOT_VALIDATION_FAILED", message: "Slot sku.context contains unknown field " + extra}
		}
		if _, ok := slot["skus"].([]any); !ok {
			return &validationError{status: http.StatusUnprocessableEntity, code: "SLOT_VALIDATION_FAILED", message: "Slot sku.context skus must be an array"}
		}
		return nil
	}
	if strings.HasSuffix(name, ".context") {
		allowed := []string{"slot_version", "project_ids", "country", "project_name"}
		switch name {
		case "report.context":
			allowed = append(allowed, "frequency", "report_date", "date_range_start", "date_range_end")
		case "ad.context":
			allowed = append(allowed, "date_range_start", "date_range_end", "data_freshness", "missing_data")
		case "inventory.context":
			allowed = append(allowed, "report_date", "data_freshness", "missing_data")
		}
		if extra := firstUnknownSlotKey(slot, allowed); extra != "" {
			return &validationError{status: http.StatusUnprocessableEntity, code: "SLOT_VALIDATION_FAILED", message: "Slot " + name + " contains unknown field " + extra}
		}
		if _, ok := slot["project_ids"].([]any); !ok {
			return &validationError{status: http.StatusUnprocessableEntity, code: "SLOT_VALIDATION_FAILED", message: "Slot " + name + " project_ids must be an array"}
		}
		if country, _ := slot["country"].(string); country == "" {
			return &validationError{status: http.StatusUnprocessableEntity, code: "SLOT_VALIDATION_FAILED", message: "Slot " + name + " country is required"}
		}
		if name == "ad.context" || name == "inventory.context" {
			if _, ok := slot["data_freshness"].(map[string]any); !ok {
				return &validationError{status: http.StatusUnprocessableEntity, code: "SLOT_VALIDATION_FAILED", message: "Slot " + name + " data_freshness must be an object"}
			}
			if _, ok := slot["missing_data"].(map[string]any); !ok {
				return &validationError{status: http.StatusUnprocessableEntity, code: "SLOT_VALIDATION_FAILED", message: "Slot " + name + " missing_data must be an object"}
			}
		}
		if name == "report.context" {
			if frequency, _ := slot["frequency"].(string); frequency == "" {
				return &validationError{status: http.StatusUnprocessableEntity, code: "SLOT_VALIDATION_FAILED", message: "Slot report.context frequency is required"}
			}
			for _, key := range []string{"report_date", "date_range_start", "date_range_end"} {
				if value, _ := slot[key].(string); value == "" {
					return &validationError{status: http.StatusUnprocessableEntity, code: "SLOT_VALIDATION_FAILED", message: "Slot report.context " + key + " is required"}
				}
			}
		}
		if name == "inventory.context" {
			if value, _ := slot["report_date"].(string); value == "" {
				return &validationError{status: http.StatusUnprocessableEntity, code: "SLOT_VALIDATION_FAILED", message: "Slot inventory.context report_date is required"}
			}
		}
		if name == "ad.context" {
			for _, key := range []string{"date_range_start", "date_range_end"} {
				if value, _ := slot[key].(string); value == "" {
					return &validationError{status: http.StatusUnprocessableEntity, code: "SLOT_VALIDATION_FAILED", message: "Slot ad.context " + key + " is required"}
				}
			}
		}
	}
	return nil
}

func firstUnknownSlotKey(slot map[string]any, allowed []string) string {
	allowedSet := make(map[string]bool, len(allowed))
	for _, key := range allowed {
		allowedSet[key] = true
	}
	for key := range slot {
		if !allowedSet[key] {
			return key
		}
	}
	return ""
}

func validateSlotScope(projectID int64, country string, slots map[string]any) error {
	for name, value := range slots {
		if !strings.HasSuffix(name, ".context") {
			continue
		}
		slot, ok := value.(map[string]any)
		if !ok {
			continue
		}
		countryValue, _ := slot["country"].(string)
		if countryValue != "" && normalizeCountry(countryValue) != country {
			return &validationError{status: http.StatusUnprocessableEntity, code: "SCOPE_MISMATCH", message: "Slot " + name + " country does not match request scope"}
		}
		rawIDs, ok := slot["project_ids"].([]any)
		if !ok {
			continue
		}
		found := false
		for _, rawID := range rawIDs {
			switch value := rawID.(type) {
			case float64:
				if int64(value) == projectID {
					found = true
				}
			case int64:
				if value == projectID {
					found = true
				}
			case int:
				if int64(value) == projectID {
					found = true
				}
			}
		}
		if !found {
			return &validationError{status: http.StatusUnprocessableEntity, code: "SCOPE_MISMATCH", message: "Slot " + name + " project_ids does not contain request project_id"}
		}
	}
	return nil
}

func fingerprintRequest(request CreateRunRequest) (string, []byte, error) {
	canonical := map[string]any{
		"schema_version": request.SchemaVersion,
		"role_id":        request.RoleID,
		"role_version":   request.RoleVersion,
		"project_id":     request.ProjectID,
		"country":        request.Country,
		"slots":          request.Slots,
	}
	if request.EndpointID != nil && *request.EndpointID != "" {
		canonical["endpoint_id"] = *request.EndpointID
	}
	if request.ModelID != nil && *request.ModelID != "" {
		canonical["model_id"] = *request.ModelID
	}
	raw, err := json.Marshal(canonical)
	if err != nil {
		return "", nil, err
	}
	digest := sha256.Sum256(raw)
	slotsJSON, err := json.Marshal(request.Slots)
	if err != nil {
		return "", nil, err
	}
	return hex.EncodeToString(digest[:]), slotsJSON, nil
}

func validUUIDText(value string) bool {
	return ValidateRunID(value) == nil
}

func parseLastEventID(w http.ResponseWriter, raw string, run *Run) (*Cursor, bool) {
	if strings.TrimSpace(raw) == "" {
		return nil, true
	}
	parts := strings.Split(strings.TrimSpace(raw), ":")
	if len(parts) != 3 || ValidateRunID(parts[0]) != nil {
		WriteTypedError(w, http.StatusBadRequest, "RESUME_CURSOR_INVALID", "Last-Event-ID is not a valid cursor")
		return nil, false
	}
	attempt, errA := strconv.Atoi(parts[1])
	seq, errS := strconv.Atoi(parts[2])
	if errA != nil || errS != nil || attempt <= 0 || seq <= 0 {
		WriteTypedError(w, http.StatusBadRequest, "RESUME_CURSOR_INVALID", "Last-Event-ID is not a valid cursor")
		return nil, false
	}
	if attempt > run.Attempt {
		WriteTypedError(w, http.StatusBadRequest, "RESUME_CURSOR_INVALID", "Last-Event-ID points at a future attempt")
		return nil, false
	}
	if parts[0] != run.RunID {
		return nil, true
	}
	return &Cursor{RunID: parts[0], Attempt: attempt, Seq: seq}, true
}

func parseCursorValue(id string) *Cursor {
	parts := strings.Split(id, ":")
	if len(parts) != 3 {
		return nil
	}
	attempt, errA := strconv.Atoi(parts[1])
	seq, errS := strconv.Atoi(parts[2])
	if errA != nil || errS != nil || attempt <= 0 || seq <= 0 {
		return nil
	}
	return &Cursor{RunID: parts[0], Attempt: attempt, Seq: seq}
}

func snapshotEvent(detail RunDetail, seq int) Event {
	terminal := isTerminal(detail.Status)
	return Event{
		SchemaVersion: 1, RunID: detail.RunID, Attempt: detail.Attempt, Seq: seq,
		Type: "snapshot", Status: detail.Status, Stage: detail.Stage,
		ProgressPercent: intPointer(detail.ProgressPercent), Outputs: detail.Outputs,
		IsTerminal: boolPointer(terminal), Error: detail.Error,
	}
}

func terminalEvent(detail RunDetail, seq int) Event {
	if detail.Status == "completed" {
		content := ""
		if main, ok := detail.Outputs["main"]; ok {
			content = main.Content
		}
		digest := sha256.Sum256([]byte(content))
		return Event{
			SchemaVersion: 1, RunID: detail.RunID, Attempt: detail.Attempt, Seq: seq,
			Type: "done", Status: "completed", Outputs: detail.Outputs,
			Title: detail.Title, Usage: detail.Usage,
			ContentSHA256: hex.EncodeToString(digest[:]),
		}
	}
	status := "failed"
	if detail.Status == "cancelled" {
		status = "cancelled"
	}
	err := detail.Error
	if err == nil {
		err = &Error{Code: "PROVIDER_UNAVAILABLE", Message: "Insight run failed", Retryable: true}
	}
	return Event{
		SchemaVersion: 1, RunID: detail.RunID, Attempt: detail.Attempt, Seq: seq,
		Type: "error", Status: status, Error: err,
	}
}

func cancelledError() *Error {
	return &Error{Code: "CANCELLED", Message: "Insight run cancelled", Retryable: false}
}

func isTerminal(status string) bool {
	return status == "completed" || status == "failed" || status == "cancelled"
}

func writeSSEEvent(w io.Writer, event Event, includeID bool) {
	raw, err := json.Marshal(event)
	if err != nil {
		return
	}
	if includeID && event.RunID != "" && event.Attempt > 0 && event.Seq > 0 {
		_, _ = fmt.Fprintf(w, "id: %s\n", EventID(event.RunID, event.Attempt, event.Seq))
	}
	_, _ = fmt.Fprintf(w, "data: %s\n\n", raw)
}

func EventID(runID string, attempt, seq int) string {
	return fmt.Sprintf("%s:%d:%d", runID, attempt, seq)
}

func intPointer(value int) *int    { return &value }
func boolPointer(value bool) *bool { return &value }
