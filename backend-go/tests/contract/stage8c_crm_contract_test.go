package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/crm"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

const stage8CAPIKey = "stage8c-key"

type stage8CStore struct {
	crm.Store
	customer         *crm.Customer
	lead             *crm.Lead
	contact          *crm.Contact
	task             *crm.Task
	category         *crm.Category
	rule             *crm.Rule
	savedView        *crm.SavedView
	proposal         *crm.ProposalDetail
	versionRecord    *crm.ProposalVersionRecord
	errorOn          string
	convertResponse  crm.ConvertLeadResponse
	completeConflict bool
	proposalUpload   crm.ProposalUploadResponse
}

func (store *stage8CStore) ListCustomers(context.Context, crm.CustomerListFilter, string, bool) (crm.Paginated[crm.Customer], error) {
	if store.errorOn == "list_customers" {
		return crm.Paginated[crm.Customer]{}, crm.NewAPIError(http.StatusBadRequest, "filters 非法 JSON")
	}
	return crm.Paginated[crm.Customer]{Items: []crm.Customer{}, Total: 0, Page: 1, PageSize: 20}, nil
}
func (store *stage8CStore) CreateCustomer(context.Context, crm.CustomerCreateInput, string) (*crm.Customer, error) {
	return stage8CCustomer(), nil
}
func (store *stage8CStore) ImportCustomersToSea(context.Context, []crm.CustomerSeaImportRow, string) (crm.CustomerSeaImportResult, error) {
	return crm.CustomerSeaImportResult{Created: 1, Failed: []crm.CustomerSeaImportFail{}}, nil
}
func (store *stage8CStore) GetCustomer(context.Context, int64) (*crm.Customer, error) {
	return store.customer, nil
}
func (store *stage8CStore) UpdateCustomer(context.Context, int64, crm.CustomerUpdateInput, string) (*crm.Customer, error) {
	return stage8CCustomer(), nil
}
func (store *stage8CStore) UpdateCustomerValueScores(context.Context, int64, crm.ValueScoresUpdateInput, string) (*crm.Customer, error) {
	return stage8CCustomer(), nil
}
func (store *stage8CStore) DeleteCustomer(context.Context, int64, string) error { return nil }
func (store *stage8CStore) BatchTransferCustomers(context.Context, []int64, string, string) error {
	return nil
}
func (store *stage8CStore) BatchMoveCustomersToSea(context.Context, []int64, string, bool, string) error {
	return nil
}
func (store *stage8CStore) ClaimCustomer(context.Context, int64, string) (*crm.Customer, error) {
	return stage8CCustomer(), nil
}
func (store *stage8CStore) ListContacts(context.Context, int64) ([]crm.Contact, error) {
	return []crm.Contact{*stage8CContact()}, nil
}
func (store *stage8CStore) CreateContact(context.Context, int64, crm.ContactCreateInput, string) (*crm.Contact, error) {
	return stage8CContact(), nil
}
func (store *stage8CStore) UpdateContact(context.Context, int64, crm.ContactUpdateInput, string) (*crm.Contact, error) {
	return stage8CContact(), nil
}
func (store *stage8CStore) DeleteContact(context.Context, int64, string) error { return nil }
func (store *stage8CStore) ListCRMUsers(context.Context) ([]crm.CRMUser, error) {
	return []crm.CRMUser{{ID: "user-1", Name: "运营", Email: "ops@example.com", IsActive: true}}, nil
}
func (store *stage8CStore) GetCRMUser(context.Context, string) (*crm.CRMUser, error) {
	return &crm.CRMUser{ID: "user-1", Name: "运营", Email: "ops@example.com", IsActive: true}, nil
}
func (store *stage8CStore) ListLeads(context.Context, crm.LeadListFilter, string) (crm.Paginated[crm.Lead], error) {
	return crm.Paginated[crm.Lead]{Items: []crm.Lead{}, Total: 0, Page: 1, PageSize: 20}, nil
}
func (store *stage8CStore) CreateLead(context.Context, crm.LeadCreateInput, string) (*crm.Lead, error) {
	return stage8CLead(), nil
}
func (store *stage8CStore) GetLead(context.Context, int64) (*crm.Lead, error) { return store.lead, nil }
func (store *stage8CStore) UpdateLead(context.Context, int64, crm.LeadUpdateInput, string) (*crm.Lead, error) {
	return stage8CLead(), nil
}
func (store *stage8CStore) BatchTransferLeads(context.Context, []int64, string, string) error {
	return nil
}
func (store *stage8CStore) BatchMoveLeadsToPool(context.Context, []int64, string, bool, string) error {
	return nil
}
func (store *stage8CStore) ClaimLead(context.Context, int64, string) (*crm.Lead, error) {
	return stage8CLead(), nil
}
func (store *stage8CStore) ConvertLead(context.Context, int64, *crm.ConvertLeadInput, string) (*crm.ConvertLeadResponse, error) {
	response := store.convertResponse
	if response.Lead.ID == 0 {
		response = crm.ConvertLeadResponse{Lead: *stage8CLead(), Customer: *stage8CCustomer()}
	}
	return &response, nil
}
func (store *stage8CStore) ListFollows(context.Context, string, int64) ([]crm.Follow, error) {
	return []crm.Follow{}, nil
}
func (store *stage8CStore) CreateFollow(context.Context, crm.FollowCreateInput, string) (*crm.Follow, error) {
	return &crm.Follow{ID: 1, EntityType: "customer", EntityID: 1, Type: "note", Content: "跟进", CreatedAt: "2026-11-08T00:00:00Z"}, nil
}
func (store *stage8CStore) ListFollowUps(context.Context, string, string, bool) (crm.FollowUpGroups, error) {
	return crm.FollowUpGroups{}, nil
}
func (store *stage8CStore) ListAuditLogs(context.Context, crm.AuditLogFilter) (crm.Paginated[crm.AuditLog], error) {
	return crm.Paginated[crm.AuditLog]{Items: []crm.AuditLog{}, Page: 1, PageSize: 20}, nil
}
func (store *stage8CStore) GetDashboardStats(context.Context) (crm.DashboardStats, error) {
	return crm.DashboardStats{LeadFunnel: map[string]int{}, PerOwner: []crm.OwnerPerformance{}}, nil
}
func (store *stage8CStore) GetFunnelMetrics(context.Context, string, *time.Time, *time.Time, *string, *string) (crm.FunnelMetrics, error) {
	return crm.FunnelMetrics{Dimension: "owner", Total: map[string]int{}, Items: []crm.FunnelDimensionItem{}}, nil
}
func (store *stage8CStore) GetStageDetail(context.Context, string, string, int, *time.Time, *time.Time, *string, *string, int, int) (crm.StageDetail, error) {
	return crm.StageDetail{Stage: "new", Leads: []crm.StageLeadItem{}, Page: 1, PageSize: 50}, nil
}
func (store *stage8CStore) GetPerformanceBoard(context.Context, string, string, *string, string) (crm.PerformanceBoard, error) {
	return crm.PerformanceBoard{Scope: "mine", Month: "2026-11", Ranking: []crm.PerformanceRankItem{}}, nil
}
func (store *stage8CStore) GetLifecycleBoard(context.Context) (crm.LifecycleBoard, error) {
	return crm.LifecycleBoard{}, nil
}
func (store *stage8CStore) ListTasks(context.Context, crm.TaskListFilter, string, bool) (crm.Paginated[crm.Task], error) {
	return crm.Paginated[crm.Task]{Items: []crm.Task{}, Total: 0, Page: 1, PageSize: 20}, nil
}
func (store *stage8CStore) CreateTask(context.Context, crm.TaskCreateInput, string, bool) (*crm.Task, error) {
	return stage8CTask(), nil
}
func (store *stage8CStore) GetTask(context.Context, int64) (*crm.Task, error) {
	task := stage8CTask()
	if store.task != nil {
		return store.task, nil
	}
	return task, nil
}
func (store *stage8CStore) UpdateTask(context.Context, int64, crm.TaskUpdateInput, string, bool) (*crm.Task, error) {
	return stage8CTask(), nil
}
func (store *stage8CStore) SetTaskStatus(context.Context, int64, string, string) (*crm.Task, error) {
	return stage8CTask(), nil
}
func (store *stage8CStore) CompleteTask(context.Context, int64, *crm.TaskCompleteInput, string) (*crm.Task, error) {
	if store.completeConflict {
		return nil, crm.NewAPIError(http.StatusConflict, "任务已完成，不可重复完成")
	}
	return stage8CTask(), nil
}
func (store *stage8CStore) CancelTask(context.Context, int64, string) (*crm.Task, error) {
	return stage8CTask(), nil
}
func (store *stage8CStore) ListTaskReminders(context.Context, *string) ([]crm.TaskReminder, error) {
	return []crm.TaskReminder{}, nil
}
func (store *stage8CStore) ListFollowUpReminders(context.Context, string, int) ([]crm.FollowUpReminder, error) {
	return []crm.FollowUpReminder{}, nil
}
func (store *stage8CStore) ListRules(context.Context) ([]crm.Rule, error) {
	return []crm.Rule{*stage8CRule()}, nil
}
func (store *stage8CStore) CreateRule(context.Context, crm.RuleCreateInput, string) (*crm.Rule, error) {
	return stage8CRule(), nil
}
func (store *stage8CStore) UpdateRule(context.Context, int64, crm.RuleUpdateInput, string) (*crm.Rule, error) {
	return stage8CRule(), nil
}
func (store *stage8CStore) DeleteRule(context.Context, int64, string) error { return nil }
func (store *stage8CStore) GetWorkflowSettings(context.Context) (crm.WorkflowSettings, error) {
	return crm.WorkflowSettings{StaleDays: 7, StaleEmailEnabled: true}, nil
}
func (store *stage8CStore) UpdateWorkflowSettings(context.Context, crm.WorkflowSettingsUpdate, string) (crm.WorkflowSettings, error) {
	return crm.WorkflowSettings{StaleDays: 14, StaleEmailEnabled: true}, nil
}
func (store *stage8CStore) ListCategories(context.Context) ([]crm.Category, error) {
	return []crm.Category{*stage8CCategory()}, nil
}
func (store *stage8CStore) CreateCategory(context.Context, crm.CategoryCreateInput, string) (*crm.Category, error) {
	return stage8CCategory(), nil
}
func (store *stage8CStore) UpdateCategory(context.Context, int64, crm.CategoryUpdateInput, string) (*crm.Category, error) {
	return stage8CCategory(), nil
}
func (store *stage8CStore) DeleteCategory(context.Context, int64, string) error { return nil }
func (store *stage8CStore) SetCustomerCategories(context.Context, int64, []int64, string) (*crm.Customer, error) {
	return stage8CCustomer(), nil
}
func (store *stage8CStore) ListSavedViews(context.Context, *string, string, bool) ([]crm.SavedView, error) {
	return []crm.SavedView{*stage8CSavedView()}, nil
}
func (store *stage8CStore) CreateSavedView(context.Context, crm.SavedViewCreateInput, string, bool) (*crm.SavedView, error) {
	return stage8CSavedView(), nil
}
func (store *stage8CStore) UpdateSavedView(context.Context, int64, crm.SavedViewUpdateInput, string, bool) (*crm.SavedView, error) {
	return stage8CSavedView(), nil
}
func (store *stage8CStore) DeleteSavedView(context.Context, int64, string, bool) error {
	return nil
}
func (store *stage8CStore) ListProposals(context.Context, crm.ProposalListFilter, *string, bool) (crm.Paginated[crm.Proposal], error) {
	return crm.Paginated[crm.Proposal]{Items: []crm.Proposal{}, Page: 1, PageSize: 20}, nil
}
func (store *stage8CStore) GetProposal(context.Context, int64) (*crm.ProposalDetail, error) {
	if store.proposal == nil {
		return &crm.ProposalDetail{
			Proposal: crm.Proposal{ID: 1, Title: "方案 A", OwnerID: stage8CString("user-1"), CurrentVersionNo: 1},
			Versions: []crm.ProposalVersion{{ID: 1, VersionNo: 1, OriginalFilename: "proposal.html", ContentType: "text/html"}},
		}, nil
	}
	return store.proposal, nil
}
func (store *stage8CStore) CreateProposal(context.Context, crm.ProposalCreateInput, string, bool, crm.ProposalStorage) (crm.ProposalUploadResponse, error) {
	if store.proposalUpload.Proposal.ID != 0 {
		return store.proposalUpload, nil
	}
	return stage8CProposalUpload(), nil
}
func (store *stage8CStore) AddProposalVersion(context.Context, int64, crm.ProposalAddVersionInput, string, crm.ProposalStorage) (crm.ProposalUploadResponse, error) {
	return stage8CProposalUpload(), nil
}
func (store *stage8CStore) UpdateProposal(context.Context, int64, crm.ProposalUpdateInput, string, bool) (*crm.Proposal, error) {
	proposal := stage8CProposalUpload().Proposal
	return &proposal, nil
}
func (store *stage8CStore) DeleteProposal(context.Context, int64, string, crm.ProposalStorage) error {
	return nil
}
func (store *stage8CStore) GetProposalVersionRecord(context.Context, int64, int) (*crm.ProposalVersionRecord, error) {
	if store.versionRecord != nil {
		return store.versionRecord, nil
	}
	return &crm.ProposalVersionRecord{
		ProposalID: 1, VersionNo: 1, RawKey: "crm-proposals/1/v1/raw.html",
		AdaptedKey:       "crm-proposals/1/v1/adapted.html",
		OriginalFilename: "proposal.html", ContentType: "text/html",
	}, nil
}

