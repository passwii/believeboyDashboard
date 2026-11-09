package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/crm"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type CRMStore struct {
	db FullDB
}

func NewCRMStore(db FullDB) *CRMStore {
	return &CRMStore{db: db}
}

func (s *CRMStore) inTx(ctx context.Context, fn func(FullDB) error) error {
	if s.db == nil {
		return errors.New("crm database is nil")
	}
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		return fn(NewTxDB(tx))
	})
}

func (s *CRMStore) createAuditedRow(
	ctx context.Context,
	query string,
	args []any,
	entityType string,
	action string,
	actorID string,
	summary string,
) (int64, error) {
	var id int64
	err := s.inTx(ctx, func(db FullDB) error {
		if err := db.QueryRow(ctx, query, args...).Scan(&id); err != nil {
			return err
		}
		return insertCRMAudit(ctx, db, entityType, id, action, actorID, summary)
	})
	if err != nil {
		return 0, err
	}
	return id, nil
}

func insertCRMAudit(
	ctx context.Context,
	execer Execer,
	entityType string,
	entityID int64,
	action string,
	actorID string,
	summary string,
) error {
	actor := optionalNullableText(actorID)
	summaryValue := optionalNullableText(summary)
	_, err := execer.Exec(
		ctx,
		`insert into public.crm_audit_logs
			(entity_type, entity_id, action, actor_id, summary)
		 values ($1, $2, $3, $4, $5)`,
		entityType,
		entityID,
		action,
		actor,
		summaryValue,
	)
	return err
}

func optionalNullableText(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return value
}

func crmNullableString(value *string) any {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func timestampValue(value time.Time) string {
	return httpapi.Timestamp(value)
}

func optionalTimestampValue(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := httpapi.Timestamp(*value)
	return &formatted
}

func timeNow() time.Time {
	return time.Now().UTC()
}

type crmFilterField struct {
	column string
}

var crmCustomerFilterFields = map[string]crmFilterField{
	"status":            {column: "status"},
	"rating":            {column: "rating"},
	"customerType":      {column: "customer_type"},
	"interestedService": {column: "interested_service"},
	"source":            {column: "source"},
	"ownerId":           {column: "owner_id"},
	"industry":          {column: "industry"},
	"employeeCount":     {column: "employee_count"},
	"annualRevenue":     {column: "annual_revenue"},
	"score_scale":       {column: "score_scale"},
	"score_pay":         {column: "score_pay"},
	"score_fit":         {column: "score_fit"},
	"score_coop":        {column: "score_coop"},
}

var crmLeadFilterFields = map[string]crmFilterField{
	"status":            {column: "status"},
	"intent":            {column: "intent"},
	"customerType":      {column: "customer_type"},
	"interestedService": {column: "interested_service"},
	"source":            {column: "source"},
	"ownerId":           {column: "owner_id"},
}

var crmSavedViewFilterFields = map[string]map[string]crmFilterField{
	"customer": crmCustomerFilterFields,
	"lead":     crmLeadFilterFields,
}

func buildCRMFilterSQL(
	alias string,
	conditions []crm.FilterCondition,
	argStart int,
	allowed map[string]crmFilterField,
) (string, []any, error) {
	if len(conditions) == 0 {
		return "", nil, nil
	}
	clauses := make([]string, 0, len(conditions))
	args := []any{}
	nextArg := argStart
	for _, condition := range conditions {
		clause, used, err := buildCRMFilterCondition(alias, condition, nextArg, allowed, 0)
		if err != nil {
			return "", nil, err
		}
		clauses = append(clauses, clause)
		args = append(args, used...)
		nextArg += len(used)
	}
	return "(" + strings.Join(clauses, " and ") + ")", args, nil
}

func buildCRMFilterCondition(
	alias string,
	condition crm.FilterCondition,
	argStart int,
	allowed map[string]crmFilterField,
	depth int,
) (string, []any, error) {
	if depth > 8 {
		return "", nil, crm.NewAPIError(400, "filters 嵌套深度超过 8")
	}
	if len(condition.And) > 0 {
		clauses := make([]string, 0, len(condition.And))
		args := []any{}
		nextArg := argStart
		for _, child := range condition.And {
			clause, used, err := buildCRMFilterCondition(alias, child, nextArg, allowed, depth+1)
			if err != nil {
				return "", nil, err
			}
			clauses = append(clauses, clause)
			args = append(args, used...)
			nextArg += len(used)
		}
		return "(" + strings.Join(clauses, " and ") + ")", args, nil
	}
	if len(condition.Or) > 0 {
		clauses := make([]string, 0, len(condition.Or))
		args := []any{}
		nextArg := argStart
		for _, child := range condition.Or {
			clause, used, err := buildCRMFilterCondition(alias, child, nextArg, allowed, depth+1)
			if err != nil {
				return "", nil, err
			}
			clauses = append(clauses, clause)
			args = append(args, used...)
			nextArg += len(used)
		}
		return "(" + strings.Join(clauses, " or ") + ")", args, nil
	}
	field, ok := allowed[condition.Field]
	if !ok {
		return "", nil, crm.NewAPIError(400, "不支持的筛选字段: "+condition.Field)
	}
	column := alias + "." + field.column
	switch condition.Op {
	case "eq":
		return column + " = $" + strconv.Itoa(argStart), []any{condition.Value}, nil
	case "neq":
		return column + " <> $" + strconv.Itoa(argStart), []any{condition.Value}, nil
	case "contains":
		escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(fmt.Sprint(condition.Value))
		return column + ` ilike $` + strconv.Itoa(argStart) + ` escape '\'`,
			[]any{"%" + escaped + "%"}, nil
	case "gt":
		return column + " > $" + strconv.Itoa(argStart), []any{condition.Value}, nil
	case "lt":
		return column + " < $" + strconv.Itoa(argStart), []any{condition.Value}, nil
	case "between":
		values, ok := crmFilterSlice(condition.Value)
		if !ok || len(values) != 2 {
			return "", nil, crm.NewAPIError(400, "between 值必须是二元数组")
		}
		return column + " between $" + strconv.Itoa(argStart) + " and $" + strconv.Itoa(argStart+1),
			values, nil
	case "in":
		values, ok := crmFilterSlice(condition.Value)
		if !ok {
			return "", nil, crm.NewAPIError(400, "in 值必须是数组")
		}
		placeholders := make([]string, len(values))
		for index := range values {
			placeholders[index] = "$" + strconv.Itoa(argStart+index)
		}
		return column + " in (" + strings.Join(placeholders, ", ") + ")", values, nil
	case "is_null":
		return column + " is null", nil, nil
	case "is_not_null":
		return column + " is not null", nil, nil
	default:
		return "", nil, crm.NewAPIError(400, "不支持的运算符: "+condition.Op)
	}
}

func crmFilterSlice(value any) ([]any, bool) {
	switch typed := value.(type) {
	case []any:
		return typed, true
	case []string:
		result := make([]any, len(typed))
		for index := range typed {
			result[index] = typed[index]
		}
		return result, true
	case []int:
		result := make([]any, len(typed))
		for index := range typed {
			result[index] = typed[index]
		}
		return result, true
	case []int64:
		result := make([]any, len(typed))
		for index := range typed {
			result[index] = typed[index]
		}
		return result, true
	case []float64:
		result := make([]any, len(typed))
		for index := range typed {
			result[index] = typed[index]
		}
		return result, true
	default:
		return nil, false
	}
}

func validateCRMSavedViewFilters(entityType string, filters []crm.FilterCondition) error {
	allowed, ok := crmSavedViewFilterFields[entityType]
	if !ok {
		return crm.NewAPIError(400, "entity_type must be customer or lead")
	}
	if len(filters) == 0 {
		return nil
	}
	_, _, err := buildCRMFilterSQL("c", filters, 1, allowed)
	return err
}

type crmCustomerScores struct {
	Scale *string
	Pay   *string
	Fit   *string
	Coop  *string
}

func computeCRMValueRating(scores crmCustomerScores) *string {
	if scores.Scale == nil || scores.Pay == nil || scores.Fit == nil || scores.Coop == nil {
		return nil
	}
	points := map[string]float64{"A": 4, "B": 3, "C": 2, "D": 1}
	total := points[*scores.Scale] + points[*scores.Pay] + points[*scores.Fit] + points[*scores.Coop]
	average := total / 4
	rating := "D"
	switch {
	case average >= 3.5:
		rating = "A"
	case average >= 2.5:
		rating = "B"
	case average >= 1.5:
		rating = "C"
	}
	return &rating
}

func validateCRMStoreRuleConditions(conditions []crm.RuleConditionInput) error {
	if len(conditions) == 0 {
		return crm.NewAPIError(400, "规则至少需要 1 条条件")
	}
	fields := map[string]bool{
		"days_since_created": true, "days_since_last_follow": true,
		"last_follow_at": true, "status": true, "rating": true,
	}
	operators := map[string]bool{
		"gt": true, "gte": true, "lt": true, "lte": true,
		"eq": true, "ne": true, "is_null": true, "is_not_null": true,
	}
	for _, condition := range conditions {
		if !fields[condition.Field] {
			return crm.NewAPIError(400, "不支持的 condition.field: "+strconv.Quote(condition.Field))
		}
		if !operators[condition.Operator] {
			return crm.NewAPIError(400, "不支持的 condition.operator: "+strconv.Quote(condition.Operator))
		}
		switch condition.Operator {
		case "gt", "gte", "lt", "lte":
			if condition.Value == nil {
				return crm.NewAPIError(400, condition.Field+" "+condition.Operator+" 需要数字 value")
			}
			if _, err := strconv.Atoi(strings.TrimSpace(*condition.Value)); err != nil {
				return crm.NewAPIError(400, condition.Field+" "+condition.Operator+" 的 value 必须是整数")
			}
		case "eq", "ne":
			if condition.Value == nil || strings.TrimSpace(*condition.Value) == "" {
				return crm.NewAPIError(400, condition.Field+" "+condition.Operator+" 需要非空 value")
			}
		}
	}
	return nil
}

func validateCRMStoreRuleActions(actions []crm.RuleActionInput) error {
	if len(actions) == 0 {
		return crm.NewAPIError(400, "规则至少需要 1 条动作")
	}
	for _, action := range actions {
		if action.ActionType != "notify_owner" {
			return crm.NewAPIError(400, "不支持的 action_type: "+strconv.Quote(action.ActionType))
		}
	}
	return nil
}

const crmCustomerSelect = `
select
	c.id, c.name, c.short_name, c.industry, c.customer_type, c.interested_service,
	c.rating, c.status, c.source, c.owner_id, c.address, c.website,
	c.annual_revenue, c.employee_count, c.remark, c.last_follow_at, c.next_follow_at,
	c.created_by, c.created_at, c.updated_at,
	c.score_scale, c.score_pay, c.score_fit, c.score_coop,
	ct.name, ct.phone, ct.email, ct.wechat,
	u.full_name
from public.crm_customers c
left join lateral (
	select name, phone, email, wechat
	from public.crm_contacts
	where customer_id = c.id
	order by is_primary desc, id asc
	limit 1
) ct on true
left join public.user_accounts u on u.id::text = c.owner_id
`

func (s *CRMStore) scanCustomer(row interface{ Scan(...any) error }) (*crm.Customer, error) {
	var item crm.Customer
	var lastFollowAt, nextFollowAt *time.Time
	var createdAt, updatedAt time.Time
	var contactName, contactPhone, contactEmail, contactWechat *string
	var ownerName *string
	if err := row.Scan(
		&item.ID, &item.Name, &item.ShortName, &item.Industry, &item.CustomerType,
		&item.InterestedService, &item.Rating, &item.Status, &item.Source, &item.OwnerID,
		&item.Address, &item.Website, &item.AnnualRevenue, &item.EmployeeCount,
		&item.Remark, &lastFollowAt, &nextFollowAt, &item.CreatedBy, &createdAt, &updatedAt,
		&item.ScoreScale, &item.ScorePay, &item.ScoreFit, &item.ScoreCoop,
		&contactName, &contactPhone, &contactEmail, &contactWechat, &ownerName,
	); err != nil {
		return nil, err
	}
	item.OwnerName = ownerName
	item.ContactName = contactName
	item.ContactPhone = contactPhone
	item.ContactEmail = contactEmail
	item.ContactWechat = contactWechat
	item.LastFollowAt = optionalTimestampValue(lastFollowAt)
	item.NextFollowAt = optionalTimestampValue(nextFollowAt)
	item.CreatedAt = timestampValue(createdAt)
	item.UpdatedAt = timestampValue(updatedAt)
	item.Categories = []crm.CategoryBrief{}
	return &item, nil
}

func (s *CRMStore) loadCustomerCategories(ctx context.Context, db DB, items []crm.Customer) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]int64, len(items))
	byID := make(map[int64]*crm.Customer, len(items))
	for index := range items {
		ids[index] = items[index].ID
		byID[items[index].ID] = &items[index]
	}
	rows, err := db.Query(ctx, `
		select cc.customer_id, c.id, c.name
		from public.crm_customer_categories cc
		join public.crm_categories c on c.id = cc.category_id
		where cc.customer_id = any($1)
		order by c.sort_order, c.id
	`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var customerID int64
		var category crm.CategoryBrief
		if err := rows.Scan(&customerID, &category.ID, &category.Name); err != nil {
			return err
		}
		if customer := byID[customerID]; customer != nil {
			customer.Categories = append(customer.Categories, category)
		}
	}
	return rows.Err()
}

func (s *CRMStore) ListCustomers(
	ctx context.Context,
	filter crm.CustomerListFilter,
	userID string,
	isAdmin bool,
) (crm.Paginated[crm.Customer], error) {
	page := filter.Page
	if page < 1 {
		page = 1
	}
	pageSize := filter.PageSize
	if pageSize < 1 {
		pageSize = 20
	}
	if filter.Scope == "" {
		filter.Scope = "all"
	}
	sortBy := map[string]string{
		"name": "name", "rating": "rating", "status": "status", "source": "source",
		"owner_id": "owner_id", "last_follow_at": "last_follow_at",
		"next_follow_at": "next_follow_at", "created_at": "created_at", "updated_at": "updated_at",
	}[filter.SortBy]
	if sortBy == "" {
		sortBy = "updated_at"
	}
	sortOrder := strings.ToLower(filter.SortOrder)
	if sortOrder != "desc" {
		sortOrder = "asc"
	}

	where := []string{"c.is_deleted = false"}
	args := []any{}
	nextArg := 1
	switch filter.Scope {
	case "mine":
		if strings.TrimSpace(userID) != "" {
			where = append(where, "c.owner_id = $"+strconv.Itoa(nextArg))
			args = append(args, strings.TrimSpace(userID))
			nextArg++
		}
	case "sea":
		where = append(where, "c.owner_id is null")
	}
	if filter.Keyword != nil && strings.TrimSpace(*filter.Keyword) != "" {
		where = append(where, "(c.name ilike $"+strconv.Itoa(nextArg)+" or c.short_name ilike $"+strconv.Itoa(nextArg)+")")
		args = append(args, "%"+strings.TrimSpace(*filter.Keyword)+"%")
		nextArg++
	}
	if filter.CategoryID != nil {
		where = append(where, "exists (select 1 from public.crm_customer_categories cc where cc.customer_id = c.id and cc.category_id = $"+strconv.Itoa(nextArg)+")")
		args = append(args, *filter.CategoryID)
		nextArg++
	}
	if len(filter.Filters) > 0 {
		clause, filterArgs, err := buildCRMFilterSQL("c", filter.Filters, nextArg, crmCustomerFilterFields)
		if err != nil {
			return crm.Paginated[crm.Customer]{}, err
		}
		where = append(where, clause)
		args = append(args, filterArgs...)
		nextArg += len(filterArgs)
	}
	whereSQL := strings.Join(where, " and ")
	var total int
	if err := s.db.QueryRow(ctx, "select count(*) from public.crm_customers c where "+whereSQL, args...).Scan(&total); err != nil {
		return crm.Paginated[crm.Customer]{}, err
	}
	query := crmCustomerSelect + " where " + whereSQL +
		" order by c." + sortBy + " " + sortOrder +
		" limit $" + strconv.Itoa(nextArg) + " offset $" + strconv.Itoa(nextArg+1)
	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return crm.Paginated[crm.Customer]{}, err
	}
	defer rows.Close()
	items := make([]crm.Customer, 0, pageSize)
	for rows.Next() {
		item, err := s.scanCustomer(rows)
		if err != nil {
			return crm.Paginated[crm.Customer]{}, err
		}
		items = append(items, *item)
	}
	if err := rows.Err(); err != nil {
		return crm.Paginated[crm.Customer]{}, err
	}
	if err := s.loadCustomerCategories(ctx, s.db, items); err != nil {
		return crm.Paginated[crm.Customer]{}, err
	}
	return crm.Paginated[crm.Customer]{Items: items, Total: total, Page: page, PageSize: pageSize}, nil
}

