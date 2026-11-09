package agentauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRequireConfirmationPreview(t *testing.T) {
	store := newFakeConfirmStore()
	validatorCalled := false
	contextCalled := false
	nextCalled := false
	body := []byte(`{"name":"new shipment"}`)

	middleware := RequireConfirmation(
		store,
		"shipment.create",
		WithConfirmValidator(func(_ *http.Request, got []byte) error {
			validatorCalled = true
			if !bytes.Equal(got, body) {
				t.Fatalf("validator body = %q, want %q", got, body)
			}
			return nil
		}),
		WithConfirmContext(func(_ *http.Request, _ []byte) map[string]any {
			contextCalled = true
			return map[string]any{"project_id": 42, "shipment_no": "SH-001"}
		}),
	)
	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
	}))
	request := confirmationRequest(http.MethodPost, body)
	request.Header.Set("Idempotency-Key", "idem-1")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	if nextCalled {
		t.Fatal("next handler must not run on preview")
	}
	if !validatorCalled || !contextCalled {
		t.Fatal("validator and context builder must run on preview")
	}
	if store.putCalls != 1 {
		t.Fatalf("Put calls = %d, want 1", store.putCalls)
	}
	if store.lastRecord.AgentID != "agent-alpha" || store.lastRecord.Action != "shipment.create" {
		t.Fatalf("unexpected confirm record: %+v", store.lastRecord)
	}
	if store.lastRecord.IdempotencyKey != "idem-1" {
		t.Fatalf("idempotency key = %q, want idem-1", store.lastRecord.IdempotencyKey)
	}
	if store.lastRecord.BodyHash != ComputeBodyHash(body) {
		t.Fatalf("body hash = %q, want %q", store.lastRecord.BodyHash, ComputeBodyHash(body))
	}
	if store.lastTTL != DefaultConfirmTTL {
		t.Fatalf("ttl = %s, want %s", store.lastTTL, DefaultConfirmTTL)
	}
	if store.lastRecord.Context["shipment_no"] != "SH-001" {
		t.Fatalf("confirm context = %#v", store.lastRecord.Context)
	}

	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode preview: %v", err)
	}
	if payload["ok"] != false || payload["requires_confirmation"] != true {
		t.Fatalf("unexpected preview payload: %#v", payload)
	}
	token, _ := payload["confirm_token"].(string)
	if !strings.HasPrefix(token, "cf_") || token != store.lastRecord.Token {
		t.Fatalf("confirm token = %q, record token = %q", token, store.lastRecord.Token)
	}
	if payload["message"] != "该操作需要用户确认" {
		t.Fatalf("message = %#v", payload["message"])
	}
}

func TestRequireConfirmationValidatesBeforeIssuingToken(t *testing.T) {
	store := newFakeConfirmStore()
	nextCalled := false
	middleware := RequireConfirmation(
		store,
		"shipment.create",
		WithConfirmValidator(func(*http.Request, []byte) error {
			return &APIError{
				Status: http.StatusUnprocessableEntity,
				Code:   ErrorCodeValidationFailed,
				Detail: "shipment_no is required",
			}
		}),
	)
	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
	}))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, confirmationRequest(http.MethodPost, []byte(`{}`)))

	assertErrorResponse(t, response, http.StatusUnprocessableEntity, ErrorCodeValidationFailed, "shipment_no is required")
	if store.putCalls != 0 {
		t.Fatalf("Put calls = %d, want 0", store.putCalls)
	}
	if nextCalled {
		t.Fatal("next handler must not run")
	}
}

func TestRequireConfirmationReplayRestoresBodyAndContext(t *testing.T) {
	body := []byte(`{"name":"confirmed"}`)
	store := newFakeConfirmStore()
	store.records["cf_valid"] = &ConfirmRecord{
		Token:          "cf_valid",
		AgentID:        "agent-alpha",
		Action:         "shipment.create",
		IdempotencyKey: "idem-1",
		BodyHash:       ComputeBodyHash(body),
		CreatedAt:      time.Now().UTC(),
		Context:        map[string]any{"shipment_no": "SH-001"},
	}
	nextCalled := false
	handler := RequireConfirmation(store, "shipment.create")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		gotBody, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read restored body: %v", err)
		}
		if !bytes.Equal(gotBody, body) {
			t.Fatalf("restored body = %q, want %q", gotBody, body)
		}
		record, ok := ConfirmRecordFromContext(r.Context())
		if !ok || record.Token != "cf_valid" {
			t.Fatalf("confirm record missing: %+v, ok=%v", record, ok)
		}
		confirmContext, ok := ConfirmContextFromContext(r.Context())
		if !ok || confirmContext["shipment_no"] != "SH-001" {
			t.Fatalf("confirm context missing: %#v, ok=%v", confirmContext, ok)
		}
		w.WriteHeader(http.StatusCreated)
	}))
	request := confirmationRequest(http.MethodPost, body)
	request.Header.Set("Idempotency-Key", "idem-1")
	request.Header.Set(ConfirmTokenHeader, "cf_valid")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201: %s", response.Code, response.Body.String())
	}
	if !nextCalled {
		t.Fatal("next handler must run on valid replay")
	}
	if store.consumeCalls != 1 {
		t.Fatalf("Consume calls = %d, want 1", store.consumeCalls)
	}
}

