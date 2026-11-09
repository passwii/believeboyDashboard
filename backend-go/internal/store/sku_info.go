package store

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/sku_info"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type SkuStore struct {
	db      FullDB
	auditor audit.Service
}

func NewSkuStore(db FullDB, auditors ...audit.Service) *SkuStore {
	var auditor audit.Service
	if len(auditors) > 0 {
		auditor = auditors[0]
	} else if db != nil {
		auditor = audit.NewService(db)
	}
	return &SkuStore{db: db, auditor: auditor}
}

const skuSelectColumns = `
	id, project_id, project_name, sku, asin, fnsku, product_name, father_id,
	fob_unit_cost, first_leg_cost_rmb, package_length_cm, package_width_cm, package_height_cm, weight_kg,
	carton_length_cm, carton_width_cm, carton_height_cm, carton_weight_kg, units_per_carton,
	currency, country, sort_order, coalesce(is_active, true),
	sku_factory_info::text, sku_factory_info_updated_at, sku_factory_info_updated_by,
	fnsku_label_r2_key, fnsku_label_r2_url,
	product_image_r2_key, product_image_r2_url, product_image_thumbnail_r2_key, product_image_thumbnail_r2_url,
	product_image_uploaded_at, product_image_uploaded_by,
	listing_title, listing_bullet_1, listing_bullet_2, listing_bullet_3, listing_bullet_4, listing_bullet_5,
	listing_description, listing_selling_points, listing_copy_updated_at, listing_copy_updated_by
`

func scanSkuRecord(row pgx.Row) (*sku_info.SkuRecordItem, error) {
	var item sku_info.SkuRecordItem
	var factoryInfoJSON *string
	var factoryUpdatedAt, imageUploadedAt, listingUpdatedAt *time.Time

	err := row.Scan(
		&item.ID, &item.ProjectID, &item.ProjectName, &item.SKU, &item.ASIN, &item.FNSKU, &item.ProductName, &item.FatherID,
		&item.FOBUnitCost, &item.FirstLegCostRMB, &item.PackageLengthCM, &item.PackageWidthCM, &item.PackageHeightCM, &item.WeightKG,
		&item.CartonLengthCM, &item.CartonWidthCM, &item.CartonHeightCM, &item.CartonWeightKG, &item.UnitsPerCarton,
		&item.Currency, &item.Country, &item.SortOrder, &item.IsActive,
		&factoryInfoJSON, &factoryUpdatedAt, &item.SkuFactoryInfoUpdatedBy,
		&item.FnskuLabelR2Key, &item.FnskuLabelR2URL,
		&item.ProductImageR2Key, &item.ProductImageR2URL, &item.ProductImageThumbnailR2Key, &item.ProductImageThumbnailR2URL,
		&imageUploadedAt, &item.ProductImageUploadedBy,
		&item.ListingTitle, &item.ListingBullet1, &item.ListingBullet2, &item.ListingBullet3, &item.ListingBullet4, &item.ListingBullet5,
		&item.ListingDescription, &item.ListingSellingPoints, &listingUpdatedAt, &item.ListingCopyUpdatedBy,
	)
	if err != nil {
		return nil, err
	}

	if factoryInfoJSON != nil && *factoryInfoJSON != "" {
		_ = json.Unmarshal([]byte(*factoryInfoJSON), &item.SkuFactoryInfo)
	}
	if factoryUpdatedAt != nil {
		t := factoryUpdatedAt.UTC().Format(time.RFC3339Nano)
		item.SkuFactoryInfoUpdatedAt = &t
	}
	if imageUploadedAt != nil {
		t := imageUploadedAt.UTC().Format(time.RFC3339Nano)
		item.ProductImageUploadedAt = &t
	}
	if listingUpdatedAt != nil {
		t := listingUpdatedAt.UTC().Format(time.RFC3339Nano)
		item.ListingCopyUpdatedAt = &t
	}
	item.MarketplaceURL = sku_info.BuildMarketplaceURL(item.Country, item.ASIN)
	return &item, nil
}

func scanSkuRecordWithCreated(row pgx.Row) (*sku_info.SkuRecordItem, bool, error) {
	var isCreated bool
	var item sku_info.SkuRecordItem
	var factoryInfoJSON *string
	var factoryUpdatedAt, imageUploadedAt, listingUpdatedAt *time.Time

	err := row.Scan(
		&isCreated,
		&item.ID, &item.ProjectID, &item.ProjectName, &item.SKU, &item.ASIN, &item.FNSKU, &item.ProductName, &item.FatherID,
		&item.FOBUnitCost, &item.FirstLegCostRMB, &item.PackageLengthCM, &item.PackageWidthCM, &item.PackageHeightCM, &item.WeightKG,
		&item.CartonLengthCM, &item.CartonWidthCM, &item.CartonHeightCM, &item.CartonWeightKG, &item.UnitsPerCarton,
		&item.Currency, &item.Country, &item.SortOrder, &item.IsActive,
		&factoryInfoJSON, &factoryUpdatedAt, &item.SkuFactoryInfoUpdatedBy,
		&item.FnskuLabelR2Key, &item.FnskuLabelR2URL,
		&item.ProductImageR2Key, &item.ProductImageR2URL, &item.ProductImageThumbnailR2Key, &item.ProductImageThumbnailR2URL,
		&imageUploadedAt, &item.ProductImageUploadedBy,
		&item.ListingTitle, &item.ListingBullet1, &item.ListingBullet2, &item.ListingBullet3, &item.ListingBullet4, &item.ListingBullet5,
		&item.ListingDescription, &item.ListingSellingPoints, &listingUpdatedAt, &item.ListingCopyUpdatedBy,
	)
	if err != nil {
		return nil, false, err
	}

	if factoryInfoJSON != nil && *factoryInfoJSON != "" {
		_ = json.Unmarshal([]byte(*factoryInfoJSON), &item.SkuFactoryInfo)
	}
	if factoryUpdatedAt != nil {
		t := factoryUpdatedAt.UTC().Format(time.RFC3339Nano)
		item.SkuFactoryInfoUpdatedAt = &t
	}
	if imageUploadedAt != nil {
		t := imageUploadedAt.UTC().Format(time.RFC3339Nano)
		item.ProductImageUploadedAt = &t
	}
	if listingUpdatedAt != nil {
		t := listingUpdatedAt.UTC().Format(time.RFC3339Nano)
		item.ListingCopyUpdatedAt = &t
	}
	item.MarketplaceURL = sku_info.BuildMarketplaceURL(item.Country, item.ASIN)
	return &item, isCreated, nil
}

