package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_credentials"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/internal_keys"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/uploads"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	requestauth "github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

const (
	stage9DProvisionToken = "bbx_stage9d_provisioner"
	stage9DUploadToken    = "bbx_stage9d_uploader"
)

func TestStage9DAgentCredentialRoutesModuleAndScopeGates(t *testing.T) {
	createdAt := time.Date(2026, 11, 8, 3, 4, 5, 0, time.UTC)
	keys := &stage9DKeyStore{
		list: []agent_credentials.AgentKey{{
			ID:            1,
			KeyPrefix:     "bbx_12345678",
			Label:         "库存助理",
			Scope:         "read",
			ProjectScope:  "7",
			BusinessScope: "inventory",
			CreatedAt:     createdAt,
		}},
		projects:      agent_credentials.ProjectValidation{},
		projectID:     7,
		projectActive: true,
	}
	uploadStore := &stage9DUploadStore{
		validateResponse: &agent_credentials.AgentUploadValidateResponse{
			TempFileID:        "tmp_sales",
			OriginalFilename:  "sales.csv",
			ReportType:        "sales_report",
			Status:            "valid",
			MatchedColumns:    []string{"purchase-date", "sku", "asin"},
			MissingColumns:    []string{},
			ColumnMatchRatio:  1,
			DetectedCountries: []string{},
			PrimaryCountry:    "US",
			DateInputMode:     "single_manual",
			Warnings:          []string{},
		},
	}
	credentials := stage9DCredentials{
		agentauth.HashAgentToken(stage9DProvisionToken): {
			KeyID:         10,
			AgentID:       "agent-provisioner",
			Label:         "签发员",
			BusinessScope: "agent_provisioning",
			ProjectScope:  "*",
			LastUsedAt:    stage9DTimePointer(time.Now().UTC()),
		},
		agentauth.HashAgentToken(stage9DUploadToken): {
			KeyID:         11,
			AgentID:       "agent-uploader",
			Label:         "上传员",
			BusinessScope: "report_upload",
			ProjectScope:  "7",
			LastUsedAt:    stage9DTimePointer(time.Now().UTC()),
		},
	}
	registrar := agent_credentials.NewRegistrar(keys, uploadStore, agent_credentials.Options{
		Credentials:  credentials,
		ConfirmStore: agentauth.NewMemoryConfirmStore(),
		Auditor:      audit.NewMockService(),
	})
	if registrar.ModuleName() != "agent_credentials" {
		t.Fatalf("ModuleName() = %q, want agent_credentials", registrar.ModuleName())
	}
	router := chi.NewRouter()
	registrar.RegisterRoutes(router, nil)

	noAuth := stage9DRequest(router, http.MethodGet, "/api/v1/agent/provisioning/keys", "", "", "", "")
	noAuthRecorder := httptest.NewRecorder()
	router.ServeHTTP(noAuthRecorder, noAuth)
	if noAuthRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401: %s", noAuthRecorder.Code, noAuthRecorder.Body.String())
	}

	list := stage9DRequest(
		router,
		http.MethodGet,
		"/api/v1/agent/provisioning/keys",
		"",
		stage9DProvisionToken,
		"agent-provisioner",
		"",
	)
	listRecorder := httptest.NewRecorder()
	router.ServeHTTP(listRecorder, list)
	if listRecorder.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200: %s", listRecorder.Code, listRecorder.Body.String())
	}
	var listBody struct {
		OK   bool                             `json:"ok"`
		Data []agent_credentials.AgentKeyItem `json:"data"`
	}
	if err := json.Unmarshal(listRecorder.Body.Bytes(), &listBody); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if !listBody.OK || len(listBody.Data) != 1 || listBody.Data[0].AgentID != nil {
		t.Fatalf("list body = %#v", listBody)
	}
	if bytes.Contains(listRecorder.Body.Bytes(), []byte("plaintext")) ||
		bytes.Contains(listRecorder.Body.Bytes(), []byte("key_hash")) {
		t.Fatalf("credential list leaked sensitive fields: %s", listRecorder.Body.String())
	}

	upload := stage9DRequest(
		router,
		http.MethodPost,
		"/api/v1/agent/upload/validate",
		"",
		stage9DUploadToken,
		"agent-uploader",
		"",
	)
	upload = stage9DMultipartRequest(t, upload, "sales.csv", "text/csv", []byte(
		"amazon-order-id\tpurchase-date\tsku\tasin\n1\t2026-11-01\tSKU-1\tB001\n",
	), map[string]string{"report_type": "sales_report", "country": "US"})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, upload)
	if rec.Code != http.StatusOK {
		t.Fatalf("upload validation status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"temp_file_id":"tmp_sales"`) {
		t.Fatalf("upload validation body = %s", rec.Body.String())
	}
	if uploadStore.lastValidate.Filename != "sales.csv" ||
		uploadStore.lastValidate.ReportType != "sales_report" {
		t.Fatalf("validate request = %#v", uploadStore.lastValidate)
	}
}