func TestRequireConfirmationTokenIsConsumedOnce(t *testing.T) {
	body := []byte(`{"name":"once"}`)
	store := newFakeConfirmStore()
	store.records["cf_once"] = &ConfirmRecord{
		Token:     "cf_once",
		AgentID:   "agent-alpha",
		Action:    "shipment.create",
		BodyHash:  ComputeBodyHash(body),
		CreatedAt: time.Now().UTC(),
	}
	handler := RequireConfirmation(store, "shipment.create")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	request := func() *http.Request {
		req := confirmationRequest(http.MethodPost, body)
		req.Header.Set(ConfirmTokenHeader, "cf_once")
		return req
	}

	first := httptest.NewRecorder()
	handler.ServeHTTP(first, request())
	if first.Code != http.StatusNoContent {
		t.Fatalf("first status = %d, want 204: %s", first.Code, first.Body.String())
	}

	second := httptest.NewRecorder()
	handler.ServeHTTP(second, request())
	assertErrorResponse(t, second, http.StatusBadRequest, ErrorCodeConfirmTokenInvalid, DetailConfirmInvalid)
}

func TestCanonicalRequestFingerprintBindsQuery(t *testing.T) {
	request := httptest.NewRequest(
		http.MethodDelete,
		"/api/v1/agent/projects/42/shipments/SHP-A?force=true&country=US",
		nil,
	)
	if got := CanonicalRequestFingerprint(request); got != "DELETE /api/v1/agent/projects/42/shipments/SHP-A?country=US&force=true" {
		t.Fatalf("CanonicalRequestFingerprint() = %q", got)
	}

	changed := httptest.NewRequest(
		http.MethodDelete,
		"/api/v1/agent/projects/42/shipments/SHP-B?force=true&country=US",
		nil,
	)
	if got := CanonicalRequestFingerprint(changed); got == CanonicalRequestFingerprint(request) {
		t.Fatal("changed resource retained the same fingerprint")
	}
}

func TestRequireConfirmationRejectsChangedBodyAndBurnsToken(t *testing.T) {
	original := []byte(`{"amount":10}`)
	changed := []byte(`{"amount":999}`)
	store := newFakeConfirmStore()
	store.records["cf_body"] = &ConfirmRecord{
		Token:     "cf_body",
		AgentID:   "agent-alpha",
		Action:    "shipment.create",
		BodyHash:  ComputeBodyHash(original),
		CreatedAt: time.Now().UTC(),
	}
	handler := RequireConfirmation(store, "shipment.create")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("next handler must not run with a changed body")
	}))
	request := confirmationRequest(http.MethodPost, changed)
	request.Header.Set(ConfirmTokenHeader, "cf_body")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	assertErrorResponse(t, response, http.StatusBadRequest, ErrorCodeConfirmTokenInvalid, DetailConfirmInvalid)
	if len(store.records) != 0 {
		t.Fatalf("token was not consumed: %#v", store.records)
	}
}

func TestRequireConfirmationBindsAgentActionAndIdempotencyKey(t *testing.T) {
	body := []byte(`{"name":"bound"}`)
	tests := []struct {
		name           string
		record         *ConfirmRecord
		requestAgentID string
		requestAction  string
		idempotencyKey string
	}{
		{
			name:           "agent mismatch",
			record:         &ConfirmRecord{Token: "cf_bound", AgentID: "other-agent", Action: "shipment.create", BodyHash: ComputeBodyHash(body), CreatedAt: time.Now().UTC()},
			requestAgentID: "agent-alpha",
			requestAction:  "shipment.create",
		},
		{
			name:           "action mismatch",
			record:         &ConfirmRecord{Token: "cf_bound", AgentID: "agent-alpha", Action: "shipment.delete", BodyHash: ComputeBodyHash(body), CreatedAt: time.Now().UTC()},
			requestAgentID: "agent-alpha",
			requestAction:  "shipment.create",
		},
		{
			name:           "idempotency mismatch",
			record:         &ConfirmRecord{Token: "cf_bound", AgentID: "agent-alpha", Action: "shipment.create", IdempotencyKey: "old", BodyHash: ComputeBodyHash(body), CreatedAt: time.Now().UTC()},
			requestAgentID: "agent-alpha",
			requestAction:  "shipment.create",
			idempotencyKey: "new",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newFakeConfirmStore()
			store.records[tt.record.Token] = tt.record
			handler := RequireConfirmation(store, tt.requestAction)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Fatal("next handler must not run")
			}))
			request := confirmationRequest(http.MethodPost, body)
			request = request.WithContext(WithAgentCredential(request.Context(), AgentCredential{
				AgentID: tt.requestAgentID,
			}))
			request.Header.Set(ConfirmTokenHeader, tt.record.Token)
			if tt.idempotencyKey != "" {
				request.Header.Set("Idempotency-Key", tt.idempotencyKey)
			}
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, request)

			assertErrorResponse(t, response, http.StatusBadRequest, ErrorCodeConfirmTokenInvalid, DetailConfirmInvalid)
		})
	}
}

