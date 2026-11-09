package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_commerce"
)

func (s *AgentCommerceStore) ListSKU(
	ctx context.Context,
	projectID int64,
	filter agent_commerce.SKUFilter,
) (agent_commerce.SKUSPage, error) {
	if s == nil || s.db == nil {
		return agent_commerce.SKUSPage{}, agent_commerce.ErrServiceUnavailable
	}
	conditions := []string{"project_id = $1"}
	args := []any{projectID}
	if filter.Country != nil {
		args = append(args, strings.ToUpper(strings.TrimSpace(*filter.Country)))
		conditions = append(conditions, fmt.Sprintf("upper(country) = $%d", len(args)))
	}
	if filter.IsActive != nil {
		args = append(args, *filter.IsActive)
		conditions = append(conditions, fmt.Sprintf("is_active = $%d", len(args)))
	}
	if filter.SKU != nil && strings.TrimSpace(*filter.SKU) != "" {
		args = append(args, "%"+strings.TrimSpace(*filter.SKU)+"%")
		conditions = append(conditions, fmt.Sprintf("sku ilike $%d", len(args)))
	}
	if filter.ASIN != nil && strings.TrimSpace(*filter.ASIN) != "" {
		args = append(args, "%"+strings.TrimSpace(*filter.ASIN)+"%")
		conditions = append(conditions, fmt.Sprintf("asin ilike $%d", len(args)))
	}
	page := filter.Page
	if page < 1 {
		page = 1
	}
	pageSize := filter.PageSize
	if pageSize < 1 {
		pageSize = 200
	}
	if pageSize > 500 {
		pageSize = 500
	}
	where := " where " + strings.Join(conditions, " and ")

	var total *int
	if filter.IncludeTotal {
		var count int
		if err := s.db.QueryRow(
			ctx,
			`select count(*) from public.product_costs`+where,
			args...,
		).Scan(&count); err != nil {
			return agent_commerce.SKUSPage{}, fmt.Errorf("count agent commerce skus: %w", err)
		}
		total = &count
	}

	queryArgs := append([]any(nil), args...)
	queryArgs = append(queryArgs, pageSize+1, (page-1)*pageSize)
	rows, err := s.db.Query(
		ctx,
		`select `+agentCommerceSKUSelectColumns+` from public.product_costs`+where+
			fmt.Sprintf(` order by sort_order asc, id asc limit $%d offset $%d`, len(queryArgs)-1, len(queryArgs)),
		queryArgs...,
	)
	if err != nil {
		return agent_commerce.SKUSPage{}, fmt.Errorf("list agent commerce skus: %w", err)
	}
	defer rows.Close()

	items := make([]agent_commerce.SKURecord, 0, pageSize)
	hasNext := false
	for rows.Next() {
		item, err := scanAgentCommerceSKURecord(rows)
		if err != nil {
			return agent_commerce.SKUSPage{}, fmt.Errorf("scan agent commerce sku: %w", err)
		}
		if len(items) == pageSize {
			hasNext = true
			break
		}
		items = append(items, *item)
	}
	if err := rows.Err(); err != nil {
		return agent_commerce.SKUSPage{}, err
	}
	return agent_commerce.SKUSPage{
		Items:    items,
		Page:     page,
		PageSize: pageSize,
		Total:    total,
		HasNext:  hasNext,
	}, nil
}

func (s *AgentCommerceStore) GetSKU(
	ctx context.Context,
	projectID, recordID int64,
) (*agent_commerce.SKURecord, error) {
	if s == nil || s.db == nil {
		return nil, agent_commerce.ErrServiceUnavailable
	}
	return getAgentCommerceSKUByID(ctx, s.db, projectID, recordID, false)
}

