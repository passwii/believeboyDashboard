package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_inspection"
)

const agentInspectionAuditInsertSQL = `
insert into public.operation_audit_logs (
	operator, action, target_type, target_id, result, trace_id,
	request_method, request_path, ip_address, user_agent,
	before_json, after_json, agent_id, agent_name, idempotency_key,
	error_message, created_at
) values (
	$1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
	$11, $12, $13, $14, $15, $16, now()
)`

func (s *AgentInspectionStore) LogAudit(
	ctx context.Context,
	tx pgx.Tx,
	entry agent_inspection.AuditEntry,
) error {
	var execer Execer
	if tx != nil {
		execer = tx
	} else if s != nil && s.db != nil {
		var ok bool
		execer, ok = s.db.(Execer)
		if !ok {
			return errors.New("agent inspection database does not support Exec")
		}
	} else {
		return errors.New("agent inspection database is nil")
	}

	beforeJSON, err := agentInspectionAuditJSON(entry.BeforeJSON)
	if err != nil {
		return fmt.Errorf("marshal audit before_json: %w", err)
	}
	afterJSON, err := agentInspectionAuditJSON(agentInspectionAuditAfter(entry))
	if err != nil {
		return fmt.Errorf("marshal audit after_json: %w", err)
	}
	_, err = execer.Exec(
		ctx,
		agentInspectionAuditInsertSQL,
		nil,
		clipAgentInspectionAudit(entry.Action, 128, "unknown"),
		clipAgentInspectionAudit(entry.TargetType, 64, "unknown"),
		clipAgentInspectionAuditPointer(entry.TargetID, 128),
		"success",
		clipAgentInspectionAuditPointer(entry.TraceID, 64),
		clipAgentInspectionAuditPointer(entry.RequestMethod, 16),
		clipAgentInspectionAuditPointer(entry.RequestPath, 255),
		clipAgentInspectionAuditPointer(entry.IPAddress, 64),
		clipAgentInspectionAuditPointer(entry.UserAgent, 512),
		beforeJSON,
		afterJSON,
		clipAgentInspectionAuditPointer(entry.AgentID, 128),
		clipAgentInspectionAuditPointer(entry.AgentName, 128),
		clipAgentInspectionAuditPointer(entry.IdempotencyKey, 64),
		nil,
	)
	if err != nil {
		return fmt.Errorf("insert agent inspection audit: %w", err)
	}
	return nil
}

func agentInspectionAuditJSON(value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	payload, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return payload, nil
}

func agentInspectionAuditAfter(entry agent_inspection.AuditEntry) any {
	if entry.AgentID == nil || entry.IdempotencyKey != nil {
		return entry.AfterJSON
	}
	marker := map[string]any{"risk": "no_idempotency"}
	if values, ok := entry.AfterJSON.(map[string]any); ok {
		copied := make(map[string]any, len(values)+1)
		for key, value := range values {
			copied[key] = value
		}
		copied["risk"] = "no_idempotency"
		return copied
	}
	if entry.AfterJSON == nil {
		return marker
	}
	return entry.AfterJSON
}

func clipAgentInspectionAudit(value string, limit int, fallback string) string {
	if value == "" {
		value = fallback
	}
	if len(value) > limit {
		return value[:limit]
	}
	return value
}

func clipAgentInspectionAuditPointer(value *string, limit int) *string {
	if value == nil {
		return nil
	}
	clipped := *value
	if len(clipped) > limit {
		clipped = clipped[:limit]
	}
	return &clipped
}
