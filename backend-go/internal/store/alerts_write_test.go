package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/alerts"
)

func TestAlertStoreCreateRuleReturnsPersistedRule(t *testing.T) {
	createdAt := time.Date(2026, 11, 7, 1, 2, 3, 0, time.UTC)
	db := &fakeWriteDB{fakeDB: &fakeDB{row: fakeRow{values: alertRuleScanValues(5, createdAt)}}}
	input := alerts.Rule{
		Name:                 "high ACOS",
		ProjectID:            3,
		Country:              "US",
		Metric:               "acos",
		TriggerType:          "threshold",
		Condition:            "above",
		Threshold:            0.25,
		WindowDays:           7,
		Severity:             "warning",
		NotificationChannels: "in_app",
		IsActive:             true,
		CreatedBy:            "operator",
	}

	got, err := NewAlertStore(db).CreateRule(context.Background(), input)
	if err != nil {
		t.Fatalf("CreateRule() error = %v", err)
	}
	if got == nil || got.ID != 5 || got.Name != input.Name || got.CreatedBy != input.CreatedBy {
		t.Fatalf("CreateRule() = %#v, want persisted rule", got)
	}
	if len(db.queryRowCalls) != 1 ||
		!strings.Contains(strings.ToLower(db.queryRowCalls[0].sql), "insert into public.alert_rules") ||
		!strings.Contains(strings.ToLower(db.queryRowCalls[0].sql), "returning") {
		t.Fatalf("QueryRow() = %#v, want alert-rule INSERT RETURNING", db.queryRowCalls)
	}
	if got := db.queryRowCalls[0].args; len(got) != 12 || got[0] != input.Name ||
		got[1] != input.ProjectID || got[11] != input.CreatedBy {
		t.Errorf("CreateRule args = %#v, want rule fields", got)
	}
}

func TestAlertStoreGetAndUpdateRule(t *testing.T) {
	createdAt := time.Date(2026, 11, 7, 1, 2, 3, 0, time.UTC)
	db := &fakeWriteDB{fakeDB: &fakeDB{
		row: fakeRow{values: alertRuleScanValues(5, createdAt)},
	}}
	store := NewAlertStore(db)
	got, err := store.GetRule(context.Background(), 5)
	if err != nil || got == nil || got.ID != 5 {
		t.Fatalf("GetRule() = %#v, %v, want rule 5", got, err)
	}
	if len(db.queryRowCalls) != 1 || !strings.Contains(strings.ToLower(db.queryRowCalls[0].sql), "where id = $1") {
		t.Fatalf("GetRule SQL = %#v, want id lookup", db.queryRowCalls)
	}

	db.queryRowCalls = nil
	name := "updated rule"
	active := false
	db.row = fakeRow{values: alertRuleScanValues(5, createdAt)}
	got, err = store.UpdateRule(context.Background(), 5, alerts.RuleUpdate{Name: &name, IsActive: &active})
	if err != nil || got == nil {
		t.Fatalf("UpdateRule() = %#v, %v, want updated rule", got, err)
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "update public.alert_rules") ||
		!strings.Contains(query, "updated_at = now()") ||
		!strings.Contains(query, "returning") {
		t.Errorf("UpdateRule SQL = %s, want patch update and returned row", query)
	}
	if args := db.queryRowCalls[0].args; len(args) != 10 || args[0] != int64(5) ||
		args[1] != &name || args[9] != &active {
		t.Errorf("UpdateRule args = %#v, want id and nullable patch fields", args)
	}
}