func (s *AgentCommerceStore) UpsertSKU(
	ctx context.Context,
	projectID int64,
	input agent_commerce.SKUUpsertInput,
	entry agent_commerce.AuditEntry,
) (agent_commerce.SKURecord, string, error) {
	if s == nil || s.db == nil {
		return agent_commerce.SKURecord{}, "", agent_commerce.ErrServiceUnavailable
	}
	if s.auditor == nil {
		return agent_commerce.SKURecord{}, "", agent_commerce.ErrServiceUnavailable
	}

	var result agent_commerce.SKURecord
	action := "updated"
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		project, err := verifyAgentCommerceProject(ctx, txDB, projectID)
		if err != nil {
			return err
		}
		before, err := getAgentCommerceSKUByKey(
			ctx, txDB, projectID, input.SKU, input.ASIN, input.Country, true,
		)
		if err != nil {
			return err
		}
		inserted := false
		if before == nil {
			sortOrder := 1
			if input.SortOrder != nil {
				sortOrder = *input.SortOrder
			} else if err := txDB.QueryRow(
				ctx,
				`select coalesce(max(sort_order), 0) + 1
				   from public.product_costs
				  where project_id = $1`,
				projectID,
			).Scan(&sortOrder); err != nil {
				return err
			}
			tag, err := txDB.Exec(ctx, agentCommerceSKUInsertSQL,
				projectID, project.Name, input.SKU, input.ASIN, input.Country,
				agentCommerceSourceFile(entry), sortOrder,
			)
			if err != nil {
				return mapAgentCommerceDBError(err)
			}
			if tag.RowsAffected() > 0 {
				inserted = true
			} else {
				before, err = getAgentCommerceSKUByKey(
					ctx, txDB, projectID, input.SKU, input.ASIN, input.Country, true,
				)
				if err != nil {
					return fmt.Errorf("load conflicting agent commerce sku: %w", err)
				}
				if before == nil {
					return agent_commerce.ErrConflict
				}
			}
		}
		if inserted {
			action = "inserted"
			before = nil
		}
		if _, err := applyAgentCommerceUpsertFields(
			ctx, txDB, projectID, input, entry,
		); err != nil {
			return err
		}
		if input.SortOrder != nil {
			targetID, err := agentCommerceSKUIDByKey(
				ctx, txDB, projectID, input.SKU, input.ASIN, input.Country,
			)
			if err != nil {
				return err
			}
			if err := resequenceAgentCommerceSKU(ctx, txDB, projectID, targetID, *input.SortOrder); err != nil {
				return err
			}
		}
		targetID, err := agentCommerceSKUIDByKey(
			ctx, txDB, projectID, input.SKU, input.ASIN, input.Country,
		)
		if err != nil {
			return err
		}
		resultPtr, err := getAgentCommerceSKUByID(ctx, txDB, projectID, targetID, false)
		if err != nil {
			return err
		}
		result = *resultPtr
		entry.TargetType = "sku_info"
		target := strconv.FormatInt(targetID, 10)
		entry.TargetID = &target
		entry.BeforeJSON = before
		entry.AfterJSON = result
		if err := s.writeAudit(ctx, tx, entry); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return agent_commerce.SKURecord{}, "", err
	}
	return result, action, nil
}

const agentCommerceSKUInsertSQL = `
	insert into public.product_costs (
		project_id, project_name, sku, asin, fnsku, product_name, father_id,
		fob_unit_cost, first_leg_cost_rmb,
		package_length_cm, package_width_cm, package_height_cm, weight_kg,
		carton_length_cm, carton_width_cm, carton_height_cm, carton_weight_kg, units_per_carton,
		currency, country, sort_order, is_active, source_file,
		sku_factory_info, sku_factory_info_updated_at, sku_factory_info_updated_by,
		listing_title, listing_bullet_1, listing_bullet_2, listing_bullet_3,
		listing_bullet_4, listing_bullet_5, listing_description, listing_selling_points,
		listing_copy_updated_at, listing_copy_updated_by, created_at, updated_at
	) values (
		$1, $2, $3, $4, null, null, null,
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		'CNY', upper($5), $6, true, $7,
		null, null, null,
		null, null, null, null, null, null, null, null,
		null, null, now(), now()
	)
	on conflict (project_id, sku, asin, country) do nothing
`

