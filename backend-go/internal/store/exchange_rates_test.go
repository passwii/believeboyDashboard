package store

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

func TestExchangeRateStoreListNormalizesFiltersBoundsPagination(t *testing.T) {
	createdAt := time.Date(2026, 10, 27, 1, 2, 3, 0, time.UTC)
	db := &fakeDB{row: fakeRow{values: []any{0}}}
	db.rows = &fakeRows{
		batches: [][]any{{
			int64(7),
			"USD",
			pgtype.Text{String: "美元", Valid: true},
			"2026-10",
			numericFromString("7.12345678"),
			pgtype.Text{String: "monthly", Valid: true},
			[]byte(`[{"id":"image-1","url":"https://example.com/a.webp","filename":"a.webp","content_type":"image/webp","size":123,"uploaded_at":"2026-10-26T00:00:00+00:00"}]`),
			createdAt,
			createdAt,
		}},
	}
	store := NewExchangeRateStore(db)
	currency := " USD "
	yearMonth := "2026-03"

	rows, total, err := store.List(context.Background(), &currency, &yearMonth, -2, 999)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if total != 0 {
		t.Errorf("total = %d, want 0 from empty count scan", total)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %#v, want one", rows)
	}
	if rows[0].ID != 7 || rows[0].Currency != "USD" || rows[0].YearMonth != "2026-10" {
		t.Errorf("row = %#v, want scanned values", rows[0])
	}
	if rows[0].CurrencyName == nil || *rows[0].CurrencyName != "美元" {
		t.Errorf("currency_name = %#v, want 美元", rows[0].CurrencyName)
	}
	if len(rows[0].NoteImages) != 1 || rows[0].NoteImages[0]["filename"] != "a.webp" {
		t.Errorf("note_images = %#v, want JSON decoded image", rows[0].NoteImages)
	}
	if len(db.queryRowCalls) != 1 || len(db.queryCalls) != 1 {
		t.Fatalf("queries = row %d + rows %d, want count + rows", len(db.queryRowCalls), len(db.queryCalls))
	}
	if !strings.Contains(db.queryRowCalls[0].sql, "count(*)") {
		t.Errorf("count SQL = %s, want count query", db.queryRowCalls[0].sql)
	}
	if !strings.Contains(db.queryCalls[0].sql, "order by year_month desc, currency asc") {
		t.Errorf("list SQL = %s, want FastAPI ordering", db.queryCalls[0].sql)
	}
	assertArgs(t, db.queryCalls[0].args, []any{&currency, &yearMonth, 0, 200})
}

func TestExchangeRateStoreListUsesEmptyFiltersAndDefaultPagination(t *testing.T) {
	db := &fakeDB{row: fakeRow{values: []any{0}}}
	db.rows = &fakeRows{}
	store := NewExchangeRateStore(db)

	_, _, err := store.List(context.Background(), nil, nil, 0, 0)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(db.queryRowCalls) != 1 || len(db.queryCalls) != 1 {
		t.Fatalf("queries = row %d + rows %d, want 2", len(db.queryRowCalls), len(db.queryCalls))
	}
	if !strings.Contains(db.queryCalls[0].sql, "($1::text is null or currency = $1)") {
		t.Errorf("list SQL = %s, want optional filter clauses", db.queryCalls[0].sql)
	}
	assertArgs(t, db.queryCalls[0].args, []any{(*string)(nil), (*string)(nil), 0, 1})
}

func TestExchangeRateStoreResolvePrefersExactThenHistoricalThenLatest(t *testing.T) {
	tests := []struct {
		name            string
		sqlContains     []string
		args            []any
		wantRowQueries  int
		wantRowsQueries int
		rowsBatch       [][]any
	}{
		{
			name:            "exact",
			sqlContains:     []string{"currency = $1", "year_month = $2"},
			args:            []any{"USD", "2026-10"},
			wantRowQueries:  1,
			wantRowsQueries: 0,
			rowsBatch:       [][]any{exchangeRateScanValues(8, "2026-10")},
		},
		{
			name:            "historical fallback",
			sqlContains:     []string{"year_month <= $2"},
			args:            []any{"USD", "2026-10"},
			wantRowQueries:  2,
			wantRowsQueries: 1,
			rowsBatch:       [][]any{exchangeRateScanValues(8, "2026-09")},
		},
		{
			name:            "latest fallback",
			sqlContains:     []string{"order by year_month desc, id desc"},
			args:            []any{"USD"},
			wantRowQueries:  3,
			wantRowsQueries: 2,
			rowsBatch:       [][]any{exchangeRateScanValues(8, "2027-01")},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rowResults := []pgx.Row{&fakeRows{batches: tt.rowsBatch}}
			if tt.name == "historical fallback" {
				rowResults = []pgx.Row{fakeRow{err: pgx.ErrNoRows}, &fakeRows{batches: tt.rowsBatch}}
			}
			if tt.name == "latest fallback" {
				rowResults = []pgx.Row{fakeRow{err: pgx.ErrNoRows}, fakeRow{err: pgx.ErrNoRows}, &fakeRows{batches: tt.rowsBatch}}
			}
			db := &fakeDB{row: fakeRow{err: pgx.ErrNoRows}, rowsQueue: rowResults}
			db.rows = &fakeRows{batches: tt.rowsBatch}

			got, err := NewExchangeRateStore(db).Resolve(context.Background(), "USD", "2026-10")
			if err != nil {
				t.Fatalf("Resolve() error = %v", err)
			}
			wantYearMonth := "2026-10"
			if tt.name == "historical fallback" {
				wantYearMonth = "2026-09"
			}
			if tt.name == "latest fallback" {
				wantYearMonth = "2027-01"
			}
			if got == nil || got.ID != 8 || got.YearMonth != wantYearMonth {
				t.Fatalf("Resolve() = %#v, want historical fallback row", got)
			}
			if len(db.queryRowCalls) != tt.wantRowQueries {
				t.Fatalf("query calls = %d, want %d", len(db.queryRowCalls), tt.wantRowQueries)
			}
			lastQuery := db.queryRowCalls[len(db.queryRowCalls)-1]
			for _, fragment := range tt.sqlContains {
				if !strings.Contains(lastQuery.sql, fragment) {
					t.Errorf("resolved SQL = %s, want %q", lastQuery.sql, fragment)
				}
			}
			assertArgs(t, lastQuery.args, tt.args)
			if tt.wantRowsQueries > 0 {
				wantFallbackSQL := "year_month <= $2"
				if tt.name == "latest fallback" {
					wantFallbackSQL = "from public.exchange_rates"
				}
				_ = wantFallbackSQL
			}
		})
	}
}

