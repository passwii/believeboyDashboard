package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/crm_intent"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/blob"
)

const (
	stage10APIKey     = "stage10-key"
	stage10AgentToken = "stage10-agent-token"
	stage10AgentID    = "local-intent-screening"
	stage10ReadLimit  = 120
	stage10WriteLimit = 30
	stage10BatchLimit = 60
)

// ---------- fake store ----------

type stage10Idempotency struct {
	hash      string
	response  []byte
	completed bool
}

type stage10Store struct {
	crm_intent.Store
	mu              sync.Mutex
	dataRev         int64
	followupRev     int64
	company         *crm_intent.Company
	locked          bool
	versionConflict bool
	exported        int
	exportRows      int
	ingestRequests  []crm_intent.IngestRequest
	batchCreates    []crm_intent.BatchCreate
	idempotency     map[string]*stage10Idempotency
	blobWrites      int
	attachError     bool
	lastDetailScope crm_intent.Scope
	listScopes      []crm_intent.CompanyFilter
}

func newStage10Store() *stage10Store {
	return &stage10Store{
		dataRev: 31, followupRev: 12,
		company:     stage10Company(),
		idempotency: map[string]*stage10Idempotency{},
	}
}

func stage10Company() *crm_intent.Company {
	return &crm_intent.Company{
		ID: 42, Name: "示例企业", IntentLevel: "A", IntentLevelLabel: "强意向",
		IntentScore: stage10Int(86), HumanTouched: true,
		Owner: &crm_intent.OwnerBrief{ID: "user-1", Name: stage10String("张三")},
		Phones: []crm_intent.Phone{{
			ID: 1, PhoneRaw: "13800000001", PhoneNormalized: "13800000001",
			Source: "list", CreatedAt: "2026-11-10T00:00:00Z",
		}},
		Followup: crm_intent.Followup{
			CompanyID: 42, State: "quoted", StateLabel: "已报价", Version: 3,
			ValidPhones: []string{}, UpdatedAt: "2026-11-10T00:00:00Z",
		},
		Trademarks: []string{}, Sources: []string{},
		Channel: stage10String("展会"), Channels: []string{"展会", "官网"},
		ChannelSource: stage10String("展会-2026-11-10.csv"),
		CreatedAt:     "2026-11-10T00:00:00Z", UpdatedAt: "2026-11-10T00:00:00Z",
	}
}

func stage10String(value string) *string { return &value }
func stage10Int(value int) *int          { return &value }
func stage10Int64(value int64) *int64    { return &value }

func (store *stage10Store) GetRevisions(context.Context) (int64, int64, error) {
	return store.dataRev, store.followupRev, nil
}

func (store *stage10Store) GetMetaData(context.Context, crm_intent.Scope) (crm_intent.MetaData, error) {
	return crm_intent.MetaData{
		Batch: &crm_intent.BatchBrief{ID: 7, Total: 128, PoolTotal: 80},
		Stats: crm_intent.Stats{
			Total: 128, ByLevel: map[string]int{"A": 10, "B": 30, "C": 50, "D": 38},
			PoolTotal: 80,
		},
		Facets: crm_intent.Facets{
			Levels: crm_intent.IntentLevels(), States: []crm_intent.StateFacet{},
			Categories: []string{}, Channels: []string{"展会", "官网"},
			Provinces: []string{}, Cities: []crm_intent.FacetCities{},
		},
	}, nil
}

func (store *stage10Store) GetFacets(context.Context, crm_intent.Scope) (crm_intent.Facets, error) {
	return crm_intent.Facets{Levels: crm_intent.IntentLevels()}, nil
}

func (store *stage10Store) GetBoard(context.Context, crm_intent.Scope) ([]crm_intent.BoardColumn, error) {
	return []crm_intent.BoardColumn{}, nil
}

func (store *stage10Store) ListCompanies(_ context.Context, filter crm_intent.CompanyFilter) (crm_intent.Paginated[crm_intent.Company], error) {
	store.mu.Lock()
	store.listScopes = append(store.listScopes, filter)
	store.mu.Unlock()
	return crm_intent.Paginated[crm_intent.Company]{
		Items: []crm_intent.Company{*store.company}, Total: 1, Page: 1, PageSize: 24,
	}, nil
}

func (store *stage10Store) ListCompaniesForExport(context.Context, crm_intent.CompanyFilter) ([]crm_intent.Company, error) {
	return []crm_intent.Company{*store.company}, nil
}

func (store *stage10Store) GetCompany(_ context.Context, _ int64, scope crm_intent.Scope) (*crm_intent.Company, error) {
	store.mu.Lock()
	store.lastDetailScope = scope
	store.mu.Unlock()
	return store.company, nil
}

func (store *stage10Store) ClaimCompany(context.Context, int64, crm_intent.Actor) (*crm_intent.Company, error) {
	return store.company, nil
}

func (store *stage10Store) UpdateProfile(context.Context, int64, crm_intent.ProfileUpdateInput, crm_intent.Actor) (*crm_intent.Company, error) {
	return store.company, nil
}

