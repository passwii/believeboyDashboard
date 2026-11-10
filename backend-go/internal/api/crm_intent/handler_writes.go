package crm_intent

import (
	"net/http"
	"strconv"
	"strings"
)

func requireUserIdentity(actor Actor) error {
	if strings.TrimSpace(actor.ID) == "" {
		return NewDomainError(http.StatusUnauthorized, "", "Not authenticated")
	}
	return nil
}

func parseIfMatchVersion(r *http.Request) (*int, error) {
	raw := strings.TrimSpace(r.Header.Get("If-Match"))
	if raw == "" {
		return nil, nil
	}
	raw = strings.TrimPrefix(raw, "W/")
	raw = strings.Trim(raw, "\"")
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 {
		return nil, newValidationError("If-Match 必须是版本号")
	}
	return &value, nil
}

type followupBody struct {
	State         Optional[string]   `json:"state"`
	Note          Optional[string]   `json:"note"`
	LastContactAt Optional[string]   `json:"last_contact_at"`
	NextContactAt Optional[string]   `json:"next_contact_at"`
	ValidPhones   Optional[[]string] `json:"valid_phones"`
	Version       Optional[int]      `json:"version"`
}

func (handler *Handler) UpdateFollowup(w http.ResponseWriter, r *http.Request) {
	actor := requestActor(r)
	if err := requireUserIdentity(actor); err != nil {
		writeUserError(w, err)
		return
	}
	companyID, err := parsePathID(r, "company_id")
	if err != nil {
		writeUserError(w, err)
		return
	}
	ifMatch, err := parseIfMatchVersion(r)
	if err != nil {
		writeUserError(w, err)
		return
	}
	var body followupBody
	if err := decodeJSONBody(r, &body); err != nil {
		writeUserError(w, err)
		return
	}
	expected := ifMatch
	if body.Version.Set {
		if body.Version.Value == nil {
			writeUserError(w, newValidationError("version 不能为空"))
			return
		}
		if expected != nil && *expected != *body.Version.Value {
			writeUserError(w, newValidationError("If-Match 与 body.version 不一致"))
			return
		}
		expected = body.Version.Value
	}
	write := FollowupWrite{ExpectedVersion: expected}
	if body.State.Set {
		if body.State.Value == nil || !ValidFollowupState(*body.State.Value) {
			writeUserError(w, newValidationError("state 非法"))
			return
		}
		write.State = body.State.Value
	}
	if body.Note.Set {
		note := ""
		if body.Note.Value != nil {
			note = *body.Note.Value
		}
		write.Note = &note
	}
	if body.LastContactAt.Set {
		if body.LastContactAt.Value == nil || strings.TrimSpace(*body.LastContactAt.Value) == "" {
			write.LastContactAt = OptionalTime{Set: true}
		} else {
			parsed, parseErr := ParseDateTime(*body.LastContactAt.Value)
			if parseErr != nil {
				writeUserError(w, newValidationError("last_contact_at 必须是合法时间"))
				return
			}
			write.LastContactAt = OptionalTime{Set: true, Value: parsed}
		}
	}
	if body.NextContactAt.Set {
		if body.NextContactAt.Value == nil || strings.TrimSpace(*body.NextContactAt.Value) == "" {
			write.NextContactAt = OptionalTime{Set: true}
		} else {
			parsed, parseErr := ParseDateTime(*body.NextContactAt.Value)
			if parseErr != nil {
				writeUserError(w, newValidationError("next_contact_at 必须是合法时间"))
				return
			}
			write.NextContactAt = OptionalTime{Set: true, Value: parsed}
		}
	}
	if body.ValidPhones.Set {
		values := []string{}
		if body.ValidPhones.Value != nil {
			values = *body.ValidPhones.Value
		}
		write.ValidPhones = &values
	}
	followup, err := handler.store.UpdateFollowup(r.Context(), companyID, write, actor)
	if err != nil {
		writeUserError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, followup)
}

func (handler *Handler) ClaimCompany(w http.ResponseWriter, r *http.Request) {
	actor := requestActor(r)
	if err := requireUserIdentity(actor); err != nil {
		writeUserError(w, err)
		return
	}
	companyID, err := parsePathID(r, "company_id")
	if err != nil {
		writeUserError(w, err)
		return
	}
	company, err := handler.store.ClaimCompany(r.Context(), companyID, actor)
	if err != nil {
		writeUserError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, company)
}

func (handler *Handler) UpdateProfile(w http.ResponseWriter, r *http.Request) {
	actor := requestActor(r)
	if err := requireUserIdentity(actor); err != nil {
		writeUserError(w, err)
		return
	}
	companyID, err := parsePathID(r, "company_id")
	if err != nil {
		writeUserError(w, err)
		return
	}
	var input ProfileUpdateInput
	if err := decodeJSONBody(r, &input); err != nil {
		writeUserError(w, err)
		return
	}
	company, err := handler.store.UpdateProfile(r.Context(), companyID, input, actor)
	if err != nil {
		writeUserError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, company)
}

