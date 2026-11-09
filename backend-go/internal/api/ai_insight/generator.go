package ai_insight

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
)

type GenerationContext struct {
	InsightID      int64
	ProjectID      int64
	ProjectName    string
	Country        string
	InsightType    string
	DateRangeStart string
	DateRangeEnd   string
	FocusAreas     []string
	Model          *string
	StrategyMeta   *string
}

type GenerationResult struct {
	Title        string
	Content      string
	InputTokens  int
	OutputTokens int
	TotalTokens  int
}

type providerCallError struct {
	err error
}

func (err *providerCallError) Error() string { return err.err.Error() }
func (err *providerCallError) Unwrap() error { return err.err }

type GeneratorStore interface {
	LoadGenerationContext(ctx context.Context, insightID int64) (*GenerationContext, error)
	SetGenerationStatus(ctx context.Context, insightID int64, status, subStatus string) error
	CompleteGeneration(ctx context.Context, insightID int64, title, content string) error
	FailGeneration(ctx context.Context, insightID int64, message string) error
}

// ScheduleGeneratorStore is the schedule-only persistence seam used by
// queue.TypeGenerateInsight when the job carries only schedule_id.
type ScheduleGeneratorStore interface {
	GetSchedule(ctx context.Context, scheduleID int64) (*Schedule, error)
	CreateScheduledInsight(ctx context.Context, scheduleID int64, start, end time.Time) (*GenerationContext, error)
	FailScheduleRun(ctx context.Context, scheduleID, insightID int64, message string) error
}

// Generator is the unit executed by queue.TypeGenerateInsight.
type Generator interface {
	Generate(ctx context.Context, insightID int64) (GenerationResult, error)
}

// ScheduleGenerator is the schedule-only variant of Generator. Existing
// task wiring can use a type assertion when GenerateInsightPayload has only
// schedule_id; insight-only Generate semantics remain unchanged.
type ScheduleGenerator interface {
	GenerateSchedule(ctx context.Context, scheduleID int64) (GenerationResult, error)
}

type ProviderGenerator struct {
	store            GeneratorStore
	scheduleStore    ScheduleGeneratorStore
	provider         ai.Provider
	canonicalDomains string
	now              func() time.Time
}

var (
	_ Generator         = (*ProviderGenerator)(nil)
	_ ScheduleGenerator = (*ProviderGenerator)(nil)
)

func NewProviderGenerator(store GeneratorStore, provider ai.Provider) *ProviderGenerator {
	return NewProviderGeneratorWithConfig(store, provider, Config{})
}

func NewProviderGeneratorWithConfig(store GeneratorStore, provider ai.Provider, cfg Config) *ProviderGenerator {
	cfg = cfg.normalized()
	scheduleStore, _ := store.(ScheduleGeneratorStore)
	return &ProviderGenerator{
		store:            store,
		scheduleStore:    scheduleStore,
		provider:         provider,
		canonicalDomains: cfg.CanonicalDomains,
		now:              cfg.Now,
	}
}

func (generator *ProviderGenerator) Generate(ctx context.Context, insightID int64) (GenerationResult, error) {
	if generator == nil || generator.store == nil {
		return GenerationResult{}, errors.New("insight generator store is not configured")
	}
	insight, err := generator.store.LoadGenerationContext(ctx, insightID)
	if err != nil {
		return GenerationResult{}, err
	}
	return generator.generateFromContext(ctx, insight)
}

func (generator *ProviderGenerator) GenerateSchedule(ctx context.Context, scheduleID int64) (GenerationResult, error) {
	if generator == nil || generator.store == nil {
		return GenerationResult{}, errors.New("insight generator store is not configured")
	}
	if generator.scheduleStore == nil {
		return GenerationResult{}, ErrScheduleStoreMissing
	}
	schedule, err := generator.scheduleStore.GetSchedule(ctx, scheduleID)
	if err != nil {
		return GenerationResult{}, err
	}
	if schedule == nil {
		return GenerationResult{}, ErrScheduleNotFound
	}
	if !schedule.IsActive {
		return GenerationResult{}, ErrScheduleInactive
	}
	if roleID := LegacyDomainRole(schedule.InsightType); roleID != "" &&
		IsDomainCanonical(generator.canonicalDomains, roleID) {
		return GenerationResult{}, fmt.Errorf("%w: %s", ErrDomainMigrated, roleID)
	}
	now := time.Now
	if generator.now != nil {
		now = generator.now
	}
	reference := now().In(aiInsightShanghaiLocationForAPI())
	start, end := CalculateDateRange(schedule.DateRangeStrategy, reference)
	insight, err := generator.scheduleStore.CreateScheduledInsight(ctx, scheduleID, start, end)
	if err != nil {
		return GenerationResult{}, err
	}
	if insight == nil {
		return GenerationResult{}, errors.New("scheduled insight creation returned no row")
	}
	result, err := generator.generateFromContextWithFailureHandling(ctx, insight, false)
	if err != nil {
		return GenerationResult{}, generator.failScheduledGeneration(
			ctx,
			scheduleID,
			insight.InsightID,
			err,
		)
	}
	return result, nil
}

func (generator *ProviderGenerator) generateFromContext(ctx context.Context, insight *GenerationContext) (GenerationResult, error) {
	return generator.generateFromContextWithFailureHandling(ctx, insight, true)
}