func TestExchangeRateStoreResolveFallsBackToLatestWhenNoHistoricalRow(t *testing.T) {
	db := &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}
	store := NewExchangeRateStore(db)

	got, err := store.Resolve(context.Background(), "USD", "2020-01")
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if got != nil {
		t.Fatalf("Resolve() = %#v, want nil", got)
	}
	if len(db.queryRowCalls) != 3 || len(db.queryCalls) != 0 {
		t.Fatalf("queries = row %d + rows %d, want 3 point lookups", len(db.queryRowCalls), len(db.queryCalls))
	}
}

func TestExchangeRateStoreGetAndOptions(t *testing.T) {
	db := &fakeDB{}
	db.row = fakeRow{values: []any{
		int64(9),
		"EUR",
		pgtype.Text{String: "欧元", Valid: true},
		"2025-12",
		numericFromString("7.90000000"),
		pgtype.Text{},
		[]byte(`[]`),
		time.Date(2025, 12, 1, 0, 0, 0, 0, time.UTC),
		time.Date(2025, 12, 1, 0, 0, 0, 0, time.UTC),
	}}
	store := NewExchangeRateStore(db)

	got, err := store.Get(context.Background(), 9)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if got == nil || got.ID != 9 || got.Currency != "EUR" {
		t.Fatalf("Get() = %#v, want EUR row", got)
	}
	if len(db.queryRowCalls) != 1 || !strings.Contains(db.queryRowCalls[0].sql, "id = $1") {
		t.Errorf("Get SQL = %#v, want id filter", db.queryRowCalls)
	}

	db.queryCalls = nil
	db.row = fakeRow{err: pgx.ErrNoRows}
	db.rows = &fakeRows{}
	options, err := store.ListOptionRows(context.Background())
	if err != nil {
		t.Fatalf("ListOptionRows() error = %v", err)
	}
	if len(options) != 0 {
		t.Errorf("ListOptionRows() = %#v, want empty", options)
	}
	if len(db.queryCalls) != 1 ||
		!strings.Contains(db.queryCalls[0].sql, "order by year_month desc, currency asc") {
		t.Errorf("options query = %#v, want FastAPI ordering", db.queryCalls)
	}
}

func TestExchangeRateStoreErrorsPropagate(t *testing.T) {
	wantErr := errors.New("query failed")
	db := &fakeDB{row: fakeRow{values: []any{0}}, rowsErr: wantErr}
	store := NewExchangeRateStore(db)

	if _, _, err := store.List(context.Background(), nil, nil, 1, 50); !errors.Is(err, wantErr) {
		t.Errorf("List() error = %v, want %v", err, wantErr)
	}
	if _, err := store.ListOptionRows(context.Background()); !errors.Is(err, wantErr) {
		t.Errorf("ListOptionRows() error = %v, want %v", err, wantErr)
	}
}

func TestSafeOffsetAvoidsIntegerOverflow(t *testing.T) {
	if got := safeOffset(maxIntTestValue, 200); got != math.MaxInt {
		t.Errorf("safeOffset(maxInt, 200) = %d, want MaxInt", got)
	}
	if got := safeOffset(3, 50); got != 100 {
		t.Errorf("safeOffset(3, 50) = %d, want 100", got)
	}
}

const maxIntTestValue = int(^uint(0) >> 1)

type queryCall struct {
	sql  string
	args []any
}

type queryRowCall struct {
	sql  string
	args []any
}