func (s *SkuStore) getAccessibleProjectIDs(ctx context.Context, operator string, isAdmin bool) ([]int64, error) {
	if isAdmin {
		return nil, nil
	}
	operator = strings.TrimSpace(operator)
	if operator == "" {
		return []int64{}, nil
	}
	rows, err := s.db.Query(ctx, `
		select id
		from public.projects
		where coalesce(is_active, true) = true
		  and (
		    exists (
		      select 1 from unnest(regexp_split_to_array(
		        coalesce(project_operator, ''),
		        '[、,，;' || chr(10) || ']+'
		      )) as names(value)
		      where btrim(names.value) = $1
		    )
		    or exists (
		      select 1 from unnest(regexp_split_to_array(
		        coalesce(assistant_operator, ''),
		        '[、,，;' || chr(10) || ']+'
		      )) as names(value)
		      where btrim(names.value) = $1
		    )
		  )
		order by sort_order asc, id asc
	`, operator)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if ids == nil {
		ids = []int64{}
	}
	return ids, rows.Err()
}

func (s *SkuStore) ListSkuRecords(ctx context.Context, filter sku_info.SkuFilter) (sku_info.SkuRecordsPage, error) {
	var conditions []string
	var args []any
	idx := 1

	if !filter.IsAdmin {
		accessible, err := s.getAccessibleProjectIDs(ctx, filter.Operator, false)
		if err != nil {
			return sku_info.SkuRecordsPage{}, err
		}
		if len(accessible) == 0 {
			var totalCount *int
			if filter.IncludeTotal {
				zero := 0
				totalCount = &zero
			}
			return sku_info.SkuRecordsPage{
				Items:    []sku_info.SkuRecordItem{},
				Page:     filter.Page,
				PageSize: filter.PageSize,
				Total:    totalCount,
				HasNext:  false,
			}, nil
		}
		conditions = append(conditions, fmt.Sprintf("project_id = any($%d)", idx))
		args = append(args, accessible)
		idx++
	}

	if filter.ProjectName != nil && *filter.ProjectName != "" {
		conditions = append(conditions, fmt.Sprintf("project_name = $%d", idx))
		args = append(args, *filter.ProjectName)
		idx++
	}
	if filter.SKU != nil && *filter.SKU != "" {
		conditions = append(conditions, fmt.Sprintf("sku ilike $%d", idx))
		args = append(args, "%"+*filter.SKU+"%")
		idx++
	}
	if filter.ASIN != nil && *filter.ASIN != "" {
		conditions = append(conditions, fmt.Sprintf("asin ilike $%d", idx))
		args = append(args, "%"+*filter.ASIN+"%")
		idx++
	}
	if filter.Country != nil && *filter.Country != "" {
		conditions = append(conditions, fmt.Sprintf("upper(country) = $%d", idx))
		args = append(args, strings.ToUpper(*filter.Country))
		idx++
	}
	if filter.IsActive != nil {
		conditions = append(conditions, fmt.Sprintf("is_active = $%d", idx))
		args = append(args, *filter.IsActive)
		idx++
	}

	where := ""
	if len(conditions) > 0 {
		where = "where " + strings.Join(conditions, " and ")
	}

	var totalCount *int
	if filter.IncludeTotal {
		var cnt int
		countSQL := fmt.Sprintf("select count(*) from public.product_costs %s", where)
		if err := s.db.QueryRow(ctx, countSQL, args...).Scan(&cnt); err == nil {
			totalCount = &cnt
		}
	}

	limit := filter.PageSize
	offset := (filter.Page - 1) * filter.PageSize
	if offset < 0 {
		offset = 0
	}

	querySQL := fmt.Sprintf(`
		select %s
		from public.product_costs
		%s
		order by sort_order asc, id asc
		limit $%d offset $%d
	`, skuSelectColumns, where, idx, idx+1)
	args = append(args, limit+1, offset)

	rows, err := s.db.Query(ctx, querySQL, args...)
	if err != nil {
		return sku_info.SkuRecordsPage{}, err
	}
	defer rows.Close()

	var items []sku_info.SkuRecordItem
	for rows.Next() {
		item, err := scanSkuRecord(rows)
		if err != nil {
			return sku_info.SkuRecordsPage{}, err
		}
		items = append(items, *item)
	}

	hasNext := false
	if len(items) > limit {
		hasNext = true
		items = items[:limit]
	}

	return sku_info.SkuRecordsPage{
		Items:    items,
		Page:     filter.Page,
		PageSize: filter.PageSize,
		Total:    totalCount,
		HasNext:  hasNext,
	}, nil
}

