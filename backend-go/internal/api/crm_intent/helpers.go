package crm_intent

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

// ---------- request identity ----------

func requestActor(r *http.Request) Actor {
	user, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		return Actor{Kind: ActorKindUser}
	}
	return Actor{
		Kind:    ActorKindUser,
		ID:      strings.TrimSpace(user.UserID),
		IsAdmin: user.IsAdmin,
	}
}

func agentActor(r *http.Request) (Actor, error) {
	credential, ok := agentauth.CredentialFromRequest(r)
	if !ok {
		return Actor{}, NewDomainError(http.StatusUnauthorized, "AGENT_AUTH_FAILED", "token_invalid")
	}
	return Actor{Kind: ActorKindAgent, ID: strings.TrimSpace(credential.AgentID)}, nil
}

func requestScope(r *http.Request, actor Actor) (Scope, error) {
	resolved := ResolveScope(r.URL.Query().Get("scope"), actor.IsAdmin)
	if resolved == "" {
		return Scope{}, newValidationError("scope 只接受 mine / all / sea")
	}
	if actor.ID == "" {
		return Scope{}, NewDomainError(http.StatusUnauthorized, "", "Not authenticated")
	}
	return Scope{Name: resolved, UserID: actor.ID, IsAdmin: actor.IsAdmin}, nil
}

// ---------- parsing helpers ----------

func chiParam(r *http.Request, name string) string {
	return chi.URLParam(r, name)
}

func parsePathID(r *http.Request, name string) (int64, error) {
	value, err := strconv.ParseInt(strings.TrimSpace(chi.URLParam(r, name)), 10, 64)
	if err != nil || value < 1 {
		return 0, newValidationError(name + " 必须是正整数")
	}
	return value, nil
}

func parsePageParams(r *http.Request, defaultSize, maxSize int) (int, int, error) {
	page := 1
	if raw := strings.TrimSpace(r.URL.Query().Get("page")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 {
			return 0, 0, newValidationError("page 必须大于等于 1")
		}
		page = value
	}
	pageSize := defaultSize
	if raw := strings.TrimSpace(r.URL.Query().Get("page_size")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > maxSize {
			return 0, 0, newValidationError(fmt.Sprintf("page_size 必须在 1 到 %d 之间", maxSize))
		}
		pageSize = value
	}
	return page, pageSize, nil
}

func optionalQueryString(r *http.Request, name string) *string {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return nil
	}
	return &raw
}

func optionalQueryBool(r *http.Request, name string) (*bool, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return nil, nil
	}
	switch strings.ToLower(raw) {
	case "1", "true", "yes", "y", "on":
		value := true
		return &value, nil
	case "0", "false", "no", "n", "off":
		value := false
		return &value, nil
	default:
		return nil, newValidationError(name + " 必须是布尔值")
	}
}

func optionalQueryInt64(r *http.Request, name string) (*int64, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return nil, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 1 {
		return nil, newValidationError(name + " 必须是正整数")
	}
	return &value, nil
}

func optionalQueryTime(r *http.Request, name string) (*time.Time, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return nil, nil
	}
	value, err := ParseDateTime(raw)
	if err != nil {
		return nil, newValidationError(name + " 必须是合法时间")
	}
	return value, nil
}

// ParseDateTime accepts RFC3339, naive "YYYY-MM-DDTHH:MM:SS" (Asia/Shanghai)
// and bare "YYYY-MM-DD".
func ParseDateTime(raw string) (*time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("empty datetime")
	}
	if value, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return &value, nil
	}
	location := shanghaiLocation()
	if value, err := time.ParseInLocation("2006-01-02T15:04:05.999999999", raw, location); err == nil {
		return &value, nil
	}
	if value, err := time.ParseInLocation("2006-01-02T15:04", raw, location); err == nil {
		return &value, nil
	}
	if value, err := time.ParseInLocation("2006-01-02", raw, location); err == nil {
		return &value, nil
	}
	return nil, fmt.Errorf("invalid datetime %q", raw)
}

func shanghaiLocation() *time.Location {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return time.FixedZone("CST", 8*60*60)
	}
	return location
}

