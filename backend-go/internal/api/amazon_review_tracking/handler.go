package amazon_review_tracking

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const maxJSONBodyBytes = 2 << 20

var (
	asinPattern  = regexp.MustCompile(`^[A-Z0-9]{10}$`)
	marketplaces = map[string]bool{
		"US": true, "CA": true, "UK": true, "DE": true, "FR": true,
		"IT": true, "ES": true, "JP": true, "AU": true, "MX": true,
		"BR": true, "NL": true, "SE": true, "PL": true, "BE": true,
		"IN": true, "SG": true, "AE": true, "SA": true, "TR": true,
		"EG": true,
	}
)

type Handler struct {
	store            Store
	auditor          audit.Service
	sessionValidator SessionValidator
}

type requestSession struct {
	UserID   string
	Operator string
	IsAdmin  bool
}

type ExternalLinkCreateInput struct {
	ShopID int64 `json:"shop_id"`
}

type Option func(*Handler)

func WithSessionValidator(validator SessionValidator) Option {
	return func(handler *Handler) {
		handler.sessionValidator = validator
	}
}

func NewHandler(store Store, auditor audit.Service, options ...Option) *Handler {
	handler := &Handler{store: store, auditor: auditor}
	for _, option := range options {
		if option != nil {
			option(handler)
		}
	}
	return handler
}

func (h *Handler) ListGroups(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r, true)
	if !ok {
		return
	}
	_ = session

	projectID, err := parseOptionalIntQuery(r, "project_id", 1, 0)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	marketplace := optionalQueryString(r, "marketplace")
	if marketplace != nil {
		normalized := strings.ToUpper(strings.TrimSpace(*marketplace))
		marketplace = &normalized
	}
	isActive, validationErr := httpapi.ParseOptionalBoolQuery(r, "is_active")
	if validationErr != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, validationErr.Msg)
		return
	}

	items, storeErr := h.store.ListGroups(r.Context(), GroupListFilter{
		ProjectID: projectID, Marketplace: marketplace, IsActive: isActive,
	})
	if storeErr != nil {
		WriteError(w, storeErr)
		return
	}
	writeJSON(w, http.StatusOK, ensureSlice(items))
}

func (h *Handler) CreateReviewGroup(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r, true)
	if !ok {
		return
	}
	input, decodeErr := decodeReviewGroupCreate(w, r)
	if decodeErr != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, decodeErr.Error())
		return
	}
	if err := validateReviewGroupCreate(input); err != nil {
		WriteError(w, err)
		return
	}
	if h.auditor == nil {
		httpapi.WriteInternalServerError(w)
		return
	}

	var result *ReviewGroupItem
	txErr := h.store.RunInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		var createErr error
		result, createErr = txStore.CreateGroup(ctx, *input)
		if createErr != nil {
			return createErr
		}
		entry := audit.Entry{
			Action:     "amazon_review_tracking.group.create",
			TargetType: "amazon_review_group",
			TargetID:   stringPointer(strconv.FormatInt(result.ID, 10)),
			Operator:   optionalString(session.Operator),
			AfterJSON:  result,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		return h.auditor.LogActionTx(ctx, tx, entry)
	})
	if txErr != nil {
		WriteError(w, txErr)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (h *Handler) PatchReviewGroup(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r, true)
	if !ok {
		return
	}
	groupID, ok := parsePathID(w, r, "group_id", "group_id")
	if !ok {
		return
	}
	input, decodeErr := decodeReviewGroupPatch(w, r)
	if decodeErr != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, decodeErr.Error())
		return
	}
	if h.auditor == nil {
		httpapi.WriteInternalServerError(w)
		return
	}

	var mutation *ReviewGroupMutation
	txErr := h.store.RunInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		var patchErr error
		mutation, patchErr = txStore.PatchGroup(ctx, groupID, *input)
		if patchErr != nil {
			return patchErr
		}
		entry := audit.Entry{
			Action:     "amazon_review_tracking.group.update",
			TargetType: "amazon_review_group",
			TargetID:   stringPointer(strconv.FormatInt(groupID, 10)),
			Operator:   optionalString(session.Operator),
			BeforeJSON: mutation.Before,
			AfterJSON:  mutation.After,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		return h.auditor.LogActionTx(ctx, tx, entry)
	})
	if txErr != nil {
		WriteError(w, txErr)
		return
	}
	writeJSON(w, http.StatusOK, mutation.After)
}