func applyAgentCommerceUpsertFields(
	ctx context.Context,
	db FullDB,
	projectID int64,
	input agent_commerce.SKUUpsertInput,
	entry agent_commerce.AuditEntry,
) (int64, error) {
	sets := []string{"currency = 'CNY'", "source_file = $2", "updated_at = now()"}
	args := []any{nil, agentCommerceSourceFile(entry)}
	addString := func(column, field string) {
		if input.Provided[field] {
			args = append(args, stringArg(inputFieldString(input, field)))
			sets = append(sets, fmt.Sprintf("%s = $%d", column, len(args)))
		}
	}
	addNumber := func(column, field string) {
		if input.Provided[field] {
			value := inputFieldNumber(input, field)
			if value == nil {
				return
			}
			args = append(args, *value)
			sets = append(sets, fmt.Sprintf("%s = $%d", column, len(args)))
		}
	}
	addString("fnsku", "fnsku")
	addString("product_name", "product_name")
	addString("father_id", "father_id")
	addNumber("fob_unit_cost", "fob_unit_cost")
	addNumber("first_leg_cost_rmb", "first_leg_cost_rmb")
	addNumber("package_length_cm", "package_length_cm")
	addNumber("package_width_cm", "package_width_cm")
	addNumber("package_height_cm", "package_height_cm")
	addNumber("weight_kg", "weight_kg")
	addNumber("carton_length_cm", "carton_length_cm")
	addNumber("carton_width_cm", "carton_width_cm")
	addNumber("carton_height_cm", "carton_height_cm")
	addNumber("carton_weight_kg", "carton_weight_kg")
	if input.Provided["units_per_carton"] && input.UnitsPerCarton != nil {
		args = append(args, *input.UnitsPerCarton)
		sets = append(sets, fmt.Sprintf("units_per_carton = $%d", len(args)))
	}
	if input.Provided["is_active"] {
		value := true
		if input.IsActive != nil {
			value = *input.IsActive
		}
		args = append(args, value)
		sets = append(sets, fmt.Sprintf("is_active = $%d", len(args)))
	}
	if input.Provided["sort_order"] && input.SortOrder != nil {
		args = append(args, *input.SortOrder)
		sets = append(sets, fmt.Sprintf("sort_order = $%d", len(args)))
	}
	if input.Provided["sku_factory_info"] {
		var payload any
		if input.SKUFactoryInfo != nil {
			encoded, err := json.Marshal(input.SKUFactoryInfo)
			if err != nil {
				return 0, err
			}
			payload = encoded
		}
		args = append(args, payload, nullableAgentText(entry.AgentID))
		sets = append(
			sets,
			fmt.Sprintf("sku_factory_info = $%d", len(args)-1),
			"sku_factory_info_updated_at = now()",
			fmt.Sprintf("sku_factory_info_updated_by = $%d", len(args)),
		)
	}
	listingProvided := false
	for _, spec := range listingColumnSpecs {
		if value, ok := input.ListingCopy[spec.field]; ok {
			args = append(args, stringArg(value))
			sets = append(sets, fmt.Sprintf("%s = $%d", spec.column, len(args)))
			listingProvided = true
		}
	}
	if listingProvided {
		args = append(args, nullableAgentText(entry.AgentID))
		sets = append(
			sets,
			"listing_copy_updated_at = now()",
			fmt.Sprintf("listing_copy_updated_by = $%d", len(args)),
		)
	}
	args[0] = 0
	targetID, err := agentCommerceSKUIDByKey(
		ctx, db, projectID, input.SKU, input.ASIN, input.Country,
	)
	if err != nil {
		return 0, err
	}
	args[0] = targetID
	_, err = db.Exec(
		ctx,
		`update public.product_costs set `+strings.Join(sets, ", ")+` where id = $1`,
		args...,
	)
	if err != nil {
		return 0, mapAgentCommerceDBError(err)
	}
	return targetID, nil
}

func (s *AgentCommerceStore) UpdateSKU(
	ctx context.Context,
	projectID, recordID int64,
	input agent_commerce.SKUUpdateInput,
	entry agent_commerce.AuditEntry,
) (*agent_commerce.SKURecord, *agent_commerce.SKURecord, error) {
	if s == nil || s.db == nil {
		return nil, nil, agent_commerce.ErrServiceUnavailable
	}
	if s.auditor == nil {
		return nil, nil, agent_commerce.ErrServiceUnavailable
	}
	var before, after *agent_commerce.SKURecord
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var err error
		before, err = getAgentCommerceSKUByID(ctx, txDB, projectID, recordID, true)
		if err != nil {
			return err
		}
		if _, err := applyAgentCommerceUpdateFields(ctx, txDB, recordID, input, entry); err != nil {
			return err
		}
		if input.Provided["sort_order"] && input.SortOrder != nil {
			if err := resequenceAgentCommerceSKU(ctx, txDB, projectID, recordID, *input.SortOrder); err != nil {
				return err
			}
		}
		after, err = getAgentCommerceSKUByID(ctx, txDB, projectID, recordID, false)
		if err != nil {
			return err
		}
		entry.TargetType = "sku_info"
		target := strconv.FormatInt(recordID, 10)
		entry.TargetID = &target
		entry.BeforeJSON = before
		entry.AfterJSON = after
		return s.writeAudit(ctx, tx, entry)
	})
	if err != nil {
		return nil, nil, err
	}
	return before, after, nil
}