func TestStage9DProvisioningPreviewConfirmAndScopeEscalation(t *testing.T) {
	keys := &stage9DKeyStore{
		projects:      agent_credentials.ProjectValidation{},
		projectID:     7,
		projectActive: true,
	}
	credentials := stage9DCredentials{
		agentauth.HashAgentToken(stage9DProvisionToken): {
			KeyID:         10,
			AgentID:       "agent-provisioner",
			Label:         "签发员",
			BusinessScope: "agent_provisioning",
			ProjectScope:  "*",
			LastUsedAt:    stage9DTimePointer(time.Now().UTC()),
		},
	}
	registrar := agent_credentials.NewRegistrar(keys, nil, agent_credentials.Options{
		Credentials:  credentials,
		ConfirmStore: agentauth.NewMemoryConfirmStore(),
		Auditor:      audit.NewMockService(),
	})
	router := chi.NewRouter()
	registrar.RegisterRoutes(router, nil)

	body := `{"label":"库存助理","agent_id":"inventory-simon-v1","project_scope":"7","business_scope":"inventory,sales"}`
	preview := stage9DRequest(
		router,
		http.MethodPost,
		"/api/v1/agent/provisioning/keys",
		body,
		stage9DProvisionToken,
		"agent-provisioner",
		"idem-create",
	)
	previewRecorder := httptest.NewRecorder()
	router.ServeHTTP(previewRecorder, preview)
	if previewRecorder.Code != http.StatusOK {
		t.Fatalf("preview status = %d, want 200: %s", previewRecorder.Code, previewRecorder.Body.String())
	}
	if keys.createCalls != 0 {
		t.Fatal("preview created a credential")
	}
	var previewBody struct {
		OK                   bool           `json:"ok"`
		RequiresConfirmation bool           `json:"requires_confirmation"`
		ConfirmToken         string         `json:"confirm_token"`
		Preview              map[string]any `json:"preview"`
	}
	if err := json.Unmarshal(previewRecorder.Body.Bytes(), &previewBody); err != nil {
		t.Fatalf("decode preview: %v", err)
	}
	if previewBody.OK || !previewBody.RequiresConfirmation ||
		previewBody.ConfirmToken == "" ||
		previewBody.Preview["action"] != "agent_key.create" {
		t.Fatalf("preview body = %#v", previewBody)
	}

	replay := stage9DRequest(
		router,
		http.MethodPost,
		"/api/v1/agent/provisioning/keys",
		body,
		stage9DProvisionToken,
		"agent-provisioner",
		"idem-create",
	)
	replay.Header.Set(agentauth.ConfirmTokenHeader, previewBody.ConfirmToken)
	replayRecorder := httptest.NewRecorder()
	router.ServeHTTP(replayRecorder, replay)
	if replayRecorder.Code != http.StatusOK {
		t.Fatalf("confirm status = %d, want 200: %s", replayRecorder.Code, replayRecorder.Body.String())
	}
	if keys.createCalls != 1 {
		t.Fatalf("create calls = %d, want 1", keys.createCalls)
	}
	if !strings.Contains(replayRecorder.Body.String(), `"plaintext_key":"bbx_once"`) {
		t.Fatalf("create response omitted one-time secret: %s", replayRecorder.Body.String())
	}
	if keys.lastCreateInput.BusinessScope != "inventory,sales" ||
		keys.lastCreateActor.AgentID != "agent-provisioner" {
		t.Fatalf("create input/actor = %#v / %#v", keys.lastCreateInput, keys.lastCreateActor)
	}
	if _, ok := keys.lastCreateAudit.AfterJSON.(map[string]any)["via"]; !ok {
		t.Fatalf("create audit after_json = %#v, want provisioning attribution", keys.lastCreateAudit.AfterJSON)
	}

	replayAgain := stage9DRequest(
		router,
		http.MethodPost,
		"/api/v1/agent/provisioning/keys",
		body,
		stage9DProvisionToken,
		"agent-provisioner",
		"idem-create",
	)
	replayAgain.Header.Set(agentauth.ConfirmTokenHeader, previewBody.ConfirmToken)
	replayAgainRecorder := httptest.NewRecorder()
	router.ServeHTTP(replayAgainRecorder, replayAgain)
	if replayAgainRecorder.Code != http.StatusBadRequest {
		t.Fatalf("token replay status = %d, want 400: %s", replayAgainRecorder.Code, replayAgainRecorder.Body.String())
	}

	for _, badBody := range []string{
		`{"label":"x","agent_id":"inventory-agent-2","project_scope":"7","business_scope":"*"}`,
		`{"label":"x","agent_id":"inventory-agent-2","project_scope":"7","business_scope":"inventory,agent_provisioning"}`,
	} {
		response := stage9DRequest(
			router,
			http.MethodPost,
			"/api/v1/agent/provisioning/keys",
			badBody,
			stage9DProvisionToken,
			"agent-provisioner",
			"idem-bad",
		)
		responseRecorder := httptest.NewRecorder()
		router.ServeHTTP(responseRecorder, response)
		if responseRecorder.Code != http.StatusBadRequest {
			t.Fatalf("scope escalation status = %d, want 400: %s", responseRecorder.Code, responseRecorder.Body.String())
		}
	}
}

