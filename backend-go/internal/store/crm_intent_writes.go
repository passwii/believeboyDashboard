package store

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/crm_intent"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

// ---------- shared helpers ----------

func (s *CRMIntentStore) logOperation(
	ctx context.Context,
	tx pgx.Tx,
	entry audit.Entry,
) error {
	if s.auditor == nil {
		return nil
	}
	if tx != nil {
		return s.auditor.LogActionTx(ctx, tx, entry)
	}
	return s.auditor.LogAction(ctx, entry)
}

func (s *CRMIntentStore) logOperationBestEffort(ctx context.Context, entry audit.Entry) {
	if s.auditor == nil {
		return
	}
	_ = s.auditor.LogAction(ctx, entry)
}

// logAIWriteBlocked records an agent write rejected by the human lock.
func (s *CRMIntentStore) logAIWriteBlocked(
	ctx context.Context,
	tx pgx.Tx,
	actor crm_intent.Actor,
	targetType string,
	targetID int64,
	extra map[string]any,
) error {
	entry := audit.Entry{
		Action:     "crm_intent.ai_write_blocked",
		TargetType: targetType, TargetID: auditTarget(targetID),
		Result: "failure", AfterJSON: extra,
	}
	applyAuditActor(&entry, actor)
	return s.logOperation(ctx, tx, entry)
}

func applyAuditActor(entry *audit.Entry, actor crm_intent.Actor) {
	identifier := actor.ID
	if identifier == "" {
		return
	}
	if actor.IsAgent() {
		entry.AgentID = &identifier
	} else {
		entry.Operator = &identifier
	}
}

func auditTarget(id int64) *string {
	value := strconv.FormatInt(id, 10)
	return &value
}

func mapPGError(err error) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return crm_intent.NewConflictError(
			"INTENT_DUPLICATE_CONFLICT",
			"记录与已有数据重复（credit_code 或 name_key 冲突）",
		)
	}
	return err
}

func (s *CRMIntentStore) bumpRevisions(
	ctx context.Context,
	db FullDB,
	data bool,
	followup bool,
) (int64, error) {
	var dataRev int64
	var err error
	switch {
	case data && followup:
		err = db.QueryRow(ctx, `update public.crm_intent_meta
			set data_rev = data_rev + 1, followup_rev = followup_rev + 1, updated_at = now()
			where id = 1 returning data_rev`).Scan(&dataRev)
	case data:
		err = db.QueryRow(ctx, `update public.crm_intent_meta
			set data_rev = data_rev + 1, updated_at = now()
			where id = 1 returning data_rev`).Scan(&dataRev)
	case followup:
		err = db.QueryRow(ctx, `update public.crm_intent_meta
			set followup_rev = followup_rev + 1, updated_at = now()
			where id = 1 returning data_rev`).Scan(&dataRev)
	default:
		err = db.QueryRow(ctx,
			`select data_rev from public.crm_intent_meta where id = 1`).Scan(&dataRev)
	}
	return dataRev, err
}

// lockCompanyForHumanWrite loads and row-locks the company before a human
// write. It returns owner_id / converted flag for the authorization decision.
func lockCompanyForHumanWrite(
	ctx context.Context,
	db FullDB,
	companyID int64,
) (*string, *time.Time, *int64, error) {
	var owner *string
	var humanTouchedAt *time.Time
	var converted *int64
	err := db.QueryRow(ctx, `select owner_id, human_touched_at, converted_customer_id
		from public.crm_intent_companies where id = $1 for update`, companyID).Scan(
		&owner, &humanTouchedAt, &converted,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, nil, crm_intent.NewNotFoundError("公司", companyID)
	}
	if err != nil {
		return nil, nil, nil, err
	}
	return owner, humanTouchedAt, converted, nil
}

func authorizeHumanWrite(owner *string, actor crm_intent.Actor) error {
	if actor.IsAdminActor() {
		return nil
	}
	if owner != nil && *owner != actor.ID {
		return crm_intent.NewForbiddenError("只能操作自己负责的记录")
	}
	return nil
}

// touchCompanyHumanWrite marks the record as human-touched (auto-claiming it
// when still in the sea) within the caller's transaction.
func touchCompanyHumanWrite(
	ctx context.Context,
	db FullDB,
	companyID int64,
	actor crm_intent.Actor,
) error {
	if strings.TrimSpace(actor.ID) == "" {
		return crm_intent.NewDomainError(401, "", "Not authenticated")
	}
	_, err := db.Exec(ctx, `update public.crm_intent_companies
		set owner_id = coalesce(owner_id, $1),
		    human_touched_at = now(),
		    human_touched_by = $1,
		    updated_at = now()
		where id = $2`, actor.ID, companyID)
	return err
}

func validPhonesForCompany(ctx context.Context, db DB, companyID int64) ([]string, error) {
	rows, err := db.Query(ctx, `select phone_normalized from public.crm_intent_phones
		where company_id = $1 and is_valid = true order by id`, companyID)
	if err != nil {
		return nil, err
	}
	return scanStringRows(rows)
}