type stage8CStorage struct {
	objects map[string][]byte
	meta    crm.ChunkUploadMeta
}

func (storage *stage8CStorage) PutObject(_ context.Context, key string, data []byte, _ string) error {
	if storage.objects == nil {
		storage.objects = map[string][]byte{}
	}
	storage.objects[key] = append([]byte(nil), data...)
	return nil
}
func (storage *stage8CStorage) GetObject(_ context.Context, key string) ([]byte, error) {
	if data, ok := storage.objects[key]; ok {
		return append([]byte(nil), data...), nil
	}
	return []byte("<html><body>adapted</body></html>"), nil
}
func (storage *stage8CStorage) DeleteObject(_ context.Context, key string) error {
	delete(storage.objects, key)
	return nil
}
func (storage *stage8CStorage) InitChunkUpload(_ context.Context, input crm.ChunkUploadInitInput) (crm.ChunkUploadMeta, error) {
	if !strings.HasSuffix(strings.ToLower(input.Filename), ".html") &&
		!strings.HasSuffix(strings.ToLower(input.Filename), ".htm") &&
		!strings.HasSuffix(strings.ToLower(input.Filename), ".pdf") {
		return crm.ChunkUploadMeta{}, crm.NewAPIError(http.StatusBadRequest, "unsupported")
	}
	storage.meta = crm.ChunkUploadMeta{
		UploadID: "0123456789abcdef0123456789abcdef", OwnerID: input.OwnerID,
		Filename: input.Filename, Size: input.Size, ContentType: input.ContentType,
		Title: input.Title, ProposalType: input.ProposalType, CustomerID: input.CustomerID,
		ProposalID: input.ProposalID, ChangeNote: input.ChangeNote, Status: "pending",
		ChunkSize: 3 << 20, TotalChunks: 1, ExpiresAt: "2026-11-08T02:00:00Z",
	}
	return storage.meta, nil
}
func (storage *stage8CStorage) WriteChunk(_ context.Context, _ string, _ int, data []byte, _ *string, _ bool) (int64, error) {
	return int64(len(data)), nil
}
func (storage *stage8CStorage) ReadChunkUpload(context.Context, string, *string, bool) (crm.ChunkUploadMeta, error) {
	return storage.meta, nil
}
func (storage *stage8CStorage) AssembleChunkUpload(context.Context, string, *string, bool) ([]byte, crm.ChunkUploadMeta, error) {
	return []byte("<html><body>chunked</body></html>"), storage.meta, nil
}
func (storage *stage8CStorage) MarkChunkUploadFinalized(_ context.Context, _ string, proposalID int64, versionNo int) error {
	storage.meta.Status = "finalized"
	storage.meta.FinalProposalID = &proposalID
	storage.meta.FinalVersionNo = &versionNo
	return nil
}

