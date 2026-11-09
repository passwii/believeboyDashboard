package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/insight_domains"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/insight_observation"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/insight_runs"
)

var (
	_ insight_runs.Store        = (*AIInsightStore)(nil)
	_ insight_domains.Store     = (*AIInsightStore)(nil)
	_ insight_observation.Store = (*AIInsightStore)(nil)
)

const canonicalRunColumns = `
	run_id, attempt, capability, use_case, project_id, country, role_id,
	role_version, endpoint_id, model_id, status, stage, progress_percent,
	idempotency_key, request_fingerprint, slots_json, status_timeline_json,
	usage_json, outputs_json, content_markdown, error_json, duration_ms,
	created_at, started_at, completed_at, updated_at`

func scanCanonicalRun(row pgx.Row) (*insight_runs.Run, error) {
	var run insight_runs.Run
	err := row.Scan(
		&run.RunID, &run.Attempt, &run.Capability, &run.UseCase, &run.ProjectID,
		&run.Country, &run.RoleID, &run.RoleVersion, &run.EndpointID, &run.ModelID,
		&run.Status, &run.Stage, &run.ProgressPercent, &run.IdempotencyKey,
		&run.RequestFingerprint, &run.SlotsJSON, &run.StatusTimelineJSON,
		&run.UsageJSON, &run.OutputsJSON, &run.ContentMarkdown, &run.ErrorJSON,
		&run.DurationMS, &run.CreatedAt, &run.StartedAt, &run.CompletedAt, &run.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &run, nil
}

func (s *AIInsightStore) CreateRun(ctx context.Context, input insight_runs.CreateRunInput, meta ai_insight.MutationMeta) (*insight_runs.Run, bool, error) {
	var created *insight_runs.Run
	replayed := false
	errCreate := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		existing, err := scanCanonicalRun(txDB.QueryRow(
			ctx,
			`select `+canonicalRunColumns+`
			 from public.insight_runs
			 where project_id=$1 and country=$2 and idempotency_key=$3
			 for update`,
			input.ProjectID, input.Country, input.IdempotencyKey,
		))
		if err == nil {
			if existing.RequestFingerprint != input.Fingerprint {
				return insight_runs.ErrIdempotencyConflict
			}
			created = existing
			replayed = true
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		runID, err := ai_insight.NewUUID()
		if err != nil {
			return err
		}
		capability := strings.TrimSpace(input.Capability)
		if capability == "" {
			capability = "insight"
		}
		endpointID := strings.TrimSpace(input.EndpointID)
		if endpointID == "" {
			endpointID = "default"
		}
		timeline, _ := json.Marshal([]map[string]any{{
			"status": "queued", "attempt": 1,
			"at": time.Now().UTC().Format("2006-01-02T15:04:05Z"),
		}})
		createdRow, err := scanCanonicalRun(txDB.QueryRow(
			ctx,
			`insert into public.insight_runs (
				run_id, attempt, capability, use_case, project_id, country, role_id,
				role_version, endpoint_id, model_id, status, stage, progress_percent,
				idempotency_key, request_fingerprint, slots_json, status_timeline_json,
				created_at, updated_at
			 ) values ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,'queued','queued',0,$10,$11,$12::jsonb,$13::jsonb,now(),now())
			 returning `+canonicalRunColumns,
			runID, capability, fmt.Sprintf("%s.v%d", input.RoleID, input.RoleVersion),
			input.ProjectID, input.Country, input.RoleID, input.RoleVersion,
			endpointID, input.ModelID, input.IdempotencyKey, input.Fingerprint,
			input.SlotsJSON, timeline,
		))
		if err != nil {
			return err
		}
		created = createdRow
		return s.logActionTx(ctx, tx, ai_insight.AuditEntry(
			meta, "insight_runs.create", "insight_run", created.RunID, nil, runAuditPayload(created), nil,
		))
	})
	if errCreate != nil {
		var pgErr *pgconn.PgError
		if errors.As(errCreate, &pgErr) && pgErr.Code == "23505" {
			raced, err := s.getRunByScopeKey(ctx, input.ProjectID, input.Country, input.IdempotencyKey)
			if err != nil {
				return nil, false, err
			}
			if raced.RequestFingerprint != input.Fingerprint {
				return nil, false, insight_runs.ErrIdempotencyConflict
			}
			return raced, true, nil
		}
		return nil, false, errCreate
	}
	return created, replayed, nil
}

