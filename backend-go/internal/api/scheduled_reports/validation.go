package scheduled_reports

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
)

const maxRequestBodyBytes = 1 << 20

func decodeJSONBody(w http.ResponseWriter, r *http.Request, destination any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBodyBytes))
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("trailing JSON value")
		}
		return err
	}
	return nil
}

func normalizeEmail(value string) (*string, error) {
	normalized := strings.TrimSpace(value)
	if normalized == "" {
		return nil, nil
	}
	if len([]rune(normalized)) > 256 {
		return nil, errors.New("email 长度不能超过 256")
	}
	if !strings.Contains(normalized, "@") || strings.Count(normalized, "@") != 1 {
		return nil, errors.New("邮箱格式无效（需包含且仅包含一个 @）")
	}
	local, domain, _ := strings.Cut(normalized, "@")
	if local == "" || domain == "" || !strings.Contains(domain, ".") {
		return nil, errors.New("邮箱格式无效（用户名或域名不完整）")
	}
	return &normalized, nil
}

func normalizeRequiredEmail(value string) (string, error) {
	email, err := normalizeEmail(value)
	if err != nil {
		return "", err
	}
	if email == nil {
		return "", errors.New("email is required")
	}
	return *email, nil
}

func normalizeProjectIDs(value string) (string, []int64, error) {
	value = strings.TrimSpace(value)
	if len([]rune(value)) > 500 {
		return "", nil, errors.New("project_ids 长度不能超过 500")
	}
	if value == "" || value == "*" {
		return "*", nil, nil
	}
	parts := strings.Split(value, ",")
	seen := make(map[int64]struct{}, len(parts))
	ids := make([]int64, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		id, err := strconv.ParseInt(part, 10, 64)
		if err != nil || id <= 0 {
			return "", nil, fmt.Errorf("project_ids 必须是 '*' 或逗号分隔的正整数 ID")
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return "*", nil, nil
	}
	if len(ids) > MaxProjectIDs {
		return "", nil, fmt.Errorf("project_ids 一次最多选择 %d 个项目", MaxProjectIDs)
	}
	canonicalParts := make([]string, 0, len(ids))
	for _, id := range ids {
		canonicalParts = append(canonicalParts, strconv.FormatInt(id, 10))
	}
	return strings.Join(canonicalParts, ","), ids, nil
}

func normalizedCountry(value string) (string, error) {
	if len([]rune(value)) > 256 {
		return "", errors.New("country 长度不能超过 256")
	}
	parts := strings.Split(value, ",")
	normalized := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.ToUpper(strings.TrimSpace(part))
		if part == "" {
			continue
		}
		normalized = append(normalized, part)
	}
	if len(normalized) == 0 {
		return "US", nil
	}
	return strings.Join(normalized, ","), nil
}

func validateFrequency(value string) error {
	switch value {
	case FrequencyDaily, FrequencyWeekly, FrequencyMonthly:
		return nil
	default:
		return errors.New("frequency 必须为 daily/weekly/monthly")
	}
}

func validateDispatchFields(
	frequency string,
	dispatchHour int,
	dispatchMinute int,
	dispatchWeekday *int,
	dispatchDay *int,
) error {
	if dispatchHour < 0 || dispatchHour > 23 {
		return errors.New("dispatch_hour must be between 0 and 23")
	}
	if dispatchMinute < 0 || dispatchMinute > 59 {
		return errors.New("dispatch_minute must be between 0 and 59")
	}
	if dispatchWeekday != nil && (*dispatchWeekday < 0 || *dispatchWeekday > 6) {
		return errors.New("dispatch_weekday must be between 0 and 6")
	}
	if dispatchDay != nil && (*dispatchDay < 2 || *dispatchDay > 28) {
		return errors.New("dispatch_day must be between 2 and 28")
	}
	if frequency == FrequencyWeekly {
		weekday := 0
		if dispatchWeekday != nil {
			weekday = *dispatchWeekday
		}
		if weekday == 0 && dispatchHour < 16 {
			return errors.New("周报最早可在周一 16:00 发送")
		}
	}
	return nil
}

func normalizeCreateRequest(request SubscriptionCreateRequest) (SubscriptionCreateInput, error) {
	if err := validateFrequency(request.Frequency); err != nil {
		return SubscriptionCreateInput{}, err
	}
	var email *string
	if request.Email != nil {
		normalized, err := normalizeEmail(*request.Email)
		if err != nil {
			return SubscriptionCreateInput{}, err
		}
		email = normalized
	}
	projectIDs, _, err := normalizeProjectIDs(request.ProjectIDs)
	if err != nil {
		return SubscriptionCreateInput{}, err
	}
	country, err := normalizedCountry(request.Country)
	if err != nil {
		return SubscriptionCreateInput{}, err
	}
	weekday := request.DispatchWeekday
	day := request.DispatchDay
	if request.Frequency == FrequencyWeekly && weekday == nil {
		defaultWeekday := 0
		weekday = &defaultWeekday
	}
	if request.Frequency == FrequencyMonthly && day == nil {
		defaultDay := 2
		day = &defaultDay
	}
	dispatchHour := 15
	if request.DispatchHour != nil {
		dispatchHour = *request.DispatchHour
	}
	dispatchMinute := 0
	if request.DispatchMinute != nil {
		dispatchMinute = *request.DispatchMinute
	}
	if err := validateDispatchFields(
		request.Frequency,
		dispatchHour,
		dispatchMinute,
		weekday,
		day,
	); err != nil {
		return SubscriptionCreateInput{}, err
	}
	aiModel, err := normalizeAIModel(request.AIModel)
	if err != nil {
		return SubscriptionCreateInput{}, err
	}
	return SubscriptionCreateInput{
		Email:           email,
		ProjectIDs:      projectIDs,
		Country:         country,
		Frequency:       request.Frequency,
		DispatchHour:    dispatchHour,
		DispatchMinute:  dispatchMinute,
		DispatchWeekday: weekday,
		DispatchDay:     day,
		AIModel:         aiModel,
	}, nil
}