func applyAgentCommerceUpdateFields(
	ctx context.Context,
	db FullDB,
	recordID int64,
	input agent_commerce.SKUUpdateInput,
	entry agent_commerce.AuditEntry,
) (int64, error) {
	sets := []string{"source_file = $2", "updated_at = now()"}
	args := []any{recordID, agentCommerceSourceFile(entry)}
	addString := func(column, field string) {
		if input.Provided[field] {
			args = append(args, stringArg(inputFieldUpdateString(input, field)))
			sets = append(sets, fmt.Sprintf("%s = $%d", column, len(args)))
		}
	}
	addNumber := func(column, field string) {
		if input.Provided[field] {
			value := inputFieldUpdateNumber(input, field)
			if value == nil {
				return
			}
			args = append(args, *value)
			sets = append(sets, fmt.Sprintf("%s = $%d", column, len(args)))
		}
	}
	addString("fnsku", "fnsku")
	addString("product_name", "product_name")
	addString("father_id", "father_id")
	addNumber("fob_unit_cost", "fob_unit_cost")
	addNumber("first_leg_cost_rmb", "first_leg_cost_rmb")
	addNumber("package_length_cm", "package_length_cm")
	addNumber("package_width_cm", "package_width_cm")
	addNumber("package_height_cm", "package_height_cm")
	addNumber("weight_kg", "weight_kg")
	addNumber("carton_length_cm", "carton_length_cm")
	addNumber("carton_width_cm", "carton_width_cm")
	addNumber("carton_height_cm", "carton_height_cm")
	addNumber("carton_weight_kg", "carton_weight_kg")
	if input.Provided["units_per_carton"] && input.UnitsPerCarton != nil {
		args = append(args, *input.UnitsPerCarton)
		sets = append(sets, fmt.Sprintf("units_per_carton = $%d", len(args)))
	}
	if input.Provided["is_active"] {
		value := false
		if input.IsActive != nil {
			value = *input.IsActive
		}
		args = append(args, value)
		sets = append(sets, fmt.Sprintf("is_active = $%d", len(args)))
	}
	if input.Provided["sort_order"] && input.SortOrder != nil {
		args = append(args, *input.SortOrder)
		sets = append(sets, fmt.Sprintf("sort_order = $%d", len(args)))
	}
	if input.Provided["sku_factory_info"] {
		var payload any
		if input.SKUFactoryInfo != nil {
			encoded, err := json.Marshal(input.SKUFactoryInfo)
			if err != nil {
				return 0, err
			}
			payload = encoded
		}
		args = append(args, payload, nullableAgentText(entry.AgentID))
		sets = append(
			sets,
			fmt.Sprintf("sku_factory_info = $%d", len(args)-1),
			"sku_factory_info_updated_at = now()",
			fmt.Sprintf("sku_factory_info_updated_by = $%d", len(args)),
		)
	}
	listingProvided := false
	for _, spec := range listingColumnSpecs {
		if value, ok := input.ListingCopy[spec.field]; ok {
			args = append(args, stringArg(value))
			sets = append(sets, fmt.Sprintf("%s = $%d", spec.column, len(args)))
			listingProvided = true
		}
	}
	if listingProvided {
		args = append(args, nullableAgentText(entry.AgentID))
		sets = append(
			sets,
			"listing_copy_updated_at = now()",
			fmt.Sprintf("listing_copy_updated_by = $%d", len(args)),
		)
	}
	tag, err := db.Exec(
		ctx,
		`update public.product_costs set `+strings.Join(sets, ", ")+` where id = $1`,
		args...,
	)
	if err != nil {
		return 0, mapAgentCommerceDBError(err)
	}
	if tag.RowsAffected() == 0 {
		return 0, agent_commerce.ErrSKUNotFound
	}
	return recordID, nil
}

