package contract_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_commerce"
)

const (
	contractToken    = "stage9c-agent-token"
	contractAgentID  = "agent-stage9c"
	contractAgentLbl = "Stage 9C Test Agent"
)

type contractCredentialStore struct {
	mu   sync.Mutex
	rows map[string]*agentauth.CredentialRow
}

func newContractCredentialStore(
	businessScope string,
	projectScope string,
) *contractCredentialStore {
	return &contractCredentialStore{rows: map[string]*agentauth.CredentialRow{
		agentauth.HashAgentToken(contractToken): {
			KeyID:         1,
			AgentID:       contractAgentID,
			Label:         contractAgentLbl,
			BusinessScope: businessScope,
			ProjectScope:  projectScope,
		},
	}}
}

func (s *contractCredentialStore) FindByHash(
	_ context.Context,
	keyHash string,
) (*agentauth.CredentialRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row := s.rows[keyHash]
	if row == nil {
		return nil, nil
	}
	copy := *row
	return &copy, nil
}

func (s *contractCredentialStore) TouchLastUsed(
	_ context.Context,
	_ int64,
	_ time.Time,
) error {
	return nil
}

type fakeBlobStore struct {
	mu      sync.Mutex
	puts    []string
	deletes []string
	gets    []string
	data    map[string][]byte
}

func (s *fakeBlobStore) Put(
	_ context.Context,
	key string,
	_ []byte,
	_ string,
) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.puts = append(s.puts, key)
	return "https://blob.example.test/" + key, nil
}

func (s *fakeBlobStore) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deletes = append(s.deletes, key)
	return nil
}