type phoneCreateBody struct {
	PhoneRaw string  `json:"phone_raw"`
	Phone    string  `json:"phone"`
	Source   *string `json:"source"`
	IsValid  bool    `json:"is_valid"`
}

func (handler *Handler) AddPhone(w http.ResponseWriter, r *http.Request) {
	actor := requestActor(r)
	if err := requireUserIdentity(actor); err != nil {
		writeUserError(w, err)
		return
	}
	companyID, err := parsePathID(r, "company_id")
	if err != nil {
		writeUserError(w, err)
		return
	}
	var body phoneCreateBody
	if err := decodeJSONBody(r, &body); err != nil {
		writeUserError(w, err)
		return
	}
	raw := strings.TrimSpace(body.PhoneRaw)
	if raw == "" {
		raw = strings.TrimSpace(body.Phone)
	}
	if raw == "" {
		writeUserError(w, newValidationError("phone_raw 不能为空"))
		return
	}
	source := PhoneSourceManual
	if body.Source != nil && strings.TrimSpace(*body.Source) != "" {
		source = strings.TrimSpace(*body.Source)
	}
	company, err := handler.store.AddPhone(r.Context(), companyID, PhoneCreate{
		PhoneRaw: raw, Source: source, IsValid: body.IsValid,
	}, actor)
	if err != nil {
		writeUserError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, company)
}

type phoneUpdateBody struct {
	PhoneRaw Optional[string] `json:"phone_raw"`
	Phone    Optional[string] `json:"phone"`
	IsValid  Optional[bool]   `json:"is_valid"`
}

func (handler *Handler) UpdatePhone(w http.ResponseWriter, r *http.Request) {
	actor := requestActor(r)
	if err := requireUserIdentity(actor); err != nil {
		writeUserError(w, err)
		return
	}
	companyID, err := parsePathID(r, "company_id")
	if err != nil {
		writeUserError(w, err)
		return
	}
	phoneID, err := parsePathID(r, "phone_id")
	if err != nil {
		writeUserError(w, err)
		return
	}
	var body phoneUpdateBody
	if err := decodeJSONBody(r, &body); err != nil {
		writeUserError(w, err)
		return
	}
	input := PhoneUpdate{IsValid: body.IsValid}
	if body.PhoneRaw.Set {
		input.PhoneRaw = body.PhoneRaw
	} else if body.Phone.Set {
		input.PhoneRaw = body.Phone
	}
	company, err := handler.store.UpdatePhone(r.Context(), companyID, phoneID, input, actor)
	if err != nil {
		writeUserError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, company)
}

func (handler *Handler) DeletePhone(w http.ResponseWriter, r *http.Request) {
	actor := requestActor(r)
	if err := requireUserIdentity(actor); err != nil {
		writeUserError(w, err)
		return
	}
	companyID, err := parsePathID(r, "company_id")
	if err != nil {
		writeUserError(w, err)
		return
	}
	phoneID, err := parsePathID(r, "phone_id")
	if err != nil {
		writeUserError(w, err)
		return
	}
	company, err := handler.store.DeletePhone(r.Context(), companyID, phoneID, actor)
	if err != nil {
		writeUserError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, company)
}

func (handler *Handler) ConvertCompany(w http.ResponseWriter, r *http.Request) {
	actor := requestActor(r)
	if err := requireUserIdentity(actor); err != nil {
		writeUserError(w, err)
		return
	}
	companyID, err := parsePathID(r, "company_id")
	if err != nil {
		writeUserError(w, err)
		return
	}
	result, err := handler.store.ConvertCompany(r.Context(), companyID, actor)
	if err != nil {
		writeUserError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (handler *Handler) ExportCompanies(w http.ResponseWriter, r *http.Request) {
	actor := requestActor(r)
	filter, err := handler.buildCompanyFilter(r, actor)
	if err != nil {
		writeUserError(w, err)
		return
	}
	items, err := handler.store.ListCompaniesForExport(r.Context(), filter)
	if err != nil {
		writeUserError(w, internalError())
		return
	}
	if len(items) > 50000 {
		writeUserError(w, newValidationError("导出超过 50000 行，请收窄筛选条件"))
		return
	}
	if auditErr := handler.store.RecordExportAudit(
		r.Context(), actor, filter.Scope.Name, FiltersHash(r), len(items),
	); auditErr != nil {
		writeUserError(w, internalError())
		return
	}
	filename := "客户雷达_意向客户_" +
		handler.now().In(shanghaiLocation()).Format("20060102") + ".csv"
	writeCSVResponse(w, filename, BuildCompaniesCSV(items))
}