func getSkuRecordWithDB(ctx context.Context, db DB, id int64) (*sku_info.SkuRecordItem, error) {
	querySQL := fmt.Sprintf(`select %s from public.product_costs where id = $1`, skuSelectColumns)
	row := db.QueryRow(ctx, querySQL, id)
	item, err := scanSkuRecord(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return item, nil
}

func (s *SkuStore) GetProjectIDsBySkuIDs(ctx context.Context, ids []int64) (map[int64]int64, error) {
	if len(ids) == 0 {
		return map[int64]int64{}, nil
	}
	rows, err := s.db.Query(ctx, `select id, project_id from public.product_costs where id = any($1)`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	res := make(map[int64]int64, len(ids))
	for rows.Next() {
		var id, pid int64
		if err := rows.Scan(&id, &pid); err == nil {
			res[id] = pid
		}
	}
	return res, rows.Err()
}

func (s *SkuStore) GetSkuRecord(ctx context.Context, id int64) (*sku_info.SkuRecordItem, error) {
	return getSkuRecordWithDB(ctx, s.db, id)
}

func createOrUpdateSkuRecordWithDB(ctx context.Context, db FullDB, create sku_info.SkuRecordCreate, operator string) (sku_info.SkuRecordItem, string, error) {
	projectName := strings.TrimSpace(create.ProjectName)
	if projectName == "" {
		return sku_info.SkuRecordItem{}, "", fmt.Errorf("400: project_name is required")
	}
	sku := strings.TrimSpace(create.SKU)
	if sku == "" {
		return sku_info.SkuRecordItem{}, "", fmt.Errorf("400: sku is required")
	}

	var projectID int64
	err := db.QueryRow(ctx, `select id from public.projects where project_name = $1`, projectName).Scan(&projectID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return sku_info.SkuRecordItem{}, "", fmt.Errorf("404: 项目不存在: %s", projectName)
		}
		return sku_info.SkuRecordItem{}, "", err
	}

	country := "US"
	if strings.TrimSpace(create.Country) != "" {
		country = strings.ToUpper(strings.TrimSpace(create.Country))
	}
	currency := "CNY"
	if strings.TrimSpace(create.Currency) != "" {
		currency = strings.TrimSpace(create.Currency)
	}

	sortOrder := 1
	if create.SortOrder != nil && *create.SortOrder > 0 {
		sortOrder = *create.SortOrder
	} else {
		_ = db.QueryRow(ctx, `select coalesce(max(sort_order), 0) + 1 from public.product_costs where project_id = $1`, projectID).Scan(&sortOrder)
	}

	fob := 0.0
	if create.FOBUnitCost != nil {
		fob = *create.FOBUnitCost
	}
	firstLeg := 0.0
	if create.FirstLegCostRMB != nil {
		firstLeg = *create.FirstLegCostRMB
	}

	var pkgL, pkgW, pkgH, wt, ctnL, ctnW, ctnH, ctnWt float64
	var units int
	if create.PackageLengthCM != nil {
		pkgL = *create.PackageLengthCM
	}
	if create.PackageWidthCM != nil {
		pkgW = *create.PackageWidthCM
	}
	if create.PackageHeightCM != nil {
		pkgH = *create.PackageHeightCM
	}
	if create.WeightKG != nil {
		wt = *create.WeightKG
	}
	if create.CartonLengthCM != nil {
		ctnL = *create.CartonLengthCM
	}
	if create.CartonWidthCM != nil {
		ctnW = *create.CartonWidthCM
	}
	if create.CartonHeightCM != nil {
		ctnH = *create.CartonHeightCM
	}
	if create.CartonWeightKG != nil {
		ctnWt = *create.CartonWeightKG
	}
	if create.UnitsPerCarton != nil {
		units = *create.UnitsPerCarton
	}

	var factoryInfoJSON []byte
	var factoryUpdatedAt *time.Time
	var factoryUpdatedBy *string
	if create.SkuFactoryInfo != nil {
		factoryInfoJSON, _ = json.Marshal(create.SkuFactoryInfo)
		now := time.Now().UTC()
		factoryUpdatedAt = &now
		if operator != "" {
			factoryUpdatedBy = &operator
		}
	}

	var listingUpdatedAt *time.Time
	var listingUpdatedBy *string
	hasListingCopy := create.ListingTitle != nil || create.ListingBullet1 != nil ||
		create.ListingBullet2 != nil || create.ListingBullet3 != nil ||
		create.ListingBullet4 != nil || create.ListingBullet5 != nil ||
		create.ListingDescription != nil || create.ListingSellingPoints != nil
	if hasListingCopy {
		now := time.Now().UTC()
		listingUpdatedAt = &now
		if operator != "" {
			listingUpdatedBy = &operator
		}
	}

	upsertSQL := fmt.Sprintf(`
		insert into public.product_costs (
			project_id, project_name, sku, asin, fnsku, product_name, father_id,
			fob_unit_cost, first_leg_cost_rmb,
			package_length_cm, package_width_cm, package_height_cm, weight_kg,
			carton_length_cm, carton_width_cm, carton_height_cm, carton_weight_kg, units_per_carton,
			currency, country, sort_order, is_active, source_file,
			sku_factory_info, sku_factory_info_updated_at, sku_factory_info_updated_by,
			listing_title, listing_bullet_1, listing_bullet_2, listing_bullet_3, listing_bullet_4, listing_bullet_5,
			listing_description, listing_selling_points, listing_copy_updated_at, listing_copy_updated_by,
			created_at, updated_at
		) values (
			$1, $2, $3, $4, $5, $6, $7,
			$8, $9,
			$10, $11, $12, $13,
			$14, $15, $16, $17, $18,
			$19, $20, $21, $22, $23,
			$24, $25, $26,
			$27, $28, $29, $30, $31, $32,
			$33, $34, $35, $36,
			now(), now()
		)
		on conflict (project_id, sku, asin, country) do update set
			fnsku = coalesce(excluded.fnsku, product_costs.fnsku),
			product_name = coalesce(excluded.product_name, product_costs.product_name),
			father_id = coalesce(excluded.father_id, product_costs.father_id),
			fob_unit_cost = excluded.fob_unit_cost,
			first_leg_cost_rmb = excluded.first_leg_cost_rmb,
			package_length_cm = excluded.package_length_cm,
			package_width_cm = excluded.package_width_cm,
			package_height_cm = excluded.package_height_cm,
			weight_kg = excluded.weight_kg,
			carton_length_cm = excluded.carton_length_cm,
			carton_width_cm = excluded.carton_width_cm,
			carton_height_cm = excluded.carton_height_cm,
			carton_weight_kg = excluded.carton_weight_kg,
			units_per_carton = excluded.units_per_carton,
			currency = excluded.currency,
			is_active = excluded.is_active,
			source_file = coalesce(excluded.source_file, product_costs.source_file),
			sku_factory_info = coalesce(excluded.sku_factory_info, product_costs.sku_factory_info),
			sku_factory_info_updated_at = case when excluded.sku_factory_info is not null then excluded.sku_factory_info_updated_at else product_costs.sku_factory_info_updated_at end,
			sku_factory_info_updated_by = case when excluded.sku_factory_info is not null then excluded.sku_factory_info_updated_by else product_costs.sku_factory_info_updated_by end,
			listing_title = coalesce(excluded.listing_title, product_costs.listing_title),
			listing_bullet_1 = coalesce(excluded.listing_bullet_1, product_costs.listing_bullet_1),
			listing_bullet_2 = coalesce(excluded.listing_bullet_2, product_costs.listing_bullet_2),
			listing_bullet_3 = coalesce(excluded.listing_bullet_3, product_costs.listing_bullet_3),
			listing_bullet_4 = coalesce(excluded.listing_bullet_4, product_costs.listing_bullet_4),
			listing_bullet_5 = coalesce(excluded.listing_bullet_5, product_costs.listing_bullet_5),
			listing_description = coalesce(excluded.listing_description, product_costs.listing_description),
			listing_selling_points = coalesce(excluded.listing_selling_points, product_costs.listing_selling_points),
			listing_copy_updated_at = case when (excluded.listing_title is not null or excluded.listing_description is not null) then excluded.listing_copy_updated_at else product_costs.listing_copy_updated_at end,
			listing_copy_updated_by = case when (excluded.listing_title is not null or excluded.listing_description is not null) then excluded.listing_copy_updated_by else product_costs.listing_copy_updated_by end,
			updated_at = now()
		returning (xmax = 0), %s
	`, skuSelectColumns)

	row := db.QueryRow(ctx, upsertSQL,
		projectID, projectName, sku, create.ASIN, create.FNSKU, create.ProductName, create.FatherID,
		fob, firstLeg,
		pkgL, pkgW, pkgH, wt,
		ctnL, ctnW, ctnH, ctnWt, units,
		currency, country, sortOrder, create.IsActive, create.SourceFile,
		factoryInfoJSON, factoryUpdatedAt, factoryUpdatedBy,
		create.ListingTitle, create.ListingBullet1, create.ListingBullet2, create.ListingBullet3, create.ListingBullet4, create.ListingBullet5,
		create.ListingDescription, create.ListingSellingPoints, listingUpdatedAt, listingUpdatedBy,
	)

	item, isCreated, err := scanSkuRecordWithCreated(row)
	if err != nil {
		return sku_info.SkuRecordItem{}, "", err
	}
	action := "updated"
	if isCreated {
		action = "created"
	}
	return *item, action, nil
}

func (s *SkuStore) CreateOrUpdateSkuRecord(ctx context.Context, create sku_info.SkuRecordCreate, operator string) (sku_info.SkuRecordItem, string, error) {
	return createOrUpdateSkuRecordWithDB(ctx, s.db, create, operator)
}

func (s *SkuStore) BulkCreateOrUpdateSkuRecords(ctx context.Context, bulk sku_info.SkuRecordBulkCreate, op string) (sku_info.SkuRecordBulkUpsertResponse, error) {
	var resp sku_info.SkuRecordBulkUpsertResponse
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		inserted := 0
		updated := 0
		for _, item := range bulk.Items {
			if bulk.SourceFile != nil && item.SourceFile == nil {
				item.SourceFile = bulk.SourceFile
			}
			_, action, err := createOrUpdateSkuRecordWithDB(ctx, txDB, item, op)
			if err != nil {
				return err // atomic rollback!
			}
			if action == "created" {
				inserted++
			} else {
				updated++
			}
		}
		resp = sku_info.SkuRecordBulkUpsertResponse{
			Inserted: inserted,
			Updated:  updated,
			Total:    inserted + updated,
		}
		return nil
	})
	if err != nil {
		return sku_info.SkuRecordBulkUpsertResponse{}, err
	}
	return resp, nil
}

