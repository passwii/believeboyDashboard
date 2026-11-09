package pricing_calculation_snapshots

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type snapshotMockStore struct {
	items       []SnapshotListItem
	detail      *SnapshotDetail
	itemsResp   *SnapshotItemsResponse
	verifyErr   error
	createID    int64
	createErr   error
	updateValue SnapshotListItem
	deleteOK    bool
}

func (s *snapshotMockStore) VerifyProjectAccess(context.Context, int64, string, bool) error {
	return s.verifyErr
}

func (s *snapshotMockStore) List(context.Context, int64, string, int, int) ([]SnapshotListItem, error) {
	return s.items, nil
}

func (s *snapshotMockStore) Get(context.Context, int64) (*SnapshotDetail, error) {
	return s.detail, nil
}

func (s *snapshotMockStore) GetItems(context.Context, int64) (*SnapshotItemsResponse, error) {
	return s.itemsResp, nil
}

func (s *snapshotMockStore) Create(context.Context, int64, string, *string, *string, string) (int64, error) {
	return s.createID, s.createErr
}

func (s *snapshotMockStore) Update(context.Context, int64, *string, *string, string) (*SnapshotListItem, error) {
	return &s.updateValue, nil
}

func (s *snapshotMockStore) Delete(context.Context, int64) (bool, error) {
	return s.deleteOK, nil
}

func (s *snapshotMockStore) ProjectID(context.Context, int64) (int64, error) {
	return 7, nil
}

func (s *snapshotMockStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, Store) error,
) error {
	next := *s
	if err := fn(ctx, nil, &next); err != nil {
		return err
	}
	*s = next
	return nil
}