func todayShanghai() time.Time {
	now := time.Now().In(shanghaiLocation())
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, shanghaiLocation())
}

func formatTimestamp(value time.Time) string {
	return httpapi.Timestamp(value)
}

func optionalTimestamp(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := httpapi.Timestamp(*value)
	return &formatted
}

func optionalDate(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.In(shanghaiLocation()).Format("2006-01-02")
	return &formatted
}

// ---------- JSON decoding ----------

func decodeJSONBody(r *http.Request, target any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 32<<20))
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return newValidationError("请求体不是合法 JSON")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return newValidationError("请求体不是合法 JSON")
	}
	return nil
}

// decodeStrictObject rejects both unknown fields and explicitly banned fields.
func decodeStrictObject(data []byte, allowed map[string]bool, banned map[string]string, target any) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return newValidationError("对象字段不是合法 JSON")
	}
	for key := range raw {
		if _, isBanned := banned[key]; isBanned {
			return newValidationError("字段不允许写入: " + key)
		}
		if !allowed[key] {
			return newValidationError("未知字段: " + key)
		}
	}
	if err := json.Unmarshal(data, target); err != nil {
		return newValidationError("字段类型不合法: " + err.Error())
	}
	return nil
}

// ---------- write helpers ----------

func writeJSON(w http.ResponseWriter, status int, value any) {
	if err := httpapi.WriteJSON(w, status, value); err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
	}
}

func writeUserError(w http.ResponseWriter, err error) {
	var domainErr *DomainError
	if errors.As(err, &domainErr) {
		if domainErr.Current != nil {
			detail := map[string]any{
				"code":    domainErr.Code,
				"message": domainErr.Message,
				"current": domainErr.Current,
			}
			for key, value := range domainErr.Extra {
				detail[key] = value
			}
			writeJSON(w, domainErr.Status, map[string]any{"detail": detail})
			return
		}
		httpapi.WriteDetail(w, domainErr.Status, domainErr.Message)
		return
	}
	httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
}

func writeAgentError(w http.ResponseWriter, err error) {
	var domainErr *DomainError
	if errors.As(err, &domainErr) {
		code := domainErr.Code
		if code == "" {
			code = "INTERNAL_ERROR"
		}
		detail := map[string]any{"code": code, "message": domainErr.Message}
		for key, value := range domainErr.Extra {
			detail[key] = value
		}
		writeJSON(w, domainErr.Status, map[string]any{"detail": detail})
		return
	}
	writeJSON(w, http.StatusInternalServerError, map[string]any{
		"detail": map[string]any{
			"code":    "INTERNAL_ERROR",
			"message": "服务器内部错误",
		},
	})
}

func internalError() *DomainError {
	return NewDomainError(http.StatusInternalServerError, "INTERNAL_ERROR", "服务器内部错误")
}

// requireIdempotencyKey returns the Idempotency-Key header (1-128 chars).
func requireIdempotencyKey(r *http.Request) (string, error) {
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if key == "" {
		return "", NewDomainError(http.StatusBadRequest, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key 请求头")
	}
	if len([]rune(key)) > 128 {
		return "", newValidationError("Idempotency-Key 不能超过 128 字符")
	}
	return key, nil
}

// ---------- normalization / validation ----------

// NormalizeNameKey mirrors the spec: TrimSpace + collapse whitespace, no
// full-width bracket or roman numeral normalization.
func NormalizeNameKey(name string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(name)), " ")
}

// NormalizePhone strips non-digits, removes a leading 86 on 13-digit values and
// rejects anything shorter than 6 digits.
func NormalizePhone(raw string) (string, error) {
	var builder strings.Builder
	for _, character := range raw {
		if character >= '0' && character <= '9' {
			builder.WriteRune(character)
		}
	}
	digits := builder.String()
	if len(digits) == 13 && strings.HasPrefix(digits, "86") {
		digits = digits[2:]
	}
	if len(digits) < 6 {
		return "", fmt.Errorf("号码位数不足")
	}
	if len(digits) > 32 {
		return "", fmt.Errorf("号码过长")
	}
	return digits, nil
}

