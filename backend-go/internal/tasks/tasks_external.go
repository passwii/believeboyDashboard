package tasks

import (
	"context"
	"errors"
	"fmt"

	"github.com/hibiken/asynq"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
)

func (handler *TaskHandler) HandleBuildMonthlyReportPreview(ctx context.Context, task *asynq.Task) error {
	return handler.runSafely("app.celery_tasks.monthly_report_preview.build_monthly_report_preview", func() error {
		var payload MonthlyReportPreviewPayload
		if err := handler.decodePayload(task, &payload); err != nil {
			return err
		}
		if err := payload.Validate(); err != nil {
			return err
		}
		if handler.config.MonthlyReportBuildExecutor == nil {
			return fmt.Errorf("%w: monthly report build executor", ErrDependencyNotConfigured)
		}
		result, err := handler.config.MonthlyReportBuildExecutor.ExecuteBuild(ctx, payload.BuildID)
		if err != nil {
			return fmt.Errorf("execute monthly report build: %w", err)
		}
		return handler.writeResult(task, taskResult{
			TaskType: "app.celery_tasks.monthly_report_preview.build_monthly_report_preview",
			Status:   "completed",
			Data:     result,
		})
	})
}

func (handler *TaskHandler) HandleAgentMonthlyReportCleanup(ctx context.Context, task *asynq.Task) error {
	return handler.handleAgentMonthlyReportCleanup(ctx, task)
}

func (handler *TaskHandler) HandleGenerateInsight(ctx context.Context, task *asynq.Task) error {
	return handler.runSafely("generate_insight", func() error {
		var payload GenerateInsightPayload
		if err := handler.decodePayload(task, &payload); err != nil {
			return err
		}
		if err := payload.Validate(); err != nil {
			return err
		}
		// RunScheduleNow creates the insight row first and then enqueues both ids.
		// The insight id must win: GenerateSchedule would create a second row and
		// leave the pre-created insight pending forever. Only schedule-only jobs
		// may create a scheduled insight.
		if payload.InsightID != nil {
			if handler.config.InsightGenerator != nil {
				result, err := handler.config.InsightGenerator.Generate(ctx, *payload.InsightID)
				if err != nil {
					return fmt.Errorf("generate insight %d: %w", *payload.InsightID, err)
				}
				return handler.writeResult(task, taskResult{
					TaskType: "generate_insight",
					Status:   "completed",
					Data:     result,
				})
			}
			return handler.execute(ctx, task, "generate_insight", &payload)
		}
		if payload.ScheduleID != nil {
			generator, ok := handler.config.InsightGenerator.(ai_insight.ScheduleGenerator)
			if !ok || generator == nil {
				return fmt.Errorf(
					"%w: schedule insight generator",
					ErrDependencyNotConfigured,
				)
			}
			result, err := generator.GenerateSchedule(ctx, *payload.ScheduleID)
			if err != nil {
				if errors.Is(err, ai_insight.ErrDomainMigrated) {
					return handler.writeResult(task, taskResult{
						TaskType: "generate_insight",
						Status:   "skipped",
						Reason:   "domain_migrated",
						Data: map[string]any{
							"schedule_id": *payload.ScheduleID,
						},
					})
				}
				return fmt.Errorf(
					"generate insight schedule %d: %w",
					*payload.ScheduleID,
					err,
				)
			}
			return handler.writeResult(task, taskResult{
				TaskType: "generate_insight",
				Status:   "completed",
				Data:     result,
			})
		}
		return handler.execute(ctx, task, "generate_insight", &payload)
	})
}

func (handler *TaskHandler) HandleExecuteInsightRun(ctx context.Context, task *asynq.Task) error {
	return handler.runSafely("execute_insight_run", func() error {
		var payload ExecuteInsightRunPayload
		if err := handler.decodePayload(task, &payload); err != nil {
			return err
		}
		if err := payload.Validate(); err != nil {
			return err
		}
		if handler.config.InsightRunExecutor != nil {
			if err := handler.config.InsightRunExecutor.Execute(
				ctx,
				payload.RunID,
				payload.Attempt,
			); err != nil {
				return fmt.Errorf("execute insight run %s: %w", payload.RunID, err)
			}
			return handler.writeResult(task, taskResult{
				TaskType: "execute_insight_run",
				Status:   "completed",
				Data: map[string]any{
					"run_id":  payload.RunID,
					"attempt": payload.Attempt,
				},
			})
		}
		return handler.execute(ctx, task, "execute_insight_run", &payload)
	})
}

func (handler *TaskHandler) HandleDispatchOne(ctx context.Context, task *asynq.Task) error {
	return handler.runSafely("dispatch_one", func() error {
		var payload DispatchOnePayload
		if err := handler.decodePayload(task, &payload); err != nil {
			return err
		}
		if err := payload.Validate(); err != nil {
			return err
		}
		if payload.TriggeredBy == "" {
			payload.TriggeredBy = "auto"
		}
		payload.UseCache = boolPointer(boolValue(payload.UseCache, true))
		return handler.execute(ctx, task, "dispatch_one", &payload)
	})
}

func (handler *TaskHandler) HandleGenerateDeliverySummary(ctx context.Context, task *asynq.Task) error {
	return handler.runSafely("generate_delivery_summary", func() error {
		var payload GenerateDeliverySummaryPayload
		if err := handler.decodePayload(task, &payload); err != nil {
			return err
		}
		if err := payload.Validate(); err != nil {
			return err
		}
		return handler.execute(ctx, task, "generate_delivery_summary", &payload)
	})
}

func boolPointer(value bool) *bool {
	return &value
}
