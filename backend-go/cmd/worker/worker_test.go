package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
)

type fakeWorkerServer struct {
	startErr      error
	started       chan struct{}
	startCalls    atomic.Int32
	shutdownCalls atomic.Int32
}

func newFakeWorkerServer() *fakeWorkerServer {
	return &fakeWorkerServer{started: make(chan struct{})}
}

func (server *fakeWorkerServer) Start() error {
	server.startCalls.Add(1)
	close(server.started)
	return server.startErr
}

func (server *fakeWorkerServer) Shutdown() {
	server.shutdownCalls.Add(1)
}

func (server *fakeWorkerServer) RegisteredTaskTypes() []string {
	return []string{"test:task"}
}

func (server *fakeWorkerServer) QueueWeights() map[string]int {
	return map[string]int{"default": 1}
}

func TestServeWorkerStartsAndWaitsForShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	server := newFakeWorkerServer()
	done := make(chan error, 1)
	go func() {
		done <- serveWorker(ctx, testLogger(), server)
	}()

	select {
	case <-server.started:
	case <-time.After(time.Second):
		t.Fatal("worker Start() was not called")
	}

	select {
	case err := <-done:
		t.Fatalf("serveWorker() returned before shutdown signal: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serveWorker() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("serveWorker() did not stop after shutdown signal")
	}

	if got := server.startCalls.Load(); got != 1 {
		t.Errorf("Start() calls = %d, want 1", got)
	}
	if got := server.shutdownCalls.Load(); got != 1 {
		t.Errorf("Shutdown() calls = %d, want 1", got)
	}
}

func TestServeWorkerReturnsStartupErrorImmediately(t *testing.T) {
	startErr := errors.New("startup failed")
	server := newFakeWorkerServer()
	server.startErr = startErr

	err := serveWorker(context.Background(), testLogger(), server)
	if !errors.Is(err, startErr) {
		t.Fatalf("serveWorker() error = %v, want wrapped startup error", err)
	}
	if got := server.shutdownCalls.Load(); got != 0 {
		t.Errorf("Shutdown() calls = %d, want 0 after startup failure", got)
	}
}

func TestValidateOwnedModulesRejectsScheduledReports(t *testing.T) {
	cfg := config.Config{
		OwnedModules: map[string]bool{
			"health":            true,
			"scheduled_reports": true,
		},
	}

	err := validateOwnedModules(cfg)
	if err == nil {
		t.Fatal("validateOwnedModules() error = nil, want scheduled_reports gate error")
	}
	if !errors.Is(err, errScheduledReportsNotPorted) {
		t.Fatalf("validateOwnedModules() error = %v, want errScheduledReportsNotPorted", err)
	}
}

func TestValidateOwnedModulesAllowsDefaultModules(t *testing.T) {
	cfg := config.Config{
		OwnedModules: map[string]bool{
			"health":         true,
			"exchange_rates": true,
			"notifications":  true,
			"alerts":         true,
			"profile":        true,
		},
	}
	if err := validateOwnedModules(cfg); err != nil {
		t.Fatalf("validateOwnedModules() error = %v, want nil for default modules", err)
	}
}

func TestTaskHandlerConfigMapsBusinessSettings(t *testing.T) {
	cfg := config.Config{
		CRMSeaReclaimDays:           30,
		CRMTaskReminderLeadHours:    12,
		CRMFollowUpReminderDays:     0,
		OperationAuditRetentionDays: 120,
		AgentAPIAuditRetentionDays:  45,
		CRMRuleEngineEnabled:        true,
		CRMStaleEmailEnabled:        false,
	}

	got := taskHandlerConfig(cfg)
	if got.CRMSeaReclaimDays != cfg.CRMSeaReclaimDays {
		t.Errorf("CRMSeaReclaimDays = %d, want %d", got.CRMSeaReclaimDays, cfg.CRMSeaReclaimDays)
	}
	if got.CRMTaskReminderLeadHours != cfg.CRMTaskReminderLeadHours {
		t.Errorf("CRMTaskReminderLeadHours = %d, want %d", got.CRMTaskReminderLeadHours, cfg.CRMTaskReminderLeadHours)
	}
	if got.CRMFollowUpReminderDays != cfg.CRMFollowUpReminderDays {
		t.Errorf("CRMFollowUpReminderDays = %d, want %d", got.CRMFollowUpReminderDays, cfg.CRMFollowUpReminderDays)
	}
	if got.OperationAuditRetentionDays != cfg.OperationAuditRetentionDays {
		t.Errorf("OperationAuditRetentionDays = %d, want %d", got.OperationAuditRetentionDays, cfg.OperationAuditRetentionDays)
	}
	if got.AgentAPIAuditRetentionDays != cfg.AgentAPIAuditRetentionDays {
		t.Errorf("AgentAPIAuditRetentionDays = %d, want %d", got.AgentAPIAuditRetentionDays, cfg.AgentAPIAuditRetentionDays)
	}
	if got.CRMRuleEngineEnabled != cfg.CRMRuleEngineEnabled {
		t.Errorf("CRMRuleEngineEnabled = %t, want %t", got.CRMRuleEngineEnabled, cfg.CRMRuleEngineEnabled)
	}
	if got.CRMStaleEmailEnabled != cfg.CRMStaleEmailEnabled {
		t.Errorf("CRMStaleEmailEnabled = %t, want %t", got.CRMStaleEmailEnabled, cfg.CRMStaleEmailEnabled)
	}
	if got.Location == nil {
		t.Error("Location = nil, want default location")
	}
	if got.Now == nil {
		t.Error("Now = nil, want default clock")
	}
	if got.MonthlyReportGenerator == nil {
		t.Error("MonthlyReportGenerator = nil, want configured file generator")
	}
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