func (h *Handler) DeactivateReviewGroup(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r, true)
	if !ok {
		return
	}
	groupID, ok := parsePathID(w, r, "group_id", "group_id")
	if !ok {
		return
	}
	if h.auditor == nil {
		httpapi.WriteInternalServerError(w)
		return
	}

	var mutation *ReviewGroupMutation
	txErr := h.store.RunInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		var deactivateErr error
		mutation, deactivateErr = txStore.DeactivateGroup(ctx, groupID)
		if deactivateErr != nil {
			return deactivateErr
		}
		entry := audit.Entry{
			Action:     "amazon_review_tracking.group.deactivate",
			TargetType: "amazon_review_group",
			TargetID:   stringPointer(strconv.FormatInt(groupID, 10)),
			Operator:   optionalString(session.Operator),
			BeforeJSON: mutation.Before,
			AfterJSON:  mutation.After,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		return h.auditor.LogActionTx(ctx, tx, entry)
	})
	if txErr != nil {
		WriteError(w, txErr)
		return
	}
	writeJSON(w, http.StatusOK, mutation.After)
}

func (h *Handler) ListTargets(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r, false)
	if !ok {
		return
	}
	projectID, err := parseOptionalIntQuery(r, "project_id", 1, 0)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	marketplace := optionalQueryString(r, "marketplace")
	if marketplace != nil {
		normalized := strings.ToUpper(strings.TrimSpace(*marketplace))
		marketplace = &normalized
	}
	kind := optionalQueryString(r, "kind")
	isActive, validationErr := httpapi.ParseOptionalBoolQuery(r, "is_active")
	if validationErr != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, validationErr.Msg)
		return
	}
	limit, err := parsePaginationQuery(r, "limit", 200, 1, 1000)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	offset, err := parsePaginationQuery(r, "offset", 0, 0, 0)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}

	items, storeErr := h.store.ListTargets(r.Context(), TargetListFilter{
		ProjectID: projectID, Marketplace: marketplace, Kind: kind,
		IsActive: isActive, Limit: limit, Offset: offset,
		Operator: session.Operator, IsAdmin: session.IsAdmin,
	})
	if storeErr != nil {
		WriteError(w, storeErr)
		return
	}
	writeJSON(w, http.StatusOK, ensureSlice(items))
}

func (h *Handler) ListRatingSnapshots(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r, false)
	if !ok {
		return
	}
	targetID, ok := parsePathID(w, r, "target_id", "target_id")
	if !ok {
		return
	}
	dateFrom, err := parseOptionalDateQuery(r, "from")
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	dateTo, err := parseOptionalDateQuery(r, "to")
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	limit, err := parsePaginationQuery(r, "limit", 200, 1, 1000)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	offset, err := parsePaginationQuery(r, "offset", 0, 0, 0)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}

	items, storeErr := h.store.ListRatingSnapshots(r.Context(), RatingSnapshotFilter{
		TargetID: targetID, DateFrom: dateFrom, DateTo: dateTo,
		Limit: limit, Offset: offset, Operator: session.Operator, IsAdmin: session.IsAdmin,
	})
	if storeErr != nil {
		WriteError(w, storeErr)
		return
	}
	writeJSON(w, http.StatusOK, ensureSlice(items))
}