func TestAlertStoreDeleteRuleAndAcknowledgeResolveEvents(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{}, execTag: pgconn.NewCommandTag("DELETE 1")}
	deleted, err := NewAlertStore(db).DeleteRule(context.Background(), 6)
	if err != nil || !deleted {
		t.Fatalf("DeleteRule() = %v, %v, want true", deleted, err)
	}

	createdAt := time.Date(2026, 11, 7, 1, 2, 3, 0, time.UTC)
	eventValues := alertEventScanValues(8, createdAt)
	db.row = fakeRow{values: eventValues}
	event, err := NewAlertStore(db).GetEvent(context.Background(), 8)
	if err != nil || event == nil || event.ID != 8 {
		t.Fatalf("GetEvent() = %#v, %v, want event 8", event, err)
	}

	db.queryRowCalls = nil
	operator := "operator-a"
	db.row = fakeRow{values: alertEventScanValues(8, createdAt)}
	event, err = NewAlertStore(db).AcknowledgeEvent(context.Background(), 8, &operator)
	if err != nil || event == nil {
		t.Fatalf("AcknowledgeEvent() = %#v, %v", event, err)
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "status = 'acknowledged'") ||
		!strings.Contains(query, "acknowledged_at = now()") ||
		!strings.Contains(query, "acknowledged_by = $2") {
		t.Errorf("AcknowledgeEvent SQL = %s, want status and acknowledgement fields", query)
	}
	if !assertWriteArgsEqual(db.queryRowCalls[0].args, []any{int64(8), &operator}) {
		t.Errorf("AcknowledgeEvent args = %#v, want id and operator", db.queryRowCalls[0].args)
	}

	db.queryRowCalls = nil
	db.row = fakeRow{values: alertEventScanValues(8, createdAt)}
	event, err = NewAlertStore(db).ResolveEvent(context.Background(), 8)
	if err != nil || event == nil {
		t.Fatalf("ResolveEvent() = %#v, %v", event, err)
	}
	if query := strings.ToLower(db.queryRowCalls[0].sql); !strings.Contains(query, "status = 'resolved'") {
		t.Errorf("ResolveEvent SQL = %s, want resolved status", query)
	}
}

func TestAlertStoreMissingRowsAndWriteErrors(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}}
	store := NewAlertStore(db)
	if got, err := store.GetRule(context.Background(), 1); err != nil || got != nil {
		t.Errorf("GetRule() = %#v, %v, want missing nil", got, err)
	}
	if got, err := store.UpdateRule(context.Background(), 1, alerts.RuleUpdate{}); err != nil || got != nil {
		t.Errorf("UpdateRule() = %#v, %v, want missing nil", got, err)
	}
	if got, err := store.GetEvent(context.Background(), 1); err != nil || got != nil {
		t.Errorf("GetEvent() = %#v, %v, want missing nil", got, err)
	}
	if got, err := store.AcknowledgeEvent(context.Background(), 1, nil); err != nil || got != nil {
		t.Errorf("AcknowledgeEvent() = %#v, %v, want missing nil", got, err)
	}
	if got, err := store.ResolveEvent(context.Background(), 1); err != nil || got != nil {
		t.Errorf("ResolveEvent() = %#v, %v, want missing nil", got, err)
	}

	wantErr := errors.New("database unavailable")
	db = &fakeWriteDB{fakeDB: &fakeDB{row: fakeRow{err: wantErr}}, execErr: wantErr}
	store = NewAlertStore(db)
	if _, err := store.CreateRule(context.Background(), alerts.Rule{}); !errors.Is(err, wantErr) {
		t.Errorf("CreateRule() error = %v, want %v", err, wantErr)
	}
	if _, err := store.DeleteRule(context.Background(), 1); !errors.Is(err, wantErr) {
		t.Errorf("DeleteRule() error = %v, want %v", err, wantErr)
	}
}

func alertRuleScanValues(id int64, timestamp time.Time) []any {
	return []any{
		id, "high ACOS", int64(3), "US", "acos", "threshold", "above",
		float64(0.25), 7, "warning", "in_app", true, "operator", timestamp, timestamp,
	}
}

func alertEventScanValues(id int64, timestamp time.Time) []any {
	return []any{
		id, int64(5), int64(3), "acos", float64(1.2), float64(1), float64(20),
		"warning", "message", "active", timestamp, nil, pgtype.Text{},
		pgtype.Float8{}, pgtype.Int4{}, pgtype.Float8{}, pgtype.Text{}, pgtype.Int4{},
	}
}