func TestRequireConfirmationExpiredToken(t *testing.T) {
	body := []byte(`{"name":"expired"}`)
	store := newFakeConfirmStore()
	store.records["cf_expired"] = &ConfirmRecord{
		Token:     "cf_expired",
		AgentID:   "agent-alpha",
		Action:    "shipment.create",
		BodyHash:  ComputeBodyHash(body),
		CreatedAt: time.Now().UTC().Add(-DefaultConfirmTTL - time.Second),
	}
	handler := RequireConfirmation(store, "shipment.create")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("next handler must not run")
	}))
	request := confirmationRequest(http.MethodPost, body)
	request.Header.Set(ConfirmTokenHeader, "cf_expired")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	assertErrorResponse(t, response, http.StatusConflict, ErrorCodeConfirmTokenExpired, DetailConfirmExpired)
}

func TestRequireConfirmationWithoutCredentialFailsClosed(t *testing.T) {
	store := newFakeConfirmStore()
	handler := RequireConfirmation(store, "shipment.create")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("next handler must not run")
	}))
	request := confirmationRequest(http.MethodPost, []byte(`{}`))
	request = request.WithContext(context.Background())
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	assertErrorResponse(t, response, http.StatusUnauthorized, ErrorCodeAgentAuthFailed, DetailTokenInvalid)
	if store.putCalls != 0 || store.consumeCalls != 0 {
		t.Fatalf("confirm store called without auth: put=%d consume=%d", store.putCalls, store.consumeCalls)
	}
}

func TestConfirmGateStoreFailures(t *testing.T) {
	body := []byte(`{"name":"store-error"}`)

	t.Run("put failure", func(t *testing.T) {
		store := newFakeConfirmStore()
		store.putErr = errors.New("redis unavailable")
		handler := RequireConfirmation(store, "shipment.create")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Fatal("next handler must not run")
		}))
		response := httptest.NewRecorder()

		handler.ServeHTTP(response, confirmationRequest(http.MethodPost, body))

		assertErrorResponse(t, response, http.StatusInternalServerError, ErrorCodeInternalError, DetailConfirmStoreError)
	})

	t.Run("consume failure", func(t *testing.T) {
		store := newFakeConfirmStore()
		store.consumeErr = errors.New("redis unavailable")
		handler := RequireConfirmation(store, "shipment.create")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Fatal("next handler must not run")
		}))
		request := confirmationRequest(http.MethodPost, body)
		request.Header.Set(ConfirmTokenHeader, "cf_any")
		response := httptest.NewRecorder()

		handler.ServeHTTP(response, request)

		assertErrorResponse(t, response, http.StatusInternalServerError, ErrorCodeInternalError, DetailConfirmStoreError)
	})
}

func TestRequireConfirmationCustomTTL(t *testing.T) {
	store := newFakeConfirmStore()
	handler := RequireConfirmation(
		store,
		"shipment.create",
		WithConfirmTTL(15*time.Second),
	)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("next handler must not run")
	}))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, confirmationRequest(http.MethodPost, []byte(`{}`)))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	if store.lastTTL != 15*time.Second {
		t.Fatalf("ttl = %s, want 15s", store.lastTTL)
	}
}

