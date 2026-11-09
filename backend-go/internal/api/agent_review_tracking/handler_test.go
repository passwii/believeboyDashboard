package agent_review_tracking

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
)

type reviewTrackingFakeStore struct {
	page       TargetPage
	pageErr    error
	pageFilter TargetListFilter
	pageCalls  int

	target       *Target
	targetErr    error
	existingRun  *CrawlRun
	existingErr  error
	latestAt     *time.Time
	latestErr    error
	insertResult CrawlResult
	insertErr    error
	insertInput  CrawlResultInput
	insertCalls  int

	auditEntries []AuditEntry
	auditErr     error
	txCalls      int
	rolledBack   bool
}

func (store *reviewTrackingFakeStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, Store) error,
) error {
	store.txCalls++
	err := fn(ctx, nil, store)
	if err != nil {
		store.rolledBack = true
	}
	return err
}

func (store *reviewTrackingFakeStore) ListTargets(
	_ context.Context,
	filter TargetListFilter,
) (TargetPage, error) {
	store.pageCalls++
	store.pageFilter = filter
	return store.page, store.pageErr
}

func (store *reviewTrackingFakeStore) GetTargetForUpdate(
	context.Context,
	int64,
) (*Target, error) {
	return store.target, store.targetErr
}

func (store *reviewTrackingFakeStore) FindRunByIdempotency(
	context.Context,
	int64,
	*string,
) (*CrawlRun, error) {
	return store.existingRun, store.existingErr
}

func (store *reviewTrackingFakeStore) LatestStartedAt(
	context.Context,
	int64,
	time.Time,
) (*time.Time, error) {
	return store.latestAt, store.latestErr
}

func (store *reviewTrackingFakeStore) InsertCrawlResult(
	_ context.Context,
	input CrawlResultInput,
) (CrawlResult, error) {
	store.insertCalls++
	store.insertInput = input
	return store.insertResult, store.insertErr
}

func (store *reviewTrackingFakeStore) LogAudit(
	_ context.Context,
	_ pgx.Tx,
	entry AuditEntry,
) error {
	if store.auditErr != nil {
		return store.auditErr
	}
	store.auditEntries = append(store.auditEntries, entry)
	return nil
}

func reviewTrackingTestRequest(
	t *testing.T,
	method string,
	target string,
	body string,
	credential agentauth.AgentCredential,
) *http.Request {
	t.Helper()
	request := httptest.NewRequest(method, target, bytes.NewBufferString(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	request = request.WithContext(agentauth.WithAgentCredential(request.Context(), credential))
	return request
}

func reviewTrackingWithTargetID(request *http.Request, targetID string) *http.Request {
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("target_id", targetID)
	return request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routeCtx))
}

