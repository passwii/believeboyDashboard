package health

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestPostgresProbeReportsErrorTypeOnly(t *testing.T) {
	probe := NewPostgresProbe(&fakeQueryer{err: errors.New("secret connection detail")})

	got := probe.Probe(context.Background())

	if got != "error: *errors.errorString" {
		t.Errorf("Probe() = %q, want type-only error", got)
	}
}

func TestPostgresProbeReportsOK(t *testing.T) {
	probe := NewPostgresProbe(&fakeQueryer{})

	if got := probe.Probe(context.Background()); got != "ok" {
		t.Errorf("Probe() = %q, want ok", got)
	}
}

func TestPostgresProbeReportsReplicaLag(t *testing.T) {
	lag := 10.5
	probe := NewPostgresProbe(&fakeQueryer{lag: &lag})

	if got := probe.Probe(context.Background()); got != "degraded (lag=10.5s > 10s)" {
		t.Errorf("Probe() = %q, want degraded threshold string", got)
	}
}

type fakeQueryer struct {
	lag *float64
	err error
}

func (q *fakeQueryer) QueryRow(context.Context, string, ...any) pgx.Row {
	return fakeRow{lag: q.lag, err: q.err}
}

type fakeRow struct {
	lag *float64
	err error
}

func (r fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	target := dest[0].(**float64)
	*target = r.lag
	return nil
}
