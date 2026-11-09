package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_inspection"
)

const agentInspectionIdentitySource = "amazon_seller_central_account_switcher"

type agentInspectionIdentityConfig struct {
	required bool
	expected string
	aliases  []string
}

func (s *AgentInspectionStore) ValidateComplaintBatch(
	ctx context.Context,
	input agent_inspection.ComplaintBatchInput,
) error {
	return s.validateComplaintBatch(ctx, input)
}

func (s *AgentInspectionStore) validateComplaintBatch(
	ctx context.Context,
	input agent_inspection.ComplaintBatchInput,
) error {
	projectIDs := agentInspectionComplaintProjectIDs(input)
	if len(projectIDs) > 0 {
		rows, err := s.db.Query(
			ctx,
			`select id from public.projects where id = any($1::bigint[])`,
			projectIDs,
		)
		if err != nil {
			return err
		}
		defer rows.Close()
		existing := make(map[int64]bool)
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				return err
			}
			existing[id] = true
		}
		if err := rows.Err(); err != nil {
			return err
		}
		for _, id := range projectIDs {
			if !existing[id] {
				return agent_inspection.ErrProjectNotFound
			}
		}
	}

	seen := make(map[string]bool)
	writable := make(map[string]bool)
	for _, check := range input.ShopChecks {
		key := agentInspectionShopKey(check.ProjectID, check.Country)
		if seen[key] {
			return &agent_inspection.ValidationError{
				Code: "VALIDATION_FAILED",
				Detail: fmt.Sprintf(
					"shop_checks 重复：project_id=%d country=%s 每批次最多一条",
					check.ProjectID, check.Country,
				),
			}
		}
		seen[key] = true
		config, err := s.complaintIdentityConfig(ctx, check.ProjectID, check.Country)
		if err != nil {
			return err
		}
		isWritable, err := validateComplaintIdentity(check, config)
		if err != nil {
			return err
		}
		writable[key] = isWritable
	}
	for _, complaint := range input.Complaints {
		key := agentInspectionShopKey(complaint.ProjectID, complaint.Country)
		if !writable[key] {
			return &agent_inspection.ValidationError{
				Code: "IDENTITY_CHECK_REQUIRED",
				Detail: fmt.Sprintf(
					"project_id=%d country=%s 没有 ok 且身份已核验的 shop_check，禁止写入客诉",
					complaint.ProjectID, complaint.Country,
				),
			}
		}
	}
	return nil
}

func (s *AgentInspectionStore) complaintIdentityConfig(
	ctx context.Context,
	projectID int64,
	country string,
) (*agentInspectionIdentityConfig, error) {
	var (
		required bool
		expected *string
		aliases  string
	)
	err := s.db.QueryRow(
		ctx,
		`select seller_identity_required,
		        seller_identity_expected_alias,
		        seller_identity_aliases::text
		 from public.project_shops
		 where project_id = $1 and upper(country) = upper($2)
		 limit 1`,
		projectID,
		country,
	).Scan(&required, &expected, &aliases)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	config := &agentInspectionIdentityConfig{required: required}
	if expected != nil {
		config.expected = strings.TrimSpace(*expected)
	}
	if aliases != "" {
		if err := json.Unmarshal([]byte(aliases), &config.aliases); err != nil {
			return nil, fmt.Errorf("decode seller_identity_aliases: %w", err)
		}
	}
	return config, nil
}

