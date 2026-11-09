package product_analysis

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const maxProductAnalysisJSONBody = 2 << 20

type Handler struct {
	store   Store
	auditor audit.Service
	engine  CalculationEngine
}

func NewHandler(store Store, auditor audit.Service, options ...Option) *Handler {
	handler := &Handler{
		store:   store,
		auditor: auditor,
	}
	if provider, ok := store.(CalculationEngineProvider); ok {
		handler.engine = provider.CalculationEngine()
	}
	for _, option := range options {
		if option != nil {
			option(handler)
		}
	}
	if handler.engine == nil {
		handler.engine = unconfiguredCalculationEngine{}
	}
	return handler
}

type Option func(*Handler)

func WithCalculationEngine(engine CalculationEngine) Option {
	return func(handler *Handler) {
		handler.engine = engine
	}
}

func (h *Handler) ListSources(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	projectID, ok := productAnalysisOptionalPositiveID(w, query.Get("project_id"), "project_id")
	if !ok {
		return
	}

	var reportType *string
	if raw := strings.TrimSpace(query.Get("report_type")); raw != "" {
		normalized, valid := productAnalysisNormalizeReportType(raw)
		if !valid {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "report_type is unsupported")
			return
		}
		reportType = &normalized
	}

	periodStart, ok := productAnalysisOptionalDateQuery(w, query.Get("period_start_date"), "period_start_date")
	if !ok {
		return
	}
	periodEnd, ok := productAnalysisOptionalDateQuery(w, query.Get("period_end_date"), "period_end_date")
	if !ok {
		return
	}
	currentOnly, ok := productAnalysisBoolQuery(w, query.Get("current_only"), true, "current_only")
	if !ok {
		return
	}
	includeHistory, ok := productAnalysisBoolQuery(w, query.Get("include_history"), false, "include_history")
	if !ok {
		return
	}
	if includeHistory {
		currentOnly = false
	}

	identity, _ := auth.UserContextFromContext(r.Context())
	accessibleIDs, ok := h.productAnalysisAccessibleProjectIDs(w, r, identity)
	if !ok {
		return
	}
	if projectID != nil {
		if !h.requireProjectAccess(w, r, *projectID) {
			return
		}
		accessibleIDs = nil
	} else if accessibleIDs != nil && len(*accessibleIDs) == 0 {
		_ = httpapi.WriteJSON(w, http.StatusOK, []AnalysisSourceFileItem{})
		return
	}

	items, err := h.store.ListSources(r.Context(), SourceFilter{
		ProjectID:       projectID,
		ProjectIDs:      productAnalysisProjectIDsValue(accessibleIDs),
		ReportType:      reportType,
		PeriodStartDate: periodStart,
		PeriodEndDate:   periodEnd,
		CurrentOnly:     currentOnly,
	})
	if err != nil {
		h.writeError(w, err)
		return
	}
	if items == nil {
		items = []AnalysisSourceFileItem{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, items)
}

