package scheduler

import "fmt"

// TaskEnqueuer dispatches a Celery-compatible task name to the Go task queue.
type TaskEnqueuer interface {
	Enqueue(taskName string) error
}

// TaskEnqueuerFunc adapts a function to TaskEnqueuer.
type TaskEnqueuerFunc func(taskName string) error

// Enqueue implements TaskEnqueuer.
func (f TaskEnqueuerFunc) Enqueue(taskName string) error {
	if f == nil {
		return fmt.Errorf("task enqueuer is nil")
	}
	return f(taskName)
}

// JobSpec maps a Beat schedule name to its cron expression and task name.
type JobSpec struct {
	Name     string
	CronExpr string
	TaskName string
}

var standardJobs = []JobSpec{
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

// StandardJobs returns a copy of the 11 Celery Beat-compatible schedules.
func StandardJobs() []JobSpec {
	jobs := make([]JobSpec, len(standardJobs))
	copy(jobs, standardJobs)
	return jobs
}

// StandardJobSpecs is an explicit alias used by integration code.
func StandardJobSpecs() []JobSpec {
	return StandardJobs()
}

// RegisterStandardJobs registers all Beat-compatible schedules. Registration
// errors indicate invalid built-in configuration and therefore panic.
func RegisterStandardJobs(s *Scheduler, enqueuer TaskEnqueuer, locker Locker) {
	if s == nil {
		panic("scheduler is nil")
	}
	if enqueuer == nil {
		panic("task enqueuer is nil")
	}
	s.SetLocker(locker)

	for _, spec := range StandardJobs() {
		spec := spec
		command := func() error {
			if err := enqueuer.Enqueue(spec.TaskName); err != nil {
				return fmt.Errorf("enqueue %s: %w", spec.TaskName, err)
			}
			return nil
		}
		if err := s.addJob(spec.Name, spec.CronExpr, spec.TaskName, command); err != nil {
			panic(fmt.Sprintf("register standard scheduler job %s: %v", spec.Name, err))
		}
	}
}