func companyIDFromPhone(ctx context.Context, db DB, phoneID int64) (*int64, error) {
	var companyID *int64
	err := db.QueryRow(ctx,
		`select company_id from public.crm_intent_phones where id = $1`, phoneID,
	).Scan(&companyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return companyID, nil
}

func (s *CRMIntentStore) reloadCompany(
	ctx context.Context,
	companyID int64,
	actor crm_intent.Actor,
) (*crm_intent.Company, error) {
	return s.GetCompany(ctx, companyID, crm_intent.Scope{
		Name: crm_intent.ScopeAll, UserID: actor.ID, IsAdmin: true,
	})
}

// ---------- human writes ----------

func (s *CRMIntentStore) ClaimCompany(
	ctx context.Context,
	companyID int64,
	actor crm_intent.Actor,
) (*crm_intent.Company, error) {
	err := s.inTx(ctx, func(db FullDB, tx pgx.Tx) error {
		owner, _, converted, err := lockCompanyForHumanWrite(ctx, db, companyID)
		if err != nil {
			return err
		}
		if converted != nil {
			return crm_intent.NewConflictError("INTENT_ALREADY_CONVERTED", "记录已转为客户，不能领取")
		}
		if owner != nil {
			if *owner == actor.ID {
				return nil
			}
			return crm_intent.NewConflictError("INTENT_ALREADY_CLAIMED", "记录已被他人领取")
		}
		if _, err := db.Exec(ctx, `update public.crm_intent_companies
			set owner_id = $1, human_touched_at = now(), human_touched_by = $1, updated_at = now()
			where id = $2`, actor.ID, companyID); err != nil {
			return err
		}
		if _, err := s.bumpRevisions(ctx, db, true, false); err != nil {
			return err
		}
		if err := insertCRMAudit(ctx, db, "intent_company", companyID, "claim", actor.ID, "领取意向客户"); err != nil {
			return err
		}
		entry := audit.Entry{
			Action: "crm_intent.claim", TargetType: "crm_intent_company",
			TargetID: auditTarget(companyID),
		}
		applyAuditActor(&entry, actor)
		return s.logOperation(ctx, tx, entry)
	})
	if err != nil {
		return nil, err
	}
	return s.reloadCompany(ctx, companyID, actor)
}

func (s *CRMIntentStore) UpdateProfile(
	ctx context.Context,
	companyID int64,
	input crm_intent.ProfileUpdateInput,
	actor crm_intent.Actor,
) (*crm_intent.Company, error) {
	err := s.inTx(ctx, func(db FullDB, tx pgx.Tx) error {
		owner, _, _, err := lockCompanyForHumanWrite(ctx, db, companyID)
		if err != nil {
			return err
		}
		if err := authorizeHumanWrite(owner, actor); err != nil {
			return err
		}
		query, args, buildErr := buildProfileUpdateSQL(companyID, input, actor)
		if buildErr != nil {
			return buildErr
		}
		if _, err := db.Exec(ctx, query, args...); err != nil {
			return mapPGError(err)
		}
		if err := touchCompanyHumanWrite(ctx, db, companyID, actor); err != nil {
			return err
		}
		if _, err := s.bumpRevisions(ctx, db, true, false); err != nil {
			return err
		}
		if err := insertCRMAudit(ctx, db, "intent_company", companyID, "update", actor.ID, "编辑意向客户资料"); err != nil {
			return err
		}
		entry := audit.Entry{
			Action: "crm_intent.profile_update", TargetType: "crm_intent_company",
			TargetID: auditTarget(companyID),
		}
		applyAuditActor(&entry, actor)
		return s.logOperation(ctx, tx, entry)
	})
	if err != nil {
		return nil, err
	}
	return s.reloadCompany(ctx, companyID, actor)
}

func buildProfileUpdateSQL(
	companyID int64,
	input crm_intent.ProfileUpdateInput,
	actor crm_intent.Actor,
) (string, []any, error) {
	sets := make([]string, 0, 24)
	args := make([]any, 0, 24)
	add := func(column string, value any) {
		args = append(args, value)
		sets = append(sets, column+" = $"+strconv.Itoa(len(args)))
	}
	addNullable := func(column string, value *string) {
		if value == nil {
			add(column, nil)
			return
		}
		trimmed := strings.TrimSpace(*value)
		if trimmed == "" {
			add(column, nil)
			return
		}
		add(column, trimmed)
	}
	if input.Name.Set {
		if input.Name.Value == nil || strings.TrimSpace(*input.Name.Value) == "" {
			return "", nil, crm_intent.NewValidationError("name 不能为空")
		}
		name := strings.TrimSpace(*input.Name.Value)
		if len([]rune(name)) > 200 {
			return "", nil, crm_intent.NewValidationError("name 不能超过 200 字符")
		}
		add("name", name)
		add("name_key", crm_intent.NormalizeNameKey(name))
	}
	if input.CreditCode.Set {
		addNullable("credit_code", input.CreditCode.Value)
	}
	if input.LegalPerson.Set {
		addNullable("legal_person", input.LegalPerson.Value)
	}
	if input.Province.Set {
		addNullable("province", input.Province.Value)
	}
	if input.City.Set {
		addNullable("city", input.City.Value)
	}
	if input.FoundedYear.Set {
		if input.FoundedYear.Value == nil {
			add("founded_year", nil)
		} else {
			year := *input.FoundedYear.Value
			if year < 1800 || year > 2100 {
				return "", nil, crm_intent.NewValidationError("founded_year 必须在 1800 到 2100 之间")
			}
			add("founded_year", year)
		}
	}
	if input.RegisteredCapitalWan.Set {
		if input.RegisteredCapitalWan.Value != nil &&
			!crm_intent.RegisteredCapitalInRange(*input.RegisteredCapitalWan.Value) {
			return "", nil, crm_intent.NewValidationError(
				"registered_capital_wan 超出数值范围（最大 999999999999.99）",
			)
		}
		add("registered_capital_wan", input.RegisteredCapitalWan.Value)
	}
	if input.Products.Set {
		addNullable("products", input.Products.Value)
	}
	if input.Category.Set {
		addNullable("category", input.Category.Value)
	}
	if input.Channel.Set {
		addNullable("channel", input.Channel.Value)
	}
	if input.Channels.Set {
		values := []string{}
		if input.Channels.Value != nil {
			for _, item := range *input.Channels.Value {
				if trimmed := strings.TrimSpace(item); trimmed != "" {
					values = append(values, trimmed)
				}
			}
		}
		add("channels", values)
	}
	if input.ChannelSource.Set {
		addNullable("channel_source", input.ChannelSource.Value)
	}
	if input.Trademarks.Set {
		values := []string{}
		if input.Trademarks.Value != nil {
			for _, item := range *input.Trademarks.Value {
				if trimmed := strings.TrimSpace(item); trimmed != "" {
					values = append(values, trimmed)
				}
			}
		}
		add("trademarks", values)
	}
	if input.TrademarkCount.Set {
		if input.TrademarkCount.Value == nil {
			add("trademark_count", 0)
		} else {
			if *input.TrademarkCount.Value < 0 {
				return "", nil, crm_intent.NewValidationError("trademark_count 不能为负数")
			}
			add("trademark_count", *input.TrademarkCount.Value)
		}
	}
	if input.IntentLevel.Set {
		if input.IntentLevel.Value == nil {
			add("intent_level", crm_intent.LevelD)
		} else {
			level := strings.ToUpper(strings.TrimSpace(*input.IntentLevel.Value))
			if !crm_intent.ValidIntentLevel(level) {
				return "", nil, crm_intent.NewValidationError("intent_level 只接受 A/B/C/D")
			}
			add("intent_level", level)
		}
	}
	if input.IntentScore.Set {
		if input.IntentScore.Value == nil {
			add("intent_score", nil)
		} else {
			score := *input.IntentScore.Value
			if score < 0 || score > 100 {
				return "", nil, crm_intent.NewValidationError("intent_score 必须在 0 到 100 之间")
			}
			add("intent_score", score)
		}
	}
	if input.IntentBasis.Set {
		addNullable("intent_basis", input.IntentBasis.Value)
	}
	if input.AmazonFit.Set {
		addNullable("amazon_fit", input.AmazonFit.Value)
	}
	if input.WalmartFit.Set {
		addNullable("walmart_fit", input.WalmartFit.Value)
	}
	if input.Sources.Set {
		values := []string{}
		if input.Sources.Value != nil {
			for _, item := range *input.Sources.Value {
				trimmed := strings.TrimSpace(item)
				if strings.HasPrefix(trimmed, "http://") || strings.HasPrefix(trimmed, "https://") {
					values = append(values, trimmed)
				}
			}
		}
		add("sources", values)
	}
	if input.Risks.Set {
		addNullable("risks", input.Risks.Value)
	}
	if input.ScreenedAt.Set {
		if input.ScreenedAt.Value == nil || strings.TrimSpace(*input.ScreenedAt.Value) == "" {
			add("screened_at", nil)
		} else {
			parsed, err := crm_intent.ParseDateTime(*input.ScreenedAt.Value)
			if err != nil {
				return "", nil, crm_intent.NewValidationError("screened_at 必须是 YYYY-MM-DD")
			}
			add("screened_at", parsed.Format("2006-01-02"))
		}
	}
	if input.PhoneNote.Set {
		addNullable("phone_note", input.PhoneNote.Value)
	}
	args = append(args, actor.ID, companyID)
	actorArg := "$" + strconv.Itoa(len(args)-1)
	idArg := "$" + strconv.Itoa(len(args))
	sets = append(sets,
		"owner_id = coalesce(owner_id, "+actorArg+")",
		"human_touched_at = now()",
		"human_touched_by = "+actorArg,
		"updated_at = now()",
	)
	query := "update public.crm_intent_companies set " + strings.Join(sets, ", ") +
		" where id = " + idArg
	return query, args, nil
}

func (s *CRMIntentStore) UpdateFollowup(
	ctx context.Context,
	companyID int64,
	input crm_intent.FollowupWrite,
	actor crm_intent.Actor,
) (*crm_intent.Followup, error) {
	var followup crm_intent.Followup
	err := s.inTx(ctx, func(db FullDB, tx pgx.Tx) error {
		owner, _, converted, err := lockCompanyForHumanWrite(ctx, db, companyID)
		if err != nil {
			return err
		}
		if err := authorizeHumanWrite(owner, actor); err != nil {
			return err
		}
		if converted != nil {
			return crm_intent.NewConflictError("INTENT_ALREADY_CONVERTED", "记录已转为客户，跟进区只读")
		}
		var (
			fromState     *string
			state         = crm_intent.StateNone
			note          = ""
			lastContactAt *time.Time
			nextContactAt *time.Time
			version       = 0
			updatedBy     *string
			updatedAt     *time.Time
		)
		rowErr := db.QueryRow(ctx, `select state, note, last_contact_at, next_contact_at,
			version, updated_by, updated_at from public.crm_intent_followups
			where company_id = $1 for update`, companyID).Scan(
			&state, &note, &lastContactAt, &nextContactAt, &version, &updatedBy, &updatedAt,
		)
		existing := true
		if errors.Is(rowErr, pgx.ErrNoRows) {
			existing = false
			state = crm_intent.StateNone
			note = ""
			version = 0
		} else if rowErr != nil {
			return rowErr
		} else {
			previous := state
			fromState = &previous
		}
		if input.ExpectedVersion != nil && *input.ExpectedVersion != version {
			currentPhones, phoneErr := validPhonesForCompany(ctx, db, companyID)
			if phoneErr != nil {
				return phoneErr
			}
			updatedAtText := ""
			if updatedAt != nil {
				updatedAtText = timestampText(*updatedAt)
			}
			current := crm_intent.Followup{
				CompanyID:     companyID,
				State:         state,
				StateLabel:    crm_intent.FollowupStateLabel(state),
				Note:          note,
				LastContactAt: optionalTimestampText(lastContactAt),
				NextContactAt: optionalTimestampText(nextContactAt),
				ValidPhones:   currentPhones,
				Version:       version,
				UpdatedBy:     updatedBy,
				UpdatedAt:     updatedAtText,
			}
			conflict := crm_intent.NewConflictError("INTENT_VERSION_CONFLICT", "记录已被其他人更新")
			conflict.Current = &current
			return conflict
		}
		if input.State != nil {
			if !crm_intent.ValidFollowupState(*input.State) {
				return crm_intent.NewValidationError("state 非法")
			}
			state = *input.State
		}
		if input.Note != nil {
			note = *input.Note
		}
		if input.LastContactAt.Set {
			lastContactAt = input.LastContactAt.Value
		}
		if input.NextContactAt.Set {
			nextContactAt = input.NextContactAt.Value
		}
		if input.ValidPhones != nil {
			if err := s.applyValidPhones(ctx, db, companyID, *input.ValidPhones, actor); err != nil {
				return err
			}
		}
		var storedVersion int
		if existing {
			storedVersion = version + 1
			if err := db.QueryRow(ctx, `update public.crm_intent_followups
				set state = $2, note = $3, last_contact_at = $4, next_contact_at = $5,
				    version = version + 1, updated_by = $6, updated_at = now()
				where company_id = $1
				returning version`,
				companyID, state, note, lastContactAt, nextContactAt, actor.ID,
			).Scan(&storedVersion); err != nil {
				return err
			}
		} else {
			storedVersion = 1
			if err := db.QueryRow(ctx, `insert into public.crm_intent_followups
				(company_id, state, note, last_contact_at, next_contact_at, version, updated_by, updated_at)
				values ($1, $2, $3, $4, $5, 1, $6, now())
				returning version`,
				companyID, state, note, lastContactAt, nextContactAt, actor.ID,
			).Scan(&storedVersion); err != nil {
				return err
			}
		}
		var noteSnapshot *string
		if note != "" {
			value := note
			noteSnapshot = &value
		}
		if _, err := db.Exec(ctx, `insert into public.crm_intent_followup_events
			(company_id, from_state, to_state, note_snapshot, actor_id)
			values ($1, $2, $3, $4, $5)`,
			companyID, fromState, state, noteSnapshot, actor.ID); err != nil {
			return err
		}
		if err := touchCompanyHumanWrite(ctx, db, companyID, actor); err != nil {
			return err
		}
		if _, err := s.bumpRevisions(ctx, db, false, true); err != nil {
			return err
		}
		if err := insertCRMAudit(ctx, db, "intent_followup", companyID, "update", actor.ID, "更新跟进"); err != nil {
			return err
		}
		entry := audit.Entry{
			Action: "crm_intent.followup_update", TargetType: "crm_intent_company",
			TargetID: auditTarget(companyID),
		}
		applyActor := actor
		applyAuditActor(&entry, applyActor)
		if err := s.logOperation(ctx, tx, entry); err != nil {
			return err
		}
		phoneList, err := validPhonesForCompany(ctx, db, companyID)
		if err != nil {
			return err
		}
		followup = crm_intent.Followup{
			CompanyID:     companyID,
			State:         state,
			StateLabel:    crm_intent.FollowupStateLabel(state),
			Note:          note,
			LastContactAt: optionalTimestampText(lastContactAt),
			NextContactAt: optionalTimestampText(nextContactAt),
			ValidPhones:   phoneList,
			Version:       storedVersion,
			UpdatedBy:     &actor.ID,
			UpdatedAt:     timestampText(time.Now()),
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &followup, nil
}

func (s *CRMIntentStore) applyValidPhones(
	ctx context.Context,
	db FullDB,
	companyID int64,
	phones []string,
	actor crm_intent.Actor,
) error {
	normalized, err := normalizePhoneList(phones)
	if err != nil {
		return err
	}
	if len(normalized) > 0 {
		rows, err := db.Query(ctx, `select phone_normalized from public.crm_intent_phones
			where company_id = $1 and phone_normalized = any($2)`, companyID, normalized)
		if err != nil {
			return err
		}
		found, err := scanStringRows(rows)
		if err != nil {
			return err
		}
		if len(found) != len(normalized) {
			return crm_intent.NewValidationError("有效电话必须来自该公司已录入的号码")
		}
	}
	if _, err := db.Exec(ctx, `update public.crm_intent_phones set is_valid = false
		where company_id = $1`, companyID); err != nil {
		return err
	}
	if len(normalized) == 0 {
		return nil
	}
	_, err = db.Exec(ctx, `update public.crm_intent_phones set is_valid = true
		where company_id = $1 and phone_normalized = any($2)`, companyID, normalized)
	return err
}

func (s *CRMIntentStore) AddPhone(
	ctx context.Context,
	companyID int64,
	input crm_intent.PhoneCreate,
	actor crm_intent.Actor,
) (*crm_intent.Company, error) {
	normalized, err := crm_intent.NormalizePhone(input.PhoneRaw)
	if err != nil {
		return nil, crm_intent.NewValidationError("号码格式非法: " + input.PhoneRaw)
	}
	source := input.Source
	if source == "" {
		source = crm_intent.PhoneSourceManual
	}
	if source != crm_intent.PhoneSourceList && source != crm_intent.PhoneSourceManual && source != crm_intent.PhoneSourceAI {
		return nil, crm_intent.NewValidationError("号码来源非法")
	}
	txErr := s.inTx(ctx, func(db FullDB, tx pgx.Tx) error {
		owner, _, _, err := lockCompanyForHumanWrite(ctx, db, companyID)
		if err != nil {
			return err
		}
		if err := authorizeHumanWrite(owner, actor); err != nil {
			return err
		}
		raw := strings.TrimSpace(input.PhoneRaw)
		if raw == "" {
			raw = normalized
		}
		if _, err := db.Exec(ctx, `insert into public.crm_intent_phones
			(company_id, phone_raw, phone_normalized, source, is_valid, created_by)
			values ($1, $2, $3, $4, $5, $6)
			on conflict (company_id, phone_normalized) where company_id is not null do nothing`,
			companyID, raw, normalized, source, input.IsValid, actor.ID); err != nil {
			return err
		}
		if err := touchCompanyHumanWrite(ctx, db, companyID, actor); err != nil {
			return err
		}
		if _, err := s.bumpRevisions(ctx, db, true, input.IsValid); err != nil {
			return err
		}
		if err := insertCRMAudit(ctx, db, "intent_company", companyID, "add_phone", actor.ID, "补录手机号"); err != nil {
			return err
		}
		entry := audit.Entry{
			Action: "crm_intent.phone_add", TargetType: "crm_intent_company",
			TargetID: auditTarget(companyID),
		}
		applyAuditActor(&entry, actor)
		return s.logOperation(ctx, tx, entry)
	})
	if txErr != nil {
		return nil, txErr
	}
	return s.reloadCompany(ctx, companyID, actor)
}

func (s *CRMIntentStore) UpdatePhone(
	ctx context.Context,
	companyID int64,
	phoneID int64,
	input crm_intent.PhoneUpdate,
	actor crm_intent.Actor,
) (*crm_intent.Company, error) {
	txErr := s.inTx(ctx, func(db FullDB, tx pgx.Tx) error {
		owner, _, _, err := lockCompanyForHumanWrite(ctx, db, companyID)
		if err != nil {
			return err
		}
		if err := authorizeHumanWrite(owner, actor); err != nil {
			return err
		}
		var exists bool
		if err := db.QueryRow(ctx, `select true from public.crm_intent_phones
			where id = $1 and company_id = $2 for update`, phoneID, companyID).Scan(&exists); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return crm_intent.NewNotFoundError("手机号", phoneID)
			}
			return err
		}
		if input.PhoneRaw.Set {
			if input.PhoneRaw.Value == nil || strings.TrimSpace(*input.PhoneRaw.Value) == "" {
				return crm_intent.NewValidationError("phone_raw 不能为空")
			}
			normalized, err := crm_intent.NormalizePhone(*input.PhoneRaw.Value)
			if err != nil {
				return crm_intent.NewValidationError("号码格式非法")
			}
			if _, err := db.Exec(ctx, `update public.crm_intent_phones
				set phone_raw = $1, phone_normalized = $2 where id = $3`,
				strings.TrimSpace(*input.PhoneRaw.Value), normalized, phoneID); err != nil {
				return mapPGError(err)
			}
		}
		if input.IsValid.Set {
			valid := input.IsValid.Value != nil && *input.IsValid.Value
			if _, err := db.Exec(ctx, `update public.crm_intent_phones
				set is_valid = $1 where id = $2`, valid, phoneID); err != nil {
				return err
			}
		}
		if err := touchCompanyHumanWrite(ctx, db, companyID, actor); err != nil {
			return err
		}
		if _, err := s.bumpRevisions(ctx, db, true, input.IsValid.Set); err != nil {
			return err
		}
		if err := insertCRMAudit(ctx, db, "intent_company", companyID, "update_phone", actor.ID, "更新手机号"); err != nil {
			return err
		}
		entry := audit.Entry{
			Action: "crm_intent.phone_update", TargetType: "crm_intent_company",
			TargetID: auditTarget(companyID),
		}
		applyAuditActor(&entry, actor)
		return s.logOperation(ctx, tx, entry)
	})
	if txErr != nil {
		return nil, txErr
	}
	return s.reloadCompany(ctx, companyID, actor)
}

func (s *CRMIntentStore) DeletePhone(
	ctx context.Context,
	companyID int64,
	phoneID int64,
	actor crm_intent.Actor,
) (*crm_intent.Company, error) {
	txErr := s.inTx(ctx, func(db FullDB, tx pgx.Tx) error {
		owner, _, _, err := lockCompanyForHumanWrite(ctx, db, companyID)
		if err != nil {
			return err
		}
		if err := authorizeHumanWrite(owner, actor); err != nil {
			return err
		}
		var source string
		var wasValid bool
		if err := db.QueryRow(ctx, `select source, is_valid from public.crm_intent_phones
			where id = $1 and company_id = $2 for update`, phoneID, companyID).Scan(
			&source, &wasValid,
		); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return crm_intent.NewNotFoundError("手机号", phoneID)
			}
			return err
		}
		if source != crm_intent.PhoneSourceManual {
			return crm_intent.NewConflictError("INTENT_PHONE_NOT_DELETABLE", "仅允许删除人工补录的号码")
		}
		if _, err := db.Exec(ctx,
			`delete from public.crm_intent_phones where id = $1`, phoneID,
		); err != nil {
			return err
		}
		if err := touchCompanyHumanWrite(ctx, db, companyID, actor); err != nil {
			return err
		}
		if _, err := s.bumpRevisions(ctx, db, true, wasValid); err != nil {
			return err
		}
		if err := insertCRMAudit(ctx, db, "intent_company", companyID, "delete_phone", actor.ID, "删除手机号"); err != nil {
			return err
		}
		entry := audit.Entry{
			Action: "crm_intent.phone_delete", TargetType: "crm_intent_company",
			TargetID: auditTarget(companyID),
		}
		applyAuditActor(&entry, actor)
		return s.logOperation(ctx, tx, entry)
	})
	if txErr != nil {
		return nil, txErr
	}
	return s.reloadCompany(ctx, companyID, actor)
}