func (s *fakeBlobStore) Get(_ context.Context, key string) (io.ReadCloser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gets = append(s.gets, key)
	data := s.data[key]
	if len(data) == 0 {
		return nil, errors.New("blob not found")
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

type fakeCommerceStore struct {
	project      *agent_commerce.ProjectInfo
	projectErr   error
	page         agent_commerce.SKUSPage
	sku          *agent_commerce.SKURecord
	skuErr       error
	upsertResult agent_commerce.SKURecord
	upsertAction string
	updateAfter  *agent_commerce.SKURecord
	batchResult  agent_commerce.ListingCopyBatchResult
	statusResult agent_commerce.SKURecord
	statusChange bool
	auditItems   []agent_commerce.AuditItem
	auditErr     error
	writeErr     error
	previousKey  *string
	templateData *agent_commerce.ShipmentTemplateData
	boxData      agent_commerce.FBABoxData
	newRows      []agent_commerce.NewProductExportRow
	shopData     agent_commerce.ShopExportData
	audits       []agent_commerce.AuditEntry
	writeAudits  []agent_commerce.AuditEntry
	mutations    []string
}

func (s *fakeCommerceStore) VerifyProject(
	_ context.Context,
	_ int64,
) (*agent_commerce.ProjectInfo, error) {
	if s.projectErr != nil {
		return nil, s.projectErr
	}
	if s.project == nil {
		return nil, agent_commerce.ErrProjectNotFound
	}
	copy := *s.project
	return &copy, nil
}

func (s *fakeCommerceStore) ListSKU(
	_ context.Context,
	_ int64,
	_ agent_commerce.SKUFilter,
) (agent_commerce.SKUSPage, error) {
	return s.page, nil
}

func (s *fakeCommerceStore) GetSKU(
	_ context.Context,
	projectID, recordID int64,
) (*agent_commerce.SKURecord, error) {
	if s.skuErr != nil {
		return nil, s.skuErr
	}
	if s.sku == nil || projectID < 1 || recordID < 1 {
		return nil, agent_commerce.ErrSKUNotFound
	}
	copy := *s.sku
	return &copy, nil
}

func (s *fakeCommerceStore) UpsertSKU(
	_ context.Context,
	_ int64,
	_ agent_commerce.SKUUpsertInput,
	entry agent_commerce.AuditEntry,
) (agent_commerce.SKURecord, string, error) {
	s.mutations = append(s.mutations, "upsert")
	s.writeAudits = append(s.writeAudits, entry)
	if s.writeErr != nil {
		return agent_commerce.SKURecord{}, "", s.writeErr
	}
	action := s.upsertAction
	if action == "" {
		action = "inserted"
	}
	return s.upsertResult, action, nil
}

func (s *fakeCommerceStore) UpdateSKU(
	_ context.Context,
	_, _ int64,
	_ agent_commerce.SKUUpdateInput,
	entry agent_commerce.AuditEntry,
) (*agent_commerce.SKURecord, *agent_commerce.SKURecord, error) {
	s.mutations = append(s.mutations, "update")
	s.writeAudits = append(s.writeAudits, entry)
	if s.writeErr != nil {
		return nil, nil, s.writeErr
	}
	before := s.sku
	after := s.updateAfter
	if after == nil {
		after = before
	}
	return before, after, nil
}

func (s *fakeCommerceStore) BatchUpdateListingCopy(
	_ context.Context,
	_ int64,
	_ agent_commerce.ListingCopyBatchInput,
	entry agent_commerce.AuditEntry,
) (agent_commerce.ListingCopyBatchResult, error) {
	s.mutations = append(s.mutations, "batch")
	s.writeAudits = append(s.writeAudits, entry)
	if s.writeErr != nil {
		return agent_commerce.ListingCopyBatchResult{}, s.writeErr
	}
	return s.batchResult, nil
}

func (s *fakeCommerceStore) TransitionSKUStatus(
	_ context.Context,
	_, _ int64,
	_ agent_commerce.SKUStatusInput,
	entry agent_commerce.AuditEntry,
) (agent_commerce.SKURecord, bool, error) {
	s.mutations = append(s.mutations, "status")
	s.writeAudits = append(s.writeAudits, entry)
	if s.writeErr != nil {
		return agent_commerce.SKURecord{}, false, s.writeErr
	}
	return s.statusResult, s.statusChange, nil
}

func (s *fakeCommerceStore) DeleteSKU(
	_ context.Context,
	_, _ int64,
	entry agent_commerce.AuditEntry,
) (agent_commerce.SKURecord, error) {
	s.mutations = append(s.mutations, "delete")
	s.writeAudits = append(s.writeAudits, entry)
	if s.writeErr != nil {
		return agent_commerce.SKURecord{}, s.writeErr
	}
	return *s.sku, nil
}

func (s *fakeCommerceStore) ListSKUAudit(
	_ context.Context,
	_, _ int64,
	_ int,
) ([]agent_commerce.AuditItem, error) {
	if s.auditErr != nil {
		return nil, s.auditErr
	}
	return s.auditItems, nil
}

func (s *fakeCommerceStore) SetFNSKULabel(
	_ context.Context,
	_, _ int64,
	_ string,
	_ string,
	_ int64,
	entry agent_commerce.AuditEntry,
) (*string, error) {
	s.mutations = append(s.mutations, "fnsku")
	s.writeAudits = append(s.writeAudits, entry)
	if s.writeErr != nil {
		return nil, s.writeErr
	}
	return s.previousKey, nil
}

func (s *fakeCommerceStore) RecordAudit(
	_ context.Context,
	entry agent_commerce.AuditEntry,
) error {
	s.audits = append(s.audits, entry)
	return nil
}

func (s *fakeCommerceStore) ResolveShipment(
	_ context.Context,
	_ int64,
	_ string,
) (*agent_commerce.ShipmentDetail, error) {
	if s.templateData == nil || s.templateData.Detail == nil {
		return nil, agent_commerce.ErrShipmentNotFound
	}
	detail := *s.templateData.Detail
	return &detail, nil
}

func (s *fakeCommerceStore) ListFBABoxDetails(
	_ context.Context,
	_ int64,
	_ []string,
) (agent_commerce.FBABoxData, error) {
	return s.boxData, nil
}

func (s *fakeCommerceStore) PrepareShipmentTemplate(
	_ context.Context,
	_ int64,
	_ string,
) (*agent_commerce.ShipmentTemplateData, error) {
	if s.templateData == nil {
		return nil, agent_commerce.ErrShipmentNotFound
	}
	return s.templateData, nil
}

func (s *fakeCommerceStore) ListNewProductExports(
	_ context.Context,
	_ int64,
	_ []int64,
) ([]agent_commerce.NewProductExportRow, error) {
	return s.newRows, nil
}

func (s *fakeCommerceStore) ListShopExport(
	_ context.Context,
	_ int64,
	_ agent_commerce.ShopExportFilter,
) (agent_commerce.ShopExportData, error) {
	return s.shopData, nil
}

type contractServer struct {
	handler    http.Handler
	credential *contractCredentialStore
	store      *fakeCommerceStore
	blobs      *fakeBlobStore
}

func newContractServer(
	t *testing.T,
	businessScope string,
	projectScope string,
) *contractServer {
	t.Helper()
	credential := newContractCredentialStore(businessScope, projectScope)
	store := &fakeCommerceStore{
		project: &agent_commerce.ProjectInfo{ID: 1, Name: "Project A"},
		sku: &agent_commerce.SKURecord{
			ID:          11,
			ProjectName: "Project A",
			SKU:         "SKU-1",
			ASIN:        "B000000001",
			Country:     "US",
			IsActive:    true,
			Currency:    "CNY",
			CreatedAt:   "2026-11-08T00:00:00Z",
			UpdatedAt:   "2026-11-08T00:00:00Z",
		},
	}
	blobs := &fakeBlobStore{}
	registrar := agent_commerce.NewRegistrar(store, agent_commerce.Options{
		Credentials:      credential,
		ConfirmStore:     agentauth.NewMemoryConfirmStore(),
		Blobs:            blobs,
		ReadRateLimiter:  agentauth.NewMemoryRateLimiter(agentauth.RateLimit{Requests: 1000, Window: time.Minute}),
		WriteRateLimiter: agentauth.NewMemoryRateLimiter(agentauth.RateLimit{Requests: 1000, Window: time.Minute}),
		Now:              func() time.Time { return time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC) },
	})
	router := chi.NewRouter()
	registrar.RegisterRoutes(router, nil)
	return &contractServer{handler: router, credential: credential, store: store, blobs: blobs}
}

func (s *contractServer) do(
	t *testing.T,
	method, path string,
	body []byte,
	contentType string,
	headers map[string]string,
) *http.Response {
	t.Helper()
	request, err := http.NewRequest(method, path, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Authorization", "Bearer "+contractToken)
	request.Header.Set("X-Agent-Id", contractAgentID)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	s.handler.ServeHTTP(recorder, request)
	return recorder.Result()
}

func readBody(t *testing.T, response *http.Response) []byte {
	t.Helper()
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return body
}

func decodeMap(t *testing.T, data []byte) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatalf("decode json: %v; body=%s", err, data)
	}
	return value
}