func validateComplaintIdentity(
	check agent_inspection.ShopCheckInput,
	config *agentInspectionIdentityConfig,
) (bool, error) {
	required := config != nil && config.required
	configExpected := ""
	var configAliases []string
	if config != nil {
		configExpected = config.expected
		configAliases = config.aliases
	}
	if required && configExpected == "" {
		return false, identityValidationError(
			"IDENTITY_EXPECTED_ALIAS_MISSING",
			fmt.Sprintf("project_id=%d country=%s 要求身份核验但缺少 expected_alias",
				check.ProjectID, check.Country),
		)
	}
	identity := check.IdentityCheck
	if identity == nil {
		if check.CheckStatus == "ok" && required {
			return false, identityValidationError(
				"IDENTITY_CHECK_REQUIRED",
				fmt.Sprintf("project_id=%d country=%s 缺少 identity_check，禁止写入客诉",
					check.ProjectID, check.Country),
			)
		}
		return check.CheckStatus == "ok", nil
	}
	expected := ""
	if identity.ExpectedAlias != nil {
		expected = strings.TrimSpace(*identity.ExpectedAlias)
	}
	if expected == "" {
		return false, identityValidationError(
			"IDENTITY_EXPECTED_ALIAS_MISSING",
			"identity_check.expected_alias 不能为空",
		)
	}
	if configExpected != "" && expected != configExpected {
		return false, identityValidationError(
			"IDENTITY_CHECK_INVALID",
			fmt.Sprintf("project_id=%d country=%s 的 expected_alias 与后端期望不一致",
				check.ProjectID, check.Country),
		)
	}
	if identity.Source != agentInspectionIdentitySource {
		return false, identityValidationError(
			"IDENTITY_CHECK_INVALID",
			"identity_check.source 非法",
		)
	}
	recomputed := false
	if identity.ObservedAlias != nil {
		allowed := map[string]bool{expected: true}
		for _, alias := range configAliases {
			allowed[alias] = true
		}
		aliasOK := allowed[*identity.ObservedAlias]
		countryOK := false
		for _, observed := range identity.ObservedCountry {
			if observed == check.Country {
				countryOK = true
				break
			}
		}
		recomputed = aliasOK && countryOK
	}
	if identity.Verified && !recomputed {
		return false, identityValidationError(
			"IDENTITY_CHECK_INVALID",
			fmt.Sprintf("project_id=%d country=%s 声明 verified=true 但页面观测不匹配",
				check.ProjectID, check.Country),
		)
	}
	if check.CheckStatus == "ok" && !identity.Verified {
		return false, identityValidationError(
			"IDENTITY_CHECK_REQUIRED",
			fmt.Sprintf("project_id=%d country=%s 身份核验未通过，禁止写入客诉",
				check.ProjectID, check.Country),
		)
	}
	if check.CheckStatus == "identity_mismatch" && identity.Verified {
		return false, identityValidationError(
			"IDENTITY_CHECK_CONTRADICTION",
			fmt.Sprintf("project_id=%d country=%s 自称 identity_mismatch 却声明 verified=true",
				check.ProjectID, check.Country),
		)
	}
	return check.CheckStatus == "ok" && identity.Verified, nil
}

func identityValidationError(code, detail string) error {
	return &agent_inspection.ValidationError{Code: code, Detail: detail}
}

