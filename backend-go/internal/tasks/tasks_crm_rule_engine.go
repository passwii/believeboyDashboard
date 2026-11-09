package tasks

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/hibiken/asynq"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

const (
	selectEnabledCRMRulesSQL = `
SELECT id, name, entity_type, event_type, priority
FROM crm_rules
WHERE enabled = TRUE
ORDER BY priority DESC, id
`
	selectCRMRuleConditionsSQL = `
SELECT field, operator, value, sort_order
FROM crm_rule_conditions
WHERE rule_id = $1
ORDER BY sort_order, id
`
	selectCRMRuleActionsSQL = `
SELECT action_type, coalesce(params, '{}'::json), sort_order
FROM crm_rule_actions
WHERE rule_id = $1
ORDER BY sort_order, id
`
	selectCRMCustomerRuleEntitiesSQL = `
SELECT
    c.id,
    c.owner_id,
    c.status,
    c.rating,
    c.annual_revenue::double precision,
    c.created_at,
    c.last_follow_at,
    coalesce(
        (
            SELECT string_agg(cat.name, ', ' ORDER BY cat.name)
            FROM crm_customer_categories cc
            JOIN crm_categories cat ON cat.id = cc.category_id
            WHERE cc.customer_id = c.id
        ),
        ''
    )
FROM crm_customers c
WHERE c.is_deleted = FALSE
ORDER BY c.id
`
	selectCRMLeadRuleEntitiesSQL = `
SELECT
    l.id,
    l.owner_id,
    l.status,
    '',
    l.expected_amount::double precision,
    l.created_at,
    l.last_follow_at,
    ''
FROM crm_leads l
WHERE l.is_deleted = FALSE
ORDER BY l.id
`
	insertCRMRuleReminderSQL = `
INSERT INTO crm_reminder_logs (
    entity_type, entity_id, reminder_type, owner_id, status, reminded_at
)
SELECT $1, $2, 'stale_follow_up', $3, 'active', $4
WHERE NOT EXISTS (
    SELECT 1
    FROM crm_reminder_logs
    WHERE entity_type = $1
      AND entity_id = $2
      AND reminder_type = 'stale_follow_up'
      AND status = 'active'
)
`
	insertCRMRuleFollowSQL = `
INSERT INTO crm_follows (
    entity_type, entity_id, type, content, next_follow_at, created_by
)
SELECT $1, $2, $3, $4, NULL, NULL
WHERE NOT EXISTS (
    SELECT 1
    FROM crm_follows
    WHERE entity_type = $1
      AND entity_id = $2
      AND content = $4
      AND created_at >= $5
)
`
	insertCRMRuleTaskSQL = `
INSERT INTO crm_tasks (
    title, description, due_date, priority, status, type, owner_id,
    customer_id, lead_id, created_by
)
SELECT $1, $2, NULL, $3, 'pending', 'custom', $4, $5, $6, NULL
WHERE NOT EXISTS (
    SELECT 1
    FROM crm_tasks
    WHERE owner_id = $4
      AND coalesce(customer_id, 0) = coalesce($5, 0)
      AND coalesce(lead_id, 0) = coalesce($6, 0)
      AND title = $1
      AND created_at >= $7
)
`
	insertCRMRuleExecutionLogSQL = `
INSERT INTO crm_audit_logs (
    entity_type, entity_id, action, actor_id, summary, created_at
)
VALUES ('rule', $1, 'trigger', NULL, $2, $3)
`
)

type crmRuleRecord struct {
	ID         int64
	Name       string
	EntityType string
	EventType  string
	Priority   int
}

type crmRuleConditionRecord struct {
	Field     string
	Operator  string
	Value     *string
	SortOrder int
}

type crmRuleActionRecord struct {
	ActionType string
	Params     []byte
	SortOrder  int
}

type crmRuleEntity struct {
	ID           int64
	OwnerID      *string
	Status       string
	Rating       string
	Amount       *float64
	CreatedAt    time.Time
	LastFollowAt *time.Time
	Tags         string
}

type crmRuleEngineSummary struct {
	RulesEvaluated          int `json:"rules_evaluated"`
	RulesSkippedUnsupported int `json:"rules_skipped_unsupported"`
	EntitiesMatched         int `json:"entities_matched"`
	ActionsApplied          int `json:"actions_applied"`
	RemindersCreated        int `json:"reminders_created"`
	FollowsCreated          int `json:"follows_created"`
	TasksCreated            int `json:"tasks_created"`
}