func (generator *ProviderGenerator) generateFromContextWithFailureHandling(
	ctx context.Context,
	insight *GenerationContext,
	markInsightFailure bool,
) (GenerationResult, error) {
	if insight == nil {
		return GenerationResult{}, errors.New("insight generation context is nil")
	}
	if generator.provider == nil || !generator.provider.Configured() {
		message := "AI provider is not configured"
		if markInsightFailure && generator.store != nil {
			_ = generator.store.FailGeneration(ctx, insight.InsightID, message)
		}
		return GenerationResult{}, ErrProviderMissing
	}
	if generator.store == nil {
		return GenerationResult{}, errors.New("insight generator store is not configured")
	}
	if err := generator.store.SetGenerationStatus(ctx, insight.InsightID, "generating", "data_aggregating"); err != nil {
		return GenerationResult{}, err
	}
	if err := generator.store.SetGenerationStatus(ctx, insight.InsightID, "generating", "ai_generating"); err != nil {
		return GenerationResult{}, err
	}

	prompt := buildLegacyPrompt(insight)
	model := ""
	if insight.Model != nil {
		model = strings.TrimSpace(*insight.Model)
	}
	content, usage, err := generator.provider.Complete(ctx, ai.ChatRequest{
		Model: model,
		Messages: []ai.Message{
			{Role: "system", Content: "You are a senior cross-border ecommerce analyst. Return only the requested Markdown report."},
			{Role: "user", Content: prompt},
		},
		Temperature: 0.4,
	})
	if err != nil {
		message := providerFailureMessage(err)
		if markInsightFailure {
			_ = generator.store.FailGeneration(ctx, insight.InsightID, message)
		}
		return GenerationResult{}, fmt.Errorf(
			"generate insight %d: %w",
			insight.InsightID,
			&providerCallError{err: err},
		)
	}
	content = strings.TrimSpace(content)
	if content == "" {
		message := "AI provider returned empty content"
		if markInsightFailure {
			_ = generator.store.FailGeneration(ctx, insight.InsightID, message)
		}
		return GenerationResult{}, ai.ErrEmptyCompletion
	}
	title := deriveTitle(content, insight.InsightType)
	if err := generator.store.CompleteGeneration(ctx, insight.InsightID, title, content); err != nil {
		return GenerationResult{}, err
	}
	return GenerationResult{
		Title:        title,
		Content:      content,
		InputTokens:  usage.InputTokens,
		OutputTokens: usage.OutputTokens,
		TotalTokens:  usage.TotalTokens,
	}, nil
}

func (generator *ProviderGenerator) failScheduledGeneration(
	ctx context.Context,
	scheduleID, insightID int64,
	cause error,
) error {
	message := failureMessage(cause)
	failures := []error{cause}
	if err := generator.store.FailGeneration(ctx, insightID, message); err != nil {
		failures = append(failures, fmt.Errorf("mark scheduled insight failed: %w", err))
	}
	if err := generator.scheduleStore.FailScheduleRun(ctx, scheduleID, insightID, message); err != nil {
		failures = append(failures, fmt.Errorf("mark insight schedule failed: %w", err))
	}
	return errors.Join(failures...)
}

func failureMessage(err error) string {
	if err == nil {
		return "scheduled insight generation failed"
	}
	if errors.Is(err, ErrProviderMissing) ||
		errors.Is(err, ai.ErrProviderNotConfigured) ||
		errors.Is(err, ai.ErrEmptyCompletion) {
		return providerFailureMessage(err)
	}
	var providerErr *ai.ProviderError
	if errors.As(err, &providerErr) {
		return providerFailureMessage(err)
	}
	var callErr *providerCallError
	if errors.As(err, &callErr) {
		return providerFailureMessage(callErr.err)
	}
	var networkErr net.Error
	if errors.As(err, &networkErr) {
		return providerFailureMessage(err)
	}
	message := strings.TrimSpace(err.Error())
	if message == "" {
		return "scheduled insight generation failed"
	}
	return message
}

func aiInsightShanghaiLocationForAPI() *time.Location {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return time.FixedZone("CST", 8*60*60)
	}
	return location
}

func providerFailureMessage(err error) string {
	var providerErr *ai.ProviderError
	if errors.As(err, &providerErr) {
		switch providerErr.StatusCode {
		case 429:
			return "AI provider rate limit reached"
		case 408, 504:
			return "AI provider timed out"
		case 401, 403, 404:
			return "AI provider rejected the request"
		}
	}
	if errors.Is(err, ai.ErrProviderNotConfigured) {
		return "AI provider is not configured"
	}
	if errors.Is(err, ErrProviderMissing) {
		return "AI provider is not configured"
	}
	if errors.Is(err, ai.ErrEmptyCompletion) {
		return "AI provider returned empty content"
	}
	return "AI provider is unavailable"
}

func buildLegacyPrompt(insight *GenerationContext) string {
	var builder strings.Builder
	builder.WriteString("Generate a concise, evidence-led ecommerce insight report in Markdown.\n")
	fmt.Fprintf(&builder, "Project: %s (id=%d, country=%s)\n", insight.ProjectName, insight.ProjectID, insight.Country)
	fmt.Fprintf(&builder, "Insight type: %s\nDate range: %s to %s\n", insight.InsightType, insight.DateRangeStart, insight.DateRangeEnd)
	if len(insight.FocusAreas) > 0 {
		fmt.Fprintf(&builder, "Focus areas: %s\n", strings.Join(insight.FocusAreas, ", "))
	}
	if insight.StrategyMeta != nil && strings.TrimSpace(*insight.StrategyMeta) != "" {
		fmt.Fprintf(&builder, "Prior strategy metadata: %s\n", *insight.StrategyMeta)
	}
	builder.WriteString("Use headings, quantified observations where available, risks, and concrete next actions. Do not invent metrics.")
	return builder.String()
}

func deriveTitle(content, insightType string) string {
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		line = strings.TrimLeft(line, "# ")
		if line != "" {
			runes := []rune(line)
			if len(runes) > 255 {
				runes = runes[:255]
			}
			return string(runes)
		}
	}
	if insightType == "" {
		insightType = "custom"
	}
	return "AI Insight - " + insightType
}