func (s *AgentInspectionStore) UpsertComplaintBatch(
	ctx context.Context,
	input agent_inspection.ComplaintBatchInput,
	agentID string,
) (agent_inspection.ComplaintBatchResult, error) {
	if err := s.validateComplaintBatch(ctx, input); err != nil {
		return agent_inspection.ComplaintBatchResult{}, err
	}
	shopsFailedJSON, err := agentInspectionJSONString(input.ShopsFailed)
	if err != nil {
		return agent_inspection.ComplaintBatchResult{}, err
	}
	summaryJSON, err := agentInspectionJSONString(input.Summary)
	if err != nil {
		return agent_inspection.ComplaintBatchResult{}, err
	}
	var (
		runID   int64
		runDate string
	)
	err = s.db.QueryRow(
		ctx,
		`insert into public.complaint_runs (
		   run_date, trigger, shops_total, shops_checked,
		   shops_failed, summary, agent_id, created_at, updated_at
		 )
		 values ($1::date, $2, $3, $4, $5::json, $6::json, $7, now(), now())
		 on conflict (run_date) do update
		 set trigger = excluded.trigger,
		     shops_total = excluded.shops_total,
		     shops_checked = excluded.shops_checked,
		     shops_failed = excluded.shops_failed,
		     summary = excluded.summary,
		     agent_id = excluded.agent_id,
		     updated_at = now()
		 returning id, run_date::text`,
		input.RunDate,
		input.Trigger,
		input.ShopsTotal,
		input.ShopsChecked,
		shopsFailedJSON,
		summaryJSON,
		nilIfEmpty(agentID),
	).Scan(&runID, &runDate)
	if err != nil {
		return agent_inspection.ComplaintBatchResult{}, fmt.Errorf("upsert complaint run: %w", err)
	}

	result := agent_inspection.ComplaintBatchResult{
		RunID:      runID,
		RunDate:    runDate,
		ShopChecks: []agent_inspection.ShopCheckResult{},
		Complaints: []agent_inspection.ComplaintResult{},
	}
	shopKeys := make(map[string]bool)
	for _, check := range input.ShopChecks {
		metricsJSON, err := agentInspectionJSONString(check.Metrics)
		if err != nil {
			return result, err
		}
		identity := agentInspectionIdentityDump(check.IdentityCheck)
		observedCountryJSON, err := agentInspectionJSONString(identity.observedCountry)
		if err != nil {
			return result, err
		}
		var shopCheckID int64
		err = s.db.QueryRow(
			ctx,
			`insert into public.shop_checks (
			   run_id, project_id, country, check_status, error_message,
			   metrics, identity_expected_alias, identity_observed_alias,
			   identity_observed_country, identity_verified, identity_source,
			   created_at, updated_at
			 )
			 values (
			   $1, $2, $3, $4, $5, $6::json,
			   $7, $8, $9::json, $10, $11, now(), now()
			 )
			 on conflict (run_id, project_id, country) do update
			 set check_status = excluded.check_status,
			     error_message = excluded.error_message,
			     metrics = excluded.metrics,
			     identity_expected_alias = excluded.identity_expected_alias,
			     identity_observed_alias = excluded.identity_observed_alias,
			     identity_observed_country = excluded.identity_observed_country,
			     identity_verified = excluded.identity_verified,
			     identity_source = excluded.identity_source,
			     updated_at = now()
			 returning id`,
			runID,
			check.ProjectID,
			check.Country,
			check.CheckStatus,
			check.ErrorMessage,
			metricsJSON,
			identity.expectedAlias,
			identity.observedAlias,
			observedCountryJSON,
			identity.verified,
			identity.source,
		).Scan(&shopCheckID)
		if err != nil {
			return result, fmt.Errorf("upsert shop check: %w", err)
		}
		key := agentInspectionShopKey(check.ProjectID, check.Country)
		if !shopKeys[key] {
			shopKeys[key] = true
			result.ShopChecks = append(result.ShopChecks, agent_inspection.ShopCheckResult{
				ShopCheckID: shopCheckID,
				ProjectID:   check.ProjectID,
				Country:     check.Country,
			})
		}
	}

	complaintKeys := make(map[string]bool)
	for _, complaint := range input.Complaints {
		item, err := s.upsertComplaintConversation(ctx, runID, complaint)
		if err != nil {
			return result, err
		}
		key := agentInspectionComplaintKey(
			complaint.ProjectID,
			complaint.Country,
			complaint.BuyerName,
			complaint.FirstMessageDate,
		)
		if !complaintKeys[key] {
			complaintKeys[key] = true
			result.Complaints = append(result.Complaints, item)
		}
	}
	return result, nil
}