func (store *stage10Store) UpdateFollowup(context.Context, int64, crm_intent.FollowupWrite, crm_intent.Actor) (*crm_intent.Followup, error) {
	if store.versionConflict {
		conflict := crm_intent.NewConflictError("INTENT_VERSION_CONFLICT", "记录已被其他人更新")
		current := crm_intent.Followup{
			CompanyID: 42, State: "quoted", StateLabel: "已报价", Version: 4,
			ValidPhones: []string{}, UpdatedAt: "2026-11-10T00:00:00Z",
		}
		conflict.Current = &current
		return nil, conflict
	}
	return &crm_intent.Followup{
		CompanyID: 42, State: "quoted", StateLabel: "已报价", Version: 4,
		ValidPhones: []string{}, UpdatedAt: "2026-11-10T00:00:00Z",
	}, nil
}

func (store *stage10Store) AddPhone(context.Context, int64, crm_intent.PhoneCreate, crm_intent.Actor) (*crm_intent.Company, error) {
	return store.company, nil
}

func (store *stage10Store) UpdatePhone(context.Context, int64, int64, crm_intent.PhoneUpdate, crm_intent.Actor) (*crm_intent.Company, error) {
	return store.company, nil
}

func (store *stage10Store) DeletePhone(context.Context, int64, int64, crm_intent.Actor) (*crm_intent.Company, error) {
	return store.company, nil
}

func (store *stage10Store) ConvertCompany(context.Context, int64, crm_intent.Actor) (*crm_intent.ConvertResult, error) {
	return &crm_intent.ConvertResult{
		CompanyID: 42, CustomerID: 900, Company: store.company, DataRev: 33,
	}, nil
}

func (store *stage10Store) ListPool(context.Context, crm_intent.PoolFilter) (crm_intent.Paginated[crm_intent.PoolItem], error) {
	return crm_intent.Paginated[crm_intent.PoolItem]{
		Items: []crm_intent.PoolItem{}, Total: 0, Page: 1, PageSize: 60,
	}, nil
}

func (store *stage10Store) LatestBatchDate(context.Context) (*string, error) {
	value := "2026-11-10"
	return &value, nil
}

func (store *stage10Store) ListBatches(context.Context, int, int) (crm_intent.Paginated[crm_intent.Batch], error) {
	return crm_intent.Paginated[crm_intent.Batch]{
		Items: []crm_intent.Batch{}, Total: 0, Page: 1, PageSize: 20,
	}, nil
}

func (store *stage10Store) GetBatch(context.Context, int64) (*crm_intent.BatchDetail, error) {
	return &crm_intent.BatchDetail{
		Batch: crm_intent.Batch{
			ID: 7, BatchDate: "2026-11-10", Source: "ai", Status: "completed",
			CreatedCount: 1, RejectedCount: 1, CreatedAt: "2026-11-10T00:00:00Z",
		},
		Rejected: []crm_intent.RejectedRow{},
		Rows: []crm_intent.BatchRow{
			{Scope: "companies", Index: 0, Status: "created", CompanyID: stage10Int64(42)},
			{Scope: "companies", Index: 1, Status: "rejected",
				Reason: "registered_capital_wan must be a number"},
			{Scope: "pool", Index: 0, Status: "skipped_locked"},
		},
	}, nil
}

func (store *stage10Store) CreateBatch(_ context.Context, input crm_intent.BatchCreate) (int64, error) {
	store.mu.Lock()
	store.batchCreates = append(store.batchCreates, input)
	store.mu.Unlock()
	return 7, nil
}

func (store *stage10Store) AttachBatchArchive(context.Context, int64, string, string) error {
	if store.attachError {
		return errors.New("archive attach failed")
	}
	return nil
}

func (store *stage10Store) FailBatch(context.Context, int64, string) error { return nil }

func (store *stage10Store) IngestBatch(_ context.Context, request crm_intent.IngestRequest) (crm_intent.IngestResult, error) {
	store.mu.Lock()
	store.ingestRequests = append(store.ingestRequests, request)
	store.mu.Unlock()
	rows := make([]crm_intent.BatchRow, 0)
	for _, rejected := range request.Rejected {
		rows = append(rows, crm_intent.BatchRow{
			Scope: rejected.Scope, Index: rejected.Index,
			ExternalID: rejected.ExternalID, Status: "rejected", Reason: rejected.Reason,
		})
	}
	for index := range request.Companies {
		rows = append(rows, crm_intent.BatchRow{
			Scope: "companies", Index: index, Status: "created",
			CompanyID: stage10Int64(42),
		})
	}
	for index := range request.Pool {
		rows = append(rows, crm_intent.BatchRow{Scope: "pool", Index: index, Status: "created"})
	}
	return crm_intent.IngestResult{
		BatchID: request.BatchID, Status: crm_intent.BatchCompleted,
		Created: len(request.Companies), Updated: len(request.Pool),
		Rejected: request.Rejected, RejectedCount: len(request.Rejected),
		Rows: rows, CompaniesTotal: len(request.Companies),
		PoolTotal: len(request.Pool), DataRev: 32,
	}, nil
}