func stage8CString(value string) *string { return &value }

func stage8CCustomer() *crm.Customer {
	return &crm.Customer{
		ID: 1, Name: "客户 A", Rating: "C", Status: "active",
		OwnerID: stage8CString("user-1"), Categories: []crm.CategoryBrief{},
		CreatedAt: "2026-11-08T00:00:00Z", UpdatedAt: "2026-11-08T00:00:00Z",
	}
}

func stage8CLead() *crm.Lead {
	return &crm.Lead{
		ID: 1, Name: "联系人 A", Status: "new", Intent: "medium",
		OwnerID: stage8CString("user-1"), CreatedAt: "2026-11-08T00:00:00Z",
		UpdatedAt: "2026-11-08T00:00:00Z",
	}
}

func stage8CContact() *crm.Contact {
	return &crm.Contact{
		ID: 1, CustomerID: 1, Name: "联系人 A", IsPrimary: true,
		CreatedAt: "2026-11-08T00:00:00Z", UpdatedAt: "2026-11-08T00:00:00Z",
	}
}

func stage8CTask() *crm.Task {
	return &crm.Task{
		ID: 1, Title: "跟进客户", Priority: "medium", Status: "pending", Type: "follow_up",
		OwnerID: stage8CString("user-1"), CreatedBy: stage8CString("user-1"),
		CreatedAt: "2026-11-08T00:00:00Z", UpdatedAt: "2026-11-08T00:00:00Z",
	}
}

