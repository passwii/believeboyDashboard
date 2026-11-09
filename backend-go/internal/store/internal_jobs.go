package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/internal_jobs"
)

type InternalJobStore struct {
	db FullDB
}

func NewInternalJobStore(db FullDB) *InternalJobStore {
	return &InternalJobStore{db: db}
}

func (store *InternalJobStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, internal_jobs.Store) error,
) error {
	if store == nil || store.db == nil {
		return errors.New("internal jobs database is not configured")
	}
	return RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		txStore := &InternalJobStore{db: NewTxDB(tx)}
		return fn(ctx, tx, txStore)
	})
}

func (store *InternalJobStore) AcquireJobLock(ctx context.Context, lockKey string) error {
	if store == nil || store.db == nil {
		return errors.New("internal jobs database is not configured")
	}
	return acquireAdvisoryLock(ctx, store.db, lockKey)
}

func (store *InternalJobStore) FindIdempotencyRecord(
	ctx context.Context,
	action string,
	idempotencyKey string,
) (*internal_jobs.IdempotencyRecord, error) {
	if store == nil || store.db == nil {
		return nil, errors.New("internal jobs database is not configured")
	}
	var beforeJSON, afterJSON []byte
	err := store.db.QueryRow(
		ctx,
		`select before_json, after_json
		 from public.operation_audit_logs
		 where action = $1 and idempotency_key = $2 and result = 'success'
		 order by id desc
		 limit 1`,
		action,
		idempotencyKey,
	).Scan(&beforeJSON, &afterJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var marker struct {
		Fingerprint string `json:"fingerprint"`
	}
	if err := json.Unmarshal(beforeJSON, &marker); err != nil {
		return nil, fmt.Errorf("decode idempotency fingerprint: %w", err)
	}
	if marker.Fingerprint == "" {
		return nil, errors.New("idempotency audit row is missing fingerprint")
	}
	return &internal_jobs.IdempotencyRecord{
		Fingerprint: marker.Fingerprint,
		Response:    json.RawMessage(afterJSON),
	}, nil
}