func assumeOK(t *testing.T, response *httptest.ResponseRecorder, want int) map[string]any {
	t.Helper()
	if response.Code != want {
		t.Fatalf("status = %d, want %d; body=%s", response.Code, want, response.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return payload
}

func reviewTrackingError(t *testing.T, payload map[string]any) map[string]any {
	t.Helper()
	raw, ok := payload["error"].(map[string]any)
	if !ok {
		t.Fatalf("missing error envelope: %#v", payload)
	}
	return raw
}

func reviewTrackingTestHandler(store Store, now time.Time) *Handler {
	return NewHandler(store, Options{Now: func() time.Time { return now }})
}

func TestListTargetsAppliesCredentialScopeAndReturnsRules(t *testing.T) {
	now := time.Date(2026, 11, 8, 4, 0, 0, 0, time.UTC)
	lastRunAt := time.Date(2026, 11, 7, 3, 0, 0, 0, time.UTC)
	store := &reviewTrackingFakeStore{
		page: TargetPage{
			Items: []TargetItem{{
				TargetID:        11,
				Kind:            "external_asin",
				Marketplace:     "US",
				ASIN:            reviewTrackingStringPointer("B0TEST"),
				DisplayName:     reviewTrackingStringPointer("Competitor"),
				ExternalShopIDs: []int64{8},
				LastRun: &LastRun{
					RunID:     21,
					Status:    "success",
					StartedAt: lastRunAt.Format(time.RFC3339),
				},
			}},
			Total: 1,
		},
	}
	handler := reviewTrackingTestHandler(store, now)
	request := reviewTrackingTestRequest(
		t,
		http.MethodGet,
		"/api/v1/agent/review-tracking/targets?kind=external_asin&marketplace=us&limit=2&offset=5",
		"",
		agentauth.AgentCredential{AgentID: "agent-1", ProjectScope: "12, 34"},
	)
	response := httptest.NewRecorder()

	handler.ListTargets(response, request)
	payload := assumeOK(t, response, http.StatusOK)
	data := payload["data"].(map[string]any)
	if got := data["total"]; got != float64(1) {
		t.Fatalf("total = %#v, want 1", got)
	}
	rules := data["crawl_rules"].(map[string]any)
	if got := rules["business_timezone"]; got != "Asia/Shanghai" {
		t.Fatalf("business_timezone = %#v", got)
	}
	if store.pageFilter.ScopeAll {
		t.Fatalf("scope unexpectedly wildcard")
	}
	if got := store.pageFilter.ProjectIDs; len(got) != 2 || got[0] != 12 || got[1] != 34 {
		t.Fatalf("project scope IDs = %#v", got)
	}
	if got := store.pageFilter.Marketplace; got == nil || *got != "US" {
		t.Fatalf("marketplace filter = %#v", got)
	}
	if got := store.pageFilter.Kind; got == nil || *got != "external_asin" {
		t.Fatalf("kind filter = %#v", got)
	}
	if got := store.pageFilter.Limit; got != 2 {
		t.Fatalf("limit = %d", got)
	}
	if got := store.pageFilter.Offset; got != 5 {
		t.Fatalf("offset = %d", got)
	}
}

func TestListTargetsExplicitProjectOutsideScopeIs403(t *testing.T) {
	store := &reviewTrackingFakeStore{}
	handler := reviewTrackingTestHandler(store, time.Now())
	request := reviewTrackingTestRequest(
		t,
		http.MethodGet,
		"/api/v1/agent/review-tracking/targets?project_id=12",
		"",
		agentauth.AgentCredential{AgentID: "agent-1", ProjectScope: "99"},
	)
	response := httptest.NewRecorder()

	handler.ListTargets(response, request)
	payload := assumeOK(t, response, http.StatusForbidden)
	errorBody := reviewTrackingError(t, payload)
	if got := errorBody["code"]; got != agentauth.ErrorCodeAgentProjectOutOfScope {
		t.Fatalf("code = %#v", got)
	}
	if store.pageCalls != 0 {
		t.Fatalf("store queried after scope rejection: %d", store.pageCalls)
	}
}

func TestSubmitCrawlRunSuccessWritesAudit(t *testing.T) {
	now := time.Date(2026, 11, 8, 4, 0, 0, 0, time.UTC)
	capturedAt := now.Add(-30 * time.Minute)
	store := &reviewTrackingFakeStore{
		target: &Target{
			ID: 11, Kind: "internal_group", ProjectID: reviewTrackingInt64Pointer(12),
			Marketplace: "US", ASIN: reviewTrackingStringPointer("B0TEST"),
			IsActive: true,
		},
		insertResult: CrawlResult{
			TargetID: 11, RunID: 31, Status: "success", StartedAt: capturedAt,
			SnapshotUpdated: true, ReviewsUpserted: 1,
		},
	}
	handler := reviewTrackingTestHandler(store, now)
	body := `{
		"captured_at":"2026-11-08T11:30:00+08:00",
		"status":"success",
		"rating":{
			"average_rating":4.3,
			"rating_count":128,
			"review_count":96,
			"star_percentages":[7,3,6,20,64],
			"star_count_quality":"estimated"
		},
		"reviews":[{
			"review_key":"R1",
			"id_confidence":"original",
			"rating":5,
			"title":"great",
			"body":"ok",
			"review_date":"2026-10-10",
			"verified_purchase":true,
			"helpful_count":3
		}],
		"is_complete_list":true,
		"idempotency_key":"run-1",
		"asin_scraped":"B0TEST"
	}`
	request := reviewTrackingWithTargetID(
		reviewTrackingTestRequest(
			t,
			http.MethodPost,
			"/api/v1/agent/review-tracking/targets/11/runs",
			body,
			agentauth.AgentCredential{
				AgentID: "agent-1", Label: "Agent One", ProjectScope: "12",
			},
		),
		"11",
	)
	response := httptest.NewRecorder()

	handler.SubmitCrawlRun(response, request)
	payload := assumeOK(t, response, http.StatusOK)
	if got := payload["idempotency_key"]; got != "run-1" {
		t.Fatalf("idempotency_key = %#v", got)
	}
	data := payload["data"].(map[string]any)
	if got := data["capture_date"]; got != "2026-11-08" {
		t.Fatalf("capture_date = %#v", got)
	}
	if store.insertCalls != 1 {
		t.Fatalf("insert calls = %d", store.insertCalls)
	}
	if store.insertInput.Source == nil || *store.insertInput.Source != DefaultSource {
		t.Fatalf("source = %#v", store.insertInput.Source)
	}
	if len(store.auditEntries) != 1 {
		t.Fatalf("audit entries = %d", len(store.auditEntries))
	}
	entry := store.auditEntries[0]
	if entry.Action != "review_tracking.crawl_run" ||
		entry.AgentID == nil || *entry.AgentID != "agent-1" ||
		entry.AgentName == nil || *entry.AgentName != "Agent One" ||
		entry.IdempotencyKey == nil || *entry.IdempotencyKey != "run-1" {
		t.Fatalf("audit entry = %#v", entry)
	}
	after := entry.AfterJSON.(map[string]any)
	if got := after["capture_date"]; got != "2026-11-08" {
		t.Fatalf("audit capture_date = %#v", got)
	}
	if got := after["reviews_seen"]; got != 1 {
		t.Fatalf("audit reviews_seen = %#v", got)
	}
}

func TestSubmitCrawlRunReplaySkipsOrderGuardAndAudit(t *testing.T) {
	now := time.Date(2026, 11, 8, 4, 0, 0, 0, time.UTC)
	firstStarted := now.Add(-2 * time.Hour)
	latest := now.Add(-30 * time.Minute)
	store := &reviewTrackingFakeStore{
		target: &Target{
			ID: 11, Kind: "internal_group", ProjectID: reviewTrackingInt64Pointer(12),
			IsActive: true,
		},
		existingRun: &CrawlRun{
			ID: 31, TargetID: 11, Status: "success", StartedAt: firstStarted,
			IdempotencyKey: reviewTrackingStringPointer("run-1"),
		},
		latestAt: &latest,
	}
	handler := reviewTrackingTestHandler(store, now)
	body := `{
		"captured_at":"2026-11-08T09:30:00+08:00",
		"status":"success",
		"idempotency_key":"run-1"
	}`
	request := reviewTrackingWithTargetID(
		reviewTrackingTestRequest(
			t,
			http.MethodPost,
			"/api/v1/agent/review-tracking/targets/11/runs",
			body,
			agentauth.AgentCredential{AgentID: "agent-1", ProjectScope: "12"},
		),
		"11",
	)
	response := httptest.NewRecorder()

	handler.SubmitCrawlRun(response, request)
	payload := assumeOK(t, response, http.StatusOK)
	data := payload["data"].(map[string]any)
	if got := data["replayed"]; got != true {
		t.Fatalf("replayed = %#v", got)
	}
	if store.insertCalls != 0 {
		t.Fatalf("insert calls = %d", store.insertCalls)
	}
	if len(store.auditEntries) != 0 {
		t.Fatalf("replay wrote audit: %d", len(store.auditEntries))
	}
}

func TestSubmitCrawlRunFutureRejectedBeforeWrites(t *testing.T) {
	now := time.Date(2026, 11, 8, 4, 0, 0, 0, time.UTC)
	store := &reviewTrackingFakeStore{
		target: &Target{
			ID: 11, Kind: "internal_group", ProjectID: reviewTrackingInt64Pointer(12),
			IsActive: true,
		},
	}
	handler := reviewTrackingTestHandler(store, now)
	body := `{"captured_at":"2026-11-10T09:30:00+08:00","status":"failed"}`
	request := reviewTrackingWithTargetID(
		reviewTrackingTestRequest(
			t,
			http.MethodPost,
			"/api/v1/agent/review-tracking/targets/11/runs",
			body,
			agentauth.AgentCredential{AgentID: "agent-1", ProjectScope: "12"},
		),
		"11",
	)
	response := httptest.NewRecorder()

	handler.SubmitCrawlRun(response, request)
	payload := assumeOK(t, response, http.StatusBadRequest)
	errorBody := reviewTrackingError(t, payload)
	if got := errorBody["code"]; got != agentauth.ErrorCodeValidationFailed {
		t.Fatalf("code = %#v", got)
	}
	if got := errorBody["reason"]; got != "captured_at_in_future" {
		t.Fatalf("reason = %#v", got)
	}
	if store.insertCalls != 0 {
		t.Fatalf("insert calls = %d", store.insertCalls)
	}
}

func TestSubmitCrawlRunOutOfOrderReturns409Details(t *testing.T) {
	now := time.Date(2026, 11, 8, 4, 0, 0, 0, time.UTC)
	latest := now.Add(-30 * time.Minute)
	store := &reviewTrackingFakeStore{
		target: &Target{
			ID: 11, Kind: "internal_group", ProjectID: reviewTrackingInt64Pointer(12),
			IsActive: true,
		},
		latestAt: &latest,
	}
	handler := reviewTrackingTestHandler(store, now)
	body := `{"captured_at":"2026-11-08T09:30:00+08:00","status":"success"}`
	request := reviewTrackingWithTargetID(
		reviewTrackingTestRequest(
			t,
			http.MethodPost,
			"/api/v1/agent/review-tracking/targets/11/runs",
			body,
			agentauth.AgentCredential{AgentID: "agent-1", ProjectScope: "12"},
		),
		"11",
	)
	response := httptest.NewRecorder()

	handler.SubmitCrawlRun(response, request)
	payload := assumeOK(t, response, http.StatusConflict)
	errorBody := reviewTrackingError(t, payload)
	if got := errorBody["code"]; got != "REVIEW_TRACKING_CAPTURE_OUT_OF_ORDER" {
		t.Fatalf("code = %#v", got)
	}
	details := errorBody["details"].(map[string]any)
	if got := details["latest_started_at"]; got != latest.Format(time.RFC3339) {
		t.Fatalf("latest_started_at = %#v, want %s", got, latest.Format(time.RFC3339))
	}
	if store.insertCalls != 0 {
		t.Fatalf("insert calls = %d", store.insertCalls)
	}
}

func TestSubmitCrawlRunConcurrentDuplicateIsReportedAsReplay(t *testing.T) {
	now := time.Date(2026, 11, 8, 4, 0, 0, 0, time.UTC)
	capturedAt := now.Add(-30 * time.Minute)
	store := &reviewTrackingFakeStore{
		target: &Target{
			ID: 11, Kind: "internal_group", ProjectID: reviewTrackingInt64Pointer(12),
			IsActive: true,
		},
		insertResult: CrawlResult{
			TargetID: 11, RunID: 31, Status: "success", StartedAt: capturedAt,
			Replayed: true,
		},
	}
	handler := reviewTrackingTestHandler(store, now)
	body := `{
		"captured_at":"2026-11-08T11:30:00+08:00",
		"status":"success",
		"idempotency_key":"concurrent-1"
	}`
	request := reviewTrackingWithTargetID(
		reviewTrackingTestRequest(
			t,
			http.MethodPost,
			"/api/v1/agent/review-tracking/targets/11/runs",
			body,
			agentauth.AgentCredential{AgentID: "agent-1", ProjectScope: "12"},
		),
		"11",
	)
	response := httptest.NewRecorder()

	handler.SubmitCrawlRun(response, request)
	payload := assumeOK(t, response, http.StatusOK)
	data := payload["data"].(map[string]any)
	if got := data["replayed"]; got != true {
		t.Fatalf("replayed = %#v", got)
	}
	if len(store.auditEntries) != 0 {
		t.Fatalf("concurrent duplicate wrote audit")
	}
}

func TestSubmitCrawlRunAuditFailureRollsBack(t *testing.T) {
	now := time.Date(2026, 11, 8, 4, 0, 0, 0, time.UTC)
	store := &reviewTrackingFakeStore{
		target: &Target{
			ID: 11, Kind: "internal_group", ProjectID: reviewTrackingInt64Pointer(12),
			IsActive: true,
		},
		insertResult: CrawlResult{
			TargetID: 11, RunID: 31, Status: "success", StartedAt: now.Add(-time.Hour),
			SnapshotUpdated: true,
		},
		auditErr: errors.New("audit unavailable"),
	}
	handler := reviewTrackingTestHandler(store, now)
	body := `{"captured_at":"2026-11-08T11:00:00+08:00","status":"success"}`
	request := reviewTrackingWithTargetID(
		reviewTrackingTestRequest(
			t,
			http.MethodPost,
			"/api/v1/agent/review-tracking/targets/11/runs",
			body,
			agentauth.AgentCredential{AgentID: "agent-1", ProjectScope: "12"},
		),
		"11",
	)
	response := httptest.NewRecorder()

	handler.SubmitCrawlRun(response, request)
	payload := assumeOK(t, response, http.StatusInternalServerError)
	errorBody := reviewTrackingError(t, payload)
	if got := errorBody["code"]; got != agentauth.ErrorCodeInternalError {
		t.Fatalf("code = %#v", got)
	}
	if !store.rolledBack {
		t.Fatalf("audit failure did not roll back transaction")
	}
}

func TestSubmitCrawlRunValidationAndIdempotencyConflicts(t *testing.T) {
	now := time.Date(2026, 11, 8, 4, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		body   string
		header string
	}{
		{"naive time", `{"captured_at":"2026-11-08T09:30:00","status":"success"}`, ""},
		{"bad status", `{"captured_at":"2026-11-08T09:30:00+08:00","status":"部分成功"}`, ""},
		{"star percentages length", `{"captured_at":"2026-11-08T09:30:00+08:00","status":"success","rating":{"star_percentages":[1,2,3,4]}}`, ""},
		{"null star quality", `{"captured_at":"2026-11-08T09:30:00+08:00","status":"success","rating":{"star_count_quality":null}}`, ""},
		{"null complete list", `{"captured_at":"2026-11-08T09:30:00+08:00","status":"success","is_complete_list":null}`, ""},
		{"rating range", `{"captured_at":"2026-11-08T09:30:00+08:00","status":"success","reviews":[{"review_key":"R1","id_confidence":"original","rating":6}]}`, ""},
		{"int4 overflow", `{"captured_at":"2026-11-08T09:30:00+08:00","status":"success","rating":{"rating_count":2147483648}}`, ""},
		{"unknown field", `{"captured_at":"2026-11-08T09:30:00+08:00","status":"success","review":[]}`, ""},
		{"blank body idempotency", `{"captured_at":"2026-11-08T09:30:00+08:00","status":"success","idempotency_key":"   "}`, ""},
		{"blank header idempotency", `{"captured_at":"2026-11-08T09:30:00+08:00","status":"success"}`, "   "},
		{"header body mismatch", `{"captured_at":"2026-11-08T09:30:00+08:00","status":"success","idempotency_key":"body"}`, "header"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &reviewTrackingFakeStore{
				target: &Target{
					ID: 11, Kind: "internal_group", ProjectID: reviewTrackingInt64Pointer(12),
					IsActive: true,
				},
			}
			handler := reviewTrackingTestHandler(store, now)
			request := reviewTrackingWithTargetID(
				reviewTrackingTestRequest(
					t,
					http.MethodPost,
					"/api/v1/agent/review-tracking/targets/11/runs",
					tt.body,
					agentauth.AgentCredential{AgentID: "agent-1", ProjectScope: "12"},
				),
				"11",
			)
			if tt.header != "" {
				request.Header.Set("Idempotency-Key", tt.header)
			}
			response := httptest.NewRecorder()
			handler.SubmitCrawlRun(response, request)
			payload := assumeOK(t, response, http.StatusBadRequest)
			errorBody := reviewTrackingError(t, payload)
			if got := errorBody["code"]; got != agentauth.ErrorCodeValidationFailed {
				t.Fatalf("code = %#v", got)
			}
			if store.insertCalls != 0 {
				t.Fatalf("validation failure wrote run")
			}
		})
	}
}

func TestSubmitCrawlRunTargetNotFoundAndScope(t *testing.T) {
	now := time.Date(2026, 11, 8, 4, 0, 0, 0, time.UTC)
	tests := []struct {
		name       string
		target     *Target
		credential agentauth.AgentCredential
		status     int
		code       string
	}{
		{
			name:       "not found",
			target:     nil,
			credential: agentauth.AgentCredential{AgentID: "agent-1", ProjectScope: "*"},
			status:     http.StatusNotFound,
			code:       "RESOURCE_NOT_FOUND",
		},
		{
			name: "inactive",
			target: &Target{
				ID: 11, Kind: "internal_group", ProjectID: reviewTrackingInt64Pointer(12),
				IsActive: false,
			},
			credential: agentauth.AgentCredential{AgentID: "agent-1", ProjectScope: "*"},
			status:     http.StatusNotFound,
			code:       "RESOURCE_NOT_FOUND",
		},
		{
			name: "out of project scope",
			target: &Target{
				ID: 11, Kind: "internal_group", ProjectID: reviewTrackingInt64Pointer(12),
				IsActive: true,
			},
			credential: agentauth.AgentCredential{AgentID: "agent-1", ProjectScope: "99"},
			status:     http.StatusForbidden,
			code:       agentauth.ErrorCodeAgentProjectOutOfScope,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &reviewTrackingFakeStore{target: tt.target}
			handler := reviewTrackingTestHandler(store, now)
			body := `{"captured_at":"2026-11-08T09:30:00+08:00","status":"success"}`
			request := reviewTrackingWithTargetID(
				reviewTrackingTestRequest(
					t,
					http.MethodPost,
					"/api/v1/agent/review-tracking/targets/11/runs",
					body,
					tt.credential,
				),
				"11",
			)
			response := httptest.NewRecorder()
			handler.SubmitCrawlRun(response, request)
			payload := assumeOK(t, response, tt.status)
			errorBody := reviewTrackingError(t, payload)
			if got := errorBody["code"]; got != tt.code {
				t.Fatalf("code = %#v, want %s", got, tt.code)
			}
			if store.insertCalls != 0 {
				t.Fatalf("rejected target wrote run")
			}
		})
	}
}