func (s *CRMIntentStore) ConvertCompany(
	ctx context.Context,
	companyID int64,
	actor crm_intent.Actor,
) (*crm_intent.ConvertResult, error) {
	var customerID int64
	txErr := s.inTx(ctx, func(db FullDB, tx pgx.Tx) error {
		var (
			name, intentLevel           string
			category, legalPerson       *string
			province, city, intentBasis *string
		)
		owner, _, converted, err := lockCompanyForHumanWrite(ctx, db, companyID)
		if err != nil {
			return err
		}
		if converted != nil {
			return crm_intent.NewConflictError("INTENT_ALREADY_CONVERTED", "记录已转为客户")
		}
		if err := authorizeHumanWrite(owner, actor); err != nil {
			return err
		}
		if err := db.QueryRow(ctx, `select name, category, legal_person, province, city,
			intent_level, intent_basis from public.crm_intent_companies where id = $1`,
			companyID).Scan(
			&name, &category, &legalPerson, &province, &city, &intentLevel, &intentBasis,
		); err != nil {
			return err
		}
		addressParts := make([]string, 0, 2)
		if province != nil && strings.TrimSpace(*province) != "" {
			addressParts = append(addressParts, strings.TrimSpace(*province))
		}
		if city != nil && strings.TrimSpace(*city) != "" {
			addressParts = append(addressParts, strings.TrimSpace(*city))
		}
		var address *string
		if len(addressParts) > 0 {
			value := strings.Join(addressParts, " ")
			address = &value
		}
		remark := "客户雷达转入"
		if intentBasis != nil && strings.TrimSpace(*intentBasis) != "" {
			basis := []rune(strings.TrimSpace(*intentBasis))
			if len(basis) > 500 {
				basis = basis[:500]
			}
			remark = "客户雷达转入。意向依据：" + string(basis)
		}
		var industry *string
		if category != nil && strings.TrimSpace(*category) != "" {
			value := strings.TrimSpace(*category)
			industry = &value
		}
		ownerID := effectiveConvertOwner(owner, actor)
		rating := intentLevel
		if rating == "" {
			rating = crm_intent.LevelD
		}
		if err := db.QueryRow(ctx, `insert into public.crm_customers
			(name, industry, rating, status, source, owner_id, address, remark, created_by)
			values ($1, $2, $3, 'active', 'customer_radar', $4, $5, $6, $7)
			returning id`,
			name, industry, rating, ownerID, address, remark, actor.ID,
		).Scan(&customerID); err != nil {
			return err
		}
		contactName := name
		if legalPerson != nil && strings.TrimSpace(*legalPerson) != "" {
			contactName = strings.TrimSpace(*legalPerson)
		}
		var primaryPhone *string
		if err := db.QueryRow(ctx, `select phone_normalized from public.crm_intent_phones
			where company_id = $1 order by is_valid desc, id asc limit 1`, companyID).Scan(
			&primaryPhone,
		); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if _, err := db.Exec(ctx, `insert into public.crm_contacts
			(customer_id, name, phone, is_primary)
			values ($1, $2, $3, true)`, customerID, contactName, primaryPhone); err != nil {
			return err
		}
		if _, err := db.Exec(ctx, `update public.crm_intent_companies
			set converted_customer_id = $1, converted_at = now(),
			    owner_id = coalesce(owner_id, $2), human_touched_at = now(),
			    human_touched_by = $2, updated_at = now()
			where id = $3`, customerID, actor.ID, companyID); err != nil {
			return err
		}
		if _, err := s.bumpRevisions(ctx, db, true, false); err != nil {
			return err
		}
		if err := insertCRMAudit(ctx, db, "customer", customerID, "create", actor.ID, "客户雷达转为客户"); err != nil {
			return err
		}
		if err := insertCRMAudit(ctx, db, "intent_company", companyID, "convert", actor.ID, "转为客户"); err != nil {
			return err
		}
		entry := audit.Entry{
			Action: "crm_intent.convert", TargetType: "crm_intent_company",
			TargetID:  auditTarget(companyID),
			AfterJSON: map[string]any{"customer_id": customerID},
		}
		applyAuditActor(&entry, actor)
		return s.logOperation(ctx, tx, entry)
	})
	if txErr != nil {
		return nil, txErr
	}
	company, err := s.reloadCompany(ctx, companyID, actor)
	if err != nil {
		return nil, err
	}
	dataRev, err := s.currentDataRev(ctx)
	if err != nil {
		return nil, err
	}
	return &crm_intent.ConvertResult{
		CompanyID: companyID, CustomerID: customerID, Company: company, DataRev: dataRev,
	}, nil
}

