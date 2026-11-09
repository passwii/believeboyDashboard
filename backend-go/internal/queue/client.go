package queue

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/hibiken/asynq"
)

const (
	defaultRetryCount  = 3
	defaultTaskTimeout = 20 * time.Minute
)

// TaskEnqueuer is the Asynq client surface used by QueueClient.
type TaskEnqueuer interface {
	EnqueueContext(ctx context.Context, task *asynq.Task, opts ...asynq.Option) (*asynq.TaskInfo, error)
}

type taskEnqueuerCloser interface {
	Close() error
}

type ClientConfig struct {
	DefaultRetry   int
	DefaultTimeout time.Duration
}

func DefaultClientConfig() ClientConfig {
	return ClientConfig{
		DefaultRetry:   defaultRetryCount,
		DefaultTimeout: defaultTaskTimeout,
	}
}

type QueueClient struct {
	enqueuer TaskEnqueuer
	config   ClientConfig
}

// NewQueueClient creates a Redis-backed Asynq producer.
func NewQueueClient(redisURL string, config ClientConfig) (*QueueClient, error) {
	if strings.TrimSpace(redisURL) == "" {
		return nil, fmt.Errorf("create queue client: REDIS_URL is empty")
	}
	redisConnection, err := asynq.ParseRedisURI(redisURL)
	if err != nil {
		return nil, fmt.Errorf("create queue client: parse REDIS_URL: %w", err)
	}
	return NewQueueClientWithEnqueuer(asynq.NewClient(redisConnection), config), nil
}

// NewQueueClientWithEnqueuer creates a producer with an injected Asynq client.
func NewQueueClientWithEnqueuer(enqueuer TaskEnqueuer, config ClientConfig) *QueueClient {
	return &QueueClient{
		enqueuer: enqueuer,
		config:   normalizeClientConfig(config),
	}
}

// Enqueue publishes one task to its Celery-compatible queue.
func (client *QueueClient) Enqueue(
	ctx context.Context,
	taskType string,
	payload any,
	opts ...asynq.Option,
) (*asynq.TaskInfo, error) {
	return client.enqueue(ctx, nil, taskType, payload, opts...)
}

// EnqueueIn publishes one task after the requested delay.
func (client *QueueClient) EnqueueIn(
	ctx context.Context,
	delay time.Duration,
	taskType string,
	payload any,
	opts ...asynq.Option,
) (*asynq.TaskInfo, error) {
	if delay < 0 {
		return nil, fmt.Errorf("enqueue task %q: delay must not be negative", taskType)
	}
	return client.enqueue(ctx, &delay, taskType, payload, opts...)
}

// Close releases the underlying Redis connection pool when supported.
func (client *QueueClient) Close() error {
	if client == nil || client.enqueuer == nil {
		return nil
	}
	closer, ok := client.enqueuer.(taskEnqueuerCloser)
	if !ok {
		return nil
	}
	return closer.Close()
}

func (client *QueueClient) enqueue(
	ctx context.Context,
	delay *time.Duration,
	taskType string,
	payload any,
	opts ...asynq.Option,
) (*asynq.TaskInfo, error) {
	if client == nil {
		return nil, fmt.Errorf("enqueue task: queue client is nil")
	}
	if client.enqueuer == nil {
		return nil, fmt.Errorf("enqueue task: enqueuer is nil")
	}
	if ctx == nil {
		return nil, fmt.Errorf("enqueue task: context is nil")
	}
	if strings.TrimSpace(taskType) == "" {
		return nil, fmt.Errorf("enqueue task: task type is empty")
	}
	if client.config.DefaultRetry < 0 {
		return nil, fmt.Errorf("enqueue task %q: default retry must not be negative", taskType)
	}
	if client.config.DefaultTimeout < 0 {
		return nil, fmt.Errorf("enqueue task %q: default timeout must not be negative", taskType)
	}

	encoded, err := MarshalPayload(payload)
	if err != nil {
		return nil, fmt.Errorf("enqueue task %q: %w", taskType, err)
	}

	var hasMaxRetry, hasTimeout bool
	for _, opt := range opts {
		if opt.Type() == asynq.MaxRetryOpt {
			hasMaxRetry = true
		}
		if opt.Type() == asynq.TimeoutOpt {
			hasTimeout = true
		}
	}
	taskOptions := make([]asynq.Option, 0, len(opts)+4)
	taskOptions = append(taskOptions, opts...)
	if !hasMaxRetry && client.config.DefaultRetry >= 0 {
		taskOptions = append(taskOptions, asynq.MaxRetry(client.config.DefaultRetry))
	}
	if !hasTimeout && client.config.DefaultTimeout > 0 {
		taskOptions = append(taskOptions, asynq.Timeout(client.config.DefaultTimeout))
	}
	if delay != nil {
		taskOptions = append(taskOptions, asynq.ProcessIn(*delay))
	}
	// Routing and delay are non-overridable invariants of this wrapper.
	taskOptions = append(taskOptions, asynq.Queue(QueueForTask(taskType)))

	taskInfo, err := client.enqueuer.EnqueueContext(
		ctx,
		asynq.NewTask(taskType, encoded),
		taskOptions...,
	)
	if err != nil {
		return nil, fmt.Errorf("enqueue task %q: %w", taskType, err)
	}
	return taskInfo, nil
}

func normalizeClientConfig(config ClientConfig) ClientConfig {
	if config.DefaultRetry == 0 {
		config.DefaultRetry = defaultRetryCount
	}
	if config.DefaultTimeout == 0 {
		config.DefaultTimeout = defaultTaskTimeout
	}
	return config
}