func TestStage9DProvisioningUpdateRequiresConfirmation(t *testing.T) {
	keys := &stage9DKeyStore{projects: agent_credentials.ProjectValidation{}}
	credentials := stage9DCredentials{
		agentauth.HashAgentToken(stage9DProvisionToken): {
			KeyID:         10,
			AgentID:       "agent-provisioner",
			Label:         "签发员",
			BusinessScope: "agent_provisioning",
			ProjectScope:  "*",
			LastUsedAt:    stage9DTimePointer(time.Now().UTC()),
		},
	}
	registrar := agent_credentials.NewRegistrar(keys, nil, agent_credentials.Options{
		Credentials:  credentials,
		ConfirmStore: agentauth.NewMemoryConfirmStore(),
		Auditor:      audit.NewMockService(),
	})
	router := chi.NewRouter()
	registrar.RegisterRoutes(router, nil)
	body := `{"label":"改名后","business_scope":"inventory,sales"}`
	preview := stage9DRequest(
		router,
		http.MethodPatch,
		"/api/v1/agent/provisioning/keys/42",
		body,
		stage9DProvisionToken,
		"agent-provisioner",
		"idem-update",
	)
	previewRecorder := httptest.NewRecorder()
	router.ServeHTTP(previewRecorder, preview)
	if previewRecorder.Code != http.StatusOK {
		t.Fatalf("update preview status = %d: %s", previewRecorder.Code, previewRecorder.Body.String())
	}
	var previewBody struct {
		ConfirmToken string `json:"confirm_token"`
	}
	if err := json.Unmarshal(previewRecorder.Body.Bytes(), &previewBody); err != nil {
		t.Fatalf("decode update preview: %v", err)
	}
	replay := stage9DRequest(
		router,
		http.MethodPatch,
		"/api/v1/agent/provisioning/keys/42",
		body,
		stage9DProvisionToken,
		"agent-provisioner",
		"idem-update",
	)
	replay.Header.Set(agentauth.ConfirmTokenHeader, previewBody.ConfirmToken)
	replayRecorder := httptest.NewRecorder()
	router.ServeHTTP(replayRecorder, replay)
	if replayRecorder.Code != http.StatusOK {
		t.Fatalf("update confirm status = %d: %s", replayRecorder.Code, replayRecorder.Body.String())
	}
	if keys.updateCalls != 1 || keys.lastUpdateID != 42 ||
		keys.lastUpdateInput.Label == nil || *keys.lastUpdateInput.Label != "改名后" {
		t.Fatalf("update calls/input = %d %#v", keys.updateCalls, keys.lastUpdateInput)
	}
}

