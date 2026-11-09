package store

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/insight_observation"
)

func (s *AIInsightStore) ListObservationRows(ctx context.Context, since time.Time, capability *string) ([]insight_observation.ObservationRow, error) {
	query := `select
		source, run_id, attempt, capability, role_id, endpoint_id, model_id,
		status, first_delta_ms, duration_ms, input_tokens, output_tokens,
		total_tokens, attempts, retries, stream_opens, stream_reconnects,
		reconnect_completed, stream_frames, stream_bytes, stream_xlen,
		stream_memory_bytes, cancel_requested, cancel_succeeded,
		error_code, error_retryable, fallback, fallback_reason, created_at
		from public.insight_run_observations
		where created_at >= $1`
	args := []any{since}
	if capability != nil && strings.TrimSpace(*capability) != "" {
		args = append(args, *capability)
		query += fmt.Sprintf(" and capability = $%d", len(args))
	}
	query += " order by created_at asc"
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		return []insight_observation.ObservationRow{}, nil
	}
	defer rows.Close()
	items := make([]insight_observation.ObservationRow, 0)
	for rows.Next() {
		var row insight_observation.ObservationRow
		var cancelSucceeded pgtype.Bool
		var errorRetryable pgtype.Bool
		if err := rows.Scan(
			&row.Source, &row.RunID, &row.Attempt, &row.Capability, &row.RoleID,
			&row.EndpointID, &row.ModelID, &row.Status, &row.FirstDeltaMS,
			&row.DurationMS, &row.InputTokens, &row.OutputTokens, &row.TotalTokens,
			&row.Attempts, &row.Retries, &row.StreamOpens, &row.StreamReconnects,
			&row.ReconnectCompleted, &row.StreamFrames, &row.StreamBytes,
			&row.StreamXLen, &row.StreamMemoryBytes, &row.CancelRequested,
			&cancelSucceeded, &row.ErrorCode, &errorRetryable,
			&row.Fallback, &row.FallbackReason, &row.CreatedAt,
		); err != nil {
			return nil, err
		}
		if cancelSucceeded.Valid {
			value := cancelSucceeded.Bool
			row.CancelSucceeded = &value
		}
		if errorRetryable.Valid {
			value := errorRetryable.Bool
			row.ErrorRetryable = &value
		}
		items = append(items, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}