func TestSubmitExternalTargetIsWritableAcrossProjectScope(t *testing.T) {
	now := time.Date(2026, 11, 8, 4, 0, 0, 0, time.UTC)
	capturedAt := now.Add(-30 * time.Minute)
	store := &reviewTrackingFakeStore{
		target: &Target{
			ID: 11, Kind: "external_asin", Marketplace: "US",
			ASIN: reviewTrackingStringPointer("B0COMPETITOR"), IsActive: true,
		},
		insertResult: CrawlResult{
			TargetID: 11, RunID: 31, Status: "success", StartedAt: capturedAt,
			SnapshotUpdated: true,
		},
	}
	handler := reviewTrackingTestHandler(store, now)
	body := `{
		"captured_at":"2026-11-08T11:30:00+08:00",
		"status":"success",
		"asin_scraped":"B0COMPETITOR"
	}`
	request := reviewTrackingWithTargetID(
		reviewTrackingTestRequest(
			t,
			http.MethodPost,
			"/api/v1/agent/review-tracking/targets/11/runs",
			body,
			agentauth.AgentCredential{AgentID: "agent-1", ProjectScope: "999"},
		),
		"11",
	)
	response := httptest.NewRecorder()

	handler.SubmitCrawlRun(response, request)
	payload := assumeOK(t, response, http.StatusOK)
	data := payload["data"].(map[string]any)
	if got := data["snapshot_updated"]; got != true {
		t.Fatalf("snapshot_updated = %#v", got)
	}
	if store.insertCalls != 1 {
		t.Fatalf("external target insert calls = %d", store.insertCalls)
	}
}