func TestStage9DUploadCommitScopeAndIdempotency(t *testing.T) {
	keys := &stage9DKeyStore{projectID: 7, projectActive: true}
	uploadsStore := &stage9DUploadStore{
		commitResponse: &agent_credentials.AgentUploadCommitResponse{
			ReportType:        "sales_report",
			Status:            "persisted",
			ProjectName:       stage9DStringPointer("北美"),
			Country:           "US",
			FileID:            "sales-permanent.csv",
			FilePath:          "/tmp/sales-permanent.csv",
			PersistedSourceID: stage9DInt64Pointer(99),
			PersistedTable:    stage9DStringPointer("analysis_source_files"),
			Message:           "销售报表已保存",
			DuplicateWarnings: []uploads.DuplicateWarning{},
		},
	}
	credentials := stage9DCredentials{
		agentauth.HashAgentToken(stage9DUploadToken): {
			KeyID:         11,
			AgentID:       "agent-uploader",
			Label:         "上传员",
			BusinessScope: "report_upload",
			ProjectScope:  "7",
			LastUsedAt:    stage9DTimePointer(time.Now().UTC()),
		},
	}
	registrar := agent_credentials.NewRegistrar(keys, uploadsStore, agent_credentials.Options{
		Credentials:  credentials,
		ConfirmStore: agentauth.NewMemoryConfirmStore(),
		Auditor:      audit.NewMockService(),
	})
	router := chi.NewRouter()
	registrar.RegisterRoutes(router, nil)
	body := `{"temp_file_id":"tmp_1","report_type":"sales_report","project_name":"北美","country":"US","report_date":"2026-11-01"}`
	request := stage9DRequest(
		router,
		http.MethodPost,
		"/api/v1/agent/upload/commit",
		body,
		stage9DUploadToken,
		"agent-uploader",
		"idem-upload",
	)
	first := httptest.NewRecorder()
	router.ServeHTTP(first, request)
	if first.Code != http.StatusOK {
		t.Fatalf("commit status = %d: %s", first.Code, first.Body.String())
	}
	if uploadsStore.commitCalls != 1 || uploadsStore.lastCommitScope != "7" {
		t.Fatalf("commit calls/scope = %d %q", uploadsStore.commitCalls, uploadsStore.lastCommitScope)
	}

	second := stage9DRequest(
		router,
		http.MethodPost,
		"/api/v1/agent/upload/commit",
		body,
		stage9DUploadToken,
		"agent-uploader",
		"idem-upload",
	)
	secondRecorder := httptest.NewRecorder()
	router.ServeHTTP(secondRecorder, second)
	if secondRecorder.Code != http.StatusOK || secondRecorder.Body.String() != first.Body.String() {
		t.Fatalf("idempotent replay = (%d, %s), want same response", secondRecorder.Code, secondRecorder.Body.String())
	}
	if uploadsStore.commitCalls != 1 {
		t.Fatalf("commit calls after replay = %d, want 1", uploadsStore.commitCalls)
	}

	conflict := stage9DRequest(
		router,
		http.MethodPost,
		"/api/v1/agent/upload/commit",
		`{"temp_file_id":"tmp_2","report_type":"sales_report","project_name":"北美","country":"US","report_date":"2026-11-02"}`,
		stage9DUploadToken,
		"agent-uploader",
		"idem-upload",
	)
	conflictRecorder := httptest.NewRecorder()
	router.ServeHTTP(conflictRecorder, conflict)
	if conflictRecorder.Code != http.StatusConflict {
		t.Fatalf("idempotency conflict status = %d, want 409: %s", conflictRecorder.Code, conflictRecorder.Body.String())
	}

	outOfScope := stage9DRequest(
		router,
		http.MethodPost,
		"/api/v1/agent/upload/commit",
		`{"temp_file_id":"tmp_3","report_type":"sales_report","project_name":"其他项目","country":"US","report_date":"2026-11-01"}`,
		stage9DUploadToken,
		"agent-uploader",
		"idem-scope",
	)
	keys.projectID = 8
	outOfScopeRecorder := httptest.NewRecorder()
	router.ServeHTTP(outOfScopeRecorder, outOfScope)
	if outOfScopeRecorder.Code != http.StatusForbidden {
		t.Fatalf("project scope status = %d, want 403: %s", outOfScopeRecorder.Code, outOfScopeRecorder.Body.String())
	}

	uploadsStore.commitErr = agent_credentials.ErrUploadDependencyMissing
	missingDependency := stage9DRequest(
		router,
		http.MethodPost,
		"/api/v1/agent/upload/commit",
		`{"temp_file_id":"tmp_4","report_type":"sales_report","project_name":"北美","country":"US","report_date":"2026-11-01"}`,
		stage9DUploadToken,
		"agent-uploader",
		"idem-missing",
	)
	keys.projectID = 7
	missingRecorder := httptest.NewRecorder()
	router.ServeHTTP(missingRecorder, missingDependency)
	if missingRecorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing dependency status = %d, want 503: %s", missingRecorder.Code, missingRecorder.Body.String())
	}
}