func (h *Handler) GetSourceRows(w http.ResponseWriter, r *http.Request) {
	sourceID, ok := productAnalysisPathID(w, r, "source_id")
	if !ok {
		return
	}
	projectID, err := h.store.SourceProjectID(r.Context(), sourceID)
	if err != nil {
		h.writeError(w, err)
		return
	}
	if !h.requireProjectAccess(w, r, projectID) {
		return
	}
	page, ok := productAnalysisPageQuery(w, r, 1, 1, int(^uint(0)>>1), "page")
	if !ok {
		return
	}
	pageSize, ok := productAnalysisPageQuery(w, r, 200, 1, 1000, "page_size")
	if !ok {
		return
	}
	includeExcluded, ok := productAnalysisBoolQuery(
		w,
		r.URL.Query().Get("include_excluded"),
		false,
		"include_excluded",
	)
	if !ok {
		return
	}

	rows, err := h.store.GetSourceRows(r.Context(), sourceID, page, pageSize, includeExcluded)
	if err != nil {
		h.writeError(w, err)
		return
	}
	if rows == nil {
		h.writeError(w, ErrNotFound)
		return
	}
	if rows.Rows == nil {
		rows.Rows = []map[string]any{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, rows)
}

func (h *Handler) GetCurrentInventory(w http.ResponseWriter, r *http.Request) {
	projectID, ok := productAnalysisRequiredPositiveID(w, r, "project_id")
	if !ok {
		return
	}
	country, ok := productAnalysisCountryQuery(w, r)
	if !ok {
		return
	}
	startDate, ok := productAnalysisOptionalDateQuery(w, r.URL.Query().Get("start_date"), "start_date")
	if !ok {
		return
	}
	endDate, ok := productAnalysisOptionalDateQuery(w, r.URL.Query().Get("end_date"), "end_date")
	if !ok {
		return
	}
	if startDate != nil && endDate != nil && startDate.After(*endDate) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "start_date must not be after end_date")
		return
	}
	if !h.requireProjectAccess(w, r, projectID) {
		return
	}

	snapshot, err := h.store.GetCurrentInventory(r.Context(), projectID, country, startDate, endDate)
	if err != nil {
		h.writeError(w, err)
		return
	}
	if snapshot == nil {
		h.writeError(w, ErrNotFound)
		return
	}
	if snapshot.Rows == nil {
		snapshot.Rows = []map[string]any{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, snapshot)
}