func (handler *TaskHandler) HandleCRMRuleEngine(ctx context.Context, task *asynq.Task) error {
	const taskType = queue.TypeCRMRuleEngine
	return handler.runSafely(taskType, func() error {
		var payload CRMRuleEnginePayload
		if err := handler.decodePayload(task, &payload); err != nil {
			return err
		}
		if !handler.config.CRMRuleEngineEnabled {
			return handler.writeResult(task, taskResult{
				TaskType: taskType,
				Status:   "completed",
				Data: map[string]any{
					"enabled": false,
				},
			})
		}
		db, err := handler.requireDB()
		if err != nil {
			return err
		}
		now := handler.currentTime(payload.Now)
		summary, err := executeCRMRules(ctx, db, now)
		if err != nil {
			return err
		}
		return handler.writeResult(task, taskResult{
			TaskType: taskType,
			Status:   "completed",
			Data:     summary,
		})
	})
}

func executeCRMRules(
	ctx context.Context,
	db store.FullDB,
	now time.Time,
) (crmRuleEngineSummary, error) {
	rules, err := loadCRMRules(ctx, db)
	if err != nil {
		return crmRuleEngineSummary{}, err
	}

	var summary crmRuleEngineSummary
	summary.RulesEvaluated = len(rules)
	for _, rule := range rules {
		conditions, err := loadCRMRuleConditions(ctx, db, rule.ID)
		if err != nil {
			return summary, err
		}
		actions, err := loadCRMRuleActions(ctx, db, rule.ID)
		if err != nil {
			return summary, err
		}
		if len(conditions) == 0 || len(actions) == 0 {
			summary.RulesSkippedUnsupported++
			if err := writeCRMRuleLog(ctx, db, rule.ID, now, "跳过：规则无条件或无动作"); err != nil {
				return summary, err
			}
			continue
		}
		unsupportedCondition := false
		for _, condition := range conditions {
			if !crmRuleConditionSupported(condition) {
				summary.RulesSkippedUnsupported++
				if err := writeCRMRuleLog(ctx, db, rule.ID, now, "跳过：规则含不支持的条件"); err != nil {
					return summary, err
				}
				unsupportedCondition = true
				break
			}
		}
		if unsupportedCondition {
			continue
		}

		entities, err := loadCRMRuleEntities(ctx, db, rule.EntityType)
		if err != nil {
			return summary, err
		}
		matched, err := filterCRMRuleEntities(entities, conditions, now)
		if err != nil {
			return summary, err
		}
		summary.EntitiesMatched += len(matched)

		ruleActionsApplied := 0
		for _, entity := range matched {
			for _, action := range actions {
				changed, actionErr := executeCRMRuleAction(
					ctx,
					db,
					rule,
					entity,
					action,
					now,
				)
				if actionErr != nil {
					return summary, actionErr
				}
				if changed {
					ruleActionsApplied++
					summary.ActionsApplied++
					switch strings.TrimSpace(action.ActionType) {
					case "notify_owner", "reminder", "create_reminder":
						summary.RemindersCreated++
					case "follow", "create_follow":
						summary.FollowsCreated++
					case "task", "create_task":
						summary.TasksCreated++
					}
				}
			}
		}
		if err := writeCRMRuleLog(
			ctx,
			db,
			rule.ID,
			now,
			fmt.Sprintf("命中 %d 个实体，执行 %d 个动作", len(matched), ruleActionsApplied),
		); err != nil {
			return summary, err
		}
	}
	return summary, nil
}

func loadCRMRules(ctx context.Context, db store.FullDB) ([]crmRuleRecord, error) {
	rows, err := db.Query(ctx, selectEnabledCRMRulesSQL)
	if err != nil {
		return nil, fmt.Errorf("load enabled CRM rules: %w", err)
	}
	defer rows.Close()

	var rules []crmRuleRecord
	for rows.Next() {
		var rule crmRuleRecord
		if err := rows.Scan(
			&rule.ID,
			&rule.Name,
			&rule.EntityType,
			&rule.EventType,
			&rule.Priority,
		); err != nil {
			return nil, fmt.Errorf("scan CRM rule: %w", err)
		}
		rules = append(rules, rule)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate CRM rules: %w", err)
	}
	return rules, nil
}