func errorCode(t *testing.T, body []byte) string {
	t.Helper()
	root := decodeMap(t, body)
	errValue, _ := root["error"].(map[string]any)
	code, _ := errValue["code"].(string)
	if code == "" {
		code, _ = root["error_code"].(string)
	}
	return code
}

func previewToken(t *testing.T, body []byte) string {
	t.Helper()
	root := decodeMap(t, body)
	requires, _ := root["requires_confirmation"].(bool)
	if !requires {
		t.Fatalf("expected confirmation preview, body=%s", body)
	}
	token, _ := root["confirm_token"].(string)
	if token == "" {
		t.Fatalf("missing confirm_token: %s", body)
	}
	return token
}

func confirmJSON(
	t *testing.T,
	server *contractServer,
	method, path string,
	body []byte,
	idempotencyKey string,
) *http.Response {
	t.Helper()
	headers := map[string]string{"Idempotency-Key": idempotencyKey}
	preview := server.do(t, method, path, body, "application/json", headers)
	previewBody := readBody(t, preview)
	if preview.StatusCode != http.StatusOK {
		t.Fatalf("confirmation preview status=%d body=%s", preview.StatusCode, previewBody)
	}
	token := previewToken(t, previewBody)
	headers[agentauth.ConfirmTokenHeader] = token
	return server.do(t, method, path, body, "application/json", headers)
}

func multipartBody(t *testing.T, source, filename string, content []byte) ([]byte, string) {
	t.Helper()
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	if err := writer.WriteField("source", source); err != nil {
		t.Fatalf("write source: %v", err)
	}
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("create file part: %v", err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatalf("write multipart file: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	return buffer.Bytes(), writer.FormDataContentType()
}

func assertXLSX(t *testing.T, body []byte) {
	t.Helper()
	if len(body) < 4 || !bytes.HasPrefix(body, []byte("PK\x03\x04")) {
		t.Fatalf("response is not an xlsx zip: prefix=%q", body[:min(len(body), 16)])
	}
	reader, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("open xlsx: %v", err)
	}
	names := make(map[string]bool, len(reader.File))
	for _, file := range reader.File {
		names[file.Name] = true
		if strings.HasSuffix(file.Name, ".xml") {
			content, err := file.Open()
			if err != nil {
				t.Fatalf("open xlsx XML part %s: %v", file.Name, err)
			}
			var parsed struct{}
			if err := xml.NewDecoder(content).Decode(&parsed); err != nil {
				content.Close()
				t.Fatalf("xlsx XML part %s is malformed: %v", file.Name, err)
			}
			content.Close()
		}
	}
	for _, required := range []string{
		"[Content_Types].xml",
		"_rels/.rels",
		"xl/workbook.xml",
		"xl/_rels/workbook.xml.rels",
		"xl/worksheets/sheet1.xml",
	} {
		if !names[required] {
			t.Fatalf("xlsx missing part %s; got %v", required, names)
		}
	}
}

func assertXLSXContains(t *testing.T, body []byte, required ...string) {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("open xlsx: %v", err)
	}
	names := make(map[string]bool, len(reader.File))
	for _, file := range reader.File {
		names[file.Name] = true
	}
	for _, name := range required {
		if !names[name] {
			t.Fatalf("xlsx missing image part %s; got %v", name, names)
		}
	}
}