func (store *stage10Store) ReserveImportRequest(
	_ context.Context,
	actorKind string,
	actorID string,
	idempotencyKey string,
	requestHash string,
) (*crm_intent.ImportRequestState, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	composite := actorKind + "|" + actorID + "|" + idempotencyKey
	if record, ok := store.idempotency[composite]; ok {
		if record.hash != requestHash {
			return nil, crm_intent.ErrIdempotencyConflict
		}
		if record.completed {
			return &crm_intent.ImportRequestState{
				Replay: true, Response: json.RawMessage(record.response),
			}, nil
		}
		return nil, crm_intent.ErrIdempotencyInFlight
	}
	store.idempotency[composite] = &stage10Idempotency{hash: requestHash}
	return &crm_intent.ImportRequestState{ID: 1}, nil
}

func (store *stage10Store) CompleteImportRequest(
	_ context.Context,
	actorKind string,
	actorID string,
	idempotencyKey string,
	response []byte,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	composite := actorKind + "|" + actorID + "|" + idempotencyKey
	record, ok := store.idempotency[composite]
	if !ok {
		record = &stage10Idempotency{}
		store.idempotency[composite] = record
	}
	record.response = response
	record.completed = true
	return nil
}

func (store *stage10Store) DeleteImportRequest(
	_ context.Context,
	actorKind string,
	actorID string,
	idempotencyKey string,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	delete(store.idempotency, actorKind+"|"+actorID+"|"+idempotencyKey)
	return nil
}

func (store *stage10Store) AgentUpsertCompany(
	_ context.Context,
	_ crm_intent.CompanyInput,
	_ string,
	_ crm_intent.Actor,
) (crm_intent.AgentUpsertResult, error) {
	if store.locked {
		return crm_intent.AgentUpsertResult{}, crm_intent.NewLockedError(42)
	}
	return crm_intent.AgentUpsertResult{CompanyID: 42, Created: true, DataRev: 33}, nil
}

func (store *stage10Store) AgentPatchCompany(
	context.Context,
	int64,
	crm_intent.AgentCompanyPatch,
	crm_intent.Actor,
) (*crm_intent.AgentCompanyItem, error) {
	if store.locked {
		return nil, crm_intent.NewLockedError(42)
	}
	return &crm_intent.AgentCompanyItem{ID: 42, Name: "示例企业", State: "none",
		Phones: []string{}, UpdatedAt: "2026-11-10T00:00:00Z"}, nil
}

func (store *stage10Store) AgentListCompanies(
	context.Context,
	crm_intent.AgentCompanyFilter,
) (crm_intent.Paginated[crm_intent.AgentCompanyItem], error) {
	return crm_intent.Paginated[crm_intent.AgentCompanyItem]{
		Items: []crm_intent.AgentCompanyItem{}, Total: 0, Page: 1, PageSize: 50,
	}, nil
}

func (store *stage10Store) AgentGetCompany(context.Context, int64) (*crm_intent.AgentCompanyItem, error) {
	return &crm_intent.AgentCompanyItem{ID: 42, Name: "示例企业", State: "none",
		Phones: []string{}, UpdatedAt: "2026-11-10T00:00:00Z"}, nil
}

func (store *stage10Store) AgentUpdatePool(context.Context, int64, crm_intent.AgentPoolUpdate, crm_intent.Actor) (*crm_intent.PoolItem, error) {
	return &crm_intent.PoolItem{ID: 9, Name: "池记录", Status: "ignored",
		Channels: []string{}, Phones: []crm_intent.Phone{},
		CreatedAt: "2026-11-10T00:00:00Z", UpdatedAt: "2026-11-10T00:00:00Z"}, nil
}

func (store *stage10Store) AgentScreenPool(context.Context, int64, crm_intent.CompanyInput, crm_intent.Actor) (crm_intent.AgentScreenResult, error) {
	if store.locked {
		return crm_intent.AgentScreenResult{}, crm_intent.NewLockedError(42)
	}
	return crm_intent.AgentScreenResult{
		CompanyID: 43, PoolID: 9, Created: true, PoolStatus: "screened", DataRev: 34,
	}, nil
}

func (store *stage10Store) RecordExportAudit(_ context.Context, _ crm_intent.Actor, _ string, _ string, rows int) error {
	store.exported++
	store.exportRows = rows
	return nil
}

// ---------- fake credentials / blobs ----------

type stage10CredentialStore struct {
	rows map[string]*agentauth.CredentialRow
}

func newStage10CredentialStore() *stage10CredentialStore {
	return &stage10CredentialStore{rows: map[string]*agentauth.CredentialRow{
		agentauth.HashAgentToken(stage10AgentToken): {
			KeyID: 1, AgentID: stage10AgentID,
			BusinessScope: "crm_intent", ProjectScope: "*",
		},
		agentauth.HashAgentToken("stage10-narrow-token"): {
			KeyID: 2, AgentID: "narrow-agent",
			BusinessScope: "sku_info", ProjectScope: "*",
		},
	}}
}

func (store *stage10CredentialStore) FindByHash(_ context.Context, keyHash string) (*agentauth.CredentialRow, error) {
	return store.rows[keyHash], nil
}

func (store *stage10CredentialStore) TouchLastUsed(context.Context, int64, time.Time) error {
	return nil
}

type stage10BlobStore struct {
	mu      sync.Mutex
	puts    int
	deletes int
	failPut bool
}

func (store *stage10BlobStore) Put(context.Context, string, []byte, string) (string, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.failPut {
		return "", io.ErrUnexpectedEOF
	}
	store.puts++
	return "https://r2.example.com/object", nil
}

