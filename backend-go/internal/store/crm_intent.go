package store

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/crm_intent"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

// CRMIntentStore is the pgx persistence layer for the crm_intent domain.
type CRMIntentStore struct {
	db      FullDB
	auditor audit.Service
}

func NewCRMIntentStore(db FullDB, auditor audit.Service) *CRMIntentStore {
	return &CRMIntentStore{db: db, auditor: auditor}
}

var _ crm_intent.Store = (*CRMIntentStore)(nil)

func (s *CRMIntentStore) inTx(
	ctx context.Context,
	fn func(db FullDB, tx pgx.Tx) error,
) error {
	if s == nil || s.db == nil {
		return errors.New("crm_intent database is nil")
	}
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		return fn(NewTxDB(tx), tx)
	})
}

// argsBuilder accumulates SQL conditions and positional arguments.
type argsBuilder struct {
	conditions []string
	args       []any
}

func (builder *argsBuilder) arg(value any) string {
	builder.args = append(builder.args, value)
	return "$" + strconv.Itoa(len(builder.args))
}

func (builder *argsBuilder) add(condition string) {
	if strings.TrimSpace(condition) != "" {
		builder.conditions = append(builder.conditions, condition)
	}
}

func (builder *argsBuilder) where() string {
	if len(builder.conditions) == 0 {
		return ""
	}
	return " where " + strings.Join(builder.conditions, " and ")
}

// andWhere returns the condition list prefixed with " and " (for queries that
// already contain a where clause).
func andWhere(builder *argsBuilder) string {
	if len(builder.conditions) == 0 {
		return ""
	}
	return " and " + strings.Join(builder.conditions, " and ")
}

// scopeCondition applies the CRM visibility rule to the given table alias.
func scopeCondition(builder *argsBuilder, alias string, scope crm_intent.Scope) {
	switch scope.Name {
	case crm_intent.ScopeMine:
		builder.add(alias + ".owner_id = " + builder.arg(scope.UserID))
	case crm_intent.ScopeSea:
		builder.add(alias + ".owner_id is null")
	case crm_intent.ScopeVisible:
		builder.add("(" + alias + ".owner_id = " + builder.arg(scope.UserID) +
			" or " + alias + ".owner_id is null)")
	}
}

const crmIntentCompanyColumns = `c.id, c.batch_id, c.external_id, c.name, c.credit_code,
	c.legal_person, c.province, c.city, c.founded_year, c.registered_capital_wan,
	c.products, c.category, c.channel, c.channels, c.channel_source,
	c.trademarks, c.trademark_count, c.intent_level,
	c.intent_score, c.intent_basis, c.amazon_fit, c.walmart_fit, c.sources,
	c.risks, c.screened_at, c.phone_note, c.owner_id, c.human_touched_at,
	c.converted_customer_id, c.converted_at, c.created_at, c.updated_at, u.full_name`

const crmIntentCompanyFrom = ` from public.crm_intent_companies c
	left join public.user_accounts u on u.id::text = c.owner_id `

func (s *CRMIntentStore) scanCompany(
	row interface{ Scan(...any) error },
) (*crm_intent.Company, error) {
	var (
		item                                crm_intent.Company
		batchID                             *int64
		externalID, creditCode, legalPerson *string
		province, city, products, category  *string
		channel, channelSource              *string
		channels                            []string
		foundedYear                         *int
		registeredCapitalWan                *float64
		trademarks                          []string
		trademarkCount                      int
		intentScore                         *int
		intentBasis, amazonFit, walmartFit  *string
		sources                             []string
		risks, phoneNote                    *string
		screenedAt                          *time.Time
		ownerID                             *string
		humanTouchedAt                      *time.Time
		convertedCustomerID                 *int64
		convertedAt                         *time.Time
		createdAt, updatedAt                time.Time
		ownerName                           *string
	)
	if err := row.Scan(
		&item.ID, &batchID, &externalID, &item.Name, &creditCode,
		&legalPerson, &province, &city, &foundedYear, &registeredCapitalWan,
		&products, &category, &channel, &channels, &channelSource,
		&trademarks, &trademarkCount, &item.IntentLevel,
		&intentScore, &intentBasis, &amazonFit, &walmartFit, &sources,
		&risks, &screenedAt, &phoneNote, &ownerID, &humanTouchedAt,
		&convertedCustomerID, &convertedAt, &createdAt, &updatedAt, &ownerName,
	); err != nil {
		return nil, err
	}
	item.BatchID = batchID
	item.ExternalID = externalID
	item.CreditCode = creditCode
	item.LegalPerson = legalPerson
	item.Province = province
	item.City = city
	item.FoundedYear = foundedYear
	item.RegisteredCapitalWan = registeredCapitalWan
	item.Products = products
	item.Category = category
	item.Channel = channel
	if channels == nil {
		channels = []string{}
	}
	item.Channels = channels
	item.ChannelSource = channelSource
	if trademarks == nil {
		trademarks = []string{}
	}
	item.Trademarks = trademarks
	item.TrademarkCount = trademarkCount
	item.IntentLevelLabel = crm_intent.IntentLevelLabel(item.IntentLevel)
	item.IntentScore = intentScore
	item.IntentBasis = intentBasis
	item.AmazonFit = amazonFit
	item.WalmartFit = walmartFit
	if sources == nil {
		sources = []string{}
	}
	item.Sources = sources
	item.Risks = risks
	item.ScreenedAt = optionalDateText(screenedAt)
	item.PhoneNote = phoneNote
	if ownerID != nil {
		item.Owner = &crm_intent.OwnerBrief{ID: *ownerID, Name: ownerName}
	}
	item.HumanTouched = humanTouchedAt != nil
	item.HumanTouchedAt = optionalTimestampText(humanTouchedAt)
	item.ConvertedCustomerID = convertedCustomerID
	item.ConvertedAt = optionalTimestampText(convertedAt)
	item.CreatedAt = timestampText(createdAt)
	item.UpdatedAt = timestampText(updatedAt)
	item.Phones = []crm_intent.Phone{}
	item.Followup = emptyFollowup(item.ID)
	return &item, nil
}