func (s *AIInsightStore) getRunByScopeKey(ctx context.Context, projectID int64, country, idempotencyKey string) (*insight_runs.Run, error) {
	run, err := scanCanonicalRun(s.db.QueryRow(
		ctx,
		`select `+canonicalRunColumns+`
		 from public.insight_runs
		 where project_id=$1 and country=$2 and idempotency_key=$3`,
		projectID, country, idempotencyKey,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, insight_runs.ErrRunNotFound
	}
	return run, err
}

func (s *AIInsightStore) GetRun(ctx context.Context, runID string) (*insight_runs.Run, error) {
	run, err := scanCanonicalRun(s.db.QueryRow(
		ctx,
		`select `+canonicalRunColumns+` from public.insight_runs where run_id=$1`,
		strings.ToLower(strings.TrimSpace(runID)),
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, insight_runs.ErrRunNotFound
	}
	return run, err
}

func (s *AIInsightStore) LoadRunExecution(ctx context.Context, runID string) (*insight_runs.Run, error) {
	return s.GetRun(ctx, runID)
}

func (s *AIInsightStore) CancelRun(ctx context.Context, runID string, meta ai_insight.MutationMeta) (*insight_runs.Run, bool, error) {
	var cancelled *insight_runs.Run
	alreadyTerminal := false
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		run, err := scanCanonicalRun(txDB.QueryRow(
			ctx,
			`select `+canonicalRunColumns+` from public.insight_runs where run_id=$1 for update`,
			strings.ToLower(strings.TrimSpace(runID)),
		))
		if errors.Is(err, pgx.ErrNoRows) {
			return insight_runs.ErrRunNotFound
		}
		if err != nil {
			return err
		}
		if terminalRunStatus(run.Status) {
			cancelled = run
			alreadyTerminal = true
			if s.observationEnabled {
				return upsertRunObservationTx(ctx, txDB, run, true, false)
			}
			return nil
		}
		runErr := &insight_runs.Error{Code: "CANCELLED", Message: "Insight run cancelled", Retryable: false}
		errorJSON, _ := json.Marshal(runErr)
		timeline := appendRunTimeline(run.StatusTimelineJSON, "cancelled", run.Attempt)
		now := time.Now().UTC()
		duration := durationFromStart(run, now)
		updated, err := scanCanonicalRun(txDB.QueryRow(
			ctx,
			`update public.insight_runs set
				status='cancelled', progress_percent=$1, status_timeline_json=$2::jsonb,
				error_json=$3::jsonb, completed_at=$4, duration_ms=$5, updated_at=$4
			 where run_id=$6 returning `+canonicalRunColumns,
			run.ProgressPercent, timeline, errorJSON, now, duration, run.RunID,
		))
		if err != nil {
			return err
		}
		cancelled = updated
		if s.observationEnabled {
			if err := upsertRunObservationTx(ctx, txDB, updated, true, true); err != nil {
				return err
			}
		}
		return s.logActionTx(ctx, tx, ai_insight.AuditEntry(meta, "insight_runs.cancel", "insight_run", run.RunID, runAuditPayload(run), runAuditPayload(updated), nil))
	})
	return cancelled, alreadyTerminal, err
}

func (s *AIInsightStore) RetryRun(ctx context.Context, runID string, meta ai_insight.MutationMeta) (*insight_runs.Run, error) {
	var retried *insight_runs.Run
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		run, err := scanCanonicalRun(txDB.QueryRow(
			ctx,
			`select `+canonicalRunColumns+` from public.insight_runs where run_id=$1 for update`,
			strings.ToLower(strings.TrimSpace(runID)),
		))
		if errors.Is(err, pgx.ErrNoRows) {
			return insight_runs.ErrRunNotFound
		}
		if err != nil {
			return err
		}
		if run.Status == "completed" || terminalRunStatus(run.Status) && run.Status != "failed" && run.Status != "cancelled" {
			return insight_runs.ErrRunTerminal
		}
		if run.Status != "failed" && run.Status != "cancelled" {
			return insight_runs.ErrInvalidTransition
		}
		nextAttempt := run.Attempt + 1
		timeline := appendRunTimeline(run.StatusTimelineJSON, "queued", nextAttempt)
		updated, err := scanCanonicalRun(txDB.QueryRow(
			ctx,
			`update public.insight_runs set
				attempt=$1, status='queued', stage='queued', progress_percent=0,
				usage_json=null, outputs_json=null, content_markdown=null, error_json=null,
				started_at=null, completed_at=null, duration_ms=null,
				status_timeline_json=$2::jsonb, updated_at=now()
			 where run_id=$3 returning `+canonicalRunColumns,
			nextAttempt, string(timeline), run.RunID,
		))
		if err != nil {
			return err
		}
		retried = updated
		return s.logActionTx(ctx, tx, ai_insight.AuditEntry(meta, "insight_runs.retry", "insight_run", run.RunID, runAuditPayload(run), runAuditPayload(updated), nil))
	})
	return retried, err
}