func (store *stage10BlobStore) TryDelete(context.Context, string) blob.DeleteResult {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.deletes++
	return blob.DeleteResult{Success: true}
}

// ---------- router harness ----------

func stage10Router(store crm_intent.Store, blobs crm_intent.BlobStore, options ...crm_intent.Option) http.Handler {
	router := chi.NewRouter()
	requireAPIKey := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("X-API-Key") != stage10APIKey {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = io.WriteString(w, `{"detail":"Not authenticated"}`)
				return
			}
			userID := r.Header.Get("X-User-Id")
			if userID == "" {
				userID = "user-1"
			}
			ctx := auth.WithUserContext(r.Context(), auth.UserContext{
				UserID: userID, Operator: userID,
				IsAdmin: r.Header.Get("X-Is-Admin") == "true",
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
	registrar := crm_intent.NewRegistrar(
		store, blobs, newStage10CredentialStore(), nil, options...,
	)
	registrar.RegisterRoutes(router, requireAPIKey)
	return router
}

func stage10UserRequest(method, target, body, userID string, admin bool) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("X-API-Key", stage10APIKey)
	request.Header.Set("X-User-Id", userID)
	if admin {
		request.Header.Set("X-Is-Admin", "true")
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	return request
}

func stage10AgentRequest(method, target, body, token, agentID, idempotencyKey string) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if agentID != "" {
		request.Header.Set("X-Agent-Id", agentID)
	}
	if idempotencyKey != "" {
		request.Header.Set("Idempotency-Key", idempotencyKey)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	return request
}

func decodeStage10Detail(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload struct {
		Detail map[string]any `json:"detail"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("invalid JSON body: %s", recorder.Body.String())
	}
	return payload.Detail
}

// ---------- tests ----------

func TestStage10CrmIntentUserStatusMatrix(t *testing.T) {
	store := newStage10Store()
	router := stage10Router(store, &stage10BlobStore{})

	cases := []struct {
		name   string
		method string
		target string
		body   string
		user   string
		admin  bool
		apiKey string
		status int
	}{
		{"401 no key", http.MethodGet, "/api/v1/crm/intent/meta", "", "user-1", false, "", http.StatusUnauthorized},
		{"200 meta", http.MethodGet, "/api/v1/crm/intent/meta", "", "user-1", false, stage10APIKey, http.StatusOK},
		{"422 page", http.MethodGet, "/api/v1/crm/intent/companies?page=0", "", "user-1", false, stage10APIKey, http.StatusUnprocessableEntity},
		{"422 level", http.MethodGet, "/api/v1/crm/intent/companies?level=X", "", "user-1", false, stage10APIKey, http.StatusUnprocessableEntity},
		{"200 companies", http.MethodGet, "/api/v1/crm/intent/companies?scope=sea&sort=score", "", "user-1", false, stage10APIKey, http.StatusOK},
		{"200 detail", http.MethodGet, "/api/v1/crm/intent/companies/42", "", "user-1", false, stage10APIKey, http.StatusOK},
		{"422 detail id", http.MethodGet, "/api/v1/crm/intent/companies/abc", "", "user-1", false, stage10APIKey, http.StatusUnprocessableEntity},
		{"403 batches non-admin", http.MethodGet, "/api/v1/crm/intent/batches", "", "user-1", false, stage10APIKey, http.StatusForbidden},
		{"200 batches admin", http.MethodGet, "/api/v1/crm/intent/batches", "", "user-1", true, stage10APIKey, http.StatusOK},
		{"200 followup", http.MethodPatch, "/api/v1/crm/intent/companies/42/followup",
			`{"state":"quoted","note":"已发报价单","valid_phones":[]}`, "user-1", false, stage10APIKey, http.StatusOK},
		{"422 followup state", http.MethodPatch, "/api/v1/crm/intent/companies/42/followup",
			`{"state":"whatever"}`, "user-1", false, stage10APIKey, http.StatusUnprocessableEntity},
		{"200 claim", http.MethodPost, "/api/v1/crm/intent/companies/42/claim", "", "user-1", false, stage10APIKey, http.StatusOK},
		{"200 convert", http.MethodPost, "/api/v1/crm/intent/companies/42/convert", "", "user-1", false, stage10APIKey, http.StatusOK},
		{"200 export", http.MethodGet, "/api/v1/crm/intent/export?level=A", "", "user-1", false, stage10APIKey, http.StatusOK},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			request := stage10UserRequest(test.method, test.target, test.body, test.user, test.admin)
			if test.apiKey == "" {
				request.Header.Del("X-API-Key")
			}
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if recorder.Code != test.status {
				t.Fatalf("%s => %d, want %d: %s", test.name, recorder.Code, test.status, recorder.Body.String())
			}
		})
	}
}

func TestStage10CrmIntentChannelsContract(t *testing.T) {
	store := newStage10Store()
	router := stage10Router(store, &stage10BlobStore{})

	metaRecorder := httptest.NewRecorder()
	router.ServeHTTP(metaRecorder, stage10UserRequest(
		http.MethodGet, "/api/v1/crm/intent/meta", "", "user-1", false))
	if metaRecorder.Code != http.StatusOK {
		t.Fatalf("meta status = %d: %s", metaRecorder.Code, metaRecorder.Body.String())
	}
	var meta struct {
		Facets struct {
			Channels []string `json:"channels"`
		} `json:"facets"`
	}
	if err := json.Unmarshal(metaRecorder.Body.Bytes(), &meta); err != nil {
		t.Fatalf("invalid meta: %s", metaRecorder.Body.String())
	}
	if len(meta.Facets.Channels) != 2 || meta.Facets.Channels[0] != "展会" {
		t.Fatalf("facets.channels = %+v", meta.Facets.Channels)
	}

	detailRecorder := httptest.NewRecorder()
	router.ServeHTTP(detailRecorder, stage10UserRequest(
		http.MethodGet, "/api/v1/crm/intent/companies/42", "", "user-1", false))
	if detailRecorder.Code != http.StatusOK {
		t.Fatalf("detail status = %d: %s", detailRecorder.Code, detailRecorder.Body.String())
	}
	var company map[string]any
	if err := json.Unmarshal(detailRecorder.Body.Bytes(), &company); err != nil {
		t.Fatalf("invalid company: %s", detailRecorder.Body.String())
	}
	if company["channel"] != "展会" {
		t.Fatalf("company.channel = %v", company["channel"])
	}
	channels, ok := company["channels"].([]any)
	if !ok || len(channels) != 2 {
		t.Fatalf("company.channels = %v", company["channels"])
	}
	if company["channel_source"] != "展会-2026-11-10.csv" {
		t.Fatalf("company.channel_source = %v", company["channel_source"])
	}
}

func TestStage10CrmIntentFollowupVersionConflict(t *testing.T) {
	store := newStage10Store()
	store.versionConflict = true
	router := stage10Router(store, &stage10BlobStore{})
	request := stage10UserRequest(http.MethodPatch,
		"/api/v1/crm/intent/companies/42/followup",
		`{"state":"contacted"}`, "user-1", false)
	request.Header.Set("If-Match", "3")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409: %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Detail struct {
			Code    string              `json:"code"`
			Current crm_intent.Followup `json:"current"`
		} `json:"detail"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("invalid body: %s", recorder.Body.String())
	}
	if payload.Detail.Code != "INTENT_VERSION_CONFLICT" {
		t.Fatalf("code = %q", payload.Detail.Code)
	}
	if payload.Detail.Current.Version != 4 {
		t.Fatalf("current version = %d, want 4", payload.Detail.Current.Version)
	}
}

func TestStage10CrmIntentMetaRevisionShortCircuit(t *testing.T) {
	store := newStage10Store()
	router := stage10Router(store, &stage10BlobStore{})
	request := stage10UserRequest(http.MethodGet,
		"/api/v1/crm/intent/meta?data_rev=31&followup_rev=12", "", "user-1", false)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("invalid body: %s", recorder.Body.String())
	}
	if changed, _ := payload["changed"].(bool); changed {
		t.Fatalf("changed = true, want false: %s", recorder.Body.String())
	}
}

func TestStage10CrmIntentExportCSV(t *testing.T) {
	store := newStage10Store()
	router := stage10Router(store, &stage10BlobStore{})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, stage10UserRequest(http.MethodGet,
		"/api/v1/crm/intent/export", "", "user-1", false))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if contentType := recorder.Header().Get("Content-Type"); !strings.Contains(contentType, "text/csv") {
		t.Fatalf("content-type = %q", contentType)
	}
	body := recorder.Body.String()
	if !strings.HasPrefix(body, "\ufeff") {
		t.Fatalf("CSV missing BOM prefix: %q", body[:min(10, len(body))])
	}
	if !strings.Contains(body, "企业名称") || !strings.Contains(body, "是否转客户") {
		t.Fatalf("CSV header missing columns: %q", body)
	}
	if store.exported != 1 || store.exportRows != 1 {
		t.Fatalf("export audit = %d rows %d", store.exported, store.exportRows)
	}
	disposition := recorder.Header().Get("Content-Disposition")
	if !strings.Contains(disposition, "20261110") {
		t.Fatalf("export filename should use batch date, got %q", disposition)
	}
}