func TestStage9CRegistrarRoutes(t *testing.T) {
	server := newContractServer(t, "sku_info,shipments,shop_calculations,new_product_calculations", "*")
	_ = server

	credential := newContractCredentialStore("sku_info,shipments,shop_calculations,new_product_calculations", "*")
	store := &fakeCommerceStore{project: &agent_commerce.ProjectInfo{ID: 1, Name: "Project A"}}
	registrar := agent_commerce.NewRegistrar(store, agent_commerce.Options{Credentials: credential})
	if got := registrar.ModuleName(); got != "agent_commerce" {
		t.Fatalf("ModuleName()=%q, want agent_commerce", got)
	}
	router := chi.NewRouter()
	registrar.RegisterRoutes(router, nil)

	got := map[string]bool{}
	if err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		got[method+" "+route] = true
		return nil
	}); err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	expected := []string{
		// Manifest A-0074/A-0092/A-0098/A-0108 + A-0112..A-0120 are 13 unique
		// operations; fba-box-details is counted in both the export and shipment buckets.
		"GET /api/v1/agent/projects/{project_id}/new-product-calculations/export.xlsx",
		"GET /api/v1/agent/projects/{project_id}/shipments/fba-box-details.xlsx",
		"GET /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/fba-delivery-template",
		"GET /api/v1/agent/projects/{project_id}/shop-calculations/export.xlsx",
		"GET /api/v1/agent/projects/{project_id}/sku-info",
		"POST /api/v1/agent/projects/{project_id}/sku-info",
		"POST /api/v1/agent/projects/{project_id}/sku-info/listing-copy/batch",
		"DELETE /api/v1/agent/projects/{project_id}/sku-info/{sku_record_id}",
		"GET /api/v1/agent/projects/{project_id}/sku-info/{sku_record_id}",
		"PATCH /api/v1/agent/projects/{project_id}/sku-info/{sku_record_id}",
		"GET /api/v1/agent/projects/{project_id}/sku-info/{sku_record_id}/audit",
		"POST /api/v1/agent/projects/{project_id}/sku-info/{sku_record_id}/fnsku-label",
		"POST /api/v1/agent/projects/{project_id}/sku-info/{sku_record_id}/status",
	}
	if len(got) != len(expected) {
		t.Fatalf("route count=%d, want %d; routes=%v", len(got), len(expected), got)
	}
	for _, route := range expected {
		if !got[route] {
			t.Fatalf("missing route %q; got %v", route, got)
		}
	}
}

func TestStage9CSKUReadsAndScope(t *testing.T) {
	server := newContractServer(t, "sku_info", "*")
	server.store.page = agent_commerce.SKUSPage{
		Items:    []agent_commerce.SKURecord{*server.store.sku},
		Page:     1,
		PageSize: 200,
		HasNext:  false,
	}
	server.store.auditItems = []agent_commerce.AuditItem{{ID: 99, Action: "sku_info.update", Result: "success"}}

	response := server.do(t, http.MethodGet, "/api/v1/agent/projects/1/sku-info?country=us&is_active=true", nil, "", nil)
	body := readBody(t, response)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("list status=%d body=%s", response.StatusCode, body)
	}
	root := decodeMap(t, body)
	if root["ok"] != true {
		t.Fatalf("list should be ok: %s", body)
	}
	data, _ := root["data"].(map[string]any)
	items, _ := data["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("list items=%v", data)
	}

	response = server.do(t, http.MethodGet, "/api/v1/agent/projects/1/sku-info/11", nil, "", nil)
	body = readBody(t, response)
	if response.StatusCode != http.StatusOK || decodeMap(t, body)["ok"] != true {
		t.Fatalf("detail status=%d body=%s", response.StatusCode, body)
	}

	response = server.do(t, http.MethodGet, "/api/v1/agent/projects/1/sku-info/11/audit", nil, "", nil)
	body = readBody(t, response)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("audit status=%d body=%s", response.StatusCode, body)
	}

	outOfBusiness := newContractServer(t, "shipments", "*")
	response = outOfBusiness.do(t, http.MethodGet, "/api/v1/agent/projects/1/sku-info", nil, "", nil)
	body = readBody(t, response)
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("business scope status=%d body=%s", response.StatusCode, body)
	}

	outOfProject := newContractServer(t, "sku_info", "2")
	response = outOfProject.do(t, http.MethodGet, "/api/v1/agent/projects/1/sku-info", nil, "", nil)
	body = readBody(t, response)
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("project scope status=%d body=%s", response.StatusCode, body)
	}

	missing := newContractServer(t, "sku_info", "*")
	missing.store.skuErr = agent_commerce.ErrSKUNotFound
	response = missing.do(t, http.MethodGet, "/api/v1/agent/projects/1/sku-info/404", nil, "", nil)
	body = readBody(t, response)
	if response.StatusCode != http.StatusNotFound || errorCode(t, body) != "RESOURCE_NOT_FOUND" {
		t.Fatalf("missing detail status=%d body=%s", response.StatusCode, body)
	}

	anonRequest := httptest.NewRequest(http.MethodGet, "/api/v1/agent/projects/1/sku-info", nil)
	anonRecorder := httptest.NewRecorder()
	server.handler.ServeHTTP(anonRecorder, anonRequest)
	if anonRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous status=%d body=%s", anonRecorder.Code, anonRecorder.Body.String())
	}
}

