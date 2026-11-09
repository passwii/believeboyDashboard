package contract

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	agent_review_tracking "github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_review_tracking"
)

const (
	agentReviewTrackingToken   = "review-tracking-contract-token"
	agentReviewTrackingAgentID = "review-tracking-contract-agent"
)

type agentReviewTrackingCredentials struct {
	businessScope string
	projectScope  string
}

func (credentials *agentReviewTrackingCredentials) FindByHash(
	_ context.Context,
	keyHash string,
) (*agentauth.CredentialRow, error) {
	if keyHash != agentauth.HashAgentToken(agentReviewTrackingToken) {
		return nil, nil
	}
	return &agentauth.CredentialRow{
		KeyID:         42,
		AgentID:       agentReviewTrackingAgentID,
		Label:         "Review Tracking Agent",
		BusinessScope: credentials.businessScope,
		ProjectScope:  credentials.projectScope,
	}, nil
}

func (*agentReviewTrackingCredentials) TouchLastUsed(
	context.Context,
	int64,
	time.Time,
) error {
	return nil
}

type agentReviewTrackingContractStore struct {
	page         agent_review_tracking.TargetPage
	target       *agent_review_tracking.Target
	latest       *time.Time
	existing     *agent_review_tracking.CrawlRun
	insertResult agent_review_tracking.CrawlResult
	auditEntries []agent_review_tracking.AuditEntry
	insertCalls  int
}

func (store *agentReviewTrackingContractStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, agent_review_tracking.Store) error,
) error {
	return fn(ctx, nil, store)
}

func (store *agentReviewTrackingContractStore) ListTargets(
	context.Context,
	agent_review_tracking.TargetListFilter,
) (agent_review_tracking.TargetPage, error) {
	return store.page, nil
}

func (store *agentReviewTrackingContractStore) GetTargetForUpdate(
	context.Context,
	int64,
) (*agent_review_tracking.Target, error) {
	return store.target, nil
}

func (store *agentReviewTrackingContractStore) FindRunByIdempotency(
	context.Context,
	int64,
	*string,
) (*agent_review_tracking.CrawlRun, error) {
	return store.existing, nil
}

func (store *agentReviewTrackingContractStore) LatestStartedAt(
	context.Context,
	int64,
	time.Time,
) (*time.Time, error) {
	return store.latest, nil
}

func (store *agentReviewTrackingContractStore) InsertCrawlResult(
	context.Context,
	agent_review_tracking.CrawlResultInput,
) (agent_review_tracking.CrawlResult, error) {
	store.insertCalls++
	return store.insertResult, nil
}

func (store *agentReviewTrackingContractStore) LogAudit(
	_ context.Context,
	_ pgx.Tx,
	entry agent_review_tracking.AuditEntry,
) error {
	store.auditEntries = append(store.auditEntries, entry)
	return nil
}

func agentReviewTrackingRouter(
	store agent_review_tracking.Store,
	credentials agentauth.CredentialStore,
) chi.Router {
	router := chi.NewRouter()
	agent_review_tracking.NewRegistrar(store, agent_review_tracking.Options{
		Credentials: credentials,
		Now: func() time.Time {
			return time.Date(2026, 11, 8, 4, 0, 0, 0, time.UTC)
		},
	}).RegisterRoutes(router, func(next http.Handler) http.Handler {
		return next
	})
	return router
}

func agentReviewTrackingHeaders() http.Header {
	return http.Header{
		"Authorization": []string{"Bearer " + agentReviewTrackingToken},
		"X-Agent-Id":    []string{agentReviewTrackingAgentID},
		"Content-Type":  []string{"application/json"},
	}
}

