package queue

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/hibiken/asynq"
)

type ServerConfig struct {
	Concurrency     int
	Queues          map[string]int
	StrictPriority  bool
	ShutdownTimeout time.Duration
}

func DefaultServerConfig() ServerConfig {
	return ServerConfig{
		Queues:          DefaultQueueWeights(),
		ShutdownTimeout: 30 * time.Second,
	}
}

type QueueServer struct {
	server    *asynq.Server
	config    ServerConfig
	mu        sync.RWMutex
	handlers  map[string]asynq.HandlerFunc
	regErrors []error
	started   atomic.Bool
}

// NewQueueServer creates a Redis-backed Asynq consumer for all Stage 6A queues.
func NewQueueServer(redisURL string, config ServerConfig) (*QueueServer, error) {
	if strings.TrimSpace(redisURL) == "" {
		return nil, fmt.Errorf("create queue server: REDIS_URL is empty")
	}
	redisConnection, err := asynq.ParseRedisURI(redisURL)
	if err != nil {
		return nil, fmt.Errorf("create queue server: parse REDIS_URL: %w", err)
	}

	config = normalizeServerConfig(config)
	asynqConfig := asynq.Config{
		Concurrency:     config.Concurrency,
		Queues:          copyQueueWeights(config.Queues),
		StrictPriority:  config.StrictPriority,
		ShutdownTimeout: config.ShutdownTimeout,
	}
	return &QueueServer{
		server:   asynq.NewServer(redisConnection, asynqConfig),
		config:   config,
		handlers: make(map[string]asynq.HandlerFunc),
	}, nil
}

// RegisterHandler binds a task type to its handler. Invalid or duplicate
// registrations are surfaced by Start instead of panicking here.
func (server *QueueServer) RegisterHandler(taskType string, handler asynq.HandlerFunc) {
	if server == nil {
		return
	}
	server.mu.Lock()
	defer server.mu.Unlock()

	if strings.TrimSpace(taskType) == "" {
		server.regErrors = append(server.regErrors, fmt.Errorf("register handler: task type is empty"))
		return
	}
	if handler == nil {
		server.regErrors = append(server.regErrors, fmt.Errorf("register handler %q: handler is nil", taskType))
		return
	}
	if _, exists := server.handlers[taskType]; exists {
		server.regErrors = append(server.regErrors, fmt.Errorf("register handler %q: duplicate registration", taskType))
		return
	}
	server.handlers[taskType] = handler
}

// RegisteredTaskTypes returns a stable snapshot of registered task types.
func (server *QueueServer) RegisteredTaskTypes() []string {
	if server == nil {
		return nil
	}
	server.mu.RLock()
	defer server.mu.RUnlock()

	taskTypes := make([]string, 0, len(server.handlers))
	for taskType := range server.handlers {
		taskTypes = append(taskTypes, taskType)
	}
	sort.Strings(taskTypes)
	return taskTypes
}

// QueueWeights returns a defensive copy of the configured queue priorities.
func (server *QueueServer) QueueWeights() map[string]int {
	if server == nil {
		return nil
	}
	return copyQueueWeights(server.config.Queues)
}

// ProcessTask implements asynq.Handler and dispatches to registered handlers.
func (server *QueueServer) ProcessTask(ctx context.Context, task *asynq.Task) (err error) {
	if server == nil {
		return fmt.Errorf("process task: queue server is nil")
	}
	if task == nil {
		return fmt.Errorf("process task: task is nil")
	}

	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("process task %q: handler panicked: %v", task.Type(), recovered)
		}
	}()

	server.mu.RLock()
	handler, ok := server.handlers[task.Type()]
	server.mu.RUnlock()
	if !ok {
		return fmt.Errorf("process task %q: no handler registered", task.Type())
	}
	if handler == nil {
		return fmt.Errorf("process task %q: handler is nil", task.Type())
	}
	return handler(ctx, task)
}

// Start launches Asynq's consumer goroutines and returns once startup succeeds.
// Callers must keep the process alive and call Shutdown when it is time to stop.
func (server *QueueServer) Start() error {
	if server == nil {
		return fmt.Errorf("start queue server: queue server is nil")
	}
	if server.server == nil {
		return fmt.Errorf("start queue server: Asynq server is nil")
	}
	if !server.started.CompareAndSwap(false, true) {
		return fmt.Errorf("start queue server: server is already running")
	}

	server.mu.RLock()
	handlerCount := len(server.handlers)
	registrationErrors := append([]error(nil), server.regErrors...)
	server.mu.RUnlock()
	if len(registrationErrors) > 0 {
		server.started.Store(false)
		return fmt.Errorf("start queue server: invalid registrations: %w", errors.Join(registrationErrors...))
	}
	if handlerCount == 0 {
		server.started.Store(false)
		return fmt.Errorf("start queue server: no handlers registered")
	}

	if err := server.server.Start(asynq.HandlerFunc(server.ProcessTask)); err != nil {
		server.started.Store(false)
		return fmt.Errorf("start queue server: %w", err)
	}
	return nil
}

// Shutdown gracefully stops task processing. It is safe before Start and to
// call multiple times.
func (server *QueueServer) Shutdown() {
	if server == nil || server.server == nil {
		return
	}
	server.server.Shutdown()
	server.started.Store(false)
}

func normalizeServerConfig(config ServerConfig) ServerConfig {
	if len(config.Queues) == 0 {
		config.Queues = DefaultQueueWeights()
	} else {
		config.Queues = copyQueueWeights(config.Queues)
	}
	if config.ShutdownTimeout < 0 {
		config.ShutdownTimeout = 0
	}
	return config
}

func copyQueueWeights(source map[string]int) map[string]int {
	weights := make(map[string]int, len(source))
	for queueName, weight := range source {
		weights[queueName] = weight
	}
	return weights
}