func (s *AgentCommerceStore) BatchUpdateListingCopy(
	ctx context.Context,
	projectID int64,
	input agent_commerce.ListingCopyBatchInput,
	entry agent_commerce.AuditEntry,
) (agent_commerce.ListingCopyBatchResult, error) {
	if s == nil || s.db == nil {
		return agent_commerce.ListingCopyBatchResult{}, agent_commerce.ErrServiceUnavailable
	}
	if s.auditor == nil {
		return agent_commerce.ListingCopyBatchResult{}, agent_commerce.ErrServiceUnavailable
	}
	var result agent_commerce.ListingCopyBatchResult
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		uniqueIDs := make([]int64, 0, len(input.Items))
		seenIDs := make(map[int64]bool, len(input.Items))
		for _, item := range input.Items {
			if !seenIDs[item.SKURecordID] {
				seenIDs[item.SKURecordID] = true
				uniqueIDs = append(uniqueIDs, item.SKURecordID)
			}
		}
		current, err := listAgentCommerceSKUsByIDs(ctx, txDB, projectID, uniqueIDs, true)
		if err != nil {
			return err
		}
		if len(current) != len(uniqueIDs) {
			return agent_commerce.ErrSKUNotFound
		}
		initial := make(map[int64]listingSnapshot)
		changedIDs := make([]int64, 0)
		changedSet := make(map[int64]bool)
		unchanged := 0
		for recordID, record := range current {
			initial[recordID] = listingSnapshotFromRecord(record)
		}
		for _, item := range input.Items {
			record := current[item.SKURecordID]
			snapshot := listingSnapshotFromRecord(record)
			changed := false
			for field, value := range item.Values {
				if snapshot.set(field, value) {
					changed = true
				}
			}
			if !changed {
				unchanged++
				continue
			}
			if err := updateAgentCommerceListingSnapshot(
				ctx, txDB, item.SKURecordID, snapshot, entry.AgentID,
			); err != nil {
				return err
			}
			applyListingSnapshotToRecord(record, snapshot)
			if !changedSet[item.SKURecordID] {
				changedSet[item.SKURecordID] = true
				changedIDs = append(changedIDs, item.SKURecordID)
			}
		}
		afterMap, err := listAgentCommerceSKUsByIDs(ctx, txDB, projectID, changedIDs, false)
		if err != nil {
			return err
		}
		for _, recordID := range changedIDs {
			after := afterMap[recordID]
			if after == nil {
				return agent_commerce.ErrSKUNotFound
			}
			auditEntry := entry
			auditEntry.TargetType = "sku_info"
			target := strconv.FormatInt(recordID, 10)
			auditEntry.TargetID = &target
			auditEntry.BeforeJSON = initial[recordID].toAuditMap()
			auditEntry.AfterJSON = listingSnapshotFromRecord(after).toAuditMap()
			if err := s.writeAudit(ctx, tx, auditEntry); err != nil {
				return err
			}
			result.Items = append(result.Items, *after)
		}
		result.Updated = len(changedIDs)
		result.Unchanged = unchanged
		result.UpdatedIDs = changedIDs
		return nil
	})
	if err != nil {
		return agent_commerce.ListingCopyBatchResult{}, err
	}
	if result.UpdatedIDs == nil {
		result.UpdatedIDs = []int64{}
	}
	if result.Items == nil {
		result.Items = []agent_commerce.SKURecord{}
	}
	return result, nil
}

