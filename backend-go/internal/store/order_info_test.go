package store

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/order_info"
)

func TestBuildOrderInfoWhere(t *testing.T) {
	filter := order_info.OrderInfoFilter{
		ProjectIDs:          []int64{1, 2},
		FulfillmentChannels: []string{"Amazon"},
		OrderStatuses:       []string{"Shipped"},
		Countries:           []string{"US"},
		Currencies:          []string{"USD"},
	}
	where, args := buildOrderInfoWhere(filter.ProjectIDs, filter)
	if where == "" {
		t.Fatal("expected non-empty where clause")
	}
	if len(args) != 5 {
		t.Fatalf("expected 5 args, got %d", len(args))
	}
}

func TestOrderInfoStoreOperatorPermissions(t *testing.T) {
	ctx := context.Background()

	t.Run("admin has full project scope", func(t *testing.T) {
		db := &fakeDB{}
		s := NewOrderInfoStore(&fakeWriteDB{fakeDB: db})
		filter := order_info.OrderInfoFilter{
			ProjectIDs: []int64{10, 20},
			IsAdmin:    true,
		}
		scoped, hasAccess, err := s.resolveProjectScope(ctx, filter)
		if err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		if !hasAccess || len(scoped) != 2 {
			t.Fatalf("expected full access with 2 projects, got %v, %v", hasAccess, scoped)
		}
	})

	t.Run("non-admin operator with assigned projects", func(t *testing.T) {
		// Mock query returning project IDs 1 and 2
		db := &fakeDB{
			rows: &fakeRows{
				batches: [][]any{
					{int64(1)},
					{int64(2)},
				},
			},
		}
		s := NewOrderInfoStore(&fakeWriteDB{fakeDB: db})
		filter := order_info.OrderInfoFilter{
			ProjectIDs: []int64{2, 3}, // user asked for 2 and 3; only 2 is accessible
			Operator:   "alice",
			IsAdmin:    false,
		}
		scoped, hasAccess, err := s.resolveProjectScope(ctx, filter)
		if err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		if !hasAccess || len(scoped) != 1 || scoped[0] != 2 {
			t.Fatalf("expected scoped to [2], got hasAccess=%v, scoped=%v", hasAccess, scoped)
		}
	})

	t.Run("non-admin operator with no accessible projects", func(t *testing.T) {
		db := &fakeDB{
			rows: &fakeRows{batches: [][]any{}},
		}
		s := NewOrderInfoStore(&fakeWriteDB{fakeDB: db})
		filter := order_info.OrderInfoFilter{
			Operator: "bob",
			IsAdmin:  false,
		}
		scoped, hasAccess, err := s.resolveProjectScope(ctx, filter)
		if err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		if hasAccess || len(scoped) != 0 {
			t.Fatalf("expected hasAccess=false, got %v, %v", hasAccess, scoped)
		}

		// ListOrders should short-circuit to 0
		resp, err := s.ListOrders(ctx, filter)
		if err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		if resp.Total != 0 || len(resp.Items) != 0 {
			t.Fatalf("expected 0 total orders, got %d", resp.Total)
		}
	})

	t.Run("non-admin update order forbidden on unassigned project", func(t *testing.T) {
		now := time.Now()
		// First queryRow returns order on project 99
		// Second query returns accessible projects [1, 2]
		orderRow := fakeRow{
			values: []any{
				int64(100), int64(99), "OtherProject", (*string)(nil), int64(5),
				now, now, now, "ORDER-123", "Shipped", "Merchant", (*string)(nil),
				(*string)(nil), (*string)(nil), (*string)(nil), 1, 10.0, 0.0, (*string)(nil),
				"US", (*string)(nil), (*string)(nil), (*string)(nil), true, now,
				(*string)(nil), (*string)(nil), (*time.Time)(nil), (*string)(nil), (*time.Time)(nil),
			},
		}
		db := &fakeDB{
			row: orderRow,
			rows: &fakeRows{
				batches: [][]any{
					{int64(1)},
					{int64(2)},
				},
			},
		}
		s := NewOrderInfoStore(&fakeWriteDB{fakeDB: db})
		carrier := "UPS"
		_, err := s.UpdateOrderByID(ctx, 100, order_info.OrderInfoUpdate{Carrier: &carrier}, "alice", false)
		if err == nil || !strings.Contains(err.Error(), "403") {
			t.Fatalf("expected 403 forbidden error, got: %v", err)
		}
	})
}