func timestampText(value time.Time) string {
	return value.Format(time.RFC3339Nano)
}

func optionalTimestampText(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.Format(time.RFC3339Nano)
	return &formatted
}

func optionalDateText(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.Format("2006-01-02")
	return &formatted
}

func emptyFollowup(companyID int64) crm_intent.Followup {
	return crm_intent.Followup{
		CompanyID:   companyID,
		State:       crm_intent.StateNone,
		StateLabel:  crm_intent.FollowupStateLabel(crm_intent.StateNone),
		Note:        "",
		ValidPhones: []string{},
		Version:     0,
	}
}

// loadCompanyPhones attaches phones (and valid phone list) to the companies.
func (s *CRMIntentStore) loadCompanyPhones(
	ctx context.Context,
	db DB,
	items []*crm_intent.Company,
) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(items))
	index := make(map[int64]*crm_intent.Company, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
		index[item.ID] = item
	}
	rows, err := db.Query(ctx, `select id, company_id, pool_id, phone_raw,
		phone_normalized, source, is_valid, created_by, created_at
		from public.crm_intent_phones
		where company_id = any($1) order by id`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			phone     crm_intent.Phone
			companyID *int64
			poolID    *int64
			createdBy *string
			createdAt time.Time
		)
		if err := rows.Scan(
			&phone.ID, &companyID, &poolID, &phone.PhoneRaw,
			&phone.PhoneNormalized, &phone.Source, &phone.IsValid,
			&createdBy, &createdAt,
		); err != nil {
			return err
		}
		phone.CompanyID = companyID
		phone.PoolID = poolID
		phone.CreatedBy = createdBy
		phone.CreatedAt = timestampText(createdAt)
		if companyID != nil {
			if item, ok := index[*companyID]; ok {
				item.Phones = append(item.Phones, phone)
			}
		}
	}
	return rows.Err()
}

// loadCompanyFollowups attaches followup rows and valid phone lists.
func (s *CRMIntentStore) loadCompanyFollowups(
	ctx context.Context,
	db DB,
	items []*crm_intent.Company,
) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(items))
	index := make(map[int64]*crm_intent.Company, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
		index[item.ID] = item
	}
	rows, err := db.Query(ctx, `select company_id, state, note, last_contact_at,
		next_contact_at, version, updated_by, updated_at
		from public.crm_intent_followups where company_id = any($1)`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			followup      crm_intent.Followup
			lastContactAt *time.Time
			nextContactAt *time.Time
			updatedBy     *string
			updatedAt     time.Time
		)
		if err := rows.Scan(
			&followup.CompanyID, &followup.State, &followup.Note, &lastContactAt,
			&nextContactAt, &followup.Version, &updatedBy, &updatedAt,
		); err != nil {
			return err
		}
		followup.StateLabel = crm_intent.FollowupStateLabel(followup.State)
		followup.LastContactAt = optionalTimestampText(lastContactAt)
		followup.NextContactAt = optionalTimestampText(nextContactAt)
		followup.UpdatedBy = updatedBy
		followup.UpdatedAt = timestampText(updatedAt)
		followup.ValidPhones = []string{}
		if item, ok := index[followup.CompanyID]; ok {
			item.Followup = followup
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, item := range items {
		valid := make([]string, 0)
		for _, phone := range item.Phones {
			if phone.IsValid {
				valid = append(valid, phone.PhoneNormalized)
			}
		}
		item.Followup.ValidPhones = valid
		if item.Followup.StateLabel == "" {
			item.Followup.StateLabel = crm_intent.FollowupStateLabel(item.Followup.State)
		}
	}
	return nil
}