func (h *Handler) ListReviews(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r, false)
	if !ok {
		return
	}
	targetID, ok := parsePathID(w, r, "target_id", "target_id")
	if !ok {
		return
	}
	visibilityStatus := optionalQueryString(r, "visibility_status")
	reviewDateFrom, err := parseOptionalDateQuery(r, "review_date_from")
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	reviewDateTo, err := parseOptionalDateQuery(r, "review_date_to")
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	limit, err := parsePaginationQuery(r, "limit", 100, 1, 500)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	offset, err := parsePaginationQuery(r, "offset", 0, 0, 0)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}

	items, storeErr := h.store.ListReviews(r.Context(), ReviewFilter{
		TargetID: targetID, VisibilityStatus: visibilityStatus,
		ReviewDateFrom: reviewDateFrom, ReviewDateTo: reviewDateTo,
		Limit: limit, Offset: offset, Operator: session.Operator, IsAdmin: session.IsAdmin,
	})
	if storeErr != nil {
		WriteError(w, storeErr)
		return
	}
	writeJSON(w, http.StatusOK, ensureSlice(items))
}

func (h *Handler) ListRuns(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r, false)
	if !ok {
		return
	}
	targetID, ok := parsePathID(w, r, "target_id", "target_id")
	if !ok {
		return
	}
	limit, err := parsePaginationQuery(r, "limit", 50, 1, 200)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	offset, err := parsePaginationQuery(r, "offset", 0, 0, 0)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}

	items, storeErr := h.store.ListRuns(r.Context(), CrawlRunFilter{
		TargetID: targetID, Limit: limit, Offset: offset,
		Operator: session.Operator, IsAdmin: session.IsAdmin,
	})
	if storeErr != nil {
		WriteError(w, storeErr)
		return
	}
	writeJSON(w, http.StatusOK, ensureSlice(items))
}

func (h *Handler) ListExternalTargets(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r, false)
	if !ok {
		return
	}
	_ = session
	limit, err := parsePaginationQuery(r, "limit", 200, 1, 1000)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	offset, err := parsePaginationQuery(r, "offset", 0, 0, 0)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	items, storeErr := h.store.ListExternalTargets(r.Context(), limit, offset)
	if storeErr != nil {
		WriteError(w, storeErr)
		return
	}
	writeJSON(w, http.StatusOK, ensureSlice(items))
}

