package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/jobs"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type JobStore struct {
	db FullDB
}

func NewJobStore(db FullDB) *JobStore {
	return &JobStore{db: db}
}

const jobColumns = `
id, job_type, status, payload_json, operator, created_at, updated_at`

func (store *JobStore) CreateJob(
	ctx context.Context,
	input jobs.CreateInput,
	operator *string,
) (jobs.Job, error) {
	payload := map[string]any{
		"job_type": input.JobType,
		"file_id":  input.FileID,
		"params":   input.Params,
	}
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return jobs.Job{}, err
	}
	row := store.db.QueryRow(
		ctx,
		`INSERT INTO public.jobs (job_type, status, payload_json, operator)
		 VALUES ($1, 'pending', $2, $3)
		 RETURNING `+jobColumns,
		input.JobType,
		payloadBytes,
		operator,
	)
	return scanJob(row)
}

func (store *JobStore) GetJob(ctx context.Context, jobID int64) (*jobs.Job, error) {
	job, err := scanJob(store.db.QueryRow(
		ctx,
		`SELECT `+jobColumns+` FROM public.jobs WHERE id = $1 LIMIT 1`,
		jobID,
	))
	if err == pgx.ErrNoRows {
		return nil, jobs.NewAPIError(404, "Job not found")
	}
	if err != nil {
		return nil, err
	}
	return &job, nil
}

func (store *JobStore) ListRuns(ctx context.Context, jobID int64) ([]jobs.JobRun, error) {
	rows, err := store.db.Query(
		ctx,
		`SELECT id, started_at, finished_at, operator, log_excerpt,
		        error_message, result_path
		 FROM public.job_runs
		 WHERE job_id = $1
		 ORDER BY id ASC`,
		jobID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]jobs.JobRun, 0)
	for rows.Next() {
		item, err := scanJobRun(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (store *JobStore) LatestRun(ctx context.Context, jobID int64) (*jobs.JobRun, error) {
	item, err := scanJobRun(store.db.QueryRow(
		ctx,
		`SELECT id, started_at, finished_at, operator, log_excerpt,
		        error_message, result_path
		 FROM public.job_runs
		 WHERE job_id = $1
		 ORDER BY id DESC
		 LIMIT 1`,
		jobID,
	))
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (store *JobStore) MarkEnqueueFailed(ctx context.Context, jobID int64, message string) error {
	now := time.Now().UTC()
	if message == "" {
		message = "job enqueue failed"
	}
	return RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		if _, err := txDB.Exec(
			ctx,
			`UPDATE public.jobs
			 SET status = 'failed', updated_at = $2
			 WHERE id = $1 AND status = 'pending'`,
			jobID,
			now,
		); err != nil {
			return fmt.Errorf("mark job failed: %w", err)
		}
		_, err := txDB.Exec(
			ctx,
			`INSERT INTO public.job_runs (
			   job_id, started_at, finished_at, operator, error_message
			 )
			 SELECT $1, $2, $2, j.operator, $3
			 FROM public.jobs j
			 WHERE j.id = $1`,
			jobID,
			now,
			message,
		)
		return err
	})
}

type jobRowScanner interface {
	Scan(dest ...any) error
}

func scanJob(row jobRowScanner) (jobs.Job, error) {
	var item jobs.Job
	var payload []byte
	var createdAt, updatedAt pgtype.Timestamptz
	if err := row.Scan(
		&item.ID,
		&item.JobType,
		&item.Status,
		&payload,
		&item.Operator,
		&createdAt,
		&updatedAt,
	); err != nil {
		return jobs.Job{}, err
	}
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &item.PayloadJSON); err != nil {
			return jobs.Job{}, err
		}
	}
	if item.PayloadJSON == nil {
		item.PayloadJSON = map[string]any{}
	}
	item.CreatedAt = optionalPGTimestamp(createdAt)
	item.UpdatedAt = optionalPGTimestamp(updatedAt)
	return item, nil
}

func scanJobRun(row jobRowScanner) (jobs.JobRun, error) {
	var item jobs.JobRun
	var startedAt, finishedAt pgtype.Timestamptz
	if err := row.Scan(
		&item.ID,
		&startedAt,
		&finishedAt,
		&item.Operator,
		&item.LogExcerpt,
		&item.ErrorMessage,
		&item.ResultPath,
	); err != nil {
		return jobs.JobRun{}, err
	}
	item.StartedAt = optionalPGTimestamp(startedAt)
	item.FinishedAt = optionalPGTimestamp(finishedAt)
	return item, nil
}

func optionalPGTimestamp(value pgtype.Timestamptz) *string {
	if !value.Valid {
		return nil
	}
	formatted := httpapi.Timestamp(value.Time)
	return &formatted
}
