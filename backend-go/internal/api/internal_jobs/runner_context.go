package internal_jobs

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
)

type runnerExecutionContextKey struct{}

type runnerExecutionContext struct {
	tx       pgx.Tx
	operator *string
}

// WithRunnerExecution lets the handler pass its transaction and operator to a
// runner without widening the Runner interface or coupling the API package to
// the store package.
func WithRunnerExecution(ctx context.Context, tx pgx.Tx, operator string) context.Context {
	operator = strings.TrimSpace(operator)
	var operatorPtr *string
	if operator != "" {
		operatorPtr = &operator
	}
	return context.WithValue(ctx, runnerExecutionContextKey{}, runnerExecutionContext{
		tx:       tx,
		operator: operatorPtr,
	})
}

func RunnerTransactionFromContext(ctx context.Context) pgx.Tx {
	value, _ := ctx.Value(runnerExecutionContextKey{}).(runnerExecutionContext)
	return value.tx
}

func RunnerOperatorFromContext(ctx context.Context) *string {
	value, _ := ctx.Value(runnerExecutionContextKey{}).(runnerExecutionContext)
	if value.operator == nil {
		return nil
	}
	operator := *value.operator
	return &operator
}