func (s *CRMIntentStore) loadCompanies(
	ctx context.Context,
	db DB,
	items []*crm_intent.Company,
) error {
	if err := s.loadCompanyPhones(ctx, db, items); err != nil {
		return err
	}
	return s.loadCompanyFollowups(ctx, db, items)
}

// ---------- revisions / meta ----------

func (s *CRMIntentStore) GetRevisions(ctx context.Context) (int64, int64, error) {
	var dataRev, followupRev int64
	err := s.db.QueryRow(ctx,
		`select data_rev, followup_rev from public.crm_intent_meta where id = 1`,
	).Scan(&dataRev, &followupRev)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, nil
	}
	if err != nil {
		return 0, 0, err
	}
	return dataRev, followupRev, nil
}

// LatestBatchDate returns the most recent batch's date (YYYY-MM-DD).
func (s *CRMIntentStore) LatestBatchDate(ctx context.Context) (*string, error) {
	brief, err := s.latestBatchBrief(ctx)
	if err != nil || brief == nil {
		return nil, err
	}
	return brief.BatchDate, nil
}

func (s *CRMIntentStore) latestBatchBrief(ctx context.Context) (*crm_intent.BatchBrief, error) {
	var (
		brief     crm_intent.BatchBrief
		batchDate time.Time
		updatedAt time.Time
		total     int
		poolTotal int
	)
	err := s.db.QueryRow(ctx, `select id, batch_date, coalesce(completed_at, created_at),
		total_companies, total_pool
		from public.crm_intent_batches order by id desc limit 1`).Scan(
		&brief.ID, &batchDate, &updatedAt, &total, &poolTotal,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	dateText := batchDate.Format("2006-01-02")
	updatedText := timestampText(updatedAt)
	brief.BatchDate = &dateText
	brief.UpdatedAt = &updatedText
	brief.Total = total
	brief.PoolTotal = poolTotal
	return &brief, nil
}

func (s *CRMIntentStore) companyStats(
	ctx context.Context,
	db DB,
	scope crm_intent.Scope,
) (crm_intent.Stats, error) {
	builder := &argsBuilder{}
	scopeCondition(builder, "c", scope)
	stats := crm_intent.Stats{ByLevel: map[string]int{}}
	query := `select count(*),
		count(*) filter (where c.intent_level = 'A'),
		count(*) filter (where c.intent_level = 'B'),
		count(*) filter (where c.intent_level = 'C'),
		count(*) filter (where c.intent_level = 'D'),
		count(*) filter (where exists (
			select 1 from public.crm_intent_phones p where p.company_id = c.id)),
		count(*) filter (where f.state is not null and f.state <> 'none'),
		count(*) filter (where f.company_id is not null),
		count(*) filter (where f.next_contact_at is not null
			and f.next_contact_at <= now() and c.converted_customer_id is null)
		from public.crm_intent_companies c
		left join public.crm_intent_followups f on f.company_id = c.id` + builder.where()
	var byA, byB, byC, byD int
	if err := db.QueryRow(ctx, query, builder.args...).Scan(
		&stats.Total, &byA, &byB, &byC, &byD,
		&stats.WithPhone, &stats.Contacted, &stats.FollowedUp, &stats.DueCount,
	); err != nil {
		return crm_intent.Stats{}, err
	}
	stats.ByLevel = map[string]int{
		crm_intent.LevelA: byA, crm_intent.LevelB: byB,
		crm_intent.LevelC: byC, crm_intent.LevelD: byD,
	}
	if err := db.QueryRow(ctx,
		`select count(*) from public.crm_intent_pool where status = 'pending'`,
	).Scan(&stats.PoolTotal); err != nil {
		return crm_intent.Stats{}, err
	}
	dupBuilder := &argsBuilder{}
	scopeCondition(dupBuilder, "c", scope)
	dupQuery := `select count(*) from (
		select p.phone_normalized
		from public.crm_intent_phones p
		join public.crm_intent_companies c on c.id = p.company_id` +
		dupBuilder.where() + `
		group by p.phone_normalized having count(distinct p.company_id) >= 2) dup`
	if err := db.QueryRow(ctx, dupQuery, dupBuilder.args...).Scan(&stats.DupGroups); err != nil {
		return crm_intent.Stats{}, err
	}
	return stats, nil
}

func (s *CRMIntentStore) facets(
	ctx context.Context,
	db DB,
	scope crm_intent.Scope,
) (crm_intent.Facets, error) {
	facets := crm_intent.Facets{
		Levels:     crm_intent.IntentLevels(),
		States:     stateFacets(),
		Categories: []string{},
		Channels:   []string{},
		Provinces:  []string{},
		Cities:     []crm_intent.FacetCities{},
	}
	builder := &argsBuilder{}
	scopeCondition(builder, "c", scope)
	rows, err := db.Query(ctx, `select distinct c.category from public.crm_intent_companies c
		where c.category is not null and c.category <> ''`+
		andWhere(builder)+` order by c.category`, builder.args...)
	if err != nil {
		return facets, err
	}
	facets.Categories, err = scanStringRows(rows)
	if err != nil {
		return facets, err
	}
	provinceBuilder := &argsBuilder{}
	scopeCondition(provinceBuilder, "c", scope)
	rows, err = db.Query(ctx, `select distinct c.province from public.crm_intent_companies c
		where c.province is not null and c.province <> ''`+
		andWhere(provinceBuilder)+` order by c.province`, provinceBuilder.args...)
	if err != nil {
		return facets, err
	}
	facets.Provinces, err = scanStringRows(rows)
	if err != nil {
		return facets, err
	}
	cityBuilder := &argsBuilder{}
	scopeCondition(cityBuilder, "c", scope)
	rows, err = db.Query(ctx, `select c.province, c.city from public.crm_intent_companies c
		where c.province is not null and c.city is not null and c.city <> ''`+
		andWhere(cityBuilder)+`
		group by c.province, c.city order by c.province, c.city`, cityBuilder.args...)
	if err != nil {
		return facets, err
	}
	citiesByProvince := map[string][]string{}
	provinceOrder := make([]string, 0)
	for rows.Next() {
		var province, city string
		if err := rows.Scan(&province, &city); err != nil {
			rows.Close()
			return facets, err
		}
		if _, ok := citiesByProvince[province]; !ok {
			provinceOrder = append(provinceOrder, province)
		}
		citiesByProvince[province] = append(citiesByProvince[province], city)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return facets, err
	}
	for _, province := range provinceOrder {
		facets.Cities = append(facets.Cities, crm_intent.FacetCities{
			Province: province, Cities: citiesByProvince[province],
		})
	}
	channelBuilder := &argsBuilder{}
	scopeCondition(channelBuilder, "c", scope)
	companyCondition := andWhere(channelBuilder)
	poolBuilder := &argsBuilder{}
	facetPoolScopeCondition(poolBuilder, scope)
	poolCondition := andWhere(poolBuilder)
	if len(poolBuilder.args) > 0 {
		offset := len(channelBuilder.args)
		poolCondition = renumberPlaceholders(poolCondition, offset)
		channelBuilder.args = append(channelBuilder.args, poolBuilder.args...)
	}
	channelQuery := `select value from (
		select c.channel as value from public.crm_intent_companies c
			where c.channel is not null and c.channel <> ''` + companyCondition + `
		union all
		select ch.value from public.crm_intent_companies c
			cross join lateral json_array_elements_text(c.channels::json) as ch(value)
			where true` + companyCondition + `
		union all
		select pl.channel from public.crm_intent_pool pl
			where pl.channel is not null and pl.channel <> ''` + poolCondition + `
		union all
		select pch.value from public.crm_intent_pool pl
			cross join lateral json_array_elements_text(pl.channels::json) as pch(value)
			where true` + poolCondition + `
	) merged group by value order by count(*) desc, value asc`
	rows, err = db.Query(ctx, channelQuery, channelBuilder.args...)
	if err != nil {
		return facets, err
	}
	facets.Channels, err = scanStringRows(rows)
	if err != nil {
		return facets, err
	}
	return facets, nil
}

// facetPoolScopeCondition scopes the pool branch of the channel facet: pool
// rows have no owner, so scope=mine follows the screened company owner and
// scope=sea only contributes still-pending pool rows.
func facetPoolScopeCondition(builder *argsBuilder, scope crm_intent.Scope) {
	switch scope.Name {
	case crm_intent.ScopeMine:
		builder.add(`exists (select 1 from public.crm_intent_companies pc
			where pc.id = pl.screened_company_id and pc.owner_id = ` +
			builder.arg(scope.UserID) + `)`)
	case crm_intent.ScopeSea:
		builder.add("pl.status = 'pending'")
	}
}

func scanStringRows(rows Rows) ([]string, error) {
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		result = append(result, value)
	}
	return result, rows.Err()
}