func TestStage10CrmIntentSeaVisibilityAndClaim(t *testing.T) {
	store := newStage10Store()
	router := stage10Router(store, &stage10BlobStore{})

	// Non-admin sea list keeps scope=sea (list visibility was already correct).
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, stage10UserRequest(http.MethodGet,
		"/api/v1/crm/intent/companies?scope=sea", "", "user-2", false))
	if recorder.Code != http.StatusOK {
		t.Fatalf("sea list status = %d: %s", recorder.Code, recorder.Body.String())
	}
	store.mu.Lock()
	lastFilter := store.listScopes[len(store.listScopes)-1]
	store.mu.Unlock()
	if lastFilter.Scope.Name != crm_intent.ScopeSea || lastFilter.Scope.UserID != "user-2" {
		t.Fatalf("sea list scope = %+v", lastFilter.Scope)
	}

	// Detail without scope: non-admin sees own + sea records, not only mine.
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, stage10UserRequest(http.MethodGet,
		"/api/v1/crm/intent/companies/42", "", "user-2", false))
	if recorder.Code != http.StatusOK {
		t.Fatalf("detail status = %d: %s", recorder.Code, recorder.Body.String())
	}
	store.mu.Lock()
	detailScope := store.lastDetailScope
	store.mu.Unlock()
	if detailScope.Name != crm_intent.ScopeVisible || detailScope.UserID != "user-2" {
		t.Fatalf("default detail scope = %+v, want visible", detailScope)
	}

	// Explicit scope=sea is honoured for the drawer fetch.
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, stage10UserRequest(http.MethodGet,
		"/api/v1/crm/intent/companies/42?scope=sea", "", "user-2", false))
	if recorder.Code != http.StatusOK {
		t.Fatalf("sea detail status = %d: %s", recorder.Code, recorder.Body.String())
	}
	store.mu.Lock()
	detailScope = store.lastDetailScope
	store.mu.Unlock()
	if detailScope.Name != crm_intent.ScopeSea {
		t.Fatalf("explicit detail scope = %+v", detailScope)
	}

	// Explicit scope=mine is honoured.
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, stage10UserRequest(http.MethodGet,
		"/api/v1/crm/intent/companies/42?scope=mine", "", "user-2", false))
	if recorder.Code != http.StatusOK {
		t.Fatalf("mine detail status = %d: %s", recorder.Code, recorder.Body.String())
	}
	store.mu.Lock()
	detailScope = store.lastDetailScope
	store.mu.Unlock()
	if detailScope.Name != crm_intent.ScopeMine {
		t.Fatalf("explicit mine detail scope = %+v", detailScope)
	}

	// Non-admin scope=all falls back to own+sea visibility instead of 404.
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, stage10UserRequest(http.MethodGet,
		"/api/v1/crm/intent/companies/42?scope=all", "", "user-2", false))
	if recorder.Code != http.StatusOK {
		t.Fatalf("non-admin all detail status = %d: %s", recorder.Code, recorder.Body.String())
	}
	store.mu.Lock()
	detailScope = store.lastDetailScope
	store.mu.Unlock()
	if detailScope.Name != crm_intent.ScopeVisible {
		t.Fatalf("non-admin all detail scope = %+v", detailScope)
	}

	// Admin without scope still sees everything.
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, stage10UserRequest(http.MethodGet,
		"/api/v1/crm/intent/companies/42", "", "admin-1", true))
	if recorder.Code != http.StatusOK {
		t.Fatalf("admin detail status = %d: %s", recorder.Code, recorder.Body.String())
	}
	store.mu.Lock()
	detailScope = store.lastDetailScope
	store.mu.Unlock()
	if detailScope.Name != crm_intent.ScopeAll || !detailScope.IsAdmin {
		t.Fatalf("admin detail scope = %+v", detailScope)
	}

	// Claim remains reachable for the sea -> mine flow.
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, stage10UserRequest(http.MethodPost,
		"/api/v1/crm/intent/companies/42/claim", "", "user-2", false))
	if recorder.Code != http.StatusOK {
		t.Fatalf("claim status = %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestStage10CrmIntentAgentAuthAndScope(t *testing.T) {
	store := newStage10Store()
	router := stage10Router(store, &stage10BlobStore{})

	cases := []struct {
		name   string
		token  string
		agent  string
		status int
	}{
		{"401 no token", "", stage10AgentID, http.StatusUnauthorized},
		{"401 agent mismatch", stage10AgentToken, "other-agent", http.StatusUnauthorized},
		{"403 wrong scope", "stage10-narrow-token", "narrow-agent", http.StatusForbidden},
		{"200 health", stage10AgentToken, stage10AgentID, http.StatusOK},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, stage10AgentRequest(
				http.MethodGet, "/api/v1/agent/crm-intent/health", "",
				test.token, test.agent, ""))
			if recorder.Code != test.status {
				t.Fatalf("%s => %d, want %d: %s", test.name, recorder.Code, test.status, recorder.Body.String())
			}
		})
	}
}

