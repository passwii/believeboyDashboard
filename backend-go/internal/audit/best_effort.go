package audit

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5"
)

// ErrServiceUnavailable reports that no audit backend is wired. It is only
// returned by fail-closed methods (LogActionTx); best-effort methods degrade to
// a logged warning so a missing auditor cannot fail a committed business write.
var ErrServiceUnavailable = errors.New("audit service is not configured")

// BestEffort wraps a Service so that an audit failure after a committed business
// write is logged instead of surfacing as a 5xx response.
//
// Why: most handlers perform their mutation through a store method that commits
// on its own, then call LogAction. Returning 500 when that trailing audit call
// fails makes the client retry an already-applied write — creating duplicates on
// POST and spurious 404s on DELETE. FastAPI keeps the business write and the
// audit row in a single SQLAlchemy session, so it never exposed that gap.
//
// LogActionTx deliberately keeps the inner error: inside an explicit transaction
// the audit row must still be atomic with the business write, and swallowing the
// error would silently break that guarantee. Callers that need full atomicity
// should pass the transaction and use LogActionTx.
func BestEffort(inner Service) Service {
	return bestEffort{inner: inner}
}

type bestEffort struct {
	inner Service
}

// LogAction records the audit entry and never propagates the error.
func (b bestEffort) LogAction(ctx context.Context, entry Entry) error {
	if b.inner == nil {
		logDroppedAudit(ctx, entry, ErrServiceUnavailable)
		return nil
	}
	if err := b.inner.LogAction(ctx, entry); err != nil {
		logDroppedAudit(ctx, entry, err)
	}
	return nil
}

// LogActionTx forwards the audit write unchanged so transaction semantics are
// preserved: a failure here must still roll the surrounding transaction back.
func (b bestEffort) LogActionTx(ctx context.Context, tx pgx.Tx, entry Entry) error {
	if b.inner == nil {
		return ErrServiceUnavailable
	}
	return b.inner.LogActionTx(ctx, tx, entry)
}

// LogView forwards unchanged; view auditing is not persisted by default.
func (b bestEffort) LogView(
	ctx context.Context,
	action string,
	targetType string,
	operator *string,
	after any,
	r *http.Request,
) error {
	if b.inner == nil {
		return ErrServiceUnavailable
	}
	return b.inner.LogView(ctx, action, targetType, operator, after, r)
}

func logDroppedAudit(ctx context.Context, entry Entry, err error) {
	args := []any{
		slog.String("action", entry.Action),
		slog.String("target_type", entry.TargetType),
		slog.Any("error", err),
	}
	if entry.TargetID != nil {
		args = append(args, slog.String("target_id", *entry.TargetID))
	}
	if entry.Operator != nil {
		args = append(args, slog.String("operator", *entry.Operator))
	}
	// The business write already committed, so this is a data-loss signal, not a
	// request failure. Alerting on this message is the intended detection path.
	slog.Default().ErrorContext(ctx, "audit entry dropped after committed business write", args...)
}