func (s *SkuStore) UpdateSkuRecord(ctx context.Context, id int64, update sku_info.SkuRecordUpdate, operator string) (*sku_info.SkuRecordItem, error) {
	var sets []string
	var args []any
	idx := 2
	args = append(args, id)

	if update.SKU != nil {
		sets = append(sets, fmt.Sprintf("sku = $%d", idx))
		args = append(args, *update.SKU)
		idx++
	}
	if update.ASIN != nil {
		sets = append(sets, fmt.Sprintf("asin = $%d", idx))
		args = append(args, *update.ASIN)
		idx++
	}
	if update.FNSKU != nil {
		sets = append(sets, fmt.Sprintf("fnsku = $%d", idx))
		args = append(args, *update.FNSKU)
		idx++
	}
	if update.ProductName != nil {
		sets = append(sets, fmt.Sprintf("product_name = $%d", idx))
		args = append(args, *update.ProductName)
		idx++
	}
	if update.FatherID != nil {
		sets = append(sets, fmt.Sprintf("father_id = $%d", idx))
		args = append(args, *update.FatherID)
		idx++
	}
	if update.FOBUnitCost != nil {
		sets = append(sets, fmt.Sprintf("fob_unit_cost = $%d", idx))
		args = append(args, *update.FOBUnitCost)
		idx++
	}
	if update.FirstLegCostRMB != nil {
		sets = append(sets, fmt.Sprintf("first_leg_cost_rmb = $%d", idx))
		args = append(args, *update.FirstLegCostRMB)
		idx++
	}
	if update.PackageLengthCM != nil {
		sets = append(sets, fmt.Sprintf("package_length_cm = $%d", idx))
		args = append(args, *update.PackageLengthCM)
		idx++
	}
	if update.PackageWidthCM != nil {
		sets = append(sets, fmt.Sprintf("package_width_cm = $%d", idx))
		args = append(args, *update.PackageWidthCM)
		idx++
	}
	if update.PackageHeightCM != nil {
		sets = append(sets, fmt.Sprintf("package_height_cm = $%d", idx))
		args = append(args, *update.PackageHeightCM)
		idx++
	}
	if update.WeightKG != nil {
		sets = append(sets, fmt.Sprintf("weight_kg = $%d", idx))
		args = append(args, *update.WeightKG)
		idx++
	}
	if update.CartonLengthCM != nil {
		sets = append(sets, fmt.Sprintf("carton_length_cm = $%d", idx))
		args = append(args, *update.CartonLengthCM)
		idx++
	}
	if update.CartonWidthCM != nil {
		sets = append(sets, fmt.Sprintf("carton_width_cm = $%d", idx))
		args = append(args, *update.CartonWidthCM)
		idx++
	}
	if update.CartonHeightCM != nil {
		sets = append(sets, fmt.Sprintf("carton_height_cm = $%d", idx))
		args = append(args, *update.CartonHeightCM)
		idx++
	}
	if update.CartonWeightKG != nil {
		sets = append(sets, fmt.Sprintf("carton_weight_kg = $%d", idx))
		args = append(args, *update.CartonWeightKG)
		idx++
	}
	if update.UnitsPerCarton != nil {
		sets = append(sets, fmt.Sprintf("units_per_carton = $%d", idx))
		args = append(args, *update.UnitsPerCarton)
		idx++
	}
	if update.Currency != nil {
		sets = append(sets, fmt.Sprintf("currency = $%d", idx))
		args = append(args, *update.Currency)
		idx++
	}
	if update.Country != nil {
		sets = append(sets, fmt.Sprintf("country = $%d", idx))
		args = append(args, strings.ToUpper(*update.Country))
		idx++
	}
	if update.SortOrder != nil {
		sets = append(sets, fmt.Sprintf("sort_order = $%d", idx))
		args = append(args, *update.SortOrder)
		idx++
	}
	if update.IsActive != nil {
		sets = append(sets, fmt.Sprintf("is_active = $%d", idx))
		args = append(args, *update.IsActive)
		idx++
	}
	if update.SourceFile != nil {
		sets = append(sets, fmt.Sprintf("source_file = $%d", idx))
		args = append(args, *update.SourceFile)
		idx++
	}
	if update.SkuFactoryInfo != nil {
		data, _ := json.Marshal(update.SkuFactoryInfo)
		sets = append(sets, fmt.Sprintf("sku_factory_info = $%d", idx))
		args = append(args, data)
		idx++
		sets = append(sets, "sku_factory_info_updated_at = now()")
		if operator != "" {
			sets = append(sets, fmt.Sprintf("sku_factory_info_updated_by = $%d", idx))
			args = append(args, operator)
			idx++
		}
	}
	hasListingCopy := false
	if update.ListingTitle != nil {
		sets = append(sets, fmt.Sprintf("listing_title = $%d", idx))
		args = append(args, *update.ListingTitle)
		idx++
		hasListingCopy = true
	}
	if update.ListingBullet1 != nil {
		sets = append(sets, fmt.Sprintf("listing_bullet_1 = $%d", idx))
		args = append(args, *update.ListingBullet1)
		idx++
		hasListingCopy = true
	}
	if update.ListingBullet2 != nil {
		sets = append(sets, fmt.Sprintf("listing_bullet_2 = $%d", idx))
		args = append(args, *update.ListingBullet2)
		idx++
		hasListingCopy = true
	}
	if update.ListingBullet3 != nil {
		sets = append(sets, fmt.Sprintf("listing_bullet_3 = $%d", idx))
		args = append(args, *update.ListingBullet3)
		idx++
		hasListingCopy = true
	}
	if update.ListingBullet4 != nil {
		sets = append(sets, fmt.Sprintf("listing_bullet_4 = $%d", idx))
		args = append(args, *update.ListingBullet4)
		idx++
		hasListingCopy = true
	}
	if update.ListingBullet5 != nil {
		sets = append(sets, fmt.Sprintf("listing_bullet_5 = $%d", idx))
		args = append(args, *update.ListingBullet5)
		idx++
		hasListingCopy = true
	}
	if update.ListingDescription != nil {
		sets = append(sets, fmt.Sprintf("listing_description = $%d", idx))
		args = append(args, *update.ListingDescription)
		idx++
		hasListingCopy = true
	}
	if update.ListingSellingPoints != nil {
		sets = append(sets, fmt.Sprintf("listing_selling_points = $%d", idx))
		args = append(args, *update.ListingSellingPoints)
		idx++
		hasListingCopy = true
	}
	if hasListingCopy {
		sets = append(sets, "listing_copy_updated_at = now()")
		if operator != "" {
			sets = append(sets, fmt.Sprintf("listing_copy_updated_by = $%d", idx))
			args = append(args, operator)
			idx++
		}
	}

	sets = append(sets, "updated_at = now()")

	updateSQL := fmt.Sprintf(`update public.product_costs set %s where id = $1`, strings.Join(sets, ", "))
	tag, err := s.db.Exec(ctx, updateSQL, args...)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, nil
	}
	return s.GetSkuRecord(ctx, id)
}