func TestStage10CrmIntentAgentIdempotency(t *testing.T) {
	store := newStage10Store()
	router := stage10Router(store, &stage10BlobStore{})
	body := `{"name":"示例企业","phones":["13800000001"]}`

	// missing key => 400 IDEMPOTENCY_KEY_REQUIRED
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, stage10AgentRequest(
		http.MethodPost, "/api/v1/agent/crm-intent/companies", body,
		stage10AgentToken, stage10AgentID, ""))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("missing key status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if detail := decodeStage10Detail(t, recorder); detail["code"] != "IDEMPOTENCY_KEY_REQUIRED" {
		t.Fatalf("missing key code = %v", detail["code"])
	}

	// first write
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, stage10AgentRequest(
		http.MethodPost, "/api/v1/agent/crm-intent/companies", body,
		stage10AgentToken, stage10AgentID, "idem-1"))
	if recorder.Code != http.StatusOK {
		t.Fatalf("first write status = %d: %s", recorder.Code, recorder.Body.String())
	}
	firstBody := recorder.Body.String()

	// replay same key + same payload
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, stage10AgentRequest(
		http.MethodPost, "/api/v1/agent/crm-intent/companies", body,
		stage10AgentToken, stage10AgentID, "idem-1"))
	if recorder.Code != http.StatusOK {
		t.Fatalf("replay status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if recorder.Body.String() != firstBody {
		t.Fatalf("replay body differs: %q vs %q", recorder.Body.String(), firstBody)
	}

	// same key + different payload => 409 IDEMPOTENCY_CONFLICT
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, stage10AgentRequest(
		http.MethodPost, "/api/v1/agent/crm-intent/companies",
		`{"name":"另一家企业"}`, stage10AgentToken, stage10AgentID, "idem-1"))
	if recorder.Code != http.StatusConflict {
		t.Fatalf("conflict status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if detail := decodeStage10Detail(t, recorder); detail["code"] != "IDEMPOTENCY_CONFLICT" {
		t.Fatalf("conflict code = %v", detail["code"])
	}
}