func (s *AIInsightStore) RunTransition(
	ctx context.Context,
	runID string,
	attempt int,
	target string,
	stage string,
	progress int,
	usage *insight_runs.Usage,
	outputs map[string]insight_runs.Output,
	content *string,
	runErr *insight_runs.Error,
) (bool, error) {
	applied := false
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		run, err := scanCanonicalRun(txDB.QueryRow(
			ctx,
			`select `+canonicalRunColumns+` from public.insight_runs where run_id=$1 for update`,
			strings.ToLower(strings.TrimSpace(runID)),
		))
		if errors.Is(err, pgx.ErrNoRows) {
			return insight_runs.ErrRunNotFound
		}
		if err != nil {
			return err
		}
		if run.Attempt != attempt || !transitionAllowed(run.Status, target) {
			return nil
		}
		now := time.Now().UTC()
		values := map[string]any{}
		timeline := appendRunTimeline(run.StatusTimelineJSON, target, attempt)
		usageJSON := run.UsageJSON
		outputsJSON := run.OutputsJSON
		errorJSON := run.ErrorJSON
		contentMarkdown := run.ContentMarkdown
		if usage != nil {
			if raw, err := json.Marshal(usage); err == nil {
				usageJSON = raw
			}
		}
		if outputs != nil {
			if raw, err := json.Marshal(outputs); err == nil {
				outputsJSON = raw
			}
		}
		if runErr != nil {
			if raw, err := json.Marshal(runErr); err == nil {
				errorJSON = raw
			}
		}
		if content != nil {
			contentMarkdown = content
		}
		values["status"] = target
		if stage != "" {
			values["stage"] = stage
		}
		values["progress_percent"] = progress
		values["status_timeline_json"] = string(timeline)
		values["usage_json"] = nullableJSON(usageJSON)
		values["outputs_json"] = nullableJSON(outputsJSON)
		values["content_markdown"] = contentMarkdown
		values["error_json"] = nullableJSON(errorJSON)
		values["updated_at"] = now
		if terminalRunStatus(target) {
			values["completed_at"] = now
			values["duration_ms"] = durationFromStart(run, now)
		} else if run.StartedAt == nil {
			values["started_at"] = now
		}
		tag, err := tx.Exec(ctx,
			`update public.insight_runs set
				status=$1, stage=coalesce(nullif($2,''), stage),
				progress_percent=$3, status_timeline_json=$4,
				usage_json=$5::jsonb, outputs_json=$6::jsonb, content_markdown=$7, error_json=$8::jsonb,
				started_at=coalesce(started_at,$9::timestamptz),
				completed_at=$10::timestamptz, duration_ms=$11::int,
				updated_at=$12
			 where run_id=$13 and attempt=$14`,
			target, stage, progress, timeline, nullableJSON(usageJSON),
			nullableJSON(outputsJSON), contentMarkdown, nullableJSON(errorJSON),
			values["started_at"], values["completed_at"], values["duration_ms"],
			now, run.RunID, attempt,
		)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		updated, err := scanCanonicalRun(txDB.QueryRow(ctx, `select `+canonicalRunColumns+` from public.insight_runs where run_id=$1`, run.RunID))
		if err != nil {
			return err
		}
		if terminalRunStatus(target) {
			if s.observationEnabled {
				if err := upsertRunObservationTx(ctx, txDB, updated, false, false); err != nil {
					return err
				}
			}
		}
		applied = true
		operator := "system:insight-worker"
		return s.logActionTx(ctx, tx, ai_insight.AuditEntry(ai_insight.MutationMeta{Operator: operator}, "insight_runs.transition", "insight_run", run.RunID, runAuditPayload(run), runAuditPayload(updated), nil))
	})
	return applied, err
}

func nullableJSON(raw []byte) any {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	return raw
}

func terminalRunStatus(status string) bool {
	return status == "completed" || status == "failed" || status == "cancelled"
}

func transitionAllowed(current, target string) bool {
	if terminalRunStatus(current) {
		return false
	}
	switch target {
	case "aggregating":
		return current == "queued"
	case "generating":
		return current == "queued" || current == "aggregating"
	case "finalizing":
		return current == "queued" || current == "aggregating" || current == "generating"
	case "completed":
		return current == "finalizing"
	case "failed", "cancelled":
		return !terminalRunStatus(current)
	default:
		return false
	}
}

func appendRunTimeline(raw []byte, status string, attempt int) []byte {
	entries := make([]map[string]any, 0)
	_ = json.Unmarshal(raw, &entries)
	entries = append(entries, map[string]any{
		"status": status, "attempt": attempt,
		"at": time.Now().UTC().Format("2006-01-02T15:04:05Z"),
	})
	result, _ := json.Marshal(entries)
	return result
}

