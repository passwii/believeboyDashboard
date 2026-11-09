package store

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/internal_ad_data"
)

func TestInternalAdDataStoreVerifyAccess(t *testing.T) {
	ctx := context.Background()
	op := "alice"
	as := "bob"

	t.Run("admin access", func(t *testing.T) {
		db := &fakeDB{row: fakeRow{values: []any{&op, &as}}}
		s := NewInternalAdDataStore(&fakeWriteDB{fakeDB: db})
		err := s.VerifyProjectAccess(ctx, 1, "charlie", true)
		if err != nil {
			t.Fatalf("expected nil for admin, got %v", err)
		}
	})

	t.Run("forbidden", func(t *testing.T) {
		db := &fakeDB{row: fakeRow{values: []any{&op, &as}}}
		s := NewInternalAdDataStore(&fakeWriteDB{fakeDB: db})
		err := s.VerifyProjectAccess(ctx, 1, "charlie", false)
		if err != internal_ad_data.ErrProjectForbidden {
			t.Fatalf("expected ErrProjectForbidden, got %v", err)
		}
	})

	t.Run("not found", func(t *testing.T) {
		db := &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}
		s := NewInternalAdDataStore(&fakeWriteDB{fakeDB: db})
		err := s.VerifyProjectAccess(ctx, 999, "alice", true)
		if err != internal_ad_data.ErrProjectNotFound {
			t.Fatalf("expected ErrProjectNotFound, got %v", err)
		}
	})
}

func TestInternalAdDataStoreListFilesEmpty(t *testing.T) {
	ctx := context.Background()
	db := &fakeDB{}
	s := NewInternalAdDataStore(&fakeWriteDB{fakeDB: db})

	files, err := s.ListAdUploadFiles(ctx, 1, nil, nil, false, 100, 0)
	if err != nil {
		t.Fatalf("ListAdUploadFiles error: %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("expected 0 files, got %d", len(files))
	}
}

func TestInternalAdDataStoreQueryRawEmpty(t *testing.T) {
	ctx := context.Background()
	db := &fakeDB{}
	s := NewInternalAdDataStore(&fakeWriteDB{fakeDB: db})

	filter := internal_ad_data.RawQueryFilter{
		ProjectID: 1,
		Endpoint:  "ad-campaigns",
		Period:    "7d",
		Country:   "US",
		Limit:     100,
		Offset:    0,
		OrderBy:   "report_end_date",
		OrderDir:  "desc",
	}
	resp, err := s.QueryRaw(ctx, filter)
	if err != nil {
		t.Fatalf("QueryRaw error: %v", err)
	}
	if resp.ProjectID != 1 || len(resp.Data) != 0 || resp.Summary.TotalRows != 0 {
		t.Fatalf("unexpected raw response: %#v", resp)
	}
}