func TestStage10CrmIntentAgentLockedAndFieldWhitelist(t *testing.T) {
	store := newStage10Store()
	store.locked = true
	router := stage10Router(store, &stage10BlobStore{})

	// locked single create => 409 INTENT_RECORD_LOCKED
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, stage10AgentRequest(
		http.MethodPost, "/api/v1/agent/crm-intent/companies",
		`{"name":"示例企业"}`, stage10AgentToken, stage10AgentID, "idem-lock"))
	if recorder.Code != http.StatusConflict {
		t.Fatalf("locked status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if detail := decodeStage10Detail(t, recorder); detail["code"] != "INTENT_RECORD_LOCKED" {
		t.Fatalf("locked code = %v", detail["code"])
	}

	// banned field => 422 VALIDATION_FAILED
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, stage10AgentRequest(
		http.MethodPost, "/api/v1/agent/crm-intent/companies",
		`{"name":"示例企业","owner_id":"user-1"}`,
		stage10AgentToken, stage10AgentID, "idem-banned"))
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("banned status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if detail := decodeStage10Detail(t, recorder); detail["code"] != "VALIDATION_FAILED" {
		t.Fatalf("banned code = %v", detail["code"])
	}

	// unknown field => 422
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, stage10AgentRequest(
		http.MethodPost, "/api/v1/agent/crm-intent/companies",
		`{"name":"示例企业","unknown_field":1}`,
		stage10AgentToken, stage10AgentID, "idem-unknown"))
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown status = %d: %s", recorder.Code, recorder.Body.String())
	}

	// pool screen locked => 409
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, stage10AgentRequest(
		http.MethodPost, "/api/v1/agent/crm-intent/pool/9/screen",
		`{"company":{"name":"示例企业"}}`,
		stage10AgentToken, stage10AgentID, "idem-screen"))
	if recorder.Code != http.StatusConflict {
		t.Fatalf("screen status = %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestStage10CrmIntentAgentBatchIngest(t *testing.T) {
	store := newStage10Store()
	blobs := &stage10BlobStore{}
	router := stage10Router(store, blobs)
	body := `{
		"batch":{"batch_date":"2026-11-10","source":"ai-screening","source_file":"名录.csv"},
		"companies":[{"name":"企业甲","phones":["13800000001"],"intent_level":"A"},
		             {"name":"企业乙","registered_capital_wan":"300万人民币"}],
		"pool":[{"name":"池甲","channel":"展会"}]
	}`
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, stage10AgentRequest(
		http.MethodPost, "/api/v1/agent/crm-intent/batches", body,
		stage10AgentToken, stage10AgentID, "idem-batch"))
	if recorder.Code != http.StatusOK {
		t.Fatalf("batch status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var result crm_intent.IngestResult
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatalf("invalid batch response: %s", recorder.Body.String())
	}
	if result.BatchID != 7 || result.Status != crm_intent.BatchCompleted {
		t.Fatalf("batch result = %+v", result)
	}
	if result.Created != 1 || result.PoolTotal != 1 {
		t.Fatalf("batch counts = %+v", result)
	}
	if len(result.Rejected) != 1 || result.Rejected[0].Reason == "" {
		t.Fatalf("batch rejected = %+v", result.Rejected)
	}
	if result.RejectedCount != 1 {
		t.Fatalf("rejected_count = %d, want 1", result.RejectedCount)
	}
	if len(result.Rows) != 3 {
		t.Fatalf("rows = %+v, want 3", result.Rows)
	}
	if result.RequestID != "idem-batch" {
		t.Fatalf("request_id = %q", result.RequestID)
	}
	if blobs.puts != 1 {
		t.Fatalf("R2 puts = %d, want 1", blobs.puts)
	}
	if len(store.ingestRequests) != 1 {
		t.Fatalf("ingest calls = %d", len(store.ingestRequests))
	}
	if len(store.batchCreates) != 1 || store.batchCreates[0].BatchDate.IsZero() {
		t.Fatalf("batch create missing date: %+v", store.batchCreates)
	}
	if store.batchCreates[0].BatchDate.Format("2006-01-02") != "2026-11-10" {
		t.Fatalf("batch date = %s", store.batchCreates[0].BatchDate)
	}
}

func TestStage10CrmIntentBatchDetailRows(t *testing.T) {
	store := newStage10Store()
	router := stage10Router(store, &stage10BlobStore{})

	agentRecorder := httptest.NewRecorder()
	router.ServeHTTP(agentRecorder, stage10AgentRequest(
		http.MethodGet, "/api/v1/agent/crm-intent/batches/7", "",
		stage10AgentToken, stage10AgentID, ""))
	if agentRecorder.Code != http.StatusOK {
		t.Fatalf("agent batch detail status = %d: %s", agentRecorder.Code, agentRecorder.Body.String())
	}
	var detail struct {
		ID   int64                 `json:"id"`
		Rows []crm_intent.BatchRow `json:"rows"`
	}
	if err := json.Unmarshal(agentRecorder.Body.Bytes(), &detail); err != nil {
		t.Fatalf("invalid agent batch detail: %s", agentRecorder.Body.String())
	}
	if detail.ID != 7 || len(detail.Rows) != 3 {
		t.Fatalf("agent batch detail = %+v", detail)
	}
	if detail.Rows[1].Status != "rejected" || detail.Rows[1].Reason == "" {
		t.Fatalf("rejected row = %+v", detail.Rows[1])
	}

	userRecorder := httptest.NewRecorder()
	router.ServeHTTP(userRecorder, stage10UserRequest(
		http.MethodGet, "/api/v1/crm/intent/batches/7", "", "user-1", true))
	if userRecorder.Code != http.StatusOK {
		t.Fatalf("user batch detail status = %d: %s", userRecorder.Code, userRecorder.Body.String())
	}
	if !strings.Contains(userRecorder.Body.String(), "\"rows\"") {
		t.Fatalf("user batch detail missing rows: %s", userRecorder.Body.String())
	}
}

func TestStage10CrmIntentAgentBatchR2Unavailable(t *testing.T) {
	store := newStage10Store()
	router := stage10Router(store, nil)
	body := `{"batch":{"batch_date":"2026-11-10"},"companies":[{"name":"企业甲"}]}`
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, stage10AgentRequest(
		http.MethodPost, "/api/v1/agent/crm-intent/batches", body,
		stage10AgentToken, stage10AgentID, "idem-no-r2"))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if detail := decodeStage10Detail(t, recorder); detail["code"] != "INTENT_R2_UNAVAILABLE" {
		t.Fatalf("code = %v", detail["code"])
	}
}