type fakeDB struct {
	rows          Rows
	rowsErr       error
	row           pgx.Row
	rowsQueue     []pgx.Row
	queryCalls    []queryCall
	queryRowCalls []queryRowCall
	pingErr       error
}

func (f *fakeDB) Query(_ context.Context, sql string, args ...any) (Rows, error) {
	f.queryCalls = append(f.queryCalls, queryCall{sql: sql, args: args})
	return f.rows, f.rowsErr
}

func (f *fakeDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	f.queryRowCalls = append(f.queryRowCalls, queryRowCall{sql: sql, args: args})
	if len(f.rowsQueue) > 0 {
		next := f.rowsQueue[0]
		f.rowsQueue = f.rowsQueue[1:]
		return next
	}
	return f.row
}

func (f *fakeDB) Ping(context.Context) error {
	return f.pingErr
}

type fakeRow struct {
	values []any
	err    error
}

func (r fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	return scanValues(dest, r.values)
}

type fakeRows struct {
	batches [][]any
	index   int
	err     error
	closed  bool
}

func (r *fakeRows) Next() bool {
	if r.index >= len(r.batches) {
		return false
	}
	r.index++
	return true
}

func (r *fakeRows) Scan(dest ...any) error {
	if r.index == 0 || r.index > len(r.batches) {
		if len(r.batches) == 1 {
			r.index = 1
		} else {
			return errors.New("scan called outside row")
		}
	}
	return scanValues(dest, r.batches[r.index-1])
}

func (r *fakeRows) Err() error {
	return r.err
}

func (r *fakeRows) Close() {
	r.closed = true
}

func scanValues(dest, values []any) error {
	if len(dest) != len(values) {
		return errors.New("scan destination count mismatch")
	}
	for i, value := range values {
		switch target := dest[i].(type) {
		case *int:
			number, ok := value.(int)
			if !ok {
				if int64Value, ok := value.(int64); ok {
					*target = int(int64Value)
					continue
				}
				return errors.New("scan value is not int")
			}
			*target = number
		case *int64:
			number, ok := value.(int64)
			if !ok {
				return errors.New("scan value is not int64")
			}
			*target = number
		case *string:
			text, ok := value.(string)
			if !ok {
				return errors.New("scan value is not string")
			}
			*target = text
		case *pgtype.Text:
			text, ok := value.(pgtype.Text)
			if !ok {
				return errors.New("scan value is not pgtype.Text")
			}
			*target = text
		case *pgtype.Numeric:
			number, ok := value.(pgtype.Numeric)
			if !ok {
				return errors.New("scan value is not pgtype.Numeric")
			}
			*target = number
		case *pgtype.Float8:
			number, ok := value.(pgtype.Float8)
			if !ok {
				return errors.New("scan value is not pgtype.Float8")
			}
			*target = number
		case *pgtype.Int4:
			number, ok := value.(pgtype.Int4)
			if !ok {
				return errors.New("scan value is not pgtype.Int4")
			}
			*target = number
		case *float64:
			number, ok := value.(float64)
			if !ok {
				return errors.New("scan value is not float64")
			}
			*target = number
		case *[]byte:
			bytes, ok := value.([]byte)
			if !ok {
				if value == nil {
					*target = nil
					continue
				}
				return errors.New("scan value is not []byte")
			}
			*target = bytes
		case *time.Time:
			timestamp, ok := value.(time.Time)
			if !ok {
				return errors.New("scan value is not time.Time")
			}
			*target = timestamp
		case *pgtype.Timestamptz:
			if value == nil {
				*target = pgtype.Timestamptz{}
				continue
			}
			timestamp, ok := value.(time.Time)
			if !ok {
				return errors.New("scan value is not time.Time")
			}
			*target = pgtype.Timestamptz{Time: timestamp, Valid: true}
		case *bool:
			boolean, ok := value.(bool)
			if !ok {
				return errors.New("scan value is not bool")
			}
			*target = boolean
		case **time.Time:
			if value == nil {
				*target = nil
				continue
			}
			timestamp, ok := value.(time.Time)
			if !ok {
				return errors.New("scan value is not time.Time")
			}
			*target = &timestamp
		default:
			return errors.New("unsupported scan destination: " + fmt.Sprintf("%T", dest[i]))
		}
	}
	return nil
}

func numericFromString(raw string) pgtype.Numeric {
	var number pgtype.Numeric
	if err := number.Scan(raw); err != nil {
		panic(err)
	}
	return number
}

func exchangeRateScanValues(id int64, yearMonth string) []any {
	return []any{
		id,
		"USD",
		pgtype.Text{String: "美元", Valid: true},
		yearMonth,
		numericFromString("7.10000000"),
		pgtype.Text{},
		[]byte(`[]`),
		time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC),
		time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC),
	}
}

func assertArgs(t *testing.T, got []any, want []any) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("args = %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("args[%d] = %#v, want %#v", i, got[i], want[i])
		}
	}
}

type errorAfterRow struct {
	failAfter int
	calls     int
}

func (r *errorAfterRow) Scan(dest ...any) error {
	r.calls++
	if r.calls <= r.failAfter {
		return pgx.ErrNoRows
	}
	return errors.New("stop")
}
