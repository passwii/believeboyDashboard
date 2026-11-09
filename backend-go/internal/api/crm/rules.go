package crm

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

func (handler *Handler) ListRules(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if err := RequireAdmin(identity); err != nil {
		WriteError(w, err)
		return
	}
	items, err := handler.store.ListRules(r.Context())
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ensureSlice(items))
}

func (handler *Handler) CreateRule(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if err := RequireAdmin(identity); err != nil {
		WriteError(w, err)
		return
	}
	var input RuleCreateInput
	if err := decodeJSON(r, &input, false); err != nil {
		WriteError(w, err)
		return
	}
	if err := validateRuleCreate(input); err != nil {
		WriteError(w, err)
		return
	}
	item, err := handler.store.CreateRule(r.Context(), input, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (handler *Handler) UpdateRule(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if err := RequireAdmin(identity); err != nil {
		WriteError(w, err)
		return
	}
	ruleID, err := parsePathID(r, "rule_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	var input RuleUpdateInput
	if err := decodeJSON(r, &input, false); err != nil {
		WriteError(w, err)
		return
	}
	if err := validateRuleUpdate(input); err != nil {
		WriteError(w, err)
		return
	}
	item, err := handler.store.UpdateRule(r.Context(), ruleID, input, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) DeleteRule(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if err := RequireAdmin(identity); err != nil {
		WriteError(w, err)
		return
	}
	ruleID, err := parsePathID(r, "rule_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	if err := handler.store.DeleteRule(r.Context(), ruleID, identity.UserID); err != nil {
		WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (handler *Handler) GetWorkflowSettings(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if err := RequireAdmin(identity); err != nil {
		WriteError(w, err)
		return
	}
	settings, err := handler.store.GetWorkflowSettings(r.Context())
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func (handler *Handler) UpdateWorkflowSettings(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if err := RequireAdmin(identity); err != nil {
		WriteError(w, err)
		return
	}
	var input WorkflowSettingsUpdate
	if err := decodeJSON(r, &input, false); err != nil {
		WriteError(w, err)
		return
	}
	if input.StaleDays.Set && input.StaleDays.Value != nil {
		if *input.StaleDays.Value < 1 || *input.StaleDays.Value > 365 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "stale_days must be between 1 and 365")
			return
		}
	}
	settings, err := handler.store.UpdateWorkflowSettings(r.Context(), input, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func validateRuleCreate(input RuleCreateInput) error {
	if err := validateLength(input.Name, 1, 200, "name"); err != nil {
		return err
	}
	if input.EntityType == "" {
		input.EntityType = "customer"
	}
	if input.EventType == "" {
		input.EventType = "stale_follow_up"
	}
	if input.EntityType != "customer" && input.EntityType != "lead" {
		return NewAPIError(http.StatusUnprocessableEntity, "entity_type must be customer or lead")
	}
	if input.EventType != "stale_follow_up" {
		return NewAPIError(http.StatusUnprocessableEntity, "event_type must be stale_follow_up")
	}
	return validateRuleChildren(input.Conditions, input.Actions)
}

func validateRuleUpdate(input RuleUpdateInput) error {
	if input.Name.Set && input.Name.Value != nil {
		trimmed := strings.TrimSpace(*input.Name.Value)
		input.Name.Value = &trimmed
		if err := validateLength(trimmed, 1, 200, "name"); err != nil {
			return err
		}
	}
	if input.EntityType.Set && input.EntityType.Value != nil {
		if *input.EntityType.Value != "customer" && *input.EntityType.Value != "lead" {
			return NewAPIError(http.StatusUnprocessableEntity, "entity_type must be customer or lead")
		}
	}
	if input.EventType.Set && input.EventType.Value != nil && *input.EventType.Value != "stale_follow_up" {
		return NewAPIError(http.StatusUnprocessableEntity, "event_type must be stale_follow_up")
	}
	if input.Conditions.Set && input.Conditions.Value != nil {
		if len(*input.Conditions.Value) == 0 {
			return NewAPIError(http.StatusBadRequest, "规则至少需要 1 条条件")
		}
		if err := validateRuleConditions(*input.Conditions.Value); err != nil {
			return err
		}
	}
	if input.Actions.Set && input.Actions.Value != nil {
		if len(*input.Actions.Value) == 0 {
			return NewAPIError(http.StatusBadRequest, "规则至少需要 1 条动作")
		}
		if err := validateRuleActions(*input.Actions.Value); err != nil {
			return err
		}
	}
	return nil
}

func validateRuleChildren(conditions []RuleConditionInput, actions []RuleActionInput) error {
	if len(conditions) == 0 {
		return NewAPIError(http.StatusBadRequest, "规则至少需要 1 条条件")
	}
	if len(actions) == 0 {
		return NewAPIError(http.StatusBadRequest, "规则至少需要 1 条动作")
	}
	if err := validateRuleConditions(conditions); err != nil {
		return err
	}
	return validateRuleActions(actions)
}

func validateRuleConditions(conditions []RuleConditionInput) error {
	supportedFields := map[string]bool{
		"days_since_created":     true,
		"days_since_last_follow": true,
		"last_follow_at":         true,
		"status":                 true,
		"rating":                 true,
	}
	supportedOperators := map[string]bool{
		"gt": true, "gte": true, "lt": true, "lte": true,
		"eq": true, "ne": true, "is_null": true, "is_not_null": true,
	}
	for _, condition := range conditions {
		if !supportedFields[condition.Field] {
			return NewAPIError(http.StatusBadRequest, "不支持的 condition.field: "+strconv.Quote(condition.Field))
		}
		if !supportedOperators[condition.Operator] {
			return NewAPIError(http.StatusBadRequest, "不支持的 condition.operator: "+strconv.Quote(condition.Operator))
		}
		switch condition.Operator {
		case "gt", "gte", "lt", "lte":
			if condition.Value == nil || strings.TrimSpace(*condition.Value) == "" {
				return NewAPIError(http.StatusBadRequest, condition.Field+" "+condition.Operator+" 需要数字 value")
			}
			if _, err := strconv.Atoi(strings.TrimSpace(*condition.Value)); err != nil {
				return NewAPIError(http.StatusBadRequest, condition.Field+" "+condition.Operator+" 的 value 必须是整数")
			}
		case "eq", "ne":
			if condition.Value == nil || strings.TrimSpace(*condition.Value) == "" {
				return NewAPIError(http.StatusBadRequest, condition.Field+" "+condition.Operator+" 需要非空 value")
			}
		}
	}
	return nil
}

func validateRuleActions(actions []RuleActionInput) error {
	for _, action := range actions {
		if action.ActionType != "notify_owner" {
			return NewAPIError(http.StatusBadRequest, "不支持的 action_type: "+strconv.Quote(action.ActionType))
		}
	}
	return nil
}