func TestStage9CSKUWritesConfirmAndReplay(t *testing.T) {
	server := newContractServer(t, "sku_info", "*")
	server.store.upsertResult = *server.store.sku
	server.store.updateAfter = &agent_commerce.SKURecord{
		ID:          11,
		ProjectName: "Project A",
		SKU:         "SKU-1",
		ASIN:        "B000000001",
		Country:     "US",
		FOBUnitCost: 12.5,
		IsActive:    true,
		Currency:    "CNY",
	}
	server.store.batchResult = agent_commerce.ListingCopyBatchResult{
		Updated:    1,
		Unchanged:  0,
		UpdatedIDs: []int64{11},
		Items:      []agent_commerce.SKURecord{*server.store.updateAfter},
	}
	server.store.statusResult = agent_commerce.SKURecord{
		ID:          11,
		ProjectName: "Project A",
		SKU:         "SKU-1",
		ASIN:        "B000000001",
		Country:     "US",
		IsActive:    false,
		Currency:    "CNY",
	}
	server.store.statusChange = true

	upsertBody := []byte(`{"sku":"SKU-1","asin":"B000000001","country":"US","source":"agent_user_supplied","fob_unit_cost":12.5}`)
	response := confirmJSON(t, server, http.MethodPost, "/api/v1/agent/projects/1/sku-info", upsertBody, "upsert-1")
	body := readBody(t, response)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("upsert status=%d body=%s", response.StatusCode, body)
	}
	root := decodeMap(t, body)
	if root["idempotency_key"] != "upsert-1" {
		t.Fatalf("upsert idempotency key missing: %s", body)
	}

	replay := confirmJSON(t, server, http.MethodPost, "/api/v1/agent/projects/1/sku-info", upsertBody, "upsert-2")
	_ = replay
	headers := map[string]string{
		"Idempotency-Key": "upsert-1",
		agentauth.ConfirmTokenHeader: previewToken(t, readBody(t, server.do(
			t,
			http.MethodPost,
			"/api/v1/agent/projects/1/sku-info",
			upsertBody,
			"application/json",
			map[string]string{"Idempotency-Key": "upsert-replay"},
		))),
	}
	response = server.do(t, http.MethodPost, "/api/v1/agent/projects/1/sku-info", upsertBody, "application/json", headers)
	body = readBody(t, response)
	if response.StatusCode != http.StatusBadRequest || errorCode(t, body) != "CONFIRM_TOKEN_INVALID" {
		t.Fatalf("confirm resource/idempotency mismatch status=%d body=%s", response.StatusCode, body)
	}

	patchBody := []byte(`{"source":"agent_user_supplied","fob_unit_cost":12.5}`)
	response = confirmJSON(t, server, http.MethodPatch, "/api/v1/agent/projects/1/sku-info/11", patchBody, "patch-1")
	body = readBody(t, response)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("patch status=%d body=%s", response.StatusCode, body)
	}

	batchBody := []byte(`{"source":"agent_user_supplied","items":[{"sku_record_id":11,"listing_title":"New title"}]}`)
	response = confirmJSON(t, server, http.MethodPost, "/api/v1/agent/projects/1/sku-info/listing-copy/batch", batchBody, "batch-1")
	body = readBody(t, response)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("batch status=%d body=%s", response.StatusCode, body)
	}

	statusBody := []byte(`{"source":"agent_user_supplied","is_active":false}`)
	response = confirmJSON(t, server, http.MethodPost, "/api/v1/agent/projects/1/sku-info/11/status", statusBody, "status-1")
	body = readBody(t, response)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status status=%d body=%s", response.StatusCode, body)
	}

	deleteHeaders := map[string]string{"Idempotency-Key": "delete-1"}
	preview := server.do(t, http.MethodDelete, "/api/v1/agent/projects/1/sku-info/11", nil, "", deleteHeaders)
	previewBody := readBody(t, preview)
	if preview.StatusCode != http.StatusOK {
		t.Fatalf("delete preview status=%d body=%s", preview.StatusCode, previewBody)
	}
	deleteHeaders[agentauth.ConfirmTokenHeader] = previewToken(t, previewBody)
	response = server.do(t, http.MethodDelete, "/api/v1/agent/projects/1/sku-info/11", nil, "", deleteHeaders)
	body = readBody(t, response)
	if response.StatusCode != http.StatusOK || decodeMap(t, body)["ok"] != true {
		t.Fatalf("delete status=%d body=%s", response.StatusCode, body)
	}

	if got := strings.Join(server.store.mutations, ","); got != "upsert,upsert,update,batch,status,delete" {
		t.Fatalf("mutations=%q", got)
	}
	if len(server.store.writeAudits) != 6 {
		t.Fatalf("write audit entries=%d, want 6", len(server.store.writeAudits))
	}
	for index, entry := range server.store.writeAudits {
		if entry.AgentID == nil || *entry.AgentID != contractAgentID {
			t.Fatalf("audit[%d] agent attribution=%v", index, entry.AgentID)
		}
	}
	if server.store.writeAudits[0].Action != "sku_info.upsert" {
		t.Fatalf("audit action=%q", server.store.writeAudits[0].Action)
	}
}