func (s *SkuStore) DeleteSkuRecord(ctx context.Context, id int64) (bool, error) {
	tag, err := s.db.Exec(ctx, `delete from public.product_costs where id = $1`, id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (s *SkuStore) MoveSkuRecord(ctx context.Context, id int64, direction string) (*sku_info.SkuRecordItem, error) {
	if direction != "up" && direction != "down" {
		return nil, fmt.Errorf("400: direction must be 'up' or 'down'")
	}
	var res *sku_info.SkuRecordItem
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		item, err := getSkuRecordWithDB(ctx, txDB, id)
		if err != nil || item == nil {
			return err
		}
		delta := 1
		if direction == "up" {
			delta = -1
		}
		newOrder := item.SortOrder + delta
		if newOrder < 1 {
			newOrder = 1
		}
		_, err = txDB.Exec(ctx, `update public.product_costs set sort_order = $2 where id = $1`, id, newOrder)
		if err != nil {
			return err
		}
		res, err = getSkuRecordWithDB(ctx, txDB, id)
		return err
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}

func (s *SkuStore) RecalculateFirstLegCosts(ctx context.Context, req sku_info.SkuRecordFirstLegRecalculateRequest) (int, error) {
	tag, err := s.db.Exec(ctx, `
		update public.product_costs
		set first_leg_cost_rmb = round((weight_kg * $2)::numeric, 2)
		where project_name = $1 and weight_kg > 0
	`, req.ProjectName, req.UnitPricePerKgRMB)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

func (s *SkuStore) SyncFirstLegFromShipment(ctx context.Context, projectName, country string) (int, error) {
	return 0, nil
}

func (s *SkuStore) BatchUpdateFactoryInfo(ctx context.Context, req sku_info.BatchUpdateFactoryInfoRequest, operator string) (int, []int64, error) {
	if len(req.SKUIDs) == 0 {
		return 0, nil, nil
	}
	data, _ := json.Marshal(req.SkuFactoryInfo)
	tag, err := s.db.Exec(ctx, `
		update public.product_costs
		set sku_factory_info = $2, sku_factory_info_updated_at = now(), sku_factory_info_updated_by = $3
		where id = any($1)
	`, req.SKUIDs, data, operator)
	if err != nil {
		return 0, nil, err
	}
	return int(tag.RowsAffected()), req.SKUIDs, nil
}

func (s *SkuStore) BatchUpdateListingCopy(ctx context.Context, req sku_info.BatchUpdateListingCopyRequest, op string) (int, int, []int64, error) {
	updated := 0
	var updatedIDs []int64
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		for _, it := range req.Items {
			tag, err := txDB.Exec(ctx, `
				update public.product_costs
				set
					listing_title = coalesce($2, listing_title),
					listing_bullet_1 = coalesce($3, listing_bullet_1),
					listing_bullet_2 = coalesce($4, listing_bullet_2),
					listing_bullet_3 = coalesce($5, listing_bullet_3),
					listing_bullet_4 = coalesce($6, listing_bullet_4),
					listing_bullet_5 = coalesce($7, listing_bullet_5),
					listing_description = coalesce($8, listing_description),
					listing_selling_points = coalesce($9, listing_selling_points),
					listing_copy_updated_at = now(),
					listing_copy_updated_by = case when $10::text <> '' then $10 else listing_copy_updated_by end,
					updated_at = now()
				where id = $1
			`, it.ID, it.ListingTitle, it.ListingBullet1, it.ListingBullet2, it.ListingBullet3, it.ListingBullet4, it.ListingBullet5, it.ListingDescription, it.ListingSellingPoints, op)
			if err == nil && tag.RowsAffected() > 0 {
				updated++
				updatedIDs = append(updatedIDs, it.ID)
			}
		}
		return nil
	})
	if err != nil {
		return 0, 0, nil, err
	}
	return updated, len(req.Items) - updated, updatedIDs, nil
}

func (s *SkuStore) GetFnskuLabelsBySkus(ctx context.Context, projectName string, skus []string) ([]sku_info.SkuRecordFnskuLabelItem, error) {
	rows, err := s.db.Query(ctx, `
		select id, sku, fnsku_label_r2_key
		from public.product_costs
		where project_name = $1 and sku = any($2)
	`, projectName, skus)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []sku_info.SkuRecordFnskuLabelItem
	for rows.Next() {
		var it sku_info.SkuRecordFnskuLabelItem
		if err := rows.Scan(&it.ID, &it.SKU, &it.FnskuLabelR2Key); err == nil {
			list = append(list, it)
		}
	}
	return list, nil
}

func (s *SkuStore) GetSkuRecordsByIDs(
	ctx context.Context,
	ids []int64,
) ([]sku_info.SkuRecordItem, error) {
	if len(ids) == 0 {
		return []sku_info.SkuRecordItem{}, nil
	}
	rows, err := s.db.Query(
		ctx,
		fmt.Sprintf(
			`select %s
			 from public.product_costs
			 where id = any($1)
			 order by id asc`,
			skuSelectColumns,
		),
		ids,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]sku_info.SkuRecordItem, 0, len(ids))
	for rows.Next() {
		item, err := scanSkuRecord(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *SkuStore) SetFnskuLabel(
	ctx context.Context,
	id int64,
	key string,
	publicURL string,
	entry audit.Entry,
) (*sku_info.SkuRecordItem, *string, error) {
	if s == nil || s.db == nil {
		return nil, nil, errors.New("SKU database is nil")
	}
	if s.auditor == nil {
		return nil, nil, errors.New("SKU audit service is nil")
	}
	var item *sku_info.SkuRecordItem
	var previousKey *string
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var sku string
		err := txDB.QueryRow(
			ctx,
			`select sku, fnsku_label_r2_key
			 from public.product_costs
			 where id = $1
			 for update`,
			id,
		).Scan(&sku, &previousKey)
		if errors.Is(err, pgx.ErrNoRows) {
			return sku_info.ErrSkuNotFound
		}
		if err != nil {
			return err
		}
		if _, err := txDB.Exec(
			ctx,
			`update public.product_costs
			 set fnsku_label_r2_key = $2,
			     fnsku_label_r2_url = $3,
			     updated_at = now()
			 where id = $1`,
			id,
			key,
			publicURL,
		); err != nil {
			return err
		}
		item, err = getSkuRecordWithDB(ctx, txDB, id)
		if err != nil {
			return err
		}
		if item == nil {
			return sku_info.ErrSkuNotFound
		}
		entry.TargetType = "sku_info"
		targetID := strconv.FormatInt(id, 10)
		entry.TargetID = &targetID
		entry.AfterJSON = mergeSKUAuditAfter(entry.AfterJSON, map[string]any{
			"sku":                sku,
			"fnsku_label_r2_key": key,
			"fnsku_label_r2_url": publicURL,
		})
		entry.BeforeJSON = map[string]any{"fnsku_label_r2_key": previousKey}
		return s.auditor.LogActionTx(ctx, tx, entry)
	})
	if err != nil {
		return nil, nil, err
	}
	return item, previousKey, nil
}