func TestStage9DInternalAPIKeyPatchContract(t *testing.T) {
	createdAt := time.Date(2026, 11, 8, 1, 2, 3, 0, time.UTC)
	store := &stage9DInternalKeysStore{apiKey: &internal_keys.APIKey{
		ID:            7,
		KeyPrefix:     "bbx_12345678",
		Label:         "old",
		Scope:         "read",
		ProjectScope:  "1",
		BusinessScope: "inventory",
		CreatedAt:     createdAt,
	}}
	auditor := audit.NewMockService()
	handler := internal_keys.NewHandler(store, auditor)

	request := stage9DAdminRequest(
		http.MethodPatch,
		"/api/v1/internal/api-keys/7",
		`{"label":"new","project_scope":"12, 34","business_scope":"shipments,shop_calculations","item_key":"multica://item"}`,
	)
	request = stage9DWithURLParam(request, "key_id", "7")
	recorder := httptest.NewRecorder()
	handler.UpdateAPIKey(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var item internal_keys.APIKeyItem
	if err := json.Unmarshal(recorder.Body.Bytes(), &item); err != nil {
		t.Fatalf("decode PATCH response: %v", err)
	}
	if item.ProjectScope != "12, 34" ||
		item.BusinessScope != "shipments,shop_calculations" ||
		item.ItemKey == nil || *item.ItemKey != "multica://item" {
		t.Fatalf("PATCH item = %#v", item)
	}
	if len(auditor.Entries) != 1 || auditor.Entries[0].Action != "api_key.update" {
		t.Fatalf("audit entries = %#v", auditor.Entries)
	}
	if strings.Contains(recorder.Body.String(), "key_hash") {
		t.Fatalf("PATCH leaked key hash: %s", recorder.Body.String())
	}

	nonAdmin := stage9DWithURLParam(
		httptest.NewRequest(http.MethodPatch, "/api/v1/internal/api-keys/7", strings.NewReader(`{"label":"x"}`)),
		"key_id",
		"7",
	)
	nonAdmin = nonAdmin.WithContext(requestauth.WithUserContext(nonAdmin.Context(), requestauth.UserContext{
		UserID: "operator-1", IsAdmin: false,
	}))
	nonAdminRecorder := httptest.NewRecorder()
	handler.UpdateAPIKey(nonAdminRecorder, nonAdmin)
	if nonAdminRecorder.Code != http.StatusForbidden {
		t.Fatalf("non-admin status = %d, want 403", nonAdminRecorder.Code)
	}

	invalidID := stage9DAdminRequest(http.MethodPatch, "/api/v1/internal/api-keys/nope", `{"label":"x"}`)
	invalidID = stage9DWithURLParam(invalidID, "key_id", "nope")
	invalidRecorder := httptest.NewRecorder()
	handler.UpdateAPIKey(invalidRecorder, invalidID)
	if invalidRecorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid id status = %d, want 422", invalidRecorder.Code)
	}

	store.apiKey = nil
	notFound := stage9DAdminRequest(http.MethodPatch, "/api/v1/internal/api-keys/99", `{"label":"x"}`)
	notFound = stage9DWithURLParam(notFound, "key_id", "99")
	notFoundRecorder := httptest.NewRecorder()
	handler.UpdateAPIKey(notFoundRecorder, notFound)
	if notFoundRecorder.Code != http.StatusNotFound {
		t.Fatalf("not found status = %d, want 404", notFoundRecorder.Code)
	}

	store.updateErr = internal_keys.ErrAPIKeyUpdateConflict
	conflict := stage9DAdminRequest(http.MethodPatch, "/api/v1/internal/api-keys/7", `{"business_scope":"inventory,agent_provisioning"}`)
	conflict = stage9DWithURLParam(conflict, "key_id", "7")
	conflictRecorder := httptest.NewRecorder()
	handler.UpdateAPIKey(conflictRecorder, conflict)
	if conflictRecorder.Code != http.StatusConflict {
		t.Fatalf("singleton conflict status = %d, want 409", conflictRecorder.Code)
	}

	invalidBody := stage9DAdminRequest(http.MethodPatch, "/api/v1/internal/api-keys/7", `{"label":""}`)
	invalidBody = stage9DWithURLParam(invalidBody, "key_id", "7")
	invalidBodyRecorder := httptest.NewRecorder()
	handler.UpdateAPIKey(invalidBodyRecorder, invalidBody)
	if invalidBodyRecorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid body status = %d, want 422", invalidBodyRecorder.Code)
	}
}

