package store

import (
	"context"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/crm_intent"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type recordingAuditor struct {
	actions []string
	usedTx  bool
}

func (recorder *recordingAuditor) LogAction(_ context.Context, entry audit.Entry) error {
	recorder.actions = append(recorder.actions, entry.Action)
	return nil
}

func (recorder *recordingAuditor) LogActionTx(
	_ context.Context,
	_ pgx.Tx,
	entry audit.Entry,
) error {
	recorder.usedTx = true
	recorder.actions = append(recorder.actions, entry.Action)
	return nil
}

func (recorder *recordingAuditor) LogView(
	context.Context,
	string,
	string,
	*string,
	any,
	*http.Request,
) error {
	return nil
}

func TestLogAIWriteBlockedBestEffortUsesNonTransactionalAudit(t *testing.T) {
	recorder := &recordingAuditor{}
	store := &CRMIntentStore{auditor: recorder}
	store.logAIWriteBlockedBestEffort(
		context.Background(),
		crm_intent.Actor{Kind: crm_intent.ActorKindAgent, ID: "agent-1"},
		"crm_intent_company",
		42,
		map[string]any{"reason": "human_touched", "mode": "patch"},
	)
	if recorder.usedTx {
		t.Fatal("locked audit must not use the rolling-back transaction")
	}
	if len(recorder.actions) != 1 || recorder.actions[0] != "crm_intent.ai_write_blocked" {
		t.Fatalf("unexpected audit actions: %#v", recorder.actions)
	}
}
