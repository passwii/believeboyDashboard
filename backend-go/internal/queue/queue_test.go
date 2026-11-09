package queue

import (
	"context"
	"errors"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/hibiken/asynq"
)

type stage6AFakeEnqueuer struct {
	task       *asynq.Task
	options    []asynq.Option
	taskInfo   *asynq.TaskInfo
	enqueueErr error
}

func (f *stage6AFakeEnqueuer) EnqueueContext(
	_ context.Context,
	task *asynq.Task,
	opts ...asynq.Option,
) (*asynq.TaskInfo, error) {
	f.task = task
	f.options = append([]asynq.Option(nil), opts...)
	if f.enqueueErr != nil {
		return nil, f.enqueueErr
	}
	if f.taskInfo != nil {
		return f.taskInfo, nil
	}
	return &asynq.TaskInfo{ID: "task-1", Type: task.Type(), Queue: QueueForTask(task.Type())}, nil
}

func stage6AOptionValue[T any](t *testing.T, opts []asynq.Option, optionType asynq.OptionType) T {
	t.Helper()
	for _, option := range opts {
		if option.Type() != optionType {
			continue
		}
		value, ok := option.Value().(T)
		if !ok {
			t.Fatalf("option %v value has type %T, want %T", optionType, option.Value(), *new(T))
		}
		return value
	}
	t.Fatalf("option %v not found in %#v", optionType, opts)
	var zero T
	return zero
}

func TestStage6ARoutingMatchesCeleryTaskRoutes(t *testing.T) {
	want := map[string]string{
		TypeRunJob:                       "reports",
		TypeBuildMonthlyReportPreview:    "reports",
		TypeAgentMonthlyReportCleanup:    "default",
		TypeGenerateInsight:              "insights",
		TypeExecuteInsightRun:            "insights",
		TypeDispatchOne:                  "scheduled",
		TypeGenerateDeliverySummary:      "ai_summary",
		TypeAlertDetect:                  "default",
		TypeReturnAnalysisRefreshDaily:   "default",
		TypeReturnAnalysisRebuild:        "default",
		TypeCRMSeaReclaim:                "default",
		TypeCRMTaskReminder:              "default",
		TypeCRMFollowUpReminder:          "default",
		TypeCRMRuleEngine:                "default",
		TypeCRMStaleEmail:                "default",
		TypeAgentAPIAuditCleanup:         "default",
		TypeOperationAuditCleanup:        "default",
		TypeAIChatTokenUsageRefreshDaily: "default",
	}
	for taskType, queueName := range want {
		if got := QueueForTask(taskType); got != queueName {
			t.Fatalf("QueueForTask(%q) = %q, want %q", taskType, got, queueName)
		}
	}
	if got := QueueForTask("unknown.task"); got != QueueDefault {
		t.Fatalf("QueueForTask(unknown) = %q, want %q", got, QueueDefault)
	}
}

func TestStage6AAllTaskTypesAreUniqueAndComplete(t *testing.T) {
	taskTypes := AllTaskTypes()
	if len(taskTypes) != 18 {
		t.Fatalf("AllTaskTypes() length = %d, want 18", len(taskTypes))
	}
	sort.Strings(taskTypes)
	for i := 1; i < len(taskTypes); i++ {
		if taskTypes[i] == taskTypes[i-1] {
			t.Fatalf("duplicate task type %q", taskTypes[i])
		}
	}
}

func TestStage6ADefaultQueueWeightsMatchCeleryPriority(t *testing.T) {
	want := map[string]int{
		QueueReports:   6,
		QueueInsights:  4,
		QueueScheduled: 3,
		QueueAISummary: 2,
		QueueDefault:   1,
	}
	got := DefaultQueueWeights()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("DefaultQueueWeights() = %#v, want %#v", got, want)
	}

	got[QueueDefault] = 99
	if again := DefaultQueueWeights()[QueueDefault]; again != 1 {
		t.Fatalf("DefaultQueueWeights() leaked mutable state: default = %d", again)
	}
}