func (h *Handler) CreateExternalTarget(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r, true)
	if !ok {
		return
	}
	input, decodeErr := decodeExternalTargetCreate(w, r)
	if decodeErr != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, decodeErr.Error())
		return
	}
	if err := validateExternalTargetCreate(input); err != nil {
		WriteError(w, err)
		return
	}
	if h.auditor == nil {
		httpapi.WriteInternalServerError(w)
		return
	}

	var result *ExternalTargetItem
	txErr := h.store.RunInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		var createErr error
		result, createErr = txStore.CreateExternalTarget(ctx, *input)
		if createErr != nil {
			return createErr
		}
		entry := audit.Entry{
			Action:     "amazon_review_tracking.external_target.create",
			TargetType: "amazon_review_target",
			TargetID:   stringPointer(strconv.FormatInt(result.ID, 10)),
			Operator:   optionalString(session.Operator),
			AfterJSON:  result,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		return h.auditor.LogActionTx(ctx, tx, entry)
	})
	if txErr != nil {
		WriteError(w, txErr)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (h *Handler) CreateExternalLink(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r, true)
	if !ok {
		return
	}
	targetID, ok := parsePathID(w, r, "target_id", "target_id")
	if !ok {
		return
	}
	var input ExternalLinkCreateInput
	if err := decodeJSON(w, r, &input); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	if input.ShopID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "shop_id must be a positive integer")
		return
	}
	if h.auditor == nil {
		httpapi.WriteInternalServerError(w)
		return
	}

	var result *ExternalLinkItem
	txErr := h.store.RunInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		var linkErr error
		result, linkErr = txStore.AddExternalLink(ctx, targetID, input.ShopID)
		if linkErr != nil {
			return linkErr
		}
		entry := audit.Entry{
			Action:     "amazon_review_tracking.external_link.add",
			TargetType: "amazon_review_external_link",
			TargetID:   stringPointer(strconv.FormatInt(result.ID, 10)),
			Operator:   optionalString(session.Operator),
			AfterJSON:  result,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		return h.auditor.LogActionTx(ctx, tx, entry)
	})
	if txErr != nil {
		WriteError(w, txErr)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (h *Handler) DeleteExternalLink(w http.ResponseWriter, r *http.Request) {
	session, ok := h.requireSession(w, r, true)
	if !ok {
		return
	}
	targetID, ok := parsePathID(w, r, "target_id", "target_id")
	if !ok {
		return
	}
	linkID, ok := parsePathID(w, r, "link_id", "link_id")
	if !ok {
		return
	}
	if h.auditor == nil {
		httpapi.WriteInternalServerError(w)
		return
	}

	var result *ExternalLinkItem
	txErr := h.store.RunInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		var linkErr error
		result, linkErr = txStore.RemoveExternalLink(ctx, targetID, linkID)
		if linkErr != nil {
			return linkErr
		}
		entry := audit.Entry{
			Action:     "amazon_review_tracking.external_link.remove",
			TargetType: "amazon_review_external_link",
			TargetID:   stringPointer(strconv.FormatInt(result.ID, 10)),
			Operator:   optionalString(session.Operator),
			AfterJSON:  result,
			Result:     "success",
		}
		entry.PopulateFromRequest(r)
		return h.auditor.LogActionTx(ctx, tx, entry)
	})
	if txErr != nil {
		WriteError(w, txErr)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) requireSession(
	w http.ResponseWriter,
	r *http.Request,
	adminOnly bool,
) (requestSession, bool) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}
	userID := strings.TrimSpace(identity.UserID)
	sessionID := strings.TrimSpace(identity.SessionID)
	if userID == "" || sessionID == "" {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Not authenticated")
		return requestSession{}, false
	}
	if h.sessionValidator != nil {
		valid, err := h.sessionValidator.ValidateSession(r.Context(), userID, sessionID)
		if err != nil || !valid {
			httpapi.WriteDetail(w, http.StatusUnauthorized, "Session revoked")
			return requestSession{}, false
		}
	}

	account, err := h.store.GetSessionAccount(r.Context(), userID)
	if err != nil {
		WriteError(w, err)
		return requestSession{}, false
	}
	if account == nil || !account.IsActive {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Not authenticated")
		return requestSession{}, false
	}
	if !account.IsAdmin && account.RoleType != "operator" {
		httpapi.WriteDetail(w, http.StatusForbidden, "需要运营或管理员权限")
		return requestSession{}, false
	}
	if adminOnly && !account.IsAdmin {
		httpapi.WriteDetail(w, http.StatusForbidden, "需要管理员权限")
		return requestSession{}, false
	}
	return requestSession{
		UserID:   userID,
		Operator: strings.TrimSpace(identity.Operator),
		IsAdmin:  account.IsAdmin,
	}, true
}

func decodeReviewGroupCreate(w http.ResponseWriter, r *http.Request) (*ReviewGroupCreateInput, error) {
	var input ReviewGroupCreateInput
	if err := decodeJSON(w, r, &input); err != nil {
		return nil, err
	}
	return &input, nil
}

func validateReviewGroupCreate(input *ReviewGroupCreateInput) error {
	if input.ProjectID <= 0 {
		return NewError(http.StatusUnprocessableEntity, "project_id must be a positive integer")
	}
	marketplace, err := normalizeMarketplace(input.Marketplace)
	if err != nil {
		return err
	}
	input.Marketplace = marketplace
	name := strings.TrimSpace(input.Name)
	if name == "" || utf8.RuneCountInString(name) > 255 {
		return NewError(http.StatusUnprocessableEntity, "invalid name")
	}
	input.Name = name
	if err := validateMemberIDs(input.MemberIDs); err != nil {
		return err
	}
	if input.RepresentativeID <= 0 {
		return NewError(http.StatusUnprocessableEntity, "representative_id must be a positive integer")
	}
	if !containsInt64(input.MemberIDs, input.RepresentativeID) {
		return NewError(http.StatusUnprocessableEntity, "representative must be a member")
	}
	return nil
}