func TestHandlersFailClosedWithoutStore(t *testing.T) {
	handler := NewHandler(nil, Options{Now: time.Now})
	for name, call := range map[string]func(http.ResponseWriter, *http.Request){
		"list": func(w http.ResponseWriter, r *http.Request) {
			handler.ListTargets(w, r)
		},
		"submit": func(w http.ResponseWriter, r *http.Request) {
			handler.SubmitCrawlRun(w, reviewTrackingWithTargetID(r, "1"))
		},
	} {
		t.Run(name, func(t *testing.T) {
			request := reviewTrackingTestRequest(
				t,
				http.MethodGet,
				"/api/v1/agent/review-tracking/targets",
				"",
				agentauth.AgentCredential{AgentID: "agent-1", ProjectScope: "*"},
			)
			response := httptest.NewRecorder()
			call(response, request)
			payload := assumeOK(t, response, http.StatusServiceUnavailable)
			if got := reviewTrackingError(t, payload)["code"]; got != "INTERNAL_ERROR" {
				t.Fatalf("code = %#v", got)
			}
		})
	}
}

func TestRegisterRoutesAndModuleName(t *testing.T) {
	credentialStore := &reviewTrackingCredentials{
		row: agentauth.CredentialRow{
			KeyID: 1, AgentID: "agent-1", Label: "Agent One",
			BusinessScope: "review_tracking", ProjectScope: "*",
		},
	}
	store := &reviewTrackingFakeStore{page: TargetPage{Items: []TargetItem{}, Total: 0}}
	registrar := NewRegistrar(store, Options{Credentials: credentialStore})
	if got := registrar.ModuleName(); got != ModuleName {
		t.Fatalf("ModuleName() = %q", got)
	}
	router := chi.NewRouter()
	registrar.RegisterRoutes(router, func(next http.Handler) http.Handler { return next })

	request := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/agent/review-tracking/targets",
		nil,
	)
	request.Header.Set("Authorization", "Bearer review-tracking-token")
	request.Header.Set("X-Agent-Id", "agent-1")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", response.Code, response.Body.String())
	}
}