func (h *Handler) ListPT1(w http.ResponseWriter, r *http.Request) {
	projectID, ok := productAnalysisOptionalPositiveID(w, r.URL.Query().Get("project_id"), "project_id")
	if !ok {
		return
	}
	startDate, ok := productAnalysisOptionalDateQuery(w, r.URL.Query().Get("start_date"), "start_date")
	if !ok {
		return
	}
	endDate, ok := productAnalysisOptionalDateQuery(w, r.URL.Query().Get("end_date"), "end_date")
	if !ok {
		return
	}
	currentOnly, ok := productAnalysisBoolQuery(w, r.URL.Query().Get("current_only"), true, "current_only")
	if !ok {
		return
	}

	identity, _ := auth.UserContextFromContext(r.Context())
	accessibleIDs, ok := h.productAnalysisAccessibleProjectIDs(w, r, identity)
	if !ok {
		return
	}
	if projectID != nil {
		if !h.requireProjectAccess(w, r, *projectID) {
			return
		}
		accessibleIDs = nil
	} else if accessibleIDs != nil && len(*accessibleIDs) == 0 {
		_ = httpapi.WriteJSON(w, http.StatusOK, []PT1CalculationItem{})
		return
	}

	items, err := h.store.ListPT1(r.Context(), PT1Filter{
		ProjectID:   projectID,
		ProjectIDs:  productAnalysisProjectIDsValue(accessibleIDs),
		StartDate:   startDate,
		EndDate:     endDate,
		CurrentOnly: currentOnly,
	})
	if err != nil {
		h.writeError(w, err)
		return
	}
	if items == nil {
		items = []PT1CalculationItem{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, items)
}

func (h *Handler) GetPT1Details(w http.ResponseWriter, r *http.Request) {
	pt1ID, ok := productAnalysisPathID(w, r, "pt1_id")
	if !ok {
		return
	}
	country, ok := productAnalysisCountryQuery(w, r)
	if !ok {
		return
	}
	page, ok := productAnalysisPageQuery(w, r, 1, 1, int(^uint(0)>>1), "page")
	if !ok {
		return
	}
	pageSize, ok := productAnalysisPageQuery(w, r, 500, 1, 1000, "page_size")
	if !ok {
		return
	}

	pt1, err := h.store.GetPT1(r.Context(), pt1ID)
	if err != nil {
		h.writeError(w, err)
		return
	}
	if pt1 == nil {
		h.writeError(w, ErrNotFound)
		return
	}
	if !h.requireProjectAccess(w, r, pt1.ProjectID) {
		return
	}
	if country != pt1.Country {
		h.writeError(w, ErrNotFound)
		return
	}

	details, err := h.store.ListPT1Details(r.Context(), *pt1, country, page, pageSize)
	if err != nil {
		h.writeError(w, err)
		return
	}
	if details == nil {
		h.writeError(w, ErrNotFound)
		return
	}
	if details.Rows == nil {
		details.Rows = []PT1DetailRow{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, details)
}

func (h *Handler) ListWeekly(w http.ResponseWriter, r *http.Request) {
	projectID, ok := productAnalysisRequiredPositiveID(w, r, "project_id")
	if !ok {
		return
	}
	country, ok := productAnalysisCountryQuery(w, r)
	if !ok {
		return
	}
	startDate, ok := productAnalysisOptionalDateQuery(w, r.URL.Query().Get("start_date"), "start_date")
	if !ok {
		return
	}
	endDate, ok := productAnalysisOptionalDateQuery(w, r.URL.Query().Get("end_date"), "end_date")
	if !ok {
		return
	}
	currentOnly, ok := productAnalysisBoolQuery(w, r.URL.Query().Get("current_only"), true, "current_only")
	if !ok {
		return
	}
	if !h.requireProjectAccess(w, r, projectID) {
		return
	}

	items, err := h.store.ListWeekly(r.Context(), PT1Filter{
		ProjectID:   &projectID,
		Country:     &country,
		StartDate:   startDate,
		EndDate:     endDate,
		CurrentOnly: currentOnly,
	})
	if err != nil {
		h.writeError(w, err)
		return
	}
	if items == nil {
		items = []WeeklyAnalysisItem{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, items)
}

func (h *Handler) CheckAvailability(w http.ResponseWriter, r *http.Request) {
	var body CheckRequest
	if !productAnalysisDecodeJSON(
		w,
		r,
		&body,
		[]string{"project_id", "start_date", "end_date"},
	) {
		return
	}
	startDate, ok := productAnalysisDateValue(w, body.StartDate, "start_date")
	if !ok {
		return
	}
	endDate, ok := productAnalysisDateValue(w, body.EndDate, "end_date")
	if !ok {
		return
	}
	if startDate.After(endDate) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "start_date must not be after end_date")
		return
	}
	country, ok := productAnalysisNormalizeCountry(w, body.Country)
	if !ok {
		return
	}
	if !h.requireProjectAccess(w, r, body.ProjectID) {
		return
	}

	result, err := h.store.CheckAvailability(
		r.Context(),
		body.ProjectID,
		country,
		startDate,
		endDate,
	)
	if err != nil {
		h.writeError(w, err)
		return
	}
	if result == nil {
		h.writeError(w, errors.New("product analysis availability result is nil"))
		return
	}
	productAnalysisEnsureAvailabilitySlices(result)
	_ = httpapi.WriteJSON(w, http.StatusOK, result)
}

func (h *Handler) RecomputeWeekly(w http.ResponseWriter, r *http.Request) {
	projectID, ok := productAnalysisRequiredPositiveID(w, r, "project_id")
	if !ok {
		return
	}
	country, ok := productAnalysisCountryQuery(w, r)
	if !ok {
		return
	}
	startDate, startDateString, ok := productAnalysisOptionalDateQueryString(
		w,
		r.URL.Query().Get("start_date"),
		"start_date",
	)
	if !ok {
		return
	}
	endDate, endDateString, ok := productAnalysisOptionalDateQueryString(
		w,
		r.URL.Query().Get("end_date"),
		"end_date",
	)
	if !ok {
		return
	}
	currentOnly, ok := productAnalysisBoolQuery(w, r.URL.Query().Get("current_only"), true, "current_only")
	if !ok {
		return
	}
	if startDate != nil && endDate != nil && startDate.After(*endDate) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "start_date must not be after end_date")
		return
	}
	if !h.requireProjectAccess(w, r, projectID) {
		return
	}

	result, err := h.engine.RecomputeWeekly(r.Context(), WeeklyRecomputeRequest{
		ProjectID:   projectID,
		Country:     country,
		StartDate:   startDateString,
		EndDate:     endDateString,
		CurrentOnly: currentOnly,
	}, productAnalysisPrincipal(r))
	if err != nil {
		h.writeError(w, err)
		return
	}
	if result == nil {
		h.writeError(w, errors.New("product analysis weekly recompute result is nil"))
		return
	}
	if result.Periods == nil {
		result.Periods = []WeeklyRecomputePeriod{}
	}
	if err := h.logMutation(r, audit.Entry{
		Action:     "product_analysis.weekly.recompute",
		TargetType: "product_analysis_weekly",
		TargetID:   productAnalysisStringPointer(strconv.FormatInt(projectID, 10)),
		AfterJSON: map[string]any{
			"project_id":   projectID,
			"country":      country,
			"start_date":   productAnalysisDerefString(startDateString),
			"end_date":     productAnalysisDerefString(endDateString),
			"current_only": currentOnly,
			"recomputed":   productAnalysisResultRecomputed(result),
		},
	}); err != nil {
		h.writeError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, result)
}