func normalizedPhones(values []string) ([]string, error) {
	result := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		if strings.TrimSpace(value) == "" {
			continue
		}
		normalized, err := NormalizePhone(value)
		if err != nil {
			return nil, fmt.Errorf("%s", err.Error())
		}
		if seen[normalized] {
			continue
		}
		seen[normalized] = true
		result = append(result, normalized)
	}
	return result, nil
}

func trimmedPointer(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func trimmedRunes(value *string, max int) (*string, error) {
	trimmed := trimmedPointer(value)
	if trimmed != nil && len([]rune(*trimmed)) > max {
		return nil, newValidationError(fmt.Sprintf("字段长度不能超过 %d 字符", max))
	}
	return trimmed, nil
}

func filterHTTPSources(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if strings.HasPrefix(trimmed, "http://") || strings.HasPrefix(trimmed, "https://") {
			result = append(result, trimmed)
		}
	}
	return result
}

func trimList(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

// NormalizeCompanyInput validates and normalizes one shared company payload.
// requireName is true for creates/batch rows and false for PATCH.
func NormalizeCompanyInput(input *CompanyInput, requireName bool) (*CompanyInput, error) {
	normalized := *input
	var err error
	if normalized.Name, err = trimmedRunes(input.Name, 200); err != nil {
		return nil, err
	}
	if requireName && normalized.Name == nil {
		return nil, newValidationError("name 是必填字段")
	}
	if normalized.CreditCode, err = trimmedRunes(input.CreditCode, 32); err != nil {
		return nil, err
	}
	if normalized.LegalPerson, err = trimmedRunes(input.LegalPerson, 100); err != nil {
		return nil, err
	}
	if normalized.Province, err = trimmedRunes(input.Province, 50); err != nil {
		return nil, err
	}
	if normalized.City, err = trimmedRunes(input.City, 50); err != nil {
		return nil, err
	}
	if normalized.Products, err = trimmedRunes(input.Products, 5000); err != nil {
		return nil, err
	}
	if normalized.Category, err = trimmedRunes(input.Category, 50); err != nil {
		return nil, err
	}
	if normalized.Channel, err = trimmedRunes(input.Channel, 50); err != nil {
		return nil, err
	}
	if normalized.ChannelSource, err = trimmedRunes(input.ChannelSource, 255); err != nil {
		return nil, err
	}
	if normalized.Channels = trimList(input.Channels); normalized.Channels == nil {
		normalized.Channels = []string{}
	}
	if normalized.IntentBasis, err = trimmedRunes(input.IntentBasis, 5000); err != nil {
		return nil, err
	}
	if normalized.AmazonFit, err = trimmedRunes(input.AmazonFit, 5000); err != nil {
		return nil, err
	}
	if normalized.WalmartFit, err = trimmedRunes(input.WalmartFit, 5000); err != nil {
		return nil, err
	}
	if normalized.Risks, err = trimmedRunes(input.Risks, 5000); err != nil {
		return nil, err
	}
	if normalized.PhoneNote, err = trimmedRunes(input.PhoneNote, 2000); err != nil {
		return nil, err
	}
	if normalized.FoundedYear != nil && (*normalized.FoundedYear < 1800 || *normalized.FoundedYear > 2100) {
		return nil, newValidationError("founded_year 必须在 1800 到 2100 之间")
	}
	if normalized.IntentLevel != nil {
		level := strings.ToUpper(strings.TrimSpace(*normalized.IntentLevel))
		if !ValidIntentLevel(level) {
			return nil, newValidationError("intent_level 只接受 A/B/C/D")
		}
		normalized.IntentLevel = &level
	}
	if normalized.IntentScore != nil && (*normalized.IntentScore < 0 || *normalized.IntentScore > 100) {
		return nil, newValidationError("intent_score 必须在 0 到 100 之间")
	}
	if normalized.TrademarkCount != nil && *normalized.TrademarkCount < 0 {
		return nil, newValidationError("trademark_count 不能为负数")
	}
	if normalized.ScreenedAt != nil {
		parsed, parseErr := ParseDateTime(*normalized.ScreenedAt)
		if parseErr != nil {
			return nil, newValidationError("screened_at 必须是 YYYY-MM-DD")
		}
		formatted := parsed.In(shanghaiLocation()).Format("2006-01-02")
		normalized.ScreenedAt = &formatted
	}
	trademarks := trimList(input.Trademarks)
	if normalized.Trademarks = trademarks; normalized.Trademarks == nil {
		normalized.Trademarks = []string{}
	}
	normalized.Sources = filterHTTPSources(input.Sources)
	if phones, phoneErr := normalizedPhones(input.Phones); phoneErr != nil {
		return nil, newValidationError(phoneErr.Error())
	} else if normalized.Phones = phones; normalized.Phones == nil {
		normalized.Phones = []string{}
	}
	return &normalized, nil
}

// NormalizePoolInput validates one pool payload.
func NormalizePoolInput(input *PoolInput) (*PoolInput, error) {
	normalized := *input
	var err error
	if normalized.Name, err = trimmedRunes(input.Name, 200); err != nil {
		return nil, err
	}
	if normalized.Name == nil {
		return nil, newValidationError("name 是必填字段")
	}
	if normalized.LegalPerson, err = trimmedRunes(input.LegalPerson, 100); err != nil {
		return nil, err
	}
	if normalized.Channel, err = trimmedRunes(input.Channel, 50); err != nil {
		return nil, err
	}
	if normalized.ChannelSource, err = trimmedRunes(input.ChannelSource, 255); err != nil {
		return nil, err
	}
	if normalized.Website, err = trimmedRunes(input.Website, 300); err != nil {
		return nil, err
	}
	if normalized.Website != nil &&
		!strings.HasPrefix(*normalized.Website, "http://") &&
		!strings.HasPrefix(*normalized.Website, "https://") {
		normalized.Website = nil
	}
	if normalized.Channels = trimList(input.Channels); normalized.Channels == nil {
		normalized.Channels = []string{}
	}
	if phones, phoneErr := normalizedPhones(input.Phones); phoneErr != nil {
		return nil, newValidationError(phoneErr.Error())
	} else if normalized.Phones = phones; normalized.Phones == nil {
		normalized.Phones = []string{}
	}
	return &normalized, nil
}

// ---------- CSV / import parsing ----------

// BuildCompaniesCSV renders the 24 base columns + owner/state/next contact/
// converted flag (28 columns total).
func BuildCompaniesCSV(items []Company) string {
	var buffer bytes.Buffer
	buffer.WriteString("\ufeff")
	writer := csv.NewWriter(&buffer)
	_ = writer.Write([]string{
		"企业名称", "外部ID", "统一社会信用代码", "法人", "省份", "城市", "成立年份",
		"注册资本(万元)", "主营产品", "类目", "商标", "商标数", "意向级别", "意向分",
		"意向依据", "亚马逊适配", "沃尔玛适配", "来源", "疑点", "筛选日期", "手机号",
		"号码备注", "批次ID", "创建时间", "负责人", "跟进状态", "下次联系", "是否转客户",
	})
	for _, item := range items {
		phones := make([]string, 0, len(item.Phones))
		for _, phone := range item.Phones {
			phones = append(phones, phone.PhoneNormalized)
		}
		owner := ""
		if item.Owner != nil {
			if item.Owner.Name != nil {
				owner = *item.Owner.Name
			} else {
				owner = item.Owner.ID
			}
		}
		converted := "否"
		if item.ConvertedCustomerID != nil {
			converted = "是"
		}
		_ = writer.Write([]string{
			item.Name,
			pointerString(item.ExternalID),
			pointerString(item.CreditCode),
			pointerString(item.LegalPerson),
			pointerString(item.Province),
			pointerString(item.City),
			pointerString(item.FoundedYear),
			pointerString(item.RegisteredCapitalWan),
			pointerString(item.Products),
			pointerString(item.Category),
			strings.Join(item.Trademarks, ";"),
			strconv.Itoa(item.TrademarkCount),
			item.IntentLevel,
			pointerString(item.IntentScore),
			pointerString(item.IntentBasis),
			pointerString(item.AmazonFit),
			pointerString(item.WalmartFit),
			strings.Join(item.Sources, ";"),
			pointerString(item.Risks),
			pointerString(item.ScreenedAt),
			strings.Join(phones, ";"),
			pointerString(item.PhoneNote),
			pointerString(item.BatchID),
			item.CreatedAt,
			owner,
			item.Followup.StateLabel,
			pointerString(item.Followup.NextContactAt),
			converted,
		})
	}
	writer.Flush()
	return buffer.String()
}

func pointerString[T any](value *T) string {
	if value == nil {
		return ""
	}
	if stringer, ok := any(*value).(fmt.Stringer); ok {
		return stringer.String()
	}
	return fmt.Sprint(*value)
}

// ParseImportFile parses an upload (JSON/CSV/XLSX) into the shared payload.
func ParseImportFile(data []byte, filename string) ([]CompanyInput, []PoolInput, []RejectedRow, error) {
	lower := strings.ToLower(strings.TrimSpace(filename))
	switch {
	case strings.HasSuffix(lower, ".json"):
		return parseJSONImport(data)
	case strings.HasSuffix(lower, ".csv"):
		return parseTabularImport(csvRows(data))
	case strings.HasSuffix(lower, ".xlsx"):
		rows, err := xlsxRows(data)
		if err != nil {
			return nil, nil, nil, err
		}
		return parseTabularImport(rows)
	default:
		return nil, nil, nil, newValidationError("仅支持 .json / .csv / .xlsx 导入文件")
	}
}

func parseJSONImport(data []byte) ([]CompanyInput, []PoolInput, []RejectedRow, error) {
	data = bytes.TrimPrefix(data, []byte("ï»¿"))
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return nil, nil, nil, newValidationError("导入文件为空")
	}
	if trimmed[0] == '[' {
		var rows []json.RawMessage
		if err := json.Unmarshal(trimmed, &rows); err != nil {
			return nil, nil, nil, newValidationError("JSON 数组格式错误: " + err.Error())
		}
		companies, rejected := decodeCompanyRows(rows, 0)
		return companies, nil, rejected, nil
	}
	var payload struct {
		Companies []json.RawMessage `json:"companies"`
		Pool      []json.RawMessage `json:"pool"`
	}
	if err := json.Unmarshal(trimmed, &payload); err != nil {
		return nil, nil, nil, newValidationError("JSON 对象格式错误: " + err.Error())
	}
	companies, rejected := decodeCompanyRows(payload.Companies, 0)
	pool, poolRejected := decodePoolRows(payload.Pool, 0)
	return companies, pool, append(rejected, poolRejected...), nil
}