func loadCRMRuleConditions(
	ctx context.Context,
	db store.FullDB,
	ruleID int64,
) ([]crmRuleConditionRecord, error) {
	rows, err := db.Query(ctx, selectCRMRuleConditionsSQL, ruleID)
	if err != nil {
		return nil, fmt.Errorf("load CRM rule %d conditions: %w", ruleID, err)
	}
	defer rows.Close()

	var conditions []crmRuleConditionRecord
	for rows.Next() {
		var condition crmRuleConditionRecord
		if err := rows.Scan(
			&condition.Field,
			&condition.Operator,
			&condition.Value,
			&condition.SortOrder,
		); err != nil {
			return nil, fmt.Errorf("scan CRM rule condition: %w", err)
		}
		conditions = append(conditions, condition)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate CRM rule conditions: %w", err)
	}
	return conditions, nil
}

func loadCRMRuleActions(
	ctx context.Context,
	db store.FullDB,
	ruleID int64,
) ([]crmRuleActionRecord, error) {
	rows, err := db.Query(ctx, selectCRMRuleActionsSQL, ruleID)
	if err != nil {
		return nil, fmt.Errorf("load CRM rule %d actions: %w", ruleID, err)
	}
	defer rows.Close()

	var actions []crmRuleActionRecord
	for rows.Next() {
		var action crmRuleActionRecord
		if err := rows.Scan(
			&action.ActionType,
			&action.Params,
			&action.SortOrder,
		); err != nil {
			return nil, fmt.Errorf("scan CRM rule action: %w", err)
		}
		actions = append(actions, action)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate CRM rule actions: %w", err)
	}
	return actions, nil
}

func loadCRMRuleEntities(
	ctx context.Context,
	db store.FullDB,
	entityType string,
) ([]crmRuleEntity, error) {
	query := selectCRMCustomerRuleEntitiesSQL
	switch strings.TrimSpace(entityType) {
	case "customer":
	case "lead":
		query = selectCRMLeadRuleEntitiesSQL
	default:
		return nil, fmt.Errorf("unsupported CRM rule entity_type %q", entityType)
	}

	rows, err := db.Query(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("load CRM %s rule entities: %w", entityType, err)
	}
	defer rows.Close()

	var entities []crmRuleEntity
	for rows.Next() {
		var entity crmRuleEntity
		if err := rows.Scan(
			&entity.ID,
			&entity.OwnerID,
			&entity.Status,
			&entity.Rating,
			&entity.Amount,
			&entity.CreatedAt,
			&entity.LastFollowAt,
			&entity.Tags,
		); err != nil {
			return nil, fmt.Errorf("scan CRM rule entity: %w", err)
		}
		entities = append(entities, entity)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate CRM rule entities: %w", err)
	}
	return entities, nil
}

func filterCRMRuleEntities(
	entities []crmRuleEntity,
	conditions []crmRuleConditionRecord,
	now time.Time,
) ([]crmRuleEntity, error) {
	var matched []crmRuleEntity
	for _, entity := range entities {
		allMatch := true
		for _, condition := range conditions {
			ok, err := evaluateCRMRuleCondition(entity, condition, now)
			if err != nil {
				return nil, err
			}
			if !ok {
				allMatch = false
				break
			}
		}
		if allMatch {
			matched = append(matched, entity)
		}
	}
	return matched, nil
}

func crmRuleConditionSupported(condition crmRuleConditionRecord) bool {
	operator := strings.ToLower(strings.TrimSpace(condition.Operator))
	switch canonicalCRMRuleField(condition.Field) {
	case "days_since_created", "days_since_last_follow", "amount", "last_follow_at":
		return crmRuleComparisonOperator(operator, true)
	case "status", "rating", "owner_id":
		return crmRuleComparisonOperator(operator, false)
	case "tag":
		switch operator {
		case "eq", "ne", "contains", "not_contains", "is_null", "is_not_null":
			return true
		}
	default:
	}
	return false
}

func crmRuleComparisonOperator(operator string, allowOrdering bool) bool {
	switch operator {
	case "is_null", "is_not_null", "eq", "ne":
		return true
	case "gt", "gte", "lt", "lte":
		return allowOrdering
	default:
		return false
	}
}

func canonicalCRMRuleField(field string) string {
	switch strings.ToLower(strings.TrimSpace(field)) {
	case "days_since_created":
		return "days_since_created"
	case "days_since_last_follow", "last_follow":
		return "days_since_last_follow"
	case "last_follow_at":
		return "last_follow_at"
	case "stage", "status":
		return "status"
	case "rating":
		return "rating"
	case "owner", "owner_id":
		return "owner_id"
	case "amount", "expected_amount", "annual_revenue":
		return "amount"
	case "tag", "tags", "category":
		return "tag"
	default:
		return strings.ToLower(strings.TrimSpace(field))
	}
}