func (h *Handler) RunCalculation(w http.ResponseWriter, r *http.Request) {
	body := RunRequest{CurrentOnly: true}
	if !productAnalysisDecodeJSON(
		w,
		r,
		&body,
		[]string{"project_id", "start_date", "end_date"},
	) {
		return
	}
	startDate, ok := productAnalysisDateValue(w, body.StartDate, "start_date")
	if !ok {
		return
	}
	endDate, ok := productAnalysisDateValue(w, body.EndDate, "end_date")
	if !ok {
		return
	}
	if startDate.After(endDate) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "start_date must not be after end_date")
		return
	}
	country, ok := productAnalysisNormalizeCountry(w, body.Country)
	if !ok {
		return
	}
	if !h.requireProjectAccess(w, r, body.ProjectID) {
		return
	}

	body.Country = country
	result, err := h.engine.Run(r.Context(), body, productAnalysisPrincipal(r))
	if err != nil {
		h.writeError(w, err)
		return
	}
	if result == nil {
		h.writeError(w, errors.New("product analysis calculation result is nil"))
		return
	}
	productAnalysisNormalizeRunResponse(result)
	if err := h.logMutation(r, audit.Entry{
		Action:     "product_analysis.calculation.run",
		TargetType: "product_analysis_weekly",
		TargetID:   productAnalysisStringPointer(strconv.FormatInt(body.ProjectID, 10)),
		AfterJSON: map[string]any{
			"project_id":        body.ProjectID,
			"country":           country,
			"start_date":        body.StartDate,
			"end_date":          body.EndDate,
			"current_only":      body.CurrentOnly,
			"persisted_periods": productAnalysisRunTotal(result),
		},
	}); err != nil {
		h.writeError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, result)
}

func (h *Handler) PreviewCalculation(w http.ResponseWriter, r *http.Request) {
	var body PreviewRequest
	if !productAnalysisDecodeJSON(
		w,
		r,
		&body,
		[]string{"project_id", "start_date", "end_date"},
	) {
		return
	}
	startDate, ok := productAnalysisDateValue(w, body.StartDate, "start_date")
	if !ok {
		return
	}
	endDate, ok := productAnalysisDateValue(w, body.EndDate, "end_date")
	if !ok {
		return
	}
	if startDate.After(endDate) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "start_date must not be after end_date")
		return
	}
	country, ok := productAnalysisNormalizeCountry(w, body.Country)
	if !ok {
		return
	}
	if !h.requireProjectAccess(w, r, body.ProjectID) {
		return
	}

	body.Country = country
	result, err := h.engine.Preview(r.Context(), body, productAnalysisPrincipal(r))
	if err != nil {
		h.writeError(w, err)
		return
	}
	if result == nil {
		h.writeError(w, errors.New("product analysis preview result is nil"))
		return
	}
	productAnalysisNormalizeRunResponse(result)
	if err := h.logMutation(r, audit.Entry{
		Action:     "product_analysis.calculation.preview",
		TargetType: "product_analysis_weekly",
		TargetID:   productAnalysisStringPointer(strconv.FormatInt(body.ProjectID, 10)),
		AfterJSON: map[string]any{
			"project_id": body.ProjectID,
			"country":    country,
			"start_date": body.StartDate,
			"end_date":   body.EndDate,
			"temp_file_ids": map[string]any{
				"business": body.BusinessTempFileID,
				"payment":  body.PaymentTempFileID,
				"ad":       body.ADTempFileID,
			},
		},
	}); err != nil {
		h.writeError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, result)
}

