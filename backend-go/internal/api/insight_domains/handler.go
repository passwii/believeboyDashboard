package insight_domains

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/insight_runs"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const maxDomainBodyBytes = 64 << 10
const adAnalysisMaxRangeDays = 366

var domainModelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,63}$`)

type Handler struct {
	store            Store
	enqueuer         ai_insight.JobEnqueuer
	provider         ai.Provider
	canonicalDomains string
}

func NewHandler(store Store, enqueuer ai_insight.JobEnqueuer, provider ai.Provider, cfg Config) *Handler {
	return &Handler{store: store, enqueuer: enqueuer, provider: provider, canonicalDomains: cfg.CanonicalDomains}
}

func (handler *Handler) CreateAdAnalysisRun(w http.ResponseWriter, r *http.Request) {
	if !handler.guardDomain(w, "ad_analysis") {
		return
	}
	var payload AdAnalysisRequest
	if !decodeDomainBody(w, r, &payload) {
		return
	}
	normalized, ok := validateAdRequest(w, payload)
	if !ok {
		return
	}
	identity := requestIdentity(r)
	project, err := handler.store.VerifyProjectAccess(r.Context(), normalized.ProjectID, identity.Operator, identity.IsAdmin)
	if err != nil {
		writeDomainStoreError(w, err)
		return
	}
	if project.Country != "" && strings.ToUpper(project.Country) != normalized.Country {
		writeTyped(w, http.StatusUnprocessableEntity, "COUNTRY_MISMATCH", "Project country does not match the request")
		return
	}
	if !handler.guardDependencies(w) {
		return
	}
	normalized.Operator = identity.Operator
	run, replayed, err := handler.store.CreateAdAnalysisRun(r.Context(), normalized, ai_insight.MutationMetaFromRequest(r, identity.Operator))
	if err != nil {
		writeDomainStoreError(w, err)
		return
	}
	if !handler.dispatch(w, r, run, replayed, identity) {
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusCreated, insight_runs.ToRunResponse(run, replayed))
}

func (handler *Handler) CreateInventoryHealthRun(w http.ResponseWriter, r *http.Request) {
	if !handler.guardDomain(w, "inventory_health") {
		return
	}
	var payload InventoryHealthRequest
	if !decodeDomainBody(w, r, &payload) {
		return
	}
	normalized, ok := validateInventoryRequest(w, payload)
	if !ok {
		return
	}
	identity := requestIdentity(r)
	project, err := handler.store.VerifyProjectAccess(r.Context(), normalized.ProjectID, identity.Operator, identity.IsAdmin)
	if err != nil {
		writeDomainStoreError(w, err)
		return
	}
	if project.Country != "" && strings.ToUpper(project.Country) != normalized.Country {
		writeTyped(w, http.StatusUnprocessableEntity, "COUNTRY_MISMATCH", "Project country does not match the request")
		return
	}
	if !handler.guardDependencies(w) {
		return
	}
	normalized.Operator = identity.Operator
	run, replayed, err := handler.store.CreateInventoryHealthRun(r.Context(), normalized, ai_insight.MutationMetaFromRequest(r, identity.Operator))
	if err != nil {
		writeDomainStoreError(w, err)
		return
	}
	if !handler.dispatch(w, r, run, replayed, identity) {
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusCreated, insight_runs.ToRunResponse(run, replayed))
}

func (handler *Handler) guardDomain(w http.ResponseWriter, roleID string) bool {
	if !ai_insight.IsDomainCanonical(handler.canonicalDomains, roleID) {
		writeTyped(w, http.StatusConflict, "DOMAIN_SWITCH_NOT_READY", roleID+" 尚未切换到 canonical Insight（insight_canonical_domains 未包含该域），canonical 入口暂不可用")
		return false
	}
	return true
}

func (handler *Handler) guardDependencies(w http.ResponseWriter) bool {
	if handler.enqueuer == nil {
		writeTyped(w, http.StatusServiceUnavailable, "PROVIDER_UNAVAILABLE", "Insight job enqueuer is not configured")
		return false
	}
	if handler.provider == nil || !handler.provider.Configured() {
		writeTyped(w, http.StatusServiceUnavailable, "PROVIDER_UNAVAILABLE", "Insight AI provider is not configured")
		return false
	}
	return true
}

func (handler *Handler) dispatch(w http.ResponseWriter, r *http.Request, run *insight_runs.Run, replayed bool, identity auth.UserContext) bool {
	meta := ai_insight.MutationMetaFromRequest(r, identity.Operator)
	enqueue := func() bool {
		if err := handler.enqueuer.EnqueueExecuteRun(r.Context(), ai_insight.ExecuteRunJob{RunID: run.RunID, Attempt: run.Attempt}); err != nil {
			_, _ = handler.store.RunTransition(r.Context(), run.RunID, run.Attempt, "failed", run.Stage, run.ProgressPercent, nil, nil, nil, &insight_runs.Error{
				Code: "PROVIDER_UNAVAILABLE", Message: "Insight job enqueue failed", Retryable: true,
			})
			writeTyped(w, http.StatusServiceUnavailable, "PROVIDER_UNAVAILABLE", "Insight job enqueue failed")
			return false
		}
		return true
	}
	if replayed && (run.Status == "failed" || run.Status == "cancelled") {
		retried, err := handler.store.RetryRun(r.Context(), run.RunID, meta)
		if err != nil {
			writeDomainStoreError(w, err)
			return false
		}
		*run = *retried
		return enqueue()
	}
	if !replayed {
		return enqueue()
	}
	return true
}

func decodeDomainBody(w http.ResponseWriter, r *http.Request, target any) bool {
	limited := http.MaxBytesReader(w, r.Body, maxDomainBodyBytes)
	raw, err := io.ReadAll(limited)
	if err != nil {
		writeTyped(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", "Invalid request body")
		return false
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil {
		writeTyped(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", "Request body must be a JSON object")
		return false
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeTyped(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", "Invalid request body")
		return false
	}
	return true
}

func validateAdRequest(w http.ResponseWriter, payload AdAnalysisRequest) (AdAnalysisInput, bool) {
	country, ok := validateCommon(w, payload.ProjectID, payload.Country, payload.ModelID)
	if !ok {
		return AdAnalysisInput{}, false
	}
	start, err := time.Parse("2006-01-02", strings.TrimSpace(payload.StartDate))
	if err != nil {
		writeTyped(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", "Invalid request field 'start_date'")
		return AdAnalysisInput{}, false
	}
	end, err := time.Parse("2006-01-02", strings.TrimSpace(payload.EndDate))
	if err != nil {
		writeTyped(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", "Invalid request field 'end_date'")
		return AdAnalysisInput{}, false
	}
	if end.Before(start) {
		writeTyped(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", "end_date must not be earlier than start_date")
		return AdAnalysisInput{}, false
	}
	if int(end.Sub(start).Hours()/24)+1 > adAnalysisMaxRangeDays {
		writeTyped(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", fmt.Sprintf("date range must not exceed %d days", adAnalysisMaxRangeDays))
		return AdAnalysisInput{}, false
	}
	return AdAnalysisInput{
		ProjectID: payload.ProjectID, Country: country, StartDate: start, EndDate: end, ModelID: payload.ModelID,
	}, true
}

func validateInventoryRequest(w http.ResponseWriter, payload InventoryHealthRequest) (InventoryHealthInput, bool) {
	country, ok := validateCommon(w, payload.ProjectID, payload.Country, payload.ModelID)
	if !ok {
		return InventoryHealthInput{}, false
	}
	var reportDate *time.Time
	if payload.ReportDate != nil && strings.TrimSpace(*payload.ReportDate) != "" {
		parsed, err := time.Parse("2006-01-02", strings.TrimSpace(*payload.ReportDate))
		if err != nil {
			writeTyped(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", "Invalid request field 'report_date'")
			return InventoryHealthInput{}, false
		}
		reportDate = &parsed
	}
	return InventoryHealthInput{
		ProjectID: payload.ProjectID, Country: country, ReportDate: reportDate, ModelID: payload.ModelID,
	}, true
}

func validateCommon(w http.ResponseWriter, projectID int64, rawCountry string, modelID *string) (string, bool) {
	if projectID <= 0 {
		writeTyped(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", "project_id must be a positive integer")
		return "", false
	}
	country := strings.ToUpper(strings.TrimSpace(rawCountry))
	if country == "GB" {
		country = "UK"
	}
	if country != "US" && country != "DE" && country != "UK" {
		writeTyped(w, http.StatusUnprocessableEntity, "INVALID_REQUEST", "country must be one of US, DE, UK")
		return "", false
	}
	if modelID != nil && *modelID != "" && !domainModelPattern.MatchString(*modelID) {
		writeTyped(w, http.StatusUnprocessableEntity, "MODEL_NOT_ALLOWED", "model_id is invalid")
		return "", false
	}
	return country, true
}

func requestIdentity(r *http.Request) auth.UserContext {
	identity, ok := auth.UserContextFromContext(r.Context())
	if ok {
		return identity
	}
	return auth.UserContextFromRequest(r)
}

func writeTyped(w http.ResponseWriter, status int, code, message string) {
	ai_insight.WriteTypedDetail(w, status, code, message)
}

func writeDomainStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, insight_runs.ErrIdempotencyConflict):
		writeTyped(w, http.StatusConflict, "IDEMPOTENCY_KEY_CONFLICT", "Idempotency key already used with a different payload")
	case errors.Is(err, insight_runs.ErrRunNotFound):
		writeTyped(w, http.StatusNotFound, "RUN_NOT_FOUND", "Insight run not found")
	case errors.Is(err, insight_runs.ErrProjectNotFound):
		writeTyped(w, http.StatusNotFound, "PROJECT_NOT_FOUND", "Project not found")
	case errors.Is(err, insight_runs.ErrProjectOutOfScope):
		writeTyped(w, http.StatusForbidden, "PROJECT_OUT_OF_SCOPE", "Project out of scope")
	case errors.Is(err, insight_runs.ErrCountryMismatch):
		writeTyped(w, http.StatusUnprocessableEntity, "COUNTRY_MISMATCH", "Project country does not match the request")
	case errors.Is(err, insight_runs.ErrRunTerminal):
		writeTyped(w, http.StatusConflict, "RUN_TERMINAL", "Run is already terminal")
	case errors.Is(err, insight_runs.ErrInvalidTransition):
		writeTyped(w, http.StatusConflict, "INVALID_STATE_TRANSITION", "Run state transition is not allowed")
	default:
		httpapi.WriteInternalServerError(w)
	}
}