func stage8CCategory() *crm.Category {
	return &crm.Category{ID: 1, Name: "家居", SortOrder: 1, CreatedAt: "2026-11-08T00:00:00Z"}
}

func stage8CRule() *crm.Rule {
	return &crm.Rule{
		ID: 1, Name: "客户 7 天无跟进", EntityType: "customer", EventType: "stale_follow_up",
		Enabled: true, Conditions: []crm.RuleCondition{}, Actions: []crm.RuleAction{},
		CreatedAt: "2026-11-08T00:00:00Z", UpdatedAt: "2026-11-08T00:00:00Z",
	}
}

func stage8CSavedView() *crm.SavedView {
	return &crm.SavedView{
		ID: 1, Name: "我的客户", EntityType: "customer", Scope: "mine",
		Filters: []crm.FilterCondition{}, SortBy: "updated_at", SortOrder: "desc",
		OwnerID: stage8CString("user-1"), CreatedAt: "2026-11-08T00:00:00Z",
		UpdatedAt: "2026-11-08T00:00:00Z",
	}
}

func stage8CProposalUpload() crm.ProposalUploadResponse {
	return crm.ProposalUploadResponse{
		Proposal: crm.Proposal{
			ID: 1, Title: "方案 A", ProposalType: "other", Status: "draft",
			OwnerID: stage8CString("user-1"), CurrentVersionNo: 1, VersionCount: 1,
			CreatedAt: "2026-11-08T00:00:00Z", UpdatedAt: "2026-11-08T00:00:00Z",
		},
		Version: crm.ProposalVersion{
			ID: 1, VersionNo: 1, OriginalFilename: "proposal.html",
			ContentType: "text/html", CreatedAt: "2026-11-08T00:00:00Z",
		},
		Warnings: []string{},
	}
}

