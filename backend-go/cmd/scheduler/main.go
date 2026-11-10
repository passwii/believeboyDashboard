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

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
	"github.com/passwii/believeboyDashboard/backend-go/internal/scheduler"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
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

	// Dynamic scheduling (due insight schedules + minutely scheduled-report
	// scan) needs the primary database. Missing DATABASE_URL degrades safely to
	// the fixed Beat-compatible catalog instead of crashing the process.
	if dynamicSchedulingEnabled(cfg.DatabaseURL) {
		pool, err := openSchedulerPool(cfg.DatabaseURL)
		if err != nil {
			return err
		}
		defer pool.Close()

		enqueuer := scheduler.PayloadEnqueuerFunc(func(
			ctx context.Context,
			taskName string,
			payload any,
		) error {
			_, enqueueErr := queueClient.Enqueue(ctx, taskName, payload)
			return enqueueErr
		})
		reconciler, err := scheduler.NewInsightReconciler(scheduler.InsightReconcilerConfig{
			Source:           store.NewAIInsightStore(store.NewPGXDB(pool), nil),
			Enqueuer:         enqueuer,
			CanonicalDomains: cfg.InsightCanonicalDomains,
			Logger:           logger,
		})
		if err != nil {
			return fmt.Errorf("create insight schedule reconciler: %w", err)
		}
		dynamicConfig := scheduler.DynamicJobsConfig{
			InsightReconciler: reconciler,
		}
		if cfg.OwnedModules["scheduled_reports"] {
			scanner, err := scheduler.NewScheduledReportScanner(
				scheduler.ScheduledReportScannerConfig{
					Source:   store.NewScheduledReportStore(store.NewPGXDB(pool)),
					Enqueuer: enqueuer,
					Logger:   logger,
				},
			)
			if err != nil {
				return fmt.Errorf("create scheduled report scanner: %w", err)
			}
			dynamicConfig.ScheduledReportScanner = scanner
		} else {
			logger.Info(
				"scheduled report minutely scan disabled",
				slog.String("reason", "scheduled_reports module is not owned"),
			)
		}
		if err := scheduler.RegisterDynamicJobs(sched, dynamicConfig); err != nil {
			return err
		}
	} else {
		logger.Warn(
			"database-backed scheduler jobs disabled",
			slog.String("reason", "DATABASE_URL is empty"),
		)
	}

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

// dynamicSchedulingEnabled reports whether DB-backed dynamic jobs can run.
func dynamicSchedulingEnabled(databaseURL string) bool {
	return strings.TrimSpace(databaseURL) != ""
}

// openSchedulerPool bounds startup so a misconfigured database fails fast.
func openSchedulerPool(databaseURL string) (*pgxpool.Pool, error) {
	startupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := store.OpenPool(startupCtx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open scheduler database: %w", err)
	}
	return pool, nil
}