func (h *Handler) TriggerRecompute(w http.ResponseWriter, r *http.Request) {
	projectID, ok := productAnalysisRequiredPositiveID(w, r, "project_id")
	if !ok {
		return
	}
	country, ok := productAnalysisCountryQuery(w, r)
	if !ok {
		return
	}
	periodStart, ok := productAnalysisRequiredDateQuery(w, r, "period_start_date")
	if !ok {
		return
	}
	periodEnd, ok := productAnalysisRequiredDateQuery(w, r, "period_end_date")
	if !ok {
		return
	}
	if periodStart.After(periodEnd) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "period_start_date must not be after period_end_date")
		return
	}
	if !h.requireProjectAccess(w, r, projectID) {
		return
	}

	result, err := h.engine.TriggerRecompute(r.Context(), TriggerRecomputeRequest{
		ProjectID:       projectID,
		Country:         country,
		PeriodStartDate: periodStart.Format("2006-01-02"),
		PeriodEndDate:   periodEnd.Format("2006-01-02"),
	}, productAnalysisPrincipal(r))
	if err != nil {
		h.writeError(w, err)
		return
	}
	if result == nil {
		h.writeError(w, errors.New("product analysis trigger recompute result is nil"))
		return
	}
	if err := h.logMutation(r, audit.Entry{
		Action:     "product_analysis.trigger_recompute",
		TargetType: "product_analysis_pt1",
		TargetID:   productAnalysisStringPointer(strconv.FormatInt(projectID, 10)),
		AfterJSON: map[string]any{
			"project_id":        projectID,
			"country":           country,
			"period_start_date": periodStart.Format("2006-01-02"),
			"period_end_date":   periodEnd.Format("2006-01-02"),
			"pt1_id":            result["pt1_id"],
		},
	}); err != nil {
		h.writeError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, result)
}

func (h *Handler) UploadSources(w http.ResponseWriter, r *http.Request) {
	var body UploadSourcesRequest
	if !productAnalysisDecodeJSON(
		w,
		r,
		&body,
		[]string{"project_name", "report_start_date", "report_end_date", "file_ids", "resolved_file_paths"},
	) {
		return
	}
	body.ProjectName = strings.TrimSpace(body.ProjectName)
	if len([]rune(body.ProjectName)) < 1 || len([]rune(body.ProjectName)) > 128 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_name length must be between 1 and 128")
		return
	}
	startDate, ok := productAnalysisDateValue(w, body.ReportStartDate, "report_start_date")
	if !ok {
		return
	}
	endDate, ok := productAnalysisDateValue(w, body.ReportEndDate, "report_end_date")
	if !ok {
		return
	}
	if startDate.After(endDate) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "report_start_date must not be after report_end_date")
		return
	}
	country, ok := productAnalysisNormalizeCountry(w, body.Country)
	if !ok {
		return
	}
	projectID, err := h.store.ProjectIDByName(r.Context(), body.ProjectName)
	if err != nil {
		h.writeError(w, err)
		return
	}
	if !h.requireProjectAccess(w, r, projectID) {
		return
	}

	body.Country = country
	result, err := h.engine.UploadSources(r.Context(), body, productAnalysisPrincipal(r))
	if err != nil {
		h.writeError(w, err)
		return
	}
	if result == nil {
		h.writeError(w, errors.New("product analysis source upload result is nil"))
		return
	}
	if result.Outcomes == nil {
		result.Outcomes = []SourcePersistOutcome{}
	}
	if err := h.logMutation(r, audit.Entry{
		Action:     "product_analysis.sources.upload_file",
		TargetType: "product_analysis_source",
		AfterJSON: map[string]any{
			"project_name":      body.ProjectName,
			"country":           country,
			"report_start_date": body.ReportStartDate,
			"report_end_date":   body.ReportEndDate,
			"outcomes":          productAnalysisUploadOutcomes(result),
		},
	}); err != nil {
		h.writeError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, result)
}