func TestStage9CWriteErrors(t *testing.T) {
	server := newContractServer(t, "sku_info", "*")
	server.store.upsertResult = *server.store.sku
	server.store.writeErr = agent_commerce.ErrDuplicate

	body := []byte(`{"sku":"SKU-1","asin":"B000000001","country":"US","source":"agent_user_supplied"}`)
	response := confirmJSON(t, server, http.MethodPost, "/api/v1/agent/projects/1/sku-info", body, "dup-1")
	responseBody := readBody(t, response)
	if response.StatusCode != http.StatusConflict || errorCode(t, responseBody) != "SKU_INFO_DUPLICATE" {
		t.Fatalf("duplicate status=%d body=%s", response.StatusCode, responseBody)
	}

	invalidSource := []byte(`{"sku":"SKU-1","asin":"B000000001","country":"US","source":"manual"}`)
	response = server.do(t, http.MethodPost, "/api/v1/agent/projects/1/sku-info", invalidSource, "application/json", nil)
	responseBody = readBody(t, response)
	if response.StatusCode != http.StatusBadRequest || errorCode(t, responseBody) != "SKU_INFO_INVALID_SOURCE" {
		t.Fatalf("invalid source status=%d body=%s", response.StatusCode, responseBody)
	}

	badProject := newContractServer(t, "sku_info", "*")
	response = badProject.do(t, http.MethodGet, "/api/v1/agent/projects/not-an-int/sku-info", nil, "", nil)
	responseBody = readBody(t, response)
	if response.StatusCode != http.StatusBadRequest || errorCode(t, responseBody) != "VALIDATION_FAILED" {
		t.Fatalf("invalid project status=%d body=%s", response.StatusCode, responseBody)
	}

	unavailable := newContractServer(t, "new_product_calculations", "*")
	unavailable.store.projectErr = agent_commerce.ErrServiceUnavailable
	response = unavailable.do(t, http.MethodGet, "/api/v1/agent/projects/1/new-product-calculations/export.xlsx?snapshot_ids=1", nil, "", nil)
	responseBody = readBody(t, response)
	if response.StatusCode != http.StatusServiceUnavailable || errorCode(t, responseBody) != "SERVICE_UNAVAILABLE" {
		t.Fatalf("unavailable status=%d body=%s", response.StatusCode, responseBody)
	}
}

func TestStage9CFnskuUploadCompensation(t *testing.T) {
	server := newContractServer(t, "sku_info", "*")
	server.store.writeErr = agent_commerce.ErrServiceUnavailable

	content := []byte("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n")
	body, contentType := multipartBody(t, "agent_user_supplied", "label.pdf", content)
	preview := server.do(t, http.MethodPost, "/api/v1/agent/projects/1/sku-info/11/fnsku-label", body, contentType, nil)
	previewBody := readBody(t, preview)
	if preview.StatusCode != http.StatusOK {
		t.Fatalf("fnsku preview status=%d body=%s", preview.StatusCode, previewBody)
	}
	token := previewToken(t, previewBody)

	replayBody, replayType := multipartBody(t, "agent_user_supplied", "label.pdf", content)
	response := server.do(
		t,
		http.MethodPost,
		"/api/v1/agent/projects/1/sku-info/11/fnsku-label",
		replayBody,
		replayType,
		map[string]string{agentauth.ConfirmTokenHeader: token},
	)
	responseBody := readBody(t, response)
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("fnsku compensation status=%d body=%s", response.StatusCode, responseBody)
	}
	if len(server.blobs.puts) != 1 || len(server.blobs.deletes) != 1 {
		t.Fatalf("blob compensation puts=%v deletes=%v", server.blobs.puts, server.blobs.deletes)
	}
	if server.blobs.puts[0] != server.blobs.deletes[0] {
		t.Fatalf("compensated wrong blob key put=%q delete=%q", server.blobs.puts[0], server.blobs.deletes[0])
	}

	invalid := []byte("not a pdf")
	invalidBody, invalidType := multipartBody(t, "agent_user_supplied", "label.pdf", invalid)
	response = server.do(t, http.MethodPost, "/api/v1/agent/projects/1/sku-info/11/fnsku-label", invalidBody, invalidType, nil)
	responseBody = readBody(t, response)
	if response.StatusCode != http.StatusBadRequest || errorCode(t, responseBody) != "VALIDATION_FAILED" {
		t.Fatalf("invalid pdf status=%d body=%s", response.StatusCode, responseBody)
	}
}