func stateFacets() []crm_intent.StateFacet {
	states := crm_intent.FollowupStates()
	result := make([]crm_intent.StateFacet, 0, len(states))
	for _, state := range states {
		result = append(result, crm_intent.StateFacet{
			Code: state, Label: crm_intent.FollowupStateLabel(state),
		})
	}
	return result
}

func (s *CRMIntentStore) GetMetaData(
	ctx context.Context,
	scope crm_intent.Scope,
) (crm_intent.MetaData, error) {
	batch, err := s.latestBatchBrief(ctx)
	if err != nil {
		return crm_intent.MetaData{}, err
	}
	stats, err := s.companyStats(ctx, s.db, scope)
	if err != nil {
		return crm_intent.MetaData{}, err
	}
	facets, err := s.facets(ctx, s.db, scope)
	if err != nil {
		return crm_intent.MetaData{}, err
	}
	return crm_intent.MetaData{Batch: batch, Stats: stats, Facets: facets}, nil
}

func (s *CRMIntentStore) GetFacets(
	ctx context.Context,
	scope crm_intent.Scope,
) (crm_intent.Facets, error) {
	return s.facets(ctx, s.db, scope)
}

func (s *CRMIntentStore) GetBoard(
	ctx context.Context,
	scope crm_intent.Scope,
) ([]crm_intent.BoardColumn, error) {
	columns := make([]crm_intent.BoardColumn, 0, len(crm_intent.FollowupStates()))
	for _, state := range crm_intent.FollowupStates() {
		builder := &argsBuilder{}
		scopeCondition(builder, "c", scope)
		stateArg := builder.arg(state)
		builder.add(`coalesce(f.state, 'none') = ` + stateArg)
		countQuery := `select count(*) from public.crm_intent_companies c
			left join public.crm_intent_followups f on f.company_id = c.id` + builder.where()
		column := crm_intent.BoardColumn{
			State:      state,
			StateLabel: crm_intent.FollowupStateLabel(state),
			Items:      []crm_intent.BoardItem{},
		}
		if err := s.db.QueryRow(ctx, countQuery, builder.args...).Scan(&column.Count); err != nil {
			return nil, err
		}
		listArgs := append(append([]any{}, builder.args...), 8)
		limitArg := "$" + strconv.Itoa(len(listArgs))
		listQuery := `select c.id, c.name, c.intent_level, c.intent_score,
			f.next_contact_at, c.owner_id, u.full_name, c.updated_at
			from public.crm_intent_companies c
			left join public.crm_intent_followups f on f.company_id = c.id
			left join public.user_accounts u on u.id::text = c.owner_id` +
			builder.where() + `
			order by f.next_contact_at nulls last, c.updated_at desc, c.id desc
			limit ` + limitArg
		rows, err := s.db.Query(ctx, listQuery, listArgs...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var (
				item          crm_intent.BoardItem
				nextContactAt *time.Time
				ownerID       *string
				ownerName     *string
				updatedAt     time.Time
			)
			if err := rows.Scan(
				&item.ID, &item.Name, &item.IntentLevel, &item.IntentScore,
				&nextContactAt, &ownerID, &ownerName, &updatedAt,
			); err != nil {
				rows.Close()
				return nil, err
			}
			item.IntentLevelLabel = crm_intent.IntentLevelLabel(item.IntentLevel)
			item.NextContactAt = optionalTimestampText(nextContactAt)
			if ownerID != nil {
				item.Owner = &crm_intent.OwnerBrief{ID: *ownerID, Name: ownerName}
			}
			item.UpdatedAt = timestampText(updatedAt)
			column.Items = append(column.Items, item)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		columns = append(columns, column)
	}
	return columns, nil
}

// ---------- companies read ----------

func applyCompanyFilters(builder *argsBuilder, filter crm_intent.CompanyFilter) {
	scopeCondition(builder, "c", filter.Scope)
	if filter.Query != nil {
		pattern := "%" + *filter.Query + "%"
		builder.add(`(c.name ilike ` + builder.arg(pattern) +
			` or c.credit_code ilike ` + builder.arg(pattern) +
			` or c.legal_person ilike ` + builder.arg(pattern) +
			` or c.products ilike ` + builder.arg(pattern) +
			` or exists (select 1 from public.crm_intent_phones p
				where p.company_id = c.id and (p.phone_raw ilike ` + builder.arg(pattern) +
			` or p.phone_normalized ilike ` + builder.arg(pattern) + `)))`)
	}
	if filter.Level != nil {
		builder.add("c.intent_level = " + builder.arg(*filter.Level))
	}
	if filter.Category != nil {
		builder.add("c.category = " + builder.arg(*filter.Category))
	}
	if filter.Province != nil {
		builder.add("c.province = " + builder.arg(*filter.Province))
	}
	if filter.City != nil {
		builder.add("c.city = " + builder.arg(*filter.City))
	}
	if filter.Channel != nil {
		channelArg := builder.arg(*filter.Channel)
		builder.add(`(c.channel = ` + channelArg +
			` or exists (select 1 from json_array_elements_text(c.channels::json) ch
				where ch = ` + channelArg + `)
			or exists (select 1 from public.crm_intent_pool pl
				where pl.screened_company_id = c.id and (pl.channel = ` + channelArg +
			` or exists (select 1 from json_array_elements_text(pl.channels::json) pch
				where pch = ` + channelArg + `))))`)
	}
	if filter.State != nil {
		builder.add(`coalesce((select f.state from public.crm_intent_followups f
			where f.company_id = c.id), 'none') = ` + builder.arg(*filter.State))
	}
	if filter.WithPhone != nil {
		if *filter.WithPhone {
			builder.add(`exists (select 1 from public.crm_intent_phones p where p.company_id = c.id)`)
		} else {
			builder.add(`not exists (select 1 from public.crm_intent_phones p where p.company_id = c.id)`)
		}
	}
	if filter.Dup != nil && *filter.Dup {
		builder.add(dupFilterCondition(builder, filter.Scope))
	}
	if filter.Due != nil && *filter.Due {
		builder.add(`exists (select 1 from public.crm_intent_followups f
			where f.company_id = c.id and f.next_contact_at is not null
			and f.next_contact_at <= now()) and c.converted_customer_id is null`)
	}
}

// renumberPlaceholders shifts $N placeholders by offset; it is only used for
// the dup-with-scope subquery where arguments are appended after the condition
// text was built.
func renumberPlaceholders(condition string, offset int) string {
	if offset <= 0 {
		return condition
	}
	var builder strings.Builder
	for index := 0; index < len(condition); index++ {
		character := condition[index]
		if character == '$' {
			builder.WriteByte('$')
			start := index + 1
			end := start
			for end < len(condition) && condition[end] >= '0' && condition[end] <= '9' {
				end++
			}
			number, _ := strconv.Atoi(condition[start:end])
			builder.WriteString(strconv.Itoa(number + offset))
			index = end - 1
			continue
		}
		builder.WriteByte(character)
	}
	return builder.String()
}

// dupFilterCondition selects companies whose phone number is shared by at
// least two companies inside the current scope. The inner GROUP BY must run
// over all scoped companies (not the outer row), otherwise the HAVING clause
// can never reach 2.
func dupFilterCondition(builder *argsBuilder, scope crm_intent.Scope) string {
	return dupFilterConditionForTables(
		builder, scope, "public.crm_intent_phones", "public.crm_intent_companies",
	)
}

func dupFilterConditionForTables(
	builder *argsBuilder,
	scope crm_intent.Scope,
	phonesTable string,
	companiesTable string,
) string {
	otherScope := &argsBuilder{}
	scopeCondition(otherScope, "c2", scope)
	condition := `exists (select 1 from ` + phonesTable + ` p
		where p.company_id = c.id and p.phone_normalized in (
			select p2.phone_normalized
			from ` + phonesTable + ` p2
			join ` + companiesTable + ` c2 on c2.id = p2.company_id` +
		strings.Replace(otherScope.where(), " where ", " and ", 1) + `
			group by p2.phone_normalized
			having count(distinct p2.company_id) >= 2))`
	if len(otherScope.args) > 0 {
		offset := len(builder.args)
		builder.args = append(builder.args, otherScope.args...)
		condition = renumberPlaceholders(condition, offset)
	}
	return condition
}

func companyOrderBy(sort string) string {
	switch sort {
	case "name", "name_asc":
		return "c.name asc, c.id asc"
	case "level", "level_asc":
		return "c.intent_level asc, c.id asc"
	case "score", "score_desc":
		return "c.intent_score desc nulls last, c.id asc"
	case "screened", "screened_desc":
		return "c.screened_at desc nulls last, c.id desc"
	default:
		return "c.updated_at desc, c.id desc"
	}
}

func ValidCompanySort(sort string) bool {
	switch sort {
	case "", "updated", "updated_desc", "name", "name_asc", "level", "level_asc",
		"score", "score_desc", "screened", "screened_desc", "due", "due_asc":
		return true
	default:
		return false
	}
}

func (s *CRMIntentStore) ListCompanies(
	ctx context.Context,
	filter crm_intent.CompanyFilter,
) (crm_intent.Paginated[crm_intent.Company], error) {
	result := crm_intent.Paginated[crm_intent.Company]{
		Items: []crm_intent.Company{}, Page: filter.Page, PageSize: filter.PageSize,
	}
	builder := &argsBuilder{}
	applyCompanyFilters(builder, filter)
	var total int
	if err := s.db.QueryRow(ctx,
		`select count(*) from public.crm_intent_companies c`+builder.where(),
		builder.args...,
	).Scan(&total); err != nil {
		return result, err
	}
	result.Total = total
	offset := (filter.Page - 1) * filter.PageSize
	args := append(append([]any{}, builder.args...), filter.PageSize, offset)
	limitArg := "$" + strconv.Itoa(len(args)-1)
	offsetArg := "$" + strconv.Itoa(len(args))
	query := "select " + crmIntentCompanyColumns + crmIntentCompanyFrom + builder.where() +
		" order by " + companyOrderBy(filter.Sort) + " limit " + limitArg + " offset " + offsetArg
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return result, err
	}
	pointers := make([]*crm_intent.Company, 0, filter.PageSize)
	for rows.Next() {
		item, scanErr := s.scanCompany(rows)
		if scanErr != nil {
			rows.Close()
			return result, scanErr
		}
		pointers = append(pointers, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return result, err
	}
	if err := s.loadCompanies(ctx, s.db, pointers); err != nil {
		return result, err
	}
	for _, item := range pointers {
		result.Items = append(result.Items, *item)
	}
	return result, nil
}

func (s *CRMIntentStore) ListCompaniesForExport(
	ctx context.Context,
	filter crm_intent.CompanyFilter,
) ([]crm_intent.Company, error) {
	builder := &argsBuilder{}
	applyCompanyFilters(builder, filter)
	args := append(append([]any{}, builder.args...), 50001)
	limitArg := "$" + strconv.Itoa(len(args))
	query := "select " + crmIntentCompanyColumns + crmIntentCompanyFrom + builder.where() +
		" order by " + companyOrderBy(filter.Sort) + " limit " + limitArg
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	pointers := make([]*crm_intent.Company, 0)
	for rows.Next() {
		item, scanErr := s.scanCompany(rows)
		if scanErr != nil {
			rows.Close()
			return nil, scanErr
		}
		pointers = append(pointers, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := s.loadCompanies(ctx, s.db, pointers); err != nil {
		return nil, err
	}
	items := make([]crm_intent.Company, 0, len(pointers))
	for _, item := range pointers {
		items = append(items, *item)
	}
	return items, nil
}

func (s *CRMIntentStore) GetCompany(
	ctx context.Context,
	companyID int64,
	scope crm_intent.Scope,
) (*crm_intent.Company, error) {
	builder := &argsBuilder{}
	scopeCondition(builder, "c", scope)
	builder.add("c.id = " + builder.arg(companyID))
	query := "select " + crmIntentCompanyColumns + crmIntentCompanyFrom + builder.where()
	item, err := s.scanCompany(s.db.QueryRow(ctx, query, builder.args...))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	pointers := []*crm_intent.Company{item}
	if err := s.loadCompanies(ctx, s.db, pointers); err != nil {
		return nil, err
	}
	shared, err := s.loadSharedPhones(ctx, s.db, companyID, scope)
	if err != nil {
		return nil, err
	}
	item.SharedPhones = shared
	return item, nil
}

func (s *CRMIntentStore) loadSharedPhones(
	ctx context.Context,
	db DB,
	companyID int64,
	scope crm_intent.Scope,
) ([]crm_intent.SharedPhoneGroup, error) {
	rows, err := db.Query(ctx,
		`select phone_normalized, min(phone_raw) from public.crm_intent_phones
		where company_id = $1 group by phone_normalized order by phone_normalized`, companyID)
	if err != nil {
		return nil, err
	}
	type phoneEntry struct {
		normalized string
		raw        string
	}
	entries := make([]phoneEntry, 0)
	for rows.Next() {
		var entry phoneEntry
		if err := rows.Scan(&entry.normalized, &entry.raw); err != nil {
			rows.Close()
			return nil, err
		}
		entries = append(entries, entry)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	groups := make([]crm_intent.SharedPhoneGroup, 0)
	for _, entry := range entries {
		group := crm_intent.SharedPhoneGroup{
			PhoneNormalized: entry.normalized,
			Raw:             entry.raw,
			Companies:       []crm_intent.SharedPhoneCompany{},
			Pool:            []crm_intent.SharedPhonePool{},
		}
		companyBuilder := &argsBuilder{}
		scopeCondition(companyBuilder, "c", scope)
		phoneArg := companyBuilder.arg(entry.normalized)
		companyQuery := `select c.id, c.name, c.intent_level
			from public.crm_intent_phones p
			join public.crm_intent_companies c on c.id = p.company_id
			where p.phone_normalized = ` + phoneArg + andWhere(companyBuilder)
		companyRows, err := db.Query(ctx, companyQuery, companyBuilder.args...)
		if err != nil {
			return nil, err
		}
		for companyRows.Next() {
			var shared crm_intent.SharedPhoneCompany
			if err := companyRows.Scan(&shared.ID, &shared.Name, &shared.IntentLevel); err != nil {
				companyRows.Close()
				return nil, err
			}
			group.Companies = append(group.Companies, shared)
		}
		companyRows.Close()
		if err := companyRows.Err(); err != nil {
			return nil, err
		}
		poolRows, err := db.Query(ctx, `select pl.id, pl.name, pl.status
			from public.crm_intent_phones p
			join public.crm_intent_pool pl on pl.id = p.pool_id
			where p.phone_normalized = $1`, entry.normalized)
		if err != nil {
			return nil, err
		}
		for poolRows.Next() {
			var shared crm_intent.SharedPhonePool
			if err := poolRows.Scan(&shared.ID, &shared.Name, &shared.Status); err != nil {
				poolRows.Close()
				return nil, err
			}
			group.Pool = append(group.Pool, shared)
		}
		poolRows.Close()
		if err := poolRows.Err(); err != nil {
			return nil, err
		}
		if len(group.Companies)+len(group.Pool) >= 2 {
			groups = append(groups, group)
		}
	}
	return groups, nil
}

// ---------- pool read ----------

func applyPoolFilters(builder *argsBuilder, filter crm_intent.PoolFilter) {
	if filter.Query != nil {
		pattern := "%" + *filter.Query + "%"
		builder.add(`(pl.name ilike ` + builder.arg(pattern) +
			` or pl.legal_person ilike ` + builder.arg(pattern) +
			` or exists (select 1 from public.crm_intent_phones p
				where p.pool_id = pl.id and (p.phone_raw ilike ` + builder.arg(pattern) +
			` or p.phone_normalized ilike ` + builder.arg(pattern) + `)))`)
	}
	if filter.Status != nil {
		builder.add("pl.status = " + builder.arg(*filter.Status))
	}
	if filter.BatchID != nil {
		builder.add("pl.batch_id = " + builder.arg(*filter.BatchID))
	}
	if filter.Since != nil {
		builder.add("pl.updated_at > " + builder.arg(*filter.Since))
	}
}

func (s *CRMIntentStore) ListPool(
	ctx context.Context,
	filter crm_intent.PoolFilter,
) (crm_intent.Paginated[crm_intent.PoolItem], error) {
	result := crm_intent.Paginated[crm_intent.PoolItem]{
		Items: []crm_intent.PoolItem{}, Page: filter.Page, PageSize: filter.PageSize,
	}
	builder := &argsBuilder{}
	applyPoolFilters(builder, filter)
	var total int
	if err := s.db.QueryRow(ctx,
		`select count(*) from public.crm_intent_pool pl`+builder.where(),
		builder.args...,
	).Scan(&total); err != nil {
		return result, err
	}
	result.Total = total
	offset := (filter.Page - 1) * filter.PageSize
	args := append(append([]any{}, builder.args...), filter.PageSize, offset)
	limitArg := "$" + strconv.Itoa(len(args)-1)
	offsetArg := "$" + strconv.Itoa(len(args))
	query := `select pl.id, pl.batch_id, pl.external_id, pl.name, pl.legal_person,
		pl.website, pl.channel, pl.channels, pl.channel_source, pl.status,
		pl.screened_company_id, pl.created_at, pl.updated_at
		from public.crm_intent_pool pl` + builder.where() +
		` order by pl.updated_at desc, pl.id desc limit ` + limitArg + " offset " + offsetArg
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return result, err
	}
	pointers := make([]*crm_intent.PoolItem, 0, filter.PageSize)
	for rows.Next() {
		item, scanErr := scanPool(rows)
		if scanErr != nil {
			rows.Close()
			return result, scanErr
		}
		pointers = append(pointers, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return result, err
	}
	if err := s.loadPoolPhones(ctx, s.db, pointers); err != nil {
		return result, err
	}
	for _, item := range pointers {
		result.Items = append(result.Items, *item)
	}
	return result, nil
}

func scanPool(row interface{ Scan(...any) error }) (*crm_intent.PoolItem, error) {
	var (
		item            crm_intent.PoolItem
		batchID         *int64
		externalID      *string
		legalPerson     *string
		website         *string
		channel         *string
		channels        []string
		channelSource   *string
		screenedCompany *int64
		createdAt       time.Time
		updatedAt       time.Time
	)
	if err := row.Scan(
		&item.ID, &batchID, &externalID, &item.Name, &legalPerson, &website,
		&channel, &channels, &channelSource, &item.Status, &screenedCompany,
		&createdAt, &updatedAt,
	); err != nil {
		return nil, err
	}
	if channels == nil {
		channels = []string{}
	}
	item.BatchID = batchID
	item.ExternalID = externalID
	item.LegalPerson = legalPerson
	item.Website = website
	item.Channel = channel
	item.Channels = channels
	item.ChannelSource = channelSource
	item.ScreenedCompanyID = screenedCompany
	item.CreatedAt = timestampText(createdAt)
	item.UpdatedAt = timestampText(updatedAt)
	item.Phones = []crm_intent.Phone{}
	return &item, nil
}

func (s *CRMIntentStore) loadPoolPhones(
	ctx context.Context,
	db DB,
	items []*crm_intent.PoolItem,
) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(items))
	index := make(map[int64]*crm_intent.PoolItem, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
		index[item.ID] = item
	}
	rows, err := db.Query(ctx, `select id, company_id, pool_id, phone_raw,
		phone_normalized, source, is_valid, created_by, created_at
		from public.crm_intent_phones where pool_id = any($1) order by id`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			phone     crm_intent.Phone
			companyID *int64
			poolID    *int64
			createdBy *string
			createdAt time.Time
		)
		if err := rows.Scan(
			&phone.ID, &companyID, &poolID, &phone.PhoneRaw,
			&phone.PhoneNormalized, &phone.Source, &phone.IsValid,
			&createdBy, &createdAt,
		); err != nil {
			return err
		}
		phone.CompanyID = companyID
		phone.PoolID = poolID
		phone.CreatedBy = createdBy
		phone.CreatedAt = timestampText(createdAt)
		if poolID != nil {
			if item, ok := index[*poolID]; ok {
				item.Phones = append(item.Phones, phone)
			}
		}
	}
	return rows.Err()
}