func (h *Handler) requireProjectAccess(w http.ResponseWriter, r *http.Request, projectID int64) bool {
	identity, _ := auth.UserContextFromContext(r.Context())
	if err := h.store.VerifyProjectAccess(
		r.Context(),
		projectID,
		identity.Operator,
		identity.IsAdmin,
	); err != nil {
		h.writeError(w, err)
		return false
	}
	return true
}

func (h *Handler) productAnalysisAccessibleProjectIDs(
	w http.ResponseWriter,
	r *http.Request,
	identity auth.UserContext,
) (*[]int64, bool) {
	if identity.IsAdmin {
		return nil, true
	}
	ids, err := h.store.AccessibleProjectIDs(r.Context(), identity.Operator, false)
	if err != nil {
		h.writeError(w, err)
		return nil, false
	}
	if ids == nil {
		ids = []int64{}
	}
	return &ids, true
}

func (h *Handler) logMutation(r *http.Request, entry audit.Entry) error {
	if h.auditor == nil {
		return errors.New("audit service is nil")
	}
	identity, _ := auth.UserContextFromContext(r.Context())
	entry.Operator = productAnalysisStringPointer(strings.TrimSpace(identity.Operator))
	if entry.Operator != nil && *entry.Operator == "" {
		entry.Operator = nil
	}
	entry.Result = "success"
	entry.PopulateFromRequest(r)
	return h.auditor.LogAction(r.Context(), entry)
}

func (h *Handler) writeError(w http.ResponseWriter, err error) {
	var statusErr *StatusError
	if errors.As(err, &statusErr) && statusErr != nil {
		httpapi.WriteDetail(w, statusErr.Status, statusErr.Detail)
		return
	}
	switch {
	case errors.Is(err, ErrProjectNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
	case errors.Is(err, ErrProjectForbidden):
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
	case errors.Is(err, ErrNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "记录不存在")
	case errors.Is(err, ErrConflict):
		httpapi.WriteDetail(w, http.StatusConflict, "记录冲突")
	case errors.Is(err, ErrInvalid):
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
	default:
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
	}
}

type unconfiguredCalculationEngine struct{}

// This fallback is only for stores that expose neither a production engine nor
// an injected test engine. It keeps incomplete wiring fail-closed.
func (unconfiguredCalculationEngine) unsupported(operation string) error {
	return &StatusError{
		Status: http.StatusServiceUnavailable,
		Detail: operation + " has no configured calculation engine",
	}
}

func (e unconfiguredCalculationEngine) Run(context.Context, RunRequest, Principal) (*RunResponse, error) {
	return nil, e.unsupported("product_analysis.calculation.run")
}

func (e unconfiguredCalculationEngine) Preview(context.Context, PreviewRequest, Principal) (*RunResponse, error) {
	return nil, e.unsupported("product_analysis.calculation.preview")
}

func (e unconfiguredCalculationEngine) RecomputeWeekly(context.Context, WeeklyRecomputeRequest, Principal) (*WeeklyRecomputeResponse, error) {
	return nil, e.unsupported("product_analysis.weekly.recompute")
}

func (e unconfiguredCalculationEngine) TriggerRecompute(context.Context, TriggerRecomputeRequest, Principal) (map[string]any, error) {
	return nil, e.unsupported("product_analysis.trigger-recompute")
}

func (e unconfiguredCalculationEngine) UploadSources(context.Context, UploadSourcesRequest, Principal) (*UploadSourcesResponse, error) {
	return nil, e.unsupported("product_analysis.sources.upload-file")
}

func productAnalysisDecodeJSON(
	w http.ResponseWriter,
	r *http.Request,
	target any,
	requiredFields []string,
) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxProductAnalysisJSONBody)
	decoder := json.NewDecoder(r.Body)
	decoder.UseNumber()

	var fields map[string]json.RawMessage
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return false
	}
	for _, field := range requiredFields {
		raw, ok := fields[field]
		if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Required field missing: "+field)
			return false
		}
	}
	payload, err := json.Marshal(fields)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return false
	}
	if err := json.Unmarshal(payload, target); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return false
	}
	return true
}