func TestStage10CrmIntentR2AttachFailureCleansObject(t *testing.T) {
	store := newStage10Store()
	store.attachError = true
	blobs := &stage10BlobStore{}
	router := stage10Router(store, blobs)
	body := `{"batch":{"batch_date":"2026-11-10"},"companies":[{"name":"企业甲"}]}`
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, stage10AgentRequest(
		http.MethodPost, "/api/v1/agent/crm-intent/batches", body,
		stage10AgentToken, stage10AgentID, "idem-attach-fail"))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if blobs.puts != 1 {
		t.Fatalf("R2 puts = %d", blobs.puts)
	}
	if blobs.deletes < 1 {
		t.Fatalf("R2 object should be cleaned up after attach failure, deletes = %d", blobs.deletes)
	}
	store.mu.Lock()
	batchCount := len(store.batchCreates)
	store.mu.Unlock()
	if batchCount != 1 {
		t.Fatalf("batch rows created = %d", batchCount)
	}
}

func TestStage10CrmIntentAgentRateLimit(t *testing.T) {
	store := newStage10Store()
	router := stage10Router(store, &stage10BlobStore{},
		crm_intent.WithWriteRateLimiter(agentauth.NewMemoryRateLimiter(agentauth.RateLimit{
			Requests: 1, Window: time.Minute,
		})),
	)
	body := `{"name":"示例企业"}`
	first := httptest.NewRecorder()
	router.ServeHTTP(first, stage10AgentRequest(
		http.MethodPost, "/api/v1/agent/crm-intent/companies", body,
		stage10AgentToken, stage10AgentID, "idem-rate-1"))
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d: %s", first.Code, first.Body.String())
	}
	second := httptest.NewRecorder()
	router.ServeHTTP(second, stage10AgentRequest(
		http.MethodPost, "/api/v1/agent/crm-intent/companies", body,
		stage10AgentToken, stage10AgentID, "idem-rate-2"))
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("second status = %d: %s", second.Code, second.Body.String())
	}
	if second.Header().Get("Retry-After") == "" {
		t.Fatalf("429 missing Retry-After")
	}
}

func TestStage10CrmIntentAgentUploadMultipart(t *testing.T) {
	store := newStage10Store()
	blobs := &stage10BlobStore{}
	router := stage10Router(store, blobs)
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	part, err := writer.CreateFormFile("file", "companies.csv")
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	_, _ = part.Write([]byte("name,phones,intent_level\n企业甲,13800000001,A\n"))
	_ = writer.WriteField("batch_date", "2026-11-10")
	_ = writer.Close()

	request := httptest.NewRequest(http.MethodPost,
		"/api/v1/agent/crm-intent/batches/upload", &buffer)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Authorization", "Bearer "+stage10AgentToken)
	request.Header.Set("X-Agent-Id", stage10AgentID)
	request.Header.Set("Idempotency-Key", "idem-upload")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("upload status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var result crm_intent.IngestResult
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatalf("invalid upload response: %s", recorder.Body.String())
	}
	if result.Created != 1 || blobs.puts != 1 {
		t.Fatalf("upload result = %+v puts=%d", result, blobs.puts)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
