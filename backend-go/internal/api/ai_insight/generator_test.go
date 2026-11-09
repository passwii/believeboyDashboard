package ai_insight

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
)

type generatorStoreOnly struct {
	GeneratorStore
}

func TestProviderGeneratorGenerateScheduleFailsClosedWithoutScheduleStore(t *testing.T) {
	t.Parallel()

	store := newFakeAIInsightStore()
	generator := NewProviderGenerator(generatorStoreOnly{GeneratorStore: store}, nil)

	_, err := generator.GenerateSchedule(context.Background(), 7)
	if !errors.Is(err, ErrScheduleStoreMissing) {
		t.Fatalf("GenerateSchedule() error = %v, want ErrScheduleStoreMissing", err)
	}
	if len(store.generationFailures) != 0 || len(store.scheduleFailures) != 0 {
		t.Fatalf("unexpected failure writes: insight=%#v schedule=%#v", store.generationFailures, store.scheduleFailures)
	}
}

func TestProviderGeneratorGenerateScheduleCompletesAndRecordsDateRange(t *testing.T) {
	t.Parallel()

	model := "schedule-model"
	now := time.Date(2026, time.November, 8, 23, 30, 0, 0, aiInsightShanghaiLocationForAPI())
	store := newFakeAIInsightStore()
	store.schedule = &Schedule{
		ID:                7,
		ProjectID:         3,
		Country:           "US",
		InsightType:       "daily",
		DateRangeStrategy: "last_7d",
		Model:             &model,
		IsActive:          true,
	}
	store.scheduled = &GenerationContext{
		InsightID:      91,
		ProjectID:      3,
		ProjectName:    "Project",
		Country:        "US",
		InsightType:    "daily",
		DateRangeStart: "2026-11-01",
		DateRangeEnd:   "2026-11-07",
		Model:          &model,
	}
	provider := &fakeAIProvider{
		configured: true,
		content:    "# Scheduled report\nbody",
		usage:      ai.Usage{InputTokens: 4, OutputTokens: 6, TotalTokens: 10},
	}
	generator := NewProviderGeneratorWithConfig(store, provider, Config{Now: func() time.Time {
		return now
	}})

	result, err := generator.GenerateSchedule(context.Background(), 7)
	if err != nil {
		t.Fatalf("GenerateSchedule() error = %v", err)
	}
	if result.Title != "Scheduled report" || result.TotalTokens != 10 {
		t.Fatalf("GenerateSchedule() result = %#v", result)
	}
	if got := DateOnly(store.scheduledStarts[0]); got != "2026-11-01" {
		t.Fatalf("scheduled start = %s, want 2026-11-01", got)
	}
	if got := DateOnly(store.scheduledEnds[0]); got != "2026-11-07" {
		t.Fatalf("scheduled end = %s, want 2026-11-07", got)
	}
	if len(provider.requests) != 1 {
		t.Fatalf("provider requests = %d, want 1", len(provider.requests))
	}
	if provider.requests[0].Model != model {
		t.Fatalf("provider model = %q, want %q", provider.requests[0].Model, model)
	}
	if len(provider.requests[0].Messages) != 2 ||
		!strings.Contains(provider.requests[0].Messages[1].Content, "2026-11-01 to 2026-11-07") {
		t.Fatalf("provider messages = %#v", provider.requests[0].Messages)
	}
	if store.calls["generation_status"] != 2 || store.calls["generation_complete"] != 1 {
		t.Fatalf("generation calls = %#v", store.calls)
	}
	if len(store.generationFailures) != 0 || len(store.scheduleFailures) != 0 {
		t.Fatalf("unexpected failures: insight=%#v schedule=%#v", store.generationFailures, store.scheduleFailures)
	}
	if len(store.completedInsightIDs) != 1 || store.completedInsightIDs[0] != 91 {
		t.Fatalf("completed insight IDs = %#v, want [91]", store.completedInsightIDs)
	}
}

func TestProviderGeneratorGenerateScheduleRejectsMissingInactiveAndFrozen(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		schedule *Schedule
		config   Config
		wantErr  error
	}{
		{
			name:    "missing schedule",
			wantErr: ErrScheduleNotFound,
		},
		{
			name:     "inactive schedule",
			schedule: &Schedule{ID: 8, InsightType: "daily", IsActive: false},
			wantErr:  ErrScheduleInactive,
		},
		{
			name:     "frozen legacy domain",
			schedule: &Schedule{ID: 9, InsightType: "ad_analysis", IsActive: true},
			config:   Config{CanonicalDomains: "ad_analysis"},
			wantErr:  ErrDomainMigrated,
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			store := newFakeAIInsightStore()
			store.schedule = test.schedule
			provider := &fakeAIProvider{configured: true, content: "unused"}
			generator := NewProviderGeneratorWithConfig(store, provider, test.config)

			_, err := generator.GenerateSchedule(context.Background(), 7)
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("GenerateSchedule() error = %v, want %v", err, test.wantErr)
			}
			if store.calls["create_scheduled"] != 0 {
				t.Fatalf("CreateScheduledInsight calls = %d, want 0", store.calls["create_scheduled"])
			}
			if len(provider.requests) != 0 {
				t.Fatalf("provider requests = %d, want 0", len(provider.requests))
			}
		})
	}
}

