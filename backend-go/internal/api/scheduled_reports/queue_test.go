package scheduled_reports

import (
	"context"
	"errors"
	"testing"

	"github.com/hibiken/asynq"
)

type fakeQueueClient struct {
	taskType string
	payload  any
	options  []asynq.Option
	err      error
}

func (client *fakeQueueClient) Enqueue(
	_ context.Context,
	taskType string,
	payload any,
	options ...asynq.Option,
) (*asynq.TaskInfo, error) {
	client.taskType = taskType
	client.payload = payload
	client.options = options
	if client.err != nil {
		return nil, client.err
	}
	return &asynq.TaskInfo{ID: "task-1", Type: taskType}, nil
}

func TestQueueEnqueuerUsesIdempotentTaskID(t *testing.T) {
	client := &fakeQueueClient{}
	enqueuer := NewQueueEnqueuer(client)
	id, err := enqueuer.Enqueue(context.Background(), EnqueueRequest{
		TaskType:       "dispatch_one",
		Payload:        map[string]any{"subscription_id": 1},
		IdempotencyKey: "7:2026-11-08",
	})
	if err != nil {
		t.Fatalf("Enqueue() error = %v", err)
	}
	if id != "task-1" {
		t.Fatalf("task id = %q", id)
	}
	if len(client.options) != 1 || client.options[0].Type() != asynq.TaskIDOpt {
		t.Fatalf("options = %#v, want TaskID", client.options)
	}
	wantTaskID := stableTaskID("dispatch_one", "7:2026-11-08")
	if got := client.options[0].Value(); got != wantTaskID {
		t.Fatalf("TaskID = %#v, want %q", got, wantTaskID)
	}
}

func TestQueueEnqueuerTreatsTaskIDConflictAsIdempotentSuccess(t *testing.T) {
	client := &fakeQueueClient{err: asynq.ErrTaskIDConflict}
	enqueuer := NewQueueEnqueuer(client)
	id, err := enqueuer.Enqueue(context.Background(), EnqueueRequest{
		TaskType:       "dispatch_one",
		Payload:        map[string]any{"subscription_id": 1},
		IdempotencyKey: "7:2026-11-08",
	})
	if err != nil {
		t.Fatalf("Enqueue() error = %v", err)
	}
	if id != "7:2026-11-08" {
		t.Fatalf("id = %q, want idempotency key", id)
	}
}

func TestQueueEnqueuerFailClosedWithoutClient(t *testing.T) {
	enqueuer := NewQueueEnqueuer(nil)
	if _, err := enqueuer.Enqueue(context.Background(), EnqueueRequest{TaskType: "dispatch_one"}); !errors.Is(err, ErrEnqueuerNotConfigured) {
		t.Fatalf("error = %v, want ErrEnqueuerNotConfigured", err)
	}
}