func (s *AgentCommerceStore) TransitionSKUStatus(
	ctx context.Context,
	projectID, recordID int64,
	input agent_commerce.SKUStatusInput,
	entry agent_commerce.AuditEntry,
) (agent_commerce.SKURecord, bool, error) {
	if s == nil || s.db == nil {
		return agent_commerce.SKURecord{}, false, agent_commerce.ErrServiceUnavailable
	}
	if s.auditor == nil {
		return agent_commerce.SKURecord{}, false, agent_commerce.ErrServiceUnavailable
	}
	var result agent_commerce.SKURecord
	changed := false
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		before, err := getAgentCommerceSKUByID(ctx, txDB, projectID, recordID, true)
		if err != nil {
			return err
		}
		if before.IsActive == input.IsActive {
			result = *before
			return nil
		}
		changed = true
		_, err = txDB.Exec(
			ctx,
			`update public.product_costs
			    set is_active = $2, source_file = $3, updated_at = now()
			  where id = $1 and project_id = $4`,
			recordID,
			input.IsActive,
			agentCommerceSourceFile(entry),
			projectID,
		)
		if err != nil {
			return mapAgentCommerceDBError(err)
		}
		after, err := getAgentCommerceSKUByID(ctx, txDB, projectID, recordID, false)
		if err != nil {
			return err
		}
		result = *after
		entry.TargetType = "sku_info"
		target := strconv.FormatInt(recordID, 10)
		entry.TargetID = &target
		entry.BeforeJSON = before
		entry.AfterJSON = after
		return s.writeAudit(ctx, tx, entry)
	})
	if err != nil {
		return agent_commerce.SKURecord{}, false, err
	}
	return result, changed, nil
}

func (s *AgentCommerceStore) DeleteSKU(
	ctx context.Context,
	projectID, recordID int64,
	entry agent_commerce.AuditEntry,
) (agent_commerce.SKURecord, error) {
	if s == nil || s.db == nil {
		return agent_commerce.SKURecord{}, agent_commerce.ErrServiceUnavailable
	}
	if s.auditor == nil {
		return agent_commerce.SKURecord{}, agent_commerce.ErrServiceUnavailable
	}
	var before agent_commerce.SKURecord
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		record, err := getAgentCommerceSKUByID(ctx, txDB, projectID, recordID, true)
		if err != nil {
			return err
		}
		before = *record
		tag, err := txDB.Exec(
			ctx,
			`delete from public.product_costs where id = $1 and project_id = $2`,
			recordID,
			projectID,
		)
		if err != nil {
			return mapAgentCommerceDBError(err)
		}
		if tag.RowsAffected() == 0 {
			return agent_commerce.ErrSKUNotFound
		}
		entry.TargetType = "sku_info"
		target := strconv.FormatInt(recordID, 10)
		entry.TargetID = &target
		entry.BeforeJSON = before
		return s.writeAudit(ctx, tx, entry)
	})
	if err != nil {
		return agent_commerce.SKURecord{}, err
	}
	return before, nil
}

func (s *AgentCommerceStore) SetFNSKULabel(
	ctx context.Context,
	projectID, recordID int64,
	key, publicURL string,
	fileSize int64,
	entry agent_commerce.AuditEntry,
) (*string, error) {
	if s == nil || s.db == nil {
		return nil, agent_commerce.ErrServiceUnavailable
	}
	if s.auditor == nil {
		return nil, agent_commerce.ErrServiceUnavailable
	}
	var previous *string
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var sku string
		var previousURL *string
		err := txDB.QueryRow(
			ctx,
			`select sku, fnsku_label_r2_key, fnsku_label_r2_url
			   from public.product_costs
			  where id = $1 and project_id = $2
			  for update`,
			recordID,
			projectID,
		).Scan(&sku, &previous, &previousURL)
		if errors.Is(err, pgx.ErrNoRows) {
			return agent_commerce.ErrSKUNotFound
		}
		if err != nil {
			return err
		}
		_, err = txDB.Exec(
			ctx,
			`update public.product_costs
			    set fnsku_label_r2_key = $2, fnsku_label_r2_url = $3, updated_at = now()
			  where id = $1 and project_id = $4`,
			recordID,
			key,
			publicURL,
			projectID,
		)
		if err != nil {
			return mapAgentCommerceDBError(err)
		}
		entry.TargetType = "sku_info"
		target := strconv.FormatInt(recordID, 10)
		entry.TargetID = &target
		entry.BeforeJSON = map[string]any{
			"sku":                sku,
			"fnsku_label_r2_key": previous,
			"fnsku_label_r2_url": previousURL,
		}
		entry.AfterJSON = map[string]any{
			"sku":                sku,
			"fnsku_label_r2_key": key,
			"fnsku_label_r2_url": publicURL,
			"file_size":          fileSize,
		}
		return s.writeAudit(ctx, tx, entry)
	})
	if err != nil {
		return nil, err
	}
	return previous, nil
}