func TestAgentReviewTrackingRoutesAndContracts(t *testing.T) {
	defaultCredentials := &agentReviewTrackingCredentials{
		businessScope: "review_tracking",
		projectScope:  "*",
	}

	t.Run("module and list contract", func(t *testing.T) {
		lastStarted := time.Date(2026, 11, 7, 3, 0, 0, 0, time.UTC)
		store := &agentReviewTrackingContractStore{
			page: agent_review_tracking.TargetPage{
				Items: []agent_review_tracking.TargetItem{{
					TargetID:        7,
					Kind:            "internal_group",
					GroupID:         agentReviewTrackingInt64(3),
					ProjectID:       agentReviewTrackingInt64(11),
					Marketplace:     "US",
					ASIN:            agentReviewTrackingString("B0CONTRACT"),
					ExternalShopIDs: []int64{},
					LastRun: &agent_review_tracking.LastRun{
						RunID:     9,
						Status:    "success",
						StartedAt: lastStarted.Format(time.RFC3339),
					},
				}},
				Total: 1,
			},
		}
		router := agentReviewTrackingRouter(store, defaultCredentials)
		response := agentReviewTrackingServe(
			router,
			http.MethodGet,
			"/api/v1/agent/review-tracking/targets",
			"",
		)
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d; body=%s", response.Code, response.Body.String())
		}
		var payload map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode: %v", err)
		}
		data := payload["data"].(map[string]any)
		rules := data["crawl_rules"].(map[string]any)
		if rules["business_timezone"] != "Asia/Shanghai" ||
			rules["max_reviews_per_run"] != float64(500) {
			t.Fatalf("crawl_rules = %#v", rules)
		}
		if got := agent_review_tracking.NewRegistrar(
			store,
			agent_review_tracking.Options{Credentials: defaultCredentials},
		).ModuleName(); got != "agent_review_tracking" {
			t.Fatalf("ModuleName() = %q", got)
		}
	})

	t.Run("missing business scope", func(t *testing.T) {
		router := agentReviewTrackingRouter(
			&agentReviewTrackingContractStore{},
			&agentReviewTrackingCredentials{
				businessScope: "shipments",
				projectScope:  "*",
			},
		)
		response := agentReviewTrackingServe(
			router,
			http.MethodGet,
			"/api/v1/agent/review-tracking/targets",
			"",
		)
		if response.Code != http.StatusForbidden {
			t.Fatalf("status = %d; body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("successful run writes audit", func(t *testing.T) {
		capturedAt := time.Date(2026, 11, 8, 3, 30, 0, 0, time.UTC)
		store := &agentReviewTrackingContractStore{
			target: &agent_review_tracking.Target{
				ID:        7,
				Kind:      "internal_group",
				ProjectID: agentReviewTrackingInt64(11),
				IsActive:  true,
			},
			insertResult: agent_review_tracking.CrawlResult{
				TargetID:        7,
				RunID:           10,
				Status:          "success",
				StartedAt:       capturedAt,
				SnapshotUpdated: true,
				ReviewsUpserted: 1,
			},
		}
		router := agentReviewTrackingRouter(
			store,
			&agentReviewTrackingCredentials{
				businessScope: "review_tracking",
				projectScope:  "11",
			},
		)
		body := `{
			"captured_at":"2026-11-08T11:30:00+08:00",
			"status":"success",
			"rating":{"average_rating":4.5,"star_count_quality":"exact"},
			"reviews":[],
			"is_complete_list":true,
			"idempotency_key":"contract-run"
		}`
		response := agentReviewTrackingServe(
			router,
			http.MethodPost,
			"/api/v1/agent/review-tracking/targets/7/runs",
			body,
		)
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d; body=%s", response.Code, response.Body.String())
		}
		if store.insertCalls != 1 || len(store.auditEntries) != 1 {
			t.Fatalf("insert=%d audit=%d", store.insertCalls, len(store.auditEntries))
		}
		entry := store.auditEntries[0]
		if entry.IdempotencyKey == nil || *entry.IdempotencyKey != "contract-run" ||
			entry.AgentID == nil || *entry.AgentID != agentReviewTrackingAgentID {
			t.Fatalf("audit entry = %#v", entry)
		}
	})

	t.Run("out of order", func(t *testing.T) {
		latest := time.Date(2026, 11, 8, 3, 45, 0, 0, time.UTC)
		store := &agentReviewTrackingContractStore{
			target: &agent_review_tracking.Target{
				ID:        7,
				Kind:      "internal_group",
				ProjectID: agentReviewTrackingInt64(11),
				IsActive:  true,
			},
			latest: &latest,
		}
		router := agentReviewTrackingRouter(
			store,
			&agentReviewTrackingCredentials{
				businessScope: "review_tracking",
				projectScope:  "11",
			},
		)
		body := `{"captured_at":"2026-11-08T11:30:00+08:00","status":"success"}`
		response := agentReviewTrackingServe(
			router,
			http.MethodPost,
			"/api/v1/agent/review-tracking/targets/7/runs",
			body,
		)
		if response.Code != http.StatusConflict {
			t.Fatalf("status = %d; body=%s", response.Code, response.Body.String())
		}
		payload := map[string]any{}
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode: %v", err)
		}
		errorBody := payload["error"].(map[string]any)
		if errorBody["code"] != "REVIEW_TRACKING_CAPTURE_OUT_OF_ORDER" {
			t.Fatalf("error = %#v", errorBody)
		}
	})

	t.Run("inactive target is 404", func(t *testing.T) {
		store := &agentReviewTrackingContractStore{
			target: &agent_review_tracking.Target{
				ID:        7,
				Kind:      "internal_group",
				ProjectID: agentReviewTrackingInt64(11),
				IsActive:  false,
			},
		}
		router := agentReviewTrackingRouter(
			store,
			&agentReviewTrackingCredentials{
				businessScope: "review_tracking",
				projectScope:  "*",
			},
		)
		response := agentReviewTrackingServe(
			router,
			http.MethodPost,
			"/api/v1/agent/review-tracking/targets/7/runs",
			`{"captured_at":"2026-11-08T11:30:00+08:00","status":"success"}`,
		)
		if response.Code != http.StatusNotFound {
			t.Fatalf("status = %d; body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("nil store fails closed", func(t *testing.T) {
		router := agentReviewTrackingRouter(nil, defaultCredentials)
		response := agentReviewTrackingServe(
			router,
			http.MethodGet,
			"/api/v1/agent/review-tracking/targets",
			"",
		)
		if response.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d; body=%s", response.Code, response.Body.String())
		}
	})
}

func agentReviewTrackingServe(
	router http.Handler,
	method string,
	target string,
	body string,
) *httptest.ResponseRecorder {
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, target, reader)
	request.Header = agentReviewTrackingHeaders()
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func agentReviewTrackingString(value string) *string {
	return &value
}

func agentReviewTrackingInt64(value int64) *int64 {
	return &value
}