func (s *SkuStore) SetProductImage(
	ctx context.Context,
	id int64,
	mainKey string,
	mainURL string,
	thumbKey string,
	thumbURL string,
	uploadedAt time.Time,
	operator string,
	entry audit.Entry,
) (*sku_info.SkuRecordItem, []string, error) {
	if s == nil || s.db == nil {
		return nil, nil, errors.New("SKU database is nil")
	}
	if s.auditor == nil {
		return nil, nil, errors.New("SKU audit service is nil")
	}
	var item *sku_info.SkuRecordItem
	var previousKeys []string
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var sku string
		var oldMain, oldThumb *string
		err := txDB.QueryRow(
			ctx,
			`select sku, product_image_r2_key, product_image_thumbnail_r2_key
			 from public.product_costs
			 where id = $1
			 for update`,
			id,
		).Scan(&sku, &oldMain, &oldThumb)
		if errors.Is(err, pgx.ErrNoRows) {
			return sku_info.ErrSkuNotFound
		}
		if err != nil {
			return err
		}
		if _, err := txDB.Exec(
			ctx,
			`update public.product_costs
			 set product_image_r2_key = $2,
			     product_image_r2_url = $3,
			     product_image_thumbnail_r2_key = $4,
			     product_image_thumbnail_r2_url = $5,
			     product_image_uploaded_at = $6,
			     product_image_uploaded_by = $7,
			     updated_at = now()
			 where id = $1`,
			id,
			mainKey,
			mainURL,
			thumbKey,
			thumbURL,
			uploadedAt,
			operator,
		); err != nil {
			return err
		}
		item, err = getSkuRecordWithDB(ctx, txDB, id)
		if err != nil {
			return err
		}
		if item == nil {
			return sku_info.ErrSkuNotFound
		}
		previousKeys = nonEmptyObjectKeys(oldMain, oldThumb)
		entry.TargetType = "sku_info"
		targetID := strconv.FormatInt(id, 10)
		entry.TargetID = &targetID
		entry.AfterJSON = mergeSKUAuditAfter(entry.AfterJSON, map[string]any{
			"sku":                            sku,
			"product_image_r2_key":           mainKey,
			"product_image_r2_url":           mainURL,
			"product_image_thumbnail_r2_key": thumbKey,
			"product_image_thumbnail_r2_url": thumbURL,
			"product_image_uploaded_at":      uploadedAt,
			"product_image_uploaded_by":      operator,
		})
		entry.BeforeJSON = map[string]any{
			"product_image_r2_key":           oldMain,
			"product_image_thumbnail_r2_key": oldThumb,
		}
		return s.auditor.LogActionTx(ctx, tx, entry)
	})
	if err != nil {
		return nil, nil, err
	}
	return item, previousKeys, nil
}