func decodeExternalTargetCreate(w http.ResponseWriter, r *http.Request) (*ExternalTargetCreateInput, error) {
	var input ExternalTargetCreateInput
	if err := decodeJSON(w, r, &input); err != nil {
		return nil, err
	}
	return &input, nil
}

func validateExternalTargetCreate(input *ExternalTargetCreateInput) error {
	marketplace, err := normalizeMarketplace(input.Marketplace)
	if err != nil {
		return err
	}
	input.Marketplace = marketplace
	asin := strings.ToUpper(strings.TrimSpace(input.ASIN))
	if !asinPattern.MatchString(asin) {
		return NewError(http.StatusUnprocessableEntity, "asin must be 10 alphanumeric characters")
	}
	input.ASIN = asin
	if input.ShopID != nil && *input.ShopID <= 0 {
		return NewError(http.StatusUnprocessableEntity, "shop_id must be a positive integer")
	}
	if input.DisplayName != nil {
		displayName := strings.TrimSpace(*input.DisplayName)
		if utf8.RuneCountInString(displayName) > 255 {
			return NewError(http.StatusUnprocessableEntity, "display_name must be at most 255 characters")
		}
		if displayName == "" {
			input.DisplayName = nil
		} else {
			input.DisplayName = &displayName
		}
	}
	return nil
}

func decodeReviewGroupPatch(w http.ResponseWriter, r *http.Request) (*ReviewGroupPatchInput, error) {
	raw, err := decodeJSONMap(w, r)
	if err != nil {
		return nil, err
	}
	allowed := map[string]bool{
		"name": true, "description": true, "member_ids": true, "representative_id": true,
	}
	for key := range raw {
		if !allowed[key] {
			return nil, errors.New("extra fields are not permitted")
		}
	}
	if len(raw) == 0 {
		return nil, errors.New("at least one update field is required")
	}

	input := &ReviewGroupPatchInput{}
	if value, present := raw["name"]; present {
		if isJSONNull(value) {
			return nil, errors.New("name cannot be null")
		}
		var name string
		if err := json.Unmarshal(value, &name); err != nil {
			return nil, errors.New("name must be a string")
		}
		name = strings.TrimSpace(name)
		if name == "" || utf8.RuneCountInString(name) > 255 {
			return nil, errors.New("invalid name")
		}
		input.Name = &name
	}
	if value, present := raw["description"]; present {
		input.DescriptionSet = true
		if isJSONNull(value) {
			input.Description = nil
		} else {
			var description string
			if err := json.Unmarshal(value, &description); err != nil {
				return nil, errors.New("description must be a string or null")
			}
			input.Description = &description
		}
	}
	if value, present := raw["member_ids"]; present {
		if isJSONNull(value) {
			return nil, errors.New("member_ids cannot be null")
		}
		var memberIDs []int64
		if err := json.Unmarshal(value, &memberIDs); err != nil {
			return nil, errors.New("member_ids must be an array of integers")
		}
		if err := validateMemberIDs(memberIDs); err != nil {
			return nil, err
		}
		input.MemberIDs = memberIDs
		input.MemberIDsSet = true
	}
	if value, present := raw["representative_id"]; present {
		if isJSONNull(value) {
			return nil, errors.New("representative_id cannot be null")
		}
		var representativeID int64
		if err := json.Unmarshal(value, &representativeID); err != nil {
			return nil, errors.New("representative_id must be an integer")
		}
		if representativeID <= 0 {
			return nil, errors.New("representative_id must be a positive integer")
		}
		input.RepresentativeID = &representativeID
	}
	return input, nil
}