func TestStage9CExportsProduceRealXLSX(t *testing.T) {
	server := newContractServer(t, "shipments,shop_calculations,new_product_calculations", "*")
	createdAt := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	server.store.newRows = []agent_commerce.NewProductExportRow{{
		ID:                        1,
		ProjectName:               "Project A",
		SKU:                       "NEW-1",
		Country:                   "US",
		CalculationType:           "profit_calc",
		PackageLengthCM:           10,
		PackageWidthCM:            8,
		PackageHeightCM:           4,
		WeightKG:                  0.5,
		FOBProductCostRMB:         20,
		FirstLegCostRMB:           4,
		DDPCostRMB:                24,
		DDPCostUSD:                3.4,
		SalePriceUSD:              20,
		ReferralFeeUSD:            3,
		AdvertisingFeeUSD:         1,
		AdvertisingRate:           0.05,
		ReturnLossUSD:             0.4,
		ReturnLossRate:            0.02,
		FBAFulfillmentFeeUSD:      4,
		InboundConfigFeeUSD:       1,
		StorageFeeUSD:             0.5,
		TotalFeeUSD:               9.9,
		PayoutUSD:                 15,
		ProfitUSD:                 5.1,
		ProfitRate:                0.255,
		VolumeCubicIn:             320,
		VolumeCubicFt:             0.18,
		SizeTierLabel:             "标准",
		PriceBandLabel:            "$15-$20",
		ChargeableWeightLB:        1.2,
		ProductWeightLB:           1.1,
		DimensionalWeightLB:       1.2,
		ChargeableWeightRule:      "max(product, dimensional)",
		FulfillmentFeeRuleLabel:   "standard",
		InboundConfigFeeRuleLabel: "single",
		StorageFeeRuleLabel:       "standard",
		USDToRMBRate:              7.1,
		CreatedAt:                 createdAt,
	}}
	server.store.shopData = agent_commerce.ShopExportData{
		Calculations: []agent_commerce.ShopExportRow{{
			ID:                        7,
			SKU:                       "SHOP-1",
			ASIN:                      stringPtr("B000000002"),
			Country:                   "US",
			Source:                    "agent_listing_pull",
			ObservedAt:                createdAt,
			Warnings:                  []string{},
			DDPCostRMB:                24,
			DDPCostUSD:                3.4,
			USDToRMBRate:              7.1,
			SalePriceUSD:              20,
			AdvertisingRate:           0.05,
			AdvertisingFeeUSD:         1,
			ReturnLossRate:            0.02,
			ReturnLossUSD:             0.4,
			ReferralFeeUSD:            3,
			FBAFulfillmentFeeUSD:      4,
			InboundConfigFeeUSD:       1,
			StorageMonths:             2,
			StorageFeeUSD:             0.5,
			TotalFeeUSD:               9.9,
			PayoutUSD:                 15,
			ProfitUSD:                 5.1,
			ProfitRate:                0.255,
			SizeTierLabel:             "标准",
			PriceBandLabel:            "$15-$20",
			FulfillmentFeeRuleLabel:   "standard",
			InboundConfigFeeRuleLabel: "single",
			StorageFeeRuleLabel:       "standard",
		}},
		Masters: []agent_commerce.ShopExportMaster{{
			SKU:             "SHOP-1",
			ASIN:            stringPtr("B000000002"),
			Country:         "US",
			FOBUnitCost:     20,
			PackageLengthCM: 10,
			PackageWidthCM:  8,
			PackageHeightCM: 4,
			WeightKG:        0.5,
			FirstLegCostRMB: 4,
			SortOrder:       1,
		}},
		Countries: []string{"US"},
		RowCount:  1,
	}
	server.store.templateData = &agent_commerce.ShipmentTemplateData{
		Detail: &agent_commerce.ShipmentDetail{
			ID:          50,
			ProjectID:   1,
			ProjectName: "Project A",
			Country:     "US",
			ShipmentNo:  "FBA-001",
			Items: []agent_commerce.ShipmentItemRow{{
				SKU:         "SHOP-1",
				Quantity:    20,
				CartonCount: intPtr(2),
			}},
		},
		Cartons: map[string]agent_commerce.CartonInfo{
			"SHOP-1": {
				UnitsPerCarton: 10,
				CartonLengthCM: 30,
				CartonWidthCM:  20,
				CartonHeightCM: 15,
				CartonWeightKG: 5,
			},
		},
	}
	server.store.boxData = agent_commerce.FBABoxData{
		Items: []agent_commerce.FBABoxItem{{
			ProjectID:                  1,
			ProjectName:                "Project A",
			Country:                    "US",
			ShipmentNo:                 "FBA-001",
			SKU:                        "SHOP-1",
			ProductName:                stringPtr("Sample"),
			ASIN:                       stringPtr("B000000002"),
			FNSKU:                      stringPtr("X000000001"),
			LengthCM:                   30,
			WidthCM:                    20,
			HeightCM:                   15,
			Quantity:                   20,
			UnitsPerCarton:             10,
			CartonCount:                2,
			TotalWeightKG:              10,
			TotalVolumeM3:              0.018,
			FBALabelPrefix:             "FBA-001",
			TrackingNo:                 stringPtr("1ZTEST"),
			ProductImageThumbnailR2Key: stringPtr("products/SHOP-1-thumb.png"),
		}},
	}
	var imageBuffer bytes.Buffer
	testImage := image.NewRGBA(image.Rect(0, 0, 10, 10))
	draw.Draw(testImage, testImage.Bounds(), image.NewUniform(color.RGBA{R: 255, A: 255}), image.Point{}, draw.Src)
	if err := png.Encode(
		&imageBuffer,
		testImage,
	); err != nil {
		t.Fatalf("encode test png: %v", err)
	}
	server.blobs.data = map[string][]byte{
		"products/SHOP-1-thumb.png": imageBuffer.Bytes(),
	}

	response := server.do(
		t,
		http.MethodGet,
		"/api/v1/agent/projects/1/new-product-calculations/export.xlsx?snapshot_ids=1",
		nil,
		"",
		nil,
	)
	body := readBody(t, response)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("new export status=%d body=%s", response.StatusCode, body)
	}
	if got := response.Header.Get("Content-Type"); !strings.Contains(got, "spreadsheetml.sheet") {
		t.Fatalf("new export content-type=%q", got)
	}
	assertXLSX(t, body)

	response = server.do(
		t,
		http.MethodGet,
		"/api/v1/agent/projects/1/shop-calculations/export.xlsx?mode=current&include_uncomputed=true",
		nil,
		"",
		nil,
	)
	body = readBody(t, response)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("shop export status=%d body=%s", response.StatusCode, body)
	}
	assertXLSX(t, body)

	response = server.do(
		t,
		http.MethodGet,
		"/api/v1/agent/projects/1/shipments/fba-box-details.xlsx?shipment_no=FBA-001",
		nil,
		"",
		nil,
	)
	body = readBody(t, response)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("box export status=%d body=%s", response.StatusCode, body)
	}
	assertXLSX(t, body)
	assertXLSXContains(
		t,
		body,
		"xl/media/image1.png",
		"xl/drawings/drawing1.xml",
		"xl/drawings/_rels/drawing1.xml.rels",
		"xl/worksheets/_rels/sheet1.xml.rels",
	)

	response = server.do(
		t,
		http.MethodGet,
		"/api/v1/agent/projects/1/shipments/FBA-001/fba-delivery-template",
		nil,
		"",
		nil,
	)
	body = readBody(t, response)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("delivery export status=%d body=%s", response.StatusCode, body)
	}
	assertXLSX(t, body)
	if len(server.store.audits) != 2 {
		t.Fatalf("export audit entries=%d, want 2", len(server.store.audits))
	}

	missing := newContractServer(t, "shipments", "*")
	missing.store.templateData = nil
	response = missing.do(t, http.MethodGet, "/api/v1/agent/projects/1/shipments/MISSING/fba-delivery-template", nil, "", nil)
	body = readBody(t, response)
	if response.StatusCode != http.StatusNotFound || errorCode(t, body) != "RESOURCE_NOT_FOUND" {
		t.Fatalf("missing shipment status=%d body=%s", response.StatusCode, body)
	}
}

