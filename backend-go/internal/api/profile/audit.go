package profile

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5"
)

type AvatarAudit struct {
	Action     string
	TargetType string
	TargetID   *string
	Operator   *string
	BeforeJSON any
	AfterJSON  any
	Request    *http.Request
}

// Auditor keeps profile independent from internal/audit, which imports
// httpserver while httpserver/routes.go directly imports this package.
type Auditor interface {
	LogActionTx(ctx context.Context, tx pgx.Tx, entry AvatarAudit) error
}