func (s *SkuStore) ClearProductImage(
	ctx context.Context,
	id int64,
	entry audit.Entry,
) (*sku_info.SkuRecordItem, []string, error) {
	if s == nil || s.db == nil {
		return nil, nil, errors.New("SKU database is nil")
	}
	if s.auditor == nil {
		return nil, nil, errors.New("SKU audit service is nil")
	}
	var item *sku_info.SkuRecordItem
	var previousKeys []string
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var sku string
		var oldMain, oldThumb *string
		err := txDB.QueryRow(
			ctx,
			`select sku, product_image_r2_key, product_image_thumbnail_r2_key
			 from public.product_costs
			 where id = $1
			 for update`,
			id,
		).Scan(&sku, &oldMain, &oldThumb)
		if errors.Is(err, pgx.ErrNoRows) {
			return sku_info.ErrSkuNotFound
		}
		if err != nil {
			return err
		}
		if _, err := txDB.Exec(
			ctx,
			`update public.product_costs
			 set product_image_r2_key = null,
			     product_image_r2_url = null,
			     product_image_thumbnail_r2_key = null,
			     product_image_thumbnail_r2_url = null,
			     product_image_uploaded_at = null,
			     product_image_uploaded_by = null,
			     updated_at = now()
			 where id = $1`,
			id,
		); err != nil {
			return err
		}
		item, err = getSkuRecordWithDB(ctx, txDB, id)
		if err != nil {
			return err
		}
		if item == nil {
			return sku_info.ErrSkuNotFound
		}
		previousKeys = nonEmptyObjectKeys(oldMain, oldThumb)
		entry.TargetType = "sku_info"
		targetID := strconv.FormatInt(id, 10)
		entry.TargetID = &targetID
		entry.AfterJSON = mergeSKUAuditAfter(entry.AfterJSON, map[string]any{
			"sku":     sku,
			"deleted": true,
		})
		entry.BeforeJSON = map[string]any{
			"product_image_r2_key":           oldMain,
			"product_image_thumbnail_r2_key": oldThumb,
		}
		return s.auditor.LogActionTx(ctx, tx, entry)
	})
	if err != nil {
		return nil, nil, err
	}
	return item, previousKeys, nil
}