// effectiveConvertOwner keeps the existing owner, otherwise assigns the acting
// user (a sea record converted by a user must not create an unowned customer).
func effectiveConvertOwner(owner *string, actor crm_intent.Actor) *string {
	if owner != nil {
		return owner
	}
	trimmed := strings.TrimSpace(actor.ID)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// normalizePhoneList normalizes and de-duplicates valid-phone input.
func normalizePhoneList(values []string) ([]string, error) {
	normalized := make([]string, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, raw := range values {
		value, err := crm_intent.NormalizePhone(raw)
		if err != nil {
			return nil, crm_intent.NewValidationError("有效电话格式非法: " + raw)
		}
		if seen[value] {
			continue
		}
		seen[value] = true
		normalized = append(normalized, value)
	}
	return normalized, nil
}

func (s *CRMIntentStore) currentDataRev(ctx context.Context) (int64, error) {
	dataRev, _, err := s.GetRevisions(ctx)
	return dataRev, err
}

// ---------- batches ----------

const crmIntentBatchColumns = `id, batch_date, source, source_file_name, r2_key,
	content_sha256, result_json, total_companies, total_pool, created_count, updated_count,
	skipped_locked_count, rejected_count, status, error_detail, created_by,
	created_at, completed_at`

func scanBatch(row interface{ Scan(...any) error }) (*crm_intent.Batch, []byte, error) {
	var (
		item        crm_intent.Batch
		batchDate   time.Time
		sourceFile  *string
		r2Key       *string
		contentSHA  *string
		resultJSON  []byte
		errorDetail *string
		createdBy   *string
		createdAt   time.Time
		completedAt *time.Time
	)
	if err := row.Scan(
		&item.ID, &batchDate, &item.Source, &sourceFile, &r2Key, &contentSHA,
		&resultJSON, &item.TotalCompanies, &item.TotalPool, &item.CreatedCount,
		&item.UpdatedCount, &item.SkippedLockedCount, &item.RejectedCount,
		&item.Status, &errorDetail, &createdBy, &createdAt, &completedAt,
	); err != nil {
		return nil, nil, err
	}
	item.BatchDate = batchDate.Format("2006-01-02")
	item.SourceLabel = batchSourceLabel(item.Source)
	item.SourceFileName = sourceFile
	item.R2Key = r2Key
	item.ContentSHA256 = contentSHA
	item.ErrorDetail = errorDetail
	item.CreatedBy = createdBy
	item.CreatedAt = timestampText(createdAt)
	item.CompletedAt = optionalTimestampText(completedAt)
	return &item, resultJSON, nil
}

func batchSourceLabel(source string) string {
	if source == crm_intent.BatchSourceAI {
		return "AI 导入"
	}
	return "人工导入"
}

func (s *CRMIntentStore) ListBatches(
	ctx context.Context,
	page int,
	pageSize int,
) (crm_intent.Paginated[crm_intent.Batch], error) {
	result := crm_intent.Paginated[crm_intent.Batch]{
		Items: []crm_intent.Batch{}, Page: page, PageSize: pageSize,
	}
	if err := s.db.QueryRow(ctx,
		`select count(*) from public.crm_intent_batches`,
	).Scan(&result.Total); err != nil {
		return result, err
	}
	offset := (page - 1) * pageSize
	rows, err := s.db.Query(ctx, "select "+crmIntentBatchColumns+
		" from public.crm_intent_batches order by id desc limit $1 offset $2",
		pageSize, offset)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		item, _, scanErr := scanBatch(rows)
		if scanErr != nil {
			rows.Close()
			return result, scanErr
		}
		result.Items = append(result.Items, *item)
	}
	rows.Close()
	return result, rows.Err()
}

// batchResultJSON is the persisted row-level ingest outcome.
type batchResultJSON struct {
	Rows          []crm_intent.BatchRow `json:"rows"`
	RowsTruncated bool                  `json:"rows_truncated"`
	TotalRows     int                   `json:"total_rows"`
}

func (s *CRMIntentStore) GetBatch(
	ctx context.Context,
	batchID int64,
) (*crm_intent.BatchDetail, error) {
	item, resultJSON, err := scanBatch(s.db.QueryRow(ctx, "select "+crmIntentBatchColumns+
		" from public.crm_intent_batches where id = $1", batchID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	detail := &crm_intent.BatchDetail{
		Batch: *item, Rejected: []crm_intent.RejectedRow{},
		Rows: []crm_intent.BatchRow{},
	}
	if len(resultJSON) > 0 {
		var stored batchResultJSON
		if unmarshalErr := json.Unmarshal(resultJSON, &stored); unmarshalErr == nil {
			if stored.Rows != nil {
				detail.Rows = stored.Rows
			}
			detail.RowsTruncated = stored.RowsTruncated
		}
	}
	return detail, nil
}

func (s *CRMIntentStore) CreateBatch(
	ctx context.Context,
	input crm_intent.BatchCreate,
) (int64, error) {
	var batchID int64
	err := s.db.QueryRow(ctx, `insert into public.crm_intent_batches
		(batch_date, source, source_file_name, status, created_by)
		values ($1, $2, $3, 'processing', $4)
		returning id`,
		input.BatchDate, input.Source, input.SourceFileName, input.CreatedBy,
	).Scan(&batchID)
	return batchID, err
}

func (s *CRMIntentStore) AttachBatchArchive(
	ctx context.Context,
	batchID int64,
	r2Key string,
	sha256 string,
) error {
	_, err := s.db.Exec(ctx, `update public.crm_intent_batches
		set r2_key = $2, content_sha256 = $3 where id = $1`, batchID, r2Key, sha256)
	return err
}

func (s *CRMIntentStore) FailBatch(
	ctx context.Context,
	batchID int64,
	detail string,
) error {
	_, err := s.db.Exec(ctx, `update public.crm_intent_batches
		set status = 'failed', error_detail = $2, completed_at = now() where id = $1`,
		batchID, detail)
	return err
}

func phoneSourceForActor(actor crm_intent.Actor) string {
	if actor.IsAgent() {
		return crm_intent.PhoneSourceAI
	}
	return crm_intent.PhoneSourceList
}

type upsertOutcome int

const (
	upsertCreated upsertOutcome = iota
	upsertUpdated
	upsertSkippedLocked
	upsertSkippedExisting
)

func (s *CRMIntentStore) findCompanyID(
	ctx context.Context,
	db DB,
	input crm_intent.CompanyInput,
) (int64, bool, error) {
	var (
		creditMatch int64
		creditFound bool
		nameMatch   int64
		nameFound   bool
	)
	if input.CreditCode != nil && strings.TrimSpace(*input.CreditCode) != "" {
		credit := strings.TrimSpace(*input.CreditCode)
		err := db.QueryRow(ctx,
			`select id from public.crm_intent_companies where credit_code = $1 limit 1`, credit,
		).Scan(&creditMatch)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return 0, false, err
		}
		creditFound = err == nil
	}
	nameKey := crm_intent.NormalizeNameKey(pointerOrEmpty(input.Name))
	err := db.QueryRow(ctx,
		`select id from public.crm_intent_companies where name_key = $1 limit 1`, nameKey,
	).Scan(&nameMatch)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, false, err
	}
	nameFound = err == nil
	if creditFound && nameFound && creditMatch != nameMatch {
		return 0, false, crm_intent.NewConflictError(
			"INTENT_DUPLICATE_CONFLICT",
			"credit_code 与 name_key 指向不同的记录，无法安全 upsert",
		)
	}
	if creditFound {
		return creditMatch, true, nil
	}
	if nameFound {
		return nameMatch, true, nil
	}
	return 0, false, nil
}

func pointerOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func nullIfEmpty(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func insertCompanyPhones(
	ctx context.Context,
	db Execer,
	companyID int64,
	phones []string,
	source string,
) error {
	for _, raw := range phones {
		normalized, err := crm_intent.NormalizePhone(raw)
		if err != nil {
			continue
		}
		rawValue := strings.TrimSpace(raw)
		if len([]rune(rawValue)) > 50 {
			rawValue = normalized
		}
		if _, err := db.Exec(ctx, `insert into public.crm_intent_phones
			(company_id, phone_raw, phone_normalized, source)
			values ($1, $2, $3, $4)
			on conflict (company_id, phone_normalized) where company_id is not null do nothing`,
			companyID, rawValue, normalized, source); err != nil {
			return err
		}
	}
	return nil
}

func insertPoolPhones(
	ctx context.Context,
	db Execer,
	poolID int64,
	phones []string,
	source string,
) error {
	for _, raw := range phones {
		normalized, err := crm_intent.NormalizePhone(raw)
		if err != nil {
			continue
		}
		rawValue := strings.TrimSpace(raw)
		if len([]rune(rawValue)) > 50 {
			rawValue = normalized
		}
		if _, err := db.Exec(ctx, `insert into public.crm_intent_phones
			(pool_id, phone_raw, phone_normalized, source)
			values ($1, $2, $3, $4)
			on conflict (pool_id, phone_normalized) where pool_id is not null do nothing`,
			poolID, rawValue, normalized, source); err != nil {
			return err
		}
	}
	return nil
}

// upsertCompanyTx performs the shared upsert (AI + human import). It returns
// the company ID and an outcome for lock / insert_only handling.
func (s *CRMIntentStore) upsertCompanyTx(
	ctx context.Context,
	db FullDB,
	batchID *int64,
	input crm_intent.CompanyInput,
	mode string,
	phoneSource string,
) (int64, upsertOutcome, error) {
	companyID, found, err := s.findCompanyID(ctx, db, input)
	if err != nil {
		return 0, upsertCreated, err
	}
	name := strings.TrimSpace(pointerOrEmpty(input.Name))
	if name == "" {
		return 0, upsertCreated, crm_intent.NewValidationError("name 是必填字段")
	}
	nameKey := crm_intent.NormalizeNameKey(name)
	trademarks := input.Trademarks
	if trademarks == nil {
		trademarks = []string{}
	}
	sources := input.Sources
	if sources == nil {
		sources = []string{}
	}
	channels := input.Channels
	if channels == nil {
		channels = []string{}
	}
	trademarkCount := len(trademarks)
	if input.TrademarkCount != nil {
		trademarkCount = *input.TrademarkCount
	}
	level := crm_intent.LevelD
	if input.IntentLevel != nil && *input.IntentLevel != "" {
		level = *input.IntentLevel
	}
	if found {
		var humanTouchedAt *time.Time
		if err := db.QueryRow(ctx,
			`select human_touched_at from public.crm_intent_companies where id = $1`, companyID,
		).Scan(&humanTouchedAt); err != nil {
			return companyID, upsertSkippedLocked, err
		}
		if humanTouchedAt != nil {
			return companyID, upsertSkippedLocked, nil
		}
		if mode == crm_intent.ModeInsertOnly {
			return companyID, upsertSkippedExisting, nil
		}
		// AI/human ingest never rewrites an existing record's batch attribution
		// (agent spec: batch_id is not writable by agents).
		tag, err := db.Exec(ctx, `update public.crm_intent_companies set
			external_id = $2, name = $3, name_key = $4, credit_code = $5,
			legal_person = $6, province = $7, city = $8, founded_year = $9,
			registered_capital_wan = $10, products = $11, category = $12,
			channel = $13, channels = $14, channel_source = $15,
			trademarks = $16, trademark_count = $17, intent_level = $18,
			intent_score = $19, intent_basis = $20, amazon_fit = $21,
			walmart_fit = $22, sources = $23, risks = $24, screened_at = $25,
			phone_note = $26, updated_at = now()
			where id = $1 and human_touched_at is null`,
			companyID, nullIfEmpty(input.ExternalID), name, nameKey,
			nullIfEmpty(input.CreditCode), nullIfEmpty(input.LegalPerson),
			nullIfEmpty(input.Province), nullIfEmpty(input.City), input.FoundedYear,
			input.RegisteredCapitalWan, nullIfEmpty(input.Products),
			nullIfEmpty(input.Category), nullIfEmpty(input.Channel), channels,
			nullIfEmpty(input.ChannelSource), trademarks, trademarkCount, level,
			input.IntentScore, nullIfEmpty(input.IntentBasis), nullIfEmpty(input.AmazonFit),
			nullIfEmpty(input.WalmartFit), sources, nullIfEmpty(input.Risks),
			nullIfEmpty(input.ScreenedAt), nullIfEmpty(input.PhoneNote),
		)
		if err != nil {
			return companyID, upsertUpdated, mapPGError(err)
		}
		if tag.RowsAffected() == 0 {
			return companyID, upsertSkippedLocked, nil
		}
		if err := insertCompanyPhones(ctx, db, companyID, input.Phones, phoneSource); err != nil {
			return companyID, upsertUpdated, err
		}
		return companyID, upsertUpdated, nil
	}
	if err := db.QueryRow(ctx, `insert into public.crm_intent_companies
		(batch_id, external_id, name, name_key, credit_code, legal_person, province,
		 city, founded_year, registered_capital_wan, products, category,
		 channel, channels, channel_source, trademarks,
		 trademark_count, intent_level, intent_score, intent_basis, amazon_fit,
		 walmart_fit, sources, risks, screened_at, phone_note)
		values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
		 $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
		returning id`,
		batchID, nullIfEmpty(input.ExternalID), name, nameKey,
		nullIfEmpty(input.CreditCode), nullIfEmpty(input.LegalPerson),
		nullIfEmpty(input.Province), nullIfEmpty(input.City), input.FoundedYear,
		input.RegisteredCapitalWan, nullIfEmpty(input.Products),
		nullIfEmpty(input.Category), nullIfEmpty(input.Channel), channels,
		nullIfEmpty(input.ChannelSource), trademarks, trademarkCount, level,
		input.IntentScore, nullIfEmpty(input.IntentBasis), nullIfEmpty(input.AmazonFit),
		nullIfEmpty(input.WalmartFit), sources, nullIfEmpty(input.Risks),
		nullIfEmpty(input.ScreenedAt), nullIfEmpty(input.PhoneNote),
	).Scan(&companyID); err != nil {
		return 0, upsertCreated, mapPGError(err)
	}
	if err := insertCompanyPhones(ctx, db, companyID, input.Phones, phoneSource); err != nil {
		return companyID, upsertCreated, err
	}
	return companyID, upsertCreated, nil
}

func (s *CRMIntentStore) upsertPoolTx(
	ctx context.Context,
	db FullDB,
	batchID int64,
	input crm_intent.PoolInput,
	mode string,
	phoneSource string,
) (int64, upsertOutcome, error) {
	name := strings.TrimSpace(pointerOrEmpty(input.Name))
	if name == "" {
		return 0, upsertCreated, crm_intent.NewValidationError("name 是必填字段")
	}
	nameKey := crm_intent.NormalizeNameKey(name)
	var poolID int64
	err := db.QueryRow(ctx,
		`select id from public.crm_intent_pool where name_key = $1 limit 1`, nameKey,
	).Scan(&poolID)
	if err == nil {
		if mode == crm_intent.ModeInsertOnly {
			return poolID, upsertSkippedExisting, nil
		}
		channels := input.Channels
		if channels == nil {
			channels = []string{}
		}
		var channelsArg any
		if len(channels) > 0 {
			channelsArg = channels
		}
		// Batch attribution is set on insert only; re-imports keep the original
		// batch so agents can never rewrite ownership/attribution.
		if _, err := db.Exec(ctx, `update public.crm_intent_pool set
			external_id = coalesce($2, external_id),
			legal_person = coalesce($3, legal_person), website = coalesce($4, website),
			channel = coalesce($5, channel), channels = coalesce($6, channels),
			channel_source = coalesce($7, channel_source), updated_at = now()
			where id = $1`,
			poolID, nullIfEmpty(input.ExternalID), nullIfEmpty(input.LegalPerson),
			nullIfEmpty(input.Website), nullIfEmpty(input.Channel), channelsArg,
			nullIfEmpty(input.ChannelSource),
		); err != nil {
			return poolID, upsertUpdated, mapPGError(err)
		}
		if err := insertPoolPhones(ctx, db, poolID, input.Phones, phoneSource); err != nil {
			return poolID, upsertUpdated, err
		}
		return poolID, upsertUpdated, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, upsertCreated, err
	}
	channels := input.Channels
	if channels == nil {
		channels = []string{}
	}
	if err := db.QueryRow(ctx, `insert into public.crm_intent_pool
		(batch_id, external_id, name, name_key, legal_person, website, channel,
		 channels, channel_source, status)
		values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
		returning id`,
		batchID, nullIfEmpty(input.ExternalID), name, nameKey,
		nullIfEmpty(input.LegalPerson), nullIfEmpty(input.Website),
		nullIfEmpty(input.Channel), channels, nullIfEmpty(input.ChannelSource),
	).Scan(&poolID); err != nil {
		return 0, upsertCreated, mapPGError(err)
	}
	if err := insertPoolPhones(ctx, db, poolID, input.Phones, phoneSource); err != nil {
		return poolID, upsertCreated, err
	}
	return poolID, upsertCreated, nil
}

// runRowSavepoint isolates one ingest row so a data error can be rolled back
// to the savepoint without aborting the whole batch (spec: row-level tx).
func (s *CRMIntentStore) runRowSavepoint(
	ctx context.Context,
	db FullDB,
	row func() (int64, upsertOutcome, error),
) (int64, upsertOutcome, error) {
	if _, err := db.Exec(ctx, "savepoint crm_intent_row"); err != nil {
		return 0, upsertCreated, err
	}
	rowID, outcome, rowErr := row()
	if rowErr != nil {
		if _, rollbackErr := db.Exec(ctx, "rollback to savepoint crm_intent_row"); rollbackErr != nil {
			return 0, outcome, rollbackErr
		}
		_, _ = db.Exec(ctx, "release savepoint crm_intent_row")
		return rowID, outcome, rowErr
	}
	if _, err := db.Exec(ctx, "release savepoint crm_intent_row"); err != nil {
		return rowID, outcome, err
	}
	return rowID, outcome, nil
}

// rowRejectionReason converts expected row-scoped errors into a rejected-row
// reason; an empty string means the error must abort the batch.
func rowRejectionReason(err error) string {
	var domainErr *crm_intent.DomainError
	if errors.As(err, &domainErr) {
		switch domainErr.Code {
		case "INTENT_DUPLICATE_CONFLICT", "VALIDATION_FAILED":
			return domainErr.Message
		}
		return ""
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return "行数据不满足数据库约束（" + pgErr.Code + "）"
	}
	return ""
}

func (s *CRMIntentStore) IngestBatch(
	ctx context.Context,
	request crm_intent.IngestRequest,
) (crm_intent.IngestResult, error) {
	result := crm_intent.IngestResult{
		BatchID:  request.BatchID,
		Status:   crm_intent.BatchCompleted,
		Rejected: append([]crm_intent.RejectedRow{}, request.Rejected...),
	}
	rows := make([]crm_intent.BatchRow, 0, len(request.Companies)+len(request.Pool))
	for _, rejected := range request.Rejected {
		rows = append(rows, crm_intent.BatchRow{
			Scope: rejected.Scope, Index: rejected.Index,
			ExternalID: rejected.ExternalID, Status: "rejected", Reason: rejected.Reason,
		})
	}
	phoneSource := phoneSourceForActor(request.Actor)
	err := s.inTx(ctx, func(db FullDB, tx pgx.Tx) error {
		dataChanged := false
		for index, input := range request.Companies {
			companyID, outcome, err := s.runRowSavepoint(ctx, db,
				func() (int64, upsertOutcome, error) {
					return s.upsertCompanyTx(
						ctx, db, &request.BatchID, input, request.Mode, phoneSource,
					)
				},
			)
			if err != nil {
				reason := rowRejectionReason(err)
				if reason == "" {
					return err
				}
				result.Rejected = append(result.Rejected, crm_intent.RejectedRow{
					Scope: "companies", Index: index,
					ExternalID: input.ExternalID, Reason: reason,
				})
				rows = append(rows, crm_intent.BatchRow{
					Scope: "companies", Index: index, ExternalID: input.ExternalID,
					Status: "rejected", Reason: reason,
				})
				continue
			}
			switch outcome {
			case upsertCreated:
				result.Created++
				dataChanged = true
			case upsertUpdated:
				result.Updated++
				dataChanged = true
			case upsertSkippedLocked:
				result.SkippedLocked++
				if request.Actor.IsAgent() {
					entry := audit.Entry{
						Action:     "crm_intent.ai_write_blocked",
						TargetType: "crm_intent_company", TargetID: auditTarget(companyID),
						Result: "failure",
						AfterJSON: map[string]any{
							"agent_id": request.Actor.ID, "batch_id": request.BatchID,
							"reason": "human_touched",
						},
					}
					applyAuditActor(&entry, request.Actor)
					if err := s.logOperation(ctx, tx, entry); err != nil {
						return err
					}
				}
			case upsertSkippedExisting:
				result.SkippedExisting++
			}
			rows = append(rows, crm_intent.BatchRow{
				Scope: "companies", Index: index, ExternalID: input.ExternalID,
				Status: outcomeStatus(outcome), CompanyID: crmIntentInt64Pointer(companyID),
			})
		}
		for index, input := range request.Pool {
			poolID, outcome, err := s.runRowSavepoint(ctx, db,
				func() (int64, upsertOutcome, error) {
					return s.upsertPoolTx(
						ctx, db, request.BatchID, input, request.Mode, phoneSource,
					)
				},
			)
			if err != nil {
				reason := rowRejectionReason(err)
				if reason == "" {
					return err
				}
				result.Rejected = append(result.Rejected, crm_intent.RejectedRow{
					Scope: "pool", Index: index,
					ExternalID: input.ExternalID, Reason: reason,
				})
				rows = append(rows, crm_intent.BatchRow{
					Scope: "pool", Index: index, ExternalID: input.ExternalID,
					Status: "rejected", Reason: reason,
				})
				continue
			}
			switch outcome {
			case upsertCreated:
				result.Created++
				dataChanged = true
			case upsertUpdated:
				result.Updated++
				dataChanged = true
			case upsertSkippedExisting:
				result.SkippedExisting++
			}
			rows = append(rows, crm_intent.BatchRow{
				Scope: "pool", Index: index, ExternalID: input.ExternalID,
				Status: outcomeStatus(outcome), PoolID: crmIntentInt64Pointer(poolID),
			})
		}
		result.CompaniesTotal = len(request.Companies)
		result.PoolTotal = len(request.Pool)
		dataRev, err := s.bumpRevisions(ctx, db, dataChanged, false)
		if err != nil {
			return err
		}
		result.DataRev = dataRev
		result.RejectedCount = len(result.Rejected)
		stored := batchResultJSON{TotalRows: len(rows)}
		if len(rows) <= 500 {
			stored.Rows = rows
		} else {
			stored.RowsTruncated = true
		}
		storedJSON, marshalErr := json.Marshal(stored)
		if marshalErr != nil {
			return marshalErr
		}
		result.Rows = rows
		if len(result.Rows) > 500 {
			result.Rows = result.Rows[:500]
			result.RowsTruncated = true
		}
		if _, err := db.Exec(ctx, `update public.crm_intent_batches set
			total_companies = $2, total_pool = $3, created_count = $4,
			updated_count = $5, skipped_locked_count = $6, rejected_count = $7,
			result_json = $8::json, status = 'completed', error_detail = null,
			completed_at = now()
			where id = $1`,
			request.BatchID, result.CompaniesTotal, result.PoolTotal, result.Created,
			result.Updated, result.SkippedLocked, result.RejectedCount, storedJSON,
		); err != nil {
			return err
		}
		entry := audit.Entry{
			Action: "crm_intent.batch_import", TargetType: "crm_intent_batch",
			TargetID: auditTarget(request.BatchID),
			AfterJSON: map[string]any{
				"created": result.Created, "updated": result.Updated,
				"skipped_locked": result.SkippedLocked, "rejected": len(result.Rejected),
				"companies_total": result.CompaniesTotal, "pool_total": result.PoolTotal,
				"data_rev": result.DataRev,
			},
		}
		applyAuditActor(&entry, request.Actor)
		return s.logOperation(ctx, tx, entry)
	})
	if err != nil {
		return result, err
	}
	return result, nil
}

// ---------- idempotency ----------

func (s *CRMIntentStore) ReserveImportRequest(
	ctx context.Context,
	actorKind string,
	actorID string,
	idempotencyKey string,
	requestHash string,
) (*crm_intent.ImportRequestState, error) {
	var requestID int64
	err := s.db.QueryRow(ctx, `insert into public.crm_intent_import_requests
		(actor_kind, actor_id, idempotency_key, request_hash, status)
		values ($1, $2, $3, $4, 'processing')
		on conflict (actor_kind, actor_id, idempotency_key) do nothing
		returning id`, actorKind, actorID, idempotencyKey, requestHash).Scan(&requestID)
	if err == nil {
		return &crm_intent.ImportRequestState{ID: requestID}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	var (
		existingHash string
		status       string
		responseText *string
	)
	err = s.db.QueryRow(ctx, `select request_hash, status, response_json::text
		from public.crm_intent_import_requests
		where actor_kind = $1 and actor_id = $2 and idempotency_key = $3`,
		actorKind, actorID, idempotencyKey,
	).Scan(&existingHash, &status, &responseText)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errors.New("import request reservation disappeared")
	}
	if err != nil {
		return nil, err
	}
	if existingHash != requestHash {
		return nil, crm_intent.ErrIdempotencyConflict
	}
	if status == "completed" {
		response := json.RawMessage{}
		if responseText != nil {
			response = json.RawMessage(*responseText)
		}
		return &crm_intent.ImportRequestState{Replay: true, Response: response}, nil
	}
	return nil, crm_intent.ErrIdempotencyInFlight
}

func (s *CRMIntentStore) CompleteImportRequest(
	ctx context.Context,
	actorKind string,
	actorID string,
	idempotencyKey string,
	response []byte,
) error {
	_, err := s.db.Exec(ctx, `update public.crm_intent_import_requests
		set status = 'completed', response_json = $4::json, completed_at = now()
		where actor_kind = $1 and actor_id = $2 and idempotency_key = $3`,
		actorKind, actorID, idempotencyKey, response)
	return err
}

func (s *CRMIntentStore) DeleteImportRequest(
	ctx context.Context,
	actorKind string,
	actorID string,
	idempotencyKey string,
) error {
	_, err := s.db.Exec(ctx, `delete from public.crm_intent_import_requests
		where actor_kind = $1 and actor_id = $2 and idempotency_key = $3`,
		actorKind, actorID, idempotencyKey)
	return err
}

// ---------- agent reads / writes ----------

const agentCompanySelect = `select c.id, c.name, c.credit_code, c.intent_level,
	c.intent_score, c.human_touched_at, c.owner_id, coalesce(f.state, 'none'),
	c.converted_customer_id, c.updated_at
	from public.crm_intent_companies c
	left join public.crm_intent_followups f on f.company_id = c.id`

func scanAgentCompany(row interface{ Scan(...any) error }) (*crm_intent.AgentCompanyItem, error) {
	var (
		item         crm_intent.AgentCompanyItem
		humanTouched *time.Time
		updatedAt    time.Time
	)
	if err := row.Scan(
		&item.ID, &item.Name, &item.CreditCode, &item.IntentLevel,
		&item.IntentScore, &humanTouched, &item.OwnerID, &item.State,
		&item.ConvertedCustomerID, &updatedAt,
	); err != nil {
		return nil, err
	}
	item.HumanTouched = humanTouched != nil
	item.UpdatedAt = timestampText(updatedAt)
	item.Phones = []string{}
	return &item, nil
}

func (s *CRMIntentStore) attachAgentPhones(
	ctx context.Context,
	db DB,
	items []*crm_intent.AgentCompanyItem,
) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(items))
	index := make(map[int64]*crm_intent.AgentCompanyItem, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
		index[item.ID] = item
	}
	rows, err := db.Query(ctx, `select company_id, phone_normalized
		from public.crm_intent_phones where company_id = any($1) order by id`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			companyID  int64
			normalized string
		)
		if err := rows.Scan(&companyID, &normalized); err != nil {
			return err
		}
		if item, ok := index[companyID]; ok {
			item.Phones = append(item.Phones, normalized)
		}
	}
	return rows.Err()
}

