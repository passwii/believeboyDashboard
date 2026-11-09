package scheduled_reports

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/hibiken/asynq"
)

const defaultScheduledReportUniqueTTL = 24 * time.Hour

type QueueClient interface {
	Enqueue(ctx context.Context, taskType string, payload any, opts ...asynq.Option) (*asynq.TaskInfo, error)
}

// QueueEnqueuer maps the injectable enqueuer contract onto the existing Asynq
// task catalog. Stable task IDs and unique locks make repeated HTTP requests and
// beat/trigger races converge onto one queued task.
type QueueEnqueuer struct {
	client    QueueClient
	uniqueTTL time.Duration
}

func NewQueueEnqueuer(client QueueClient) *QueueEnqueuer {
	if isNilDependency(client) {
		client = nil
	}
	return &QueueEnqueuer{client: client, uniqueTTL: defaultScheduledReportUniqueTTL}
}

type QueueRunner struct {
	enqueuer Enqueuer
}

func NewQueueRunner(enqueuer Enqueuer) *QueueRunner {
	if isNilDependency(enqueuer) {
		enqueuer = nil
	}
	return &QueueRunner{enqueuer: enqueuer}
}

func (runner *QueueRunner) Run(
	ctx context.Context,
	request EnqueueRequest,
) (string, error) {
	if runner == nil || runner.enqueuer == nil {
		return "", ErrEnqueuerNotConfigured
	}
	return runner.enqueuer.Enqueue(ctx, request)
}

func (enqueuer *QueueEnqueuer) Enqueue(
	ctx context.Context,
	request EnqueueRequest,
) (string, error) {
	if enqueuer == nil || enqueuer.client == nil {
		return "", ErrEnqueuerNotConfigured
	}
	if strings.TrimSpace(request.TaskType) == "" {
		return "", fmt.Errorf("task type is empty")
	}
	options := make([]asynq.Option, 0, 1)
	if strings.TrimSpace(request.IdempotencyKey) != "" {
		options = append(options, asynq.TaskID(stableTaskID(request.TaskType, request.IdempotencyKey)))
	} else {
		options = append(options, asynq.Unique(enqueuer.uniqueTTL))
	}
	info, err := enqueuer.client.Enqueue(ctx, request.TaskType, request.Payload, options...)
	if err != nil {
		if errors.Is(err, asynq.ErrTaskIDConflict) {
			return request.IdempotencyKey, nil
		}
		return "", err
	}
	if info == nil {
		return "", fmt.Errorf("queue returned nil task info")
	}
	return info.ID, nil
}

func stableTaskID(taskType, idempotencyKey string) string {
	sum := sha256.Sum256([]byte(taskType + "\x00" + idempotencyKey))
	return "idem-" + hex.EncodeToString(sum[:16])
}