func decodeCompanyRows(rows []json.RawMessage, offset int) ([]CompanyInput, []RejectedRow) {
	companies := make([]CompanyInput, 0, len(rows))
	rejected := make([]RejectedRow, 0)
	for index, raw := range rows {
		var input CompanyInput
		if err := decodeStrictObject(raw, companyImportFields, companyBannedFields, &input); err != nil {
			rejected = append(rejected, rejectedRow("companies", index+offset, input.ExternalID, err.Error()))
			continue
		}
		normalized, err := NormalizeCompanyInput(&input, true)
		if err != nil {
			rejected = append(rejected, rejectedRow("companies", index+offset, input.ExternalID, err.Error()))
			continue
		}
		companies = append(companies, *normalized)
	}
	return companies, rejected
}

func decodePoolRows(rows []json.RawMessage, offset int) ([]PoolInput, []RejectedRow) {
	pool := make([]PoolInput, 0, len(rows))
	rejected := make([]RejectedRow, 0)
	for index, raw := range rows {
		var input PoolInput
		if err := decodeStrictObject(raw, poolImportFields, companyBannedFields, &input); err != nil {
			rejected = append(rejected, rejectedRow("pool", index+offset, input.ExternalID, err.Error()))
			continue
		}
		normalized, err := NormalizePoolInput(&input)
		if err != nil {
			rejected = append(rejected, rejectedRow("pool", index+offset, input.ExternalID, err.Error()))
			continue
		}
		pool = append(pool, *normalized)
	}
	return pool, rejected
}

