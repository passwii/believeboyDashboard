package store

import (
	"context"
	"testing"
)

func TestRpaReportsStoreEmpty(t *testing.T) {
	ctx := context.Background()
	db := &fakeDB{}
	s := NewRpaReportsStore(&fakeWriteDB{fakeDB: db})

	resp, err := s.GetReportStatusForDate(ctx, "2026-10-10", "US", "admin", true)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if resp.Country != "US" || len(resp.Items) != 0 {
		t.Fatalf("unexpected resp: %#v", resp)
	}
}

func TestRpaReportsStoreProjectsFound(t *testing.T) {
	ctx := context.Background()
	// fakeDB returns 1 project
	db := &fakeDB{
		rows: &fakeRows{
			batches: [][]any{
				{int64(1), "US Project", 0},
			},
		},
	}
	s := NewRpaReportsStore(&fakeWriteDB{fakeDB: db})

	resp, err := s.GetReportStatusForDate(ctx, "2026-10-10", "US", "admin", true)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(resp.Items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(resp.Items))
	}
	if resp.Items[0].ProjectID != 1 || resp.Items[0].ProjectName != "US Project" {
		t.Fatalf("unexpected item: %#v", resp.Items[0])
	}
	if len(resp.Items[0].Statuses) != 15 {
		t.Fatalf("expected 15 statuses, got %d", len(resp.Items[0].Statuses))
	}
}