func TestStage6AClientSetsQueueRetryAndTimeoutDefaults(t *testing.T) {
	fake := &stage6AFakeEnqueuer{}
	client := NewQueueClientWithEnqueuer(fake, ClientConfig{
		DefaultRetry:   3,
		DefaultTimeout: 30 * time.Second,
	})

	info, err := client.Enqueue(
		context.Background(),
		TypeAlertDetect,
		map[string]any{"source": "test"},
		asynq.MaxRetry(7),
	)
	if err != nil {
		t.Fatalf("Enqueue() error = %v", err)
	}
	if info == nil || info.Type != TypeAlertDetect {
		t.Fatalf("Enqueue() info = %#v", info)
	}
	if fake.task == nil {
		t.Fatal("enqueuer did not receive a task")
	}
	if got := string(fake.task.Payload()); got != `{"source":"test"}` {
		t.Fatalf("payload = %s, want {\"source\":\"test\"}", got)
	}
	if got := stage6AOptionValue[string](t, fake.options, asynq.QueueOpt); got != QueueDefault {
		t.Fatalf("queue option = %q, want %q", got, QueueDefault)
	}
	if got := stage6AOptionValue[int](t, fake.options, asynq.MaxRetryOpt); got != 7 {
		t.Fatalf("max retry option = %d, want caller override 7", got)
	}
	if got := stage6AOptionValue[time.Duration](t, fake.options, asynq.TimeoutOpt); got != 30*time.Second {
		t.Fatalf("timeout option = %s, want 30s", got)
	}
}

func TestStage6AClientDelayedEnqueueAlwaysUsesDelayAndRoute(t *testing.T) {
	fake := &stage6AFakeEnqueuer{}
	client := NewQueueClientWithEnqueuer(fake, DefaultClientConfig())
	delay := 15 * time.Minute

	_, err := client.EnqueueIn(
		context.Background(),
		delay,
		TypeRunJob,
		map[string]any{"job_id": 42},
		asynq.ProcessAt(time.Now().Add(24*time.Hour)),
	)
	if err != nil {
		t.Fatalf("EnqueueIn() error = %v", err)
	}
	if got := stage6AOptionValue[time.Duration](t, fake.options, asynq.ProcessInOpt); got != delay {
		t.Fatalf("delay option = %s, want %s", got, delay)
	}
	if got := stage6AOptionValue[string](t, fake.options, asynq.QueueOpt); got != QueueReports {
		t.Fatalf("queue option = %q, want %q", got, QueueReports)
	}
}

func TestStage6AClientReturnsErrorsWithoutPanics(t *testing.T) {
	fake := &stage6AFakeEnqueuer{enqueueErr: errors.New("redis unavailable")}
	client := NewQueueClientWithEnqueuer(fake, DefaultClientConfig())
	if _, err := client.Enqueue(context.Background(), TypeRunJob, map[string]any{"job_id": 1}); err == nil {
		t.Fatal("Enqueue() error = nil, want wrapped enqueue error")
	}

	var nilClient *QueueClient
	if _, err := nilClient.Enqueue(context.Background(), TypeRunJob, map[string]any{}); err == nil {
		t.Fatal("nil client Enqueue() error = nil")
	}

	unsupported := make(chan int)
	if _, err := client.Enqueue(context.Background(), TypeRunJob, unsupported); err == nil {
		t.Fatal("Enqueue() accepted an unsupported JSON payload")
	}
}

func TestStage6AServerRegistersAndDispatchesHandlers(t *testing.T) {
	server, err := NewQueueServer("redis://127.0.0.1:6379/0", DefaultServerConfig())
	if err != nil {
		t.Fatalf("NewQueueServer() error = %v", err)
	}
	defer server.Shutdown()

	server.RegisterHandler(TypeAlertDetect, func(context.Context, *asynq.Task) error {
		return nil
	})
	server.RegisterHandler(TypeRunJob, func(context.Context, *asynq.Task) error {
		return errors.New("handler failed")
	})

	got := server.RegisteredTaskTypes()
	want := []string{TypeAlertDetect, TypeRunJob}
	sort.Strings(got)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("RegisteredTaskTypes() = %#v, want %#v", got, want)
	}

	var handler asynq.Handler = server
	if err := handler.ProcessTask(context.Background(), asynq.NewTask(TypeAlertDetect, nil)); err != nil {
		t.Fatalf("registered handler error = %v", err)
	}
	if err := handler.ProcessTask(context.Background(), asynq.NewTask(TypeRunJob, nil)); err == nil ||
		!strings.Contains(err.Error(), "handler failed") {
		t.Fatalf("handler error = %v, want propagated handler failure", err)
	}
	if err := handler.ProcessTask(context.Background(), asynq.NewTask("unknown", nil)); err == nil {
		t.Fatal("unknown task type did not return an error")
	}
}

func TestStage6AServerRejectsDuplicateAndEmptyRegistrationsOnStart(t *testing.T) {
	server, err := NewQueueServer("redis://127.0.0.1:6379/0", DefaultServerConfig())
	if err != nil {
		t.Fatalf("NewQueueServer() error = %v", err)
	}
	handler := func(context.Context, *asynq.Task) error { return nil }
	server.RegisterHandler(TypeAlertDetect, handler)
	server.RegisterHandler(TypeAlertDetect, handler)
	server.RegisterHandler("", handler)

	if err := server.Start(); err == nil {
		t.Fatal("Start() error = nil, want registration validation error")
	}
	server.Shutdown()
}