type stage9DCredentials map[string]agentauth.CredentialRow

func (store stage9DCredentials) FindByHash(
	_ context.Context,
	keyHash string,
) (*agentauth.CredentialRow, error) {
	row, ok := store[keyHash]
	if !ok {
		return nil, nil
	}
	copy := row
	return &copy, nil
}

func (stage9DCredentials) TouchLastUsed(context.Context, int64, time.Time) error {
	return nil
}

type stage9DKeyStore struct {
	list            []agent_credentials.AgentKey
	projects        agent_credentials.ProjectValidation
	projectID       int64
	projectActive   bool
	activeExists    bool
	createCalls     int
	updateCalls     int
	lastCreateInput agent_credentials.AgentKeyCreateInput
	lastCreateActor agent_credentials.Actor
	lastCreateAudit audit.Entry
	lastUpdateID    int64
	lastUpdateInput agent_credentials.AgentKeyUpdateInput
	listErr         error
	createErr       error
	updateErr       error
}

func (store *stage9DKeyStore) ListAgentKeys(context.Context) ([]agent_credentials.AgentKey, error) {
	return store.list, store.listErr
}

func (store *stage9DKeyStore) CreateAgentKey(
	_ context.Context,
	input agent_credentials.AgentKeyCreateInput,
	actor agent_credentials.Actor,
	entry audit.Entry,
) (*agent_credentials.AgentKey, string, error) {
	store.createCalls++
	store.lastCreateInput = input
	store.lastCreateActor = actor
	store.lastCreateAudit = entry
	if store.createErr != nil {
		return nil, "", store.createErr
	}
	agentID := input.AgentID
	return &agent_credentials.AgentKey{
		ID:            42,
		KeyPrefix:     "bbx_12345678",
		Label:         input.Label,
		Scope:         "read",
		ProjectScope:  input.ProjectScope,
		BusinessScope: input.BusinessScope,
		AgentID:       &agentID,
		ItemKey:       input.ItemKey,
		ExpiresAt:     input.ExpiresAt,
		CreatedAt:     time.Now().UTC(),
	}, "bbx_once", nil
}

