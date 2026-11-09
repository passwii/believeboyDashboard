package store

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/exchange_rates"
)

func TestExchangeRateStoreInsertReturnsPersistedRow(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{
		row: fakeRow{values: exchangeRateScanValues(12, "2026-10")},
	}}
	description := "monthly rate"
	input := exchange_rates.ExchangeRate{
		Currency:    "USD",
		YearMonth:   "2026-10",
		Rate:        7.12345678,
		Description: &description,
		NoteImages: []map[string]any{{
			"id": "image-1", "url": "https://example.com/a.webp", "filename": "a.webp",
		}},
	}

	got, err := NewExchangeRateStore(db).Insert(context.Background(), input)
	if err != nil {
		t.Fatalf("Insert() error = %v", err)
	}
	if got == nil || got.ID != 12 || got.Currency != "USD" || got.YearMonth != "2026-10" {
		t.Fatalf("Insert() = %#v, want persisted USD row", got)
	}
	if len(db.queryRowCalls) != 1 ||
		!strings.Contains(strings.ToLower(db.queryRowCalls[0].sql), "insert into public.exchange_rates") ||
		!strings.Contains(strings.ToLower(db.queryRowCalls[0].sql), "returning") {
		t.Fatalf("QueryRow() = %#v, want parameterized INSERT RETURNING", db.queryRowCalls)
	}
	args := db.queryRowCalls[0].args
	if len(args) != 6 || args[0] != "USD" || args[2] != "2026-10" ||
		args[3] != input.Rate || args[4] != input.Description {
		t.Errorf("Insert args = %#v, want currency/name/month/rate/description/images", args)
	}
	if images, ok := args[5].([]byte); !ok || string(images) != `[{"filename":"a.webp","id":"image-1","url":"https://example.com/a.webp"}]` {
		t.Errorf("note_images arg = %#v, want compact JSON", args[5])
	}
}

func TestExchangeRateStoreUpdateUsesIDAndReturnsUpdatedRow(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{
		row: fakeRow{values: exchangeRateScanValues(12, "2026-11")},
	}}
	input := exchange_rates.ExchangeRate{
		Currency:   "EUR",
		YearMonth:  "2026-11",
		Rate:       8.25,
		NoteImages: []map[string]any{},
	}

	got, err := NewExchangeRateStore(db).Update(context.Background(), 12, input)
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if got == nil || got.ID != 12 || got.YearMonth != "2026-11" {
		t.Fatalf("Update() = %#v, want updated row", got)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("QueryRow() calls = %d, want 1", len(db.queryRowCalls))
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "update public.exchange_rates") ||
		!strings.Contains(query, "where id = $7") ||
		!strings.Contains(query, "returning") {
		t.Errorf("Update SQL = %s, want UPDATE by id with RETURNING", query)
	}
	args := db.queryRowCalls[0].args
	if len(args) != 7 || args[0] != "EUR" || args[2] != "2026-11" ||
		args[3] != input.Rate || args[6] != int64(12) {
		t.Errorf("Update args = %#v, want values and id 12", args)
	}
}

func TestExchangeRateStoreDeleteReportsMissingRows(t *testing.T) {
	for _, tt := range []struct {
		tag      string
		wantRows bool
	}{
		{tag: "DELETE 1", wantRows: true},
		{tag: "DELETE 0", wantRows: false},
	} {
		t.Run(tt.tag, func(t *testing.T) {
			db := &fakeWriteDB{
				fakeDB:  &fakeDB{},
				execTag: pgconn.NewCommandTag(tt.tag),
			}
			deleted, err := NewExchangeRateStore(db).Delete(context.Background(), 9)
			if err != nil {
				t.Fatalf("Delete() error = %v", err)
			}
			if deleted != tt.wantRows {
				t.Errorf("Delete() = %v, want %v", deleted, tt.wantRows)
			}
			if len(db.execCalls) != 1 || !strings.Contains(strings.ToLower(db.execCalls[0].sql), "delete from public.exchange_rates") {
				t.Fatalf("Exec() = %#v, want exchange-rate DELETE", db.execCalls)
			}
			if !assertWriteArgsEqual(db.execCalls[0].args, []any{int64(9)}) {
				t.Errorf("Delete args = %#v, want id 9", db.execCalls[0].args)
			}
		})
	}
}

func TestExchangeRateStoreWriteErrorsPropagateAndMissingUpdateIsNil(t *testing.T) {
	wantErr := errors.New("database unavailable")
	db := &fakeWriteDB{fakeDB: &fakeDB{row: fakeRow{err: wantErr}}}
	if _, err := NewExchangeRateStore(db).Insert(context.Background(), exchange_rates.ExchangeRate{}); !errors.Is(err, wantErr) {
		t.Errorf("Insert() error = %v, want %v", err, wantErr)
	}
	if _, err := NewExchangeRateStore(db).Update(context.Background(), 4, exchange_rates.ExchangeRate{}); !errors.Is(err, wantErr) {
		t.Errorf("Update() error = %v, want %v", err, wantErr)
	}

	db = &fakeWriteDB{fakeDB: &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}}
	got, err := NewExchangeRateStore(db).Update(context.Background(), 4, exchange_rates.ExchangeRate{})
	if err != nil || got != nil {
		t.Errorf("Update() = %#v, %v, want nil row without error", got, err)
	}

	db = &fakeWriteDB{fakeDB: &fakeDB{}, execErr: wantErr}
	if _, err := NewExchangeRateStore(db).Delete(context.Background(), 4); !errors.Is(err, wantErr) {
		t.Errorf("Delete() error = %v, want %v", err, wantErr)
	}
}