func rejectedRow(scope string, index int, externalID *string, reason string) RejectedRow {
	return RejectedRow{Scope: scope, Index: index, ExternalID: externalID, Reason: reason}
}

func csvRows(data []byte) [][]string {
	data = bytes.TrimPrefix(data, []byte("ï»¿"))
	reader := csv.NewReader(bytes.NewReader(data))
	reader.FieldsPerRecord = -1
	rows, err := reader.ReadAll()
	if err != nil {
		return nil
	}
	return rows
}

var tabularCompanyHeaders = map[string]string{
	"name": "name", "企业名称": "name",
	"external_id": "external_id", "外部id": "external_id",
	"credit_code": "credit_code", "统一社会信用代码": "credit_code", "信用代码": "credit_code",
	"legal_person": "legal_person", "法人": "legal_person",
	"phones": "phones", "手机号": "phones", "电话": "phones",
	"province": "province", "省份": "province",
	"city": "city", "城市": "city",
	"founded_year": "founded_year", "成立年份": "founded_year",
	"registered_capital_wan": "registered_capital_wan", "注册资本(万元)": "registered_capital_wan", "注册资本": "registered_capital_wan",
	"products": "products", "主营产品": "products",
	"category": "category", "类目": "category",
	"channel": "channel", "渠道": "channel",
	"channels": "channels", "渠道列表": "channels",
	"channel_source": "channel_source", "渠道来源": "channel_source",
	"trademarks": "trademarks", "商标": "trademarks",
	"trademark_count": "trademark_count", "商标数": "trademark_count",
	"intent_level": "intent_level", "意向级别": "intent_level",
	"intent_score": "intent_score", "意向分": "intent_score",
	"intent_basis": "intent_basis", "意向依据": "intent_basis",
	"amazon_fit": "amazon_fit", "亚马逊适配": "amazon_fit",
	"walmart_fit": "walmart_fit", "沃尔玛适配": "walmart_fit",
	"sources": "sources", "来源": "sources",
	"risks": "risks", "疑点": "risks",
	"screened_at": "screened_at", "筛选日期": "screened_at",
	"phone_note": "phone_note", "号码备注": "phone_note",
}