func nonEmptyObjectKeys(values ...*string) []string {
	keys := make([]string, 0, len(values))
	for _, value := range values {
		if value != nil && strings.TrimSpace(*value) != "" {
			keys = append(keys, *value)
		}
	}
	return keys
}

func mergeSKUAuditAfter(existing any, additions map[string]any) map[string]any {
	merged := make(map[string]any, len(additions)+1)
	if values, ok := existing.(map[string]any); ok {
		for key, value := range values {
			merged[key] = value
		}
	}
	for key, value := range additions {
		merged[key] = value
	}
	return merged
}

func (s *SkuStore) ExportCSV(ctx context.Context, filter sku_info.SkuFilter) (string, []byte, error) {
	filter.Page = 1
	filter.PageSize = 50000
	page, err := s.ListSkuRecords(ctx, filter)
	if err != nil {
		return "", nil, err
	}

	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	_ = w.Write([]string{"ID", "项目", "SKU", "ASIN", "FNSKU", "品名", "成本(FOB)", "头程运费", "币种", "站点"})
	for _, it := range page.Items {
		fnsku := ""
		if it.FNSKU != nil {
			fnsku = *it.FNSKU
		}
		prod := ""
		if it.ProductName != nil {
			prod = *it.ProductName
		}
		_ = w.Write([]string{
			strconv.FormatInt(it.ID, 10), it.ProjectName, it.SKU, it.ASIN, fnsku, prod,
			fmt.Sprintf("%.2f", it.FOBUnitCost), fmt.Sprintf("%.2f", it.FirstLegCostRMB),
			it.Currency, it.Country,
		})
	}
	w.Flush()
	return fmt.Sprintf("sku_records_%s.csv", time.Now().Format("20060102")), buf.Bytes(), nil
}

func (s *SkuStore) ImportCSV(ctx context.Context, projectName string, data []byte, op string) (sku_info.SkuRecordImportResponse, error) {
	projectName = strings.TrimSpace(projectName)
	if projectName == "" {
		return sku_info.SkuRecordImportResponse{}, fmt.Errorf("400: project_name is required")
	}
	r := csv.NewReader(bytes.NewReader(data))
	records, err := r.ReadAll()
	if err != nil || len(records) <= 1 {
		return sku_info.SkuRecordImportResponse{}, err
	}
	var resp sku_info.SkuRecordImportResponse
	err = RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		inserted := 0
		updated := 0
		for _, row := range records[1:] {
			if len(row) < 3 {
				continue
			}
			sku := strings.TrimSpace(row[1])
			asin := strings.TrimSpace(row[2])
			if sku == "" {
				continue
			}
			_, action, err := createOrUpdateSkuRecordWithDB(ctx, txDB, sku_info.SkuRecordCreate{
				ProjectName: projectName,
				SKU:         sku,
				ASIN:        asin,
			}, op)
			if err != nil {
				return err
			}
			if action == "created" {
				inserted++
			} else {
				updated++
			}
		}
		resp = sku_info.SkuRecordImportResponse{
			Inserted: inserted,
			Updated:  updated,
			Total:    len(records) - 1,
		}
		return nil
	})
	if err != nil {
		return sku_info.SkuRecordImportResponse{}, err
	}
	return resp, nil
}
