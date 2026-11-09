package tasks

import (
	"context"
	"errors"
	"testing"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
)

type insightGeneratorOnly struct {
	generateCalls int
	generateID    int64
	result        ai_insight.GenerationResult
	err           error
}

func (generator *insightGeneratorOnly) Generate(
	_ context.Context,
	insightID int64,
) (ai_insight.GenerationResult, error) {
	generator.generateCalls++
	generator.generateID = insightID
	return generator.result, generator.err
}

type insightScheduleGenerator struct {
	generateCalls int
	generateID    int64
	scheduleCalls int
	scheduleID    int64
	result        ai_insight.GenerationResult
	generateErr   error
	scheduleErr   error
}

func (generator *insightScheduleGenerator) Generate(
	_ context.Context,
	insightID int64,
) (ai_insight.GenerationResult, error) {
	generator.generateCalls++
	generator.generateID = insightID
	return generator.result, generator.generateErr
}

func (generator *insightScheduleGenerator) GenerateSchedule(
	_ context.Context,
	scheduleID int64,
) (ai_insight.GenerationResult, error) {
	generator.scheduleCalls++
	generator.scheduleID = scheduleID
	return generator.result, generator.scheduleErr
}

func TestScheduleInsightUsesScheduleGeneratorWithoutExecutorFallback(t *testing.T) {
	generator := &insightScheduleGenerator{
		result: ai_insight.GenerationResult{Title: "title", Content: "content"},
	}
	fallback := &remediationExecutor{result: map[string]any{"unexpected": true}}
	handler := NewTaskHandlerWithDB(&remediationDB{}, HandlerConfig{
		InsightGenerator: generator,
		Executor:         fallback,
	})
	task := remediationTask(t, queue.TypeGenerateInsight, GenerateInsightPayload{
		ScheduleID: remediationInt64Pointer(17),
	})

	if err := handler.HandleGenerateInsight(context.Background(), task); err != nil {
		t.Fatalf("HandleGenerateInsight() error = %v", err)
	}
	if generator.scheduleCalls != 1 || generator.scheduleID != 17 {
		t.Fatalf(
			"GenerateSchedule calls=%d scheduleID=%d, want 1/17",
			generator.scheduleCalls,
			generator.scheduleID,
		)
	}
	if generator.generateCalls != 0 {
		t.Fatalf("Generate calls = %d, want 0", generator.generateCalls)
	}
	if fallback.calls != 0 {
		t.Fatalf("fallback Executor calls = %d, want 0", fallback.calls)
	}
}

func TestScheduleInsightFailsClosedWithoutScheduleGenerator(t *testing.T) {
	generator := &insightGeneratorOnly{}
	fallback := &remediationExecutor{result: map[string]any{"unexpected": true}}
	handler := NewTaskHandlerWithDB(&remediationDB{}, HandlerConfig{
		InsightGenerator: generator,
		Executor:         fallback,
	})
	task := remediationTask(t, queue.TypeGenerateInsight, GenerateInsightPayload{
		ScheduleID: remediationInt64Pointer(18),
	})

	err := handler.HandleGenerateInsight(context.Background(), task)
	if !errors.Is(err, ErrDependencyNotConfigured) {
		t.Fatalf("HandleGenerateInsight() error = %v, want ErrDependencyNotConfigured", err)
	}
	if generator.generateCalls != 0 {
		t.Fatalf("Generate calls = %d, want 0", generator.generateCalls)
	}
	if fallback.calls != 0 {
		t.Fatalf("fallback Executor calls = %d, want 0", fallback.calls)
	}
}

func TestScheduleInsightDomainMigratedIsSkipped(t *testing.T) {
	generator := &insightScheduleGenerator{
		scheduleErr: ai_insight.ErrDomainMigrated,
	}
	handler := NewTaskHandlerWithDB(&remediationDB{}, HandlerConfig{
		InsightGenerator: generator,
	})
	task := remediationTask(t, queue.TypeGenerateInsight, GenerateInsightPayload{
		ScheduleID: remediationInt64Pointer(19),
	})

	if err := handler.HandleGenerateInsight(context.Background(), task); err != nil {
		t.Fatalf("HandleGenerateInsight() error = %v, want migrated skip", err)
	}
	if generator.scheduleCalls != 1 || generator.scheduleID != 19 {
		t.Fatalf(
			"GenerateSchedule calls=%d scheduleID=%d, want 1/19",
			generator.scheduleCalls,
			generator.scheduleID,
		)
	}
}

func TestScheduleInsightPropagatesGeneratorError(t *testing.T) {
	sentinel := errors.New("schedule generation failed")
	generator := &insightScheduleGenerator{scheduleErr: sentinel}
	handler := NewTaskHandlerWithDB(&remediationDB{}, HandlerConfig{
		InsightGenerator: generator,
	})
	task := remediationTask(t, queue.TypeGenerateInsight, GenerateInsightPayload{
		ScheduleID: remediationInt64Pointer(20),
	})

	err := handler.HandleGenerateInsight(context.Background(), task)
	if !errors.Is(err, sentinel) {
		t.Fatalf("HandleGenerateInsight() error = %v, want propagated error", err)
	}
}
