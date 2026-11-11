package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_monthly_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/health"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/insight_runs"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
	"github.com/passwii/believeboyDashboard/backend-go/internal/mailer"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
	"github.com/passwii/believeboyDashboard/backend-go/internal/tasks"
	"github.com/passwii/believeboyDashboard/backend-go/internal/tzcheck"
)

type workerServer interface {
	Start() error
	Shutdown()
	RegisteredTaskTypes() []string
	QueueWeights() map[string]int
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(logger); err != nil {
		logger.Error("worker stopped", slog.Any("error", err))
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	if logger == nil {
		logger = slog.Default()
	}

	if err := tzcheck.Ensure(); err != nil {
		return err
	}

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	if cfg.RedisURL == "" {
		return errors.New("REDIS_URL is required for the worker")
	}

	startupCtx, startupCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer startupCancel()
	pool, err := store.OpenPool(startupCtx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("open primary database: %w", err)
	}
	defer pool.Close()

	server, err := queue.NewQueueServer(cfg.RedisURL, queue.DefaultServerConfig())
	if err != nil {
		return err
	}

	monthlyStore := store.NewMonthlyReportStoreWithRoots(
		store.NewPGXDB(pool),
		cfg.MonthlyReportResultRoot,
		cfg.UploadRoot,
	)
	primaryDB := store.NewPGXDB(pool)
	auditSvc := audit.NewService(primaryDB)
	agentMonthlyStore := store.NewAgentMonthlyReportStore(
		primaryDB,
		auditSvc,
		store.AgentMonthlyReportStoreOptions{
			Root:       cfg.AgentMonthlyReportRoot,
			UploadRoot: cfg.UploadRoot,
			ResultRoot: cfg.MonthlyReportResultRoot,
			Now:        time.Now,
		},
	)
	insightRedisClient := health.NewRedisClient(cfg.InsightStreamRedisURL)
	if insightRedisClient == nil {
		return errors.New("parse INSIGHT_STREAM_REDIS_URL")
	}
	defer insightRedisClient.Close()
	insightProvider := ai.NewOpenAIProvider(ai.ProviderConfig{
		BaseURL:      cfg.AIChatProviderBaseURL,
		APIKey:       cfg.AIChatProviderAPIKey,
		DefaultModel: cfg.AIChatDefaultModel,
		Timeout:      time.Duration(cfg.AIChatTimeoutSeconds) * time.Second,
	})
	insightStore := store.NewAIInsightStoreWithObservation(
		primaryDB,
		auditSvc,
		cfg.InsightObservationEnabled,
	)
	insightEvents := insight_runs.NewRedisEventStore(
		insightRedisClient,
		cfg.RedisKeyPrefix+":insight",
		time.Duration(cfg.InsightStreamTTLSeconds)*time.Second,
		int64(cfg.InsightStreamMaxLen),
	)
	handlerConfig := taskHandlerConfig(cfg)
	handlerConfig.InsightGenerator = ai_insight.NewProviderGeneratorWithConfig(
		insightStore,
		insightProvider,
		ai_insight.Config{
			CanonicalDomains: cfg.InsightCanonicalDomains,
		},
	)
	handlerConfig.InsightRunExecutor = insight_runs.NewExecutor(
		insightStore,
		insightProvider,
		insightEvents,
	)
	handlerConfig.MonthlyReportFinalizer = monthlyReportFinalizer{store: monthlyStore}
	handlerConfig.ProductAnalysisReportExecutor = tasks.NewProductAnalysisReportExecutor(
		primaryDB,
		cfg.UploadRoot,
		cfg.MonthlyReportResultRoot,
	)
	handlerConfig.MonthlyReportBuildExecutor = agent_monthly_reports.NewBuildExecutor(
		agentMonthlyStore,
		cfg.AgentMonthlyReportRoot,
		50<<20,
	)
	handlerConfig.Mailer = workerTextMailer{mailer: newWorkerMailer(cfg)}
	handlerConfig.Executor = scheduledDispatchExecutor{db: primaryDB, sender: newWorkerMailer(cfg), provider: insightProvider}
	handler := tasks.NewTaskHandler(pool, handlerConfig)
	if err := handler.ValidateRuntime(); err != nil {
		return fmt.Errorf("validate task runtime: %w", err)
	}
	if err := handler.RegisterAll(server); err != nil {
		return fmt.Errorf("register task handlers: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	return serveWorker(ctx, logger, server)
}

func serveWorker(ctx context.Context, logger *slog.Logger, server workerServer) error {
	if err := server.Start(); err != nil {
		return fmt.Errorf("start task worker: %w", err)
	}
	defer server.Shutdown()

	logger.Info(
		"worker started",
		slog.Int("task_handlers", len(server.RegisteredTaskTypes())),
		slog.Any("queues", server.QueueWeights()),
	)

	<-ctx.Done()
	return nil
}

func taskHandlerConfig(cfg config.Config) tasks.HandlerConfig {
	handlerConfig := tasks.DefaultHandlerConfig()
	handlerConfig.CRMSeaReclaimDays = cfg.CRMSeaReclaimDays
	handlerConfig.CRMTaskReminderLeadHours = cfg.CRMTaskReminderLeadHours
	handlerConfig.CRMFollowUpReminderDays = cfg.CRMFollowUpReminderDays
	handlerConfig.OperationAuditRetentionDays = cfg.OperationAuditRetentionDays
	handlerConfig.AgentAPIAuditRetentionDays = cfg.AgentAPIAuditRetentionDays
	handlerConfig.CRMRuleEngineEnabled = cfg.CRMRuleEngineEnabled
	handlerConfig.CRMStaleEmailEnabled = cfg.CRMStaleEmailEnabled
	handlerConfig.MonthlyReportGenerator = tasks.NewFileMonthlyReportGenerator(
		cfg.UploadRoot,
		cfg.MonthlyReportResultRoot,
	)
	return handlerConfig
}

func newWorkerMailer(cfg config.Config) *mailer.Mailer {
	from := cfg.AlertFromEmail
	if cfg.AlertFromName != "" {
		from = fmt.Sprintf("%s <%s>", cfg.AlertFromName, cfg.AlertFromEmail)
	}
	return mailer.New(mailer.Config{
		APIKey:  cfg.ResendAPIKey,
		From:    from,
		BaseURL: cfg.ResendBaseURL,
		Timeout: 30 * time.Second,
	})
}

type workerTextMailer struct {
	mailer *mailer.Mailer
}

func (adapter workerTextMailer) Send(
	ctx context.Context,
	to string,
	subject string,
	body string,
) error {
	if adapter.mailer == nil {
		return fmt.Errorf("%w: mailer client", tasks.ErrDependencyNotConfigured)
	}
	_, err := adapter.mailer.SendText(ctx, to, subject, body, "")
	return err
}

type monthlyReportFinalizer struct {
	store *store.MonthlyReportStore
}

func (finalizer monthlyReportFinalizer) Finalize(
	ctx context.Context,
	reportID int64,
	jobID int64,
	result store.MonthlyReportComputedResult,
) error {
	if finalizer.store == nil {
		return fmt.Errorf("%w: monthly report store", tasks.ErrDependencyNotConfigured)
	}
	return finalizer.store.FinalizeCompletedReport(ctx, reportID, jobID, result)
}