func productAnalysisPathID(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	raw := strings.TrimSpace(chi.URLParam(r, name))
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, name+" must be a valid integer")
		return 0, false
	}
	return value, true
}

func productAnalysisRequiredPositiveID(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	values, present := r.URL.Query()[name]
	if !present || len(values) == 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Missing required query parameter: "+name)
		return 0, false
	}
	return productAnalysisPositiveID(w, values[len(values)-1], name)
}

func productAnalysisOptionalPositiveID(
	w http.ResponseWriter,
	raw string,
	name string,
) (*int64, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, true
	}
	value, ok := productAnalysisPositiveID(w, raw, name)
	if !ok {
		return nil, false
	}
	return &value, true
}

func productAnalysisPositiveID(w http.ResponseWriter, raw, name string) (int64, bool) {
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || value <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, name+" must be greater than zero")
		return 0, false
	}
	return value, true
}

func productAnalysisPageQuery(
	w http.ResponseWriter,
	r *http.Request,
	fallback, minimum, maximum int,
	name string,
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

func productAnalysisBoolQuery(
	w http.ResponseWriter,
	raw string,
	fallback bool,
	name string,
) (bool, bool) {
	if strings.TrimSpace(raw) == "" {
		return fallback, true
	}
	value, ok := productAnalysisParseBool(raw)
	if !ok {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, name+" must be a valid boolean")
		return false, false
	}
	return value, true
}

func productAnalysisParseBool(raw string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "on", "t", "true", "y", "yes":
		return true, true
	case "0", "off", "f", "false", "n", "no":
		return false, true
	default:
		return false, false
	}
}

func productAnalysisOptionalDateQuery(
	w http.ResponseWriter,
	raw string,
	name string,
) (*time.Time, bool) {
	value, _, ok := productAnalysisOptionalDateQueryString(w, raw, name)
	return value, ok
}

func productAnalysisOptionalDateQueryString(
	w http.ResponseWriter,
	raw string,
	name string,
) (*time.Time, *string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil, true
	}
	value, ok := productAnalysisDateValue(w, raw, name)
	if !ok {
		return nil, nil, false
	}
	formatted := value.Format("2006-01-02")
	return &value, &formatted, true
}

func productAnalysisRequiredDateQuery(
	w http.ResponseWriter,
	r *http.Request,
	name string,
) (time.Time, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Missing required query parameter: "+name)
		return time.Time{}, false
	}
	return productAnalysisDateValue(w, raw, name)
}

func productAnalysisDateValue(w http.ResponseWriter, raw, name string) (time.Time, bool) {
	value, err := time.Parse("2006-01-02", strings.TrimSpace(raw))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, name+" must be a valid date")
		return time.Time{}, false
	}
	return value, true
}

func productAnalysisCountryQuery(w http.ResponseWriter, r *http.Request) (string, bool) {
	raw := r.URL.Query().Get("country")
	if strings.TrimSpace(raw) == "" {
		raw = "US"
	}
	return productAnalysisNormalizeCountry(w, raw)
}