func (s *AgentInspectionStore) upsertComplaintConversation(
	ctx context.Context,
	runID int64,
	complaint agent_inspection.ComplaintInput,
) (agent_inspection.ComplaintResult, error) {
	incoming := agentInspectionIncomingMessage(complaint)
	incomingJSON, err := agentInspectionJSONString(incoming)
	if err != nil {
		return agent_inspection.ComplaintResult{}, err
	}
	var (
		complaintID        int64
		currentMessageDate string
		currentSubject     string
		currentBody        string
		currentTriageText  string
		currentHasOrder    bool
		currentOrderText   *string
		currentSLAText     *string
		currentMessages    string
	)
	err = s.db.QueryRow(
		ctx,
		`select id, message_date::text, subject, message_body,
		        triage::text, has_order, order_info::text,
		        sla::text, messages::text
		 from public.complaints
		 where project_id = $1
		   and upper(country) = upper($2)
		   and buyer_name = $3
		   and first_message_date = $4::date
		 for update`,
		complaint.ProjectID,
		complaint.Country,
		complaint.BuyerName,
		complaint.FirstMessageDate,
	).Scan(
		&complaintID,
		&currentMessageDate,
		&currentSubject,
		&currentBody,
		&currentTriageText,
		&currentHasOrder,
		&currentOrderText,
		&currentSLAText,
		&currentMessages,
	)
	if err == pgx.ErrNoRows {
		triageJSON, err := agentInspectionJSONString(agentInspectionTriageMap(complaint.Triage))
		if err != nil {
			return agent_inspection.ComplaintResult{}, err
		}
		orderJSON, err := agentInspectionJSONString(complaint.Order)
		if err != nil {
			return agent_inspection.ComplaintResult{}, err
		}
		slaJSON, err := agentInspectionJSONString(complaint.SLA)
		if err != nil {
			return agent_inspection.ComplaintResult{}, err
		}
		var messageDate, firstDate string
		err = s.db.QueryRow(
			ctx,
			`insert into public.complaints (
			   run_id, project_id, country, buyer_name, message_date,
			   subject, message_body, triage, category, has_order,
			   order_info, sla, status, status_history, first_message_date,
			   message_count, messages, created_at, updated_at
			 )
			 values (
			   $1, $2, $3, $4, $5::date, $6, $7, $8::json,
			   $9, $10, $11::json, $12::json, 'pending', '[]'::json,
			   $13::date, $14, $15::json, now(), now()
			 )
			 returning id, message_date::text, first_message_date::text`,
			runID,
			complaint.ProjectID,
			complaint.Country,
			complaint.BuyerName,
			complaint.MessageDate,
			complaint.Subject,
			complaint.MessageBody,
			triageJSON,
			complaint.Triage.Category,
			complaint.Triage.HasOrder,
			orderJSON,
			slaJSON,
			complaint.FirstMessageDate,
			complaint.MessageCount,
			incomingJSON,
		).Scan(&complaintID, &messageDate, &firstDate)
		if err != nil {
			return agent_inspection.ComplaintResult{}, fmt.Errorf("insert complaint: %w", err)
		}
		return agent_inspection.ComplaintResult{
			ComplaintID:      complaintID,
			ProjectID:        complaint.ProjectID,
			Country:          complaint.Country,
			BuyerName:        complaint.BuyerName,
			FirstMessageDate: firstDate,
			MessageDate:      messageDate,
		}, nil
	}
	if err != nil {
		return agent_inspection.ComplaintResult{}, err
	}

	latest := complaint.MessageDate >= currentMessageDate
	messageDate := currentMessageDate
	if complaint.MessageDate > currentMessageDate {
		messageDate = complaint.MessageDate
	}
	subject := currentSubject
	messageBody := currentBody
	category := complaint.Triage.Category
	hasOrder := currentHasOrder
	currentTriage := map[string]any{}
	if currentTriageText != "" {
		_ = json.Unmarshal([]byte(currentTriageText), &currentTriage)
	}
	triage := agentInspectionTriageMap(complaint.Triage)
	if !latest {
		triage = currentTriage
		if value, ok := currentTriage["category"].(string); ok {
			category = value
		}
	} else {
		subject = complaint.Subject
		messageBody = complaint.MessageBody
		hasOrder = complaint.Triage.HasOrder
	}
	currentOrder := map[string]any{}
	if currentOrderText != nil && *currentOrderText != "" {
		_ = json.Unmarshal([]byte(*currentOrderText), &currentOrder)
	}
	currentSLA := map[string]any{}
	if currentSLAText != nil && *currentSLAText != "" {
		_ = json.Unmarshal([]byte(*currentSLAText), &currentSLA)
	}
	orderValue := any(currentOrder)
	if len(currentOrder) == 0 {
		orderValue = nil
	}
	if complaint.Order != nil && (latest || !currentHasOrder) {
		orderValue = complaint.Order
		hasOrder = complaint.Triage.HasOrder || currentHasOrder
	}
	slaValue := any(currentSLA)
	if len(currentSLA) == 0 {
		slaValue = nil
	}
	if complaint.SLA != nil && (latest || currentSLAText == nil) {
		slaValue = complaint.SLA
	}
	var messages []any
	if currentMessages != "" {
		_ = json.Unmarshal([]byte(currentMessages), &messages)
	}
	if messages == nil {
		messages = []any{}
	}
	replaced := false
	for index, stored := range messages {
		object, ok := stored.(map[string]any)
		if ok && agentInspectionMessageIdentity(object) == agentInspectionMessageIdentity(incoming) {
			messages[index] = incoming
			replaced = true
			break
		}
	}
	if !replaced {
		messages = append(messages, incoming)
	}
	messagesJSON, err := agentInspectionJSONString(messages)
	if err != nil {
		return agent_inspection.ComplaintResult{}, err
	}
	triageJSON, err := agentInspectionJSONString(triage)
	if err != nil {
		return agent_inspection.ComplaintResult{}, err
	}
	orderJSON, err := agentInspectionJSONString(orderValue)
	if err != nil {
		return agent_inspection.ComplaintResult{}, err
	}
	slaJSON, err := agentInspectionJSONString(slaValue)
	if err != nil {
		return agent_inspection.ComplaintResult{}, err
	}
	var firstDate string
	err = s.db.QueryRow(
		ctx,
		`update public.complaints
		 set run_id = $1,
		     message_date = $2::date,
		     subject = $3,
		     message_body = $4,
		     triage = $5::json,
		     category = $6,
		     has_order = $7,
		     order_info = $8::json,
		     sla = $9::json,
		     messages = $10::json,
		     message_count = $11,
		     updated_at = now()
		 where id = $12
		 returning message_date::text, first_message_date::text`,
		runID,
		messageDate,
		subject,
		messageBody,
		triageJSON,
		category,
		hasOrder,
		orderJSON,
		slaJSON,
		messagesJSON,
		len(messages),
		complaintID,
	).Scan(&messageDate, &firstDate)
	if err != nil {
		return agent_inspection.ComplaintResult{}, fmt.Errorf("update complaint: %w", err)
	}
	return agent_inspection.ComplaintResult{
		ComplaintID:      complaintID,
		ProjectID:        complaint.ProjectID,
		Country:          complaint.Country,
		BuyerName:        complaint.BuyerName,
		FirstMessageDate: firstDate,
		MessageDate:      messageDate,
	}, nil
}

