package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/internal_keys"
)

var _ internal_keys.TransactionalStore = (*APIKeyStore)(nil)

// RunInTx runs fn with a store bound to one database transaction so credential
// mutations and their audit rows commit or roll back together.
func (s *APIKeyStore) RunInTx(
	ctx context.Context,
	fn func(ctx context.Context, tx pgx.Tx, txStore internal_keys.Store) error,
) error {
	if s == nil || s.db == nil {
		return errors.New("api key store database is nil")
	}
	txer, ok := s.db.(Transactor)
	if !ok {
		return errors.New("api key store database does not support transactions")
	}
	return RunInTx(ctx, txer, func(tx pgx.Tx) error {
		return fn(ctx, tx, NewAPIKeyStore(NewTxDB(tx)))
	})
}
