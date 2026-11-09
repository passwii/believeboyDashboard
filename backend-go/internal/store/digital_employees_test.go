package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/digital_employees"
)

func TestDigitalEmployeeStoreScanEmployee(t *testing.T) {
	avatar := "https://example.test/avatar.png"
	description := "守护数据库"
	heartbeat := time.Date(2026, 11, 8, 10, 11, 12, 123456000, time.UTC)
	created := time.Date(2026, 11, 1, 1, 2, 3, 0, time.UTC)
	updated := time.Date(2026, 11, 7, 4, 5, 6, 789000000, time.UTC)
	item, err := scanDigitalEmployee(digitalFlexibleRow{values: []any{
		int64(7),
		"数据库守护者",
		pgtype.Text{String: avatar, Valid: true},
		"database",
		"idle",
		pgtype.Text{String: description, Valid: true},
		&heartbeat,
		30,
		created,
		updated,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if item.ID != 7 ||
		item.Name != "数据库守护者" ||
		item.AvatarURL == nil ||
		*item.AvatarURL != avatar ||
		item.Description == nil ||
		*item.Description != description {
		t.Fatalf("employee = %#v", item)
	}
	if item.LastHeartbeatAt == nil || *item.LastHeartbeatAt != "2026-11-08T10:11:12.123456Z" {
		t.Errorf("last heartbeat = %v", item.LastHeartbeatAt)
	}
	if item.CreatedAt != "2026-11-01T01:02:03Z" ||
		item.UpdatedAt != "2026-11-07T04:05:06.789000Z" {
		t.Errorf("timestamps = %q / %q", item.CreatedAt, item.UpdatedAt)
	}

	item, err = scanDigitalEmployee(digitalFlexibleRow{values: []any{
		int64(8),
		"空员工",
		pgtype.Text{},
		"custom",
		"idle",
		pgtype.Text{},
		nil,
		30,
		created,
		created,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if item.AvatarURL != nil || item.Description != nil || item.LastHeartbeatAt != nil {
		t.Fatalf("nullable fields = %#v", item)
	}
}

func TestDigitalEmployeeStoreScanTaskAndLog(t *testing.T) {
	started := time.Date(2026, 11, 8, 9, 0, 0, 0, time.UTC)
	created := time.Date(2026, 11, 8, 8, 59, 0, 0, time.UTC)
	step := "数据识别"
	task, err := scanDigitalEmployeeTask(digitalFlexibleRow{values: []any{
		int64(12),
		"task-12",
		"Payment Report",
		"payment_report",
		"succeeded",
		100,
		pgtype.Text{String: step, Valid: true},
		&started,
		&started,
		pgtype.Text{},
		pgtype.Text{String: `{"project_name":"润茗","report_label":"Payment"}`, Valid: true},
		created,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if task.CurrentStep == nil || *task.CurrentStep != step ||
		task.StartedAt == nil || *task.StartedAt != "2026-11-08T09:00:00Z" ||
		task.MetadataJSON["project_name"] != "润茗" {
		t.Fatalf("task = %#v", task)
	}

	taskID := int64(12)
	logItem, err := scanDigitalEmployeeLog(digitalFlexibleRow{values: []any{
		int64(33),
		&taskID,
		"info",
		"done",
		created,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if logItem.TaskID == nil || *logItem.TaskID != 12 ||
		logItem.CreatedAt != "2026-11-08T08:59:00Z" {
		t.Fatalf("log = %#v", logItem)
	}
}

func TestDigitalEmployeeStoreListLogsCursorSQLAndScan(t *testing.T) {
	ctx := context.Background()
	created := time.Date(2026, 11, 8, 8, 0, 0, 0, time.UTC)
	db := &fakeDB{
		rowsQueue: []pgx.Row{
			digitalFlexibleRow{values: digitalEmployeeTaskScanValues(created)},
		},
		rowsQueueQuery: []Rows{
			&digitalFlexibleRows{batches: [][]any{
				{int64(8), int64(12), "info", "first", created},
				{int64(9), int64(12), "warn", "second", created},
			}},
		},
	}
	store := NewDigitalEmployeeStore(&fakeWriteDB{fakeDB: db})
	cursor := int64(7)
	items, hasMore, nextCursor, err := store.ListLogs(ctx, 3, 12, &cursor, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || hasMore || nextCursor == nil || *nextCursor != 9 {
		t.Fatalf("logs = %#v hasMore=%v cursor=%v", items, hasMore, nextCursor)
	}
	if len(db.queryCalls) != 1 {
		t.Fatalf("query calls = %d, want 1", len(db.queryCalls))
	}
	if !assertWriteArgsEqual(db.queryCalls[0].args, []any{int64(12), int64(7), 3}) {
		t.Errorf("args = %#v", db.queryCalls[0].args)
	}
}

func TestDigitalEmployeeStoreHeartbeatRejectsWrongSecret(t *testing.T) {
	ctx := context.Background()
	db := &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{"stored-secret", "idle"}},
		},
	}
	store := NewDigitalEmployeeStore(&fakeWriteDB{fakeDB: db})
	secret := "wrong-secret"
	_, err := store.Heartbeat(ctx, digital_employees.HeartbeatInput{
		EmployeeID: 3,
		APISecret:  &secret,
	}, time.Date(2026, 11, 8, 10, 0, 0, 0, time.UTC))
	if !errors.Is(err, digital_employees.ErrInvalidAPISecret) {
		t.Fatalf("error = %v, want ErrInvalidAPISecret", err)
	}
}

func digitalEmployeeTaskScanValues(created time.Time) []any {
	started := created.Add(time.Minute)
	return []any{
		int64(12),
		"task-12",
		"Payment Report",
		"payment_report",
		"running",
		42,
		pgtype.Text{String: "拉取数据", Valid: true},
		&started,
		nil,
		pgtype.Text{},
		pgtype.Text{String: `{"project_name":"润茗"}`, Valid: true},
		created,
	}
}

type digitalFlexibleRow struct {
	values []any
	err    error
}

func (r digitalFlexibleRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	return digitalScanValues(dest, r.values)
}

type digitalFlexibleRows struct {
	batches [][]any
	index   int
	err     error
	closed  bool
}

func (r *digitalFlexibleRows) Next() bool {
	if r.index >= len(r.batches) {
		return false
	}
	r.index++
	return true
}

func (r *digitalFlexibleRows) Scan(dest ...any) error {
	if r.index == 0 || r.index > len(r.batches) {
		return errors.New("scan called outside row")
	}
	return digitalScanValues(dest, r.batches[r.index-1])
}

func (r *digitalFlexibleRows) Err() error {
	return r.err
}

func (r *digitalFlexibleRows) Close() {
	r.closed = true
}

func digitalScanValues(dest, values []any) error {
	if len(dest) != len(values) {
		return errors.New("scan destination count mismatch")
	}
	for index, value := range values {
		switch target := dest[index].(type) {
		case *int64:
			number, ok := value.(int64)
			if !ok {
				return errors.New("scan value is not int64")
			}
			*target = number
		case *int:
			number, ok := value.(int)
			if !ok {
				return errors.New("scan value is not int")
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
		case *time.Time:
			timestamp, ok := value.(time.Time)
			if !ok {
				return errors.New("scan value is not time.Time")
			}
			*target = timestamp
		case **time.Time:
			if value == nil {
				*target = nil
				continue
			}
			if timestamp, ok := value.(*time.Time); ok {
				*target = timestamp
				continue
			}
			return errors.New("scan value is not *time.Time")
		case **int64:
			if value == nil {
				*target = nil
				continue
			}
			switch typed := value.(type) {
			case int64:
				*target = &typed
			case *int64:
				*target = typed
			default:
				return errors.New("scan value is not int64 or *int64")
			}
		default:
			return errors.New("unsupported scan destination")
		}
	}
	return nil
}