func stage8CRouter(store crm.Store, storage crm.ProposalStorage) http.Handler {
	router := chi.NewRouter()
	requireAPIKey := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("X-API-Key") != stage8CAPIKey {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = io.WriteString(w, `{"detail":"Not authenticated"}`)
				return
			}
			userID := r.Header.Get("X-User-Id")
			if userID == "" {
				userID = "user-1"
			}
			ctx := auth.WithUserContext(r.Context(), auth.UserContext{
				UserID: userID, Operator: r.Header.Get("X-Operator"), IsAdmin: r.Header.Get("X-Is-Admin") == "true",
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
	crm.NewRegistrar(store, storage, nil).RegisterRoutes(router, requireAPIKey)
	return router
}

func stage8CRequest(
	method, target, body, userID string,
	isAdmin bool,
) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("X-API-Key", stage8CAPIKey)
	request.Header.Set("X-User-Id", userID)
	request.Header.Set("X-Operator", userID)
	if isAdmin {
		request.Header.Set("X-Is-Admin", "true")
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	return request
}

func TestStage8CCRMCRUDRouteStatuses(t *testing.T) {
	store := &stage8CStore{customer: stage8CCustomer(), lead: stage8CLead()}
	router := stage8CRouter(store, &stage8CStorage{})
	admin := true

	tests := []struct {
		name   string
		method string
		target string
		body   string
		status int
	}{
		{"customers list", http.MethodGet, "/api/v1/crm/customers", "", http.StatusOK},
		{"customers export", http.MethodGet, "/api/v1/crm/customers/export", "", http.StatusOK},
		{"customers create", http.MethodPost, "/api/v1/crm/customers", `{"name":"客户 A"}`, http.StatusCreated},
		{"customers import sea", http.MethodPost, "/api/v1/crm/customers/import-sea", `{"rows":[{"name":"客户 A"}]}`, http.StatusOK},
		{"customer detail", http.MethodGet, "/api/v1/crm/customers/1", "", http.StatusOK},
		{"customer patch", http.MethodPatch, "/api/v1/crm/customers/1", `{"remark":"重点"}`, http.StatusOK},
		{"customer values", http.MethodPatch, "/api/v1/crm/customers/1/value-scores", `{"score_scale":"A"}`, http.StatusOK},
		{"customer delete", http.MethodDelete, "/api/v1/crm/customers/1", "", http.StatusNoContent},
		{"customer batch transfer", http.MethodPost, "/api/v1/crm/customers/batch-transfer", `{"ids":[1],"to_owner_id":"user-2"}`, http.StatusNoContent},
		{"customer batch sea", http.MethodPost, "/api/v1/crm/customers/batch-move-sea", `{"ids":[1]}`, http.StatusNoContent},
		{"customer claim", http.MethodPost, "/api/v1/crm/customers/1/claim", "", http.StatusOK},
		{"contacts list", http.MethodGet, "/api/v1/crm/customers/1/contacts", "", http.StatusOK},
		{"contacts create", http.MethodPost, "/api/v1/crm/customers/1/contacts", `{"name":"张总"}`, http.StatusCreated},
		{"contacts patch", http.MethodPatch, "/api/v1/crm/contacts/1", `{"title":"采购"}`, http.StatusOK},
		{"contacts delete", http.MethodDelete, "/api/v1/crm/contacts/1", "", http.StatusNoContent},
		{"users list", http.MethodGet, "/api/v1/crm/users", "", http.StatusOK},
		{"user detail", http.MethodGet, "/api/v1/crm/users/user-1", "", http.StatusOK},
		{"leads list", http.MethodGet, "/api/v1/crm/leads", "", http.StatusOK},
		{"leads export", http.MethodGet, "/api/v1/crm/leads/export", "", http.StatusOK},
		{"leads create", http.MethodPost, "/api/v1/crm/leads", `{"name":"联系人 A"}`, http.StatusCreated},
		{"lead detail", http.MethodGet, "/api/v1/crm/leads/1", "", http.StatusOK},
		{"lead patch", http.MethodPatch, "/api/v1/crm/leads/1", `{"intent":"high"}`, http.StatusOK},
		{"leads batch transfer", http.MethodPost, "/api/v1/crm/leads/batch-transfer", `{"ids":[1],"to_owner_id":"user-2"}`, http.StatusNoContent},
		{"leads batch pool", http.MethodPost, "/api/v1/crm/leads/batch-move-pool", `{"ids":[1]}`, http.StatusNoContent},
		{"lead claim", http.MethodPost, "/api/v1/crm/leads/1/claim", "", http.StatusOK},
		{"lead convert", http.MethodPost, "/api/v1/crm/leads/1/convert", `{}`, http.StatusOK},
		{"follows list", http.MethodGet, "/api/v1/crm/follows?entity_type=customer&entity_id=1", "", http.StatusOK},
		{"follows create", http.MethodPost, "/api/v1/crm/follows", `{"entity_type":"customer","entity_id":1,"content":"电话沟通"}`, http.StatusCreated},
		{"follow ups", http.MethodGet, "/api/v1/crm/follow-ups", "", http.StatusOK},
		{"audit logs", http.MethodGet, "/api/v1/crm/audit-logs", "", http.StatusOK},
		{"dashboard stats", http.MethodGet, "/api/v1/crm/dashboard/stats", "", http.StatusOK},
		{"dashboard funnel", http.MethodGet, "/api/v1/crm/dashboard/funnel?dimension=owner", "", http.StatusOK},
		{"dashboard stage", http.MethodGet, "/api/v1/crm/dashboard/funnel/stage/new", "", http.StatusOK},
		{"dashboard performance", http.MethodGet, "/api/v1/crm/dashboard/performance", "", http.StatusOK},
		{"dashboard lifecycle", http.MethodGet, "/api/v1/crm/dashboard/lifecycle", "", http.StatusOK},
		{"tasks list", http.MethodGet, "/api/v1/crm/tasks", "", http.StatusOK},
		{"tasks create", http.MethodPost, "/api/v1/crm/tasks", `{"title":"跟进客户"}`, http.StatusCreated},
		{"task detail", http.MethodGet, "/api/v1/crm/tasks/1", "", http.StatusOK},
		{"task patch", http.MethodPatch, "/api/v1/crm/tasks/1", `{"priority":"high"}`, http.StatusOK},
		{"task status", http.MethodPost, "/api/v1/crm/tasks/1/status", `{"status":"in_progress"}`, http.StatusOK},
		{"task complete", http.MethodPost, "/api/v1/crm/tasks/1/complete", `{"note":"已沟通"}`, http.StatusOK},
		{"task cancel", http.MethodPost, "/api/v1/crm/tasks/1/cancel", "", http.StatusOK},
		{"rules list", http.MethodGet, "/api/v1/crm/rules", "", http.StatusOK},
		{"rules create", http.MethodPost, "/api/v1/crm/rules", `{"name":"规则","conditions":[{"field":"days_since_created","operator":"gte","value":"7"}],"actions":[{"action_type":"notify_owner"}]}`, http.StatusCreated},
		{"rules patch", http.MethodPatch, "/api/v1/crm/rules/1", `{"enabled":false}`, http.StatusOK},
		{"rules delete", http.MethodDelete, "/api/v1/crm/rules/1", "", http.StatusNoContent},
		{"workflow get", http.MethodGet, "/api/v1/crm/settings/workflow", "", http.StatusOK},
		{"workflow put", http.MethodPut, "/api/v1/crm/settings/workflow", `{"stale_days":14}`, http.StatusOK},
		{"categories list", http.MethodGet, "/api/v1/crm/categories", "", http.StatusOK},
		{"categories create", http.MethodPost, "/api/v1/crm/categories", `{"name":"家居"}`, http.StatusCreated},
		{"categories patch", http.MethodPatch, "/api/v1/crm/categories/1", `{"sort_order":2}`, http.StatusOK},
		{"categories delete", http.MethodDelete, "/api/v1/crm/categories/1", "", http.StatusNoContent},
		{"customer categories", http.MethodPut, "/api/v1/crm/customers/1/categories", `{"category_ids":[1]}`, http.StatusOK},
		{"saved views list", http.MethodGet, "/api/v1/crm/saved-views", "", http.StatusOK},
		{"saved views create", http.MethodPost, "/api/v1/crm/saved-views", `{"name":"我的","entity_type":"customer","scope":"mine"}`, http.StatusCreated},
		{"saved views patch", http.MethodPatch, "/api/v1/crm/saved-views/1", `{"name":"改名"}`, http.StatusOK},
		{"saved views delete", http.MethodDelete, "/api/v1/crm/saved-views/1", "", http.StatusNoContent},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := stage8CRequest(test.method, test.target, test.body, "user-1", admin)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if recorder.Code != test.status {
				t.Fatalf("%s %s => %d, want %d: %s", test.method, test.target, recorder.Code, test.status, recorder.Body.String())
			}
		})
	}
}

