package crm_intent

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

const (
	defaultAgentCompanyPageSize = 50
	maxAgentCompanyPageSize     = 200
	defaultAgentPoolPageSize    = 50
)

// runAgentWrite enforces the Idempotency-Key contract for all agent writes and
// replays the stored response for duplicate keys (spec §4).
func (handler *Handler) runAgentWrite(
	w http.ResponseWriter,
	r *http.Request,
	handle func(actor Actor, body []byte) (any, error),
) {
	actor, err := agentActor(r)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	key, err := requireIdempotencyKey(r)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	body, readErr := io.ReadAll(io.LimitReader(r.Body, maxUploadBytes+1))
	if readErr != nil {
		writeAgentError(w, internalError())
		return
	}
	if len(body) > maxUploadBytes {
		writeAgentError(w, newValidationError("请求体超过 32MB"))
		return
	}
	hash := sha256Hex(body)
	state, reserveErr := handler.store.ReserveImportRequest(
		r.Context(), ActorKindAgent, actor.ID, key, hash,
	)
	if reserveErr != nil {
		writeAgentError(w, reserveErr)
		return
	}
	if state.Replay {
		if len(state.Response) == 0 {
			writeAgentError(w, ErrIdempotencyInFlight)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(state.Response)
		return
	}
	response, handleErr := handle(actor, body)
	if handleErr != nil {
		_ = handler.store.DeleteImportRequest(r.Context(), ActorKindAgent, actor.ID, key)
		writeAgentError(w, handleErr)
		return
	}
	payload, marshalErr := json.Marshal(response)
	if marshalErr != nil {
		_ = handler.store.DeleteImportRequest(r.Context(), ActorKindAgent, actor.ID, key)
		writeAgentError(w, internalError())
		return
	}
	if err := handler.store.CompleteImportRequest(
		r.Context(), ActorKindAgent, actor.ID, key, payload,
	); err != nil {
		writeAgentError(w, internalError())
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (handler *Handler) AgentHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "domain": BusinessScope, "version": "1",
	})
}

func parseAgentCompanyFilter(r *http.Request) (AgentCompanyFilter, error) {
	page, pageSize, err := parsePageParams(r, defaultAgentCompanyPageSize, maxAgentCompanyPageSize)
	if err != nil {
		return AgentCompanyFilter{}, err
	}
	since, err := optionalQueryTime(r, "since")
	if err != nil {
		return AgentCompanyFilter{}, err
	}
	level := optionalQueryString(r, "level")
	if level != nil && !ValidIntentLevel(*level) {
		return AgentCompanyFilter{}, newValidationError("level 只接受 A/B/C/D")
	}
	state := optionalQueryString(r, "state")
	if state != nil && !ValidFollowupState(*state) {
		return AgentCompanyFilter{}, newValidationError("state 非法")
	}
	humanTouched, err := optionalQueryBool(r, "human_touched")
	if err != nil {
		return AgentCompanyFilter{}, err
	}
	converted, err := optionalQueryBool(r, "converted")
	if err != nil {
		return AgentCompanyFilter{}, err
	}
	batchID, err := optionalQueryInt64(r, "batch_id")
	if err != nil {
		return AgentCompanyFilter{}, err
	}
	return AgentCompanyFilter{
		Page: page, PageSize: pageSize, Since: since, Level: level, State: state,
		Owner: optionalQueryString(r, "owner"), HumanTouched: humanTouched,
		Converted: converted, BatchID: batchID,
	}, nil
}

