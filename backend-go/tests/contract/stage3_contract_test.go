package contract

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/pricing_calculation_snapshots"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type stage3SnapshotStore struct {
	item   pricing_calculation_snapshots.SnapshotItem
	detail pricing_calculation_snapshots.SnapshotDetail
}

func (s *stage3SnapshotStore) VerifyProjectAccess(context.Context, int64, string, bool) error {
	return nil
}
func (s *stage3SnapshotStore) List(context.Context, int64, string, int, int) ([]pricing_calculation_snapshots.SnapshotListItem, error) {
	return []pricing_calculation_snapshots.SnapshotListItem{s.detail.SnapshotListItem}, nil
}
func (s *stage3SnapshotStore) Get(context.Context, int64) (*pricing_calculation_snapshots.SnapshotDetail, error) {
	return &s.detail, nil
}
func (s *stage3SnapshotStore) GetItems(context.Context, int64) (*pricing_calculation_snapshots.SnapshotItemsResponse, error) {
	return &pricing_calculation_snapshots.SnapshotItemsResponse{
		Items:      []pricing_calculation_snapshots.SnapshotItem{s.item},
		Summary:    s.detail.Summary,
		RowCount:   1,
		Total:      1,
		Page:       1,
		PageSize:   200,
		SnapshotID: s.detail.ID,
	}, nil
}
func (s *stage3SnapshotStore) Create(context.Context, int64, string, *string, *string, string) (int64, error) {
	return s.detail.ID, nil
}
func (s *stage3SnapshotStore) Update(context.Context, int64, *string, *string, string) (*pricing_calculation_snapshots.SnapshotListItem, error) {
	return &s.detail.SnapshotListItem, nil
}
func (s *stage3SnapshotStore) Delete(context.Context, int64) (bool, error) { return true, nil }
func (s *stage3SnapshotStore) ProjectID(context.Context, int64) (int64, error) {
	return s.detail.ProjectID, nil
}
func (s *stage3SnapshotStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, pricing_calculation_snapshots.Store) error,
) error {
	next := *s
	if err := fn(ctx, nil, &next); err != nil {
		return err
	}
	*s = next
	return nil
}

func TestStage3PricingSnapshotContract(t *testing.T) {
	store := &stage3SnapshotStore{
		item: pricing_calculation_snapshots.SnapshotItem{
			ID: 1000001, ProjectID: 1, ProjectName: "Shop", SKU: "A-1",
			Country: "US", AccountingType: "profit_calc",
			Fees:   pricing_calculation_snapshots.SnapshotFees{TotalFeeUSD: 8.8, AdvertisingFeeUSD: 2.4},
			Profit: pricing_calculation_snapshots.SnapshotProfit{DDPCostUSD: 3.47},
			Anchor: &pricing_calculation_snapshots.SnapshotAnchor{},
		},
		detail: pricing_calculation_snapshots.SnapshotDetail{
			SnapshotListItem: pricing_calculation_snapshots.SnapshotListItem{
				ID: 1, ProjectID: 1, ProjectName: "Shop", Country: "US",
				SnapshotDate: "2026-11-08T08:00:00Z", RowCount: 1,
				CreatedAt: "2026-11-08T08:00:00Z",
				Summary: pricing_calculation_snapshots.SnapshotSummary{
					Total: 1, Calculated: 1, Profitable: 1, PassRate: 100,
				},
			},
		},
	}
	router := chi.NewRouter()
	pricing_calculation_snapshots.NewRegistrar(store, audit.NewMockService()).
		RegisterRoutes(router, func(next http.Handler) http.Handler { return next })
	ctx := auth.WithUserContext(context.Background(), auth.UserContext{Operator: "alice", IsAdmin: true})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/pricing-calculation-snapshots?project_id=1&country=US", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	for _, key := range []string{`"passRate":100`, `"row_count":1`, `"snapshot_date":`} {
		if !strings.Contains(rec.Body.String(), key) {
			t.Errorf("body %s missing %s", rec.Body.String(), key)
		}
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/pricing-calculation-snapshots/1/items", nil).WithContext(ctx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("items status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var response pricing_calculation_snapshots.SnapshotItemsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode items: %v", err)
	}
	if response.SnapshotID != 1 || response.Items[0].SKU != "A-1" {
		t.Fatalf("unexpected items response: %#v", response)
	}
}
