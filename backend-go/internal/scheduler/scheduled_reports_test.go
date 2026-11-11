package scheduler

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/scheduled_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/tasks"
)

type fakeScheduledReportSource struct {
	subscriptions []scheduled_reports.Subscription
	err           error
	receivedNow   time.Time
}

func (source *fakeScheduledReportSource) ListDueSubscriptions(
	_ context.Context,
	now time.Time,
) ([]scheduled_reports.Subscription, error) {
	source.receivedNow = now
	return source.subscriptions, source.err
}

type fakeScheduledReportEnqueuer struct {
	payloads []tasks.DispatchOnePayload
	delays   []time.Duration
	err      error
}

func (enqueuer *fakeScheduledReportEnqueuer) EnqueueScheduledReport(
	_ context.Context,
	payload tasks.DispatchOnePayload,
	delay time.Duration,
) error {
	enqueuer.payloads = append(enqueuer.payloads, payload)
	enqueuer.delays = append(enqueuer.delays, delay)
	return enqueuer.err
}

func stringPtr(value string) *string { return &value }

func TestScanDueScheduledReportsEnqueuesPayloads(t *testing.T) {
	now := time.Date(2026, 11, 11, 15, 30, 0, 0, time.FixedZone("CST", 8*3600))
	source := &fakeScheduledReportSource{
		subscriptions: []scheduled_reports.Subscription{
			{
				ID:             7,
				Email:          stringPtr("ops@example.com"),
				ProjectIDs:     "1,2",
				Country:        "US",
				Frequency:      "daily",
				DispatchHour:   15,
				DispatchMinute: 30,
				AIModel:        stringPtr("model-a"),
			},
			{
				ID:         8,
				ProjectIDs: "*",
				Country:    "DE",
				Frequency:  "weekly",
			},
		},
	}
	enqueuer := &fakeScheduledReportEnqueuer{}

	result, err := ScanDueScheduledReports(context.Background(), now, source, enqueuer, nil)
	if err != nil {
		t.Fatalf("ScanDueScheduledReports() error = %v", err)
	}
	if source.receivedNow != now {
		t.Errorf("source now = %v, want %v", source.receivedNow, now)
	}
	if result.Due != 2 || result.Enqueued != 1 || result.Skipped != 1 {
		t.Fatalf("result = %#v, want due=2 enqueued=1 skipped=1", result)
	}
	if len(enqueuer.payloads) != 1 {
		t.Fatalf("payloads = %d, want 1", len(enqueuer.payloads))
	}
	payload := enqueuer.payloads[0]
	if payload.SubscriptionID != 7 || payload.Email != "ops@example.com" ||
		len(payload.ProjectIDs) != 2 || payload.ProjectIDs[0] != 1 || payload.ProjectIDs[1] != 2 ||
		payload.Country != "US" || payload.Frequency != "daily" ||
		payload.AIModel == nil || *payload.AIModel != "model-a" ||
		payload.UseCache == nil || !*payload.UseCache ||
		payload.TriggeredBy != "auto" || payload.ReportDate != "2026-11-11" {
		t.Fatalf("payload = %#v", payload)
	}
	if enqueuer.delays[0] != 0 {
		t.Errorf("first delay = %v, want 0", enqueuer.delays[0])
	}
}

func TestScanDueScheduledReportsPropagatesSourceError(t *testing.T) {
	source := &fakeScheduledReportSource{err: errors.New("db down")}
	if _, err := ScanDueScheduledReports(context.Background(), time.Now(), source, &fakeScheduledReportEnqueuer{}, nil); err == nil {
		t.Fatal("error = nil, want source error")
	}
}

func TestParseScheduledReportProjectIDs(t *testing.T) {
	cases := []struct {
		raw  string
		want []int64
		err  bool
	}{
		{"*", nil, false},
		{"", nil, false},
		{"1, 2,3", []int64{1, 2, 3}, false},
		{"abc", nil, true},
	}
	for _, testCase := range cases {
		got, err := ParseScheduledReportProjectIDs(testCase.raw)
		if testCase.err {
			if err == nil {
				t.Errorf("ParseScheduledReportProjectIDs(%q) error = nil, want error", testCase.raw)
			}
			continue
		}
		if err != nil {
			t.Errorf("ParseScheduledReportProjectIDs(%q) error = %v", testCase.raw, err)
			continue
		}
		if len(got) != len(testCase.want) {
			t.Errorf("ParseScheduledReportProjectIDs(%q) = %v, want %v", testCase.raw, got, testCase.want)
		}
	}
}