func splitCellList(value string) []string {
	replacer := strings.NewReplacer("；", ";", "|", ";", "、", ";")
	parts := strings.Split(replacer.Replace(value), ";")
	return trimList(parts)
}

func parseTabularImport(rows [][]string) ([]CompanyInput, []PoolInput, []RejectedRow, error) {
	if len(rows) < 2 {
		return nil, nil, nil, newValidationError("导入文件为空")
	}
	headers := make([]string, len(rows[0]))
	for index, header := range rows[0] {
		key := strings.ToLower(strings.TrimSpace(header))
		if mapped, ok := tabularCompanyHeaders[key]; ok {
			headers[index] = mapped
		}
	}
	companies := make([]CompanyInput, 0, len(rows)-1)
	rejected := make([]RejectedRow, 0)
	for rowIndex, row := range rows[1:] {
		cell := func(field string) *string {
			for index, header := range headers {
				if header == field && index < len(row) && strings.TrimSpace(row[index]) != "" {
					value := strings.TrimSpace(row[index])
					return &value
				}
			}
			return nil
		}
		input := CompanyInput{
			Name:          cell("name"),
			ExternalID:    cell("external_id"),
			LegalPerson:   cell("legal_person"),
			Province:      cell("province"),
			City:          cell("city"),
			Products:      cell("products"),
			Category:      cell("category"),
			Channel:       cell("channel"),
			ChannelSource: cell("channel_source"),
			IntentLevel:   cell("intent_level"),
			IntentBasis:   cell("intent_basis"),
			AmazonFit:     cell("amazon_fit"),
			WalmartFit:    cell("walmart_fit"),
			Risks:         cell("risks"),
			PhoneNote:     cell("phone_note"),
			CreditCode:    cell("credit_code"),
		}
		if value := cell("phones"); value != nil {
			input.Phones = splitCellList(*value)
		}
		if value := cell("trademarks"); value != nil {
			input.Trademarks = splitCellList(*value)
		}
		if value := cell("sources"); value != nil {
			input.Sources = splitCellList(*value)
		}
		if value := cell("channels"); value != nil {
			input.Channels = splitCellList(*value)
		}
		if value := cell("screened_at"); value != nil {
			input.ScreenedAt = value
		}
		if value := cell("founded_year"); value != nil {
			parsed, err := strconv.Atoi(*value)
			if err != nil {
				rejected = append(rejected, rejectedRow("companies", rowIndex, input.ExternalID, "founded_year must be an integer"))
				continue
			}
			input.FoundedYear = &parsed
		}
		if value := cell("trademark_count"); value != nil {
			parsed, err := strconv.Atoi(*value)
			if err != nil {
				rejected = append(rejected, rejectedRow("companies", rowIndex, input.ExternalID, "trademark_count must be an integer"))
				continue
			}
			input.TrademarkCount = &parsed
		}
		if value := cell("intent_score"); value != nil {
			parsed, err := strconv.Atoi(*value)
			if err != nil {
				rejected = append(rejected, rejectedRow("companies", rowIndex, input.ExternalID, "intent_score must be an integer"))
				continue
			}
			input.IntentScore = &parsed
		}
		if value := cell("registered_capital_wan"); value != nil {
			parsed, err := strconv.ParseFloat(strings.ReplaceAll(*value, ",", ""), 64)
			if err != nil {
				rejected = append(rejected, rejectedRow("companies", rowIndex, input.ExternalID, "registered_capital_wan must be a number"))
				continue
			}
			input.RegisteredCapitalWan = &parsed
		}
		normalized, err := NormalizeCompanyInput(&input, true)
		if err != nil {
			rejected = append(rejected, rejectedRow("companies", rowIndex, input.ExternalID, err.Error()))
			continue
		}
		companies = append(companies, *normalized)
	}
	return companies, nil, rejected, nil
}

