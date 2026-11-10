package crm_intent

import (
	"net/http"
	"strconv"
)

const (
	defaultCompanyPageSize = 24
	defaultPoolPageSize    = 60
	defaultBatchPageSize   = 20
)

func optionalRevQuery(r *http.Request, name string) (*int64, error) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return nil, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 0 {
		return nil, newValidationError(name + " 必须是非负整数")
	}
	return &value, nil
}

// Meta returns batch/stats/facets plus the polling revisions (spec §5.2).
func (handler *Handler) Meta(w http.ResponseWriter, r *http.Request) {
	actor := requestActor(r)
	scope, err := requestScope(r, actor)
	if err != nil {
		writeUserError(w, err)
		return
	}
	dataRevParam, err := optionalRevQuery(r, "data_rev")
	if err != nil {
		writeUserError(w, err)
		return
	}
	followupRevParam, err := optionalRevQuery(r, "followup_rev")
	if err != nil {
		writeUserError(w, err)
		return
	}
	dataRev, followupRev, err := handler.store.GetRevisions(r.Context())
	if err != nil {
		writeUserError(w, internalError())
		return
	}
	serverTime := formatTimestamp(handler.now())
	if dataRevParam != nil && followupRevParam != nil &&
		*dataRevParam == dataRev && *followupRevParam == followupRev {
		writeJSON(w, http.StatusOK, MetaResponse{
			Stats: Stats{ByLevel: map[string]int{}}, Facets: Facets{
				Levels: IntentLevels(), States: stateFacets(),
				Categories: []string{}, Channels: []string{}, Provinces: []string{},
				Cities: []FacetCities{},
			},
			DataRev: dataRev, FollowupRev: followupRev,
			Changed: false, ServerTime: serverTime,
		})
		return
	}
	meta, err := handler.store.GetMetaData(r.Context(), scope)
	if err != nil {
		writeUserError(w, internalError())
		return
	}
	writeJSON(w, http.StatusOK, MetaResponse{
		Batch: meta.Batch, Stats: meta.Stats, Facets: meta.Facets,
		DataRev: dataRev, FollowupRev: followupRev,
		Changed: true, ServerTime: serverTime,
	})
}

func (handler *Handler) buildCompanyFilter(r *http.Request, actor Actor) (CompanyFilter, error) {
	scope, err := requestScope(r, actor)
	if err != nil {
		return CompanyFilter{}, err
	}
	page, pageSize, err := parsePageParams(r, defaultCompanyPageSize, 200)
	if err != nil {
		return CompanyFilter{}, err
	}
	sort := r.URL.Query().Get("sort")
	if !ValidCompanySort(sort) {
		return CompanyFilter{}, newValidationError("sort 取值非法")
	}
	level := optionalQueryString(r, "level")
	if level != nil && !ValidIntentLevel(*level) {
		return CompanyFilter{}, newValidationError("level 只接受 A/B/C/D")
	}
	state := optionalQueryString(r, "state")
	if state != nil && !ValidFollowupState(*state) {
		return CompanyFilter{}, newValidationError("state 非法")
	}
	withPhone, err := optionalQueryBool(r, "with_phone")
	if err != nil {
		return CompanyFilter{}, err
	}
	dup, err := optionalQueryBool(r, "dup")
	if err != nil {
		return CompanyFilter{}, err
	}
	due, err := optionalQueryBool(r, "due")
	if err != nil {
		return CompanyFilter{}, err
	}
	return CompanyFilter{
		Scope:     scope,
		Query:     optionalQueryString(r, "q"),
		Level:     level,
		Category:  optionalQueryString(r, "category"),
		Channel:   optionalQueryString(r, "channel"),
		Province:  optionalQueryString(r, "province"),
		City:      optionalQueryString(r, "city"),
		State:     state,
		WithPhone: withPhone,
		Dup:       dup,
		Due:       due,
		Sort:      sort,
		Page:      page,
		PageSize:  pageSize,
	}, nil
}

func (handler *Handler) ListCompanies(w http.ResponseWriter, r *http.Request) {
	actor := requestActor(r)
	filter, err := handler.buildCompanyFilter(r, actor)
	if err != nil {
		writeUserError(w, err)
		return
	}
	result, err := handler.store.ListCompanies(r.Context(), filter)
	if err != nil {
		writeUserError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (handler *Handler) GetCompany(w http.ResponseWriter, r *http.Request) {
	actor := requestActor(r)
	companyID, err := parsePathID(r, "company_id")
	if err != nil {
		writeUserError(w, err)
		return
	}
	scope, err := requestScope(r, actor)
	if err != nil {
		writeUserError(w, err)
		return
	}
	company, err := handler.store.GetCompany(r.Context(), companyID, scope)
	if err != nil {
		writeUserError(w, err)
		return
	}
	if company == nil {
		writeUserError(w, newNotFoundError("公司", companyID))
		return
	}
	writeJSON(w, http.StatusOK, company)
}

func (handler *Handler) Board(w http.ResponseWriter, r *http.Request) {
	actor := requestActor(r)
	scope, err := requestScope(r, actor)
	if err != nil {
		writeUserError(w, err)
		return
	}
	columns, err := handler.store.GetBoard(r.Context(), scope)
	if err != nil {
		writeUserError(w, internalError())
		return
	}
	if columns == nil {
		columns = []BoardColumn{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"columns": columns})
}

func (handler *Handler) Facets(w http.ResponseWriter, r *http.Request) {
	actor := requestActor(r)
	scope, err := requestScope(r, actor)
	if err != nil {
		writeUserError(w, err)
		return
	}
	facets, err := handler.store.GetFacets(r.Context(), scope)
	if err != nil {
		writeUserError(w, internalError())
		return
	}
	writeJSON(w, http.StatusOK, facets)
}

func (handler *Handler) buildPoolFilter(r *http.Request) (PoolFilter, error) {
	page, pageSize, err := parsePageParams(r, defaultPoolPageSize, 100)
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

func (handler *Handler) ListPool(w http.ResponseWriter, r *http.Request) {
	filter, err := handler.buildPoolFilter(r)
	if err != nil {
		writeUserError(w, err)
		return
	}
	result, err := handler.store.ListPool(r.Context(), filter)
	if err != nil {
		writeUserError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (handler *Handler) ListBatches(w http.ResponseWriter, r *http.Request) {
	actor := requestActor(r)
	if !actor.IsAdminActor() {
		writeUserError(w, newForbiddenError("仅管理员可查看导入批次"))
		return
	}
	page, pageSize, err := parsePageParams(r, defaultBatchPageSize, 100)
	if err != nil {
		writeUserError(w, err)
		return
	}
	result, err := handler.store.ListBatches(r.Context(), page, pageSize)
	if err != nil {
		writeUserError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (handler *Handler) GetBatch(w http.ResponseWriter, r *http.Request) {
	actor := requestActor(r)
	if !actor.IsAdminActor() {
		writeUserError(w, newForbiddenError("仅管理员可查看导入批次"))
		return
	}
	batchID, err := parsePathID(r, "batch_id")
	if err != nil {
		writeUserError(w, err)
		return
	}
	batch, err := handler.store.GetBatch(r.Context(), batchID)
	if err != nil {
		writeUserError(w, err)
		return
	}
	if batch == nil {
		writeUserError(w, newNotFoundError("批次", batchID))
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