func durationFromStart(run *insight_runs.Run, now time.Time) int {
	if run == nil || run.StartedAt == nil {
		return 0
	}
	millis := int(now.Sub(run.StartedAt.UTC()).Milliseconds())
	if millis < 0 {
		return 0
	}
	return millis
}

func (s *AIInsightStore) RecordStreamMetric(ctx context.Context, runID string, reconnect, reconnectCompleted bool) error {
	if s == nil {
		return errors.New("AI insight store is not configured")
	}
	if !s.observationEnabled {
		return nil
	}
	run, err := s.GetRun(ctx, runID)
	if err != nil {
		return err
	}
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		opened := 0
		reconnects := 0
		completed := false
		if reconnect {
			opened = 1
			reconnects = 1
		} else if !reconnectCompleted {
			opened = 1
		}
		completed = reconnectCompleted
		_, err := tx.Exec(
			ctx,
			`insert into public.insight_run_observations (
				source, run_id, attempt, capability, role_id, endpoint_id, model_id,
				status, stream_opens, stream_reconnects, reconnect_completed,
				created_at, updated_at
			 ) values ('insight_run',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())
			 on conflict (run_id) do update set
				stream_opens=insight_run_observations.stream_opens + excluded.stream_opens,
				stream_reconnects=insight_run_observations.stream_reconnects + excluded.stream_reconnects,
				reconnect_completed=insight_run_observations.reconnect_completed or excluded.reconnect_completed,
				updated_at=now()`,
			run.RunID, run.Attempt, run.Capability, run.RoleID, run.EndpointID, run.ModelID,
			run.Status, opened, reconnects, completed,
		)
		return err
	})
}

func upsertRunObservationTx(ctx context.Context, db FullDB, run *insight_runs.Run, cancelRequested, cancelSucceeded bool) error {
	var usage insight_runs.Usage
	if len(run.UsageJSON) > 0 {
		_ = json.Unmarshal(run.UsageJSON, &usage)
	}
	var runErr insight_runs.Error
	if len(run.ErrorJSON) > 0 {
		_ = json.Unmarshal(run.ErrorJSON, &runErr)
	}
	var errorCode any
	if runErr.Code != "" {
		errorCode = runErr.Code
	}
	var cancelSucceededValue any
	if cancelRequested {
		cancelSucceededValue = cancelSucceeded
	}
	_, err := db.Exec(
		ctx,
		`insert into public.insight_run_observations (
			source, run_id, attempt, capability, role_id, endpoint_id, model_id,
			status, duration_ms, input_tokens, output_tokens, total_tokens,
			attempts, retries, cancel_requested, cancel_succeeded, error_code,
			error_retryable, created_at, updated_at
		 ) values (
			'insight_run',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),now()
		 )
		 on conflict (run_id) do update set
			status=excluded.status, duration_ms=excluded.duration_ms,
			input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
			total_tokens=excluded.total_tokens, attempts=excluded.attempts,
			retries=excluded.retries, cancel_requested=excluded.cancel_requested,
			cancel_succeeded=excluded.cancel_succeeded, error_code=excluded.error_code,
			error_retryable=excluded.error_retryable, updated_at=now()`,
		run.RunID, run.Attempt, run.Capability, run.RoleID, run.EndpointID, run.ModelID,
		run.Status, run.DurationMS, nullableInt(usage.InputTokens, len(run.UsageJSON) > 0),
		nullableInt(usage.OutputTokens, len(run.UsageJSON) > 0),
		nullableInt(usage.TotalTokens, len(run.UsageJSON) > 0),
		run.Attempt, maxIntZero(run.Attempt-1), cancelRequested, cancelSucceededValue,
		errorCode, nullableBool(runErr.Retryable, runErr.Code != ""),
	)
	return err
}

func nullableInt(value int, valid bool) any {
	if !valid {
		return nil
	}
	return value
}

func nullableBool(value bool, valid bool) any {
	if !valid {
		return nil
	}
	return value
}

func maxIntZero(value int) int {
	if value < 0 {
		return 0
	}
	return value
}

func runAuditPayload(run *insight_runs.Run) map[string]any {
	if run == nil {
		return nil
	}
	payload := map[string]any{
		"run_id":           run.RunID,
		"attempt":          run.Attempt,
		"capability":       run.Capability,
		"project_id":       run.ProjectID,
		"country":          run.Country,
		"role_id":          run.RoleID,
		"role_version":     run.RoleVersion,
		"endpoint_id":      run.EndpointID,
		"model_id":         run.ModelID,
		"status":           run.Status,
		"stage":            run.Stage,
		"progress_percent": run.ProgressPercent,
	}
	if run.ContentMarkdown != nil {
		payload["content_chars"] = len([]rune(*run.ContentMarkdown))
	}
	return payload
}