func (s *CRMIntentStore) AgentListCompanies(
	ctx context.Context,
	filter crm_intent.AgentCompanyFilter,
) (crm_intent.Paginated[crm_intent.AgentCompanyItem], error) {
	result := crm_intent.Paginated[crm_intent.AgentCompanyItem]{
		Items: []crm_intent.AgentCompanyItem{}, Page: filter.Page, PageSize: filter.PageSize,
	}
	builder := &argsBuilder{}
	if filter.Level != nil {
		builder.add("c.intent_level = " + builder.arg(*filter.Level))
	}
	if filter.State != nil {
		builder.add(`coalesce(f.state, 'none') = ` + builder.arg(*filter.State))
	}
	if filter.Owner != nil {
		builder.add("c.owner_id = " + builder.arg(*filter.Owner))
	}
	if filter.HumanTouched != nil {
		if *filter.HumanTouched {
			builder.add("c.human_touched_at is not null")
		} else {
			builder.add("c.human_touched_at is null")
		}
	}
	if filter.Converted != nil {
		if *filter.Converted {
			builder.add("c.converted_customer_id is not null")
		} else {
			builder.add("c.converted_customer_id is null")
		}
	}
	if filter.BatchID != nil {
		builder.add("c.batch_id = " + builder.arg(*filter.BatchID))
	}
	if filter.Since != nil {
		builder.add("c.updated_at > " + builder.arg(*filter.Since))
	}
	if err := s.db.QueryRow(ctx,
		`select count(*) from public.crm_intent_companies c
		left join public.crm_intent_followups f on f.company_id = c.id`+builder.where(),
		builder.args...,
	).Scan(&result.Total); err != nil {
		return result, err
	}
	offset := (filter.Page - 1) * filter.PageSize
	args := append(append([]any{}, builder.args...), filter.PageSize, offset)
	limitArg := "$" + strconv.Itoa(len(args)-1)
	offsetArg := "$" + strconv.Itoa(len(args))
	query := agentCompanySelect + builder.where() +
		" order by c.updated_at desc, c.id desc limit " + limitArg + " offset " + offsetArg
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return result, err
	}
	pointers := make([]*crm_intent.AgentCompanyItem, 0, filter.PageSize)
	for rows.Next() {
		item, scanErr := scanAgentCompany(rows)
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
	if err := s.attachAgentPhones(ctx, s.db, pointers); err != nil {
		return result, err
	}
	for _, item := range pointers {
		result.Items = append(result.Items, *item)
	}
	return result, nil
}