func TestStage9CExportValidation(t *testing.T) {
	server := newContractServer(t, "new_product_calculations,shop_calculations,shipments", "*")
	response := server.do(
		t,
		http.MethodGet,
		"/api/v1/agent/projects/1/new-product-calculations/export.xlsx",
		nil,
		"",
		nil,
	)
	body := readBody(t, response)
	if response.StatusCode != http.StatusBadRequest || errorCode(t, body) != "VALIDATION_FAILED" {
		t.Fatalf("missing snapshot_ids status=%d body=%s", response.StatusCode, body)
	}

	response = server.do(
		t,
		http.MethodGet,
		"/api/v1/agent/projects/1/shop-calculations/export.xlsx?mode=invalid",
		nil,
		"",
		nil,
	)
	body = readBody(t, response)
	if response.StatusCode != http.StatusBadRequest || errorCode(t, body) != "VALIDATION_FAILED" {
		t.Fatalf("invalid mode status=%d body=%s", response.StatusCode, body)
	}

	values := url.Values{}
	response = server.do(
		t,
		http.MethodGet,
		"/api/v1/agent/projects/1/shipments/fba-box-details.xlsx?"+values.Encode(),
		nil,
		"",
		nil,
	)
	body = readBody(t, response)
	if response.StatusCode != http.StatusBadRequest || errorCode(t, body) != "VALIDATION_FAILED" {
		t.Fatalf("missing shipment_no status=%d body=%s", response.StatusCode, body)
	}
}

func TestStage9CErrorMapping(t *testing.T) {
	server := newContractServer(t, "sku_info", "*")
	server.store.skuErr = errors.New("database unavailable")
	response := server.do(t, http.MethodGet, "/api/v1/agent/projects/1/sku-info/11", nil, "", nil)
	body := readBody(t, response)
	if response.StatusCode != http.StatusServiceUnavailable || errorCode(t, body) != "SERVICE_UNAVAILABLE" {
		t.Fatalf("generic store error status=%d body=%s", response.StatusCode, body)
	}
}

func stringPtr(value string) *string {
	return &value
}

func intPtr(value int) *int {
	return &value
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