func xlsxRows(data []byte) ([][]string, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, newValidationError("XLSX 文件格式错误")
	}
	var shared []string
	if sharedFile, sharedErr := reader.Open("xl/sharedStrings.xml"); sharedErr == nil {
		defer sharedFile.Close()
		var parsed struct {
			Items []struct {
				Text     string `xml:"t"`
				Fallback string `xml:",chardata"`
			} `xml:"si"`
		}
		if err := xml.NewDecoder(io.LimitReader(sharedFile, 64<<20)).Decode(&parsed); err == nil {
			for _, item := range parsed.Items {
				value := item.Text
				if value == "" {
					value = item.Fallback
				}
				shared = append(shared, value)
			}
		}
	}
	sheetFile, err := reader.Open("xl/worksheets/sheet1.xml")
	if err != nil {
		return nil, newValidationError("XLSX 缺少首个工作表")
	}
	defer sheetFile.Close()
	var parsed struct {
		Rows []struct {
			Cells []struct {
				Ref    string `xml:"r,attr"`
				Type   string `xml:"t,attr"`
				Value  string `xml:"v"`
				Inline struct {
					Text string `xml:"t"`
				} `xml:"is"`
			} `xml:"c"`
		} `xml:"sheetData>row"`
	}
	if err := xml.NewDecoder(io.LimitReader(sheetFile, 64<<20)).Decode(&parsed); err != nil {
		return nil, newValidationError("XLSX 工作表格式错误")
	}
	rows := make([][]string, 0, len(parsed.Rows))
	for _, row := range parsed.Rows {
		maxColumn := 0
		for _, cell := range row.Cells {
			if column := xlsxColumnIndex(cell.Ref); column > maxColumn {
				maxColumn = column
			}
		}
		values := make([]string, maxColumn)
		for _, cell := range row.Cells {
			value := cell.Value
			if cell.Inline.Text != "" {
				value = cell.Inline.Text
			}
			if cell.Type == "s" {
				index, parseErr := strconv.Atoi(value)
				if parseErr == nil && index >= 0 && index < len(shared) {
					value = shared[index]
				}
			}
			column := xlsxColumnIndex(cell.Ref)
			if column > 0 && column <= len(values) {
				values[column-1] = value
			}
		}
		rows = append(rows, values)
	}
	return rows, nil
}