func (store *stage9DKeyStore) UpdateAgentKey(
	_ context.Context,
	id int64,
	input agent_credentials.AgentKeyUpdateInput,
	_ agent_credentials.Actor,
	_ audit.Entry,
) (*agent_credentials.AgentKey, error) {
	store.updateCalls++
	store.lastUpdateID = id
	store.lastUpdateInput = input
	if store.updateErr != nil {
		return nil, store.updateErr
	}
	agentID := "inventory-simon-v1"
	label := "改名后"
	projectScope := "7"
	businessScope := "inventory,sales"
	if input.Label != nil {
		label = *input.Label
	}
	if input.ProjectScope != nil {
		projectScope = *input.ProjectScope
	}
	if input.BusinessScope != nil {
		businessScope = *input.BusinessScope
	}
	return &agent_credentials.AgentKey{
		ID:            id,
		KeyPrefix:     "bbx_12345678",
		Label:         label,
		Scope:         "read",
		ProjectScope:  projectScope,
		BusinessScope: businessScope,
		AgentID:       &agentID,
		ItemKey:       input.ItemKey,
		CreatedAt:     time.Now().UTC(),
	}, nil
}

func (store *stage9DKeyStore) ValidateProjects(
	context.Context,
	[]int64,
) (agent_credentials.ProjectValidation, error) {
	return store.projects, nil
}

func (store *stage9DKeyStore) ActiveAgentKeyExists(context.Context, string) (bool, error) {
	return store.activeExists, nil
}

func (store *stage9DKeyStore) ProjectByName(
	context.Context,
	string,
) (int64, bool, error) {
	return store.projectID, store.projectActive, nil
}

type stage9DUploadStore struct {
	validateResponse *agent_credentials.AgentUploadValidateResponse
	commitResponse   *agent_credentials.AgentUploadCommitResponse
	validateErr      error
	commitErr        error
	commitCalls      int
	lastValidate     agent_credentials.AgentUploadValidateRequest
	lastCommit       agent_credentials.AgentUploadCommitRequest
	lastCommitScope  string
}

func (store *stage9DUploadStore) Validate(
	_ context.Context,
	request agent_credentials.AgentUploadValidateRequest,
) (*agent_credentials.AgentUploadValidateResponse, error) {
	store.lastValidate = request
	if store.validateErr != nil {
		return nil, store.validateErr
	}
	return store.validateResponse, nil
}

func (store *stage9DUploadStore) Commit(
	_ context.Context,
	request agent_credentials.AgentUploadCommitRequest,
	projectScope string,
) (*agent_credentials.AgentUploadCommitResponse, error) {
	store.commitCalls++
	store.lastCommit = request
	store.lastCommitScope = projectScope
	if store.commitErr != nil {
		return nil, store.commitErr
	}
	return store.commitResponse, nil
}

type stage9DInternalKeysStore struct {
	apiKey    *internal_keys.APIKey
	updateErr error
}

func (store *stage9DInternalKeysStore) ListAPIKeys(context.Context, bool) ([]internal_keys.APIKey, error) {
	if store.apiKey == nil {
		return []internal_keys.APIKey{}, nil
	}
	return []internal_keys.APIKey{*store.apiKey}, nil
}