func (handler *Handler) AgentListCompanies(w http.ResponseWriter, r *http.Request) {
	filter, err := parseAgentCompanyFilter(r)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	result, err := handler.store.AgentListCompanies(r.Context(), filter)
	if err != nil {
		writeAgentError(w, internalError())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (handler *Handler) AgentGetCompany(w http.ResponseWriter, r *http.Request) {
	companyID, err := parsePathID(r, "company_id")
	if err != nil {
		writeAgentError(w, err)
		return
	}
	item, err := handler.store.AgentGetCompany(r.Context(), companyID)
	if err != nil {
		writeAgentError(w, internalError())
		return
	}
	if item == nil {
		writeAgentError(w, NewNotFoundError("公司", companyID))
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) AgentCreateCompany(w http.ResponseWriter, r *http.Request) {
	handler.runAgentWrite(w, r, func(actor Actor, body []byte) (any, error) {
		var input CompanyInput
		if err := decodeStrictObject(body, companyImportFields, companyBannedFields, &input); err != nil {
			return nil, err
		}
		normalized, err := NormalizeCompanyInput(&input, true)
		if err != nil {
			return nil, err
		}
		return handler.store.AgentUpsertCompany(
			r.Context(), *normalized, ModeUpsert, actor,
		)
	})
}

func (handler *Handler) AgentPatchCompany(w http.ResponseWriter, r *http.Request) {
	companyID, err := parsePathID(r, "company_id")
	if err != nil {
		writeAgentError(w, err)
		return
	}
	handler.runAgentWrite(w, r, func(actor Actor, body []byte) (any, error) {
		var input AgentCompanyPatch
		if err := decodeStrictObject(body, companyPatchFields, companyBannedFields, &input); err != nil {
			return nil, err
		}
		if input.IntentLevel != nil {
			level := strings.ToUpper(strings.TrimSpace(*input.IntentLevel))
			if !ValidIntentLevel(level) {
				return nil, newValidationError("intent_level 只接受 A/B/C/D")
			}
			input.IntentLevel = &level
		}
		if input.IntentScore != nil && (*input.IntentScore < 0 || *input.IntentScore > 100) {
			return nil, newValidationError("intent_score 必须在 0 到 100 之间")
		}
		if input.ScreenedAt != nil {
			parsed, parseErr := ParseDateTime(*input.ScreenedAt)
			if parseErr != nil {
				return nil, newValidationError("screened_at 必须是 YYYY-MM-DD")
			}
			formatted := parsed.In(shanghaiLocation()).Format("2006-01-02")
			input.ScreenedAt = &formatted
		}
		if input.Sources != nil {
			values := filterHTTPSources(*input.Sources)
			input.Sources = &values
		}
		return handler.store.AgentPatchCompany(r.Context(), companyID, input, actor)
	})
}

func parseAgentPoolFilter(r *http.Request) (PoolFilter, error) {
	page, pageSize, err := parsePageParams(r, defaultAgentPoolPageSize, 200)
	if err != nil {
		return PoolFilter{}, err
	}
	status := optionalQueryString(r, "status")
	if status != nil && !ValidPoolStatus(*status) {
		return PoolFilter{}, newValidationError("status 只接受 pending / screened / ignored")
	}
	batchID, err := optionalQueryInt64(r, "batch_id")
	if err != nil {
		return PoolFilter{}, err
	}
	since, err := optionalQueryTime(r, "since")
	if err != nil {
		return PoolFilter{}, err
	}
	return PoolFilter{
		Query: optionalQueryString(r, "q"), Status: status, BatchID: batchID,
		Since: since, Page: page, PageSize: pageSize,
	}, nil
}

func (handler *Handler) AgentListPool(w http.ResponseWriter, r *http.Request) {
	filter, err := parseAgentPoolFilter(r)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	result, err := handler.store.ListPool(r.Context(), filter)
	if err != nil {
		writeAgentError(w, internalError())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (handler *Handler) AgentUpdatePool(w http.ResponseWriter, r *http.Request) {
	poolID, err := parsePathID(r, "pool_id")
	if err != nil {
		writeAgentError(w, err)
		return
	}
	handler.runAgentWrite(w, r, func(actor Actor, body []byte) (any, error) {
		allowed := map[string]bool{
			"status": true, "channel": true, "channels": true,
			"channel_source": true, "website": true, "legal_person": true,
		}
		var input AgentPoolUpdate
		if err := decodeStrictObject(body, allowed, companyBannedFields, &input); err != nil {
			return nil, err
		}
		return handler.store.AgentUpdatePool(r.Context(), poolID, input, actor)
	})
}

func (handler *Handler) AgentScreenPool(w http.ResponseWriter, r *http.Request) {
	poolID, err := parsePathID(r, "pool_id")
	if err != nil {
		writeAgentError(w, err)
		return
	}
	handler.runAgentWrite(w, r, func(actor Actor, body []byte) (any, error) {
		var envelope struct {
			Company json.RawMessage `json:"company"`
		}
		if err := decodeStrictObject(body, map[string]bool{"company": true}, companyBannedFields, &envelope); err != nil {
			return nil, err
		}
		if len(envelope.Company) == 0 {
			return nil, newValidationError("缺少 company 字段")
		}
		var input CompanyInput
		if err := decodeStrictObject(envelope.Company, companyImportFields, companyBannedFields, &input); err != nil {
			return nil, err
		}
		normalized, err := NormalizeCompanyInput(&input, true)
		if err != nil {
			return nil, err
		}
		return handler.store.AgentScreenPool(r.Context(), poolID, *normalized, actor)
	})
}

func (handler *Handler) AgentListBatches(w http.ResponseWriter, r *http.Request) {
	page, pageSize, err := parsePageParams(r, defaultBatchPageSize, 100)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	result, err := handler.store.ListBatches(r.Context(), page, pageSize)
	if err != nil {
		writeAgentError(w, internalError())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (handler *Handler) AgentGetBatch(w http.ResponseWriter, r *http.Request) {
	batchID, err := parsePathID(r, "batch_id")
	if err != nil {
		writeAgentError(w, err)
		return
	}
	batch, err := handler.store.GetBatch(r.Context(), batchID)
	if err != nil {
		writeAgentError(w, internalError())
		return
	}
	if batch == nil {
		writeAgentError(w, NewNotFoundError("批次", batchID))
		return
	}
	if batch.Rows == nil {
		batch.Rows = []BatchRow{}
	}
	if batch.Rejected == nil {
		batch.Rejected = []RejectedRow{}
	}
	writeJSON(w, http.StatusOK, batch)
}