func TestProviderGeneratorGenerateScheduleMarksFailures(t *testing.T) {
	t.Parallel()

	providerFailure := errors.New("provider unavailable")
	tests := []struct {
		name        string
		provider    ai.Provider
		wantErr     error
		wantMessage string
	}{
		{
			name:        "missing provider",
			provider:    nil,
			wantErr:     ErrProviderMissing,
			wantMessage: "AI provider is not configured",
		},
		{
			name:        "provider failure",
			provider:    &fakeAIProvider{configured: true, err: providerFailure},
			wantErr:     providerFailure,
			wantMessage: "AI provider is unavailable",
		},
		{
			name:        "empty completion",
			provider:    &fakeAIProvider{configured: true, content: "   "},
			wantErr:     ai.ErrEmptyCompletion,
			wantMessage: "AI provider returned empty content",
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			store := newFakeAIInsightStore()
			store.schedule = &Schedule{
				ID:                7,
				ProjectID:         3,
				Country:           "US",
				InsightType:       "daily",
				DateRangeStrategy: "yesterday",
				IsActive:          true,
			}
			store.scheduled = &GenerationContext{
				InsightID:      92,
				ProjectID:      3,
				ProjectName:    "Project",
				Country:        "US",
				InsightType:    "daily",
				DateRangeStart: "2026-11-07",
				DateRangeEnd:   "2026-11-07",
			}
			generator := NewProviderGenerator(store, test.provider)

			_, err := generator.GenerateSchedule(context.Background(), 7)
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("GenerateSchedule() error = %v, want %v", err, test.wantErr)
			}
			if len(store.generationFailureIDs) != 1 || store.generationFailureIDs[0] != 92 {
				t.Fatalf("generation failure IDs = %#v, want [92]", store.generationFailureIDs)
			}
			if len(store.scheduleFailureIDs) != 1 || store.scheduleFailureIDs[0] != 92 {
				t.Fatalf("schedule failure IDs = %#v, want [92]", store.scheduleFailureIDs)
			}
			if len(store.generationFailures) != 1 || store.generationFailures[0] != test.wantMessage {
				t.Fatalf("generation failure message = %#v, want %q", store.generationFailures, test.wantMessage)
			}
			if len(store.scheduleFailures) != 1 || store.scheduleFailures[0] != test.wantMessage {
				t.Fatalf("schedule failure message = %#v, want %q", store.scheduleFailures, test.wantMessage)
			}
			if store.calls["generation_complete"] != 0 {
				t.Fatalf("completion calls = %d, want 0", store.calls["generation_complete"])
			}
		})
	}
}

func TestProviderGeneratorGenerateScheduleDateStrategies(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.November, 8, 8, 0, 0, 0, aiInsightShanghaiLocationForAPI())
	tests := []struct {
		strategy  string
		wantStart string
		wantEnd   string
	}{
		{strategy: "yesterday", wantStart: "2026-11-07", wantEnd: "2026-11-07"},
		{strategy: "last_7d", wantStart: "2026-11-01", wantEnd: "2026-11-07"},
		{strategy: "last_30d", wantStart: "2026-10-09", wantEnd: "2026-11-07"},
		{strategy: "prev_month", wantStart: "2026-10-01", wantEnd: "2026-10-31"},
		{strategy: "current_month", wantStart: "2026-11-01", wantEnd: "2026-11-07"},
		{strategy: "last_week", wantStart: "2026-10-26", wantEnd: "2026-11-01"},
		{strategy: "unknown", wantStart: "2026-11-07", wantEnd: "2026-11-07"},
	}

	for _, test := range tests {
		test := test
		t.Run(test.strategy, func(t *testing.T) {
			t.Parallel()

			store := newFakeAIInsightStore()
			store.schedule = &Schedule{
				ID:                7,
				ProjectID:         3,
				Country:           "US",
				InsightType:       "daily",
				DateRangeStrategy: test.strategy,
				IsActive:          true,
			}
			store.scheduled = &GenerationContext{
				InsightID:      93,
				ProjectID:      3,
				ProjectName:    "Project",
				Country:        "US",
				InsightType:    "daily",
				DateRangeStart: test.wantStart,
				DateRangeEnd:   test.wantEnd,
			}
			generator := NewProviderGeneratorWithConfig(
				store,
				&fakeAIProvider{configured: true, content: "# report"},
				Config{Now: func() time.Time { return now }},
			)

			if _, err := generator.GenerateSchedule(context.Background(), 7); err != nil {
				t.Fatalf("GenerateSchedule() error = %v", err)
			}
			if got := DateOnly(store.scheduledStarts[0]); got != test.wantStart {
				t.Fatalf("start = %s, want %s", got, test.wantStart)
			}
			if got := DateOnly(store.scheduledEnds[0]); got != test.wantEnd {
				t.Fatalf("end = %s, want %s", got, test.wantEnd)
			}
		})
	}
}
