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

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/scheduled_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
	"github.com/passwii/believeboyDashboard/backend-go/internal/scheduler"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
	"github.com/passwii/believeboyDashboard/backend-go/internal/tasks"
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

	// Mirror DB-driven insight schedules into cron. FastAPI did this through
	// APScheduler (reload_insight_schedules); without it, schedules created via the
	// API are persisted but never fire, because only the 11 static jobs exist.
	stopInsightSync := startInsightScheduleSync(ctx, logger, cfg, sched, queueClient)
	defer stopInsightSync()

	stopScheduledReportScan := startScheduledReportScan(ctx, logger, cfg, sched, queueClient)
	defer stopScheduledReportScan()

	logger.Info(
		"scheduler started",
		slog.Int("jobs", len(sched.ListJobs())),
		slog.String("timezone", scheduler.DefaultTimezone),
	)

	<-ctx.Done()
	return nil
}

// insightScheduleSyncInterval controls how often the scheduler re-reads the
// insight schedule table so create/update/delete take effect without a restart.
// FastAPI reloaded through APScheduler job add/remove on every mutation; a
// periodic reconcile keeps the two runtimes detached.
const insightScheduleSyncInterval = 5 * time.Minute

func startInsightScheduleSync(
	ctx context.Context,
	logger *slog.Logger,
	cfg config.Config,
	sched *scheduler.Scheduler,
	queueClient *queue.QueueClient,
) func() {
	if strings.TrimSpace(cfg.DatabaseURL) == "" {
		logger.Warn("insight schedule sync disabled: DATABASE_URL is not set")
		return func() {}
	}

	pool, err := store.OpenPool(ctx, cfg.DatabaseURL)
	if err != nil {
		logger.Error("insight schedule sync disabled: open database", slog.Any("error", err))
		return func() {}
	}
	source := store.NewAIInsightStore(store.NewPGXDB(pool), nil)
	enqueue := func(scheduleID int64) error {
		enqueueCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, enqueueErr := queueClient.Enqueue(
			enqueueCtx,
			queue.TypeGenerateInsight,
			map[string]any{"schedule_id": scheduleID},
		)
		return enqueueErr
	}

	syncOnce := func() {
		syncCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		result, syncErr := scheduler.SyncInsightSchedules(syncCtx, sched, source, enqueue)
		if syncErr != nil {
			logger.Error("insight schedule sync failed", slog.Any("error", syncErr))
			return
		}
		logger.Info(
			"insight schedules synced",
			slog.Int("registered", result.Registered),
			slog.Int("unchanged", result.Unchanged),
			slog.Int("removed", result.Removed),
			slog.Int("skipped", result.Skipped),
		)
	}
	syncOnce()

	stopSync := make(chan struct{})
	go func() {
		ticker := time.NewTicker(insightScheduleSyncInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				syncOnce()
			case <-stopSync:
				return
			case <-ctx.Done():
				return
			}
		}
	}()

	return func() {
		close(stopSync)
		pool.Close()
	}
}

type scheduledReportStoreSource struct {
	store    *store.ScheduledReportStore
	location *time.Location
}

func (source scheduledReportStoreSource) ListDueSubscriptions(
	ctx context.Context,
	now time.Time,
) ([]scheduled_reports.Subscription, error) {
	return source.store.ListDueSubscriptions(ctx, now, source.location)
}

type scheduledReportQueueEnqueuer struct {
	client *queue.QueueClient
}

func (enqueuer scheduledReportQueueEnqueuer) EnqueueScheduledReport(
	ctx context.Context,
	payload tasks.DispatchOnePayload,
	delay time.Duration,
) error {
	_, err := enqueuer.client.EnqueueIn(ctx, delay, queue.TypeDispatchOne, payload)
	return err
}

// startScheduledReportScan registers the per-minute subscription scanner that
// FastAPI ran through APScheduler (_run_minutely_scan). Without it, scheduled
// reports created through the API never fire.
func startScheduledReportScan(
	ctx context.Context,
	logger *slog.Logger,
	cfg config.Config,
	sched *scheduler.Scheduler,
	queueClient *queue.QueueClient,
) func() {
	if strings.TrimSpace(cfg.DatabaseURL) == "" {
		logger.Warn("scheduled report scan disabled: DATABASE_URL is not set")
		return func() {}
	}
	pool, err := store.OpenPool(ctx, cfg.DatabaseURL)
	if err != nil {
		logger.Error("scheduled report scan disabled: open database", slog.Any("error", err))
		return func() {}
	}
	location, err := time.LoadLocation(scheduler.DefaultTimezone)
	if err != nil {
		pool.Close()
		logger.Error("scheduled report scan disabled: load timezone", slog.Any("error", err))
		return func() {}
	}
	source := scheduledReportStoreSource{
		store:    store.NewScheduledReportStore(store.NewPGXDB(pool)),
		location: location,
	}
	enqueuer := scheduledReportQueueEnqueuer{client: queueClient}

	if err := sched.AddJob("scheduled-report-minutely-scan", "* * * * *", func() {
		scanCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		result, scanErr := scheduler.ScanDueScheduledReports(scanCtx, time.Now(), source, enqueuer, logger)
		if scanErr != nil {
			logger.Error("scheduled report scan failed", slog.Any("error", scanErr))
			return
		}
		if result.Due > 0 {
			logger.Info(
				"scheduled report scan",
				slog.Int("due", result.Due),
				slog.Int("enqueued", result.Enqueued),
				slog.Int("skipped", result.Skipped),
			)
		}
	}); err != nil {
		pool.Close()
		logger.Error("scheduled report scan registration failed", slog.Any("error", err))
		return func() {}
	}
	return func() { pool.Close() }
}