func evaluateCRMRuleCondition(
	entity crmRuleEntity,
	condition crmRuleConditionRecord,
	now time.Time,
) (bool, error) {
	operator := strings.ToLower(strings.TrimSpace(condition.Operator))
	switch canonicalCRMRuleField(condition.Field) {
	case "days_since_created":
		return compareCRMRuleNumber(float64(int(now.Sub(entity.CreatedAt).Hours()/24)), operator, condition.Value)
	case "days_since_last_follow":
		if entity.LastFollowAt == nil {
			return crMRuleNullOperator(operator)
		}
		return compareCRMRuleNumber(
			float64(int(now.Sub(*entity.LastFollowAt).Hours()/24)),
			operator,
			condition.Value,
		)
	case "last_follow_at":
		return compareCRMRuleTime(entity.LastFollowAt, operator, condition.Value)
	case "status":
		return compareCRMRuleString(entity.Status, operator, condition.Value)
	case "rating":
		return compareCRMRuleString(entity.Rating, operator, condition.Value)
	case "owner_id":
		owner := ""
		if entity.OwnerID != nil {
			owner = *entity.OwnerID
		}
		return compareCRMRuleString(owner, operator, condition.Value)
	case "amount":
		if entity.Amount == nil {
			return crMRuleNullOperator(operator)
		}
		return compareCRMRuleNumber(*entity.Amount, operator, condition.Value)
	case "tag":
		return compareCRMRuleTags(entity.Tags, operator, condition.Value)
	default:
		return false, fmt.Errorf("unsupported CRM rule condition field %q", condition.Field)
	}
}

func crMRuleNullOperator(operator string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(operator)) {
	case "is_null":
		return true, nil
	case "is_not_null":
		return false, nil
	case "eq":
		return false, nil
	case "ne":
		return true, nil
	default:
		return false, nil
	}
}

func compareCRMRuleNumber(actual float64, operator string, rawValue *string) (bool, error) {
	if operator == "is_null" || operator == "is_not_null" {
		return false, nil
	}
	expected, err := parseCRMRuleFloat(rawValue)
	if err != nil {
		return false, err
	}
	switch operator {
	case "gt":
		return actual > expected, nil
	case "gte":
		return actual >= expected, nil
	case "lt":
		return actual < expected, nil
	case "lte":
		return actual <= expected, nil
	case "eq":
		return actual == expected, nil
	case "ne":
		return actual != expected, nil
	default:
		return false, fmt.Errorf("unsupported CRM rule numeric operator %q", operator)
	}
}

func compareCRMRuleTime(actual *time.Time, operator string, rawValue *string) (bool, error) {
	if operator == "is_null" {
		return actual == nil, nil
	}
	if operator == "is_not_null" {
		return actual != nil, nil
	}
	if actual == nil {
		return false, nil
	}
	if rawValue == nil {
		return false, fmt.Errorf("CRM rule timestamp condition requires value")
	}
	expected, err := time.Parse(time.RFC3339, strings.TrimSpace(*rawValue))
	if err != nil {
		return false, fmt.Errorf("parse CRM rule timestamp value: %w", err)
	}
	switch operator {
	case "gt":
		return actual.After(expected), nil
	case "gte":
		return !actual.Before(expected), nil
	case "lt":
		return actual.Before(expected), nil
	case "lte":
		return !actual.After(expected), nil
	case "eq":
		return actual.Equal(expected), nil
	case "ne":
		return !actual.Equal(expected), nil
	default:
		return false, fmt.Errorf("unsupported CRM rule timestamp operator %q", operator)
	}
}

func compareCRMRuleString(actual, operator string, rawValue *string) (bool, error) {
	expected := ""
	if rawValue != nil {
		expected = strings.TrimSpace(*rawValue)
	}
	switch operator {
	case "is_null":
		return strings.TrimSpace(actual) == "", nil
	case "is_not_null":
		return strings.TrimSpace(actual) != "", nil
	case "eq":
		return actual == expected, nil
	case "ne":
		return actual != expected, nil
	case "gt":
		return actual > expected, nil
	case "gte":
		return actual >= expected, nil
	case "lt":
		return actual < expected, nil
	case "lte":
		return actual <= expected, nil
	default:
		return false, fmt.Errorf("unsupported CRM rule string operator %q", operator)
	}
}

