package agent_review_tracking

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
)

type Handler struct {
	store Store
	now   func() time.Time
}

func NewHandler(store Store, options Options) *Handler {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Handler{store: store, now: now}
}

type successEnvelope struct {
	OK             bool   `json:"ok"`
	Data           any    `json:"data"`
	IdempotencyKey string `json:"idempotency_key,omitempty"`
}

type errorEnvelope struct {
	OK    bool         `json:"ok"`
	Error errorPayload `json:"error"`
}

type errorPayload struct {
	Code         string `json:"code"`
	HumanMessage string `json:"human_message"`
	AgentHint    string `json:"agent_hint"`
	Reason       string `json:"reason,omitempty"`
	Details      any    `json:"details,omitempty"`
}

func writeSuccess(w http.ResponseWriter, data any, idempotencyKey *string) {
	payload := successEnvelope{OK: true, Data: data}
	if idempotencyKey != nil {
		payload.IdempotencyKey = *idempotencyKey
	}
	writeJSON(w, http.StatusOK, payload)
}

func writeAPIError(w http.ResponseWriter, err error) {
	apiErr := normalizeError(err)
	writeJSON(w, apiErr.Status, errorEnvelope{
		OK: false,
		Error: errorPayload{
			Code:         apiErr.Code,
			HumanMessage: apiErr.HumanMessage,
			AgentHint:    apiErr.AgentHint,
			Reason:       apiErr.Reason,
			Details:      apiErr.Details,
		},
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func normalizeError(err error) *APIError {
	if err == nil {
		return internalError()
	}
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return fillErrorDefaults(apiErr)
	}
	var authErr *agentauth.APIError
	if errors.As(err, &authErr) {
		return fillErrorDefaults(&APIError{
			Status:       authErr.Status,
			Code:         authErr.Code,
			Reason:       authErr.Detail,
			HumanMessage: authErr.Detail,
		})
	}
	switch {
	case errors.Is(err, ErrResourceNotFound):
		return &APIError{
			Status:       http.StatusNotFound,
			Code:         ErrorCodeResourceNotFound,
			HumanMessage: "目标不存在或已停用",
			AgentHint:    "请重新读取 active targets 后使用返回的 target_id",
		}
	case errors.Is(err, ErrDependencyUnavailable):
		return &APIError{
			Status:       http.StatusServiceUnavailable,
			Code:         "INTERNAL_ERROR",
			HumanMessage: "评论追踪所需依赖暂不可用",
			AgentHint:    "请稍后重试；若持续出现请联系管理员",
		}
	case errors.Is(err, ErrIdempotencyKeyConflict):
		return &APIError{
			Status:       http.StatusConflict,
			Code:         "IDEMPOTENCY_KEY_CONFLICT",
			HumanMessage: "Idempotency-Key 冲突",
			AgentHint:    "请使用同一请求体重试或更换幂等键",
		}
	default:
		slog.Error("agent review tracking internal error", "error", err)
		return internalError()
	}
}

func fillErrorDefaults(apiErr *APIError) *APIError {
	if apiErr == nil {
		return internalError()
	}
	if apiErr.Status == 0 {
		apiErr.Status = http.StatusInternalServerError
	}
	if apiErr.Code == "" {
		apiErr.Code = "INTERNAL_ERROR"
	}
	if apiErr.HumanMessage == "" {
		switch apiErr.Code {
		case "VALIDATION_FAILED":
			apiErr.HumanMessage = "请求参数不合法"
			apiErr.AgentHint = "请修正请求字段后重试"
		case agentauth.ErrorCodeAgentProjectOutOfScope:
			apiErr.HumanMessage = "本凭据未被授权访问该项目"
			apiErr.AgentHint = "请在 Agent 平台为该 agent 配置项目访问权限"
		case agentauth.ErrorCodeAgentAuthFailed:
			apiErr.HumanMessage = "Agent 鉴权失败"
			apiErr.AgentHint = "请确认 Authorization 与 X-Agent-Id 配对正确"
		case ErrorCodeReviewTrackingCaptureOutOfOrder:
			apiErr.HumanMessage = "captured_at 早于或等于该目标最近一次有效采集时间"
			apiErr.AgentHint = "请使用更晚的 captured_at 重试"
		case ErrorCodeResourceNotFound:
			apiErr.HumanMessage = "资源不存在"
			apiErr.AgentHint = "请刷新资源后重试"
		default:
			apiErr.HumanMessage = "服务器内部错误"
			apiErr.AgentHint = "请稍后重试；若持续出现请联系管理员"
		}
	}
	if apiErr.AgentHint == "" {
		apiErr.AgentHint = "请稍后重试；若持续出现请联系管理员"
	}
	return apiErr
}

func internalError() *APIError {
	return &APIError{
		Status:       http.StatusInternalServerError,
		Code:         "INTERNAL_ERROR",
		HumanMessage: "服务器内部错误",
		AgentHint:    "请稍后重试；若持续出现请联系管理员",
	}
}

func (h *Handler) ListTargets(w http.ResponseWriter, r *http.Request) {
	if h.store == nil {
		writeAPIError(w, ErrDependencyUnavailable)
		return
	}
	query := r.URL.Query()
	kindValue := ""
	if values, present := query["kind"]; present {
		kindValue = rawQueryValue(values)
		if kindValue != "internal_group" && kindValue != "external_asin" {
			writeAPIError(w, validationFailure(
				"kind 必须是 internal_group 或 external_asin",
			))
			return
		}
	}
	marketplaceValue := ""
	marketplacePresent := false
	if values, present := query["marketplace"]; present {
		marketplacePresent = true
		marketplaceValue = rawQueryValue(values)
		if utf8.RuneCountInString(marketplaceValue) > 2 {
			writeAPIError(w, validationFailure("marketplace 长度不能超过 2 字符"))
			return
		}
		marketplaceValue = strings.ToUpper(strings.TrimSpace(marketplaceValue))
	}
	var projectID *int64
	if values, present := query["project_id"]; present {
		raw := firstQueryValue(values)
		parsed, err := parsePositiveProjectID(raw)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		projectID = parsed
	}
	limit := 200
	if values, present := query["limit"]; present {
		raw := firstQueryValue(values)
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 500 {
			writeAPIError(w, validationFailure("limit 必须在 1 到 500 之间"))
			return
		}
		limit = parsed
	}
	offset := 0
	if values, present := query["offset"]; present {
		raw := firstQueryValue(values)
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 {
			writeAPIError(w, validationFailure("offset 必须是非负整数"))
			return
		}
		offset = parsed
	}

	all, projectIDs, err := credentialProjectScope(r)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if projectID != nil && !all && !scopeContains(projectIDs, *projectID) {
		writeAPIError(w, &APIError{
			Status:       http.StatusForbidden,
			Code:         agentauth.ErrorCodeAgentProjectOutOfScope,
			Reason:       "project_not_in_scope",
			HumanMessage: "本凭据未被授权访问该项目",
			AgentHint:    "请在 Agent 平台为该 agent 配置项目访问权限",
		})
		return
	}

	filter := TargetListFilter{
		ScopeAll:   all,
		ProjectIDs: projectIDs,
		ProjectID:  projectID,
		Limit:      limit,
		Offset:     offset,
	}
	if marketplacePresent {
		filter.Marketplace = stringPtr(marketplaceValue)
	}
	if _, present := query["kind"]; present {
		filter.Kind = stringPtr(kindValue)
	}
	page, err := h.store.ListTargets(r.Context(), filter)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if page.Items == nil {
		page.Items = []TargetItem{}
	}
	for index := range page.Items {
		if page.Items[index].ExternalShopIDs == nil {
			page.Items[index].ExternalShopIDs = []int64{}
		}
	}
	writeSuccess(w, TargetsResponse{
		Items:      page.Items,
		Total:      page.Total,
		CrawlRules: CrawlRulesValue(),
	}, nil)
}

func (h *Handler) SubmitCrawlRun(w http.ResponseWriter, r *http.Request) {
	if h.store == nil {
		writeAPIError(w, ErrDependencyUnavailable)
		return
	}
	targetID, err := parseTargetID(chi.URLParam(r, "target_id"))
	if err != nil {
		writeAPIError(w, err)
		return
	}
	input, err := decodeCrawlRunInput(w, r)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if err := validateCrawlRunInput(input); err != nil {
		writeAPIError(w, err)
		return
	}
	idempotencyKey, err := resolveIdempotencyKey(r, input)
	if err != nil {
		writeAPIError(w, err)
		return
	}

	var response SubmitCrawlResponse
	err = h.runInTx(r.Context(), func(
		ctx context.Context,
		tx pgx.Tx,
		store Store,
	) error {
		target, getErr := store.GetTargetForUpdate(ctx, targetID)
		if getErr != nil {
			return getErr
		}
		if target == nil || !target.IsActive {
			return ErrResourceNotFound
		}
		if target.ProjectID != nil {
			allowed, scopeErr := projectInCredentialScope(r, *target.ProjectID)
			if scopeErr != nil {
				return scopeErr
			}
			if !allowed {
				return &APIError{
					Status:       http.StatusForbidden,
					Code:         agentauth.ErrorCodeAgentProjectOutOfScope,
					Reason:       "project_not_in_scope",
					HumanMessage: "本凭据未被授权访问该项目",
					AgentHint:    "请在 Agent 平台为该 agent 配置项目访问权限",
				}
			}
		}

		now := h.now().UTC()
		if input.CapturedAt.After(now.Add(FutureTolerance)) {
			return &APIError{
				Status: http.StatusBadRequest,
				Code:   "VALIDATION_FAILED",
				Reason: "captured_at_in_future",
				HumanMessage: fmt.Sprintf(
					"captured_at %s 晚于服务器当前时间 %d 小时",
					input.CapturedAt.Format(time.RFC3339),
					int(FutureTolerance/time.Hour),
				),
				AgentHint: "captured_at 是采集时刻，应为过去时间。请核对客户端时钟与时区偏移（含夏令时）后重试；超限不会写入 run 或快照",
				Details: map[string]any{
					"max_future_seconds": int64(FutureTolerance / time.Second),
				},
			}
		}

		existing, findErr := store.FindRunByIdempotency(
			ctx, targetID, idempotencyKey,
		)
		if findErr != nil {
			return findErr
		}
		if existing == nil {
			latest, latestErr := store.LatestStartedAt(
				ctx, targetID, now.Add(FutureTolerance),
			)
			if latestErr != nil {
				return latestErr
			}
			if latest != nil && !input.CapturedAt.After(*latest) {
				if input.CapturedAt.Equal(*latest) {
					existing, findErr = store.FindRunByIdempotency(
						ctx, targetID, idempotencyKey,
					)
					if findErr != nil {
						return findErr
					}
				}
				if existing == nil {
					return outOfOrderError(*latest, now)
				}
			}
		}

		if existing != nil {
			response = crawlResponse(CrawlResult{
				TargetID:  targetID,
				RunID:     existing.ID,
				Status:    existing.Status,
				StartedAt: existing.StartedAt,
				Replayed:  true,
			})
			return nil
		}

		source := input.Source
		if source == nil || *source == "" {
			source = stringPtr(DefaultSource)
		}
		result, insertErr := store.InsertCrawlResult(ctx, CrawlResultInput{
			TargetID:       targetID,
			CapturedAt:     input.CapturedAt,
			Status:         input.Status,
			Rating:         ratingCapture(input.Rating),
			Reviews:        reviewCaptures(input.Reviews),
			IsCompleteList: input.IsCompleteList.Value,
			IdempotencyKey: idempotencyKey,
			ASINScraped:    input.ASINScraped,
			Source:         source,
			ErrorMessage:   input.ErrorMessage,
		})
		if insertErr != nil {
			return insertErr
		}
		response = crawlResponse(result)
		if response.Replayed {
			return nil
		}

		credential, ok := agentauth.CredentialFromRequest(r)
		if !ok {
			return &APIError{
				Status:       http.StatusUnauthorized,
				Code:         agentauth.ErrorCodeAgentAuthFailed,
				Reason:       agentauth.DetailTokenInvalid,
				HumanMessage: "Agent 鉴权失败",
				AgentHint:    "请确认 Authorization 与 X-Agent-Id 配对正确",
			}
		}
		after := map[string]any{
			"target_id":        targetID,
			"kind":             target.Kind,
			"status":           input.Status,
			"capture_date":     response.CaptureDate,
			"is_complete_list": input.IsCompleteList.Value,
			"reviews_seen":     reviewsSeen(input.Reviews),
			"ratings_captured": input.Rating != nil,
			"asin_scraped":     input.ASINScraped,
		}
		if idempotencyKey == nil {
			after["risk"] = "no_idempotency"
		}
		entry := AuditEntry{
			Action:         "review_tracking.crawl_run",
			TargetType:     "amazon_review_crawl_run",
			TargetID:       stringPtr(strconv.FormatInt(result.RunID, 10)),
			AfterJSON:      after,
			AgentID:        stringPtr(credential.AgentID),
			AgentName:      stringPointerOrNil(credential.Label),
			IdempotencyKey: idempotencyKey,
			RequestMethod:  stringPtr(r.Method),
			RequestPath:    stringPtr(r.URL.Path),
			UserAgent:      optionalTrimmedHeader(r.UserAgent()),
			TraceID:        optionalTrimmedHeader(r.Header.Get("X-Request-ID")),
			IPAddress:      optionalTrimmedHeader(clientIPAddress(r)),
		}
		if err := store.LogAudit(ctx, tx, entry); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	writeSuccess(w, response, idempotencyKey)
}

func (h *Handler) runInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, Store) error,
) error {
	if runner, ok := h.store.(TransactionRunner); ok {
		return runner.RunInTx(ctx, fn)
	}
	return fn(ctx, nil, h.store)
}

func crawlResponse(result CrawlResult) SubmitCrawlResponse {
	startedAt := result.StartedAt
	if startedAt.IsZero() {
		startedAt = time.Now().UTC()
	}
	return SubmitCrawlResponse{
		TargetID:                result.TargetID,
		RunID:                   result.RunID,
		Status:                  result.Status,
		CaptureDate:             BusinessDateString(startedAt),
		SnapshotUpdated:         result.SnapshotUpdated,
		ReviewsUpserted:         result.ReviewsUpserted,
		ReviewsSuspectedRemoved: result.ReviewsSuspectedRemoved,
		Replayed:                result.Replayed,
	}
}

func ratingCapture(input *RatingInput) *RatingCapture {
	if input == nil {
		return nil
	}
	result := &RatingCapture{
		AverageRating:    input.AverageRating,
		RatingCount:      input.RatingCount,
		ReviewCount:      input.ReviewCount,
		StarCountQuality: input.StarCountQuality.Value,
	}
	if input.StarPercentages != nil {
		result.StarPercentages = append([]float64(nil), (*input.StarPercentages)...)
	}
	if input.StarCounts != nil {
		result.StarCounts = append([]int64(nil), (*input.StarCounts)...)
	}
	return result
}

func reviewCaptures(input *[]ReviewInput) *[]ReviewCapture {
	if input == nil {
		return nil
	}
	result := make([]ReviewCapture, 0, len(*input))
	for _, item := range *input {
		result = append(result, ReviewCapture{
			ReviewKey:        item.ReviewKey,
			IDConfidence:     item.IDConfidence,
			Rating:           item.Rating,
			Title:            item.Title,
			Body:             item.Body,
			ReviewerID:       item.ReviewerID,
			ReviewerName:     item.ReviewerName,
			ReviewDate:       item.ReviewDate,
			VerifiedPurchase: item.VerifiedPurchase,
			HelpfulCount:     item.HelpfulCount,
		})
	}
	return &result
}

func resolveIdempotencyKey(request *http.Request, input *CrawlRunInput) (*string, error) {
	var header *string
	if values := request.Header.Values("Idempotency-Key"); len(values) > 0 {
		trimmed := strings.TrimSpace(values[0])
		if trimmed == "" {
			return nil, validationFailure("Idempotency-Key 不能为空字符串")
		}
		if utf8.RuneCountInString(trimmed) > MaxIdempotencyKey {
			return nil, validationFailure(fmt.Sprintf(
				"Idempotency-Key 长度不能超过 %d 字符",
				MaxIdempotencyKey,
			))
		}
		header = stringPtr(trimmed)
	}
	bodyKey := input.IdempotencyKey
	if header != nil && bodyKey != nil && *header != *bodyKey {
		return nil, validationFailure("请求体 idempotency_key 与 Idempotency-Key 头不一致")
	}
	if bodyKey != nil {
		return bodyKey, nil
	}
	return header, nil
}

func credentialProjectScope(request *http.Request) (bool, []int64, error) {
	credential, ok := agentauth.CredentialFromRequest(request)
	if !ok {
		return false, nil, &APIError{
			Status:       http.StatusUnauthorized,
			Code:         agentauth.ErrorCodeAgentAuthFailed,
			Reason:       agentauth.DetailTokenInvalid,
			HumanMessage: "Agent 鉴权失败",
			AgentHint:    "请确认 Authorization 与 X-Agent-Id 配对正确",
		}
	}
	scope := strings.TrimSpace(credential.ProjectScope)
	if scope == "" || scope == agentauth.ScopeAll {
		return true, nil, nil
	}
	ids := make([]int64, 0)
	for _, part := range strings.Split(scope, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		id, err := strconv.ParseInt(part, 10, 64)
		if err != nil || id < 1 {
			return false, nil, &APIError{
				Status:       http.StatusUnauthorized,
				Code:         agentauth.ErrorCodeAgentAuthFailed,
				Reason:       agentauth.DetailTokenInvalid,
				HumanMessage: "凭据 project_scope 配置无效",
				AgentHint:    "请联系管理员重新签发凭据",
			}
		}
		ids = append(ids, id)
	}
	return false, ids, nil
}

func projectInCredentialScope(request *http.Request, projectID int64) (bool, error) {
	all, ids, err := credentialProjectScope(request)
	if err != nil {
		return false, err
	}
	return all || scopeContains(ids, projectID), nil
}

func scopeContains(ids []int64, projectID int64) bool {
	for _, id := range ids {
		if id == projectID {
			return true
		}
	}
	return false
}

func outOfOrderError(latest time.Time, now time.Time) *APIError {
	hint := "请用晚于 details.latest_started_at 的 captured_at 重试；同一业务日重跑用当天更晚的时间点，如需补采历史请先与运营确认（当前态评论表无版本，乱序写入会覆盖现网数据）"
	if latest.After(now) {
		hint = "该目标的采集水位落在未来（最近一次提交的 captured_at 标到了未来），请核对客户端时钟与 tz 偏移；等墙上时钟越过 details.latest_started_at 后即可恢复提交，不要为了通过校验伪造更晚的时间"
	}
	return &APIError{
		Status: http.StatusConflict,
		Code:   ErrorCodeReviewTrackingCaptureOutOfOrder,
		Reason: "captured_at_before_latest_run",
		HumanMessage: fmt.Sprintf(
			"captured_at 早于或等于该目标最近一次采集时间 %s",
			latest.Format(time.RFC3339),
		),
		AgentHint: hint,
		Details: map[string]any{
			"latest_started_at": latest.Format(time.RFC3339),
		},
	}
}

func reviewsSeen(input *[]ReviewInput) any {
	if input == nil {
		return nil
	}
	return len(*input)
}

func clientIPAddress(request *http.Request) string {
	if request == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(request.RemoteAddr))
	if err == nil {
		return host
	}
	return strings.TrimSpace(request.RemoteAddr)
}

func optionalTrimmedHeader(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func stringPointerOrNil(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}
