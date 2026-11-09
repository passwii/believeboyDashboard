package contract

import (
	"testing"

	"github.com/passwii/believeboyDashboard/backend-go/internal/scheduler"
)

func TestStage6BContractScheduleMappingAndRegistration(t *testing.T) {
	want := []scheduler.JobSpec{
		{Name: "crm-sea-reclaim", CronExpr: "0 3 * * *", TaskName: "crm_sea_reclaim"},
		{Name: "return-analysis-refresh-daily", CronExpr: "0 3 * * *", TaskName: "return_analysis.refresh_daily"},
		{Name: "ai-chat-token-usage-refresh-daily", CronExpr: "15 3 * * *", TaskName: "ai_chat_token_usage.refresh_daily"},
		{Name: "agent-api-audit-cleanup", CronExpr: "0 4 * * *", TaskName: "agent_api_audit_cleanup"},
		{Name: "operation-audit-cleanup", CronExpr: "30 4 * * *", TaskName: "operation_audit_cleanup"},
		{Name: "crm-follow-up-reminder", CronExpr: "0 9 * * *", TaskName: "crm_follow_up_reminder"},
		{Name: "crm-rule-engine", CronExpr: "5 9 * * *", TaskName: "crm_rule_engine"},
		{Name: "crm-stale-email", CronExpr: "10 9 * * *", TaskName: "crm_stale_email"},
		{Name: "crm-task-reminder", CronExpr: "5 * * * *", TaskName: "crm_task_reminder"},
		{Name: "agent-monthly-report-cleanup", CronExpr: "20 * * * *", TaskName: "agent_monthly_report_cleanup"},
		{Name: "alert-detect", CronExpr: "*/15 * * * *", TaskName: "alert_detect"},
	}

	gotSpecs := scheduler.StandardJobs()
	if len(gotSpecs) != len(want) {
		t.Fatalf("StandardJobs() length = %d, want %d", len(gotSpecs), len(want))
	}
	for i := range want {
		if gotSpecs[i] != want[i] {
			t.Fatalf("StandardJobs()[%d] = %+v, want %+v", i, gotSpecs[i], want[i])
		}
	}

	s := scheduler.New()
	scheduler.RegisterStandardJobs(
		s,
		scheduler.TaskEnqueuerFunc(func(string) error { return nil }),
		scheduler.NewMemoryLocker(),
	)

	gotJobs := s.ListJobs()
	if len(gotJobs) != len(want) {
		t.Fatalf("ListJobs() length = %d, want %d", len(gotJobs), len(want))
	}
	for i := range want {
		if gotJobs[i].Name != want[i].Name {
			t.Fatalf("ListJobs()[%d].Name = %q, want %q", i, gotJobs[i].Name, want[i].Name)
		}
		if gotJobs[i].CronExpr != want[i].CronExpr {
			t.Fatalf("ListJobs()[%d].CronExpr = %q, want %q", i, gotJobs[i].CronExpr, want[i].CronExpr)
		}
		if gotJobs[i].TaskName != want[i].TaskName {
			t.Fatalf("ListJobs()[%d].TaskName = %q, want %q", i, gotJobs[i].TaskName, want[i].TaskName)
		}
		if gotJobs[i].NextRun.IsZero() {
			t.Fatalf("ListJobs()[%d].NextRun is zero", i)
		}
	}
}