func validateMemberIDs(ids []int64) error {
	if len(ids) == 0 {
		return NewError(http.StatusUnprocessableEntity, "member_ids must contain at least 1 entry")
	}
	seen := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if id <= 0 {
			return NewError(http.StatusUnprocessableEntity, "member_ids must contain positive integers")
		}
		if seen[id] {
			return NewError(http.StatusUnprocessableEntity, "duplicate member IDs")
		}
		seen[id] = true
	}
	return nil
}

func normalizeMarketplace(value string) (string, error) {
	normalized := strings.ToUpper(strings.TrimSpace(value))
	if utf8.RuneCountInString(normalized) < 2 || utf8.RuneCountInString(normalized) > 20 {
		return "", NewError(http.StatusUnprocessableEntity, "unsupported Marketplace")
	}
	if !marketplaces[normalized] {
		return "", NewError(http.StatusUnprocessableEntity, "unsupported Marketplace")
	}
	return normalized, nil
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) error {
	if r.Body == nil {
		return errors.New("Invalid request body")
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodyBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return errors.New("Invalid request body")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("Invalid request body")
	}
	return nil
}

func decodeJSONMap(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, error) {
	var raw map[string]json.RawMessage
	if err := decodeJSON(w, r, &raw); err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, errors.New("Invalid request body")
	}
	return raw, nil
}

func parsePathID(
	w http.ResponseWriter,
	r *http.Request,
	param string,
	field string,
) (int64, bool) {
	value, err := strconv.ParseInt(chi.URLParam(r, param), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid "+field)
		return 0, false
	}
	return value, true
}

func parseOptionalIntQuery(r *http.Request, name string, minimum, maximum int64) (*int64, error) {
	param, validationErr := httpapi.ParseIntegerQuery(r, name)
	if validationErr != nil {
		return nil, errors.New(validationErr.Msg)
	}
	if !param.Present {
		return nil, nil
	}
	if !param.Value.IsInt64() {
		return nil, errors.New(name + " must be a valid integer")
	}
	value := param.Value.Int64()
	if value < minimum {
		return nil, errors.New(name + " must be greater than or equal to " + strconv.FormatInt(minimum, 10))
	}
	if maximum > 0 && value > maximum {
		return nil, errors.New(name + " must be less than or equal to " + strconv.FormatInt(maximum, 10))
	}
	return &value, nil
}

func parsePaginationQuery(
	r *http.Request,
	name string,
	defaultValue int64,
	minimum int64,
	maximum int64,
) (int64, error) {
	value, err := parseOptionalIntQuery(r, name, minimum, maximum)
	if err != nil {
		return 0, err
	}
	if value == nil {
		return defaultValue, nil
	}
	return *value, nil
}

func parseOptionalDateQuery(r *http.Request, name string) (*time.Time, error) {
	values, present := r.URL.Query()[name]
	if !present {
		return nil, nil
	}
	raw := ""
	if len(values) > 0 {
		raw = values[len(values)-1]
	}
	value, err := time.Parse("2006-01-02", raw)
	if err != nil {
		return nil, errors.New(name + " must be a valid date")
	}
	return &value, nil
}

func optionalQueryString(r *http.Request, name string) *string {
	values, present := r.URL.Query()[name]
	if !present {
		return nil
	}
	raw := ""
	if len(values) > 0 {
		raw = values[len(values)-1]
	}
	return &raw
}

func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func containsInt64(items []int64, wanted int64) bool {
	for _, item := range items {
		if item == wanted {
			return true
		}
	}
	return false
}

func optionalString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func stringPointer(value string) *string {
	return &value
}

func ensureSlice[T any](items []T) []T {
	if items == nil {
		return []T{}
	}
	return items
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	if err := httpapi.WriteJSON(w, status, value); err != nil {
		httpapi.WriteInternalServerError(w)
	}
}