func TestSnapshotRoutesWireContractAndAudit(t *testing.T) {
	store := &snapshotMockStore{
		items: []SnapshotListItem{{
			ID: 1, ProjectID: 7, ProjectName: "US Shop", Country: "US",
			SnapshotDate: "2026-11-08T08:00:00Z", RowCount: 2,
			CreatedAt: "2026-11-08T08:00:00Z",
			Summary:   SnapshotSummary{Total: 2, Calculated: 2, Profitable: 1, PassRate: 50},
		}},
		detail: &SnapshotDetail{
			SnapshotListItem: SnapshotListItem{
				ID: 2, ProjectID: 7, ProjectName: "US Shop", Country: "US",
				SnapshotDate: "2026-11-08T08:00:00Z", RowCount: 1,
				CreatedAt: "2026-11-08T08:00:00Z",
				Summary:   SnapshotSummary{Total: 1, Calculated: 1, Profitable: 1, PassRate: 100},
			},
			Items: []SnapshotItem{{ID: 2000001, ProjectID: 7, ProjectName: "US Shop", SKU: "A-1", Country: "US"}},
		},
		itemsResp: &SnapshotItemsResponse{
			Items:    []SnapshotItem{{ID: 2000001, ProjectID: 7, SKU: "A-1", Country: "US"}},
			Summary:  SnapshotSummary{Total: 1, Calculated: 1, Profitable: 1, PassRate: 100},
			RowCount: 1, Total: 1, Page: 1, PageSize: 200,
			SnapshotID: 2, SnapshotDate: "2026-11-08T08:00:00Z",
		},
		createID: 2,
		updateValue: SnapshotListItem{
			ID: 2, ProjectID: 7, ProjectName: "US Shop", Country: "US",
			SnapshotDate: "2026-11-08T08:00:00Z", RowCount: 1,
			CreatedAt: "2026-11-08T08:00:00Z",
		},
		deleteOK: true,
	}
	auditor := audit.NewMockService()
	router := chi.NewRouter()
	NewRegistrar(store, auditor).RegisterRoutes(router, func(next http.Handler) http.Handler { return next })

	admin := auth.WithUserContext(context.Background(), auth.UserContext{Operator: "admin_op", IsAdmin: true})
	operator := auth.WithUserContext(context.Background(), auth.UserContext{Operator: "alice"})

	t.Run("list", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/pricing-calculation-snapshots?project_id=7&country=US&page=2&page_size=5", nil).WithContext(operator)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
		}
		var got []SnapshotListItem
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode list: %v", err)
		}
		if len(got) != 1 || got[0].Summary.PassRate != 50 {
			t.Fatalf("unexpected list: %s", rec.Body.String())
		}
	})

	t.Run("detail and items", func(t *testing.T) {
		for _, path := range []string{"/api/v1/pricing-calculation-snapshots/2", "/api/v1/pricing-calculation-snapshots/2/items"} {
			req := httptest.NewRequest(http.MethodGet, path, nil).WithContext(operator)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("%s status = %d, want 200; body=%s", path, rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"row_count":1`) {
				t.Fatalf("%s missing row_count: %s", path, rec.Body.String())
			}
		}
	})

	t.Run("create audits and returns created detail", func(t *testing.T) {
		body := strings.NewReader(`{"name":"Q4","description":"close"}`)
		req := httptest.NewRequest(http.MethodPost, "/api/v1/pricing-calculation-snapshots?project_id=7&country=US", body).WithContext(operator)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("status = %d, want 201; body=%s", rec.Code, rec.Body.String())
		}
		if len(auditor.Entries) != 1 || auditor.Entries[0].Action != "pricing_calculation_snapshot.create" {
			t.Fatalf("unexpected audit entries: %#v", auditor.Entries)
		}
	})

	t.Run("update requires admin", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPatch, "/api/v1/pricing-calculation-snapshots/2", strings.NewReader(`{"name":"new"}`)).WithContext(operator)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("non-admin status = %d, want 403", rec.Code)
		}

		req = httptest.NewRequest(http.MethodPatch, "/api/v1/pricing-calculation-snapshots/2", strings.NewReader(`{"name":"new"}`)).WithContext(admin)
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("admin status = %d, want 200; body=%s", rec.Code, rec.Body.String())
		}
	})

	t.Run("update rejects unknown fields", func(t *testing.T) {
		req := httptest.NewRequest(
			http.MethodPatch,
			"/api/v1/pricing-calculation-snapshots/2",
			strings.NewReader(`{"name":"new","descripton":"typo"}`),
		).WithContext(admin)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422; body=%s", rec.Code, rec.Body.String())
		}
	})

	t.Run("delete requires admin and returns 204", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodDelete, "/api/v1/pricing-calculation-snapshots/2", nil).WithContext(admin)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
			t.Fatalf("response = %d %q, want 204 empty", rec.Code, rec.Body.String())
		}
	})

	t.Run("project forbidden", func(t *testing.T) {
		store.verifyErr = ErrProjectForbidden
		req := httptest.NewRequest(http.MethodGet, "/api/v1/pricing-calculation-snapshots?project_id=7&country=US", nil).WithContext(operator)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", rec.Code)
		}
		store.verifyErr = nil
	})

	t.Run("invalid pagination returns 422", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/pricing-calculation-snapshots?project_id=7&country=US&page_size=101", nil).WithContext(operator)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422", rec.Code)
		}
	})

	t.Run("create without source rows returns 404", func(t *testing.T) {
		store.createErr = ErrSourceEmpty
		req := httptest.NewRequest(http.MethodPost, "/api/v1/pricing-calculation-snapshots?project_id=7&country=US", nil).WithContext(operator)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
		}
		store.createErr = nil
	})

	t.Run("internal errors are not leaked", func(t *testing.T) {
		store.createErr = errors.New("database host secret.internal failed")
		req := httptest.NewRequest(http.MethodPost, "/api/v1/pricing-calculation-snapshots?project_id=7&country=US", nil).WithContext(operator)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500; body=%s", rec.Code, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "secret.internal") {
			t.Fatalf("internal error leaked: %s", rec.Body.String())
		}
		store.createErr = nil
	})
}