func TestAgentAuthSecurityChainPreviewThenConfirmedReplay(t *testing.T) {
	body := []byte(`{"shipment_no":"SH-CHAIN"}`)
	credentialStore := &fakeCredentialStore{
		row: &CredentialRow{
			KeyID:         1,
			AgentID:       "agent-alpha",
			Label:         "Alpha Agent",
			BusinessScope: "shipments",
			ProjectScope:  "42",
		},
	}
	confirmStore := newFakeConfirmStore()
	nextCalls := 0
	handler := RequireAgentCredential(credentialStore)(
		RequireBusinessScope("shipments")(
			RequireProjectScope(42)(
				RequireConfirmation(confirmStore, "shipment.create")(
					http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						nextCalls++
						got, err := io.ReadAll(r.Body)
						if err != nil {
							t.Fatalf("read body: %v", err)
						}
						if !bytes.Equal(got, body) {
							t.Fatalf("body = %q, want %q", got, body)
						}
						w.WriteHeader(http.StatusCreated)
					}),
				),
			),
		),
	)

	previewRequest := httptest.NewRequest(http.MethodPost, "/api/v1/agent/projects/42/shipments", bytes.NewReader(body))
	previewRequest.Header.Set("Authorization", "Bearer bbx_chain")
	previewRequest.Header.Set("X-Agent-Id", "agent-alpha")
	previewResponse := httptest.NewRecorder()
	handler.ServeHTTP(previewResponse, previewRequest)
	if previewResponse.Code != http.StatusOK {
		t.Fatalf("preview status = %d, want 200: %s", previewResponse.Code, previewResponse.Body.String())
	}
	var preview struct {
		ConfirmToken string `json:"confirm_token"`
	}
	if err := json.Unmarshal(previewResponse.Body.Bytes(), &preview); err != nil {
		t.Fatalf("decode preview: %v", err)
	}
	if preview.ConfirmToken == "" {
		t.Fatal("preview did not return a confirm token")
	}
	if nextCalls != 0 {
		t.Fatalf("next calls after preview = %d, want 0", nextCalls)
	}

	replayRequest := httptest.NewRequest(http.MethodPost, "/api/v1/agent/projects/42/shipments", bytes.NewReader(body))
	replayRequest.Header.Set("Authorization", "Bearer bbx_chain")
	replayRequest.Header.Set("X-Agent-Id", "agent-alpha")
	replayRequest.Header.Set(ConfirmTokenHeader, preview.ConfirmToken)
	replayResponse := httptest.NewRecorder()
	handler.ServeHTTP(replayResponse, replayRequest)
	if replayResponse.Code != http.StatusCreated {
		t.Fatalf("replay status = %d, want 201: %s", replayResponse.Code, replayResponse.Body.String())
	}
	if nextCalls != 1 {
		t.Fatalf("next calls after replay = %d, want 1", nextCalls)
	}
}

func TestMemoryConfirmStoreConsumeIsOneShot(t *testing.T) {
	now := time.Date(2026, time.November, 8, 10, 0, 0, 0, time.UTC)
	store := NewMemoryConfirmStore(WithMemoryConfirmClock(func() time.Time { return now }))
	record := ConfirmRecord{
		Token:     "cf_memory",
		AgentID:   "agent",
		Action:    "shipment.create",
		BodyHash:  ComputeBodyHash([]byte(`{}`)),
		CreatedAt: now,
	}
	if err := store.Put(context.Background(), record, DefaultConfirmTTL); err != nil {
		t.Fatalf("Put returned error: %v", err)
	}

	got, err := store.Consume(context.Background(), "cf_memory")
	if err != nil {
		t.Fatalf("first Consume returned error: %v", err)
	}
	if got == nil || got.Token != "cf_memory" {
		t.Fatalf("first Consume = %+v", got)
	}
	if _, err := store.Consume(context.Background(), "cf_memory"); !errors.Is(err, ErrConfirmTokenNotFound) {
		t.Fatalf("second Consume error = %v, want ErrConfirmTokenNotFound", err)
	}
}

type fakeConfirmStore struct {
	records      map[string]*ConfirmRecord
	putCalls     int
	consumeCalls int
	putErr       error
	consumeErr   error
	lastRecord   ConfirmRecord
	lastTTL      time.Duration
}

func newFakeConfirmStore() *fakeConfirmStore {
	return &fakeConfirmStore{records: make(map[string]*ConfirmRecord)}
}

func (s *fakeConfirmStore) Put(_ context.Context, record ConfirmRecord, ttl time.Duration) error {
	s.putCalls++
	s.lastRecord = record
	s.lastTTL = ttl
	if s.putErr != nil {
		return s.putErr
	}
	recordCopy := record
	s.records[record.Token] = &recordCopy
	return nil
}

func (s *fakeConfirmStore) Consume(_ context.Context, token string) (*ConfirmRecord, error) {
	s.consumeCalls++
	if s.consumeErr != nil {
		return nil, s.consumeErr
	}
	record, ok := s.records[token]
	if !ok {
		return nil, ErrConfirmTokenNotFound
	}
	delete(s.records, token)
	return record, nil
}

func confirmationRequest(method string, body []byte) *http.Request {
	request := httptest.NewRequest(method, "/api/v1/agent/projects/42/shipments", bytes.NewReader(body))
	return request.WithContext(WithAgentCredential(request.Context(), AgentCredential{
		KeyID:         1,
		AgentID:       "agent-alpha",
		Label:         "Alpha Agent",
		BusinessScope: "*",
		ProjectScope:  "*",
	}))
}