func (store *stage9DInternalKeysStore) CreateAPIKey(
	context.Context,
	internal_keys.APIKeyCreateInput,
	string,
) (*internal_keys.APIKey, string, error) {
	return store.apiKey, "bbx_new", nil
}

func (store *stage9DInternalKeysStore) UpdateAPIKey(
	_ context.Context,
	_ int64,
	input internal_keys.APIKeyUpdateInput,
) (*internal_keys.APIKey, error) {
	if store.updateErr != nil {
		return nil, store.updateErr
	}
	if store.apiKey == nil {
		return nil, nil
	}
	record := *store.apiKey
	if input.Label != nil {
		record.Label = *input.Label
	}
	if input.ProjectScope != nil {
		record.ProjectScope = *input.ProjectScope
	}
	if input.BusinessScope != nil {
		record.BusinessScope = *input.BusinessScope
	}
	if input.ItemKey != nil {
		record.ItemKey = input.ItemKey
	}
	return &record, nil
}

func (store *stage9DInternalKeysStore) DeleteAPIKey(context.Context, int64) (*internal_keys.APIKey, error) {
	return store.apiKey, nil
}

func (store *stage9DInternalKeysStore) ListUserAPIKeys(context.Context) ([]internal_keys.UserAPIKey, error) {
	return []internal_keys.UserAPIKey{}, nil
}

func (store *stage9DInternalKeysStore) CreateUserAPIKey(
	context.Context,
	string,
	string,
) (*internal_keys.UserAPIKey, string, error) {
	return nil, "", nil
}

func (store *stage9DInternalKeysStore) DeleteUserAPIKey(context.Context, int64) (*internal_keys.UserAPIKey, error) {
	return nil, nil
}

func (store *stage9DInternalKeysStore) RevokeUserAPIKeys(
	context.Context,
	string,
	*string,
) ([]internal_keys.UserAPIKey, error) {
	return nil, nil
}

func (store *stage9DInternalKeysStore) RotateUserAPIKey(
	context.Context,
	string,
	*string,
) (*internal_keys.UserAPIKey, string, error) {
	return nil, "", nil
}

func stage9DRequest(
	router http.Handler,
	method string,
	path string,
	body string,
	token string,
	agentID string,
	idempotencyKey string,
) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("X-Agent-Id", agentID)
	}
	if idempotencyKey != "" {
		request.Header.Set("Idempotency-Key", idempotencyKey)
	}
	return request
}

func stage9DMultipartRequest(
	t *testing.T,
	request *http.Request,
	filename string,
	contentType string,
	data []byte,
	fields map[string]string,
) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatalf("write field %s: %v", key, err)
		}
	}
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatalf("write multipart file: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	request.Body = ioNopCloser(body.Bytes())
	request.ContentLength = int64(body.Len())
	request.Header.Set("Content-Type", writer.FormDataContentType())
	if contentType != "" {
		request.Header.Set("X-Test-Content-Type", contentType)
	}
	return request
}

func stage9DAdminRequest(method, path, body string) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request = request.WithContext(requestauth.WithUserContext(request.Context(), requestauth.UserContext{
		UserID:   "admin-1",
		Email:    "admin@example.com",
		Operator: "Admin",
		IsAdmin:  true,
	}))
	return request
}

func stage9DWithURLParam(request *http.Request, key, value string) *http.Request {
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add(key, value)
	return request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routeContext))
}

func stage9DStringPointer(value string) *string {
	return &value
}

func stage9DInt64Pointer(value int64) *int64 {
	return &value
}

func stage9DTimePointer(value time.Time) *time.Time {
	return &value
}

func ioNopCloser(data []byte) *stage9DReadCloser {
	return &stage9DReadCloser{Reader: bytes.NewReader(data)}
}

type stage9DReadCloser struct {
	*bytes.Reader
}

func (*stage9DReadCloser) Close() error {
	return nil
}
