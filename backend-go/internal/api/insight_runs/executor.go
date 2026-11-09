package insight_runs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
)

func (executor *Executor) Execute(ctx context.Context, runID string, attempt int) error {
	if executor == nil || executor.store == nil {
		return errors.New("insight run executor store is not configured")
	}
	run, err := executor.store.LoadRunExecution(ctx, runID)
	if err != nil {
		return err
	}
	if run.Attempt != attempt || isTerminal(run.Status) {
		return nil
	}
	if executor.provider == nil || !executor.provider.Configured() {
		runErr := &Error{Code: "PROVIDER_UNAVAILABLE", Message: "Insight AI provider is not configured", Retryable: false}
		_, _ = executor.store.RunTransition(ctx, runID, attempt, "failed", run.Stage, run.ProgressPercent, nil, nil, nil, runErr)
		executor.publish(ctx, run, Event{Type: "error", Status: "failed", Error: runErr})
		return ErrProviderNotConfigured
	}
	executor.publish(ctx, run, Event{
		Type: "snapshot", Status: run.Status, Stage: run.Stage,
		ProgressPercent: intPointer(run.ProgressPercent), IsTerminal: boolPointer(false),
	})
	applied, err := executor.store.RunTransition(ctx, runID, attempt, "aggregating", "aggregating", 10, nil, nil, nil, nil)
	if err != nil {
		return err
	}
	if !applied {
		return nil
	}
	run.Status, run.Stage, run.ProgressPercent = "aggregating", "aggregating", 10
	executor.publish(ctx, run, Event{Type: "status", Status: "aggregating", Stage: "aggregating", ProgressPercent: intPointer(10)})

	applied, err = executor.store.RunTransition(ctx, runID, attempt, "generating", "generating", 25, nil, nil, nil, nil)
	if err != nil {
		return err
	}
	if !applied {
		return nil
	}
	run.Status, run.Stage, run.ProgressPercent = "generating", "generating", 25
	executor.publish(ctx, run, Event{Type: "status", Status: "generating", Stage: "generating", ProgressPercent: intPointer(25)})

	prompt, err := buildRunPrompt(run)
	if err != nil {
		runErr := &Error{Code: "INVALID_REQUEST", Message: "Stored run slots are invalid", Retryable: false}
		_, _ = executor.store.RunTransition(ctx, runID, attempt, "failed", "generating", 25, nil, nil, nil, runErr)
		executor.publish(ctx, run, Event{Type: "error", Status: "failed", Error: runErr})
		return err
	}
	var builder strings.Builder
	usage, streamErr := executor.provider.Stream(ctx, ai.ChatRequest{
		Model: run.ModelID,
		Messages: []ai.Message{
			{Role: "system", Content: "You are the canonical Insight executor. Return only the requested Markdown artifact."},
			{Role: "user", Content: prompt},
		},
		Temperature: 0.3,
	}, func(chunk ai.Chunk) error {
		if chunk.Type != ai.ChunkContent || chunk.Text == "" {
			return nil
		}
		builder.WriteString(chunk.Text)
		executor.publish(ctx, run, Event{
			Type: "content.delta", Slot: "main", BlockID: "stream",
			Format: "markdown", Delta: chunk.Text,
		})
		return nil
	})
	if streamErr != nil {
		runErr := classifyProviderError(streamErr)
		_, _ = executor.store.RunTransition(ctx, runID, attempt, "failed", "generating", 25, nil, nil, nil, runErr)
		executor.publish(ctx, run, Event{Type: "error", Status: "failed", Error: runErr})
		return streamErr
	}
	content := builder.String()
	if strings.TrimSpace(content) == "" {
		runErr := &Error{Code: "PROVIDER_UNAVAILABLE", Message: "Insight provider returned empty content", Retryable: true}
		_, _ = executor.store.RunTransition(ctx, runID, attempt, "failed", "generating", 25, nil, nil, nil, runErr)
		executor.publish(ctx, run, Event{Type: "error", Status: "failed", Error: runErr})
		return ai.ErrEmptyCompletion
	}
	summary := sha256.Sum256([]byte(content))
	digest := hex.EncodeToString(summary[:])
	outputs := map[string]Output{"main": {Format: "markdown", Content: content, ContentSHA256: digest}}
	usagePayload := &Usage{InputTokens: usage.InputTokens, OutputTokens: usage.OutputTokens, TotalTokens: usage.TotalTokens}
	applied, err = executor.store.RunTransition(ctx, runID, attempt, "finalizing", "finalizing", 90, usagePayload, nil, &content, nil)
	if err != nil {
		return err
	}
	if !applied {
		return nil
	}
	run.Status, run.Stage, run.ProgressPercent = "finalizing", "finalizing", 90
	executor.publish(ctx, run, Event{Type: "status", Status: "finalizing", Stage: "finalizing", ProgressPercent: intPointer(90)})

	applied, err = executor.store.RunTransition(ctx, runID, attempt, "completed", "finalizing", 100, usagePayload, outputs, &content, nil)
	if err != nil {
		return err
	}
	if !applied {
		return nil
	}
	run.Status, run.Stage, run.ProgressPercent = "completed", "finalizing", 100
	title := firstMarkdownTitle(content)
	var titlePtr *string
	if title != "" {
		titlePtr = &title
	}
	checkpointSeq := 1
	executor.publish(ctx, run, Event{
		Type: "content.snapshot", Slot: "main", Format: "markdown",
		Content: content, ContentSHA256: digest, CheckpointSeq: checkpointSeq,
	})
	executor.publish(ctx, run, Event{
		Type: "done", Status: "completed", Outputs: outputs, Title: titlePtr,
		Usage: usagePayload, ContentSHA256: digest,
	})
	return nil
}

func (executor *Executor) publish(ctx context.Context, run *Run, event Event) {
	if executor == nil || executor.events == nil {
		return
	}
	event.SchemaVersion = 1
	event.RunID = run.RunID
	event.Attempt = run.Attempt
	_, _ = executor.events.Append(ctx, run.RunID, event)
}

func buildRunPrompt(run *Run) (string, error) {
	var slots map[string]any
	if err := json.Unmarshal(run.SlotsJSON, &slots); err != nil {
		return "", fmt.Errorf("decode stored slots: %w", err)
	}
	payload, err := json.Marshal(map[string]any{
		"role_id":      run.RoleID,
		"role_version": run.RoleVersion,
		"project_id":   run.ProjectID,
		"country":      run.Country,
		"slots":        slots,
	})
	if err != nil {
		return "", err
	}
	return "Generate the Markdown output for this canonical Insight request. Use only the supplied slots and do not invent metrics.\n\n" + string(payload), nil
}

func classifyProviderError(err error) *Error {
	var providerErr *ai.ProviderError
	if errors.As(err, &providerErr) {
		switch providerErr.StatusCode {
		case 429:
			return &Error{Code: "RATE_LIMITED", Message: "Insight provider rate limit reached", Retryable: true}
		case 408, 504:
			return &Error{Code: "UPSTREAM_TIMEOUT", Message: "Insight provider timed out", Retryable: true}
		case 401, 403, 404:
			return &Error{Code: "MODEL_NOT_ALLOWED", Message: "Insight provider rejected the selected model", Retryable: false}
		}
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return &Error{Code: "UPSTREAM_TIMEOUT", Message: "Insight provider request was interrupted", Retryable: true}
	}
	return &Error{Code: "PROVIDER_UNAVAILABLE", Message: "Insight provider is unavailable", Retryable: true}
}
