package agent_credentials

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const scopeAll = "*"

var agentIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{2,127}$`)

var knownBusinessDomains = map[string]struct{}{
	"sku_info":                 {},
	"inventory":                {},
	"sales":                    {},
	"shipments":                {},
	"shop_calculations":        {},
	"new_product_calculations": {},
	"return_analysis":          {},
	"replenishment_analysis":   {},
	"report_upload_status":     {},
	"report_upload":            {},
	"account_health":           {},
	"ad_analysis":              {},
	"agent_provisioning":       {},
	"inventory_ledger":         {},
	"platform_inspection":      {},
	"complaint_center":         {},
	"monthly_reports":          {},
	"review_tracking":          {},
}

type agentProblem struct {
	status int
	code   string
	detail string
}

func (problem *agentProblem) Error() string {
	if problem == nil {
		return ""
	}
	return problem.detail
}

func validationProblem(detail string) *agentProblem {
	return &agentProblem{
		status: 400,
		code:   "VALIDATION_FAILED",
		detail: detail,
	}
}

func decodeStrictJSON(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return fmt.Errorf("unexpected trailing JSON")
	}
	return nil
}

func validateCreateRequest(
	request AgentKeyCreateRequest,
	now time.Time,
	projects ProjectValidation,
) *agentProblem {
	if !validRuneLength(request.Label, 1, 128) {
		return validationProblem("label 必须为 1-128 个字符")
	}
	if !agentIDPattern.MatchString(request.AgentID) {
		return validationProblem("agent_id 格式非法：小写字母/数字开头，仅含 a-z0-9-_，长度 3-128")
	}
	if !validRuneLength(request.ProjectScope, 1, 255) {
		return validationProblem("project_scope 必须为 1-255 个字符")
	}
	if !validRuneLength(request.BusinessScope, 1, 255) {
		return validationProblem("business_scope 必须为 1-255 个字符")
	}
	if strings.TrimSpace(request.ProjectScope) == scopeAll {
		return validationProblem("自助签发禁止 '*' 通配 project_scope：必须是显式白名单")
	}
	if strings.TrimSpace(request.BusinessScope) == scopeAll {
		return validationProblem("自助签发禁止 '*' 通配 business_scope：必须是显式白名单")
	}
	if request.ItemKey != nil && !validRuneLength(*request.ItemKey, 0, 128) {
		return validationProblem("item_key 最多 128 个字符")
	}
	business, problem := parseBusinessScope(request.BusinessScope)
	if problem != nil {
		return problem
	}
	if _, forbidden := business["agent_provisioning"]; forbidden {
		return validationProblem(
			"自助签发禁止授予 agent_provisioning 域：签发能力仅限管理 Key（全局单例）",
		)
	}
	if _, problem := parseProjectScope(request.ProjectScope); problem != nil {
		return problem
	}
	if len(projects.InvalidIDs) > 0 {
		message := fmt.Sprintf(
			"project_scope 含不存在或已停用的项目 id: %s",
			joinInt64s(projects.InvalidIDs),
		)
		if len(projects.AvailableIDs) > 0 {
			message += "；可用项目 id: " + joinInt64s(projects.AvailableIDs)
		} else {
			message += "；可用项目 id: 无"
		}
		return validationProblem(message)
	}
	if request.ExpiresAt != nil {
		expires := request.ExpiresAt.UTC()
		if !expires.After(now.UTC()) {
			return validationProblem("expires_at 必须晚于当前时刻")
		}
		request.ExpiresAt = &expires
	}
	return nil
}

func validateUpdateRequest(
	request AgentKeyUpdateRequest,
	projects ProjectValidation,
) *agentProblem {
	if request.Label != nil && !validRuneLength(*request.Label, 1, 128) {
		return validationProblem("label 必须为 1-128 个字符")
	}
	if request.ItemKey != nil && !validRuneLength(*request.ItemKey, 0, 128) {
		return validationProblem("item_key 最多 128 个字符")
	}
	if request.ProjectScope != nil {
		if !validRuneLength(*request.ProjectScope, 1, 255) {
			return validationProblem("project_scope 必须为 1-255 个字符")
		}
		if strings.TrimSpace(*request.ProjectScope) == scopeAll {
			return validationProblem("编辑禁止 '*' 通配 project_scope：必须是显式白名单")
		}
		if _, problem := parseProjectScope(*request.ProjectScope); problem != nil {
			return problem
		}
	}
	if request.BusinessScope != nil {
		if !validRuneLength(*request.BusinessScope, 1, 255) {
			return validationProblem("business_scope 必须为 1-255 个字符")
		}
		if strings.TrimSpace(*request.BusinessScope) == scopeAll {
			return validationProblem("编辑禁止 '*' 通配 business_scope：必须是显式白名单")
		}
		business, problem := parseBusinessScope(*request.BusinessScope)
		if problem != nil {
			return problem
		}
		if _, forbidden := business["agent_provisioning"]; forbidden {
			return validationProblem(
				"编辑禁止授予 agent_provisioning 域：签发能力仅限管理 Key（全局单例）",
			)
		}
	}
	if len(projects.InvalidIDs) > 0 {
		message := fmt.Sprintf(
			"project_scope 含不存在或已停用的项目 id: %s",
			joinInt64s(projects.InvalidIDs),
		)
		if len(projects.AvailableIDs) > 0 {
			message += "；可用项目 id: " + joinInt64s(projects.AvailableIDs)
		} else {
			message += "；可用项目 id: 无"
		}
		return validationProblem(message)
	}
	return nil
}

func projectIDsFromCreateRequest(request AgentKeyCreateRequest) ([]int64, *agentProblem) {
	return parseProjectScope(request.ProjectScope)
}

func projectIDsFromUpdateRequest(request AgentKeyUpdateRequest) ([]int64, *agentProblem) {
	if request.ProjectScope == nil {
		return []int64{}, nil
	}
	return parseProjectScope(*request.ProjectScope)
}

func parseProjectScope(scope string) ([]int64, *agentProblem) {
	parts := strings.Split(scope, ",")
	ids := make([]int64, 0, len(parts))
	seen := make(map[int64]bool, len(parts))
	var invalid []string
	for _, raw := range parts {
		part := strings.TrimSpace(raw)
		if part == "" {
			continue
		}
		id, err := strconv.ParseInt(part, 10, 64)
		if err != nil || id <= 0 {
			invalid = append(invalid, part)
			continue
		}
		if !seen[id] {
			ids = append(ids, id)
			seen[id] = true
		}
	}
	if len(ids) == 0 && len(invalid) == 0 {
		return nil, validationProblem("project_scope 不能为空或全空片段")
	}
	if len(invalid) > 0 {
		return nil, validationProblem(
			"project_scope 含非法片段: " + strings.Join(invalid, ", "),
		)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids, nil
}

func parseBusinessScope(scope string) (map[string]struct{}, *agentProblem) {
	codes := make(map[string]struct{})
	for _, raw := range strings.Split(scope, ",") {
		code := strings.TrimSpace(raw)
		if code != "" {
			codes[code] = struct{}{}
		}
	}
	if len(codes) == 0 {
		return nil, validationProblem("business_scope 不能为空")
	}
	var unknown []string
	for code := range codes {
		if _, ok := knownBusinessDomains[code]; !ok {
			unknown = append(unknown, code)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return nil, validationProblem(
			"business_scope 含未知域 code: " + strings.Join(unknown, ", "),
		)
	}
	return codes, nil
}

func businessScopeAllows(scope, domain string) bool {
	scope = strings.TrimSpace(scope)
	if scope == "" || scope == scopeAll {
		return domain != "agent_provisioning"
	}
	for _, raw := range strings.Split(scope, ",") {
		if strings.TrimSpace(raw) == domain {
			return true
		}
	}
	return false
}

func projectScopeAllows(scope string, projectID int64) bool {
	scope = strings.TrimSpace(scope)
	if scope == "" || scope == scopeAll {
		return true
	}
	for _, raw := range strings.Split(scope, ",") {
		id, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
		if err == nil && id == projectID {
			return true
		}
	}
	return false
}

func validRuneLength(value string, minLength, maxLength int) bool {
	length := utf8.RuneCountInString(value)
	return length >= minLength && length <= maxLength
}

func joinInt64s(values []int64) string {
	if len(values) == 0 {
		return ""
	}
	parts := make([]string, len(values))
	for i, value := range values {
		parts[i] = strconv.FormatInt(value, 10)
	}
	return strings.Join(parts, ", ")
}

func normalizeCountry(value string) string {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "", "US", "USA", "美国", "美国站":
		return "US"
	case "DE", "GERMANY", "德国", "德国站":
		return "DE"
	case "UK", "GB", "UNITED KINGDOM", "英国", "英国站":
		return "UK"
	default:
		return ""
	}
}

func validateDate(value *string, field string) *agentProblem {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if _, err := time.Parse("2006-01-02", trimmed); err != nil {
		return &agentProblem{
			status: 422,
			code:   "VALIDATION_FAILED",
			detail: field + " must be YYYY-MM-DD",
		}
	}
	*value = trimmed
	return nil
}