func xlsxColumnIndex(ref string) int {
	ref = strings.TrimSpace(ref)
	column := 0
	for index := 0; index < len(ref); index++ {
		character := ref[index]
		if character >= 'a' && character <= 'z' {
			character -= 'a' - 'A'
		}
		if character < 'A' || character > 'Z' {
			break
		}
		column = column*26 + int(character-'A'+1)
	}
	return column
}

// ---------- hashing / object keys ----------

func sha256Hex(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func FiltersHash(r *http.Request) string {
	return sha256Hex([]byte(r.URL.Query().Encode()))
}

func sanitizeFilename(filename string) string {
	filename = strings.TrimSpace(filename)
	replacer := strings.NewReplacer("/", "-", "\\", "-")
	filename = replacer.Replace(filename)
	var builder strings.Builder
	for _, character := range filename {
		if character < 0x20 || character == 0x7f {
			continue
		}
		builder.WriteRune(character)
	}
	cleaned := strings.Join(strings.Fields(builder.String()), " ")
	if cleaned == "" {
		cleaned = "batch"
	}
	runes := []rune(cleaned)
	if len(runes) > 100 {
		cleaned = string(runes[:100])
	}
	return cleaned
}

func encodeQueryValue(value string) string {
	return url.QueryEscape(value)
}

// ValidCompanySort validates the sort query parameter.
func ValidCompanySort(sort string) bool {
	switch sort {
	case "", "updated", "updated_desc", "name", "name_asc", "level", "level_asc",
		"score", "score_desc", "screened", "screened_desc", "due", "due_asc":
		return true
	default:
		return false
	}
}

// writeCSVResponse writes a UTF-8 CSV attachment with an RFC 5987 filename.
func writeCSVResponse(w http.ResponseWriter, filename, content string) {
	encoded := url.QueryEscape(filename)
	encoded = strings.ReplaceAll(encoded, "+", "%20")
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+encoded)
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, content)
}

// ---------- field whitelists ----------

var companyBannedFields = map[string]string{
	"owner_id":              "owner 只能由人工设置",
	"human_touched_at":      "人工锁标记只能由人工写入",
	"human_touched_by":      "人工锁标记只能由人工写入",
	"converted_customer_id": "转换标记只能由人工写入",
	"converted_at":          "转换标记只能由人工写入",
	"followup":              "跟进字段只能由人工写入",
	"state":                 "跟进字段只能由人工写入",
	"note":                  "跟进字段只能由人工写入",
	"last_contact_at":       "跟进字段只能由人工写入",
	"next_contact_at":       "跟进字段只能由人工写入",
	"valid_phones":          "跟进字段只能由人工写入",
	"batch_id":              "批次归属由导入决定",
	"name_key":              "派生字段不可写",
}

var companyImportFields = map[string]bool{
	"external_id": true, "name": true, "credit_code": true, "legal_person": true,
	"phones": true, "province": true, "city": true, "founded_year": true,
	"registered_capital_wan": true, "products": true, "category": true,
	"channel": true, "channels": true, "channel_source": true,
	"trademarks": true, "trademark_count": true, "intent_level": true,
	"intent_score": true, "intent_basis": true, "amazon_fit": true,
	"walmart_fit": true, "sources": true, "risks": true, "screened_at": true,
	"phone_note": true,
}

// companyPatchFields excludes identity fields (name / external_id).
var companyPatchFields = func() map[string]bool {
	result := make(map[string]bool, len(companyImportFields))
	for key := range companyImportFields {
		if key == "name" || key == "external_id" {
			continue
		}
		result[key] = true
	}
	return result
}()

var poolImportFields = map[string]bool{
	"external_id": true, "name": true, "legal_person": true, "phones": true,
	"website": true, "channel": true, "channels": true, "channel_source": true,
}

var batchEnvelopeFields = map[string]bool{
	"batch": true, "mode": true, "companies": true, "pool": true,
}

var batchMetaFields = map[string]bool{
	"batch_date": true, "source": true, "source_file": true, "note": true,
}
