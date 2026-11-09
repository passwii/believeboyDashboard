package store

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/jobs"
)

func TestJobStoreCreateAndDetailScanJSONAndTimes(t *testing.T) {
	now := time.Date(2026, 11, 8, 8, 0, 0, 123000000, time.UTC)
	db := &fakeWriteDB{fakeDB: &fakeDB{
		row: fakeRow{values: []any{
			int64(9), "monthly_report", "pending", []byte(`{"job_type":"monthly_report","file_id":"f","params":{}}`),
			(*string)(nil), now, now,
		}},
	}}
	job, err := NewJobStore(db).CreateJob(context.Background(), jobsCreateInput(),
		nil)
	if err != nil {
		t.Fatal(err)
	}
	if job.ID != 9 || job.PayloadJSON["file_id"] != "f" ||
		job.CreatedAt == nil || *job.CreatedAt != "2026-11-08T08:00:00.123000Z" {
		t.Fatalf("job = %#v", job)
	}
	if len(db.execCalls) == 0 {
	}
}

func TestJobStoreLatestRunScansNullableFields(t *testing.T) {
	started := time.Now()
	db := &fakeDB{row: fakeRow{values: []any{
		int64(3), started, nil, (*string)(nil),
		(*string)(nil), (*string)(nil), (*string)(nil),
	}}}
	run, err := NewJobStore(&fakeWriteDB{fakeDB: db}).LatestRun(context.Background(), 9)
	if err != nil || run == nil || run.StartedAt == nil || run.FinishedAt != nil {
		t.Fatalf("run = %#v err=%v", run, err)
	}
}

func TestJobStoreMarkEnqueueFailedWritesJobAndRun(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{}}
	err := NewJobStore(db).MarkEnqueueFailed(context.Background(), 9, "redis down")
	if err != nil {
		t.Fatal(err)
	}
	if len(db.execCalls) != 2 {
		t.Fatalf("exec calls = %d", len(db.execCalls))
	}
	if !strings.Contains(db.execCalls[0].sql, "status = 'failed'") ||
		!strings.Contains(db.execCalls[1].sql, "INSERT INTO public.job_runs") {
		t.Errorf("calls = %#v", db.execCalls)
	}
}

func jobsCreateInput() jobs.CreateInput {
	return jobs.CreateInput{JobType: "monthly_report", FileID: "f", Params: map[string]any{}}
}
