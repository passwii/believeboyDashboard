package internal_keys

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

var (
	// errUserAPIKeyNotFound marks user credential mutations that matched no row.
	errUserAPIKeyNotFound = errors.New("user API key not found")
	// errMutationRecordMissing guards against stores that silently return no record.
	errMutationRecordMissing = errors.New("api key mutation returned no record")
	// errMutationUnsupported keeps the previous 500 response for stores missing a capability.
	errMutationUnsupported = errors.New("api key store does not support this mutation")
)

// TransactionalStore is implemented by the concrete store to expose a single
// database transaction around credential mutations. Handlers write the audit
// entry through it so audit failures roll the mutation back; stores that only
// implement Store keep the legacy best-effort behavior.
type TransactionalStore interface {
	RunInTx(
		ctx context.Context,
		fn func(ctx context.Context, tx pgx.Tx, txStore Store) error,
	) error
}

// runInTx executes fn inside a transaction when the store supports it. Stores
// without transaction support (lightweight test doubles) receive a nil tx and
// operate directly, which matches the previous non-transactional behavior.
func (h *Handler) runInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, Store) error,
) error {
	runner, ok := h.store.(TransactionalStore)
	if !ok {
		return fn(ctx, nil, h.store)
	}
	return runner.RunInTx(ctx, fn)
}

// auditTx records entry in the mutation's transaction so the mutation and its
// audit row commit or roll back together. Missing tx or auditor keeps the
// legacy non-transactional behavior.
func (h *Handler) auditTx(
	ctx context.Context,
	r *http.Request,
	tx pgx.Tx,
	entry audit.Entry,
) error {
	if h.auditor == nil {
		return nil
	}
	entry.PopulateFromRequest(r)
	if tx != nil {
		return h.auditor.LogActionTx(ctx, tx, entry)
	}
	return h.auditor.LogAction(ctx, entry)
}

func revokedNowCount(rows []UserAPIKey) int {
	changed := 0
	for _, row := range rows {
		if row.RevokedNow {
			changed++
		}
	}
	return changed
}
