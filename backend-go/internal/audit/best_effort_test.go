package audit_test

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type stubService struct {
	logActionErr error
	logViewErr   error
	logTxErr     error

	logActionCalls int
	logTxCalls     int
}

func (s *stubService) LogAction(context.Context, audit.Entry) error {
	s.logActionCalls++
	return s.logActionErr
}

func (s *stubService) LogActionTx(context.Context, pgx.Tx, audit.Entry) error {
	s.logTxCalls++
	return s.logTxErr
}

func (s *stubService) LogView(
	context.Context, string, string, *string, any, *http.Request,
) error {
	return s.logViewErr
}

func TestBestEffortLogActionSwallowsErrors(t *testing.T) {
	innerErr := errors.New("audit insert failed")
	inner := &stubService{logActionErr: innerErr}

	if err := audit.BestEffort(inner).LogAction(context.Background(), audit.Entry{Action: "projects.create"}); err != nil {
		t.Fatalf("LogAction() = %v, want nil so a committed write is not reported as failed", err)
	}
	if inner.logActionCalls != 1 {
		t.Fatalf("inner LogAction calls = %d, want 1", inner.logActionCalls)
	}
}

func TestBestEffortLogActionTxKeepsErrors(t *testing.T) {
	innerErr := errors.New("audit insert failed")
	inner := &stubService{logTxErr: innerErr}

	err := audit.BestEffort(inner).LogActionTx(context.Background(), nil, audit.Entry{Action: "api_keys.create"})
	if !errors.Is(err, innerErr) {
		t.Fatalf("LogActionTx() = %v, want the inner error so the transaction rolls back", err)
	}
	if inner.logTxCalls != 1 {
		t.Fatalf("inner LogActionTx calls = %d, want 1", inner.logTxCalls)
	}
}

func TestBestEffortWithoutInnerService(t *testing.T) {
	service := audit.BestEffort(nil)

	if err := service.LogAction(context.Background(), audit.Entry{Action: "projects.create"}); err != nil {
		t.Fatalf("LogAction() without inner service = %v, want nil", err)
	}
	if err := service.LogActionTx(context.Background(), nil, audit.Entry{}); !errors.Is(err, audit.ErrServiceUnavailable) {
		t.Fatalf("LogActionTx() without inner service = %v, want ErrServiceUnavailable", err)
	}
	if err := service.LogView(context.Background(), "a", "b", nil, nil, nil); !errors.Is(err, audit.ErrServiceUnavailable) {
		t.Fatalf("LogView() without inner service = %v, want ErrServiceUnavailable", err)
	}
}
