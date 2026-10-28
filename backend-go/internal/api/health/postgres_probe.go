package health

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

type Queryer interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type PostgresProbe struct {
	db Queryer
}

func NewPostgresProbe(db Queryer) *PostgresProbe {
	return &PostgresProbe{db: db}
}

func (p *PostgresProbe) Probe(ctx context.Context) string {
	if p.db == nil {
		return "error: DatabaseNotConfigured"
	}

	var lagSeconds *float64
	err := p.db.QueryRow(
		ctx,
		`select extract(epoch from (now() - pg_last_xact_replay_timestamp()))::float
		 as lag_seconds`,
	).Scan(&lagSeconds)
	if err != nil {
		return "error: " + fmt.Sprintf("%T", err)
	}
	if lagSeconds == nil {
		return "ok"
	}
	lag := *lagSeconds
	if lag < replicaLagDegradedSeconds {
		return fmt.Sprintf("ok (lag=%.1fs)", lag)
	}
	return fmt.Sprintf("degraded (lag=%.1fs > 10s)", lag)
}

const replicaLagDegradedSeconds = 10.0