func TestStage8CProposalRoutesAndStatusCodes(t *testing.T) {
	store := &stage8CStore{}
	storage := &stage8CStorage{objects: map[string][]byte{}}
	router := stage8CRouter(store, storage)

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, stage8CRequest(http.MethodGet, "/api/v1/crm/proposals", "", "user-1", false))
	if recorder.Code != http.StatusOK {
		t.Fatalf("list proposals = %d: %s", recorder.Code, recorder.Body.String())
	}

	detailRecorder := httptest.NewRecorder()
	router.ServeHTTP(detailRecorder, stage8CRequest(http.MethodGet, "/api/v1/crm/proposals/1", "", "user-1", false))
	var detail map[string]any
	if err := json.Unmarshal(detailRecorder.Body.Bytes(), &detail); err != nil {
		t.Fatalf("decode proposal detail: %v", err)
	}
	if _, ok := detail["title"]; !ok {
		t.Fatalf("proposal detail did not flatten proposal fields: %s", detailRecorder.Body.String())
	}
	if _, ok := detail["versions"].([]any); !ok {
		t.Fatalf("proposal detail missing versions array: %s", detailRecorder.Body.String())
	}

	var uploadBody bytes.Buffer
	writer := multipart.NewWriter(&uploadBody)
	part, _ := writer.CreateFormFile("file", "proposal.html")
	_, _ = part.Write([]byte("<html><head></head><body>方案</body></html>"))
	_ = writer.WriteField("title", "方案 A")
	_ = writer.WriteField("proposal_type", "other")
	_ = writer.Close()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/crm/proposals", &uploadBody)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("X-API-Key", stage8CAPIKey)
	request.Header.Set("X-User-Id", "user-1")
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create proposal = %d: %s", recorder.Code, recorder.Body.String())
	}

	requests := []struct {
		method string
		target string
		body   string
		status int
	}{
		{http.MethodGet, "/api/v1/crm/proposals/1", "", http.StatusOK},
		{http.MethodPost, "/api/v1/crm/proposals/uploads/init", `{"filename":"a.html","size":10}`, http.StatusOK},
		{http.MethodPost, "/api/v1/crm/proposals/1/versions/uploads/init", `{"filename":"a.html","size":10}`, http.StatusOK},
		{http.MethodPost, "/api/v1/crm/proposals/uploads/0123456789abcdef0123456789abcdef/chunks/0", "abc", http.StatusOK},
		{http.MethodPost, "/api/v1/crm/proposals/uploads/0123456789abcdef0123456789abcdef/finalize", "", http.StatusCreated},
		{http.MethodPatch, "/api/v1/crm/proposals/1", `{"status":"published"}`, http.StatusOK},
		{http.MethodDelete, "/api/v1/crm/proposals/1", "", http.StatusNoContent},
		{http.MethodGet, "/api/v1/crm/proposals/1/versions/1/content", "", http.StatusOK},
		{http.MethodGet, "/api/v1/crm/proposals/1/versions/1/download", "", http.StatusOK},
	}
	for _, item := range requests {
		request := stage8CRequest(item.method, item.target, item.body, "user-1", false)
		if strings.HasSuffix(item.target, "/chunks/0") {
			request.Header.Set("Content-Type", "application/octet-stream")
		}
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != item.status {
			t.Fatalf("%s %s => %d, want %d: %s", item.method, item.target, recorder.Code, item.status, recorder.Body.String())
		}
	}

	var addVersion bytes.Buffer
	versionWriter := multipart.NewWriter(&addVersion)
	versionPart, _ := versionWriter.CreateFormFile("file", "proposal-v2.html")
	_, _ = versionPart.Write([]byte("<html><body>v2</body></html>"))
	_ = versionWriter.Close()
	addRequest := httptest.NewRequest(http.MethodPost, "/api/v1/crm/proposals/1/versions", &addVersion)
	addRequest.Header.Set("Content-Type", versionWriter.FormDataContentType())
	addRequest.Header.Set("X-API-Key", stage8CAPIKey)
	addRequest.Header.Set("X-User-Id", "user-1")
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, addRequest)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("add version = %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestStage8CTabularImportExport(t *testing.T) {
	store := &stage8CStore{}
	router := stage8CRouter(store, &stage8CStorage{})

	for _, target := range []string{
		"/api/v1/crm/customers/export?format=xlsx",
		"/api/v1/crm/leads/export?format=xlsx",
	} {
		request := stage8CRequest(http.MethodGet, target, "", "user-1", false)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s => %d: %s", target, recorder.Code, recorder.Body.String())
		}
		if got := recorder.Header().Get("Content-Type"); got !=
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" {
			t.Fatalf("%s Content-Type = %q", target, got)
		}
		if !bytes.HasPrefix(recorder.Body.Bytes(), []byte("PK")) {
			t.Fatalf("%s did not return an XLSX zip payload", target)
		}
	}

	var csvBody bytes.Buffer
	writer := multipart.NewWriter(&csvBody)
	part, _ := writer.CreateFormFile("file", "customers.csv")
	_, _ = part.Write([]byte("\ufeffname,short_name\n客户 A,简称\n"))
	_ = writer.Close()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/crm/customers/import-sea", &csvBody)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("X-API-Key", stage8CAPIKey)
	request.Header.Set("X-User-Id", "user-1")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("CSV import => %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestStage8CStatusMatrix(t *testing.T) {
	store := &stage8CStore{customer: stage8CCustomer(), lead: stage8CLead()}
	router := stage8CRouter(store, &stage8CStorage{})

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
		{"401", http.MethodGet, "/api/v1/crm/customers", "", "user-1", false, "", http.StatusUnauthorized},
		{"400 invalid filters", http.MethodGet, "/api/v1/crm/customers?filters=not-json", "", "user-1", false, stage8CAPIKey, http.StatusBadRequest},
		{"403 write other customer", http.MethodPatch, "/api/v1/crm/customers/1", `{"remark":"x"}`, "user-2", false, stage8CAPIKey, http.StatusForbidden},
		{"403 non-admin audit", http.MethodGet, "/api/v1/crm/audit-logs", "", "user-1", false, stage8CAPIKey, http.StatusForbidden},
		{"403 non-admin transfer", http.MethodPost, "/api/v1/crm/customers/batch-transfer", `{"ids":[1],"to_owner_id":"x"}`, "user-1", false, stage8CAPIKey, http.StatusForbidden},
		{"404 customer", http.MethodGet, "/api/v1/crm/customers/99", "", "user-1", false, stage8CAPIKey, http.StatusNotFound},
		{"409 task complete", http.MethodPost, "/api/v1/crm/tasks/1/complete", `{"note":"x"}`, "user-1", false, stage8CAPIKey, http.StatusConflict},
		{"422 page", http.MethodGet, "/api/v1/crm/customers?page=0", "", "user-1", false, stage8CAPIKey, http.StatusUnprocessableEntity},
		{"422 path id", http.MethodGet, "/api/v1/crm/customers/not-a-number", "", "user-1", false, stage8CAPIKey, http.StatusUnprocessableEntity},
		{"400 task both links", http.MethodPost, "/api/v1/crm/tasks", `{"title":"x","customer_id":1,"lead_id":1}`, "user-1", false, stage8CAPIKey, http.StatusBadRequest},
	}
	originalCustomer := store.customer
	originalComplete := store.completeConflict
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			store.customer = originalCustomer
			store.completeConflict = originalComplete
			if test.status == http.StatusNotFound {
				store.customer = nil
			}
			if test.status == http.StatusConflict {
				store.completeConflict = true
			}
			request := stage8CRequest(test.method, test.target, test.body, test.user, test.admin)
			if test.apiKey == "" {
				request.Header.Del("X-API-Key")
			} else {
				request.Header.Set("X-API-Key", test.apiKey)
			}
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if recorder.Code != test.status {
				t.Fatalf("%s => %d, want %d: %s", test.name, recorder.Code, test.status, recorder.Body.String())
			}
			if test.status >= 400 && test.status != http.StatusUnauthorized &&
				recorder.Header().Get("Content-Type") == "application/json" {
				var body map[string]any
				if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
					t.Fatalf("%s returned invalid JSON error body: %v", test.name, err)
				}
				if _, ok := body["detail"]; !ok {
					t.Fatalf("%s error body missing detail: %s", test.name, recorder.Body.String())
				}
			}
		})
	}
}

