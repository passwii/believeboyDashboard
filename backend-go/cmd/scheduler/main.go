package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
	"github.com/passwii/believeboyDashboard/backend-go/internal/scheduler"
	"github.com/redis/go-redis/v9"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(logger); err != nil {
		logger.Error("scheduler stopped", slog.Any("error", err))
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	if logger == nil {
		logger = slog.Default()
	}

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	if strings.TrimSpace(cfg.RedisURL) == "" {
		return errors.New("REDIS_URL is required for the scheduler")
	}

	redisOptions, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return fmt.Errorf("parse REDIS_URL: %w", err)
	}
	redisOptions.DialTimeout = 3 * time.Second
	redisOptions.ReadTimeout = 3 * time.Second
	redisOptions.WriteTimeout = 3 * time.Second
	lockClient := redis.NewClient(redisOptions)
	defer lockClient.Close()

	pingCtx, pingCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer pingCancel()
	if err := lockClient.Ping(pingCtx).Err(); err != nil {
		return fmt.Errorf("ping redis: %w", err)
	}

	queueClient, err := queue.NewQueueClient(cfg.RedisURL, queue.DefaultClientConfig())
	if err != nil {
		return err
	}
	defer queueClient.Close()

	locker := scheduler.NewRedisLocker(lockClient, "scheduler:beat:")
	sched := scheduler.New(locker)
	scheduler.RegisterStandardJobs(sched, scheduler.TaskEnqueuerFunc(func(taskName string) error {
		_, enqueueErr := queueClient.Enqueue(context.Background(), taskName, nil)
		return enqueueErr
	}), locker)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	sched.Start()
	defer sched.Stop()
	logger.Info(
		"scheduler started",
		slog.Int("jobs", len(sched.ListJobs())),
		slog.String("timezone", scheduler.DefaultTimezone),
	)

	<-ctx.Done()
	return nil
}