func (s *CRMIntentStore) AgentGetCompany(
	ctx context.Context,
	companyID int64,
) (*crm_intent.AgentCompanyItem, error) {
	item, err := scanAgentCompany(s.db.QueryRow(ctx,
		agentCompanySelect+" where c.id = $1", companyID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	pointers := []*crm_intent.AgentCompanyItem{item}
	if err := s.attachAgentPhones(ctx, s.db, pointers); err != nil {
		return nil, err
	}
	return item, nil
}

func (s *CRMIntentStore) AgentUpsertCompany(
	ctx context.Context,
	input crm_intent.CompanyInput,
	mode string,
	actor crm_intent.Actor,
) (crm_intent.AgentUpsertResult, error) {
	result := crm_intent.AgentUpsertResult{}
	err := s.inTx(ctx, func(db FullDB, tx pgx.Tx) error {
		companyID, outcome, err := s.upsertCompanyTx(
			ctx, db, nil, input, mode, crm_intent.PhoneSourceAI,
		)
		if err != nil {
			return err
		}
		if outcome == upsertSkippedLocked {
			entry := audit.Entry{
				Action:     "crm_intent.ai_write_blocked",
				TargetType: "crm_intent_company", TargetID: auditTarget(companyID),
				Result:    "failure",
				AfterJSON: map[string]any{"reason": "human_touched", "mode": "single"},
			}
			applyAuditActor(&entry, actor)
			_ = s.logOperation(ctx, tx, entry)
			return crm_intent.NewLockedError(companyID)
		}
		dataRev, err := s.bumpRevisions(ctx, db, true, false)
		if err != nil {
			return err
		}
		result = crm_intent.AgentUpsertResult{
			CompanyID: companyID,
			Created:   outcome == upsertCreated,
			DataRev:   dataRev,
		}
		entry := audit.Entry{
			Action: "crm_intent.company_upsert_ai", TargetType: "crm_intent_company",
			TargetID: auditTarget(companyID),
			AfterJSON: map[string]any{
				"created": result.Created, "changed_fields": "profile",
			},
		}
		applyAuditActor(&entry, actor)
		return s.logOperation(ctx, tx, entry)
	})
	return result, err
}

func (s *CRMIntentStore) AgentPatchCompany(
	ctx context.Context,
	companyID int64,
	input crm_intent.AgentCompanyPatch,
	actor crm_intent.Actor,
) (*crm_intent.AgentCompanyItem, error) {
	err := s.inTx(ctx, func(db FullDB, tx pgx.Tx) error {
		sets := make([]string, 0, 24)
		args := make([]any, 0, 24)
		add := func(column string, value any) {
			args = append(args, value)
			sets = append(sets, column+" = $"+strconv.Itoa(len(args)))
		}
		if input.CreditCode != nil {
			value := nullIfEmpty(input.CreditCode)
			if value == nil {
				return crm_intent.NewValidationError("credit_code 不能为空字符串")
			}
			add("credit_code", *value)
		}
		if input.LegalPerson != nil {
			add("legal_person", nullIfEmpty(input.LegalPerson))
		}
		if input.Province != nil {
			add("province", nullIfEmpty(input.Province))
		}
		if input.City != nil {
			add("city", nullIfEmpty(input.City))
		}
		if input.FoundedYear != nil {
			year := *input.FoundedYear
			if year < 1800 || year > 2100 {
				return crm_intent.NewValidationError("founded_year 必须在 1800 到 2100 之间")
			}
			add("founded_year", year)
		}
		if input.RegisteredCapitalWan != nil {
			if !crm_intent.RegisteredCapitalInRange(*input.RegisteredCapitalWan) {
				return crm_intent.NewValidationError(
					"registered_capital_wan 超出数值范围（最大 999999999999.99）",
				)
			}
			add("registered_capital_wan", *input.RegisteredCapitalWan)
		}
		if input.Products != nil {
			add("products", nullIfEmpty(input.Products))
		}
		if input.Category != nil {
			add("category", nullIfEmpty(input.Category))
		}
		if input.Channel != nil {
			add("channel", nullIfEmpty(input.Channel))
		}
		if input.Channels != nil {
			values := *input.Channels
			if values == nil {
				values = []string{}
			}
			add("channels", values)
		}
		if input.ChannelSource != nil {
			add("channel_source", nullIfEmpty(input.ChannelSource))
		}
		if input.Trademarks != nil {
			values := *input.Trademarks
			if values == nil {
				values = []string{}
			}
			add("trademarks", values)
		}
		if input.TrademarkCount != nil {
			if *input.TrademarkCount < 0 {
				return crm_intent.NewValidationError("trademark_count 不能为负数")
			}
			add("trademark_count", *input.TrademarkCount)
		}
		if input.IntentLevel != nil {
			level := strings.ToUpper(strings.TrimSpace(*input.IntentLevel))
			if !crm_intent.ValidIntentLevel(level) {
				return crm_intent.NewValidationError("intent_level 只接受 A/B/C/D")
			}
			add("intent_level", level)
		}
		if input.IntentScore != nil {
			score := *input.IntentScore
			if score < 0 || score > 100 {
				return crm_intent.NewValidationError("intent_score 必须在 0 到 100 之间")
			}
			add("intent_score", score)
		}
		if input.IntentBasis != nil {
			add("intent_basis", nullIfEmpty(input.IntentBasis))
		}
		if input.AmazonFit != nil {
			add("amazon_fit", nullIfEmpty(input.AmazonFit))
		}
		if input.WalmartFit != nil {
			add("walmart_fit", nullIfEmpty(input.WalmartFit))
		}
		if input.Sources != nil {
			values := *input.Sources
			if values == nil {
				values = []string{}
			}
			add("sources", values)
		}
		if input.Risks != nil {
			add("risks", nullIfEmpty(input.Risks))
		}
		if input.ScreenedAt != nil {
			parsed, parseErr := crm_intent.ParseDateTime(*input.ScreenedAt)
			if parseErr != nil {
				return crm_intent.NewValidationError("screened_at 必须是 YYYY-MM-DD")
			}
			add("screened_at", parsed.Format("2006-01-02"))
		}
		if input.PhoneNote != nil {
			add("phone_note", nullIfEmpty(input.PhoneNote))
		}
		args = append(args, companyID)
		idArg := "$" + strconv.Itoa(len(args))
		sets = append(sets, "updated_at = now()")
		query := "update public.crm_intent_companies set " + strings.Join(sets, ", ") +
			" where id = " + idArg + " and human_touched_at is null"
		tag, err := db.Exec(ctx, query, args...)
		if err != nil {
			return mapPGError(err)
		}
		if tag.RowsAffected() == 0 {
			var exists bool
			if err := db.QueryRow(ctx,
				`select true from public.crm_intent_companies where id = $1`, companyID,
			).Scan(&exists); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return crm_intent.NewNotFoundError("公司", companyID)
				}
				return err
			}
			_ = s.logAIWriteBlocked(ctx, tx, actor, "crm_intent_company", companyID,
				map[string]any{"reason": "human_touched", "mode": "patch"})
			return crm_intent.NewLockedError(companyID)
		}
		if err := insertCompanyPhones(
			ctx, db, companyID, input.Phones, crm_intent.PhoneSourceAI,
		); err != nil {
			return err
		}
		if _, err := s.bumpRevisions(ctx, db, true, false); err != nil {
			return err
		}
		entry := audit.Entry{
			Action: "crm_intent.company_upsert_ai", TargetType: "crm_intent_company",
			TargetID:  auditTarget(companyID),
			AfterJSON: map[string]any{"mode": "patch"},
		}
		applyAuditActor(&entry, actor)
		return s.logOperation(ctx, tx, entry)
	})
	if err != nil {
		return nil, err
	}
	return s.AgentGetCompany(ctx, companyID)
}

