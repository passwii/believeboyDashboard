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


func TestInsightIDTakesPrecedenceOverScheduleID(t *testing.T) {
	generator := &insightScheduleGenerator{
		result: ai_insight.GenerationResult{Title: "title", Content: "content"},
	}
	fallback := &remediationExecutor{result: map[string]any{"unexpected": true}}
	handler := NewTaskHandlerWithDB(&remediationDB{}, HandlerConfig{
		InsightGenerator: generator,
		Executor:         fallback,
	})
	// RunScheduleNow pre-creates the insight row and enqueues both ids; the
	// pre-created insight must be generated in place, never duplicated.
	task := remediationTask(t, queue.TypeGenerateInsight, GenerateInsightPayload{
		ScheduleID: remediationInt64Pointer(17),
		InsightID:  remediationInt64Pointer(33),
	})

	if err := handler.HandleGenerateInsight(context.Background(), task); err != nil {
		t.Fatalf("HandleGenerateInsight() error = %v", err)
	}
	if generator.generateCalls != 1 || generator.generateID != 33 {
		t.Fatalf(
			"Generate calls=%d insightID=%d, want 1/33",
			generator.generateCalls,
			generator.generateID,
		)
	}
	if generator.scheduleCalls != 0 {
		t.Fatalf(
			"GenerateSchedule calls = %d, want 0 (it would create a second insight row)",
			generator.scheduleCalls,
		)
	}
	if fallback.calls != 0 {
		t.Fatalf("fallback Executor calls = %d, want 0", fallback.calls)
	}
}

func TestInsightOnlyPayloadUsesGenerator(t *testing.T) {
	generator := &insightGeneratorOnly{
		result: ai_insight.GenerationResult{Title: "title", Content: "content"},
	}
	handler := NewTaskHandlerWithDB(&remediationDB{}, HandlerConfig{
		InsightGenerator: generator,
	})
	task := remediationTask(t, queue.TypeGenerateInsight, GenerateInsightPayload{
		InsightID: remediationInt64Pointer(34),
	})

	if err := handler.HandleGenerateInsight(context.Background(), task); err != nil {
		t.Fatalf("HandleGenerateInsight() error = %v", err)
	}
	if generator.generateCalls != 1 || generator.generateID != 34 {
		t.Fatalf("Generate calls=%d insightID=%d, want 1/34", generator.generateCalls, generator.generateID)
	}
}

func TestDualIDPayloadWithoutInsightGeneratorSkipsScheduledInsight(t *testing.T) {
	fallback := &remediationExecutor{result: map[string]any{"fallback": true}}
	handler := NewTaskHandlerWithDB(&remediationDB{}, HandlerConfig{
		Executor: fallback,
	})
	task := remediationTask(t, queue.TypeGenerateInsight, GenerateInsightPayload{
		ScheduleID: remediationInt64Pointer(18),
		InsightID:  remediationInt64Pointer(35),
	})

	if err := handler.HandleGenerateInsight(context.Background(), task); err != nil {
		t.Fatalf("HandleGenerateInsight() error = %v", err)
	}
	if fallback.calls != 1 {
		t.Fatalf("fallback Executor calls = %d, want 1", fallback.calls)
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