func (s *AgentCommerceStore) ListSKUAudit(
	ctx context.Context,
	projectID, recordID int64,
	limit int,
) ([]agent_commerce.AuditItem, error) {
	if s == nil || s.db == nil {
		return nil, agent_commerce.ErrServiceUnavailable
	}
	if _, err := getAgentCommerceSKUByID(ctx, s.db, projectID, recordID, false); err != nil {
		return nil, err
	}
	if limit < 1 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	rows, err := s.db.Query(
		ctx,
		`select id, created_at, action, agent_id, operator, idempotency_key,
		        result, before_json, after_json, error_message
		   from public.operation_audit_logs
		  where target_type = 'sku_info' and target_id = $1
		  order by id desc
		  limit $2`,
		strconv.FormatInt(recordID, 10),
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]agent_commerce.AuditItem, 0, limit)
	for rows.Next() {
		var item agent_commerce.AuditItem
		var createdAt *time.Time
		var beforeRaw, afterRaw []byte
		if err := rows.Scan(
			&item.ID, &createdAt, &item.Action, &item.AgentID, &item.Operator,
			&item.IdempotencyKey, &item.Result, &beforeRaw, &afterRaw, &item.ErrorMessage,
		); err != nil {
			return nil, err
		}
		if createdAt != nil {
			value := createdAt.UTC().Format(time.RFC3339Nano)
			item.CreatedAt = &value
		}
		if len(beforeRaw) > 0 {
			_ = json.Unmarshal(beforeRaw, &item.Before)
		}
		if len(afterRaw) > 0 {
			_ = json.Unmarshal(afterRaw, &item.After)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

type listingColumnSpec struct {
	field  string
	column string
}

var listingColumnSpecs = []listingColumnSpec{
	{"listing_title", "listing_title"},
	{"listing_bullet_1", "listing_bullet_1"},
	{"listing_bullet_2", "listing_bullet_2"},
	{"listing_bullet_3", "listing_bullet_3"},
	{"listing_bullet_4", "listing_bullet_4"},
	{"listing_bullet_5", "listing_bullet_5"},
	{"listing_description", "listing_description"},
	{"listing_selling_points", "listing_selling_points"},
}

type listingSnapshot struct {
	values [8]*string
}

func listingSnapshotFromRecord(record *agent_commerce.SKURecord) listingSnapshot {
	return listingSnapshot{values: [8]*string{
		record.ListingTitle,
		record.ListingBullet1,
		record.ListingBullet2,
		record.ListingBullet3,
		record.ListingBullet4,
		record.ListingBullet5,
		record.ListingDescription,
		record.ListingSellingPoints,
	}}
}

func (snapshot *listingSnapshot) set(field string, value *string) bool {
	for index, spec := range listingColumnSpecs {
		if spec.field != field {
			continue
		}
		before := snapshot.values[index]
		if strings.TrimSpace(stringArgValue(before)) == strings.TrimSpace(stringArgValue(value)) {
			snapshot.values[index] = value
			return false
		}
		snapshot.values[index] = value
		return true
	}
	return false
}

func (snapshot listingSnapshot) toAuditMap() map[string]any {
	result := make(map[string]any, len(listingColumnSpecs))
	for index, spec := range listingColumnSpecs {
		if snapshot.values[index] == nil {
			result[spec.field] = nil
		} else {
			result[spec.field] = *snapshot.values[index]
		}
	}
	return result
}

func applyListingSnapshotToRecord(record *agent_commerce.SKURecord, snapshot listingSnapshot) {
	record.ListingTitle = snapshot.values[0]
	record.ListingBullet1 = snapshot.values[1]
	record.ListingBullet2 = snapshot.values[2]
	record.ListingBullet3 = snapshot.values[3]
	record.ListingBullet4 = snapshot.values[4]
	record.ListingBullet5 = snapshot.values[5]
	record.ListingDescription = snapshot.values[6]
	record.ListingSellingPoints = snapshot.values[7]
}

func updateAgentCommerceListingSnapshot(
	ctx context.Context,
	db FullDB,
	recordID int64,
	snapshot listingSnapshot,
	agentID *string,
) error {
	args := []any{recordID}
	for _, value := range snapshot.values {
		args = append(args, stringArg(value))
	}
	args = append(args, nullableAgentText(agentID))
	_, err := db.Exec(
		ctx,
		`update public.product_costs
		    set listing_title = $2,
		        listing_bullet_1 = $3,
		        listing_bullet_2 = $4,
		        listing_bullet_3 = $5,
		        listing_bullet_4 = $6,
		        listing_bullet_5 = $7,
		        listing_description = $8,
		        listing_selling_points = $9,
		        listing_copy_updated_at = now(),
		        listing_copy_updated_by = $10,
		        updated_at = now()
		  where id = $1`,
		args...,
	)
	return err
}

func resequenceAgentCommerceSKU(
	ctx context.Context,
	db FullDB,
	projectID, targetID int64,
	requested int,
) error {
	rows, err := db.Query(
		ctx,
		`select id
		   from public.product_costs
		  where project_id = $1 and id <> $2
		  order by sort_order asc, id asc`,
		projectID,
		targetID,
	)
	if err != nil {
		return err
	}
	ids := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	position := requested - 1
	if position < 0 {
		position = 0
	}
	if position > len(ids) {
		position = len(ids)
	}
	ids = append(ids, 0)
	copy(ids[position+1:], ids[position:])
	ids[position] = targetID
	for index, id := range ids {
		if _, err := db.Exec(
			ctx,
			`update public.product_costs set sort_order = $2 where id = $1 and project_id = $3`,
			id, index+1, projectID,
		); err != nil {
			return err
		}
	}
	return nil
}

func agentCommerceSKUIDByKey(
	ctx context.Context,
	db FullDB,
	projectID int64,
	sku, asin, country string,
) (int64, error) {
	var id int64
	err := db.QueryRow(
		ctx,
		`select id from public.product_costs
		  where project_id = $1 and sku = $2 and asin = $3 and country = $4`,
		projectID, sku, asin, country,
	).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, agent_commerce.ErrSKUNotFound
	}
	return id, err
}

func agentCommerceSourceFile(entry agent_commerce.AuditEntry) string {
	if entry.AgentID == nil || strings.TrimSpace(*entry.AgentID) == "" {
		return "agent"
	}
	return "agent:" + strings.TrimSpace(*entry.AgentID)
}

func mapAgentCommerceDBError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return agent_commerce.ErrDuplicate
	}
	return err
}