func TestRegistrarEnforcesAgentAuthenticationAndBusinessScope(t *testing.T) {
	credentialStore := &reviewTrackingCredentials{
		row: agentauth.CredentialRow{
			KeyID: 1, AgentID: "agent-1", Label: "Agent One",
			BusinessScope: "shipments", ProjectScope: "*",
		},
	}
	store := &reviewTrackingFakeStore{page: TargetPage{Items: []TargetItem{}, Total: 0}}
	registrar := NewRegistrar(store, Options{Credentials: credentialStore})
	router := chi.NewRouter()
	registrar.RegisterRoutes(router, func(next http.Handler) http.Handler { return next })

	missingAuth := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/agent/review-tracking/targets",
		nil,
	)
	missingAuthResponse := httptest.NewRecorder()
	router.ServeHTTP(missingAuthResponse, missingAuth)
	if missingAuthResponse.Code != http.StatusUnauthorized {
		t.Fatalf("missing auth status = %d", missingAuthResponse.Code)
	}

	badScope := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/agent/review-tracking/targets",
		nil,
	)
	badScope.Header.Set("Authorization", "Bearer review-tracking-token")
	badScope.Header.Set("X-Agent-Id", "agent-1")
	badScopeResponse := httptest.NewRecorder()
	router.ServeHTTP(badScopeResponse, badScope)
	if badScopeResponse.Code != http.StatusForbidden {
		t.Fatalf("bad scope status = %d; body=%s", badScopeResponse.Code, badScopeResponse.Body.String())
	}
	if store.pageCalls != 0 {
		t.Fatalf("business scope rejection reached store")
	}
}

type reviewTrackingCredentials struct {
	row agentauth.CredentialRow
}

func (store *reviewTrackingCredentials) FindByHash(
	_ context.Context,
	keyHash string,
) (*agentauth.CredentialRow, error) {
	if keyHash != agentauth.HashAgentToken("review-tracking-token") {
		return nil, nil
	}
	row := store.row
	return &row, nil
}

func (*reviewTrackingCredentials) TouchLastUsed(context.Context, int64, time.Time) error {
	return nil
}

func reviewTrackingStringPointer(value string) *string {
	return &value
}

func reviewTrackingInt64Pointer(value int64) *int64 {
	return &value
}