func productAnalysisNormalizeCountry(w http.ResponseWriter, raw string) (string, bool) {
	normalized := strings.ToUpper(strings.TrimSpace(raw))
	if normalized == "" {
		return "US", true
	}
	switch normalized {
	case "US", "USA", "美国", "美国站":
		return "US", true
	case "DE", "GERMANY", "德国", "德国站":
		return "DE", true
	case "UK", "GB", "UNITED KINGDOM", "英国", "英国站":
		return "UK", true
	default:
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "country must be one of: DE, UK, US")
		return "", false
	}
}

func productAnalysisNormalizeReportType(raw string) (string, bool) {
	switch strings.TrimSpace(raw) {
	case "business_report", "payment_report", "sales_report", "inventory_report":
		return raw, true
	case "ad_product_report", "ad_report":
		return "ad_product_report", true
	default:
		return "", false
	}
}

func productAnalysisProjectIDsValue(ids *[]int64) []int64 {
	if ids == nil {
		return nil
	}
	return *ids
}

func productAnalysisPrincipal(r *http.Request) Principal {
	identity, _ := auth.UserContextFromContext(r.Context())
	return Principal{Operator: identity.Operator, IsAdmin: identity.IsAdmin}
}

func productAnalysisStringPointer(value string) *string {
	return &value
}

func productAnalysisDerefString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func productAnalysisResultRecomputed(result *WeeklyRecomputeResponse) int {
	if result == nil {
		return 0
	}
	return result.Recomputed
}

func productAnalysisRunTotal(result *RunResponse) int {
	if result == nil {
		return 0
	}
	return result.TotalPeriods
}

func productAnalysisNormalizeRunResponse(result *RunResponse) {
	if result == nil {
		return
	}
	if result.Periods == nil {
		result.Periods = []CalculationPeriod{}
	}
	for index := range result.Periods {
		if result.Periods[index].Summary == nil {
			result.Periods[index].Summary = map[string]any{}
		}
		if result.Periods[index].Details == nil {
			result.Periods[index].Details = []map[string]any{}
		}
	}
}

func productAnalysisUploadOutcomes(result *UploadSourcesResponse) []map[string]any {
	if result == nil {
		return []map[string]any{}
	}
	outcomes := make([]map[string]any, 0, len(result.Outcomes))
	for _, outcome := range result.Outcomes {
		outcomes = append(outcomes, map[string]any{
			"type":      outcome.ReportType,
			"success":   outcome.Success,
			"source_id": outcome.SourceID,
		})
	}
	return outcomes
}

func productAnalysisEnsureAvailabilitySlices(result *AvailabilityCheck) {
	if result == nil {
		return
	}
	if result.BusinessReportMissing == nil {
		result.BusinessReportMissing = []string{}
	}
	if result.ADReportMissing == nil {
		result.ADReportMissing = []string{}
	}
	if result.InventoryMissing == nil {
		result.InventoryMissing = []string{}
	}
	if result.BusinessPeriodInfo == nil {
		result.BusinessPeriodInfo = []PeriodCoverageInfo{}
	}
	if result.ADPeriodInfo == nil {
		result.ADPeriodInfo = []PeriodCoverageInfo{}
	}
	if result.BusinessPeriodicOnlyMissing == nil {
		result.BusinessPeriodicOnlyMissing = []string{}
	}
	if result.ADPeriodicOnlyMissing == nil {
		result.ADPeriodicOnlyMissing = []string{}
	}
	if result.PaymentPeriodsOverlapping == nil {
		result.PaymentPeriodsOverlapping = []PaymentPeriodOverlap{}
	}
	if result.PaymentDailyCoveredDates == nil {
		result.PaymentDailyCoveredDates = []string{}
	}
	if result.PaymentObjectiveEmptyDates == nil {
		result.PaymentObjectiveEmptyDates = []string{}
	}
	if result.WeeklyAvailability == nil {
		result.WeeklyAvailability = []WeeklyAvailability{}
	}
}
