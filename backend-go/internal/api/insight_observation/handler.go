package insight_observation

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Handler struct {
	store Store
	cfg   Config
}

func NewHandler(store Store, cfg Config) *Handler {
	return &Handler{store: store, cfg: cfg.normalized()}
}

func (handler *Handler) Gate(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	windowDays, capability, ok := parseGateQuery(w, r, handler.cfg.WindowDays)
	if !ok {
		return
	}
	report, err := handler.report(r, windowDays, capability)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, report)
}

func (handler *Handler) RetirementReadiness(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	windowDays, _, ok := parseGateQuery(w, r, handler.cfg.WindowDays)
	if !ok {
		return
	}
	report, err := handler.report(r, windowDays, nil)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	enabled := ai_insight.CanonicalDomains(handler.cfg.CanonicalDomains)
	domains := make([]string, 0, len(enabled))
	for _, role := range []string{"ad_analysis", "inventory_health"} {
		if enabled[role] {
			domains = append(domains, role)
		}
	}
	sort.Strings(domains)
	metricsOK := len(report.RetirementReasons) == 0
	readiness := RetirementReadiness{
		MetricsOK:            metricsOK,
		MetricsReasons:       report.RetirementReasons,
		CanonicalDomains:     domains,
		FrozenLegacyDomains:  append([]string{}, domains...),
		RollbackSwitch:       "清空 Settings.insight_canonical_domains 即回滚到旧写链路",
		LegacyReadsPreserved: true,
		CodegraphVerified:    nil,
		Eligible:             false,
		BlockingCount:        len(report.RetirementReasons),
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, readiness)
}

func (handler *Handler) report(r *http.Request, windowDays int, capability *string) (GateResponse, error) {
	since := time.Now().UTC().Add(-time.Duration(windowDays) * 24 * time.Hour)
	rows, err := handler.store.ListObservationRows(r.Context(), since, capability)
	if err != nil {
		return GateResponse{}, err
	}
	multiplier := handler.cfg.Thresholds.CostAnomalyMultiplier
	buckets := AggregateRows(rows, multiplier)
	findings, reasons := EvaluateGate(buckets, handler.cfg.Thresholds)
	eligible := len(reasons) == 0
	return GateResponse{
		WindowDays:            windowDays,
		GeneratedAt:           time.Now().UTC(),
		EligibleForRetirement: eligible,
		RetirementReasons:     reasons,
		BlockingCount:         len(reasons),
		Thresholds:            handler.cfg.Thresholds,
		BucketCaps:            copyCaps(handler.cfg.BucketCaps),
		Buckets:               buckets,
		Findings:              findings,
	}, nil
}

func requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}
	if !identity.IsAdmin {
		httpapi.WriteDetail(w, http.StatusForbidden, "需要管理员权限")
		return false
	}
	return true
}

func parseGateQuery(w http.ResponseWriter, r *http.Request, defaultWindow int) (int, *string, bool) {
	window := defaultWindow
	if raw := strings.TrimSpace(r.URL.Query().Get("window_days")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 90 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "window_days must be between 1 and 90")
			return 0, nil, false
		}
		window = value
	}
	var capability *string
	if raw := strings.TrimSpace(r.URL.Query().Get("capability")); raw != "" {
		if len([]rune(raw)) > 64 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "capability must contain at most 64 characters")
			return 0, nil, false
		}
		capability = &raw
	}
	return window, capability, true
}

func copyCaps(source map[string]int) map[string]int {
	result := make(map[string]int, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}
