package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/system_management"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type stage8BStore struct {
	system_management.Store
	auditPage    system_management.AuditLogPage
	auditFilter  system_management.AuditLogFilter
	auditSummary system_management.AuditLogSummary
}

func (s *stage8BStore) ListAuditLogs(
	_ context.Context,
	filter system_management.AuditLogFilter,
) (system_management.AuditLogPage, error) {
	s.auditFilter = filter
	return s.auditPage, nil
}

func (s *stage8BStore) AuditLogSummary(
	_ context.Context,
	_ system_management.AuditLogFilter,
) (system_management.AuditLogSummary, error) {
	return s.auditSummary, nil
}

type stage8BCache struct {
	cleared int
	err     error
}

func (c *stage8BCache) ClearAll(context.Context) (int, error) {
	return c.cleared, c.err
}

type stage8BAuditor struct {
	entries []audit.Entry
}

func (a *stage8BAuditor) LogAction(_ context.Context, entry audit.Entry) error {
	a.entries = append(a.entries, entry)
	return nil
}

func (a *stage8BAuditor) LogActionTx(_ context.Context, _ pgx.Tx, entry audit.Entry) error {
	a.entries = append(a.entries, entry)
	return nil
}

func (a *stage8BAuditor) LogView(
	context.Context,
	string,
	string,
	*string,
	any,
	*http.Request,
) error {
	return nil
}