func (s *CRMIntentStore) getPool(ctx context.Context, db DB, poolID int64) (*crm_intent.PoolItem, error) {
	item, err := scanPool(db.QueryRow(ctx, `select pl.id, pl.batch_id, pl.external_id,
		pl.name, pl.legal_person, pl.website, pl.channel, pl.channels,
		pl.channel_source, pl.status, pl.screened_company_id, pl.created_at, pl.updated_at
		from public.crm_intent_pool pl where pl.id = $1`, poolID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	pointers := []*crm_intent.PoolItem{item}
	if err := s.loadPoolPhones(ctx, db, pointers); err != nil {
		return nil, err
	}
	return item, nil
}

func (s *CRMIntentStore) AgentUpdatePool(
	ctx context.Context,
	poolID int64,
	input crm_intent.AgentPoolUpdate,
	actor crm_intent.Actor,
) (*crm_intent.PoolItem, error) {
	err := s.inTx(ctx, func(db FullDB, tx pgx.Tx) error {
		var exists bool
		if err := db.QueryRow(ctx,
			`select true from public.crm_intent_pool where id = $1 for update`, poolID,
		).Scan(&exists); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return crm_intent.NewNotFoundError("待筛池记录", poolID)
			}
			return err
		}
		sets := make([]string, 0, 6)
		args := make([]any, 0, 6)
		add := func(column string, value any) {
			args = append(args, value)
			sets = append(sets, column+" = $"+strconv.Itoa(len(args)))
		}
		if input.Status.Set {
			if input.Status.Value == nil {
				return crm_intent.NewValidationError("status 不能为空")
			}
			status := strings.TrimSpace(*input.Status.Value)
			if status != crm_intent.PoolPending && status != crm_intent.PoolIgnored {
				return crm_intent.NewValidationError("status 只接受 pending / ignored")
			}
			add("status", status)
		}
		if input.Channel.Set {
			add("channel", nullIfEmpty(input.Channel.Value))
		}
		if input.Channels.Set {
			values := []string{}
			if input.Channels.Value != nil {
				values = *input.Channels.Value
			}
			add("channels", values)
		}
		if input.ChannelSource.Set {
			add("channel_source", nullIfEmpty(input.ChannelSource.Value))
		}
		if input.Website.Set {
			add("website", nullIfEmpty(input.Website.Value))
		}
		if input.LegalPerson.Set {
			add("legal_person", nullIfEmpty(input.LegalPerson.Value))
		}
		if len(sets) > 0 {
			args = append(args, poolID)
			idArg := "$" + strconv.Itoa(len(args))
			sets = append(sets, "updated_at = now()")
			query := "update public.crm_intent_pool set " + strings.Join(sets, ", ") +
				" where id = " + idArg
			if _, err := db.Exec(ctx, query, args...); err != nil {
				return mapPGError(err)
			}
			if _, err := s.bumpRevisions(ctx, db, true, false); err != nil {
				return err
			}
		}
		entry := audit.Entry{
			Action: "crm_intent.pool_update", TargetType: "crm_intent_pool",
			TargetID: auditTarget(poolID),
		}
		applyAuditActor(&entry, actor)
		return s.logOperation(ctx, tx, entry)
	})
	if err != nil {
		return nil, err
	}
	return s.getPool(ctx, s.db, poolID)
}