type agentInspectionIdentityDumpValue struct {
	expectedAlias   *string
	observedAlias   *string
	observedCountry []string
	verified        *bool
	source          *string
}

func agentInspectionIdentityDump(identity *agent_inspection.IdentityCheck) agentInspectionIdentityDumpValue {
	if identity == nil {
		return agentInspectionIdentityDumpValue{observedCountry: []string{}}
	}
	verified := identity.Verified
	source := identity.Source
	return agentInspectionIdentityDumpValue{
		expectedAlias:   identity.ExpectedAlias,
		observedAlias:   identity.ObservedAlias,
		observedCountry: append([]string(nil), identity.ObservedCountry...),
		verified:        &verified,
		source:          &source,
	}
}

func agentInspectionIncomingMessage(complaint agent_inspection.ComplaintInput) map[string]any {
	return map[string]any{
		"project_id":         complaint.ProjectID,
		"country":            complaint.Country,
		"first_message_date": complaint.FirstMessageDate,
		"message_date":       complaint.MessageDate,
		"buyer_name":         complaint.BuyerName,
		"subject":            complaint.Subject,
		"message_body":       complaint.MessageBody,
		"triage":             agentInspectionTriageMap(complaint.Triage),
		"order":              complaint.Order,
		"sla":                complaint.SLA,
		"message_count":      complaint.MessageCount,
	}
}

func agentInspectionTriageMap(triage agent_inspection.Triage) map[string]any {
	return map[string]any{
		"category":   triage.Category,
		"has_order":  triage.HasOrder,
		"summary_zh": triage.SummaryZH,
	}
}

func agentInspectionMessageIdentity(message map[string]any) string {
	return fmt.Sprintf(
		"%v|%v|%v",
		message["message_date"],
		message["subject"],
		message["message_body"],
	)
}

func agentInspectionJSONString(value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return string(encoded), nil
}

func agentInspectionComplaintProjectIDs(input agent_inspection.ComplaintBatchInput) []int64 {
	seen := make(map[int64]bool)
	ids := make([]int64, 0, len(input.ShopChecks)+len(input.Complaints))
	for _, check := range input.ShopChecks {
		if !seen[check.ProjectID] {
			seen[check.ProjectID] = true
			ids = append(ids, check.ProjectID)
		}
	}
	for _, complaint := range input.Complaints {
		if !seen[complaint.ProjectID] {
			seen[complaint.ProjectID] = true
			ids = append(ids, complaint.ProjectID)
		}
	}
	return ids
}

func agentInspectionShopKey(projectID int64, country string) string {
	return fmt.Sprintf("%d|%s", projectID, country)
}

func agentInspectionComplaintKey(
	projectID int64,
	country string,
	buyerName string,
	firstMessageDate string,
) string {
	return fmt.Sprintf("%d|%s|%s|%s", projectID, country, buyerName, firstMessageDate)
}

func nilIfEmpty(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}