func (s *CRMStore) GetCustomer(ctx context.Context, customerID int64) (*crm.Customer, error) {
	row := s.db.QueryRow(ctx, crmCustomerSelect+
		" where c.id = $1 and c.is_deleted = false", customerID)
	item, err := s.scanCustomer(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	items := []crm.Customer{*item}
	if err := s.loadCustomerCategories(ctx, s.db, items); err != nil {
		return nil, err
	}
	return &items[0], nil
}

func (s *CRMStore) CreateCustomer(
	ctx context.Context,
	input crm.CustomerCreateInput,
	actorID string,
) (*crm.Customer, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return nil, crm.NewAPIError(422, "name must contain at least 1 character")
	}
	ownerID := input.OwnerID
	if ownerID == nil && strings.TrimSpace(actorID) != "" {
		value := strings.TrimSpace(actorID)
		ownerID = &value
	}
	if input.Rating == "" {
		input.Rating = "C"
	}
	if input.Status == "" {
		input.Status = "active"
	}
	var customerID int64
	err := s.inTx(ctx, func(db FullDB) error {
		if err := db.QueryRow(ctx, `
			insert into public.crm_customers (
				name, short_name, industry, customer_type, interested_service, rating,
				status, source, owner_id, address, website, annual_revenue,
				employee_count, remark, created_by
			) values (
				$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
			) returning id
		`,
			name,
			crmNullableString(input.ShortName),
			crmNullableString(input.Industry),
			crmNullableString(input.CustomerType),
			crmNullableString(input.InterestedService),
			input.Rating,
			input.Status,
			crmNullableString(input.Source),
			crmNullableString(ownerID),
			crmNullableString(input.Address),
			crmNullableString(input.Website),
			input.AnnualRevenue,
			input.EmployeeCount,
			crmNullableString(input.Remark),
			optionalNullableText(actorID),
		).Scan(&customerID); err != nil {
			return err
		}
		contactName := strings.TrimSpace(derefString(input.ContactName))
		if contactName != "" {
			if _, err := db.Exec(ctx, `
				insert into public.crm_contacts
					(customer_id, name, phone, email, is_primary)
				values ($1, $2, $3, $4, true)
			`, customerID, contactName, crmNullableString(input.ContactPhone), crmNullableString(input.ContactEmail)); err != nil {
				return err
			}
		}
		return insertCRMAudit(ctx, db, "customer", customerID, "create", actorID, "新建客户")
	})
	if err != nil {
		return nil, err
	}
	return s.GetCustomer(ctx, customerID)
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (s *CRMStore) UpdateCustomer(
	ctx context.Context,
	customerID int64,
	input crm.CustomerUpdateInput,
	actorID string,
) (*crm.Customer, error) {
	sets := []string{}
	args := []any{}
	nextArg := 1
	add := func(column string, value any) {
		sets = append(sets, column+" = $"+strconv.Itoa(nextArg))
		args = append(args, value)
		nextArg++
	}
	if input.Name.Set {
		if input.Name.Value == nil || strings.TrimSpace(*input.Name.Value) == "" {
			return nil, crm.NewAPIError(422, "name must contain at least 1 character")
		}
		add("name", strings.TrimSpace(*input.Name.Value))
	}
	for _, optional := range []struct {
		column string
		value  crm.Optional[string]
	}{
		{"short_name", input.ShortName},
		{"industry", input.Industry},
		{"customer_type", input.CustomerType},
		{"interested_service", input.InterestedService},
		{"rating", input.Rating},
		{"status", input.Status},
		{"source", input.Source},
		{"owner_id", input.OwnerID},
		{"address", input.Address},
		{"website", input.Website},
		{"remark", input.Remark},
	} {
		if optional.value.Set {
			add(optional.column, crmNullableString(optional.value.Value))
		}
	}
	if input.AnnualRevenue.Set {
		add("annual_revenue", input.AnnualRevenue.Value)
	}
	if input.EmployeeCount.Set {
		add("employee_count", input.EmployeeCount.Value)
	}
	if len(sets) == 0 {
		err := s.inTx(ctx, func(db FullDB) error {
			var exists int
			if err := db.QueryRow(ctx, `
				select 1 from public.crm_customers
				where id = $1 and is_deleted = false
				for update
			`, customerID).Scan(&exists); err != nil {
				return err
			}
			return insertCRMAudit(ctx, db, "customer", customerID, "update", actorID, "编辑客户")
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return s.GetCustomer(ctx, customerID)
	}
	sets = append(sets, "updated_at = now()")
	args = append(args, customerID)
	err := s.inTx(ctx, func(db FullDB) error {
		tag, err := db.Exec(ctx, `
			update public.crm_customers
			set `+strings.Join(sets, ", ")+`
			where id = $`+strconv.Itoa(nextArg)+` and is_deleted = false
		`, args...)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return insertCRMAudit(ctx, db, "customer", customerID, "update", actorID, "编辑客户")
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return s.GetCustomer(ctx, customerID)
}

func (s *CRMStore) UpdateCustomerValueScores(
	ctx context.Context,
	customerID int64,
	input crm.ValueScoresUpdateInput,
	actorID string,
) (*crm.Customer, error) {
	var scores crmCustomerScores
	var rating string
	err := s.inTx(ctx, func(db FullDB) error {
		if err := db.QueryRow(ctx, `
			select score_scale, score_pay, score_fit, score_coop, rating
			from public.crm_customers
			where id = $1 and is_deleted = false
			for update
		`, customerID).Scan(&scores.Scale, &scores.Pay, &scores.Fit, &scores.Coop, &rating); err != nil {
			return err
		}
		if input.ScoreScale != nil {
			scores.Scale = input.ScoreScale
		}
		if input.ScorePay != nil {
			scores.Pay = input.ScorePay
		}
		if input.ScoreFit != nil {
			scores.Fit = input.ScoreFit
		}
		if input.ScoreCoop != nil {
			scores.Coop = input.ScoreCoop
		}
		newRating := computeCRMValueRating(scores)
		ratingValue := rating
		if newRating != nil {
			ratingValue = *newRating
		}
		if _, err := db.Exec(ctx, `
			update public.crm_customers
			set score_scale = $1,
			    score_pay = $2,
			    score_fit = $3,
			    score_coop = $4,
			    rating = $5,
			    updated_at = now()
			where id = $6
		`,
			scores.Scale, scores.Pay, scores.Fit, scores.Coop, ratingValue, customerID,
		); err != nil {
			return err
		}
		return insertCRMAudit(ctx, db, "customer", customerID, "update", actorID, "价值评分更新")
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return s.GetCustomer(ctx, customerID)
}

func (s *CRMStore) DeleteCustomer(ctx context.Context, customerID int64, actorID string) error {
	err := s.inTx(ctx, func(db FullDB) error {
		var name string
		if err := db.QueryRow(ctx, `
			select name from public.crm_customers
			where id = $1 and is_deleted = false
			for update
		`, customerID).Scan(&name); err != nil {
			return err
		}
		if _, err := db.Exec(ctx, `
			update public.crm_customers set is_deleted = true, updated_at = now() where id = $1
		`, customerID); err != nil {
			return err
		}
		return insertCRMAudit(ctx, db, "customer", customerID, "delete", actorID, "删除客户 "+name)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return crm.NewAPIError(404, "Customer not found")
	}
	return err
}

func (s *CRMStore) BatchTransferCustomers(
	ctx context.Context,
	ids []int64,
	toOwnerID string,
	actorID string,
) error {
	if len(ids) == 0 || strings.TrimSpace(toOwnerID) == "" {
		return crm.NewAPIError(422, "ids and to_owner_id are required")
	}
	return s.inTx(ctx, func(db FullDB) error {
		rows, err := db.Query(ctx, `
			select id from public.crm_customers
			where id = any($1) and is_deleted = false
		`, ids)
		if err != nil {
			return err
		}
		var existing []int64
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			existing = append(existing, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(existing) == 0 {
			return nil
		}
		if _, err := db.Exec(ctx, `
			update public.crm_customers
			set owner_id = $1, updated_at = now()
			where id = any($2) and is_deleted = false
		`, strings.TrimSpace(toOwnerID), existing); err != nil {
			return err
		}
		for _, id := range existing {
			if err := insertCRMAudit(ctx, db, "customer", id, "transfer", actorID, "指派负责人"); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *CRMStore) BatchMoveCustomersToSea(
	ctx context.Context,
	ids []int64,
	actorID string,
	isAdmin bool,
	auditActorID string,
) error {
	if len(ids) == 0 {
		return crm.NewAPIError(422, "ids must contain at least 1 entry")
	}
	return s.inTx(ctx, func(db FullDB) error {
		query := `select id from public.crm_customers where id = any($1) and is_deleted = false`
		args := []any{ids}
		if !isAdmin {
			query += ` and owner_id = $2`
			args = append(args, strings.TrimSpace(actorID))
		}
		rows, err := db.Query(ctx, query, args...)
		if err != nil {
			return err
		}
		var owned []int64
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			owned = append(owned, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(owned) == 0 {
			return nil
		}
		if _, err := db.Exec(ctx, `
			update public.crm_customers
			set owner_id = null, updated_at = now()
			where id = any($1) and is_deleted = false
		`, owned); err != nil {
			return err
		}
		for _, id := range owned {
			if err := insertCRMAudit(ctx, db, "customer", id, "move_sea", auditActorID, "释放至公海"); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *CRMStore) ClaimCustomer(
	ctx context.Context,
	customerID int64,
	actorID string,
) (*crm.Customer, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, crm.NewAPIError(401, "Not authenticated")
	}
	var claimed bool
	err := s.inTx(ctx, func(db FullDB) error {
		tag, err := db.Exec(ctx, `
			update public.crm_customers
			set owner_id = $1, updated_at = now()
			where id = $2 and owner_id is null and is_deleted = false
		`, actorID, customerID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		claimed = true
		return insertCRMAudit(ctx, db, "customer", customerID, "claim", actorID, "从公海领取")
	})
	if err != nil {
		return nil, err
	}
	if !claimed {
		return nil, nil
	}
	return s.GetCustomer(ctx, customerID)
}

var (
	crmEmailPattern     = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
	crmCustomerStatuses = map[string]bool{"active": true, "lost": true, "signed": true, "on_hold": true}
	crmCustomerRatings  = map[string]bool{"A": true, "B": true, "C": true, "D": true}
	crmCustomerSources  = map[string]bool{
		"referral": true, "exhibition": true, "online_ad": true,
		"cold_call": true, "self_developed": true, "other": true,
	}
	crmCustomerTypes      = map[string]bool{"工厂": true, "贸易商": true, "同行": true, "其他": true}
	crmInterestedServices = map[string]bool{"代运营": true, "AI运营": true, "运营服务": true, "其他": true}
)

func normalizeCRMPhone(value *string) string {
	if value == nil {
		return ""
	}
	return strings.NewReplacer(" ", "", "-", "").Replace(*value)
}

func (s *CRMStore) ImportCustomersToSea(
	ctx context.Context,
	rows []crm.CustomerSeaImportRow,
	actorID string,
) (crm.CustomerSeaImportResult, error) {
	result := crm.CustomerSeaImportResult{Failed: []crm.CustomerSeaImportFail{}}
	seen := map[string]bool{}
	err := s.inTx(ctx, func(db FullDB) error {
		for index, row := range rows {
			rowNumber := index + 1
			name := strings.TrimSpace(row.Name)
			fail := func(field, reason string) {
				result.Failed = append(result.Failed, crm.CustomerSeaImportFail{
					Row: rowNumber, Field: &field, Reason: reason,
				})
			}
			if name == "" {
				fail("name", "客户名必填")
				continue
			}
			if row.Rating != nil && !crmCustomerRatings[*row.Rating] {
				fail("rating", "等级无效："+*row.Rating)
				continue
			}
			if row.Status != nil && !crmCustomerStatuses[*row.Status] {
				fail("status", "状态无效："+*row.Status)
				continue
			}
			if row.Source != nil && !crmCustomerSources[*row.Source] {
				fail("source", "来源无效："+*row.Source)
				continue
			}
			if row.CustomerType != nil && !crmCustomerTypes[*row.CustomerType] {
				fail("customer_type", "对象类型无效："+*row.CustomerType)
				continue
			}
			if row.InterestedService != nil && !crmInterestedServices[*row.InterestedService] {
				fail("interested_service", "意向服务无效："+*row.InterestedService)
				continue
			}
			if row.ContactEmail != nil && !crmEmailPattern.MatchString(*row.ContactEmail) {
				fail("contact_email", "邮箱格式不正确")
				continue
			}
			phoneKey := normalizeCRMPhone(row.ContactPhone)
			key := strings.ToLower(name) + "\x00" + phoneKey
			if seen[key] {
				result.SkippedDupes++
				continue
			}
			var existingIDs []int64
			if err := db.QueryRow(ctx, `
				select coalesce(array_agg(id), '{}'::int[])
				from public.crm_customers
				where is_deleted = false and lower(trim(name)) = lower(trim($1))
			`, name).Scan(&existingIDs); err != nil {
				return err
			}
			duplicate := false
			if len(existingIDs) > 0 {
				if phoneKey == "" {
					duplicate = true
				} else {
					var phoneMatches int
					if err := db.QueryRow(ctx, `
						select count(*)
						from public.crm_contacts
						where customer_id = any($1)
						  and regexp_replace(coalesce(phone, ''), '[- ]', '', 'g') = $2
					`, existingIDs, phoneKey).Scan(&phoneMatches); err != nil {
						return err
					}
					duplicate = phoneMatches > 0
				}
			}
			if duplicate {
				result.SkippedDupes++
				seen[key] = true
				continue
			}
			seen[key] = true
			var customerID int64
			if err := db.QueryRow(ctx, `
				insert into public.crm_customers (
					name, short_name, industry, customer_type, interested_service, rating,
					status, source, owner_id, address, website, annual_revenue,
					employee_count, remark, created_by
				) values (
					$1, $2, $3, $4, $5, coalesce($6, 'C'), coalesce($7, 'active'),
					$8, null, $9, $10, $11, $12, $13, $14
				) returning id
			`,
				name,
				crmNullableString(row.ShortName),
				crmNullableString(row.Industry),
				crmNullableString(row.CustomerType),
				crmNullableString(row.InterestedService),
				crmNullableString(row.Rating),
				crmNullableString(row.Status),
				crmNullableString(row.Source),
				crmNullableString(row.Address),
				crmNullableString(row.Website),
				row.AnnualRevenue,
				row.EmployeeCount,
				crmNullableString(row.Remark),
				optionalNullableText(actorID),
			).Scan(&customerID); err != nil {
				return err
			}
			if contactName := strings.TrimSpace(derefString(row.ContactName)); contactName != "" {
				if _, err := db.Exec(ctx, `
					insert into public.crm_contacts
						(customer_id, name, phone, email, is_primary)
					values ($1, $2, $3, $4, true)
				`, customerID, contactName, crmNullableString(row.ContactPhone), crmNullableString(row.ContactEmail)); err != nil {
					return err
				}
			}
			if err := insertCRMAudit(ctx, db, "customer", customerID, "create", actorID, "公海导入"); err != nil {
				return err
			}
			result.Created++
		}
		return nil
	})
	return result, err
}

const crmContactSelect = `
select id, customer_id, name, phone, email, wechat, title, is_primary, remark, created_at, updated_at
from public.crm_contacts
`

func (s *CRMStore) scanContact(row interface{ Scan(...any) error }) (*crm.Contact, error) {
	var item crm.Contact
	var createdAt, updatedAt time.Time
	if err := row.Scan(
		&item.ID, &item.CustomerID, &item.Name, &item.Phone, &item.Email, &item.Wechat,
		&item.Title, &item.IsPrimary, &item.Remark, &createdAt, &updatedAt,
	); err != nil {
		return nil, err
	}
	item.CreatedAt = timestampValue(createdAt)
	item.UpdatedAt = timestampValue(updatedAt)
	return &item, nil
}

func (s *CRMStore) ListContacts(ctx context.Context, customerID int64) ([]crm.Contact, error) {
	rows, err := s.db.Query(ctx, crmContactSelect+
		" where customer_id = $1 order by is_primary desc, id asc", customerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []crm.Contact{}
	for rows.Next() {
		item, err := s.scanContact(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *item)
	}
	return items, rows.Err()
}

func (s *CRMStore) CreateContact(
	ctx context.Context,
	customerID int64,
	input crm.ContactCreateInput,
	actorID string,
) (*crm.Contact, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return nil, crm.NewAPIError(422, "name must contain at least 1 character")
	}
	var contactID int64
	err := s.inTx(ctx, func(db FullDB) error {
		var exists int
		if err := db.QueryRow(ctx, `
			select count(*) from public.crm_customers where id = $1 and is_deleted = false
		`, customerID).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			return nil
		}
		var existingCount int
		if err := db.QueryRow(ctx, `
			select count(*) from public.crm_contacts where customer_id = $1
		`, customerID).Scan(&existingCount); err != nil {
			return err
		}
		primary := input.IsPrimary || existingCount == 0
		if err := db.QueryRow(ctx, `
			insert into public.crm_contacts
				(customer_id, name, phone, email, wechat, title, is_primary, remark)
			values ($1, $2, $3, $4, $5, $6, $7, $8)
			returning id
		`, customerID, name, crmNullableString(input.Phone), crmNullableString(input.Email),
			crmNullableString(input.Wechat), crmNullableString(input.Title), primary, crmNullableString(input.Remark),
		).Scan(&contactID); err != nil {
			return err
		}
		if primary {
			if _, err := db.Exec(ctx, `
				update public.crm_contacts set is_primary = false, updated_at = now()
				where customer_id = $1 and id <> $2 and is_primary = true
			`, customerID, contactID); err != nil {
				return err
			}
		}
		return insertCRMAudit(ctx, db, "contact", contactID, "create", actorID, "新增联系人 "+name)
	})
	if err != nil {
		return nil, err
	}
	if contactID == 0 {
		return nil, nil
	}
	return s.getContact(ctx, contactID)
}

func (s *CRMStore) getContact(ctx context.Context, contactID int64) (*crm.Contact, error) {
	row := s.db.QueryRow(ctx, crmContactSelect+" where id = $1", contactID)
	item, err := s.scanContact(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return item, err
}

func (s *CRMStore) UpdateContact(
	ctx context.Context,
	contactID int64,
	input crm.ContactUpdateInput,
	actorID string,
) (*crm.Contact, error) {
	sets := []string{}
	args := []any{}
	nextArg := 1
	add := func(column string, value any) {
		sets = append(sets, column+" = $"+strconv.Itoa(nextArg))
		args = append(args, value)
		nextArg++
	}
	if input.Name.Set {
		if input.Name.Value == nil || strings.TrimSpace(*input.Name.Value) == "" {
			return nil, crm.NewAPIError(422, "name must contain at least 1 character")
		}
		add("name", strings.TrimSpace(*input.Name.Value))
	}
	for _, optional := range []struct {
		column string
		value  crm.Optional[string]
	}{
		{"phone", input.Phone}, {"email", input.Email}, {"wechat", input.Wechat},
		{"title", input.Title}, {"remark", input.Remark},
	} {
		if optional.value.Set {
			add(optional.column, crmNullableString(optional.value.Value))
		}
	}
	if input.IsPrimary.Set {
		add("is_primary", input.IsPrimary.Value != nil && *input.IsPrimary.Value)
	}
	if len(sets) == 0 {
		err := s.inTx(ctx, func(db FullDB) error {
			var exists int
			if err := db.QueryRow(ctx, `
				select 1 from public.crm_contacts where id = $1 for update
			`, contactID).Scan(&exists); err != nil {
				return err
			}
			return insertCRMAudit(ctx, db, "contact", contactID, "update", actorID, "编辑联系人")
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return s.getContact(ctx, contactID)
	}
	sets = append(sets, "updated_at = now()")
	args = append(args, contactID)
	var customerID int64
	var primary bool
	err := s.inTx(ctx, func(db FullDB) error {
		if err := db.QueryRow(ctx, `
			select customer_id from public.crm_contacts where id = $1 for update
		`, contactID).Scan(&customerID); err != nil {
			return err
		}
		query := `update public.crm_contacts set ` + strings.Join(sets, ", ") +
			` where id = $` + strconv.Itoa(nextArg) + ` returning is_primary`
		if err := db.QueryRow(ctx, query, args...).Scan(&primary); err != nil {
			return err
		}
		if primary {
			if _, err := db.Exec(ctx, `
				update public.crm_contacts set is_primary = false, updated_at = now()
				where customer_id = $1 and id <> $2 and is_primary = true
			`, customerID, contactID); err != nil {
				return err
			}
		}
		return insertCRMAudit(ctx, db, "contact", contactID, "update", actorID, "编辑联系人")
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return s.getContact(ctx, contactID)
}

func (s *CRMStore) DeleteContact(ctx context.Context, contactID int64, actorID string) error {
	err := s.inTx(ctx, func(db FullDB) error {
		var customerID int64
		var primary bool
		if err := db.QueryRow(ctx, `
			select customer_id, is_primary from public.crm_contacts where id = $1 for update
		`, contactID).Scan(&customerID, &primary); err != nil {
			return err
		}
		if _, err := db.Exec(ctx, `delete from public.crm_contacts where id = $1`, contactID); err != nil {
			return err
		}
		if primary {
			if _, err := db.Exec(ctx, `
				update public.crm_contacts set is_primary = true, updated_at = now()
				where id = (
					select id from public.crm_contacts
					where customer_id = $1
					order by id asc
					limit 1
				)
			`, customerID); err != nil {
				return err
			}
		}
		return insertCRMAudit(ctx, db, "contact", contactID, "delete", actorID, "删除联系人")
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return crm.NewAPIError(404, "Contact not found")
	}
	return err
}

func (s *CRMStore) ListCRMUsers(ctx context.Context) ([]crm.CRMUser, error) {
	rows, err := s.db.Query(ctx, `
		select id::text, coalesce(trim(full_name), ''), email, role_type, is_active
		from public.user_accounts
		where is_active = true and coalesce(trim(full_name), '') <> ''
		order by coalesce(trim(full_name), '')
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []crm.CRMUser{}
	for rows.Next() {
		var item crm.CRMUser
		if err := rows.Scan(&item.ID, &item.Name, &item.Email, &item.RoleType, &item.IsActive); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *CRMStore) GetCRMUser(ctx context.Context, userID string) (*crm.CRMUser, error) {
	var item crm.CRMUser
	err := s.db.QueryRow(ctx, `
		select id::text, coalesce(trim(full_name), ''), email, role_type, is_active
		from public.user_accounts where id::text = $1 limit 1
	`, userID).Scan(&item.ID, &item.Name, &item.Email, &item.RoleType, &item.IsActive)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

const crmLeadSelect = `
select
	l.id, l.name, l.company, l.phone, l.email, l.wechat, l.source, l.status,
	l.intent, l.customer_type, l.interested_service, l.owner_id, l.expected_amount,
	l.expected_close_date, l.remark, l.next_follow_at, l.converted_to_customer_id,
	l.converted_at, l.entered_stage_at, l.created_by, l.created_at, l.updated_at,
	u.full_name
from public.crm_leads l
left join public.user_accounts u on u.id::text = l.owner_id
`

func (s *CRMStore) scanLead(row interface{ Scan(...any) error }) (*crm.Lead, error) {
	var item crm.Lead
	var nextFollowAt, convertedAt, enteredStageAt *time.Time
	var createdAt, updatedAt time.Time
	var ownerName *string
	if err := row.Scan(
		&item.ID, &item.Name, &item.Company, &item.Phone, &item.Email, &item.Wechat,
		&item.Source, &item.Status, &item.Intent, &item.CustomerType,
		&item.InterestedService, &item.OwnerID, &item.ExpectedAmount,
		&item.ExpectedCloseDate, &item.Remark, &nextFollowAt,
		&item.ConvertedToCustomerID, &convertedAt, &enteredStageAt,
		&item.CreatedBy, &createdAt, &updatedAt, &ownerName,
	); err != nil {
		return nil, err
	}
	item.NextFollowAt = optionalTimestampValue(nextFollowAt)
	item.ConvertedAt = optionalTimestampValue(convertedAt)
	item.EnteredStageAt = optionalTimestampValue(enteredStageAt)
	item.CreatedAt = timestampValue(createdAt)
	item.UpdatedAt = timestampValue(updatedAt)
	item.OwnerName = ownerName
	return &item, nil
}

func (s *CRMStore) ListLeads(
	ctx context.Context,
	filter crm.LeadListFilter,
	userID string,
) (crm.Paginated[crm.Lead], error) {
	page := filter.Page
	if page < 1 {
		page = 1
	}
	pageSize := filter.PageSize
	if pageSize < 1 {
		pageSize = 20
	}
	if filter.Scope == "" {
		filter.Scope = "all"
	}
	sortBy := map[string]string{
		"name": "name", "status": "status", "intent": "intent",
		"owner_id": "owner_id", "next_follow_at": "next_follow_at",
		"converted_at": "converted_at", "created_at": "created_at", "updated_at": "updated_at",
	}[filter.SortBy]
	if sortBy == "" {
		sortBy = "updated_at"
	}
	sortOrder := strings.ToLower(filter.SortOrder)
	if sortOrder != "desc" {
		sortOrder = "asc"
	}
	where := []string{"l.is_deleted = false"}
	args := []any{}
	nextArg := 1
	switch filter.Scope {
	case "mine":
		where = append(where, "l.owner_id = $"+strconv.Itoa(nextArg))
		args = append(args, strings.TrimSpace(userID))
		nextArg++
	case "sea":
		where = append(where, "l.owner_id is null")
	}
	if filter.Keyword != nil && strings.TrimSpace(*filter.Keyword) != "" {
		where = append(where, "(l.name ilike $"+strconv.Itoa(nextArg)+" or l.company ilike $"+strconv.Itoa(nextArg)+")")
		args = append(args, "%"+strings.TrimSpace(*filter.Keyword)+"%")
		nextArg++
	}
	if len(filter.Filters) > 0 {
		clause, filterArgs, err := buildCRMFilterSQL("l", filter.Filters, nextArg, crmLeadFilterFields)
		if err != nil {
			return crm.Paginated[crm.Lead]{}, err
		}
		where = append(where, clause)
		args = append(args, filterArgs...)
		nextArg += len(filterArgs)
	}
	whereSQL := strings.Join(where, " and ")
	var total int
	if err := s.db.QueryRow(ctx, `
		select count(*) from public.crm_leads l where `+whereSQL, args...).Scan(&total); err != nil {
		return crm.Paginated[crm.Lead]{}, err
	}
	query := crmLeadSelect + " where " + whereSQL +
		" order by l." + sortBy + " " + sortOrder +
		" limit $" + strconv.Itoa(nextArg) + " offset $" + strconv.Itoa(nextArg+1)
	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return crm.Paginated[crm.Lead]{}, err
	}
	defer rows.Close()
	items := make([]crm.Lead, 0, pageSize)
	for rows.Next() {
		item, err := s.scanLead(rows)
		if err != nil {
			return crm.Paginated[crm.Lead]{}, err
		}
		items = append(items, *item)
	}
	if err := rows.Err(); err != nil {
		return crm.Paginated[crm.Lead]{}, err
	}
	return crm.Paginated[crm.Lead]{Items: items, Total: total, Page: page, PageSize: pageSize}, nil
}

func (s *CRMStore) GetLead(ctx context.Context, leadID int64) (*crm.Lead, error) {
	row := s.db.QueryRow(ctx, crmLeadSelect+
		" where l.id = $1 and l.is_deleted = false", leadID)
	item, err := s.scanLead(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return item, err
}

func (s *CRMStore) CreateLead(
	ctx context.Context,
	input crm.LeadCreateInput,
	actorID string,
) (*crm.Lead, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return nil, crm.NewAPIError(422, "name must contain at least 1 character")
	}
	ownerID := input.OwnerID
	if ownerID == nil && strings.TrimSpace(actorID) != "" {
		value := strings.TrimSpace(actorID)
		ownerID = &value
	}
	if input.Status == "" {
		input.Status = "new"
	}
	if input.Intent == "" {
		input.Intent = "medium"
	}
	var leadID int64
	err := s.inTx(ctx, func(db FullDB) error {
		if err := db.QueryRow(ctx, `
			insert into public.crm_leads (
				name, company, phone, email, wechat, source, status, intent,
				customer_type, interested_service, owner_id, expected_amount,
				expected_close_date, remark, entered_stage_at, created_by
			) values (
				$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now(), $15
			) returning id
		`,
			name,
			crmNullableString(input.Company),
			crmNullableString(input.Phone),
			crmNullableString(input.Email),
			crmNullableString(input.Wechat),
			crmNullableString(input.Source),
			input.Status,
			input.Intent,
			crmNullableString(input.CustomerType),
			crmNullableString(input.InterestedService),
			crmNullableString(ownerID),
			input.ExpectedAmount,
			crmNullableString(input.ExpectedCloseDate),
			crmNullableString(input.Remark),
			optionalNullableText(actorID),
		).Scan(&leadID); err != nil {
			return err
		}
		return insertCRMAudit(ctx, db, "lead", leadID, "create", actorID, "新建线索")
	})
	if err != nil {
		return nil, err
	}
	return s.GetLead(ctx, leadID)
}

func (s *CRMStore) UpdateLead(
	ctx context.Context,
	leadID int64,
	input crm.LeadUpdateInput,
	actorID string,
) (*crm.Lead, error) {
	var currentStatus string
	if err := s.db.QueryRow(ctx, `
		select status from public.crm_leads where id = $1 and is_deleted = false
	`, leadID).Scan(&currentStatus); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	sets := []string{}
	args := []any{}
	nextArg := 1
	add := func(column string, value any) {
		sets = append(sets, column+" = $"+strconv.Itoa(nextArg))
		args = append(args, value)
		nextArg++
	}
	if input.Name.Set {
		if input.Name.Value == nil || strings.TrimSpace(*input.Name.Value) == "" {
			return nil, crm.NewAPIError(422, "name must contain at least 1 character")
		}
		add("name", strings.TrimSpace(*input.Name.Value))
	}
	for _, optional := range []struct {
		column string
		value  crm.Optional[string]
	}{
		{"company", input.Company}, {"phone", input.Phone}, {"email", input.Email},
		{"wechat", input.Wechat}, {"source", input.Source}, {"intent", input.Intent},
		{"customer_type", input.CustomerType}, {"interested_service", input.InterestedService},
		{"owner_id", input.OwnerID}, {"expected_close_date", input.ExpectedCloseDate},
		{"remark", input.Remark},
	} {
		if optional.value.Set {
			add(optional.column, crmNullableString(optional.value.Value))
		}
	}
	if input.ExpectedAmount.Set {
		add("expected_amount", input.ExpectedAmount.Value)
	}
	if input.Status.Set && input.Status.Value != nil {
		add("status", *input.Status.Value)
		if *input.Status.Value != currentStatus {
			sets = append(sets, "entered_stage_at = now()")
		}
	}
	if len(sets) == 0 {
		if err := s.inTx(ctx, func(db FullDB) error {
			return insertCRMAudit(ctx, db, "lead", leadID, "update", actorID, "编辑线索")
		}); err != nil {
			return nil, err
		}
		return s.GetLead(ctx, leadID)
	}
	sets = append(sets, "updated_at = now()")
	args = append(args, leadID)
	err := s.inTx(ctx, func(db FullDB) error {
		tag, err := db.Exec(ctx, `
			update public.crm_leads
			set `+strings.Join(sets, ", ")+`
			where id = $`+strconv.Itoa(nextArg)+` and is_deleted = false
		`, args...)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return insertCRMAudit(ctx, db, "lead", leadID, "update", actorID, "编辑线索")
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return s.GetLead(ctx, leadID)
}

func (s *CRMStore) BatchTransferLeads(
	ctx context.Context,
	ids []int64,
	toOwnerID string,
	actorID string,
) error {
	if len(ids) == 0 || strings.TrimSpace(toOwnerID) == "" {
		return crm.NewAPIError(422, "ids and to_owner_id are required")
	}
	return s.inTx(ctx, func(db FullDB) error {
		rows, err := db.Query(ctx, `
			update public.crm_leads
			set owner_id = $1, updated_at = now()
			where id = any($2) and is_deleted = false
			returning id
		`, strings.TrimSpace(toOwnerID), ids)
		if err != nil {
			return err
		}
		var transferred []int64
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			transferred = append(transferred, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, id := range transferred {
			if err := insertCRMAudit(ctx, db, "lead", id, "transfer", actorID, "指派负责人"); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *CRMStore) BatchMoveLeadsToPool(
	ctx context.Context,
	ids []int64,
	actorID string,
	isAdmin bool,
	auditActorID string,
) error {
	if len(ids) == 0 {
		return crm.NewAPIError(422, "ids must contain at least 1 entry")
	}
	return s.inTx(ctx, func(db FullDB) error {
		query := `
			update public.crm_leads
			set owner_id = null, updated_at = now()
			where id = any($1) and is_deleted = false`
		args := []any{ids}
		if !isAdmin {
			query += ` and owner_id = $2 returning id`
			args = append(args, strings.TrimSpace(actorID))
		} else {
			query += ` returning id`
		}
		rows, err := db.Query(ctx, query, args...)
		if err != nil {
			return err
		}
		var moved []int64
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			moved = append(moved, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, id := range moved {
			if err := insertCRMAudit(ctx, db, "lead", id, "move_sea", auditActorID, "释放至线索池"); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *CRMStore) ClaimLead(ctx context.Context, leadID int64, actorID string) (*crm.Lead, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, crm.NewAPIError(401, "Not authenticated")
	}
	var claimed bool
	err := s.inTx(ctx, func(db FullDB) error {
		tag, err := db.Exec(ctx, `
			update public.crm_leads
			set owner_id = $1, updated_at = now()
			where id = $2 and owner_id is null and is_deleted = false
		`, actorID, leadID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		claimed = true
		return insertCRMAudit(ctx, db, "lead", leadID, "claim", actorID, "从线索池领取")
	})
	if err != nil {
		return nil, err
	}
	if !claimed {
		return nil, nil
	}
	return s.GetLead(ctx, leadID)
}

func (s *CRMStore) ConvertLead(
	ctx context.Context,
	leadID int64,
	override *crm.ConvertLeadInput,
	actorID string,
) (*crm.ConvertLeadResponse, error) {
	var customerID int64
	err := s.inTx(ctx, func(db FullDB) error {
		var (
			name, status             string
			company, source, remark  *string
			phone, email, wechat     *string
			customerType, interested *string
			ownerID                  *string
			convertedTo              *int64
		)
		if err := db.QueryRow(ctx, `
			select name, company, phone, email, wechat, source, status,
			       customer_type, interested_service, owner_id, remark,
			       converted_to_customer_id
			from public.crm_leads
			where id = $1 and is_deleted = false
			for update
		`, leadID).Scan(
			&name, &company, &phone, &email, &wechat, &source, &status,
			&customerType, &interested, &ownerID, &remark, &convertedTo,
		); err != nil {
			return err
		}
		if convertedTo != nil {
			return crm.NewAPIError(409, "Lead already converted")
		}
		customerName := name
		if company != nil && strings.TrimSpace(*company) != "" {
			customerName = *company
		}
		customerSource := source
		customerRemark := remark
		customerRating := "C"
		if override != nil {
			if override.Name != nil && strings.TrimSpace(*override.Name) != "" {
				customerName = strings.TrimSpace(*override.Name)
			}
			if override.Source != nil && strings.TrimSpace(*override.Source) != "" {
				value := strings.TrimSpace(*override.Source)
				customerSource = &value
			}
			if override.Remark != nil && strings.TrimSpace(*override.Remark) != "" {
				value := strings.TrimSpace(*override.Remark)
				customerRemark = &value
			}
			if override.Rating != nil && strings.TrimSpace(*override.Rating) != "" {
				customerRating = strings.TrimSpace(*override.Rating)
			}
		}
		if err := db.QueryRow(ctx, `
			insert into public.crm_customers (
				name, customer_type, interested_service, source, rating, status,
				owner_id, remark, created_by
			) values ($1, $2, $3, $4, $5, 'active', $6, $7, $8)
			returning id
		`,
			customerName,
			customerType,
			interested,
			customerSource,
			customerRating,
			ownerID,
			customerRemark,
			optionalNullableText(actorID),
		).Scan(&customerID); err != nil {
			return err
		}
		var contactID int64
		if err := db.QueryRow(ctx, `
			insert into public.crm_contacts
				(customer_id, name, phone, email, wechat, is_primary)
			values ($1, $2, $3, $4, $5, true)
			returning id
		`, customerID, name, phone, email, wechat).Scan(&contactID); err != nil {
			return err
		}
		if _, err := db.Exec(ctx, `
			update public.crm_follows
			set entity_type = 'customer', entity_id = $1
			where entity_type = 'lead' and entity_id = $2
		`, customerID, leadID); err != nil {
			return err
		}
		if _, err := db.Exec(ctx, `
			update public.crm_leads
			set status = 'converted',
			    entered_stage_at = case when status <> 'converted' then now() else entered_stage_at end,
			    converted_to_customer_id = $1,
			    converted_at = now(),
			    updated_at = now()
			where id = $2
		`, customerID, leadID); err != nil {
			return err
		}
		if err := insertCRMAudit(ctx, db, "lead", leadID, "convert", actorID, "线索转化为客户"); err != nil {
			return err
		}
		if err := insertCRMAudit(ctx, db, "customer", customerID, "create", actorID, "新建客户"); err != nil {
			return err
		}
		return insertCRMAudit(ctx, db, "contact", contactID, "create", actorID, "新建联系人")
	})
	if err != nil {
		return nil, err
	}
	lead, err := s.GetLead(ctx, leadID)
	if err != nil {
		return nil, err
	}
	customer, err := s.GetCustomer(ctx, customerID)
	if err != nil {
		return nil, err
	}
	if lead == nil || customer == nil {
		return nil, errors.New("converted lead rows could not be reloaded")
	}
	return &crm.ConvertLeadResponse{Lead: *lead, Customer: *customer}, nil
}

const crmFollowSelect = `
select f.id, f.entity_type, f.entity_id, f.type, f.content, f.next_follow_at,
       f.created_by, f.created_at, u.full_name
from public.crm_follows f
left join public.user_accounts u on u.id::text = f.created_by
`

func (s *CRMStore) scanFollow(row interface{ Scan(...any) error }) (*crm.Follow, error) {
	var item crm.Follow
	var nextFollowAt *time.Time
	var createdAt time.Time
	var createdByName *string
	if err := row.Scan(
		&item.ID, &item.EntityType, &item.EntityID, &item.Type, &item.Content,
		&nextFollowAt, &item.CreatedBy, &createdAt, &createdByName,
	); err != nil {
		return nil, err
	}
	item.NextFollowAt = optionalTimestampValue(nextFollowAt)
	item.CreatedAt = timestampValue(createdAt)
	item.CreatedByName = createdByName
	return &item, nil
}

func (s *CRMStore) ListFollows(ctx context.Context, entityType string, entityID int64) ([]crm.Follow, error) {
	rows, err := s.db.Query(ctx, crmFollowSelect+`
		where f.entity_type = $1 and f.entity_id = $2
		order by f.created_at desc, f.id desc
	`, entityType, entityID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []crm.Follow{}
	for rows.Next() {
		item, err := s.scanFollow(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *item)
	}
	return items, rows.Err()
}

func (s *CRMStore) CreateFollow(
	ctx context.Context,
	input crm.FollowCreateInput,
	actorID string,
) (*crm.Follow, error) {
	if input.EntityType != "customer" && input.EntityType != "lead" {
		return nil, crm.NewAPIError(422, "entity_type must be customer or lead")
	}
	if strings.TrimSpace(input.Content) == "" {
		return nil, crm.NewAPIError(422, "content must contain at least 1 character")
	}
	if input.Type == "" {
		input.Type = "note"
	}
	var followID int64
	err := s.inTx(ctx, func(db FullDB) error {
		return s.createFollowTx(ctx, db, input, actorID, &followID, true)
	})
	if err != nil {
		return nil, err
	}
	row := s.db.QueryRow(ctx, crmFollowSelect+" where f.id = $1", followID)
	return s.scanFollow(row)
}

func (s *CRMStore) createFollowTx(
	ctx context.Context,
	db FullDB,
	input crm.FollowCreateInput,
	actorID string,
	followID *int64,
	audit bool,
) error {
	if err := db.QueryRow(ctx, `
		insert into public.crm_follows
			(entity_type, entity_id, type, content, next_follow_at, created_by)
		values ($1, $2, $3, $4, $5, $6)
		returning id
	`, input.EntityType, input.EntityID, input.Type, input.Content, input.NextFollowAt,
		optionalNullableText(actorID),
	).Scan(followID); err != nil {
		return err
	}
	switch input.EntityType {
	case "customer":
		if _, err := db.Exec(ctx, `
			update public.crm_customers
			set last_follow_at = now(), next_follow_at = $1, updated_at = now()
			where id = $2 and is_deleted = false
		`, input.NextFollowAt, input.EntityID); err != nil {
			return err
		}
	case "lead":
		if _, err := db.Exec(ctx, `
			update public.crm_leads
			set last_follow_at = now(), next_follow_at = $1, updated_at = now()
			where id = $2 and is_deleted = false
		`, input.NextFollowAt, input.EntityID); err != nil {
			return err
		}
	}
	if _, err := db.Exec(ctx, `
		update public.crm_reminder_logs
		set status = 'resolved', updated_at = now()
		where reminder_type = 'stale_follow_up'
		  and status = 'active'
		  and entity_type = $1 and entity_id = $2
	`, input.EntityType, input.EntityID); err != nil {
		return err
	}
	if audit {
		return insertCRMAudit(ctx, db, input.EntityType, input.EntityID, "follow", actorID, "新增跟进")
	}
	return nil
}

func (s *CRMStore) ListFollowUps(
	ctx context.Context,
	scope string,
	userID string,
	isAdmin bool,
) (crm.FollowUpGroups, error) {
	_ = isAdmin
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		location = time.FixedZone("CST", 8*60*60)
	}
	now := time.Now().In(location)
	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, location)
	tomorrowStart := todayStart.AddDate(0, 0, 1)
	daysUntilSunday := crmDaysUntilSunday(now.Weekday())
	weekEnd := todayStart.AddDate(0, 0, daysUntilSunday).Add(24*time.Hour - time.Second)

	customerWhere := "c.is_deleted = false and c.next_follow_at is not null"
	leadWhere := "l.is_deleted = false and l.next_follow_at is not null and l.status not in ('converted', 'discarded')"
	customerArgs := []any{}
	leadArgs := []any{}
	if scope == "mine" {
		customerWhere += " and c.owner_id = $1"
		leadWhere += " and l.owner_id = $1"
		customerArgs = append(customerArgs, strings.TrimSpace(userID))
		leadArgs = append(leadArgs, strings.TrimSpace(userID))
	}
	customerRows, err := s.db.Query(ctx, `
		select c.id, c.name, c.industry, c.owner_id, u.full_name, c.next_follow_at,
		       c.rating, c.status, f.content, f.created_at
		from public.crm_customers c
		left join public.user_accounts u on u.id::text = c.owner_id
		left join lateral (
			select content, created_at
			from public.crm_follows
			where entity_type = 'customer' and entity_id = c.id
			order by created_at desc, id desc
			limit 1
		) f on true
		where `+customerWhere, customerArgs...)
	if err != nil {
		return crm.FollowUpGroups{}, err
	}
	defer customerRows.Close()
	items := []crm.FollowUpItem{}
	for customerRows.Next() {
		var (
			id                           int64
			name                         string
			subtitle, ownerID, ownerName *string
			nextFollowAt                 time.Time
			rating, status               *string
			lastContent                  *string
			lastAt                       *time.Time
		)
		if err := customerRows.Scan(
			&id, &name, &subtitle, &ownerID, &ownerName, &nextFollowAt,
			&rating, &status, &lastContent, &lastAt,
		); err != nil {
			return crm.FollowUpGroups{}, err
		}
		item := crm.FollowUpItem{
			EntityType: "customer", EntityID: id, Name: name, Subtitle: subtitle,
			OwnerID: ownerID, OwnerName: ownerName, NextFollowAt: timestampValue(nextFollowAt),
			LastFollowContent: lastContent, LastFollowAt: optionalTimestampValue(lastAt),
			Rating: rating, Status: status,
		}
		items = append(items, item)
	}
	if err := customerRows.Err(); err != nil {
		return crm.FollowUpGroups{}, err
	}
	leadRows, err := s.db.Query(ctx, `
		select l.id, l.name, l.company, l.owner_id, u.full_name, l.next_follow_at,
		       l.status, l.intent, f.content, f.created_at
		from public.crm_leads l
		left join public.user_accounts u on u.id::text = l.owner_id
		left join lateral (
			select content, created_at
			from public.crm_follows
			where entity_type = 'lead' and entity_id = l.id
			order by created_at desc, id desc
			limit 1
		) f on true
		where `+leadWhere, leadArgs...)
	if err != nil {
		return crm.FollowUpGroups{}, err
	}
	defer leadRows.Close()
	for leadRows.Next() {
		var (
			id                          int64
			name                        string
			company, ownerID, ownerName *string
			nextFollowAt                time.Time
			status, intent              *string
			lastContent                 *string
			lastAt                      *time.Time
		)
		if err := leadRows.Scan(
			&id, &name, &company, &ownerID, &ownerName, &nextFollowAt,
			&status, &intent, &lastContent, &lastAt,
		); err != nil {
			return crm.FollowUpGroups{}, err
		}
		items = append(items, crm.FollowUpItem{
			EntityType: "lead", EntityID: id, Name: name, Subtitle: company,
			OwnerID: ownerID, OwnerName: ownerName, NextFollowAt: timestampValue(nextFollowAt),
			LastFollowContent: lastContent, LastFollowAt: optionalTimestampValue(lastAt),
			Status: status, Intent: intent,
		})
	}
	if err := leadRows.Err(); err != nil {
		return crm.FollowUpGroups{}, err
	}
	groups := crm.FollowUpGroups{Overdue: []crm.FollowUpItem{}, Today: []crm.FollowUpItem{}, ThisWeek: []crm.FollowUpItem{}}
	for _, item := range items {
		next, parseErr := time.Parse(time.RFC3339, item.NextFollowAt)
		if parseErr != nil {
			continue
		}
		next = next.In(location)
		switch {
		case next.Before(todayStart):
			groups.Overdue = append(groups.Overdue, item)
		case next.Before(tomorrowStart):
			groups.Today = append(groups.Today, item)
		case !next.After(weekEnd):
			groups.ThisWeek = append(groups.ThisWeek, item)
		}
	}
	sortFollowUpsByTime(groups.Overdue)
	sortFollowUpsByTime(groups.Today)
	sortFollowUpsByTime(groups.ThisWeek)
	groups.OverdueCount = len(groups.Overdue)
	groups.TotalCount = len(groups.Overdue) + len(groups.Today) + len(groups.ThisWeek)
	return groups, nil
}

func crmDaysUntilSunday(weekday time.Weekday) int {
	return (7 - int(weekday)) % 7
}

func sortFollowUpsByTime(items []crm.FollowUpItem) {
	sort.Slice(items, func(i, j int) bool {
		return items[i].NextFollowAt < items[j].NextFollowAt
	})
}

func (s *CRMStore) ListAuditLogs(
	ctx context.Context,
	filter crm.AuditLogFilter,
) (crm.Paginated[crm.AuditLog], error) {
	page := filter.Page
	if page < 1 {
		page = 1
	}
	pageSize := filter.PageSize
	if pageSize < 1 {
		pageSize = 20
	}
	where := []string{"true"}
	args := []any{}
	nextArg := 1
	if len(filter.EntityTypes) > 0 {
		where = append(where, "a.entity_type = any($"+strconv.Itoa(nextArg)+")")
		args = append(args, filter.EntityTypes)
		nextArg++
	} else if filter.EntityType != nil {
		where = append(where, "a.entity_type = $"+strconv.Itoa(nextArg))
		args = append(args, *filter.EntityType)
		nextArg++
	}
	if len(filter.EntityIDs) > 0 {
		where = append(where, "a.entity_id = any($"+strconv.Itoa(nextArg)+")")
		args = append(args, filter.EntityIDs)
		nextArg++
	} else if filter.EntityID != nil {
		where = append(where, "a.entity_id = $"+strconv.Itoa(nextArg))
		args = append(args, *filter.EntityID)
		nextArg++
	}
	if filter.ActorID != nil {
		where = append(where, "a.actor_id = $"+strconv.Itoa(nextArg))
		args = append(args, *filter.ActorID)
		nextArg++
	}
	if filter.Action != nil {
		where = append(where, "a.action = $"+strconv.Itoa(nextArg))
		args = append(args, *filter.Action)
		nextArg++
	}
	whereSQL := strings.Join(where, " and ")
	var total int
	if err := s.db.QueryRow(ctx, `
		select count(*) from public.crm_audit_logs a where `+whereSQL, args...).Scan(&total); err != nil {
		return crm.Paginated[crm.AuditLog]{}, err
	}
	query := `
		select a.id, a.entity_type, a.entity_id, a.action, a.actor_id,
		       u.full_name, a.summary, a.created_at
		from public.crm_audit_logs a
		left join public.user_accounts u on u.id::text = a.actor_id
		where ` + whereSQL + `
		order by a.created_at desc, a.id desc
		limit $` + strconv.Itoa(nextArg) + ` offset $` + strconv.Itoa(nextArg+1)
	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return crm.Paginated[crm.AuditLog]{}, err
	}
	defer rows.Close()
	items := []crm.AuditLog{}
	for rows.Next() {
		var item crm.AuditLog
		var createdAt time.Time
		if err := rows.Scan(
			&item.ID, &item.EntityType, &item.EntityID, &item.Action, &item.ActorID,
			&item.ActorName, &item.Summary, &createdAt,
		); err != nil {
			return crm.Paginated[crm.AuditLog]{}, err
		}
		item.CreatedAt = timestampValue(createdAt)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return crm.Paginated[crm.AuditLog]{}, err
	}
	return crm.Paginated[crm.AuditLog]{Items: items, Total: total, Page: page, PageSize: pageSize}, nil
}

const crmTaskSelect = `
select
	t.id, t.title, t.description, t.due_date, t.priority, t.status, t.type,
	t.owner_id, t.customer_id, t.lead_id, t.reminded_at, t.created_by,
	t.completed_at, t.created_at, t.updated_at,
	u.full_name, c.name, l.name
from public.crm_tasks t
left join public.user_accounts u on u.id::text = t.owner_id
left join public.crm_customers c on c.id = t.customer_id
left join public.crm_leads l on l.id = t.lead_id
`

func (s *CRMStore) scanTask(row interface{ Scan(...any) error }) (*crm.Task, error) {
	var item crm.Task
	var dueDate, remindedAt, completedAt *time.Time
	var createdAt, updatedAt time.Time
	var ownerName, customerName, leadName *string
	if err := row.Scan(
		&item.ID, &item.Title, &item.Description, &dueDate, &item.Priority,
		&item.Status, &item.Type, &item.OwnerID, &item.CustomerID, &item.LeadID,
		&remindedAt, &item.CreatedBy, &completedAt, &createdAt, &updatedAt,
		&ownerName, &customerName, &leadName,
	); err != nil {
		return nil, err
	}
	item.DueDate = optionalTimestampValue(dueDate)
	item.RemindedAt = optionalTimestampValue(remindedAt)
	item.CompletedAt = optionalTimestampValue(completedAt)
	item.CreatedAt = timestampValue(createdAt)
	item.UpdatedAt = timestampValue(updatedAt)
	item.OwnerName = ownerName
	item.CustomerName = customerName
	item.LeadName = leadName
	return &item, nil
}

func (s *CRMStore) ListTasks(
	ctx context.Context,
	filter crm.TaskListFilter,
	userID string,
	isAdmin bool,
) (crm.Paginated[crm.Task], error) {
	page := filter.Page
	if page < 1 {
		page = 1
	}
	pageSize := filter.PageSize
	if pageSize < 1 {
		pageSize = 20
	}
	where := []string{"true"}
	args := []any{}
	nextArg := 1
	if filter.Scope == "" || filter.Scope == "mine" {
		where = append(where, "t.owner_id = $"+strconv.Itoa(nextArg))
		args = append(args, strings.TrimSpace(userID))
		nextArg++
	}
	filterColumns := []struct {
		name   string
		column string
		value  any
	}{
		{"type", "type", filter.Type},
		{"status", "status", filter.Status},
		{"priority", "priority", filter.Priority},
		{"owner_id", "owner_id", filter.OwnerID},
		{"customer_id", "customer_id", filter.CustomerID},
		{"lead_id", "lead_id", filter.LeadID},
	}
	for _, item := range filterColumns {
		switch value := item.value.(type) {
		case *string:
			if value != nil && strings.TrimSpace(*value) != "" {
				where = append(where, "t."+item.column+" = $"+strconv.Itoa(nextArg))
				args = append(args, *value)
				nextArg++
			}
		case *int64:
			if value != nil {
				where = append(where, "t."+item.column+" = $"+strconv.Itoa(nextArg))
				args = append(args, *value)
				nextArg++
			}
		}
	}
	if filter.OwnerID != nil && !isAdmin {
		return crm.Paginated[crm.Task]{}, crm.NewAPIError(403, "owner_id 筛选仅管理员可用")
	}
	sortBy := filter.SortBy
	if sortBy == "" {
		sortBy = "due_date"
	}
	switch sortBy {
	case "due_date", "priority", "created_at", "completed_at":
	default:
		return crm.Paginated[crm.Task]{}, crm.NewAPIError(400, "不支持的排序字段: "+sortBy)
	}
	sortOrder := strings.ToLower(filter.SortOrder)
	if sortOrder != "asc" && sortOrder != "desc" {
		return crm.Paginated[crm.Task]{}, crm.NewAPIError(400, "不支持的排序方向: "+filter.SortOrder)
	}
	whereSQL := strings.Join(where, " and ")
	var total int
	if err := s.db.QueryRow(ctx, `
		select count(*) from public.crm_tasks t where `+whereSQL, args...).Scan(&total); err != nil {
		return crm.Paginated[crm.Task]{}, err
	}
	orderSQL := ""
	if sortBy == "priority" {
		orderSQL = `(case t.priority when 'urgent' then 4 when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end) ` + sortOrder
	} else if sortBy == "due_date" && sortOrder == "asc" {
		orderSQL = `t.due_date asc nulls last,
			(case t.priority when 'urgent' then 4 when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end) desc,
			t.created_at desc`
	} else if sortBy == "due_date" {
		orderSQL = `t.due_date desc nulls last,
			(case t.priority when 'urgent' then 4 when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end) asc,
			t.created_at asc`
	} else {
		orderSQL = "t." + sortBy + " " + sortOrder + " nulls last"
	}
	query := crmTaskSelect + " where " + whereSQL + " order by " + orderSQL +
		" limit $" + strconv.Itoa(nextArg) + " offset $" + strconv.Itoa(nextArg+1)
	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return crm.Paginated[crm.Task]{}, err
	}
	defer rows.Close()
	items := []crm.Task{}
	for rows.Next() {
		item, err := s.scanTask(rows)
		if err != nil {
			return crm.Paginated[crm.Task]{}, err
		}
		items = append(items, *item)
	}
	if err := rows.Err(); err != nil {
		return crm.Paginated[crm.Task]{}, err
	}
	return crm.Paginated[crm.Task]{Items: items, Total: total, Page: page, PageSize: pageSize}, nil
}

func (s *CRMStore) GetTask(ctx context.Context, taskID int64) (*crm.Task, error) {
	row := s.db.QueryRow(ctx, crmTaskSelect+" where t.id = $1", taskID)
	item, err := s.scanTask(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return item, err
}

func (s *CRMStore) validateTaskLinks(
	ctx context.Context,
	db DB,
	customerID *int64,
	leadID *int64,
) error {
	if customerID != nil && leadID != nil {
		return crm.NewAPIError(400, "任务只能关联客户或线索之一（二选一）")
	}
	if customerID != nil {
		var exists int
		if err := db.QueryRow(ctx, `
			select count(*) from public.crm_customers where id = $1
		`, *customerID).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			return crm.NewAPIError(404, "Customer not found")
		}
	}
	if leadID != nil {
		var exists int
		if err := db.QueryRow(ctx, `
			select count(*) from public.crm_leads where id = $1
		`, *leadID).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			return crm.NewAPIError(404, "Lead not found")
		}
	}
	return nil
}

func (s *CRMStore) CreateTask(
	ctx context.Context,
	input crm.TaskCreateInput,
	actorID string,
	isAdmin bool,
) (*crm.Task, error) {
	if strings.TrimSpace(input.Title) == "" {
		return nil, crm.NewAPIError(422, "title must contain at least 1 character")
	}
	if input.OwnerID != nil && !isAdmin {
		return nil, crm.NewAPIError(403, "仅管理员可指派负责人")
	}
	ownerID := input.OwnerID
	if ownerID == nil && strings.TrimSpace(actorID) != "" {
		value := strings.TrimSpace(actorID)
		ownerID = &value
	}
	if input.Priority == "" {
		input.Priority = "medium"
	}
	if input.Type == "" {
		input.Type = "custom"
	}
	var taskID int64
	err := s.inTx(ctx, func(db FullDB) error {
		if err := s.validateTaskLinks(ctx, db, input.CustomerID, input.LeadID); err != nil {
			return err
		}
		if err := db.QueryRow(ctx, `
			insert into public.crm_tasks (
				title, description, due_date, priority, type, owner_id,
				customer_id, lead_id, created_by
			) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			returning id
		`,
			strings.TrimSpace(input.Title), crmNullableString(input.Description), input.DueDate,
			input.Priority, input.Type, crmNullableString(ownerID), input.CustomerID,
			input.LeadID, optionalNullableText(actorID),
		).Scan(&taskID); err != nil {
			return err
		}
		return insertCRMAudit(ctx, db, "task", taskID, "create", actorID, "新建任务 "+strings.TrimSpace(input.Title))
	})
	if err != nil {
		return nil, err
	}
	return s.GetTask(ctx, taskID)
}

func (s *CRMStore) UpdateTask(
	ctx context.Context,
	taskID int64,
	input crm.TaskUpdateInput,
	actorID string,
	isAdmin bool,
) (*crm.Task, error) {
	if input.OwnerID.Set && !isAdmin {
		return nil, crm.NewAPIError(403, "仅管理员可修改负责人")
	}
	var currentCustomerID, currentLeadID *int64
	if err := s.db.QueryRow(ctx, `
		select customer_id, lead_id from public.crm_tasks where id = $1
	`, taskID).Scan(&currentCustomerID, &currentLeadID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if input.CustomerID.Set {
		currentCustomerID = input.CustomerID.Value
	}
	if input.LeadID.Set {
		currentLeadID = input.LeadID.Value
	}
	sets := []string{}
	args := []any{}
	nextArg := 1
	add := func(column string, value any) {
		sets = append(sets, column+" = $"+strconv.Itoa(nextArg))
		args = append(args, value)
		nextArg++
	}
	if input.Title.Set {
		if input.Title.Value == nil || strings.TrimSpace(*input.Title.Value) == "" {
			return nil, crm.NewAPIError(422, "title must contain at least 1 character")
		}
		add("title", strings.TrimSpace(*input.Title.Value))
	}
	for _, optional := range []struct {
		column string
		value  crm.Optional[string]
	}{
		{"description", input.Description}, {"priority", input.Priority},
		{"type", input.Type}, {"owner_id", input.OwnerID},
	} {
		if optional.value.Set {
			add(optional.column, crmNullableString(optional.value.Value))
		}
	}
	if input.DueDate.Set {
		add("due_date", input.DueDate.Value)
	}
	if input.CustomerID.Set {
		if input.CustomerID.Value == nil {
			add("customer_id", nil)
		} else {
			add("customer_id", *input.CustomerID.Value)
		}
	}
	if input.LeadID.Set {
		if input.LeadID.Value == nil {
			add("lead_id", nil)
		} else {
			add("lead_id", *input.LeadID.Value)
		}
	}
	if len(sets) == 0 {
		if err := s.inTx(ctx, func(db FullDB) error {
			return insertCRMAudit(ctx, db, "task", taskID, "update", actorID, "编辑任务")
		}); err != nil {
			return nil, err
		}
		return s.GetTask(ctx, taskID)
	}
	sets = append(sets, "updated_at = now()")
	args = append(args, taskID)
	err := s.inTx(ctx, func(db FullDB) error {
		if err := s.validateTaskLinks(ctx, db, currentCustomerID, currentLeadID); err != nil {
			return err
		}
		tag, err := db.Exec(ctx, `
			update public.crm_tasks
			set `+strings.Join(sets, ", ")+`
			where id = $`+strconv.Itoa(nextArg)+`
		`, args...)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return insertCRMAudit(ctx, db, "task", taskID, "update", actorID, "编辑任务")
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return s.GetTask(ctx, taskID)
}

func (s *CRMStore) SetTaskStatus(
	ctx context.Context,
	taskID int64,
	status string,
	actorID string,
) (*crm.Task, error) {
	err := s.inTx(ctx, func(db FullDB) error {
		var currentStatus, title string
		if err := db.QueryRow(ctx, `
			select status, title from public.crm_tasks where id = $1 for update
		`, taskID).Scan(&currentStatus, &title); err != nil {
			return err
		}
		if currentStatus == "done" || currentStatus == "cancelled" {
			return crm.NewAPIError(409, "任务已"+currentStatus+"，不可再流转")
		}
		if status != "pending" && status != "in_progress" && status != "done" {
			return crm.NewAPIError(400, "不支持的状态: "+status)
		}
		if status == "done" {
			if _, err := db.Exec(ctx, `
				update public.crm_tasks
				set status = $1, completed_at = now(), updated_at = now()
				where id = $2
			`, status, taskID); err != nil {
				return err
			}
		} else if _, err := db.Exec(ctx, `
			update public.crm_tasks
			set status = $1, completed_at = null, updated_at = now()
			where id = $2
		`, status, taskID); err != nil {
			return err
		}
		return insertCRMAudit(ctx, db, "task", taskID, "status", actorID, "状态变更: "+title)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, crm.NewAPIError(404, "Task not found")
	}
	if err != nil {
		return nil, err
	}
	return s.GetTask(ctx, taskID)
}

func (s *CRMStore) CompleteTask(
	ctx context.Context,
	taskID int64,
	input *crm.TaskCompleteInput,
	actorID string,
) (*crm.Task, error) {
	err := s.inTx(ctx, func(db FullDB) error {
		var title, taskType, status string
		var customerID, leadID *int64
		if err := db.QueryRow(ctx, `
			select title, type, status, customer_id, lead_id
			from public.crm_tasks
			where id = $1
			for update
		`, taskID).Scan(&title, &taskType, &status, &customerID, &leadID); err != nil {
			return err
		}
		if status == "done" {
			return crm.NewAPIError(409, "任务已完成，不可重复完成")
		}
		if status == "cancelled" {
			return crm.NewAPIError(409, "任务已取消，不可完成")
		}
		if _, err := db.Exec(ctx, `
			update public.crm_tasks
			set status = 'done', completed_at = now(), updated_at = now()
			where id = $1
		`, taskID); err != nil {
			return err
		}
		if (taskType == "follow_up" || taskType == "call" || taskType == "visit") &&
			(customerID != nil || leadID != nil) {
			var nextFollowAt *time.Time
			note := ""
			if input != nil {
				nextFollowAt = input.NextFollowAt
				if input.Note != nil {
					note = strings.TrimSpace(*input.Note)
				}
			}
			content := title
			if note != "" {
				content += "：" + note
			}
			followType := map[string]string{
				"follow_up": "note", "call": "phone", "visit": "visit",
			}[taskType]
			entityType := "lead"
			var entityID int64
			if customerID != nil {
				entityType = "customer"
				entityID = *customerID
			} else {
				entityID = *leadID
			}
			var followID int64
			if err := s.createFollowTx(ctx, db, crm.FollowCreateInput{
				EntityType: entityType, EntityID: entityID, Type: followType,
				Content: content, NextFollowAt: nextFollowAt,
			}, actorID, &followID, false); err != nil {
				return err
			}
		}
		return insertCRMAudit(ctx, db, "task", taskID, "complete", actorID, "完成任务 "+title)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, crm.NewAPIError(404, "Task not found")
	}
	if err != nil {
		return nil, err
	}
	return s.GetTask(ctx, taskID)
}

func (s *CRMStore) CancelTask(
	ctx context.Context,
	taskID int64,
	actorID string,
) (*crm.Task, error) {
	err := s.inTx(ctx, func(db FullDB) error {
		var title, status string
		if err := db.QueryRow(ctx, `
			select title, status from public.crm_tasks where id = $1 for update
		`, taskID).Scan(&title, &status); err != nil {
			return err
		}
		if status == "done" {
			return crm.NewAPIError(409, "任务已完成，不可取消")
		}
		if _, err := db.Exec(ctx, `
			update public.crm_tasks
			set status = 'cancelled', completed_at = null, updated_at = now()
			where id = $1
		`, taskID); err != nil {
			return err
		}
		return insertCRMAudit(ctx, db, "task", taskID, "cancel", actorID, "取消任务 "+title)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, crm.NewAPIError(404, "Task not found")
	}
	if err != nil {
		return nil, err
	}
	return s.GetTask(ctx, taskID)
}

func (s *CRMStore) ListTaskReminders(
	ctx context.Context,
	userID *string,
) ([]crm.TaskReminder, error) {
	if userID == nil || strings.TrimSpace(*userID) == "" {
		return []crm.TaskReminder{}, nil
	}
	rows, err := s.db.Query(ctx, `
		select id, title, due_date
		from public.crm_tasks
		where owner_id = $1
		  and reminded_at is not null
		  and due_date is not null
		  and due_date >= now()
		  and status in ('pending', 'in_progress')
		order by due_date asc, id asc
	`, strings.TrimSpace(*userID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []crm.TaskReminder{}
	for rows.Next() {
		var item crm.TaskReminder
		var dueDate time.Time
		if err := rows.Scan(&item.TaskID, &item.Title, &dueDate); err != nil {
			return nil, err
		}
		formatted := timestampValue(dueDate)
		item.DueDate = &formatted
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *CRMStore) ListFollowUpReminders(
	ctx context.Context,
	userID string,
	days int,
) ([]crm.FollowUpReminder, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return []crm.FollowUpReminder{}, nil
	}
	if days < 0 {
		days = 7
	}
	rows, err := s.db.Query(ctx, `
		select 'customer' as entity_type, c.id, c.name,
		       greatest(0, floor(extract(epoch from now() - coalesce(c.last_follow_at, c.created_at)) / 86400.0))::int as days
		from public.crm_reminder_logs r
		join public.crm_customers c
		  on r.entity_type = 'customer' and r.entity_id = c.id
		where r.reminder_type = 'stale_follow_up'
		  and r.status = 'active'
		  and c.owner_id = $1
		  and c.is_deleted = false
		  and c.status <> 'signed'
		  and coalesce(c.last_follow_at, c.created_at) < now() - make_interval(days => $2)
		union all
		select 'lead' as entity_type, l.id, l.name,
		       greatest(0, floor(extract(epoch from now() - coalesce(l.last_follow_at, l.next_follow_at, l.created_at)) / 86400.0))::int as days
		from public.crm_reminder_logs r
		join public.crm_leads l
		  on r.entity_type = 'lead' and r.entity_id = l.id
		where r.reminder_type = 'stale_follow_up'
		  and r.status = 'active'
		  and l.owner_id = $1
		  and l.is_deleted = false
		  and l.status not in ('converted', 'discarded')
		  and coalesce(l.last_follow_at, l.next_follow_at, l.created_at) < now() - make_interval(days => $2)
		order by days desc, entity_type, id
	`, userID, days)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []crm.FollowUpReminder{}
	for rows.Next() {
		var item crm.FollowUpReminder
		if err := rows.Scan(&item.EntityType, &item.EntityID, &item.Name, &item.Days); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *CRMStore) ListRules(ctx context.Context) ([]crm.Rule, error) {
	rows, err := s.db.Query(ctx, `
		select id, name, description, entity_type, event_type, enabled, priority,
		       created_by, created_at, updated_at
		from public.crm_rules
		order by priority desc, id asc
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []crm.Rule{}
	ids := []int64{}
	for rows.Next() {
		var item crm.Rule
		var createdAt, updatedAt time.Time
		if err := rows.Scan(
			&item.ID, &item.Name, &item.Description, &item.EntityType, &item.EventType,
			&item.Enabled, &item.Priority, &item.CreatedBy, &createdAt, &updatedAt,
		); err != nil {
			return nil, err
		}
		item.CreatedAt = timestampValue(createdAt)
		item.UpdatedAt = timestampValue(updatedAt)
		item.Conditions = []crm.RuleCondition{}
		item.Actions = []crm.RuleAction{}
		items = append(items, item)
		ids = append(ids, item.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return items, nil
	}
	if err := s.loadRuleChildren(ctx, s.db, ids, items); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *CRMStore) loadRuleChildren(
	ctx context.Context,
	db DB,
	ruleIDs []int64,
	items []crm.Rule,
) error {
	byID := map[int64]*crm.Rule{}
	for index := range items {
		byID[items[index].ID] = &items[index]
	}
	conditionRows, err := db.Query(ctx, `
		select id, rule_id, field, operator, value, sort_order
		from public.crm_rule_conditions
		where rule_id = any($1)
		order by rule_id, sort_order, id
	`, ruleIDs)
	if err != nil {
		return err
	}
	for conditionRows.Next() {
		var ruleID int64
		var condition crm.RuleCondition
		if err := conditionRows.Scan(
			&condition.ID, &ruleID, &condition.Field, &condition.Operator,
			&condition.Value, &condition.SortOrder,
		); err != nil {
			conditionRows.Close()
			return err
		}
		if rule := byID[ruleID]; rule != nil {
			rule.Conditions = append(rule.Conditions, condition)
		}
	}
	conditionRows.Close()
	if err := conditionRows.Err(); err != nil {
		return err
	}
	actionRows, err := db.Query(ctx, `
		select id, rule_id, action_type, params, sort_order
		from public.crm_rule_actions
		where rule_id = any($1)
		order by rule_id, sort_order, id
	`, ruleIDs)
	if err != nil {
		return err
	}
	defer actionRows.Close()
	for actionRows.Next() {
		var ruleID int64
		var action crm.RuleAction
		var paramsJSON []byte
		if err := actionRows.Scan(
			&action.ID, &ruleID, &action.ActionType, &paramsJSON, &action.SortOrder,
		); err != nil {
			return err
		}
		if len(paramsJSON) > 0 {
			_ = json.Unmarshal(paramsJSON, &action.Params)
		}
		if rule := byID[ruleID]; rule != nil {
			rule.Actions = append(rule.Actions, action)
		}
	}
	return actionRows.Err()
}

func (s *CRMStore) CreateRule(
	ctx context.Context,
	input crm.RuleCreateInput,
	actorID string,
) (*crm.Rule, error) {
	if input.EntityType == "" {
		input.EntityType = "customer"
	}
	if input.EventType == "" {
		input.EventType = "stale_follow_up"
	}
	if strings.TrimSpace(input.Name) == "" {
		return nil, crm.NewAPIError(422, "name must contain at least 1 character")
	}
	if err := validateCRMStoreRuleConditions(input.Conditions); err != nil {
		return nil, err
	}
	if err := validateCRMStoreRuleActions(input.Actions); err != nil {
		return nil, err
	}
	var ruleID int64
	err := s.inTx(ctx, func(db FullDB) error {
		if err := db.QueryRow(ctx, `
			insert into public.crm_rules
				(name, description, entity_type, event_type, enabled, priority, created_by)
			values ($1, $2, $3, $4, $5, $6, $7)
			returning id
		`, strings.TrimSpace(input.Name), crmNullableString(input.Description), input.EntityType,
			input.EventType, input.Enabled, input.Priority, optionalNullableText(actorID),
		).Scan(&ruleID); err != nil {
			return err
		}
		if err := s.rebuildRuleConditions(ctx, db, ruleID, input.Conditions); err != nil {
			return err
		}
		if err := s.rebuildRuleActions(ctx, db, ruleID, input.Actions); err != nil {
			return err
		}
		return insertCRMAudit(ctx, db, "rule", ruleID, "create", actorID, "新建规则「"+strings.TrimSpace(input.Name)+"」")
	})
	if err != nil {
		return nil, err
	}
	return s.getRule(ctx, ruleID)
}

func (s *CRMStore) getRule(ctx context.Context, ruleID int64) (*crm.Rule, error) {
	var item crm.Rule
	var createdAt, updatedAt time.Time
	err := s.db.QueryRow(ctx, `
		select id, name, description, entity_type, event_type, enabled, priority,
		       created_by, created_at, updated_at
		from public.crm_rules where id = $1
	`, ruleID).Scan(
		&item.ID, &item.Name, &item.Description, &item.EntityType, &item.EventType,
		&item.Enabled, &item.Priority, &item.CreatedBy, &createdAt, &updatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	item.CreatedAt = timestampValue(createdAt)
	item.UpdatedAt = timestampValue(updatedAt)
	items := []crm.Rule{item}
	if err := s.loadRuleChildren(ctx, s.db, []int64{ruleID}, items); err != nil {
		return nil, err
	}
	return &items[0], nil
}

func (s *CRMStore) UpdateRule(
	ctx context.Context,
	ruleID int64,
	input crm.RuleUpdateInput,
	actorID string,
) (*crm.Rule, error) {
	sets := []string{}
	args := []any{}
	nextArg := 1
	add := func(column string, value any) {
		sets = append(sets, column+" = $"+strconv.Itoa(nextArg))
		args = append(args, value)
		nextArg++
	}
	if input.Name.Set {
		if input.Name.Value == nil || strings.TrimSpace(*input.Name.Value) == "" {
			return nil, crm.NewAPIError(422, "name must contain at least 1 character")
		}
		add("name", strings.TrimSpace(*input.Name.Value))
	}
	for _, optional := range []struct {
		column string
		value  crm.Optional[string]
	}{
		{"description", input.Description}, {"entity_type", input.EntityType},
		{"event_type", input.EventType},
	} {
		if optional.value.Set {
			add(optional.column, crmNullableString(optional.value.Value))
		}
	}
	if input.Enabled.Set {
		add("enabled", input.Enabled.Value != nil && *input.Enabled.Value)
	}
	if input.Priority.Set {
		add("priority", input.Priority.Value)
	}
	if input.Conditions.Set && input.Conditions.Value != nil {
		if err := validateCRMStoreRuleConditions(*input.Conditions.Value); err != nil {
			return nil, err
		}
	}
	if input.Actions.Set && input.Actions.Value != nil {
		if err := validateCRMStoreRuleActions(*input.Actions.Value); err != nil {
			return nil, err
		}
	}
	err := s.inTx(ctx, func(db FullDB) error {
		var name string
		if err := db.QueryRow(ctx, `
			select name from public.crm_rules where id = $1 for update
		`, ruleID).Scan(&name); err != nil {
			return err
		}
		if len(sets) > 0 {
			setsWithUpdated := append(sets, "updated_at = now()")
			execArgs := append([]any(nil), args...)
			execArgs = append(execArgs, ruleID)
			query := `update public.crm_rules set ` + strings.Join(setsWithUpdated, ", ") +
				` where id = $` + strconv.Itoa(nextArg)
			if _, err := db.Exec(ctx, query, execArgs...); err != nil {
				return err
			}
		} else if _, err := db.Exec(ctx, `
			update public.crm_rules set updated_at = now() where id = $1
		`, ruleID); err != nil {
			return err
		}
		if input.Conditions.Set && input.Conditions.Value != nil {
			if err := s.rebuildRuleConditions(ctx, db, ruleID, *input.Conditions.Value); err != nil {
				return err
			}
		}
		if input.Actions.Set && input.Actions.Value != nil {
			if err := s.rebuildRuleActions(ctx, db, ruleID, *input.Actions.Value); err != nil {
				return err
			}
		}
		return insertCRMAudit(ctx, db, "rule", ruleID, "update", actorID, "编辑规则「"+name+"」")
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, crm.NewAPIError(404, "Rule not found")
	}
	if err != nil {
		return nil, err
	}
	return s.getRule(ctx, ruleID)
}

func (s *CRMStore) rebuildRuleConditions(
	ctx context.Context,
	db FullDB,
	ruleID int64,
	conditions []crm.RuleConditionInput,
) error {
	if _, err := db.Exec(ctx, `delete from public.crm_rule_conditions where rule_id = $1`, ruleID); err != nil {
		return err
	}
	for _, condition := range conditions {
		if _, err := db.Exec(ctx, `
			insert into public.crm_rule_conditions
				(rule_id, field, operator, value, sort_order)
			values ($1, $2, $3, $4, $5)
		`, ruleID, condition.Field, condition.Operator, crmNullableString(condition.Value), condition.SortOrder); err != nil {
			return err
		}
	}
	return nil
}

func (s *CRMStore) rebuildRuleActions(
	ctx context.Context,
	db FullDB,
	ruleID int64,
	actions []crm.RuleActionInput,
) error {
	if _, err := db.Exec(ctx, `delete from public.crm_rule_actions where rule_id = $1`, ruleID); err != nil {
		return err
	}
	for _, action := range actions {
		params := any(nil)
		if action.Params != nil {
			encoded, err := json.Marshal(action.Params)
			if err != nil {
				return err
			}
			params = string(encoded)
		}
		if _, err := db.Exec(ctx, `
			insert into public.crm_rule_actions
				(rule_id, action_type, params, sort_order)
			values ($1, $2, $3::json, $4)
		`, ruleID, action.ActionType, params, action.SortOrder); err != nil {
			return err
		}
	}
	return nil
}

func (s *CRMStore) DeleteRule(ctx context.Context, ruleID int64, actorID string) error {
	err := s.inTx(ctx, func(db FullDB) error {
		var name string
		if err := db.QueryRow(ctx, `
			select name from public.crm_rules where id = $1 for update
		`, ruleID).Scan(&name); err != nil {
			return err
		}
		if _, err := db.Exec(ctx, `delete from public.crm_rule_conditions where rule_id = $1`, ruleID); err != nil {
			return err
		}
		if _, err := db.Exec(ctx, `delete from public.crm_rule_actions where rule_id = $1`, ruleID); err != nil {
			return err
		}
		if _, err := db.Exec(ctx, `delete from public.crm_rules where id = $1`, ruleID); err != nil {
			return err
		}
		return insertCRMAudit(ctx, db, "rule", ruleID, "delete", actorID, "删除规则「"+name+"」")
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return crm.NewAPIError(404, "Rule not found")
	}
	return err
}

func (s *CRMStore) GetWorkflowSettings(ctx context.Context) (crm.WorkflowSettings, error) {
	var settings crm.WorkflowSettings
	err := s.inTx(ctx, func(db FullDB) error {
		if _, err := db.Exec(ctx, `
			insert into public.crm_workflow_settings (id, stale_days, stale_email_enabled)
			values (1, 7, true)
			on conflict (id) do nothing
		`); err != nil {
			return err
		}
		return db.QueryRow(ctx, `
			select stale_days, stale_email_enabled
			from public.crm_workflow_settings where id = 1
		`).Scan(&settings.StaleDays, &settings.StaleEmailEnabled)
	})
	return settings, err
}

func (s *CRMStore) UpdateWorkflowSettings(
	ctx context.Context,
	input crm.WorkflowSettingsUpdate,
	actorID string,
) (crm.WorkflowSettings, error) {
	var settings crm.WorkflowSettings
	err := s.inTx(ctx, func(db FullDB) error {
		if _, err := db.Exec(ctx, `
			insert into public.crm_workflow_settings (id, stale_days, stale_email_enabled)
			values (1, 7, true)
			on conflict (id) do nothing
		`); err != nil {
			return err
		}
		if input.StaleDays.Set && input.StaleDays.Value != nil {
			if _, err := db.Exec(ctx, `
				update public.crm_workflow_settings
				set stale_days = $1, updated_at = now()
				where id = 1
			`, *input.StaleDays.Value); err != nil {
				return err
			}
		}
		if input.StaleEmailEnabled.Set && input.StaleEmailEnabled.Value != nil {
			if _, err := db.Exec(ctx, `
				update public.crm_workflow_settings
				set stale_email_enabled = $1, updated_at = now()
				where id = 1
			`, *input.StaleEmailEnabled.Value); err != nil {
				return err
			}
		}
		if err := db.QueryRow(ctx, `
			select stale_days, stale_email_enabled
			from public.crm_workflow_settings where id = 1
		`).Scan(&settings.StaleDays, &settings.StaleEmailEnabled); err != nil {
			return err
		}
		return insertCRMAudit(ctx, db, "workflow", 1, "update", actorID, "更新工作流设置")
	})
	return settings, err
}

func (s *CRMStore) ListCategories(ctx context.Context) ([]crm.Category, error) {
	rows, err := s.db.Query(ctx, `
		select id, name, sort_order, created_at
		from public.crm_categories
		order by sort_order, id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []crm.Category{}
	for rows.Next() {
		var item crm.Category
		var createdAt time.Time
		if err := rows.Scan(&item.ID, &item.Name, &item.SortOrder, &createdAt); err != nil {
			return nil, err
		}
		item.CreatedAt = timestampValue(createdAt)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *CRMStore) getCategory(ctx context.Context, categoryID int64) (*crm.Category, error) {
	var item crm.Category
	var createdAt time.Time
	err := s.db.QueryRow(ctx, `
		select id, name, sort_order, created_at
		from public.crm_categories where id = $1
	`, categoryID).Scan(&item.ID, &item.Name, &item.SortOrder, &createdAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	item.CreatedAt = timestampValue(createdAt)
	return &item, nil
}

func crmIsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func (s *CRMStore) CreateCategory(
	ctx context.Context,
	input crm.CategoryCreateInput,
	actorID string,
) (*crm.Category, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return nil, crm.NewAPIError(422, "name must contain at least 1 character")
	}
	var categoryID int64
	err := s.inTx(ctx, func(db FullDB) error {
		if err := db.QueryRow(ctx, `
			insert into public.crm_categories (name, sort_order)
			values ($1, $2)
			returning id
		`, name, input.SortOrder).Scan(&categoryID); err != nil {
			if crmIsUniqueViolation(err) {
				return crm.NewAPIError(409, "类目「"+name+"」已存在")
			}
			return err
		}
		return insertCRMAudit(ctx, db, "category", categoryID, "create", actorID, "新建产品类目「"+name+"」")
	})
	if err != nil {
		return nil, err
	}
	return s.getCategory(ctx, categoryID)
}

func (s *CRMStore) UpdateCategory(
	ctx context.Context,
	categoryID int64,
	input crm.CategoryUpdateInput,
	actorID string,
) (*crm.Category, error) {
	sets := []string{}
	args := []any{}
	nextArg := 1
	if input.Name.Set && input.Name.Value != nil {
		name := strings.TrimSpace(*input.Name.Value)
		if name == "" {
			return nil, crm.NewAPIError(422, "name must contain at least 1 character")
		}
		sets = append(sets, "name = $"+strconv.Itoa(nextArg))
		args = append(args, name)
		nextArg++
	}
	if input.SortOrder.Set && input.SortOrder.Value != nil {
		sets = append(sets, "sort_order = $"+strconv.Itoa(nextArg))
		args = append(args, *input.SortOrder.Value)
		nextArg++
	}
	var categoryName string
	err := s.inTx(ctx, func(db FullDB) error {
		if err := db.QueryRow(ctx, `
			select name from public.crm_categories where id = $1 for update
		`, categoryID).Scan(&categoryName); err != nil {
			return err
		}
		if len(sets) > 0 {
			args = append(args, categoryID)
			if _, err := db.Exec(ctx, `
				update public.crm_categories
				set `+strings.Join(sets, ", ")+`
				where id = $`+strconv.Itoa(nextArg)+`
			`, args...); err != nil {
				if crmIsUniqueViolation(err) {
					return crm.NewAPIError(409, "类目「"+derefString(input.Name.Value)+"」已存在")
				}
				return err
			}
			if input.Name.Value != nil {
				categoryName = strings.TrimSpace(*input.Name.Value)
			}
		}
		return insertCRMAudit(ctx, db, "category", categoryID, "update", actorID, "编辑产品类目「"+categoryName+"」")
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return s.getCategory(ctx, categoryID)
}

func (s *CRMStore) DeleteCategory(ctx context.Context, categoryID int64, actorID string) error {
	err := s.inTx(ctx, func(db FullDB) error {
		var name string
		if err := db.QueryRow(ctx, `
			select name from public.crm_categories where id = $1 for update
		`, categoryID).Scan(&name); err != nil {
			return err
		}
		if _, err := db.Exec(ctx, `delete from public.crm_customer_categories where category_id = $1`, categoryID); err != nil {
			return err
		}
		if _, err := db.Exec(ctx, `delete from public.crm_categories where id = $1`, categoryID); err != nil {
			return err
		}
		return insertCRMAudit(ctx, db, "category", categoryID, "delete", actorID, "删除产品类目「"+name+"」")
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return crm.NewAPIError(404, "类目不存在")
	}
	return err
}

func (s *CRMStore) SetCustomerCategories(
	ctx context.Context,
	customerID int64,
	categoryIDs []int64,
	actorID string,
) (*crm.Customer, error) {
	ids := make([]int64, 0, len(categoryIDs))
	seen := map[int64]bool{}
	for _, id := range categoryIDs {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	err := s.inTx(ctx, func(db FullDB) error {
		var exists int
		if err := db.QueryRow(ctx, `
			select count(*) from public.crm_customers where id = $1 and is_deleted = false
		`, customerID).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			return crm.NewAPIError(404, "客户不存在")
		}
		if len(ids) > 0 {
			var found int
			if err := db.QueryRow(ctx, `
				select count(*) from public.crm_categories where id = any($1)
			`, ids).Scan(&found); err != nil {
				return err
			}
			if found != len(ids) {
				return crm.NewAPIError(400, "类目不存在")
			}
		}
		if _, err := db.Exec(ctx, `delete from public.crm_customer_categories where customer_id = $1`, customerID); err != nil {
			return err
		}
		for _, categoryID := range ids {
			if _, err := db.Exec(ctx, `
				insert into public.crm_customer_categories (customer_id, category_id)
				values ($1, $2)
				on conflict do nothing
			`, customerID, categoryID); err != nil {
				return err
			}
		}
		return insertCRMAudit(ctx, db, "customer", customerID, "update", actorID, "产品类目更新")
	})
	if err != nil {
		return nil, err
	}
	return s.GetCustomer(ctx, customerID)
}

func (s *CRMStore) scanSavedView(row interface{ Scan(...any) error }) (*crm.SavedView, error) {
	var item crm.SavedView
	var filtersJSON []byte
	var createdAt, updatedAt time.Time
	if err := row.Scan(
		&item.ID, &item.Name, &item.EntityType, &item.Scope, &item.Keyword,
		&filtersJSON, &item.SortBy, &item.SortOrder, &item.IsShared, &item.OwnerID,
		&item.OwnerName, &createdAt, &updatedAt,
	); err != nil {
		return nil, err
	}
	if len(filtersJSON) > 0 {
		_ = json.Unmarshal(filtersJSON, &item.Filters)
	}
	item.CreatedAt = timestampValue(createdAt)
	item.UpdatedAt = timestampValue(updatedAt)
	return &item, nil
}

const crmSavedViewSelect = `
select v.id, v.name, v.entity_type, v.scope, v.keyword, v.filters,
       v.sort_by, v.sort_order, v.is_shared, v.owner_id, u.full_name,
       v.created_at, v.updated_at
from public.crm_saved_views v
left join public.user_accounts u on u.id::text = v.owner_id
`

func (s *CRMStore) ListSavedViews(
	ctx context.Context,
	entityType *string,
	userID string,
	isAdmin bool,
) ([]crm.SavedView, error) {
	_ = isAdmin
	where := "(v.is_shared = true or v.owner_id = $1)"
	args := []any{strings.TrimSpace(userID)}
	if entityType != nil {
		where += " and v.entity_type = $2"
		args = append(args, *entityType)
	}
	rows, err := s.db.Query(ctx, crmSavedViewSelect+" where "+where+
		" order by v.updated_at desc, v.id desc", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []crm.SavedView{}
	for rows.Next() {
		item, err := s.scanSavedView(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *item)
	}
	return items, rows.Err()
}

func (s *CRMStore) CreateSavedView(
	ctx context.Context,
	input crm.SavedViewCreateInput,
	actorID string,
	isAdmin bool,
) (*crm.SavedView, error) {
	if input.IsShared && !isAdmin {
		return nil, crm.NewAPIError(403, "Admin required to create shared views")
	}
	if err := validateCRMSavedViewFilters(input.EntityType, input.Filters); err != nil {
		return nil, err
	}
	filtersJSON, err := json.Marshal(input.Filters)
	if err != nil {
		return nil, err
	}
	var viewID int64
	err = s.inTx(ctx, func(db FullDB) error {
		if err := db.QueryRow(ctx, `
			insert into public.crm_saved_views
				(name, entity_type, scope, keyword, filters, sort_by, sort_order,
				 is_shared, owner_id)
			values ($1, $2, $3, $4, $5::json, $6, $7, $8, $9)
			returning id
		`, strings.TrimSpace(input.Name), input.EntityType, input.Scope,
			crmNullableString(input.Keyword), string(filtersJSON), input.SortBy,
			input.SortOrder, input.IsShared, optionalNullableText(actorID),
		).Scan(&viewID); err != nil {
			return err
		}
		return insertCRMAudit(ctx, db, "saved_view", viewID, "create", actorID, "新建保存视图「"+strings.TrimSpace(input.Name)+"」")
	})
	if err != nil {
		return nil, err
	}
	return s.getSavedView(ctx, viewID)
}

func (s *CRMStore) getSavedView(ctx context.Context, viewID int64) (*crm.SavedView, error) {
	row := s.db.QueryRow(ctx, crmSavedViewSelect+" where v.id = $1", viewID)
	item, err := s.scanSavedView(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return item, err
}

func (s *CRMStore) UpdateSavedView(
	ctx context.Context,
	viewID int64,
	input crm.SavedViewUpdateInput,
	actorID string,
	isAdmin bool,
) (*crm.SavedView, error) {
	var ownerID *string
	var entityType string
	var isShared bool
	if err := s.db.QueryRow(ctx, `
		select owner_id, entity_type, is_shared
		from public.crm_saved_views where id = $1
	`, viewID).Scan(&ownerID, &entityType, &isShared); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	visible := isShared || (ownerID != nil && *ownerID == actorID)
	if !visible {
		return nil, nil
	}
	if !(ownerID != nil && *ownerID == actorID) && !(isShared && isAdmin) {
		return nil, crm.NewAPIError(403, "Not the view owner (shared views: owner or admin)")
	}
	if input.IsShared.Set && input.IsShared.Value != nil && *input.IsShared.Value && !isShared && !isAdmin {
		return nil, crm.NewAPIError(403, "Admin required to create shared views")
	}
	if input.Filters.Set && input.Filters.Value != nil {
		if err := validateCRMSavedViewFilters(entityType, *input.Filters.Value); err != nil {
			return nil, err
		}
	}
	sets := []string{}
	args := []any{}
	nextArg := 1
	for _, optional := range []struct {
		column string
		value  crm.Optional[string]
	}{
		{"name", input.Name}, {"scope", input.Scope}, {"keyword", input.Keyword},
		{"sort_by", input.SortBy}, {"sort_order", input.SortOrder},
	} {
		if optional.value.Set {
			value := crmNullableString(optional.value.Value)
			if optional.column == "name" || optional.column == "scope" ||
				optional.column == "sort_by" || optional.column == "sort_order" {
				if optional.value.Value == nil {
					continue
				}
				value = strings.TrimSpace(*optional.value.Value)
			}
			sets = append(sets, optional.column+" = $"+strconv.Itoa(nextArg))
			args = append(args, value)
			nextArg++
		}
	}
	if input.IsShared.Set && input.IsShared.Value != nil {
		sets = append(sets, "is_shared = $"+strconv.Itoa(nextArg))
		args = append(args, *input.IsShared.Value)
		nextArg++
	}
	if input.Filters.Set && input.Filters.Value != nil {
		encoded, err := json.Marshal(*input.Filters.Value)
		if err != nil {
			return nil, err
		}
		sets = append(sets, "filters = $"+strconv.Itoa(nextArg)+"::json")
		args = append(args, string(encoded))
		nextArg++
	}
	if len(sets) == 0 {
		if err := s.inTx(ctx, func(db FullDB) error {
			return insertCRMAudit(ctx, db, "saved_view", viewID, "update", actorID, "编辑保存视图")
		}); err != nil {
			return nil, err
		}
		return s.getSavedView(ctx, viewID)
	}
	args = append(args, viewID)
	err := s.inTx(ctx, func(db FullDB) error {
		if _, err := db.Exec(ctx, `
			update public.crm_saved_views
			set `+strings.Join(sets, ", ")+`, updated_at = now()
			where id = $`+strconv.Itoa(nextArg)+`
		`, args...); err != nil {
			return err
		}
		return insertCRMAudit(ctx, db, "saved_view", viewID, "update", actorID, "编辑保存视图")
	})
	if err != nil {
		return nil, err
	}
	return s.getSavedView(ctx, viewID)
}

func (s *CRMStore) DeleteSavedView(
	ctx context.Context,
	viewID int64,
	actorID string,
	isAdmin bool,
) error {
	var ownerID *string
	var isShared bool
	var name string
	if err := s.db.QueryRow(ctx, `
		select owner_id, is_shared, name
		from public.crm_saved_views where id = $1
	`, viewID).Scan(&ownerID, &isShared, &name); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return crm.NewAPIError(404, "视图不存在")
		}
		return err
	}
	visible := isShared || (ownerID != nil && *ownerID == actorID)
	if !visible {
		return crm.NewAPIError(404, "视图不存在")
	}
	if !(ownerID != nil && *ownerID == actorID) && !(isShared && isAdmin) {
		return crm.NewAPIError(403, "Not the view owner (shared views: owner or admin)")
	}
	return s.inTx(ctx, func(db FullDB) error {
		if _, err := db.Exec(ctx, `delete from public.crm_saved_views where id = $1`, viewID); err != nil {
			return err
		}
		return insertCRMAudit(ctx, db, "saved_view", viewID, "delete", actorID, "删除保存视图「"+name+"」")
	})
}

var crmLeadStatusOrder = []string{"new", "contacting", "qualified", "converted", "discarded"}

func emptyCRMFunnel() map[string]int {
	return map[string]int{
		"new": 0, "contacting": 0, "qualified": 0, "converted": 0, "discarded": 0,
	}
}

func shanghaiLocation() *time.Location {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return time.FixedZone("CST", 8*60*60)
	}
	return location
}

func (s *CRMStore) GetDashboardStats(ctx context.Context) (crm.DashboardStats, error) {
	location := shanghaiLocation()
	now := time.Now().In(location)
	monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, location)
	sevenDaysAgo := now.AddDate(0, 0, -7)
	funnel := emptyCRMFunnel()
	rows, err := s.db.Query(ctx, `
		select status, count(*)
		from public.crm_leads
		where is_deleted = false
		group by status
	`)
	if err != nil {
		return crm.DashboardStats{}, err
	}
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			rows.Close()
			return crm.DashboardStats{}, err
		}
		funnel[status] = count
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return crm.DashboardStats{}, err
	}
	var newCustomers, newLeads, convertedCount, followCount int
	if err := s.db.QueryRow(ctx, `
		select count(*) from public.crm_customers
		where is_deleted = false and created_at >= $1
	`, monthStart).Scan(&newCustomers); err != nil {
		return crm.DashboardStats{}, err
	}
	if err := s.db.QueryRow(ctx, `
		select count(*) from public.crm_leads
		where is_deleted = false and created_at >= $1
	`, monthStart).Scan(&newLeads); err != nil {
		return crm.DashboardStats{}, err
	}
	if err := s.db.QueryRow(ctx, `
		select count(*) from public.crm_leads
		where is_deleted = false and converted_at >= $1
	`, monthStart).Scan(&convertedCount); err != nil {
		return crm.DashboardStats{}, err
	}
	if err := s.db.QueryRow(ctx, `
		select count(*) from public.crm_follows where created_at >= $1
	`, sevenDaysAgo).Scan(&followCount); err != nil {
		return crm.DashboardStats{}, err
	}
	customerRows, err := s.db.Query(ctx, `
		select owner_id, count(*)
		from public.crm_customers
		where is_deleted = false and owner_id is not null
		group by owner_id
	`)
	if err != nil {
		return crm.DashboardStats{}, err
	}
	customerByOwner := map[string]int{}
	ownerSet := map[string]bool{}
	for customerRows.Next() {
		var ownerID string
		var count int
		if err := customerRows.Scan(&ownerID, &count); err != nil {
			customerRows.Close()
			return crm.DashboardStats{}, err
		}
		customerByOwner[ownerID] = count
		ownerSet[ownerID] = true
	}
	customerRows.Close()
	if err := customerRows.Err(); err != nil {
		return crm.DashboardStats{}, err
	}
	conversionRows, err := s.db.Query(ctx, `
		select owner_id, count(*)
		from public.crm_leads
		where is_deleted = false and owner_id is not null and converted_at >= $1
		group by owner_id
	`, monthStart)
	if err != nil {
		return crm.DashboardStats{}, err
	}
	convertedByOwner := map[string]int{}
	for conversionRows.Next() {
		var ownerID string
		var count int
		if err := conversionRows.Scan(&ownerID, &count); err != nil {
			conversionRows.Close()
			return crm.DashboardStats{}, err
		}
		convertedByOwner[ownerID] = count
		ownerSet[ownerID] = true
	}
	conversionRows.Close()
	if err := conversionRows.Err(); err != nil {
		return crm.DashboardStats{}, err
	}
	ownerNames, err := s.resolveCRMUserNames(ctx, ownerSet)
	if err != nil {
		return crm.DashboardStats{}, err
	}
	ownerIDs := make([]string, 0, len(ownerSet))
	for id := range ownerSet {
		ownerIDs = append(ownerIDs, id)
	}
	sort.Strings(ownerIDs)
	perOwner := make([]crm.OwnerPerformance, 0, len(ownerIDs))
	for _, ownerID := range ownerIDs {
		name := ownerNames[ownerID]
		perOwner = append(perOwner, crm.OwnerPerformance{
			OwnerID: ownerID, OwnerName: stringPointerIfNotEmpty(name),
			CustomerCount: customerByOwner[ownerID], ConvertedThisMonth: convertedByOwner[ownerID],
		})
	}
	return crm.DashboardStats{
		LeadFunnel: funnel,
		NewThisMonth: crm.NewThisMonth{
			NewCustomers: newCustomers, NewLeads: newLeads, ConvertedCount: convertedCount,
		},
		FollowActivity: crm.FollowActivity{FollowCount7D: followCount},
		PerOwner:       perOwner,
	}, nil
}

func stringPointerIfNotEmpty(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}

func (s *CRMStore) resolveCRMUserNames(ctx context.Context, ids map[string]bool) (map[string]string, error) {
	result := map[string]string{}
	if len(ids) == 0 {
		return result, nil
	}
	values := make([]string, 0, len(ids))
	for id := range ids {
		values = append(values, id)
	}
	rows, err := s.db.Query(ctx, `
		select id::text, coalesce(trim(full_name), '')
		from public.user_accounts where id::text = any($1)
	`, values)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		result[id] = name
	}
	return result, rows.Err()
}

func (s *CRMStore) funnelWhere(
	startAt, endAt *time.Time,
	ownerID, source *string,
) (string, []any) {
	where := []string{"l.is_deleted = false"}
	args := []any{}
	nextArg := 1
	if ownerID != nil {
		where = append(where, "l.owner_id = $"+strconv.Itoa(nextArg))
		args = append(args, *ownerID)
		nextArg++
	}
	if source != nil {
		where = append(where, "l.source = $"+strconv.Itoa(nextArg))
		args = append(args, *source)
		nextArg++
	}
	if startAt != nil {
		where = append(where, "l.entered_stage_at >= $"+strconv.Itoa(nextArg))
		args = append(args, *startAt)
		nextArg++
	}
	if endAt != nil {
		where = append(where, "l.entered_stage_at < $"+strconv.Itoa(nextArg))
		args = append(args, *endAt)
	}
	return strings.Join(where, " and "), args
}

func (s *CRMStore) GetFunnelMetrics(
	ctx context.Context,
	dimension string,
	startAt *time.Time,
	endAt *time.Time,
	ownerID *string,
	source *string,
) (crm.FunnelMetrics, error) {
	where, args := s.funnelWhere(startAt, endAt, ownerID, source)
	total := emptyCRMFunnel()
	totalRows, err := s.db.Query(ctx, `
		select status, count(*) from public.crm_leads l
		where `+where+` group by status`, args...)
	if err != nil {
		return crm.FunnelMetrics{}, err
	}
	for totalRows.Next() {
		var status string
		var count int
		if err := totalRows.Scan(&status, &count); err != nil {
			totalRows.Close()
			return crm.FunnelMetrics{}, err
		}
		total[status] = count
	}
	totalRows.Close()
	if err := totalRows.Err(); err != nil {
		return crm.FunnelMetrics{}, err
	}
	var groupSQL string
	switch dimension {
	case "owner":
		groupSQL = "l.owner_id::text"
	case "source":
		groupSQL = "coalesce(l.source, '')"
	case "time":
		groupSQL = "to_char(timezone('Asia/Shanghai', l.entered_stage_at), 'YYYY-MM')"
	default:
		return crm.FunnelMetrics{}, crm.NewAPIError(400, "unknown funnel dimension: "+dimension)
	}
	extraWhere := ""
	if dimension == "time" {
		extraWhere = " and l.entered_stage_at is not null"
	}
	groupRows, err := s.db.Query(ctx, `
		select `+groupSQL+` as bucket, l.status, count(*)
		from public.crm_leads l
		where `+where+extraWhere+`
		group by bucket, l.status
		order by bucket
	`, args...)
	if err != nil {
		return crm.FunnelMetrics{}, err
	}
	byKey := map[string]map[string]int{}
	for groupRows.Next() {
		var key, status string
		var count int
		if err := groupRows.Scan(&key, &status, &count); err != nil {
			groupRows.Close()
			return crm.FunnelMetrics{}, err
		}
		if byKey[key] == nil {
			byKey[key] = emptyCRMFunnel()
		}
		byKey[key][status] = count
	}
	groupRows.Close()
	if err := groupRows.Err(); err != nil {
		return crm.FunnelMetrics{}, err
	}
	items := make([]crm.FunnelDimensionItem, 0, len(byKey))
	if dimension == "owner" {
		ids := map[string]bool{}
		for key := range byKey {
			if key != "" {
				ids[key] = true
			}
		}
		names, err := s.resolveCRMUserNames(ctx, ids)
		if err != nil {
			return crm.FunnelMetrics{}, err
		}
		for _, key := range sortedStringKeys(byKey) {
			item := crm.FunnelDimensionItem{Key: key, Funnel: byKey[key]}
			if key != "" {
				item.Label = stringPointerIfNotEmpty(names[key])
			}
			items = append(items, item)
		}
	} else {
		for _, key := range sortedStringKeys(byKey) {
			label := key
			if label == "" {
				items = append(items, crm.FunnelDimensionItem{Key: key, Funnel: byKey[key]})
				continue
			}
			items = append(items, crm.FunnelDimensionItem{Key: key, Label: &label, Funnel: byKey[key]})
		}
	}
	return crm.FunnelMetrics{
		Dimension: dimension, Total: total, Items: items,
		StartAt: optionalTimestampValue(startAt), EndAt: optionalTimestampValue(endAt),
	}, nil
}

func sortedStringKeys(values map[string]map[string]int) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func (s *CRMStore) GetStageDetail(
	ctx context.Context,
	stage string,
	sortBy string,
	stuckDays int,
	startAt *time.Time,
	endAt *time.Time,
	ownerID *string,
	source *string,
	page int,
	pageSize int,
) (crm.StageDetail, error) {
	stageIndex := -1
	for index, candidate := range crmLeadStatusOrder {
		if stage == candidate {
			stageIndex = index
			break
		}
	}
	if stageIndex < 0 {
		return crm.StageDetail{}, crm.NewAPIError(400, "unknown stage: "+stage)
	}
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 50
	}
	where := []string{"l.status = $1", "l.is_deleted = false"}
	args := []any{stage}
	nextArg := 2
	if ownerID != nil {
		where = append(where, "l.owner_id = $"+strconv.Itoa(nextArg))
		args = append(args, *ownerID)
		nextArg++
	}
	if source != nil {
		where = append(where, "l.source = $"+strconv.Itoa(nextArg))
		args = append(args, *source)
		nextArg++
	}
	whereSQL := strings.Join(where, " and ")
	var total, stuckCount int
	var avgDwell *float64
	if err := s.db.QueryRow(ctx, `
		select count(*) from public.crm_leads l where `+whereSQL, args...).Scan(&total); err != nil {
		return crm.StageDetail{}, err
	}
	if err := s.db.QueryRow(ctx, `
		select avg(extract(epoch from now() - coalesce(l.entered_stage_at, l.updated_at))/86400.0)
		from public.crm_leads l where `+whereSQL, args...).Scan(&avgDwell); err != nil {
		return crm.StageDetail{}, err
	}
	if err := s.db.QueryRow(ctx, `
		select count(*) from public.crm_leads l
		where `+whereSQL+` and extract(epoch from now() - coalesce(l.entered_stage_at, l.updated_at))/86400.0 > $`+strconv.Itoa(nextArg),
		append(args, stuckDays)...).Scan(&stuckCount); err != nil {
		return crm.StageDetail{}, err
	}
	inflow := total
	var outflow *int
	if startAt != nil || endAt != nil {
		inflowWhere := whereSQL
		inflowArgs := append([]any(nil), args...)
		inflowArg := nextArg
		if startAt != nil {
			inflowWhere += " and l.entered_stage_at >= $" + strconv.Itoa(inflowArg)
			inflowArgs = append(inflowArgs, *startAt)
			inflowArg++
		}
		if endAt != nil {
			inflowWhere += " and l.entered_stage_at < $" + strconv.Itoa(inflowArg)
			inflowArgs = append(inflowArgs, *endAt)
		}
		if err := s.db.QueryRow(ctx, `
			select count(*) from public.crm_leads l where `+inflowWhere, inflowArgs...).Scan(&inflow); err != nil {
			return crm.StageDetail{}, err
		}
		later := []string{}
		for _, candidate := range crmLeadStatusOrder[stageIndex+1:] {
			if candidate != "discarded" {
				later = append(later, candidate)
			}
		}
		if len(later) > 0 {
			outWhere := []string{"l.is_deleted = false", "l.status = any($1)"}
			outArgs := []any{later}
			outNext := 2
			if ownerID != nil {
				outWhere = append(outWhere, "l.owner_id = $"+strconv.Itoa(outNext))
				outArgs = append(outArgs, *ownerID)
				outNext++
			}
			if source != nil {
				outWhere = append(outWhere, "l.source = $"+strconv.Itoa(outNext))
				outArgs = append(outArgs, *source)
				outNext++
			}
			if startAt != nil {
				outWhere = append(outWhere, "l.entered_stage_at >= $"+strconv.Itoa(outNext))
				outArgs = append(outArgs, *startAt)
				outNext++
			}
			if endAt != nil {
				outWhere = append(outWhere, "l.entered_stage_at < $"+strconv.Itoa(outNext))
				outArgs = append(outArgs, *endAt)
			}
			var count int
			if err := s.db.QueryRow(ctx, `
				select count(*) from public.crm_leads l
				where `+strings.Join(outWhere, " and "), outArgs...).Scan(&count); err != nil {
				return crm.StageDetail{}, err
			}
			outflow = &count
		} else {
			zero := 0
			outflow = &zero
		}
	}
	order := "dwell_days desc nulls last"
	if sortBy == "recent" {
		order = "last_action_at desc nulls last"
	}
	query := `
		select l.id, l.name, l.company, l.owner_id, u.full_name, l.source, l.intent,
		       l.entered_stage_at, l.next_follow_at,
		       extract(epoch from now() - coalesce(l.entered_stage_at, l.updated_at))/86400.0 as dwell_days,
		       (
		         select max(created_at) from public.crm_follows
		         where entity_type = 'lead' and entity_id = l.id
		       ) as last_action_at,
		       (
		         select content from public.crm_follows
		         where entity_type = 'lead' and entity_id = l.id
		         order by created_at desc, id desc limit 1
		       ) as last_action_content
		from public.crm_leads l
		left join public.user_accounts u on u.id::text = l.owner_id
		where ` + whereSQL + `
		order by ` + order + `, l.id asc
		limit $` + strconv.Itoa(nextArg) + ` offset $` + strconv.Itoa(nextArg+1)
	queryArgs := append([]any(nil), args...)
	queryArgs = append(queryArgs, pageSize, (page-1)*pageSize)
	rows, err := s.db.Query(ctx, query, queryArgs...)
	if err != nil {
		return crm.StageDetail{}, err
	}
	defer rows.Close()
	leads := []crm.StageLeadItem{}
	for rows.Next() {
		var (
			item              crm.StageLeadItem
			enteredStageAt    *time.Time
			nextFollowAt      *time.Time
			dwellDays         float64
			lastActionAt      *time.Time
			lastActionContent *string
		)
		if err := rows.Scan(
			&item.ID, &item.Name, &item.Company, &item.OwnerID, &item.OwnerName,
			&item.Source, &item.Intent, &enteredStageAt, &nextFollowAt,
			&dwellDays, &lastActionAt, &lastActionContent,
		); err != nil {
			return crm.StageDetail{}, err
		}
		item.EnteredStageAt = optionalTimestampValue(enteredStageAt)
		item.NextFollowAt = optionalTimestampValue(nextFollowAt)
		item.LastActionAt = optionalTimestampValue(lastActionAt)
		item.LastActionContent = lastActionContent
		rounded := mathRound1(dwellDays)
		item.DwellDays = &rounded
		item.IsStuck = dwellDays > float64(stuckDays)
		leads = append(leads, item)
	}
	if err := rows.Err(); err != nil {
		return crm.StageDetail{}, err
	}
	var avgRounded *float64
	if avgDwell != nil {
		value := mathRound1(*avgDwell)
		avgRounded = &value
	}
	return crm.StageDetail{
		Stage: stage, Count: total, AvgDwellDays: avgRounded, StuckCount: stuckCount,
		Inflow: inflow, Outflow: outflow, StuckDays: stuckDays, Leads: leads,
		Page: page, PageSize: pageSize, Total: total,
	}, nil
}

func mathRound1(value float64) float64 {
	return float64(int(value*10+0.5)) / 10
}

func (s *CRMStore) GetPerformanceBoard(
	ctx context.Context,
	scope string,
	sortBy string,
	month *string,
	userID string,
) (crm.PerformanceBoard, error) {
	location := shanghaiLocation()
	now := time.Now().In(location)
	monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, location)
	if month != nil {
		parts := strings.Split(*month, "-")
		if len(parts) != 2 {
			return crm.PerformanceBoard{}, crm.NewAPIError(400, "month 须为 YYYY-MM 格式")
		}
		year, err1 := strconv.Atoi(parts[0])
		monthNumber, err2 := strconv.Atoi(parts[1])
		if err1 != nil || err2 != nil || monthNumber < 1 || monthNumber > 12 {
			return crm.PerformanceBoard{}, crm.NewAPIError(400, "month 须为 YYYY-MM 格式")
		}
		monthStart = time.Date(year, time.Month(monthNumber), 1, 0, 0, 0, 0, location)
	}
	monthEnd := monthStart.AddDate(0, 1, 0)
	label := monthStart.Format("2006-01")
	newByOwner := map[string]int{}
	convByOwner := map[string]int{}
	followByOwner := map[string]int{}
	doneByOwner := map[string]int{}
	openByOwner := map[string]int{}
	if err := s.loadOwnerCounts(ctx, `
		select owner_id::text, count(*) from public.crm_customers
		where is_deleted = false and created_at >= $1 and created_at < $2
		  and owner_id is not null group by owner_id
	`, []any{monthStart, monthEnd}, newByOwner); err != nil {
		return crm.PerformanceBoard{}, err
	}
	if err := s.loadOwnerCounts(ctx, `
		select owner_id::text, count(*) from public.crm_leads
		where is_deleted = false and converted_at >= $1 and converted_at < $2
		  and owner_id is not null group by owner_id
	`, []any{monthStart, monthEnd}, convByOwner); err != nil {
		return crm.PerformanceBoard{}, err
	}
	if err := s.loadOwnerCounts(ctx, `
		select created_by::text, count(*) from public.crm_follows
		where created_at >= $1 and created_at < $2 and created_by is not null
		group by created_by
	`, []any{monthStart, monthEnd}, followByOwner); err != nil {
		return crm.PerformanceBoard{}, err
	}
	if err := s.loadOwnerCounts(ctx, `
		select owner_id::text, count(*) from public.crm_tasks
		where status = 'done' and completed_at >= $1 and completed_at < $2
		  and owner_id is not null group by owner_id
	`, []any{monthStart, monthEnd}, doneByOwner); err != nil {
		return crm.PerformanceBoard{}, err
	}
	if err := s.loadOwnerCounts(ctx, `
		select owner_id::text, count(*) from public.crm_tasks
		where status in ('pending', 'in_progress') and owner_id is not null
		group by owner_id
	`, nil, openByOwner); err != nil {
		return crm.PerformanceBoard{}, err
	}
	rosterRows, err := s.db.Query(ctx, `
		select id::text, coalesce(trim(full_name), '')
		from public.user_accounts where is_active = true
		order by coalesce(trim(full_name), '')
	`)
	if err != nil {
		return crm.PerformanceBoard{}, err
	}
	roster := []struct {
		ID   string
		Name string
	}{}
	for rosterRows.Next() {
		var id, name string
		if err := rosterRows.Scan(&id, &name); err != nil {
			rosterRows.Close()
			return crm.PerformanceBoard{}, err
		}
		roster = append(roster, struct {
			ID   string
			Name string
		}{id, name})
	}
	rosterRows.Close()
	if err := rosterRows.Err(); err != nil {
		return crm.PerformanceBoard{}, err
	}
	metricsFor := func(id string) crm.PerformanceMetrics {
		done := doneByOwner[id]
		open := openByOwner[id]
		var rate *float64
		if done+open > 0 {
			value := float64(done) / float64(done+open)
			value = float64(int(value*10000+0.5)) / 10000
			rate = &value
		}
		return crm.PerformanceMetrics{
			NewCustomers: newByOwner[id], ConvertedCount: convByOwner[id],
			FollowCount: followByOwner[id], CompletionRate: rate,
		}
	}
	ranking := make([]crm.PerformanceRankItem, 0, len(roster))
	for _, user := range roster {
		metrics := metricsFor(user.ID)
		ranking = append(ranking, crm.PerformanceRankItem{
			OwnerID: user.ID, OwnerName: stringPointerIfNotEmpty(user.Name),
			NewCustomers: metrics.NewCustomers, ConvertedCount: metrics.ConvertedCount,
			FollowCount: metrics.FollowCount, CompletionRate: metrics.CompletionRate,
		})
	}
	sort.Slice(ranking, func(i, j int) bool {
		left := performanceSortValue(ranking[i], sortBy)
		right := performanceSortValue(ranking[j], sortBy)
		if left != right {
			if left == nil {
				return false
			}
			if right == nil {
				return true
			}
			return *left > *right
		}
		if ranking[i].ConvertedCount != ranking[j].ConvertedCount {
			return ranking[i].ConvertedCount > ranking[j].ConvertedCount
		}
		if ranking[i].NewCustomers != ranking[j].NewCustomers {
			return ranking[i].NewCustomers > ranking[j].NewCustomers
		}
		if ranking[i].FollowCount != ranking[j].FollowCount {
			return ranking[i].FollowCount > ranking[j].FollowCount
		}
		return pointerValueOrder(ranking[i].OwnerName, ranking[i].OwnerID) <
			pointerValueOrder(ranking[j].OwnerName, ranking[j].OwnerID)
	})
	mine := metricsFor(strings.TrimSpace(userID))
	var myRank *int
	for index := range ranking {
		ranking[index].Rank = index + 1
		if ranking[index].OwnerID == strings.TrimSpace(userID) {
			value := ranking[index].Rank
			myRank = &value
			break
		}
	}
	board := crm.PerformanceBoard{
		Scope: scope, Month: label, Mine: mine, MyRank: myRank,
		TotalUsers: len(roster), Ranking: []crm.PerformanceRankItem{},
	}
	if scope == "mine" {
		return board, nil
	}
	var globalDone, globalOpen, globalNew, globalConv, globalFollow int
	if err := s.db.QueryRow(ctx, `
		select count(*) from public.crm_tasks
		where status = 'done' and completed_at >= $1 and completed_at < $2
	`, monthStart, monthEnd).Scan(&globalDone); err != nil {
		return crm.PerformanceBoard{}, err
	}
	if err := s.db.QueryRow(ctx, `
		select count(*) from public.crm_tasks where status in ('pending', 'in_progress')
	`).Scan(&globalOpen); err != nil {
		return crm.PerformanceBoard{}, err
	}
	if err := s.db.QueryRow(ctx, `
		select count(*) from public.crm_customers
		where is_deleted = false and created_at >= $1 and created_at < $2
	`, monthStart, monthEnd).Scan(&globalNew); err != nil {
		return crm.PerformanceBoard{}, err
	}
	if err := s.db.QueryRow(ctx, `
		select count(*) from public.crm_leads
		where is_deleted = false and converted_at >= $1 and converted_at < $2
	`, monthStart, monthEnd).Scan(&globalConv); err != nil {
		return crm.PerformanceBoard{}, err
	}
	if err := s.db.QueryRow(ctx, `
		select count(*) from public.crm_follows
		where created_at >= $1 and created_at < $2
	`, monthStart, monthEnd).Scan(&globalFollow); err != nil {
		return crm.PerformanceBoard{}, err
	}
	var globalRate *float64
	if globalDone+globalOpen > 0 {
		value := float64(globalDone) / float64(globalDone+globalOpen)
		value = float64(int(value*10000+0.5)) / 10000
		globalRate = &value
	}
	global := crm.PerformanceMetrics{
		NewCustomers: globalNew, ConvertedCount: globalConv,
		FollowCount: globalFollow, CompletionRate: globalRate,
	}
	board.GlobalMetrics = &global
	board.Ranking = ranking
	return board, nil
}

func (s *CRMStore) loadOwnerCounts(
	ctx context.Context,
	query string,
	args []any,
	target map[string]int,
) error {
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var ownerID string
		var count int
		if err := rows.Scan(&ownerID, &count); err != nil {
			return err
		}
		target[ownerID] = count
	}
	return rows.Err()
}

func performanceSortValue(item crm.PerformanceRankItem, sortBy string) *float64 {
	var value int
	switch sortBy {
	case "new_customers":
		value = item.NewCustomers
	case "follow_count":
		value = item.FollowCount
	case "completion_rate":
		return item.CompletionRate
	default:
		value = item.ConvertedCount
	}
	converted := float64(value)
	return &converted
}

func pointerValueOrder(name *string, fallback string) string {
	if name == nil {
		return fallback
	}
	return *name
}

func (s *CRMStore) GetLifecycleBoard(ctx context.Context) (crm.LifecycleBoard, error) {
	firstRows, err := s.db.Query(ctx, `
		select extract(epoch from (
			min(f.created_at) - c.created_at
		))/86400.0
		from public.crm_customers c
		join public.crm_follows f
		  on f.entity_type = 'customer' and f.entity_id = c.id
		where c.is_deleted = false
		group by c.id, c.created_at
	`)
	if err != nil {
		return crm.LifecycleBoard{}, err
	}
	firstDurations := []float64{}
	for firstRows.Next() {
		var duration float64
		if err := firstRows.Scan(&duration); err != nil {
			firstRows.Close()
			return crm.LifecycleBoard{}, err
		}
		if duration < 0 {
			duration = 0
		}
		firstDurations = append(firstDurations, duration)
	}
	firstRows.Close()
	if err := firstRows.Err(); err != nil {
		return crm.LifecycleBoard{}, err
	}
	var totalCustomers int
	if err := s.db.QueryRow(ctx, `
		select count(*) from public.crm_customers where is_deleted = false
	`).Scan(&totalCustomers); err != nil {
		return crm.LifecycleBoard{}, err
	}
	conversionRows, err := s.db.Query(ctx, `
		select greatest(0, extract(epoch from (converted_at - created_at))/86400.0)
		from public.crm_leads
		where is_deleted = false and converted_at is not null
	`)
	if err != nil {
		return crm.LifecycleBoard{}, err
	}
	conversionDurations := []float64{}
	for conversionRows.Next() {
		var duration float64
		if err := conversionRows.Scan(&duration); err != nil {
			conversionRows.Close()
			return crm.LifecycleBoard{}, err
		}
		conversionDurations = append(conversionDurations, duration)
	}
	conversionRows.Close()
	if err := conversionRows.Err(); err != nil {
		return crm.LifecycleBoard{}, err
	}
	var totalLeads int
	if err := s.db.QueryRow(ctx, `
		select count(*) from public.crm_leads where is_deleted = false
	`).Scan(&totalLeads); err != nil {
		return crm.LifecycleBoard{}, err
	}
	churnRows, err := s.db.Query(ctx, `
		select greatest(0, extract(epoch from (min(event_at) - c.created_at))/86400.0)
		from public.crm_customers c
		join (
			select entity_id, created_at as event_at
			from public.crm_audit_logs
			where entity_type = 'customer' and action = 'move_sea'
			union all
			select entity_id, created_at
			from public.crm_follows
			where entity_type = 'customer' and created_by is null
			  and content like '%回收至公海%'
		) e on e.entity_id = c.id
		where c.is_deleted = false
		group by c.id, c.created_at
	`)
	if err != nil {
		return crm.LifecycleBoard{}, err
	}
	churnDurations := []float64{}
	for churnRows.Next() {
		var duration float64
		if err := churnRows.Scan(&duration); err != nil {
			churnRows.Close()
			return crm.LifecycleBoard{}, err
		}
		churnDurations = append(churnDurations, duration)
	}
	churnRows.Close()
	if err := churnRows.Err(); err != nil {
		return crm.LifecycleBoard{}, err
	}
	var nowInSea int
	if err := s.db.QueryRow(ctx, `
		select count(*) from public.crm_customers
		where is_deleted = false and owner_id is null
	`).Scan(&nowInSea); err != nil {
		return crm.LifecycleBoard{}, err
	}
	return crm.LifecycleBoard{
		FirstFollow: crmLifecycleDistribution("first_follow", "首次跟进", "客户创建 → 第一条跟进记录", firstDurations, totalCustomers),
		Conversion:  crmLifecycleDistribution("conversion", "转化", "线索创建 → 转化完成（线索转客户）", conversionDurations, totalLeads),
		Churn:       crmLifecycleDistribution("churn", "流失", "客户创建 → 首次回公海", churnDurations, totalCustomers),
		NowInSea:    nowInSea,
	}, nil
}

var crmLifecycleEdges = []float64{1, 3, 7, 14, 30}
var crmLifecycleLabels = []string{"1 天内", "1-3 天", "3-7 天", "7-14 天", "14-30 天", "30 天以上"}

func crmLifecycleDistribution(
	metric, label, description string,
	durations []float64,
	total int,
) crm.LifecycleDistribution {
	counts := make([]int, len(crmLifecycleEdges)+1)
	for _, duration := range durations {
		index := len(crmLifecycleEdges)
		for boundary, edge := range crmLifecycleEdges {
			if duration < edge {
				index = boundary
				break
			}
		}
		counts[index]++
	}
	buckets := make([]crm.LifecycleBucket, 0, len(counts))
	sampleSize := len(durations)
	if sampleSize == 0 {
		sampleSize = 1
	}
	cumulative := 0
	for index, count := range counts {
		cumulative += count
		bucket := crm.LifecycleBucket{
			Label: crmLifecycleLabels[index], Count: count,
			Pct:           float64(int(float64(count)/float64(sampleSize)*10000+0.5)) / 10000,
			CumulativePct: float64(int(float64(cumulative)/float64(sampleSize)*10000+0.5)) / 10000,
		}
		if index > 0 {
			bucket.MinDays = crmLifecycleEdges[index-1]
		}
		if index < len(crmLifecycleEdges) {
			max := crmLifecycleEdges[index]
			bucket.MaxDays = &max
		}
		buckets = append(buckets, bucket)
	}
	summary := crm.LifecycleSummary{SampleCount: len(durations), TotalCount: total}
	if len(durations) > 0 {
		ordered := append([]float64(nil), durations...)
		sort.Float64s(ordered)
		n := len(ordered)
		avg := mathRound1(sumFloat(ordered) / float64(n))
		median := ordered[n/2]
		if n%2 == 0 {
			median = (ordered[n/2-1] + ordered[n/2]) / 2
		}
		median = mathRound1(median)
		p90Index := int(float64(n) * 0.9)
		if p90Index >= n {
			p90Index = n - 1
		}
		p90 := mathRound1(ordered[p90Index])
		max := mathRound1(ordered[n-1])
		summary.AvgDays = &avg
		summary.MedianDays = &median
		summary.P90Days = &p90
		summary.MaxDays = &max
	}
	return crm.LifecycleDistribution{
		Metric: metric, Label: label, Description: description,
		Buckets: buckets, Summary: summary,
	}
}

func sumFloat(values []float64) float64 {
	total := 0.0
	for _, value := range values {
		total += value
	}
	return total
}

var _ crm.Store = (*CRMStore)(nil)