func TestStage8CReminderSSEUsesHeartbeatAndStopsOnDisconnect(t *testing.T) {
	store := &stage8CStore{}
	router := stage8CRouter(store, &stage8CStorage{})
	for _, target := range []string{
		"/api/v1/crm/tasks/reminders/stream",
		"/api/v1/crm/follow-ups/reminders/stream",
	} {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		request := stage8CRequest(http.MethodGet, target, "", "user-1", false).WithContext(ctx)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s status = %d: %s", target, recorder.Code, recorder.Body.String())
		}
		if got := recorder.Header().Get("Content-Type"); got != "text/event-stream" {
			t.Fatalf("%s Content-Type = %q", target, got)
		}
		if !strings.Contains(recorder.Body.String(), ": keep-alive") {
			t.Fatalf("%s missing heartbeat: %q", target, recorder.Body.String())
		}
	}
}

func TestStage8CProposalMissingStorageFailsClosed(t *testing.T) {
	store := &stage8CStore{}
	router := stage8CRouter(store, nil)
	request := stage8CRequest(http.MethodPost, "/api/v1/crm/proposals/uploads/init", `{"filename":"a.html","size":10}`, "user-1", false)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "云存储未配置") {
		t.Fatalf("body = %s, want precise storage error", recorder.Body.String())
	}
}

func TestStage8CJSONShapeAndTimestampCompatibility(t *testing.T) {
	store := &stage8CStore{customer: stage8CCustomer()}
	router := stage8CRouter(store, &stage8CStorage{})
	request := stage8CRequest(http.MethodGet, "/api/v1/crm/customers/1", "", "user-1", false)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode customer: %v", err)
	}
	for _, field := range []string{"score_scale", "owner_name", "contact_name", "last_follow_at"} {
		if _, ok := payload[field]; !ok {
			t.Errorf("response missing snake_case field %q: %s", field, recorder.Body.String())
		}
	}
	if payload["created_at"] != "2026-11-08T00:00:00Z" {
		t.Errorf("created_at = %#v, want RFC3339", payload["created_at"])
	}
}