func stringArg(value *string) any {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func stringArgValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func nullableAgentText(value *string) any {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	return trimmed
}

func inputFieldString(input agent_commerce.SKUUpsertInput, field string) *string {
	switch field {
	case "fnsku":
		return input.FNSKU
	case "product_name":
		return input.ProductName
	case "father_id":
		return input.FatherID
	default:
		return nil
	}
}

func inputFieldNumber(input agent_commerce.SKUUpsertInput, field string) *float64 {
	switch field {
	case "fob_unit_cost":
		return input.FOBUnitCost
	case "first_leg_cost_rmb":
		return input.FirstLegCostRMB
	case "package_length_cm":
		return input.PackageLengthCM
	case "package_width_cm":
		return input.PackageWidthCM
	case "package_height_cm":
		return input.PackageHeightCM
	case "weight_kg":
		return input.WeightKG
	case "carton_length_cm":
		return input.CartonLengthCM
	case "carton_width_cm":
		return input.CartonWidthCM
	case "carton_height_cm":
		return input.CartonHeightCM
	case "carton_weight_kg":
		return input.CartonWeightKG
	default:
		return nil
	}
}

func inputFieldUpdateString(input agent_commerce.SKUUpdateInput, field string) *string {
	switch field {
	case "fnsku":
		return input.FNSKU
	case "product_name":
		return input.ProductName
	case "father_id":
		return input.FatherID
	default:
		return nil
	}
}

func inputFieldUpdateNumber(input agent_commerce.SKUUpdateInput, field string) *float64 {
	switch field {
	case "fob_unit_cost":
		return input.FOBUnitCost
	case "first_leg_cost_rmb":
		return input.FirstLegCostRMB
	case "package_length_cm":
		return input.PackageLengthCM
	case "package_width_cm":
		return input.PackageWidthCM
	case "package_height_cm":
		return input.PackageHeightCM
	case "weight_kg":
		return input.WeightKG
	case "carton_length_cm":
		return input.CartonLengthCM
	case "carton_width_cm":
		return input.CartonWidthCM
	case "carton_height_cm":
		return input.CartonHeightCM
	case "carton_weight_kg":
		return input.CartonWeightKG
	default:
		return nil
	}
}