func TestStage8BSystemManagementRouteInventory(t *testing.T) {
	router := chi.NewRouter()
	system_management.NewRegistrar(
		&stage8BStore{},
		&stage8BAuditor{},
		system_management.WithCacheClearer(&stage8BCache{}),
	).RegisterRoutes(router, stage8BPassthrough)

	want := []string{
		"GET /api/v1/system-management/audit-logs",
		"GET /api/v1/system-management/audit-logs/summary",
		"GET /api/v1/system-management/agent-access-logs",
		"GET /api/v1/system-management/agent-access-logs/summary",
		"GET /api/v1/system-management/agent-operation-logs",
		"GET /api/v1/system-management/agent-operation-logs/summary",
		"GET /api/v1/system-management/operator-management/performance",
		"POST /api/v1/system-management/operator-management/performance/upsert",
		"POST /api/v1/system-management/operation-audit-logs/client-actions",
		"GET /api/v1/system-management/data-management/status",
		"GET /api/v1/system-management/data-management/overview",
		"PATCH /api/v1/system-management/data-management/data-status",
		"POST /api/v1/system-management/cache/clear-all",
		"POST /api/v1/system-management/commission-management/records/upsert",
		"GET /api/v1/system-management/commission-management/records",
		"PATCH /api/v1/system-management/commission-management/records/{record_id}/payment-status",
		"GET /api/v1/system-management/commission-management/project-months",
		"PATCH /api/v1/system-management/commission-management/project-months/{project_month_id}/payment",
		"POST /api/v1/system-management/commission-management/ratio-overrides/upsert",
		"GET /api/v1/system-management/commission-management/ratio-overrides",
		"GET /api/v1/system-management/commission-management/role-assignments",
		"POST /api/v1/system-management/commission-management/role-assignments/upsert",
		"GET /api/v1/system-management/commission-management/summary/monthly",
		"GET /api/v1/system-management/commission-management/summary/project",
		"POST /api/v1/system-management/commission-management/recompute",
	}

	var got []string
	if err := chi.Walk(router, func(
		method string,
		route string,
		_ http.Handler,
		_ ...func(http.Handler) http.Handler,
	) error {
		got = append(got, method+" "+route)
		return nil
	}); err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	sort.Strings(got)
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("route count = %d, want %d\ngot:\n%s", len(got), len(want), strings.Join(got, "\n"))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("route[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestStage8BSystemManagementAuthAndAuditWireContract(t *testing.T) {
	store := &stage8BStore{
		auditPage: system_management.AuditLogPage{
			Items: []system_management.AuditLogItem{{
				ID:            7,
				CreatedAt:     "2026-11-08T10:11:12+08:00",
				Operator:      stage8BText("admin"),
				Action:        "commission.bonus.recompute",
				TargetType:    "commission_bonus_record",
				TargetID:      stage8BText("2026-10"),
				Result:        "success",
				BeforeJSON:    nil,
				AfterJSON:     map[string]any{"record_count": 2},
				RequestMethod: stage8BText("POST"),
				RequestPath:   stage8BText("/api/v1/system-management/commission-management/recompute"),
			}},
			Total: 1,
		},
		auditSummary: system_management.AuditLogSummary{
			Total:               1,
			SuccessCount:        1,
			FailureCount:        0,
			UniqueOperatorCount: 1,
			Modules: []system_management.AuditModuleSummary{
				{Key: "commission", Label: "运营报表核算", Count: 1, SuccessCount: 1},
			},
			TopActions: []system_management.AuditActionSummary{
				{Action: "commission.bonus.recompute", Count: 1},
			},
		},
	}
	router := chi.NewRouter()
	system_management.NewRegistrar(
		store,
		&stage8BAuditor{},
		system_management.WithCacheClearer(&stage8BCache{cleared: 3}),
	).RegisterRoutes(router, stage8BPassthrough)

	request := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/system-management/audit-logs?page=2&page_size=1&operator=adm&result=success&keyword=recompute",
		nil,
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401", recorder.Code)
	}

	request = stage8BRequest(
		http.MethodGet,
		"/api/v1/system-management/audit-logs?page=2&page_size=1&operator=adm&result=success&keyword=recompute",
		"",
		false,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("non-admin status = %d, want 403", recorder.Code)
	}

	request = stage8BRequest(
		http.MethodGet,
		"/api/v1/system-management/audit-logs?page=2&page_size=1&operator=adm&result=success&keyword=recompute",
		"admin",
		true,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("admin status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	var page system_management.AuditLogPage
	if err := json.Unmarshal(recorder.Body.Bytes(), &page); err != nil {
		t.Fatalf("decode audit page: %v", err)
	}
	if page.Total != 1 || len(page.Items) != 1 || page.Items[0].AfterJSON == nil {
		t.Fatalf("audit page = %#v", page)
	}
	if store.auditFilter.Page != 2 || store.auditFilter.PageSize != 1 ||
		store.auditFilter.Operator != "adm" || store.auditFilter.Result != "success" ||
		store.auditFilter.Keyword != "recompute" {
		t.Fatalf("audit filter = %#v", store.auditFilter)
	}

	request = stage8BRequest(
		http.MethodGet,
		"/api/v1/system-management/audit-logs/summary?operator=adm&result=success",
		"admin",
		true,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("summary status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	var summary system_management.AuditLogSummary
	if err := json.Unmarshal(recorder.Body.Bytes(), &summary); err != nil {
		t.Fatalf("decode audit summary: %v", err)
	}
	if summary.Total != 1 || len(summary.Modules) != 1 || summary.Modules[0].Key != "commission" {
		t.Fatalf("audit summary = %#v", summary)
	}

	request = stage8BRequest(
		http.MethodGet,
		"/api/v1/system-management/audit-logs?page_size=101",
		"admin",
		true,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid pagination status = %d, want 422", recorder.Code)
	}
}

func TestStage8BClientAuditAndCacheSafetyBoundary(t *testing.T) {
	auditor := &stage8BAuditor{}
	cache := &stage8BCache{cleared: 4}
	router := chi.NewRouter()
	system_management.NewRegistrar(
		&stage8BStore{},
		auditor,
		system_management.WithCacheClearer(cache),
	).RegisterRoutes(router, stage8BPassthrough)

	request := stage8BJSONRequest(
		http.MethodPost,
		"/api/v1/system-management/operation-audit-logs/client-actions",
		`{"action":"dashboard.export","target_type":"monthly_report","target_id":"42","result":"success","after":{"format":"csv"}}`,
		"admin",
		true,
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("client audit status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if len(auditor.entries) != 1 {
		t.Fatalf("audit entries = %d, want 1", len(auditor.entries))
	}
	entry := auditor.entries[0]
	if entry.Action != "dashboard.export" || entry.TargetType != "monthly_report" ||
		entry.TargetID == nil || *entry.TargetID != "42" ||
		entry.Operator == nil || *entry.Operator != "admin" {
		t.Fatalf("client audit entry = %#v", entry)
	}

	request = stage8BJSONRequest(
		http.MethodPost,
		"/api/v1/system-management/cache/clear-all",
		"",
		"admin",
		true,
	)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("cache clear status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if cache.cleared != 4 || len(auditor.entries) != 2 {
		t.Fatalf("cache cleared=%d audit entries=%d", cache.cleared, len(auditor.entries))
	}
}

func stage8BPassthrough(next http.Handler) http.Handler { return next }

func stage8BRequest(method, target, operator string, isAdmin bool) *http.Request {
	request := httptest.NewRequest(method, target, bytes.NewBuffer(nil))
	request = request.WithContext(auth.WithUserContext(context.Background(), auth.UserContext{
		Operator: operator,
		IsAdmin:  isAdmin,
	}))
	request.Header.Set("Content-Type", "application/json")
	return request
}

func stage8BJSONRequest(method, target, body, operator string, isAdmin bool) *http.Request {
	request := stage8BRequest(method, target, operator, isAdmin)
	request.Body = io.NopCloser(bytes.NewBufferString(body))
	request.ContentLength = int64(len(body))
	return request
}

func stage8BText(value string) *string { return &value }