func compareCRMRuleTags(actual, operator string, rawValue *string) (bool, error) {
	expected := ""
	if rawValue != nil {
		expected = strings.TrimSpace(*rawValue)
	}
	has := false
	for _, tag := range strings.Split(actual, ",") {
		if strings.TrimSpace(tag) == expected {
			has = true
			break
		}
	}
	switch operator {
	case "eq", "contains":
		return has, nil
	case "ne", "not_contains":
		return !has, nil
	case "is_null":
		return strings.TrimSpace(actual) == "", nil
	case "is_not_null":
		return strings.TrimSpace(actual) != "", nil
	default:
		return false, fmt.Errorf("unsupported CRM rule tag operator %q", operator)
	}
}

func parseCRMRuleFloat(value *string) (float64, error) {
	if value == nil || strings.TrimSpace(*value) == "" {
		return 0, fmt.Errorf("CRM rule numeric condition requires value")
	}
	parsed, err := strconv.ParseFloat(strings.TrimSpace(*value), 64)
	if err != nil {
		return 0, fmt.Errorf("parse CRM rule numeric value: %w", err)
	}
	return parsed, nil
}

func executeCRMRuleAction(
	ctx context.Context,
	db store.FullDB,
	rule crmRuleRecord,
	entity crmRuleEntity,
	action crmRuleActionRecord,
	now time.Time,
) (bool, error) {
	params := make(map[string]any)
	if len(action.Params) > 0 {
		if err := json.Unmarshal(action.Params, &params); err != nil {
			return false, fmt.Errorf("decode CRM rule %d action params: %w", rule.ID, err)
		}
	}
	entityType := strings.TrimSpace(rule.EntityType)
	message := stringParam(params, "message")
	if message == "" {
		message = "CRM 规则触发：" + rule.Name
	}
	ownerID := ""
	if entity.OwnerID != nil {
		ownerID = strings.TrimSpace(*entity.OwnerID)
	}

	switch strings.ToLower(strings.TrimSpace(action.ActionType)) {
	case "notify_owner", "reminder", "create_reminder":
		if ownerID == "" {
			return false, nil
		}
		tag, err := db.Exec(
			ctx,
			insertCRMRuleReminderSQL,
			entityType,
			entity.ID,
			ownerID,
			now,
		)
		if err != nil {
			return false, fmt.Errorf("create CRM rule reminder: %w", err)
		}
		return tag.RowsAffected() > 0, nil
	case "follow", "create_follow":
		followType := stringParam(params, "type")
		if followType == "" {
			followType = "note"
		}
		tag, err := db.Exec(
			ctx,
			insertCRMRuleFollowSQL,
			entityType,
			entity.ID,
			followType,
			message,
			now.Add(-24*time.Hour),
		)
		if err != nil {
			return false, fmt.Errorf("create CRM rule follow: %w", err)
		}
		return tag.RowsAffected() > 0, nil
	case "task", "create_task":
		if ownerID == "" {
			return false, nil
		}
		title := stringParam(params, "title")
		if title == "" {
			title = message
		}
		priority := stringParam(params, "priority")
		if priority == "" {
			priority = "medium"
		}
		var customerID, leadID any
		switch entityType {
		case "customer":
			customerID = entity.ID
		case "lead":
			leadID = entity.ID
		default:
			return false, fmt.Errorf("unsupported CRM rule entity_type %q", entityType)
		}
		tag, err := db.Exec(
			ctx,
			insertCRMRuleTaskSQL,
			title,
			message,
			priority,
			ownerID,
			customerID,
			leadID,
			now.Add(-24*time.Hour),
		)
		if err != nil {
			return false, fmt.Errorf("create CRM rule task: %w", err)
		}
		return tag.RowsAffected() > 0, nil
	default:
		return false, fmt.Errorf("unsupported CRM rule action_type %q", action.ActionType)
	}
}

func stringParam(params map[string]any, key string) string {
	value, _ := params[key].(string)
	return strings.TrimSpace(value)
}

func writeCRMRuleLog(
	ctx context.Context,
	db store.FullDB,
	ruleID int64,
	now time.Time,
	summary string,
) error {
	if _, err := db.Exec(ctx, insertCRMRuleExecutionLogSQL, ruleID, summary, now); err != nil {
		return fmt.Errorf("write CRM rule execution log: %w", err)
	}
	return nil
}