func normalizeUpdateRequest(
	request SubscriptionUpdateRequest,
	existing *Subscription,
) (SubscriptionPatch, error) {
	effectiveFrequency := existing.Frequency
	if request.Frequency.Set && request.Frequency.Value != nil {
		if err := validateFrequency(*request.Frequency.Value); err != nil {
			return SubscriptionPatch{}, err
		}
		effectiveFrequency = *request.Frequency.Value
	}

	effectiveHour := existing.DispatchHour
	effectiveMinute := existing.DispatchMinute
	effectiveWeekday := existing.DispatchWeekday
	effectiveDay := existing.DispatchDay

	if request.ProjectIDs.Set && request.ProjectIDs.Value != nil {
		canonical, _, err := normalizeProjectIDs(*request.ProjectIDs.Value)
		if err != nil {
			return SubscriptionPatch{}, err
		}
		request.ProjectIDs.Value = &canonical
	}
	if request.Country.Set && request.Country.Value != nil {
		canonical, err := normalizedCountry(*request.Country.Value)
		if err != nil {
			return SubscriptionPatch{}, err
		}
		request.Country.Value = &canonical
	}
	if request.Email.Set && request.Email.Value != nil {
		normalized, err := normalizeEmail(*request.Email.Value)
		if err != nil {
			return SubscriptionPatch{}, err
		}
		request.Email.Value = normalized
	}
	if request.AIModel.Set && request.AIModel.Value != nil {
		normalized, err := normalizeAIModel(request.AIModel.Value)
		if err != nil {
			return SubscriptionPatch{}, err
		}
		request.AIModel.Value = normalized
	}
	if request.DispatchHour.Set && request.DispatchHour.Value != nil {
		effectiveHour = *request.DispatchHour.Value
	}
	if request.DispatchMinute.Set && request.DispatchMinute.Value != nil {
		effectiveMinute = *request.DispatchMinute.Value
	}
	if request.DispatchWeekday.Set {
		effectiveWeekday = request.DispatchWeekday.Value
	}
	if request.DispatchDay.Set {
		effectiveDay = request.DispatchDay.Value
	}
	if effectiveFrequency == FrequencyWeekly && effectiveWeekday == nil {
		defaultWeekday := 0
		effectiveWeekday = &defaultWeekday
	}
	if effectiveFrequency == FrequencyMonthly && effectiveDay == nil {
		defaultDay := 2
		effectiveDay = &defaultDay
	}
	if err := validateDispatchFields(
		effectiveFrequency,
		effectiveHour,
		effectiveMinute,
		effectiveWeekday,
		effectiveDay,
	); err != nil {
		return SubscriptionPatch{}, err
	}

	return SubscriptionPatch{
		Email:           request.Email,
		ProjectIDs:      request.ProjectIDs,
		Country:         request.Country,
		Frequency:       request.Frequency,
		DispatchHour:    request.DispatchHour,
		DispatchMinute:  request.DispatchMinute,
		DispatchWeekday: request.DispatchWeekday,
		DispatchDay:     request.DispatchDay,
		AIModel:         request.AIModel,
		Enabled:         request.Enabled,
	}, nil
}

func normalizeTestEmailRequest(request TestEmailRequest) (TestEmailMessage, []int64, error) {
	email, err := normalizeRequiredEmail(request.Email)
	if err != nil {
		return TestEmailMessage{}, nil, err
	}
	if request.Frequency == "" {
		request.Frequency = FrequencyDaily
	}
	if err := validateFrequency(request.Frequency); err != nil {
		return TestEmailMessage{}, nil, err
	}
	if request.ProjectIDs == "" {
		request.ProjectIDs = "*"
	}
	projectIDs, ids, err := normalizeProjectIDs(request.ProjectIDs)
	if err != nil {
		return TestEmailMessage{}, nil, err
	}
	if request.Country == "" {
		request.Country = "US"
	}
	country, err := normalizedCountry(request.Country)
	if err != nil {
		return TestEmailMessage{}, nil, err
	}
	aiModel, err := normalizeAIModel(request.AIModel)
	if err != nil {
		return TestEmailMessage{}, nil, err
	}
	return TestEmailMessage{
		Email:      email,
		Frequency:  request.Frequency,
		ProjectIDs: projectIDs,
		Country:    country,
		AIModel:    aiModel,
	}, ids, nil
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

func normalizeAIModel(value *string) (*string, error) {
	trimmed := trimOptional(value)
	if trimmed == nil {
		return nil, nil
	}
	if len([]rune(*trimmed)) > 64 {
		return nil, errors.New("ai_model 长度不能超过 64")
	}
	return trimmed, nil
}

func projectIDsFromString(value string) []int64 {
	if value == "" || value == "*" {
		return nil
	}
	ids := make([]int64, 0)
	for _, part := range strings.Split(value, ",") {
		id, err := strconv.ParseInt(strings.TrimSpace(part), 10, 64)
		if err == nil && id > 0 {
			ids = append(ids, id)
		}
	}
	return ids
}

func requestFingerprint(value any) string {
	payload, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(payload)
}

func parseOptionalIntHeader(value string) (*int, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	number, err := strconv.Atoi(value)
	if err != nil {
		return nil, err
	}
	return &number, nil
}