func (s *CRMIntentStore) AgentScreenPool(
	ctx context.Context,
	poolID int64,
	input crm_intent.CompanyInput,
	actor crm_intent.Actor,
) (crm_intent.AgentScreenResult, error) {
	result := crm_intent.AgentScreenResult{PoolID: poolID, PoolStatus: crm_intent.PoolScreened}
	err := s.inTx(ctx, func(db FullDB, tx pgx.Tx) error {
		var (
			status          string
			screenedCompany *int64
		)
		if err := db.QueryRow(ctx, `select status, screened_company_id
			from public.crm_intent_pool where id = $1 for update`, poolID).Scan(
			&status, &screenedCompany,
		); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return crm_intent.NewNotFoundError("待筛池记录", poolID)
			}
			return err
		}
		if status == crm_intent.PoolScreened {
			return crm_intent.NewConflictError("INTENT_POOL_ALREADY_SCREENED", "该待筛池记录已筛入")
		}
		companyID, outcome, err := s.upsertCompanyTx(
			ctx, db, nil, input, crm_intent.ModeUpsert, crm_intent.PhoneSourceAI,
		)
		if err != nil {
			return err
		}
		if outcome == upsertSkippedLocked {
			_ = s.logAIWriteBlocked(ctx, tx, actor, "crm_intent_company", companyID,
				map[string]any{
					"reason": "human_touched", "mode": "pool_screen", "pool_id": poolID,
				})
			return crm_intent.NewLockedError(companyID)
		}
		if _, err := db.Exec(ctx, `update public.crm_intent_pool
			set status = 'screened', screened_company_id = $2, updated_at = now()
			where id = $1`, poolID, companyID); err != nil {
			return err
		}
		dataRev, err := s.bumpRevisions(ctx, db, true, false)
		if err != nil {
			return err
		}
		result = crm_intent.AgentScreenResult{
			CompanyID: companyID, PoolID: poolID,
			Created: outcome == upsertCreated, PoolStatus: crm_intent.PoolScreened,
			DataRev: dataRev,
		}
		entry := audit.Entry{
			Action: "crm_intent.pool_screen", TargetType: "crm_intent_pool",
			TargetID:  auditTarget(poolID),
			AfterJSON: map[string]any{"company_id": companyID, "created": result.Created},
		}
		applyAuditActor(&entry, actor)
		return s.logOperation(ctx, tx, entry)
	})
	return result, err
}

func outcomeStatus(outcome upsertOutcome) string {
	switch outcome {
	case upsertCreated:
		return "created"
	case upsertUpdated:
		return "updated"
	case upsertSkippedLocked:
		return "skipped_locked"
	case upsertSkippedExisting:
		return "skipped_existing"
	default:
		return "unknown"
	}
}

func crmIntentInt64Pointer(value int64) *int64 { return &value }

func (s *CRMIntentStore) RecordExportAudit(
	ctx context.Context,
	actor crm_intent.Actor,
	scope string,
	filtersHash string,
	rows int,
) error {
	entry := audit.Entry{
		Action: "crm_intent.export", TargetType: "crm_intent_company",
		AfterJSON: map[string]any{
			"scope": scope, "filters_hash": filtersHash, "rows": rows,
		},
	}
	applyAuditActor(&entry, actor)
	if s.auditor == nil {
		return nil
	}
	return s.auditor.LogAction(ctx, entry)
}
