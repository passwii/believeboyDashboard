package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/system_management"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const dataStateTable = "public.system_management_data_state"

type SystemManagementStore struct {
	db  FullDB
	now func() time.Time
}

func NewSystemManagementStore(db FullDB) *SystemManagementStore {
	return &SystemManagementStore{db: db, now: time.Now}
}

func (s *SystemManagementStore) ListAuditLogs(
	ctx context.Context,
	filter system_management.AuditLogFilter,
) (system_management.AuditLogPage, error) {
	where, args := buildAuditWhere(filter)
	var total int
	if err := s.db.QueryRow(
		ctx,
		"select count(*) from public.operation_audit_logs "+where,
		args...,
	).Scan(&total); err != nil {
		return system_management.AuditLogPage{}, fmt.Errorf("count audit logs: %w", err)
	}
	offset := httpapi.SafeOffset(filter.Page, filter.PageSize)
	queryArgs := append(args, filter.PageSize, offset)
	rows, err := s.db.Query(
		ctx,
		`select id, created_at, operator, action, target_type, target_id, result,
		        trace_id, request_method, request_path, ip_address, user_agent,
		        before_json, after_json, error_message
		   from public.operation_audit_logs `+where+
			` order by created_at desc, id desc limit $`+strconv.Itoa(len(args)+1)+
			` offset $`+strconv.Itoa(len(args)+2),
		queryArgs...,
	)
	if err != nil {
		return system_management.AuditLogPage{}, fmt.Errorf("query audit logs: %w", err)
	}
	defer rows.Close()
	items := make([]system_management.AuditLogItem, 0, filter.PageSize)
	for rows.Next() {
		item, scanErr := scanAuditLog(rows)
		if scanErr != nil {
			return system_management.AuditLogPage{}, scanErr
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return system_management.AuditLogPage{}, err
	}
	return system_management.AuditLogPage{
		Items:    items,
		Total:    total,
		Page:     filter.Page,
		PageSize: filter.PageSize,
		HasNext:  offset < total && offset+len(items) < total,
	}, nil
}

func buildAuditWhere(filter system_management.AuditLogFilter) (string, []any) {
	where := []string{
		"not (lower(action) like '%.list' or lower(action) like '%.view')",
	}
	args := make([]any, 0, 8)
	addLike := func(column, value string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		args = append(args, "%"+value+"%")
		where = append(where, column+" ilike $"+strconv.Itoa(len(args)))
	}
	addLike("operator", filter.Operator)
	addLike("action", filter.Action)
	addLike("target_type", filter.TargetType)
	if result := strings.ToLower(strings.TrimSpace(filter.Result)); result == "success" || result == "failure" {
		args = append(args, result)
		where = append(where, "result = $"+strconv.Itoa(len(args)))
	}
	if keyword := strings.TrimSpace(filter.Keyword); keyword != "" {
		args = append(args, "%"+keyword+"%")
		placeholder := "$" + strconv.Itoa(len(args))
		where = append(where, `(operator ilike `+placeholder+
			` or action ilike `+placeholder+
			` or target_type ilike `+placeholder+
			` or request_path ilike `+placeholder+
			` or target_id ilike `+placeholder+
			` or trace_id ilike `+placeholder+
			` or error_message ilike `+placeholder+`)`)
	}
	return "where " + strings.Join(where, " and "), args
}

func scanAuditLog(row interface{ Scan(...any) error }) (system_management.AuditLogItem, error) {
	var (
		item          system_management.AuditLogItem
		createdAt     time.Time
		operator      pgtype.Text
		targetID      pgtype.Text
		traceID       pgtype.Text
		requestMethod pgtype.Text
		requestPath   pgtype.Text
		ipAddress     pgtype.Text
		userAgent     pgtype.Text
		beforeRaw     []byte
		afterRaw      []byte
		errorMessage  pgtype.Text
	)
	if err := row.Scan(
		&item.ID,
		&createdAt,
		&operator,
		&item.Action,
		&item.TargetType,
		&targetID,
		&item.Result,
		&traceID,
		&requestMethod,
		&requestPath,
		&ipAddress,
		&userAgent,
		&beforeRaw,
		&afterRaw,
		&errorMessage,
	); err != nil {
		return item, fmt.Errorf("scan audit log: %w", err)
	}
	item.CreatedAt = systemTimestamp(createdAt)
	item.Operator = Text(operator)
	item.TargetID = Text(targetID)
	item.TraceID = Text(traceID)
	item.RequestMethod = Text(requestMethod)
	item.RequestPath = Text(requestPath)
	item.IPAddress = Text(ipAddress)
	item.UserAgent = Text(userAgent)
	item.ErrorMessage = Text(errorMessage)
	item.BeforeJSON = decodeJSONValue(beforeRaw)
	item.AfterJSON = decodeJSONValue(afterRaw)
	return item, nil
}

func (s *SystemManagementStore) AuditLogSummary(
	ctx context.Context,
	filter system_management.AuditLogFilter,
) (system_management.AuditLogSummary, error) {
	where, args := buildAuditWhere(filter)
	var summary system_management.AuditLogSummary
	if err := s.db.QueryRow(
		ctx,
		`select count(*),
		        count(*) filter (where result = 'success'),
		        count(*) filter (where result = 'failure'),
		        count(distinct operator)
		   from public.operation_audit_logs `+where,
		args...,
	).Scan(
		&summary.Total,
		&summary.SuccessCount,
		&summary.FailureCount,
		&summary.UniqueOperatorCount,
	); err != nil {
		return summary, fmt.Errorf("query audit summary: %w", err)
	}
	moduleSpecs := []struct {
		key    string
		label  string
		prefix string
	}{
		{key: "commission", label: "运营报表核算", prefix: "commission.%"},
		{key: "shipment_schedules", label: "编辑发货信息管理", prefix: "shipment_schedules.%"},
		{key: "projects", label: "项目信息维护", prefix: "projects.%"},
		{key: "users", label: "账号权限维护", prefix: "users.%"},
	}
	summary.Modules = make([]system_management.AuditModuleSummary, 0, len(moduleSpecs))
	for _, spec := range moduleSpecs {
		var module system_management.AuditModuleSummary
		module.Key = spec.key
		module.Label = spec.label
		moduleArgs := append(append([]any{}, args...), spec.prefix)
		if err := s.db.QueryRow(
			ctx,
			`select count(*),
			        count(*) filter (where result = 'success'),
			        count(*) filter (where result = 'failure')
			   from public.operation_audit_logs `+where+
				` and action like $`+strconv.Itoa(len(moduleArgs)),
			moduleArgs...,
		).Scan(&module.Count, &module.SuccessCount, &module.FailureCount); err != nil {
			return summary, fmt.Errorf("query audit module summary: %w", err)
		}
		summary.Modules = append(summary.Modules, module)
	}
	topArgs := append(append([]any{}, args...), 6)
	rows, err := s.db.Query(
		ctx,
		`select action, count(*) from public.operation_audit_logs `+where+
			` group by action order by count(*) desc, action asc limit $`+strconv.Itoa(len(topArgs)),
		topArgs...,
	)
	if err != nil {
		return summary, fmt.Errorf("query top audit actions: %w", err)
	}
	defer rows.Close()
	summary.TopActions = make([]system_management.AuditActionSummary, 0, 6)
	for rows.Next() {
		var item system_management.AuditActionSummary
		if err := rows.Scan(&item.Action, &item.Count); err != nil {
			return summary, err
		}
		summary.TopActions = append(summary.TopActions, item)
	}
	return summary, rows.Err()
}

func (s *SystemManagementStore) ListAgentAccessLogs(
	ctx context.Context,
	filter system_management.AgentAccessLogFilter,
) (system_management.AgentAccessLogPage, error) {
	where, args := buildAgentAccessWhere(filter)
	var total int
	if err := s.db.QueryRow(
		ctx,
		`select count(*) from public.agent_api_audit_log l
		   left join public.agent_api_keys k on k.id = l.api_key_id `+where,
		args...,
	).Scan(&total); err != nil {
		return system_management.AgentAccessLogPage{}, fmt.Errorf("count agent access logs: %w", err)
	}
	offset := httpapi.SafeOffset(filter.Page, filter.PageSize)
	queryArgs := append(args, filter.PageSize, offset)
	rows, err := s.db.Query(
		ctx,
		`select l.id, l.created_at, l.method, l.path, l.status_code, l.latency_ms,
		        l.ip_address, l.api_key_id, k.agent_id, k.label, l.project_id,
		        l.operation_type, l.country
		   from public.agent_api_audit_log l
		   left join public.agent_api_keys k on k.id = l.api_key_id `+where+
			` order by l.id desc limit $`+strconv.Itoa(len(args)+1)+
			` offset $`+strconv.Itoa(len(args)+2),
		queryArgs...,
	)
	if err != nil {
		return system_management.AgentAccessLogPage{}, fmt.Errorf("query agent access logs: %w", err)
	}
	defer rows.Close()
	items := make([]system_management.AgentAccessLogItem, 0, filter.PageSize)
	projectIDs := make([]int64, 0)
	for rows.Next() {
		var (
			item          system_management.AgentAccessLogItem
			createdAt     time.Time
			ipAddress     pgtype.Text
			apiKeyID      pgtype.Int8
			agentID       pgtype.Text
			keyLabel      pgtype.Text
			projectID     pgtype.Int8
			operationType pgtype.Text
			country       pgtype.Text
		)
		if err := rows.Scan(
			&item.ID,
			&createdAt,
			&item.Method,
			&item.Path,
			&item.StatusCode,
			&item.LatencyMS,
			&ipAddress,
			&apiKeyID,
			&agentID,
			&keyLabel,
			&projectID,
			&operationType,
			&country,
		); err != nil {
			return system_management.AgentAccessLogPage{}, fmt.Errorf("scan agent access log: %w", err)
		}
		item.CreatedAt = systemTimestamp(createdAt)
		item.IPAddress = Text(ipAddress)
		item.APIKeyID = int8Pointer(apiKeyID)
		item.AgentID = Text(agentID)
		item.KeyLabel = Text(keyLabel)
		item.ProjectID = int8Pointer(projectID)
		item.OperationType = Text(operationType)
		item.Country = Text(country)
		if item.ProjectID != nil {
			projectIDs = append(projectIDs, *item.ProjectID)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return system_management.AgentAccessLogPage{}, err
	}
	projectNames, err := s.loadProjectNames(ctx, projectIDs)
	if err != nil {
		return system_management.AgentAccessLogPage{}, err
	}
	for index := range items {
		if items[index].ProjectID != nil {
			items[index].ProjectName = projectNames[*items[index].ProjectID]
		}
	}
	return system_management.AgentAccessLogPage{
		Items:    items,
		Total:    total,
		Page:     filter.Page,
		PageSize: filter.PageSize,
		HasNext:  offset < total && offset+len(items) < total,
	}, nil
}

func buildAgentAccessWhere(filter system_management.AgentAccessLogFilter) (string, []any) {
	where := []string{"true"}
	args := make([]any, 0, 12)
	addArg := func(value any, condition func(string) string) {
		args = append(args, value)
		where = append(where, condition("$"+strconv.Itoa(len(args))))
	}
	if keyword := strings.TrimSpace(filter.Keyword); keyword != "" {
		addArg("%"+keyword+"%", func(placeholder string) string {
			return `(k.agent_id ilike ` + placeholder +
				` or k.label ilike ` + placeholder +
				` or l.path ilike ` + placeholder +
				` or l.method ilike ` + placeholder + `)`
		})
	}
	if method := strings.ToUpper(strings.TrimSpace(filter.Method)); method != "" {
		addArg(method, func(placeholder string) string {
			return "l.method = " + placeholder
		})
	}
	if filter.StatusCode != nil {
		addArg(*filter.StatusCode, func(placeholder string) string {
			return "l.status_code = " + placeholder
		})
	}
	switch strings.ToLower(strings.TrimSpace(filter.Result)) {
	case "success":
		where = append(where, "l.status_code between 200 and 299")
	case "error":
		where = append(where, "l.status_code >= 400")
	}
	if filter.DateFrom != "" {
		addArg(filter.DateFrom, func(placeholder string) string {
			return "l.created_at::date >= " + placeholder + "::date"
		})
	}
	if filter.DateTo != "" {
		addArg(filter.DateTo, func(placeholder string) string {
			return "l.created_at::date <= " + placeholder + "::date"
		})
	}
	if filter.ProjectID != nil {
		addArg(*filter.ProjectID, func(placeholder string) string {
			return "l.project_id = " + placeholder
		})
	}
	if operationType := strings.TrimSpace(filter.OperationType); operationType != "" {
		addArg(operationType, func(placeholder string) string {
			return "l.operation_type = " + placeholder
		})
	}
	if country := strings.ToUpper(strings.TrimSpace(filter.Country)); country != "" {
		addArg(country, func(placeholder string) string {
			return "l.country = " + placeholder
		})
	}
	return "where " + strings.Join(where, " and "), args
}

func (s *SystemManagementStore) AgentAccessLogSummary(
	ctx context.Context,
	filter system_management.AgentAccessLogFilter,
) (system_management.AgentAccessLogSummary, error) {
	where, args := buildAgentAccessWhere(filter)
	var summary system_management.AgentAccessLogSummary
	if err := s.db.QueryRow(
		ctx,
		`select count(*),
		        count(*) filter (where l.status_code between 200 and 299),
		        count(*) filter (where l.status_code >= 400),
		        count(distinct k.agent_id) filter (where k.agent_id is not null)
		   from public.agent_api_audit_log l
		   left join public.agent_api_keys k on k.id = l.api_key_id `+where,
		args...,
	).Scan(
		&summary.Total,
		&summary.SuccessCount,
		&summary.ErrorCount,
		&summary.UniqueAgentCount,
	); err != nil {
		return summary, fmt.Errorf("query agent access summary: %w", err)
	}
	topArgs := append(append([]any{}, args...), 10)
	rows, err := s.db.Query(
		ctx,
		`select k.agent_id, k.label, count(*)
		   from public.agent_api_audit_log l
		   left join public.agent_api_keys k on k.id = l.api_key_id `+where+
			` and k.agent_id is not null
		   group by k.agent_id, k.label
		   order by count(*) desc, k.agent_id asc
		   limit $`+strconv.Itoa(len(topArgs)),
		topArgs...,
	)
	if err != nil {
		return summary, fmt.Errorf("query top agents: %w", err)
	}
	defer rows.Close()
	summary.TopAgents = make([]system_management.AgentAccessSummaryItem, 0, 10)
	for rows.Next() {
		var (
			item     system_management.AgentAccessSummaryItem
			keyLabel pgtype.Text
		)
		if err := rows.Scan(&item.AgentID, &keyLabel, &item.Count); err != nil {
			return summary, err
		}
		item.KeyLabel = Text(keyLabel)
		summary.TopAgents = append(summary.TopAgents, item)
	}
	return summary, rows.Err()
}

var (
	agentProjectPathPattern  = regexp.MustCompile(`/projects/(\d+)`)
	agentShipmentPathPattern = regexp.MustCompile(`/shipments/([^/]+)`)
)

func (s *SystemManagementStore) ListAgentOperationLogs(
	ctx context.Context,
	filter system_management.AgentOperationLogFilter,
) (system_management.AgentOperationLogPage, error) {
	where, args := buildAgentOperationWhere(filter)
	var total int
	if err := s.db.QueryRow(
		ctx,
		"select count(*) from public.operation_audit_logs "+where,
		args...,
	).Scan(&total); err != nil {
		return system_management.AgentOperationLogPage{}, fmt.Errorf("count agent operation logs: %w", err)
	}
	offset := httpapi.SafeOffset(filter.Page, filter.PageSize)
	queryArgs := append(args, filter.PageSize, offset)
	rows, err := s.db.Query(
		ctx,
		`select id, created_at, agent_id, agent_name, action, target_type,
		        target_id, result, request_path, request_method, before_json,
		        after_json, idempotency_key, error_message
		   from public.operation_audit_logs `+where+
			` order by created_at desc, id desc limit $`+strconv.Itoa(len(args)+1)+
			` offset $`+strconv.Itoa(len(args)+2),
		queryArgs...,
	)
	if err != nil {
		return system_management.AgentOperationLogPage{}, fmt.Errorf("query agent operation logs: %w", err)
	}
	defer rows.Close()
	items := make([]system_management.AgentOperationLogItem, 0, filter.PageSize)
	projectIDs := make([]int64, 0)
	for rows.Next() {
		var (
			item          system_management.AgentOperationLogItem
			createdAt     time.Time
			agentID       pgtype.Text
			agentName     pgtype.Text
			targetID      pgtype.Text
			requestPath   pgtype.Text
			requestMethod pgtype.Text
			beforeRaw     []byte
			afterRaw      []byte
			idempotency   pgtype.Text
			errorMessage  pgtype.Text
		)
		if err := rows.Scan(
			&item.ID,
			&createdAt,
			&agentID,
			&agentName,
			&item.Action,
			&item.TargetType,
			&targetID,
			&item.Result,
			&requestPath,
			&requestMethod,
			&beforeRaw,
			&afterRaw,
			&idempotency,
			&errorMessage,
		); err != nil {
			return system_management.AgentOperationLogPage{}, fmt.Errorf("scan agent operation log: %w", err)
		}
		item.CreatedAt = systemTimestamp(createdAt)
		item.AgentID = Text(agentID)
		item.AgentName = Text(agentName)
		item.TargetID = Text(targetID)
		item.RequestPath = Text(requestPath)
		item.RequestMethod = Text(requestMethod)
		item.BeforeJSON = decodeJSONValue(beforeRaw)
		item.AfterJSON = decodeJSONValue(afterRaw)
		item.IdempotencyKey = Text(idempotency)
		item.ErrorMessage = Text(errorMessage)
		item.ProjectID = deriveAgentProjectID(item.RequestPath, item.BeforeJSON, item.AfterJSON)
		if item.ProjectID != nil {
			projectIDs = append(projectIDs, *item.ProjectID)
		}
		item.TargetLabel = deriveAgentTargetLabel(item.RequestPath, item.BeforeJSON, item.AfterJSON)
		item.OperationType = deriveAgentOperationType(item.Action)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return system_management.AgentOperationLogPage{}, err
	}
	projectNames, err := s.loadProjectNames(ctx, projectIDs)
	if err != nil {
		return system_management.AgentOperationLogPage{}, err
	}
	for index := range items {
		if items[index].ProjectID != nil {
			items[index].ProjectName = projectNames[*items[index].ProjectID]
		}
	}
	return system_management.AgentOperationLogPage{
		Items:    items,
		Total:    total,
		Page:     filter.Page,
		PageSize: filter.PageSize,
		HasNext:  offset < total && offset+len(items) < total,
	}, nil
}

func buildAgentOperationWhere(filter system_management.AgentOperationLogFilter) (string, []any) {
	where := []string{"agent_id is not null"}
	args := make([]any, 0, 10)
	addArg := func(value any, condition string) {
		args = append(args, value)
		placeholder := "$" + strconv.Itoa(len(args))
		where = append(where, strings.ReplaceAll(condition, "?", placeholder))
	}
	if agentID := strings.TrimSpace(filter.AgentID); agentID != "" {
		addArg("%"+agentID+"%", "agent_id ilike ?")
	}
	if filter.ProjectID != nil {
		addArg(fmt.Sprintf("%%/projects/%d/%%", *filter.ProjectID), "request_path like ?")
	}
	if action := strings.TrimSpace(filter.Action); action != "" {
		addArg("%"+action+"%", "action ilike ?")
	}
	if result := strings.ToLower(strings.TrimSpace(filter.Result)); result == "success" || result == "failure" {
		addArg(result, "result = ?")
	}
	if filter.DateFrom != "" {
		addArg(filter.DateFrom, "created_at::date >= ?::date")
	}
	if filter.DateTo != "" {
		addArg(filter.DateTo, "created_at::date <= ?::date")
	}
	if keyword := strings.TrimSpace(filter.Keyword); keyword != "" {
		addArg("%"+keyword+"%", `(agent_id ilike ? or action ilike ? or target_type ilike ? or target_id ilike ? or request_path ilike ? or error_message ilike ?)`)
	}
	return "where " + strings.Join(where, " and "), args
}

func (s *SystemManagementStore) AgentOperationLogSummary(
	ctx context.Context,
	filter system_management.AgentOperationLogFilter,
) (system_management.AgentOperationLogSummary, error) {
	where, args := buildAgentOperationWhere(filter)
	var summary system_management.AgentOperationLogSummary
	if err := s.db.QueryRow(
		ctx,
		`select count(*),
		        count(*) filter (where result = 'success'),
		        count(*) filter (where result = 'failure'),
		        count(distinct agent_id)
		   from public.operation_audit_logs `+where,
		args...,
	).Scan(
		&summary.Total,
		&summary.SuccessCount,
		&summary.FailureCount,
		&summary.UniqueAgentCount,
	); err != nil {
		return summary, fmt.Errorf("query agent operation summary: %w", err)
	}
	topAgentArgs := append(append([]any{}, args...), 10)
	rows, err := s.db.Query(
		ctx,
		`select agent_id, agent_name, count(*)
		   from public.operation_audit_logs `+where+
			` group by agent_id, agent_name
		   order by count(*) desc, agent_id asc limit $`+strconv.Itoa(len(topAgentArgs)),
		topAgentArgs...,
	)
	if err != nil {
		return summary, fmt.Errorf("query top operation agents: %w", err)
	}
	defer rows.Close()
	summary.TopAgents = make([]system_management.AgentOperationSummaryItem, 0, 10)
	for rows.Next() {
		var (
			item      system_management.AgentOperationSummaryItem
			agentName pgtype.Text
		)
		if err := rows.Scan(&item.AgentID, &agentName, &item.Count); err != nil {
			return summary, err
		}
		item.AgentName = Text(agentName)
		summary.TopAgents = append(summary.TopAgents, item)
	}
	if err := rows.Err(); err != nil {
		return summary, err
	}
	rows.Close()
	topActionArgs := append(append([]any{}, args...), 10)
	actionRows, err := s.db.Query(
		ctx,
		`select action, count(*) from public.operation_audit_logs `+where+
			` group by action order by count(*) desc, action asc limit $`+strconv.Itoa(len(topActionArgs)),
		topActionArgs...,
	)
	if err != nil {
		return summary, fmt.Errorf("query top operation actions: %w", err)
	}
	defer actionRows.Close()
	summary.TopActions = make([]system_management.AgentOperationActionSummaryItem, 0, 10)
	for actionRows.Next() {
		var item system_management.AgentOperationActionSummaryItem
		if err := actionRows.Scan(&item.Action, &item.Count); err != nil {
			return summary, err
		}
		summary.TopActions = append(summary.TopActions, item)
	}
	return summary, actionRows.Err()
}

func (s *SystemManagementStore) loadProjectNames(
	ctx context.Context,
	projectIDs []int64,
) (map[int64]*string, error) {
	result := make(map[int64]*string)
	if len(projectIDs) == 0 {
		return result, nil
	}
	ids := uniqueInt64s(projectIDs)
	rows, err := s.db.Query(
		ctx,
		"select id, project_name from public.projects where id = any($1::bigint[])",
		ids,
	)
	if err != nil {
		return nil, fmt.Errorf("query project names: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id   int64
			name string
		)
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		value := name
		result[id] = &value
	}
	return result, rows.Err()
}

func (s *SystemManagementStore) ListOperatorPerformance(
	ctx context.Context,
	reportMonth string,
	projectID *int64,
) ([]system_management.OperatorPerformanceItem, error) {
	query := `select id, report_month, week_index, project_id, project_name,
	                 person_name, role_type, score, note, updated_by, updated_at
	            from public.operator_performance_records
	           where report_month = $1`
	args := []any{reportMonth}
	if projectID != nil {
		args = append(args, *projectID)
		query += " and project_id = $2"
	}
	query += ` order by person_name asc, project_name asc, week_index asc`
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query operator performance: %w", err)
	}
	defer rows.Close()
	items := make([]system_management.OperatorPerformanceItem, 0)
	for rows.Next() {
		item, scanErr := scanOperatorPerformance(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *SystemManagementStore) UpsertOperatorPerformance(
	ctx context.Context,
	items []system_management.OperatorPerformanceUpsertItem,
	operator *string,
) (string, []system_management.OperatorPerformanceItem, error) {
	if len(items) == 0 {
		return "", []system_management.OperatorPerformanceItem{}, nil
	}
	touchedMonths := make(map[string]struct{}, len(items))
	var response []system_management.OperatorPerformanceItem
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		for _, item := range items {
			touchedMonths[item.ReportMonth] = struct{}{}
			note := trimOptional(item.Note)
			var rowID int64
			found := false
			if item.ID != nil {
				err := txDB.QueryRow(
					ctx,
					"select id from public.operator_performance_records where id = $1",
					*item.ID,
				).Scan(&rowID)
				if err != nil && !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
				found = err == nil
			}
			if !found {
				err := txDB.QueryRow(
					ctx,
					`select id from public.operator_performance_records
					  where report_month = $1 and week_index = $2 and project_id = $3
					    and person_name = $4 and role_type = $5`,
					item.ReportMonth,
					item.WeekIndex,
					item.ProjectID,
					item.PersonName,
					item.RoleType,
				).Scan(&rowID)
				if err != nil && !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
				found = err == nil
			}
			if found {
				if _, err := txDB.Exec(
					ctx,
					`update public.operator_performance_records
					    set report_month = $2, week_index = $3, project_id = $4,
					        project_name = $5, person_name = $6, role_type = $7,
					        score = $8, note = $9, updated_by = $10, updated_at = now()
					  where id = $1`,
					rowID,
					item.ReportMonth,
					item.WeekIndex,
					item.ProjectID,
					item.ProjectName,
					item.PersonName,
					item.RoleType,
					item.Score,
					note,
					operator,
				); err != nil {
					return err
				}
			} else {
				if _, err := txDB.Exec(
					ctx,
					`insert into public.operator_performance_records (
					    report_month, week_index, project_id, project_name,
					    person_name, role_type, score, note, updated_by, created_at, updated_at
					 ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())`,
					item.ReportMonth,
					item.WeekIndex,
					item.ProjectID,
					item.ProjectName,
					item.PersonName,
					item.RoleType,
					item.Score,
					note,
					operator,
				); err != nil {
					return err
				}
			}
		}
		months := make([]string, 0, len(touchedMonths))
		for month := range touchedMonths {
			months = append(months, month)
		}
		sort.Strings(months)
		targetMonth := months[len(months)-1]
		rows, err := txDB.Query(
			ctx,
			`select id, report_month, week_index, project_id, project_name,
			        person_name, role_type, score, note, updated_by, updated_at
			   from public.operator_performance_records
			  where report_month = $1
			  order by person_name asc, project_name asc, week_index asc`,
			targetMonth,
		)
		if err != nil {
			return err
		}
		defer rows.Close()
		response = make([]system_management.OperatorPerformanceItem, 0)
		for rows.Next() {
			row, scanErr := scanOperatorPerformance(rows)
			if scanErr != nil {
				return scanErr
			}
			response = append(response, row)
		}
		return rows.Err()
	})
	if err != nil {
		return "", nil, fmt.Errorf("upsert operator performance: %w", err)
	}
	months := make([]string, 0, len(touchedMonths))
	for month := range touchedMonths {
		months = append(months, month)
	}
	sort.Strings(months)
	return months[len(months)-1], response, nil
}

func scanOperatorPerformance(row interface{ Scan(...any) error }) (
	system_management.OperatorPerformanceItem,
	error,
) {
	var (
		item      system_management.OperatorPerformanceItem
		note      pgtype.Text
		updatedBy pgtype.Text
		updatedAt time.Time
	)
	if err := row.Scan(
		&item.ID,
		&item.ReportMonth,
		&item.WeekIndex,
		&item.ProjectID,
		&item.ProjectName,
		&item.PersonName,
		&item.RoleType,
		&item.Score,
		&note,
		&updatedBy,
		&updatedAt,
	); err != nil {
		return item, fmt.Errorf("scan operator performance: %w", err)
	}
	item.Note = Text(note)
	item.UpdatedBy = Text(updatedBy)
	item.UpdatedAt = systemTimestamp(updatedAt)
	return item, nil
}

func (s *SystemManagementStore) GetDataStatus(
	ctx context.Context,
) (system_management.DataState, error) {
	if err := s.ensureDataStateTable(ctx); err != nil {
		return system_management.DataState{}, err
	}
	var (
		state     system_management.DataState
		status    string
		note      pgtype.Text
		updatedBy pgtype.Text
		updatedAt *time.Time
	)
	err := s.db.QueryRow(
		ctx,
		`select status, note, updated_by, updated_at
		   from `+dataStateTable+` where id = 1`,
	).Scan(&status, &note, &updatedBy, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return system_management.DataState{
			Status: system_management.DataStatusActive,
		}, nil
	}
	if err != nil {
		return state, fmt.Errorf("load data status: %w", err)
	}
	state.Status = normalizeDataStatus(status)
	state.Note = Text(note)
	state.UpdatedBy = Text(updatedBy)
	if updatedAt != nil {
		formatted := formatNaiveTimestamp(*updatedAt)
		state.UpdatedAt = &formatted
	}
	return state, nil
}

func (s *SystemManagementStore) SetDataStatus(
	ctx context.Context,
	status system_management.DataLifecycleStatus,
	note *string,
	operator *string,
) (system_management.DataState, error) {
	if err := s.ensureDataStateTable(ctx); err != nil {
		return system_management.DataState{}, err
	}
	now := s.now().Truncate(time.Second)
	status = normalizeDataStatus(string(status))
	if _, err := s.db.Exec(
		ctx,
		`insert into `+dataStateTable+` (id, status, note, updated_by, updated_at)
		 values (1, $1, $2, $3, $4)
		 on conflict (id) do update
		    set status = excluded.status,
		        note = excluded.note,
		        updated_by = excluded.updated_by,
		        updated_at = excluded.updated_at`,
		string(status),
		note,
		operator,
		now,
	); err != nil {
		return system_management.DataState{}, fmt.Errorf("set data status: %w", err)
	}
	formatted := formatNaiveTimestamp(now)
	return system_management.DataState{
		Status:    status,
		Note:      note,
		UpdatedAt: &formatted,
		UpdatedBy: operator,
	}, nil
}

func (s *SystemManagementStore) InspectDataManagement(
	ctx context.Context,
) (system_management.DataManagementSnapshot, error) {
	checkedAt := s.now()
	healthy := true
	if err := s.db.QueryRow(ctx, "select 1").Scan(new(int)); err != nil {
		healthy = false
	}
	state, err := s.GetDataStatus(ctx)
	if err != nil {
		return system_management.DataManagementSnapshot{}, err
	}
	tableNames, timestampColumns, err := s.loadTableMetadata(ctx)
	if err != nil {
		return system_management.DataManagementSnapshot{}, err
	}
	tables := make([]system_management.TableStatusItem, 0, len(tableNames))
	var totalRows int64
	staleTables := 0
	staleBefore := checkedAt.Add(-72 * time.Hour)
	for _, tableName := range tableNames {
		item := system_management.TableStatusItem{
			TableName:   tableName,
			TableNameCN: tableNameLabel(tableName),
			Status:      system_management.TableHealthy,
		}
		quoted := pgx.Identifier{tableName}.Sanitize()
		var rowCount int64
		if err := s.db.QueryRow(
			ctx,
			"select count(*) from "+quoted,
		).Scan(&rowCount); err != nil {
			note := "读取失败: " + errorClassName(err)
			item.Status = system_management.TableError
			item.Note = &note
			tables = append(tables, item)
			continue
		}
		item.RowCount = &rowCount
		totalRows += rowCount
		timestampColumn := timestampColumns[tableName]
		if timestampColumn != "" {
			var lastUpdated *time.Time
			if err := s.db.QueryRow(
				ctx,
				"select max("+pgx.Identifier{timestampColumn}.Sanitize()+") from "+quoted,
			).Scan(&lastUpdated); err != nil {
				note := "读取失败: " + errorClassName(err)
				item.Status = system_management.TableError
				item.Note = &note
				tables = append(tables, item)
				continue
			}
			if lastUpdated != nil {
				formatted := systemTimestamp(*lastUpdated)
				item.LastUpdatedAt = &formatted
			}
			if rowCount == 0 {
				item.Status = system_management.TableEmpty
				item.Note = smStringPointer("表中暂无数据")
			} else if lastUpdated != nil && lastUpdated.Before(staleBefore) {
				item.Status = system_management.TableStale
				item.Note = smStringPointer("超过 72 小时无更新")
				staleTables++
			} else {
				item.Note = smStringPointer("运行正常")
			}
		} else if rowCount == 0 {
			item.Status = system_management.TableEmpty
			item.Note = smStringPointer("表中暂无数据")
		} else {
			item.Note = smStringPointer("运行正常")
		}
		tables = append(tables, item)
	}
	recent := []system_management.RecentStatusItem{{
		Source:     "data-status",
		Level:      "info",
		Message:    "当前数据状态: " + string(state.Status),
		OccurredAt: systemTimestamp(checkedAt),
	}}
	if hasJobs, err := s.jobsTablesExist(ctx); err == nil && hasJobs {
		rows, queryErr := s.db.Query(
			ctx,
			`select j.job_type,
			        j.status,
			        coalesce(jr.error_message, jr.log_excerpt, '任务执行记录'),
			        coalesce(jr.finished_at, jr.started_at)
			   from public.job_runs jr
			   join public.jobs j on j.id = jr.job_id
			  order by jr.started_at desc
			  limit 8`,
		)
		if queryErr == nil {
			defer rows.Close()
			for rows.Next() {
				var (
					source     string
					level      string
					message    string
					occurredAt *time.Time
				)
				if scanErr := rows.Scan(&source, &level, &message, &occurredAt); scanErr != nil {
					return system_management.DataManagementSnapshot{}, scanErr
				}
				occurred := systemTimestamp(checkedAt)
				if occurredAt != nil {
					occurred = systemTimestamp(*occurredAt)
				}
				recent = append(recent, system_management.RecentStatusItem{
					Source:     source,
					Level:      level,
					Message:    message,
					OccurredAt: occurred,
				})
			}
			if err := rows.Err(); err != nil {
				return system_management.DataManagementSnapshot{}, err
			}
		}
	}
	return system_management.DataManagementSnapshot{
		ServerTime: systemTimestamp(checkedAt),
		Database:   system_management.DatabaseStatus{Engine: "unknown", Healthy: healthy, CheckedAt: systemTimestamp(checkedAt)},
		Summary: system_management.DataSummary{
			TotalTables: len(tables),
			TotalRows:   totalRows,
			StaleTables: staleTables,
			DataStatus:  state.Status,
		},
		DataStatusNote: state.Note,
		DataStatusAt:   state.UpdatedAt,
		DataStatusBy:   state.UpdatedBy,
		Tables:         tables,
		RecentStatuses: recent,
	}, nil
}

func (s *SystemManagementStore) ensureDataStateTable(ctx context.Context) error {
	_, err := s.db.Exec(
		ctx,
		`create table if not exists `+dataStateTable+` (
			id integer primary key,
			status varchar(32) not null,
			note text,
			updated_by varchar(255),
			updated_at timestamp not null
		)`,
	)
	if err != nil {
		return fmt.Errorf("ensure data state table: %w", err)
	}
	return nil
}

func (s *SystemManagementStore) loadTableMetadata(
	ctx context.Context,
) ([]string, map[string]string, error) {
	rows, err := s.db.Query(
		ctx,
		`select table_name
		   from information_schema.tables
		  where table_schema = 'public'
		    and table_type = 'BASE TABLE'
		    and table_name <> 'alembic_version'
		  order by table_name asc`,
	)
	if err != nil {
		return nil, nil, fmt.Errorf("query table metadata: %w", err)
	}
	defer rows.Close()
	names := make([]string, 0)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, nil, err
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	rows.Close()
	columnRows, err := s.db.Query(
		ctx,
		`select table_name, column_name
		   from information_schema.columns
		  where table_schema = 'public'
		    and column_name in ('updated_at', 'created_at')`,
	)
	if err != nil {
		return nil, nil, fmt.Errorf("query timestamp columns: %w", err)
	}
	defer columnRows.Close()
	columns := make(map[string]string, len(names))
	for columnRows.Next() {
		var (
			tableName  string
			columnName string
		)
		if err := columnRows.Scan(&tableName, &columnName); err != nil {
			return nil, nil, err
		}
		current := columns[tableName]
		if columnName == "updated_at" || current == "" {
			columns[tableName] = columnName
		}
	}
	if err := columnRows.Err(); err != nil {
		return nil, nil, err
	}
	return names, columns, nil
}

func (s *SystemManagementStore) jobsTablesExist(ctx context.Context) (bool, error) {
	var count int
	err := s.db.QueryRow(
		ctx,
		`select count(*) from information_schema.tables
		  where table_schema = 'public' and table_name in ('jobs', 'job_runs')`,
	).Scan(&count)
	return count == 2, err
}

func normalizeDataStatus(value string) system_management.DataLifecycleStatus {
	status := system_management.DataLifecycleStatus(strings.ToLower(strings.TrimSpace(value)))
	switch status {
	case system_management.DataStatusActive,
		system_management.DataStatusMaintenance,
		system_management.DataStatusReadOnly,
		system_management.DataStatusPaused:
		return status
	default:
		return system_management.DataStatusActive
	}
}

func tableNameLabel(tableName string) *string {
	value, ok := tableLabels[tableName]
	if !ok {
		return nil
	}
	return &value
}

func errorClassName(err error) string {
	typeName := fmt.Sprintf("%T", err)
	if index := strings.LastIndex(typeName, "."); index >= 0 {
		typeName = typeName[index+1:]
	}
	typeName = strings.TrimPrefix(typeName, "*")
	if typeName == "" {
		return "Error"
	}
	return typeName
}

var tableLabels = map[string]string{
	"ad_upload_budget_rows":             "广告预算数据",
	"ad_upload_campaign_rows":           "广告活动数据",
	"ad_upload_files":                   "广告上传文件",
	"ad_upload_invalid_traffic_rows":    "广告无效流量数据",
	"ad_upload_placement_rows":          "广告投放位置数据",
	"ad_upload_promoted_product_rows":   "广告推广产品数据",
	"ad_upload_purchased_product_rows":  "广告购买产品数据",
	"ad_upload_search_term_rows":        "广告搜索词数据",
	"ad_upload_search_term_share_rows":  "广告搜索词份额数据",
	"ad_upload_target_rows":             "广告定向数据",
	"ad_upload_time_trend_rows":         "广告时间趋势数据",
	"ai_conversations":                  "AI对话",
	"ai_messages":                       "AI消息",
	"analysis_ad_product_rows":          "广告产品分析数据",
	"analysis_business_rows":            "商业分析数据",
	"analysis_payment_rows":             "支付分析数据",
	"analysis_pt1_calculation":          "PT1计算数据",
	"analysis_pt_sku_details":           "PT-SKU详情数据",
	"analysis_sales_order_rows":         "销售订单分析数据",
	"analysis_source_files":             "分析数据源文件",
	"analysis_validation_runs":          "分析验证记录",
	"category_research_datasets":        "类目研究数据集",
	"category_research_product_details": "类目研究产品详情",
	"category_research_sales_trends":    "类目研究销售趋势",
	"commission_project_months":         "佣金项目月度数据",
	"commission_ratio_overrides":        "佣金比例覆盖",
	"commission_records":                "佣金记录",
	"exchange_rates":                    "汇率信息",
	"inventory_replenishment_settings":  "补货设置",
	"inventory_snapshot_rows":           "库存快照数据",
	"job_runs":                          "任务执行记录",
	"jobs":                              "任务配置",
	"monthly_report_pt3_calculation":    "月报PT3计算",
	"monthly_report_pt4_calculation":    "月报PT4计算",
	"monthly_report_transactions":       "月报交易数据",
	"monthly_reports":                   "月报",
	"operation_audit_logs":              "操作审计日志",
	"operator_performance_records":      "运营绩效记录",
	"pricing_calculation_runs":          "定价计算记录",
	"product_costs":                     "产品成本",
	"project_role_assignments":          "项目角色分配",
	"projects":                          "项目",
	"report_upload_statuses":            "报表上传状态",
	"shipment_schedule_items":           "发货计划明细",
	"shipment_schedules":                "发货计划",
	"shipment_sku_summaries":            "发货SKU汇总",
	"new_product_calculations":          "新品核算",
	"system_management_data_state":      "系统数据状态",
	"user_accounts":                     "用户账户",
	"user_presence":                     "用户在线状态",
	"weekly_payment_pt_summary":         "周付款PT汇总",
}

type commissionKey struct {
	projectID      int64
	personName     string
	incomeCategory string
}

type commissionExistingRow struct {
	id       int64
	isLocked bool
	isActive bool
}

const commissionRecordColumns = `id, report_month, country, project_id, project_name,
	project_month_id, person_name, income_category, income_total_usd,
	factory_commission_rate, operator_bonus_ratio, bonus_amount_usd,
	usd_to_rmb_rate, bonus_amount_rmb, bonus_ratio_source, manual_bonus_ratio,
	payment_status, payment_confirmed_at, payment_confirmed_by, is_locked,
	locked_at, locked_by, is_active, deactivated_at, computed_at, updated_at`

func (s *SystemManagementStore) ListCommissionRecords(
	ctx context.Context,
	filter system_management.CommissionRecordFilter,
) ([]system_management.CommissionRecordItem, error) {
	query := `select ` + commissionRecordColumns + `
	            from public.commission_records
	           where report_month = $1 and country = $2`
	args := []any{filter.ReportMonth, filter.Country}
	if !filter.IncludeInactive {
		query += " and is_active = true"
	}
	if filter.PersonName != "" {
		args = append(args, filter.PersonName)
		query += " and person_name = $" + strconv.Itoa(len(args))
	}
	query += ` order by person_name asc, project_name asc, income_category asc`
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query commission records: %w", err)
	}
	defer rows.Close()
	items := make([]system_management.CommissionRecordItem, 0)
	for rows.Next() {
		item, scanErr := scanCommissionRecord(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *SystemManagementStore) UpsertCommissionRecords(
	ctx context.Context,
	reportMonth string,
	country string,
	items []system_management.CommissionRecordUpsertItem,
	now time.Time,
) ([]system_management.CommissionRecordItem, error) {
	projects := make(map[int64]system_management.CommissionRecordUpsertItem)
	for _, item := range items {
		projects[item.ProjectID] = item
	}
	projectIDs := make([]int64, 0, len(projects))
	for projectID := range projects {
		projectIDs = append(projectIDs, projectID)
	}
	sort.Slice(projectIDs, func(i, j int) bool { return projectIDs[i] < projectIDs[j] })

	var response []system_management.CommissionRecordItem
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		projectMonthIDs := make(map[int64]int64)
		rows, err := txDB.Query(
			ctx,
			`select id, project_id from public.commission_project_months
			  where report_month = $1 and country = $2`,
			reportMonth,
			country,
		)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id, projectID int64
			if err := rows.Scan(&id, &projectID); err != nil {
				rows.Close()
				return err
			}
			projectMonthIDs[projectID] = id
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()

		for _, projectID := range projectIDs {
			item := projects[projectID]
			income := roundDecimalRat(ratFromFloat(item.IncomeTotalUSD), 2)
			rate := roundDecimalRat(ratFromFloat(item.FactoryCommissionRate), 6)
			usdRate := roundDecimalRat(ratFromFloat(item.USDToRMBRate), 8)
			commissionUSD := roundDecimalRat(
				new(big.Rat).Mul(income, rate),
				2,
			)
			commissionRMB := roundDecimalRat(
				new(big.Rat).Mul(commissionUSD, usdRate),
				2,
			)
			projectMonthID, exists := projectMonthIDs[projectID]
			if !exists {
				err := txDB.QueryRow(
					ctx,
					`insert into public.commission_project_months (
					    report_month, country, project_id, project_name,
					    income_total_usd, factory_commission_rate, usd_to_rmb_rate,
					    factory_commission_usd, factory_commission_rmb,
					    payment_status, received_rmb, computed_at, created_at, updated_at
					 ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
					           'unpaid', 0, $10, now(), now())
					 returning id`,
					reportMonth,
					country,
					projectID,
					item.ProjectName,
					numericRatArg(income, 2),
					numericRatArg(rate, 6),
					numericRatArg(usdRate, 8),
					numericRatArg(commissionUSD, 2),
					numericRatArg(commissionRMB, 2),
					now,
				).Scan(&projectMonthID)
				if err != nil {
					return err
				}
				projectMonthIDs[projectID] = projectMonthID
			} else {
				if _, err := txDB.Exec(
					ctx,
					`update public.commission_project_months
					    set project_name = $2, income_total_usd = $3,
					        factory_commission_rate = $4, usd_to_rmb_rate = $5,
					        factory_commission_usd = $6, factory_commission_rmb = $7,
					        computed_at = $8, updated_at = now()
					  where id = $1`,
					projectMonthID,
					item.ProjectName,
					numericRatArg(income, 2),
					numericRatArg(rate, 6),
					numericRatArg(usdRate, 8),
					numericRatArg(commissionUSD, 2),
					numericRatArg(commissionRMB, 2),
					now,
				); err != nil {
					return err
				}
			}
		}

		existing := make(map[commissionKey]*commissionExistingRow)
		recordRows, err := txDB.Query(
			ctx,
			`select id, project_id, person_name, income_category, is_locked, is_active
			   from public.commission_records
			  where report_month = $1 and country = $2`,
			reportMonth,
			country,
		)
		if err != nil {
			return err
		}
		for recordRows.Next() {
			var (
				row commissionExistingRow
				key commissionKey
			)
			if err := recordRows.Scan(
				&row.id,
				&key.projectID,
				&key.personName,
				&key.incomeCategory,
				&row.isLocked,
				&row.isActive,
			); err != nil {
				recordRows.Close()
				return err
			}
			copied := row
			existing[key] = &copied
		}
		if err := recordRows.Err(); err != nil {
			recordRows.Close()
			return err
		}
		recordRows.Close()

		incomingKeys := make(map[commissionKey]struct{}, len(items))
		for _, item := range items {
			key := commissionKey{
				projectID:      item.ProjectID,
				personName:     item.PersonName,
				incomeCategory: item.IncomeCategory,
			}
			incomingKeys[key] = struct{}{}
			projectMonthID := projectMonthIDs[item.ProjectID]
			existingRow := existing[key]
			if existingRow == nil {
				source := item.BonusRatioSource
				if source == "" {
					source = "rule"
				}
				manualRatio := item.ManualBonusRatio
				if manualRatio != nil {
					source = "manual"
				}
				var insertedID int64
				if err := txDB.QueryRow(
					ctx,
					`insert into public.commission_records (
					    report_month, country, project_id, project_name, project_month_id,
					    person_name, income_category, income_total_usd,
					    factory_commission_rate, operator_bonus_ratio, bonus_amount_usd,
					    usd_to_rmb_rate, bonus_amount_rmb, bonus_ratio_source,
					    manual_bonus_ratio, payment_status, is_locked, is_active,
					    computed_at, created_at, updated_at
					 ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
					           $11, $12, $13, $14, $15, 'unpaid', false, true,
					           $16, now(), now())
					 returning id`,
					reportMonth,
					country,
					item.ProjectID,
					item.ProjectName,
					projectMonthID,
					item.PersonName,
					item.IncomeCategory,
					numericScaleFloatArg(item.IncomeTotalUSD, 2),
					numericScaleFloatArg(item.FactoryCommissionRate, 6),
					numericScaleFloatArg(item.OperatorBonusRatio, 6),
					numericScaleFloatArg(item.BonusAmountUSD, 2),
					numericScaleFloatArg(item.USDToRMBRate, 8),
					numericScaleFloatArg(item.BonusAmountRMB, 2),
					source,
					optionalNumericScaleFloatArg(manualRatio, 6),
					now,
				).Scan(&insertedID); err != nil {
					return err
				}
				existing[key] = &commissionExistingRow{
					id:       insertedID,
					isActive: true,
				}
				continue
			}
			if existingRow.isLocked {
				if _, err := txDB.Exec(
					ctx,
					`update public.commission_records
					    set project_name = $2, project_month_id = $3,
					        is_active = true, deactivated_at = null, updated_at = now()
					  where id = $1`,
					existingRow.id,
					item.ProjectName,
					projectMonthID,
				); err != nil {
					return err
				}
				existingRow.isActive = true
				continue
			}
			source := item.BonusRatioSource
			if source == "" {
				source = "rule"
			}
			manualRatio := item.ManualBonusRatio
			if manualRatio != nil {
				source = "manual"
			}
			if _, err := txDB.Exec(
				ctx,
				`update public.commission_records
				    set project_name = $2, project_month_id = $3,
				        income_total_usd = $4, factory_commission_rate = $5,
				        operator_bonus_ratio = $6, bonus_amount_usd = $7,
				        usd_to_rmb_rate = $8, bonus_amount_rmb = $9,
				        bonus_ratio_source = $10, manual_bonus_ratio = $11,
				        is_active = true, deactivated_at = null,
				        computed_at = $12, updated_at = now()
				  where id = $1`,
				existingRow.id,
				item.ProjectName,
				projectMonthID,
				numericScaleFloatArg(item.IncomeTotalUSD, 2),
				numericScaleFloatArg(item.FactoryCommissionRate, 6),
				numericScaleFloatArg(item.OperatorBonusRatio, 6),
				numericScaleFloatArg(item.BonusAmountUSD, 2),
				numericScaleFloatArg(item.USDToRMBRate, 8),
				numericScaleFloatArg(item.BonusAmountRMB, 2),
				source,
				optionalNumericScaleFloatArg(manualRatio, 6),
				now,
			); err != nil {
				return err
			}
			existingRow.isActive = true
		}
		for key, row := range existing {
			if _, present := incomingKeys[key]; present || !row.isActive {
				continue
			}
			if _, err := txDB.Exec(
				ctx,
				`update public.commission_records
				    set is_active = false, deactivated_at = $2, updated_at = now()
				  where id = $1`,
				row.id,
				now,
			); err != nil {
				return err
			}
		}
		response, err = loadActiveCommissionRecords(ctx, txDB, reportMonth, country)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("upsert commission records: %w", err)
	}
	return response, nil
}

func loadActiveCommissionRecords(
	ctx context.Context,
	db DB,
	reportMonth string,
	country string,
) ([]system_management.CommissionRecordItem, error) {
	rows, err := db.Query(
		ctx,
		`select `+commissionRecordColumns+`
		   from public.commission_records
		  where report_month = $1 and country = $2 and is_active = true
		  order by person_name asc, project_name asc, income_category asc`,
		reportMonth,
		country,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]system_management.CommissionRecordItem, 0)
	for rows.Next() {
		item, err := scanCommissionRecord(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func scanCommissionRecord(row interface{ Scan(...any) error }) (
	system_management.CommissionRecordItem,
	error,
) {
	var (
		item           system_management.CommissionRecordItem
		projectMonthID pgtype.Int8
		manualRatio    pgtype.Float8
		paymentAt      *time.Time
		paymentBy      pgtype.Text
		lockedAt       *time.Time
		lockedBy       pgtype.Text
		deactivatedAt  *time.Time
		computedAt     time.Time
		updatedAt      time.Time
	)
	if err := row.Scan(
		&item.ID,
		&item.ReportMonth,
		&item.Country,
		&item.ProjectID,
		&item.ProjectName,
		&projectMonthID,
		&item.PersonName,
		&item.IncomeCategory,
		&item.IncomeTotalUSD,
		&item.FactoryCommissionRate,
		&item.OperatorBonusRatio,
		&item.BonusAmountUSD,
		&item.USDToRMBRate,
		&item.BonusAmountRMB,
		&item.BonusRatioSource,
		&manualRatio,
		&item.PaymentStatus,
		&paymentAt,
		&paymentBy,
		&item.IsLocked,
		&lockedAt,
		&lockedBy,
		&item.IsActive,
		&deactivatedAt,
		&computedAt,
		&updatedAt,
	); err != nil {
		return item, fmt.Errorf("scan commission record: %w", err)
	}
	item.ProjectMonthID = int8Pointer(projectMonthID)
	item.ManualBonusRatio = smFloat8Pointer(manualRatio)
	item.PaymentConfirmedAt = systemOptionalTimestamp(paymentAt)
	item.PaymentConfirmedBy = Text(paymentBy)
	item.LockedAt = systemOptionalTimestamp(lockedAt)
	item.LockedBy = Text(lockedBy)
	item.DeactivatedAt = systemOptionalTimestamp(deactivatedAt)
	item.ComputedAt = systemTimestamp(computedAt)
	item.UpdatedAt = systemTimestamp(updatedAt)
	return item, nil
}

func (s *SystemManagementStore) UpdateCommissionRecordPayment(
	ctx context.Context,
	recordID int64,
	status string,
	now time.Time,
	operator *string,
) (system_management.CommissionRecordMutation, error) {
	var mutation system_management.CommissionRecordMutation
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		before, err := queryCommissionRecord(ctx, txDB, recordID)
		if err != nil {
			return err
		}
		if before == nil {
			return system_management.ErrNotFound
		}
		mutation.Before = before
		if status == "paid" {
			_, err = txDB.Exec(
				ctx,
				`update public.commission_records
				    set payment_status = 'paid', payment_confirmed_at = $2,
				        payment_confirmed_by = $3, is_locked = true,
				        locked_at = $2, locked_by = $3, updated_at = now()
				  where id = $1`,
				recordID,
				now,
				operator,
			)
		} else {
			_, err = txDB.Exec(
				ctx,
				`update public.commission_records
				    set payment_status = 'unpaid', payment_confirmed_at = null,
				        payment_confirmed_by = null, is_locked = false,
				        locked_at = null, locked_by = null, updated_at = now()
				  where id = $1`,
				recordID,
			)
		}
		if err != nil {
			return err
		}
		after, err := queryCommissionRecord(ctx, txDB, recordID)
		if err != nil {
			return err
		}
		mutation.After = after
		return nil
	})
	if err != nil {
		return mutation, err
	}
	return mutation, nil
}

func queryCommissionRecord(
	ctx context.Context,
	db DB,
	recordID int64,
) (*system_management.CommissionRecordItem, error) {
	row := db.QueryRow(
		ctx,
		"select "+commissionRecordColumns+" from public.commission_records where id = $1",
		recordID,
	)
	item, err := scanCommissionRecord(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

const commissionProjectMonthColumns = `id, report_month, country, project_id,
	project_name, income_total_usd, factory_commission_rate, usd_to_rmb_rate,
	factory_commission_usd, factory_commission_rmb, payment_status, received_rmb,
	payment_confirmed_at, payment_confirmed_by, note, computed_at, updated_at`

func (s *SystemManagementStore) ListCommissionProjectMonths(
	ctx context.Context,
	reportMonth string,
	country *string,
) ([]system_management.CommissionProjectMonthItem, error) {
	query := `select ` + commissionProjectMonthColumns + `
	            from public.commission_project_months
	           where report_month = $1`
	args := []any{reportMonth}
	if country != nil && strings.TrimSpace(*country) != "" {
		args = append(args, *country)
		query += " and country = $2"
	}
	query += " order by project_id asc, country asc"
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query commission project months: %w", err)
	}
	defer rows.Close()
	items := make([]system_management.CommissionProjectMonthItem, 0)
	for rows.Next() {
		item, scanErr := scanCommissionProjectMonth(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *SystemManagementStore) UpdateCommissionProjectPayment(
	ctx context.Context,
	projectMonthID int64,
	status string,
	receivedRMB float64,
	note *string,
	now time.Time,
	operator *string,
) (system_management.CommissionProjectMonthMutation, error) {
	var mutation system_management.CommissionProjectMonthMutation
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		before, err := queryCommissionProjectMonth(ctx, txDB, projectMonthID)
		if err != nil {
			return err
		}
		if before == nil {
			return system_management.ErrNotFound
		}
		mutation.Before = before
		var confirmedAt *time.Time
		var confirmedBy *string
		if status != "unpaid" {
			confirmedAt = &now
			confirmedBy = operator
		}
		if _, err := txDB.Exec(
			ctx,
			`update public.commission_project_months
			    set payment_status = $2, received_rmb = $3, note = $4,
			        payment_confirmed_at = $5, payment_confirmed_by = $6,
			        updated_at = now()
			  where id = $1`,
			projectMonthID,
			status,
			numericScaleFloatArg(receivedRMB, 2),
			note,
			confirmedAt,
			confirmedBy,
		); err != nil {
			return err
		}
		if status == "paid" {
			if _, err := txDB.Exec(
				ctx,
				`update public.commission_records
				    set payment_status = 'paid', payment_confirmed_at = $2,
				        payment_confirmed_by = $3, is_locked = true,
				        locked_at = $2, locked_by = $3, updated_at = now()
				  where project_month_id = $1 and is_active = true`,
				projectMonthID,
				now,
				operator,
			); err != nil {
				return err
			}
		} else {
			if _, err := txDB.Exec(
				ctx,
				`update public.commission_records
				    set payment_status = 'unpaid', payment_confirmed_at = null,
				        payment_confirmed_by = null, is_locked = false,
				        locked_at = null, locked_by = null, updated_at = now()
				  where project_month_id = $1 and is_active = true`,
				projectMonthID,
			); err != nil {
				return err
			}
		}
		after, err := queryCommissionProjectMonth(ctx, txDB, projectMonthID)
		if err != nil {
			return err
		}
		mutation.After = after
		return nil
	})
	if err != nil {
		return mutation, err
	}
	return mutation, nil
}

func scanCommissionProjectMonth(row interface{ Scan(...any) error }) (
	system_management.CommissionProjectMonthItem,
	error,
) {
	var (
		item        system_management.CommissionProjectMonthItem
		confirmedAt *time.Time
		confirmedBy pgtype.Text
		note        pgtype.Text
		computedAt  time.Time
		updatedAt   time.Time
	)
	if err := row.Scan(
		&item.ID,
		&item.ReportMonth,
		&item.Country,
		&item.ProjectID,
		&item.ProjectName,
		&item.IncomeTotalUSD,
		&item.FactoryCommissionRate,
		&item.USDToRMBRate,
		&item.FactoryCommissionUSD,
		&item.FactoryCommissionRMB,
		&item.PaymentStatus,
		&item.ReceivedRMB,
		&confirmedAt,
		&confirmedBy,
		&note,
		&computedAt,
		&updatedAt,
	); err != nil {
		return item, fmt.Errorf("scan commission project month: %w", err)
	}
	item.PaymentConfirmedAt = systemOptionalTimestamp(confirmedAt)
	item.PaymentConfirmedBy = Text(confirmedBy)
	item.Note = Text(note)
	item.ComputedAt = systemTimestamp(computedAt)
	item.UpdatedAt = systemTimestamp(updatedAt)
	return item, nil
}

func queryCommissionProjectMonth(
	ctx context.Context,
	db DB,
	projectMonthID int64,
) (*system_management.CommissionProjectMonthItem, error) {
	row := db.QueryRow(
		ctx,
		"select "+commissionProjectMonthColumns+
			" from public.commission_project_months where id = $1",
		projectMonthID,
	)
	item, err := scanCommissionProjectMonth(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

const commissionRatioColumns = `id, report_month, project_id, project_name,
	person_name, income_category, override_ratio, reason, updated_by, updated_at`

func (s *SystemManagementStore) ListCommissionRatioOverrides(
	ctx context.Context,
	reportMonth string,
) ([]system_management.CommissionRatioOverrideItem, error) {
	rows, err := s.db.Query(
		ctx,
		`select `+commissionRatioColumns+`
		   from public.commission_ratio_overrides
		  where report_month = $1
		  order by person_name asc, project_name asc, income_category asc`,
		reportMonth,
	)
	if err != nil {
		return nil, fmt.Errorf("query commission ratio overrides: %w", err)
	}
	defer rows.Close()
	items := make([]system_management.CommissionRatioOverrideItem, 0)
	for rows.Next() {
		item, scanErr := scanCommissionRatioOverride(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *SystemManagementStore) UpsertCommissionRatioOverrides(
	ctx context.Context,
	reportMonth string,
	items []system_management.CommissionRatioOverrideUpsertItem,
	operator *string,
) ([]system_management.CommissionRatioOverrideItem, error) {
	type overrideKey struct {
		projectID      int64
		personName     string
		incomeCategory string
	}
	var response []system_management.CommissionRatioOverrideItem
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		type existingOverride struct {
			id int64
		}
		existing := make(map[overrideKey]existingOverride)
		rows, err := txDB.Query(
			ctx,
			`select id, project_id, person_name, income_category
			   from public.commission_ratio_overrides where report_month = $1`,
			reportMonth,
		)
		if err != nil {
			return err
		}
		for rows.Next() {
			var (
				id  int64
				key overrideKey
			)
			if err := rows.Scan(&id, &key.projectID, &key.personName, &key.incomeCategory); err != nil {
				rows.Close()
				return err
			}
			existing[key] = existingOverride{id: id}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
		incoming := make(map[overrideKey]struct{}, len(items))
		for _, item := range items {
			key := overrideKey{
				projectID:      item.ProjectID,
				personName:     item.PersonName,
				incomeCategory: item.IncomeCategory,
			}
			incoming[key] = struct{}{}
			row, found := existing[key]
			if found {
				if _, err := txDB.Exec(
					ctx,
					`update public.commission_ratio_overrides
					    set project_name = $2, override_ratio = $3,
					        reason = $4, updated_by = $5, updated_at = now()
					  where id = $1`,
					row.id,
					item.ProjectName,
					numericScaleFloatArg(item.OverrideRatio, 6),
					item.Reason,
					operator,
				); err != nil {
					return err
				}
			} else {
				var insertedID int64
				if err := txDB.QueryRow(
					ctx,
					`insert into public.commission_ratio_overrides (
					    report_month, project_id, project_name, person_name,
					    income_category, override_ratio, reason, updated_by,
					    created_at, updated_at
					 ) values ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
					 returning id`,
					reportMonth,
					item.ProjectID,
					item.ProjectName,
					item.PersonName,
					item.IncomeCategory,
					numericScaleFloatArg(item.OverrideRatio, 6),
					item.Reason,
					operator,
				).Scan(&insertedID); err != nil {
					return err
				}
				existing[key] = existingOverride{id: insertedID}
			}
		}
		for key, row := range existing {
			if _, present := incoming[key]; present {
				continue
			}
			if _, err := txDB.Exec(
				ctx,
				"delete from public.commission_ratio_overrides where id = $1",
				row.id,
			); err != nil {
				return err
			}
		}
		rows, err = txDB.Query(
			ctx,
			`select `+commissionRatioColumns+`
			   from public.commission_ratio_overrides
			  where report_month = $1
			  order by person_name asc, project_name asc, income_category asc`,
			reportMonth,
		)
		if err != nil {
			return err
		}
		defer rows.Close()
		response = make([]system_management.CommissionRatioOverrideItem, 0)
		for rows.Next() {
			item, scanErr := scanCommissionRatioOverride(rows)
			if scanErr != nil {
				return scanErr
			}
			response = append(response, item)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, fmt.Errorf("upsert commission ratio overrides: %w", err)
	}
	return response, nil
}

func scanCommissionRatioOverride(row interface{ Scan(...any) error }) (
	system_management.CommissionRatioOverrideItem,
	error,
) {
	var (
		item      system_management.CommissionRatioOverrideItem
		reason    pgtype.Text
		updatedBy pgtype.Text
		updatedAt time.Time
	)
	if err := row.Scan(
		&item.ID,
		&item.ReportMonth,
		&item.ProjectID,
		&item.ProjectName,
		&item.PersonName,
		&item.IncomeCategory,
		&item.OverrideRatio,
		&reason,
		&updatedBy,
		&updatedAt,
	); err != nil {
		return item, fmt.Errorf("scan commission ratio override: %w", err)
	}
	item.Reason = Text(reason)
	item.UpdatedBy = Text(updatedBy)
	item.UpdatedAt = systemTimestamp(updatedAt)
	return item, nil
}

const roleAssignmentColumns = `id, project_id, role_type, person_name,
	effective_from_month, effective_to_month, updated_at`

func (s *SystemManagementStore) ListProjectRoleAssignments(
	ctx context.Context,
	reportMonth *string,
	projectID *int64,
) ([]system_management.ProjectRoleAssignmentItem, error) {
	query := "select " + roleAssignmentColumns + " from public.project_role_assignments where true"
	args := make([]any, 0, 3)
	if projectID != nil {
		args = append(args, *projectID)
		query += " and project_id = $" + strconv.Itoa(len(args))
	}
	if reportMonth != nil {
		args = append(args, *reportMonth)
		placeholder := "$" + strconv.Itoa(len(args))
		query += " and effective_from_month <= " + placeholder +
			" and (effective_to_month is null or effective_to_month >= " + placeholder + ")"
	}
	query += ` order by project_id asc, role_type asc,
	                  effective_from_month asc, person_name asc`
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query role assignments: %w", err)
	}
	defer rows.Close()
	items := make([]system_management.ProjectRoleAssignmentItem, 0)
	for rows.Next() {
		item, scanErr := scanRoleAssignment(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *SystemManagementStore) UpsertProjectRoleAssignments(
	ctx context.Context,
	items []system_management.ProjectRoleAssignmentUpsertItem,
) ([]system_management.ProjectRoleAssignmentItem, error) {
	var response []system_management.ProjectRoleAssignmentItem
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		for _, item := range items {
			var existingID int64
			found := false
			if item.ID != nil {
				err := txDB.QueryRow(
					ctx,
					"select id from public.project_role_assignments where id = $1",
					*item.ID,
				).Scan(&existingID)
				if err != nil && !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
				found = err == nil
			}
			if found {
				if _, err := txDB.Exec(
					ctx,
					`update public.project_role_assignments
					    set project_id = $2, role_type = $3, person_name = $4,
					        effective_from_month = $5, effective_to_month = $6,
					        updated_at = now()
					  where id = $1`,
					existingID,
					item.ProjectID,
					item.RoleType,
					item.PersonName,
					item.EffectiveFromMonth,
					item.EffectiveToMonth,
				); err != nil {
					return err
				}
			} else {
				if _, err := txDB.Exec(
					ctx,
					`insert into public.project_role_assignments (
					    project_id, role_type, person_name, effective_from_month,
					    effective_to_month, created_at, updated_at
					 ) values ($1, $2, $3, $4, $5, now(), now())`,
					item.ProjectID,
					item.RoleType,
					item.PersonName,
					item.EffectiveFromMonth,
					item.EffectiveToMonth,
				); err != nil {
					return err
				}
			}
		}
		rows, err := txDB.Query(
			ctx,
			`select `+roleAssignmentColumns+`
			   from public.project_role_assignments
			  order by project_id asc, role_type asc,
			           effective_from_month asc, person_name asc`,
		)
		if err != nil {
			return err
		}
		defer rows.Close()
		response = make([]system_management.ProjectRoleAssignmentItem, 0)
		for rows.Next() {
			item, scanErr := scanRoleAssignment(rows)
			if scanErr != nil {
				return scanErr
			}
			response = append(response, item)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, fmt.Errorf("upsert role assignments: %w", err)
	}
	return response, nil
}

func scanRoleAssignment(row interface{ Scan(...any) error }) (
	system_management.ProjectRoleAssignmentItem,
	error,
) {
	var (
		item      system_management.ProjectRoleAssignmentItem
		toMonth   pgtype.Text
		updatedAt time.Time
	)
	if err := row.Scan(
		&item.ID,
		&item.ProjectID,
		&item.RoleType,
		&item.PersonName,
		&item.EffectiveFromMonth,
		&toMonth,
		&updatedAt,
	); err != nil {
		return item, fmt.Errorf("scan role assignment: %w", err)
	}
	item.EffectiveToMonth = Text(toMonth)
	item.UpdatedAt = systemTimestamp(updatedAt)
	return item, nil
}

func (s *SystemManagementStore) GetCommissionMonthlySummary(
	ctx context.Context,
	year string,
	country *string,
) ([]system_management.CommissionYearlyMonthlySummaryItem, error) {
	monthStart := year + "-01"
	monthEnd := year + "-12"
	query := `select report_month,
	                 coalesce(sum(income_total_usd), 0),
	                 coalesce(sum(factory_commission_usd), 0),
	                 coalesce(sum(factory_commission_rmb), 0),
	                 coalesce(sum(received_rmb), 0)
	            from public.commission_project_months
	           where report_month >= $1 and report_month <= $2`
	args := []any{monthStart, monthEnd}
	if country != nil && strings.TrimSpace(*country) != "" {
		args = append(args, *country)
		query += " and country = $3"
	}
	query += " group by report_month order by report_month asc"
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query commission monthly summary: %w", err)
	}
	defer rows.Close()
	type values struct {
		income        float64
		commission    float64
		commissionRMB float64
		received      float64
	}
	byMonth := make(map[string]values)
	for rows.Next() {
		var (
			month string
			value values
		)
		if err := rows.Scan(
			&month,
			&value.income,
			&value.commission,
			&value.commissionRMB,
			&value.received,
		); err != nil {
			return nil, err
		}
		byMonth[month] = value
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	items := make([]system_management.CommissionYearlyMonthlySummaryItem, 0, 12)
	for month := 1; month <= 12; month++ {
		monthKey := fmt.Sprintf("%s-%02d", year, month)
		value := byMonth[monthKey]
		receiveRate := 0.0
		if value.commissionRMB > 0 {
			receiveRate = value.received / value.commissionRMB
		}
		items = append(items, system_management.CommissionYearlyMonthlySummaryItem{
			ReportMonth:          monthKey,
			IncomeTotalUSD:       value.income,
			FactoryCommissionUSD: value.commission,
			FactoryCommissionRMB: value.commissionRMB,
			ReceivedRMB:          value.received,
			ReceiveRate:          receiveRate,
		})
	}
	return items, nil
}

func (s *SystemManagementStore) GetCommissionProjectSummary(
	ctx context.Context,
	year string,
	country *string,
) ([]system_management.CommissionProjectYearlySummaryItem, error) {
	monthStart := year + "-01"
	monthEnd := year + "-12"
	query := `select project_id, report_month, max(project_name),
	                 coalesce(sum(income_total_usd), 0),
	                 coalesce(sum(factory_commission_rmb), 0),
	                 coalesce(sum(received_rmb), 0)
	            from public.commission_project_months
	           where report_month >= $1 and report_month <= $2`
	args := []any{monthStart, monthEnd}
	if country != nil && strings.TrimSpace(*country) != "" {
		args = append(args, *country)
		query += " and country = $3"
	}
	query += ` group by project_id, report_month
	           order by project_id asc, report_month asc`
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query commission project summary: %w", err)
	}
	defer rows.Close()
	byProject := make(map[int64]*system_management.CommissionProjectYearlySummaryItem)
	for rows.Next() {
		var (
			projectID     int64
			month         string
			projectName   string
			income        float64
			commissionRMB float64
			receivedRMB   float64
		)
		if err := rows.Scan(
			&projectID,
			&month,
			&projectName,
			&income,
			&commissionRMB,
			&receivedRMB,
		); err != nil {
			return nil, err
		}
		item := byProject[projectID]
		if item == nil {
			item = &system_management.CommissionProjectYearlySummaryItem{
				ProjectID:   projectID,
				ProjectName: projectName,
				Months:      make(map[string]system_management.CommissionProjectMonthlySummaryMonthItem),
			}
			byProject[projectID] = item
		}
		receiveRate := 0.0
		if commissionRMB > 0 {
			receiveRate = receivedRMB / commissionRMB
		}
		item.Months[month] = system_management.CommissionProjectMonthlySummaryMonthItem{
			ReportMonth:          month,
			IncomeTotalUSD:       income,
			FactoryCommissionRMB: commissionRMB,
			ReceivedRMB:          receivedRMB,
			ReceiveRate:          receiveRate,
		}
		item.TotalIncomeUSD += income
		item.TotalCommissionRMB += commissionRMB
		item.TotalReceivedRMB += receivedRMB
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	projectIDs := make([]int64, 0, len(byProject))
	for projectID := range byProject {
		projectIDs = append(projectIDs, projectID)
	}
	sort.Slice(projectIDs, func(i, j int) bool { return projectIDs[i] < projectIDs[j] })
	items := make([]system_management.CommissionProjectYearlySummaryItem, 0, len(projectIDs))
	for _, projectID := range projectIDs {
		item := byProject[projectID]
		if item.TotalCommissionRMB > 0 {
			item.ReceiveRate = item.TotalReceivedRMB / item.TotalCommissionRMB
		}
		items = append(items, *item)
	}
	return items, nil
}

type commissionProjectInfo struct {
	name              string
	commissionBasis   *string
	commissionRate    *float64
	projectOperator   *string
	assistantOperator *string
}

func (s *SystemManagementStore) RecomputeCommission(
	ctx context.Context,
	input system_management.RecomputeCommissionInput,
) (system_management.RecomputeCommissionResult, error) {
	// Each country uses its reporting currency converted to USD, then applies
	// the project's commission basis, role assignments, and ratio overrides.
	// All mutated countries share one transaction to keep the recompute atomic.
	countries := []string{"US", "UK", "DE"}
	if input.Country != nil {
		normalized := strings.ToUpper(strings.TrimSpace(*input.Country))
		if normalized == "" {
			return system_management.RecomputeCommissionResult{}, fmt.Errorf(
				"country must be US, UK, or DE",
			)
		}
		countries = []string{normalized}
	}
	var result system_management.RecomputeCommissionResult
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		for _, country := range countries {
			projectCount, recordCount, lockedCount, err := s.recomputeCommissionCountry(
				ctx,
				txDB,
				input.ReportMonth,
				country,
				input.Now,
			)
			if errors.Is(err, system_management.ErrExchangeRateNotFound) &&
				input.Country == nil {
				continue
			}
			if err != nil {
				return err
			}
			result.ProjectMonthCount += projectCount
			result.RecordCount += recordCount
			result.LockedRecordCount += lockedCount
		}
		return nil
	})
	if err != nil {
		return system_management.RecomputeCommissionResult{}, fmt.Errorf("recompute commission: %w", err)
	}
	return result, nil
}

func (s *SystemManagementStore) recomputeCommissionCountry(
	ctx context.Context,
	db FullDB,
	reportMonth string,
	country string,
	now time.Time,
) (int, int, int, error) {
	sourceCurrency := map[string]string{"US": "USD", "UK": "GBP", "DE": "EUR"}[country]
	if sourceCurrency == "" {
		return 0, 0, 0, fmt.Errorf("country must be US, UK, or DE")
	}
	reportRows, err := db.Query(
		ctx,
		`select mr.project_id, pt4.income_total, pt4.amazon_pay_back
		   from public.monthly_reports mr
		   join public.monthly_report_pt4_calculation pt4 on pt4.report_id = mr.id
		  where mr.report_month = $1 and mr.country = $2 and mr.is_current = true
		  order by mr.project_id asc`,
		reportMonth,
		country,
	)
	if err != nil {
		return 0, 0, 0, err
	}
	type reportInfo struct {
		projectID int64
		income    float64
		payback   float64
	}
	reports := make([]reportInfo, 0)
	projectIDs := make([]int64, 0)
	seenProjects := make(map[int64]struct{})
	for reportRows.Next() {
		var report reportInfo
		if err := reportRows.Scan(&report.projectID, &report.income, &report.payback); err != nil {
			reportRows.Close()
			return 0, 0, 0, err
		}
		reports = append(reports, report)
		if _, exists := seenProjects[report.projectID]; !exists {
			seenProjects[report.projectID] = struct{}{}
			projectIDs = append(projectIDs, report.projectID)
		}
	}
	if err := reportRows.Err(); err != nil {
		reportRows.Close()
		return 0, 0, 0, err
	}
	reportRows.Close()
	if len(projectIDs) == 0 {
		return 0, 0, 0, nil
	}

	projectRows, err := db.Query(
		ctx,
		`select id, project_name, commission_basis, commission_rate::float8,
		        project_operator, assistant_operator
		   from public.projects where id = any($1::bigint[])`,
		projectIDs,
	)
	if err != nil {
		return 0, 0, 0, err
	}
	projects := make(map[int64]commissionProjectInfo)
	for projectRows.Next() {
		var (
			projectID int64
			info      commissionProjectInfo
			basis     pgtype.Text
			rate      pgtype.Float8
			operator  pgtype.Text
			assistant pgtype.Text
		)
		if err := projectRows.Scan(
			&projectID,
			&info.name,
			&basis,
			&rate,
			&operator,
			&assistant,
		); err != nil {
			projectRows.Close()
			return 0, 0, 0, err
		}
		info.commissionBasis = Text(basis)
		info.commissionRate = smFloat8Pointer(rate)
		info.projectOperator = Text(operator)
		info.assistantOperator = Text(assistant)
		projects[projectID] = info
	}
	if err := projectRows.Err(); err != nil {
		projectRows.Close()
		return 0, 0, 0, err
	}
	projectRows.Close()

	sourceRate, err := s.exchangeRateWithFallback(ctx, db, sourceCurrency, reportMonth)
	if err != nil {
		return 0, 0, 0, err
	}
	usdRate, err := s.exchangeRateWithFallback(ctx, db, "USD", reportMonth)
	if err != nil {
		return 0, 0, 0, err
	}
	sourceToCNY := ratFromFloat(sourceRate)
	usdToCNY := ratFromFloat(usdRate)
	if usdToCNY.Sign() == 0 {
		return 0, 0, 0, fmt.Errorf("%w: USD rate is zero", system_management.ErrExchangeRateNotFound)
	}
	sourceToUSD := new(big.Rat).Quo(sourceToCNY, usdToCNY)

	roles, err := loadCommissionRoles(ctx, db, projectIDs, reportMonth)
	if err != nil {
		return 0, 0, 0, err
	}
	overrides, err := loadCommissionOverrides(ctx, db, reportMonth)
	if err != nil {
		return 0, 0, 0, err
	}
	projectMonthIDs, err := loadProjectMonthIDs(ctx, db, reportMonth, country)
	if err != nil {
		return 0, 0, 0, err
	}
	existingRecords, err := loadExistingCommissionRows(ctx, db, reportMonth, country)
	if err != nil {
		return 0, 0, 0, err
	}
	incomingKeys := make(map[commissionKey]struct{})
	lockedCount := 0
	for _, report := range reports {
		project, exists := projects[report.projectID]
		if !exists {
			continue
		}
		incomeUSD := roundDecimalRat(
			new(big.Rat).Mul(ratFromFloat(report.income), sourceToUSD),
			2,
		)
		paybackUSD := roundDecimalRat(
			new(big.Rat).Mul(ratFromFloat(report.payback), sourceToUSD),
			2,
		)
		factoryRate, factoryUSD := resolveFactoryCommission(
			project.commissionBasis,
			project.commissionRate,
			incomeUSD,
			paybackUSD,
		)
		factoryRMB := roundDecimalRat(
			new(big.Rat).Mul(factoryUSD, usdToCNY),
			2,
		)
		projectMonthID := projectMonthIDs[report.projectID]
		if projectMonthID == 0 {
			err := db.QueryRow(
				ctx,
				`insert into public.commission_project_months (
				    report_month, country, project_id, project_name,
				    income_total_usd, factory_commission_rate, usd_to_rmb_rate,
				    factory_commission_usd, factory_commission_rmb,
				    payment_status, received_rmb, computed_at, created_at, updated_at
				 ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
				           'unpaid', 0, $10, now(), now())
				 returning id`,
				reportMonth,
				country,
				report.projectID,
				project.name,
				numericRatArg(incomeUSD, 2),
				numericRatArg(factoryRate, 6),
				numericRatArg(usdToCNY, 8),
				numericRatArg(factoryUSD, 2),
				numericRatArg(factoryRMB, 2),
				now,
			).Scan(&projectMonthID)
			if err != nil {
				return 0, 0, 0, err
			}
			projectMonthIDs[report.projectID] = projectMonthID
		} else {
			if _, err := db.Exec(
				ctx,
				`update public.commission_project_months
				    set project_name = $2, income_total_usd = $3,
				        factory_commission_rate = $4, usd_to_rmb_rate = $5,
				        factory_commission_usd = $6, factory_commission_rmb = $7,
				        computed_at = $8, updated_at = now()
				  where id = $1`,
				projectMonthID,
				project.name,
				numericRatArg(incomeUSD, 2),
				numericRatArg(factoryRate, 6),
				numericRatArg(usdToCNY, 8),
				numericRatArg(factoryUSD, 2),
				numericRatArg(factoryRMB, 2),
				now,
			); err != nil {
				return 0, 0, 0, err
			}
		}
		projectRoles := roles[report.projectID]
		operatorNames := dedupeNames(projectRoles["operator"])
		if len(operatorNames) == 0 && project.projectOperator != nil {
			operatorNames = dedupeNames(splitRoleNames(*project.projectOperator))
		}
		assistantNames := dedupeNames(projectRoles["assistant"])
		if len(assistantNames) == 0 && project.assistantOperator != nil {
			assistantNames = dedupeNames(splitRoleNames(*project.assistantOperator))
		}
		ratios := buildDefaultBonusRatios(incomeUSD, operatorNames, assistantNames)
		for key, defaultRatio := range ratios {
			incomingKeys[commissionKey{
				projectID:      report.projectID,
				personName:     key.personName,
				incomeCategory: key.incomeCategory,
			}] = struct{}{}
			override, overridden := overrides[commissionKey{
				projectID:      report.projectID,
				personName:     key.personName,
				incomeCategory: key.incomeCategory,
			}]
			ratio := defaultRatio
			ratioSource := "rule"
			var manualRatio *big.Rat
			if overridden {
				ratio = override
				ratioSource = "manual"
				manualRatio = override
			}
			bonusUSD := roundDecimalRat(
				new(big.Rat).Mul(factoryUSD, ratio),
				2,
			)
			bonusRMB := roundDecimalRat(
				new(big.Rat).Mul(bonusUSD, usdToCNY),
				2,
			)
			recordKey := commissionKey{
				projectID:      report.projectID,
				personName:     key.personName,
				incomeCategory: key.incomeCategory,
			}
			existing := existingRecords[recordKey]
			if existing == nil {
				var insertedID int64
				if err := db.QueryRow(
					ctx,
					`insert into public.commission_records (
					    report_month, country, project_id, project_name, project_month_id,
					    person_name, income_category, income_total_usd,
					    factory_commission_rate, operator_bonus_ratio, bonus_amount_usd,
					    usd_to_rmb_rate, bonus_amount_rmb, bonus_ratio_source,
					    manual_bonus_ratio, payment_status, is_locked, is_active,
					    computed_at, created_at, updated_at
					 ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
					           $11, $12, $13, $14, $15, 'unpaid', false, true,
					           $16, now(), now())
					 returning id`,
					reportMonth,
					country,
					report.projectID,
					project.name,
					projectMonthID,
					key.personName,
					key.incomeCategory,
					numericRatArg(incomeUSD, 2),
					numericRatArg(factoryRate, 6),
					numericRatArg(ratio, 6),
					numericRatArg(bonusUSD, 2),
					numericRatArg(usdToCNY, 8),
					numericRatArg(bonusRMB, 2),
					ratioSource,
					optionalNumericRatArg(manualRatio, 6),
					now,
				).Scan(&insertedID); err != nil {
					return 0, 0, 0, err
				}
				existingRecords[recordKey] = &commissionExistingRow{
					id:       insertedID,
					isActive: true,
				}
			} else {
				if _, err := db.Exec(
					ctx,
					`update public.commission_records
					    set project_name = $2, project_month_id = $3,
					        income_total_usd = $4, factory_commission_rate = $5,
					        operator_bonus_ratio = $6, bonus_amount_usd = $7,
					        usd_to_rmb_rate = $8, bonus_amount_rmb = $9,
					        bonus_ratio_source = $10, manual_bonus_ratio = $11,
					        is_active = true, deactivated_at = null,
					        computed_at = $12, updated_at = now()
					  where id = $1`,
					existing.id,
					project.name,
					projectMonthID,
					numericRatArg(incomeUSD, 2),
					numericRatArg(factoryRate, 6),
					numericRatArg(ratio, 6),
					numericRatArg(bonusUSD, 2),
					numericRatArg(usdToCNY, 8),
					numericRatArg(bonusRMB, 2),
					ratioSource,
					optionalNumericRatArg(manualRatio, 6),
					now,
				); err != nil {
					return 0, 0, 0, err
				}
				existing.isActive = true
				if existing.isLocked {
					lockedCount++
				}
			}
		}
	}
	for key, row := range existingRecords {
		if _, present := incomingKeys[key]; present || !row.isActive {
			continue
		}
		if _, err := db.Exec(
			ctx,
			`update public.commission_records
			    set is_active = false, deactivated_at = $2, updated_at = now()
			  where id = $1`,
			row.id,
			now,
		); err != nil {
			return 0, 0, 0, err
		}
	}
	return len(projectIDs), len(incomingKeys), lockedCount, nil
}

func (s *SystemManagementStore) exchangeRateWithFallback(
	ctx context.Context,
	db DB,
	currency string,
	yearMonth string,
) (float64, error) {
	var rate float64
	err := db.QueryRow(
		ctx,
		`select rate from public.exchange_rates
		  where currency = $1 and year_month <= $2
		  order by year_month desc, id desc limit 1`,
		currency,
		yearMonth,
	).Scan(&rate)
	if errors.Is(err, pgx.ErrNoRows) {
		err = db.QueryRow(
			ctx,
			`select rate from public.exchange_rates
			  where currency = $1
			  order by year_month desc, id desc limit 1`,
			currency,
		).Scan(&rate)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, fmt.Errorf(
			"%w: %s exchange rate for %s not found (no fallback available)",
			system_management.ErrExchangeRateNotFound,
			currency,
			yearMonth,
		)
	}
	if err != nil {
		return 0, err
	}
	return rate, nil
}

func loadCommissionRoles(
	ctx context.Context,
	db DB,
	projectIDs []int64,
	reportMonth string,
) (map[int64]map[string][]string, error) {
	rows, err := db.Query(
		ctx,
		`select project_id, role_type, person_name
		   from public.project_role_assignments
		  where project_id = any($1::bigint[])
		    and effective_from_month <= $2
		    and (effective_to_month is null or effective_to_month >= $2)`,
		projectIDs,
		reportMonth,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[int64]map[string][]string)
	for rows.Next() {
		var (
			projectID int64
			roleType  string
			person    string
		)
		if err := rows.Scan(&projectID, &roleType, &person); err != nil {
			return nil, err
		}
		if roleType != "operator" && roleType != "assistant" {
			continue
		}
		if result[projectID] == nil {
			result[projectID] = map[string][]string{
				"operator":  {},
				"assistant": {},
			}
		}
		result[projectID][roleType] = append(result[projectID][roleType], strings.TrimSpace(person))
	}
	return result, rows.Err()
}

func loadCommissionOverrides(
	ctx context.Context,
	db DB,
	reportMonth string,
) (map[commissionKey]*big.Rat, error) {
	rows, err := db.Query(
		ctx,
		`select project_id, person_name, income_category, override_ratio
		   from public.commission_ratio_overrides where report_month = $1`,
		reportMonth,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[commissionKey]*big.Rat)
	for rows.Next() {
		var (
			key  commissionKey
			rate float64
		)
		if err := rows.Scan(&key.projectID, &key.personName, &key.incomeCategory, &rate); err != nil {
			return nil, err
		}
		result[key] = ratFromFloat(rate)
	}
	return result, rows.Err()
}

func loadProjectMonthIDs(
	ctx context.Context,
	db DB,
	reportMonth string,
	country string,
) (map[int64]int64, error) {
	rows, err := db.Query(
		ctx,
		`select project_id, id from public.commission_project_months
		  where report_month = $1 and country = $2`,
		reportMonth,
		country,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[int64]int64)
	for rows.Next() {
		var projectID, id int64
		if err := rows.Scan(&projectID, &id); err != nil {
			return nil, err
		}
		result[projectID] = id
	}
	return result, rows.Err()
}

func loadExistingCommissionRows(
	ctx context.Context,
	db DB,
	reportMonth string,
	country string,
) (map[commissionKey]*commissionExistingRow, error) {
	rows, err := db.Query(
		ctx,
		`select id, project_id, person_name, income_category, is_locked, is_active
		   from public.commission_records
		  where report_month = $1 and country = $2`,
		reportMonth,
		country,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[commissionKey]*commissionExistingRow)
	for rows.Next() {
		var (
			row commissionExistingRow
			key commissionKey
		)
		if err := rows.Scan(
			&row.id,
			&key.projectID,
			&key.personName,
			&key.incomeCategory,
			&row.isLocked,
			&row.isActive,
		); err != nil {
			return nil, err
		}
		copied := row
		result[key] = &copied
	}
	return result, rows.Err()
}

type bonusRoleKey struct {
	personName     string
	incomeCategory string
}

var roleNameSeparator = regexp.MustCompile(`[、,，;\n]+`)

func deriveAgentProjectID(requestPath *string, before, after any) *int64 {
	if requestPath != nil {
		if match := agentProjectPathPattern.FindStringSubmatch(*requestPath); len(match) > 1 {
			if value, err := strconv.ParseInt(match[1], 10, 64); err == nil {
				return &value
			}
		}
	}
	for _, payload := range []any{before, after} {
		if dictionary, ok := payload.(map[string]any); ok {
			if raw, exists := dictionary["project_id"]; exists && raw != nil {
				switch value := raw.(type) {
				case float64:
					number := int64(value)
					return &number
				case string:
					if number, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64); err == nil {
						return &number
					}
				}
			}
		}
	}
	return nil
}

func deriveAgentTargetLabel(requestPath *string, before, after any) *string {
	for _, payload := range []any{before, after} {
		if dictionary, ok := payload.(map[string]any); ok {
			if raw, exists := dictionary["shipment_no"]; exists && raw != nil {
				value := strings.TrimSpace(fmt.Sprint(raw))
				if value != "" {
					return &value
				}
			}
		}
	}
	if requestPath != nil {
		if match := agentShipmentPathPattern.FindStringSubmatch(*requestPath); len(match) > 1 {
			value := strings.TrimSpace(match[1])
			if value != "" {
				return &value
			}
		}
	}
	return nil
}

func deriveAgentOperationType(action string) *string {
	var value string
	switch {
	case strings.HasPrefix(action, "new_product_calculation."):
		value = "new_product_calculations"
	case strings.HasPrefix(action, "shop_calculation."):
		value = "shop_calculations"
	case strings.HasPrefix(action, "shipment."):
		value = "shipments"
	default:
		return nil
	}
	return &value
}

func decodeJSONValue(raw []byte) any {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return value
}

func int8Pointer(value pgtype.Int8) *int64 {
	if !value.Valid {
		return nil
	}
	result := value.Int64
	return &result
}

func smFloat8Pointer(value pgtype.Float8) *float64 {
	if !value.Valid {
		return nil
	}
	result := value.Float64
	return &result
}

func smStringPointer(value string) *string {
	return &value
}

func systemTimestamp(value time.Time) string {
	return value.Local().Truncate(time.Second).Format("2006-01-02T15:04:05-07:00")
}

func systemOptionalTimestamp(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := systemTimestamp(*value)
	return &formatted
}

func formatNaiveTimestamp(value time.Time) string {
	return value.Truncate(time.Second).Format("2006-01-02T15:04:05")
}

func uniqueInt64s(values []int64) []int64 {
	seen := make(map[int64]struct{}, len(values))
	result := make([]int64, 0, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func trimOptional(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func ratFromFloat(value float64) *big.Rat {
	if math.IsNaN(value) || math.IsInf(value, 0) || value == 0 {
		return new(big.Rat)
	}
	text := strconv.FormatFloat(value, 'f', -1, 64)
	rat, ok := new(big.Rat).SetString(text)
	if ok {
		return rat
	}
	rat = new(big.Rat).SetFloat64(value)
	if rat == nil {
		return new(big.Rat)
	}
	return rat
}

func roundDecimalRat(value *big.Rat, scale int) *big.Rat {
	if value == nil {
		return new(big.Rat)
	}
	power := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(scale)), nil)
	scaledNumerator := new(big.Int).Mul(value.Num(), power)
	quotient, remainder := new(big.Int).QuoRem(scaledNumerator, value.Denom(), new(big.Int))
	absoluteRemainder := new(big.Int).Abs(remainder)
	twiceRemainder := new(big.Int).Lsh(absoluteRemainder, 1)
	if twiceRemainder.Cmp(value.Denom()) >= 0 {
		if value.Sign() < 0 {
			quotient.Sub(quotient, big.NewInt(1))
		} else {
			quotient.Add(quotient, big.NewInt(1))
		}
	}
	return new(big.Rat).SetFrac(quotient, power)
}

func formatRat(value *big.Rat, scale int) string {
	if value == nil {
		value = new(big.Rat)
	}
	return value.FloatString(scale)
}

func formatScaleFloat(value float64, scale int) string {
	return formatRat(roundDecimalRat(ratFromFloat(value), scale), scale)
}

func numericRatArg(value *big.Rat, scale int) pgtype.Numeric {
	return numericDecimalArg(formatRat(value, scale))
}

func numericScaleFloatArg(value float64, scale int) pgtype.Numeric {
	return numericDecimalArg(formatScaleFloat(value, scale))
}

func optionalNumericRatArg(value *big.Rat, scale int) any {
	if value == nil {
		return nil
	}
	return numericRatArg(value, scale)
}

func optionalNumericScaleFloatArg(value *float64, scale int) any {
	if value == nil {
		return nil
	}
	return numericScaleFloatArg(*value, scale)
}

func numericDecimalArg(value string) pgtype.Numeric {
	value = strings.TrimSpace(value)
	negative := strings.HasPrefix(value, "-")
	value = strings.TrimPrefix(value, "-")
	parts := strings.SplitN(value, ".", 2)
	integerPart := parts[0]
	if integerPart == "" {
		integerPart = "0"
	}
	fraction := ""
	if len(parts) == 2 {
		fraction = parts[1]
	}
	digits := strings.TrimLeft(integerPart+fraction, "0")
	if digits == "" {
		digits = "0"
	}
	number, ok := new(big.Int).SetString(digits, 10)
	if !ok {
		number = big.NewInt(0)
	}
	if negative && number.Sign() != 0 {
		number.Neg(number)
	}
	return pgtype.Numeric{
		Int:   number,
		Exp:   -int32(len(fraction)),
		Valid: true,
	}
}

func clampUnitRat(value *big.Rat) *big.Rat {
	if value == nil || value.Sign() <= 0 {
		return new(big.Rat)
	}
	if value.Cmp(big.NewRat(1, 1)) >= 0 {
		return big.NewRat(1, 1)
	}
	return value
}

func resolveFactoryCommission(
	basis *string,
	configuredRate *float64,
	incomeUSD *big.Rat,
	paybackUSD *big.Rat,
) (*big.Rat, *big.Rat) {
	normalizedIncome := new(big.Rat).Set(incomeUSD)
	normalizedPayback := new(big.Rat).Set(paybackUSD)
	if normalizedIncome.Sign() < 0 {
		normalizedIncome = new(big.Rat)
	}
	if normalizedPayback.Sign() < 0 {
		normalizedPayback = new(big.Rat)
	}
	var rate *big.Rat
	var base *big.Rat
	if basis != nil && *basis == "cash_received" {
		paybackRatio := new(big.Rat)
		if normalizedIncome.Sign() > 0 {
			paybackRatio = new(big.Rat).Quo(normalizedPayback, normalizedIncome)
		}
		switch {
		case paybackRatio.Cmp(big.NewRat(2, 5)) < 0:
			rate = new(big.Rat)
		case paybackRatio.Cmp(big.NewRat(1, 2)) < 0:
			rate = big.NewRat(7, 100)
		case paybackRatio.Cmp(big.NewRat(3, 5)) < 0:
			rate = big.NewRat(1, 10)
		case paybackRatio.Cmp(big.NewRat(7, 10)) < 0:
			rate = big.NewRat(13, 100)
		default:
			rate = big.NewRat(15, 100)
		}
		base = normalizedPayback
	} else {
		configured := new(big.Rat)
		if configuredRate != nil {
			configured = ratFromFloat(*configuredRate)
		}
		rate = clampUnitRat(configured)
		base = normalizedIncome
	}
	commissionUSD := roundDecimalRat(new(big.Rat).Mul(base, rate), 2)
	return rate, commissionUSD
}

func resolveOperatorBonusRatio(incomeUSD *big.Rat) *big.Rat {
	normalized := new(big.Rat).Set(incomeUSD)
	if normalized.Sign() < 0 {
		normalized = new(big.Rat)
	}
	switch {
	case normalized.Cmp(big.NewRat(10000, 1)) <= 0:
		return big.NewRat(12, 100)
	case normalized.Cmp(big.NewRat(50000, 1)) <= 0:
		return big.NewRat(14, 100)
	case normalized.Cmp(big.NewRat(150000, 1)) <= 0:
		return big.NewRat(16, 100)
	case normalized.Cmp(big.NewRat(450000, 1)) <= 0:
		return big.NewRat(18, 100)
	default:
		return big.NewRat(20, 100)
	}
}

func buildDefaultBonusRatios(
	incomeUSD *big.Rat,
	operatorNames []string,
	assistantNames []string,
) map[bonusRoleKey]*big.Rat {
	result := make(map[bonusRoleKey]*big.Rat)
	operatorRatio := resolveOperatorBonusRatio(incomeUSD)
	assistantRatio := big.NewRat(2, 100)
	if len(operatorNames) > 0 {
		split := new(big.Rat).Quo(operatorRatio, big.NewRat(int64(len(operatorNames)), 1))
		for _, name := range operatorNames {
			result[bonusRoleKey{personName: name, incomeCategory: "operator"}] = split
		}
	}
	if len(assistantNames) > 0 {
		split := new(big.Rat).Quo(assistantRatio, big.NewRat(int64(len(assistantNames)), 1))
		for _, name := range assistantNames {
			result[bonusRoleKey{personName: name, incomeCategory: "assistant"}] = split
		}
	}
	return result
}

func dedupeNames(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		normalized := strings.TrimSpace(value)
		if normalized == "" {
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}
	return result
}

func splitRoleNames(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := roleNameSeparator.Split(value, -1)
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if normalized := strings.TrimSpace(part); normalized != "" {
			result = append(result, normalized)
		}
	}
	return result
}
