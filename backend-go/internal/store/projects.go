package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type ProjectStore struct {
	db      FullDB
	auditor audit.Service
}

func NewProjectStore(db FullDB, auditors ...audit.Service) *ProjectStore {
	var auditor audit.Service
	if len(auditors) > 0 {
		auditor = auditors[0]
	} else if db != nil {
		auditor = audit.NewService(db)
	}
	return &ProjectStore{db: db, auditor: auditor}
}

const projectSelectColumns = `
	id, project_name, brand_name, store_address, project_operator,
	assistant_operator, commission_basis, commission_rate, sort_order,
	coalesce(is_active, true), source_file, project_context::text,
	sku_context::text, project_tier, country, vat_enabled`

func (s *ProjectStore) ListOptions(ctx context.Context) ([]projects.ProjectOption, error) {
	items, err := s.ListManage(ctx, "", true, false)
	if err != nil {
		return nil, err
	}
	if len(items) > 0 {
		options := make([]projects.ProjectOption, 0, len(items))
		for _, item := range items {
			options = append(options, projects.ProjectOption{
				ID:          int64Pointer(item.ID),
				Name:        item.Name,
				Country:     item.Country,
				CountryName: item.CountryName,
			})
		}
		return options, nil
	}

	// Backward-compatible fallback, matching project_service.list_project_options:
	// SkuRecord maps to product_costs, so an empty projects table still yields the
	// distinct store names seen in product costs.
	rows, err := s.db.Query(
		ctx,
		`select distinct project_name
		 from public.product_costs
		 where project_name is not null and trim(project_name) <> ''
		 order by project_name asc`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	options := make([]projects.ProjectOption, 0)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		options = append(options, projects.ProjectOption{
			Name:    name,
			Country: "US",
		})
	}
	return options, rows.Err()
}

func (s *ProjectStore) ListManage(
	ctx context.Context,
	operator string,
	isAdmin bool,
	showInactive bool,
) ([]projects.ProjectItem, error) {
	operator = strings.TrimSpace(operator)
	if !isAdmin && operator == "" {
		return []projects.ProjectItem{}, nil
	}
	rows, err := s.db.Query(
		ctx,
		`select `+projectSelectColumns+`
		 from public.projects
		 where ($1::boolean or coalesce(is_active, true))
		   and (
		     $2::boolean
		     or (
		       $3::text <> ''
		       and (
		         exists (
		           select 1 from unnest(regexp_split_to_array(
		             coalesce(project_operator, ''),
		             '[、,，;' || chr(10) || ']+'
		           )) as names(value)
		           where btrim(names.value) = $3
		         )
		         or exists (
		           select 1 from unnest(regexp_split_to_array(
		             coalesce(assistant_operator, ''),
		             '[、,，;' || chr(10) || ']+'
		           )) as names(value)
		           where btrim(names.value) = $3
		         )
		       )
		     )
		   )
		 order by coalesce(is_active, true) desc, sort_order asc, id asc`,
		showInactive,
		isAdmin,
		operator,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]projects.ProjectItem, 0)
	for rows.Next() {
		item, err := scanProjectItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *ProjectStore) ListOperatorOptions(ctx context.Context) ([]string, error) {
	rows, err := s.db.Query(
		ctx,
		`select distinct nullif(trim(full_name), '') as operator_name
		 from public.user_accounts
		 where nullif(trim(full_name), '') is not null
		 order by operator_name asc`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]string, 0)
	for rows.Next() {
		var operator string
		if err := rows.Scan(&operator); err != nil {
			return nil, err
		}
		items = append(items, operator)
	}
	return items, rows.Err()
}

func (s *ProjectStore) GetProject(ctx context.Context, projectID int64) (*projects.ProjectItem, error) {
	item, err := scanProjectItem(s.db.QueryRow(
		ctx,
		`select `+projectSelectColumns+` from public.projects where id = $1 limit 1`,
		projectID,
	))
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *ProjectStore) GetProjectByName(ctx context.Context, name string) (*projects.ProjectItem, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, nil
	}
	item, err := scanProjectItem(s.db.QueryRow(
		ctx,
		`select `+projectSelectColumns+` from public.projects where project_name = $1 limit 1`,
		name,
	))
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *ProjectStore) CreateProject(ctx context.Context, input projects.CreateProjectInput) (projects.ProjectItem, error) {
	input.Name = strings.TrimSpace(input.Name)
	input.Country, _ = projects.ValidateCountry(input.Country)
	input.BrandName = normalizeProjectText(input.BrandName)
	input.StoreAddress = normalizeProjectText(input.StoreAddress)
	input.ProjectOperator = normalizeProjectOperators(input.ProjectOperator)
	input.AssistantOperator = normalizeProjectOperators(input.AssistantOperator)
	input.CommissionBasis = normalizeProjectText(input.CommissionBasis)
	input.CommissionRate = normalizeCommissionRate(input.CommissionRate)
	input.ProjectTier = normalizeProjectTier(input.ProjectTier)

	var item projects.ProjectItem
	err := s.inTx(ctx, func(db DB) error {
		row := db.QueryRow(
			ctx,
			`insert into public.projects (
			   project_name, brand_name, store_address, project_operator,
			   assistant_operator, commission_basis, commission_rate,
			   sort_order, is_active, source_file, project_tier, country,
			   vat_enabled
			 )
			 select $1, $2, $3, $4, $5, $6, $7,
			        coalesce(max(sort_order), -1) + 1, true,
			        'manual_single_add', $8, $9, $10
			 from public.projects
			 returning `+projectSelectColumns,
			input.Name,
			input.BrandName,
			input.StoreAddress,
			input.ProjectOperator,
			input.AssistantOperator,
			input.CommissionBasis,
			input.CommissionRate,
			input.ProjectTier,
			input.Country,
			input.VATEnabled,
		)
		var err error
		item, err = scanProjectItem(row)
		return mapProjectConstraintError(err)
	})
	return item, err
}

func (s *ProjectStore) UpdateProject(
	ctx context.Context,
	projectID int64,
	input projects.UpdateProjectInput,
) (projects.ProjectItem, error) {
	input.Name = strings.TrimSpace(input.Name)
	input.BrandName = normalizeProjectText(input.BrandName)
	input.StoreAddress = normalizeProjectText(input.StoreAddress)
	input.ProjectOperator = normalizeProjectOperators(input.ProjectOperator)
	input.AssistantOperator = normalizeProjectOperators(input.AssistantOperator)
	input.CommissionBasis = normalizeProjectText(input.CommissionBasis)
	input.CommissionRate = normalizeCommissionRate(input.CommissionRate)
	input.ProjectTier = normalizeProjectTier(input.ProjectTier)
	if input.Country != nil {
		country, err := projects.ValidateCountry(*input.Country)
		if err != nil {
			return projects.ProjectItem{}, err
		}
		input.Country = &country
	}
	isActive := true
	if input.IsActive != nil {
		isActive = *input.IsActive
	}

	var item projects.ProjectItem
	err := s.inTx(ctx, func(db DB) error {
		row := db.QueryRow(
			ctx,
			`update public.projects
			 set project_name = $2,
			     brand_name = $3,
			     store_address = $4,
			     project_operator = $5,
			     assistant_operator = $6,
			     commission_basis = $7,
			     commission_rate = $8,
			     is_active = $9,
			     project_tier = $10,
			     country = coalesce($11, country),
			     vat_enabled = coalesce($12, vat_enabled)
			 where id = $1
			 returning `+projectSelectColumns,
			projectID,
			input.Name,
			input.BrandName,
			input.StoreAddress,
			input.ProjectOperator,
			input.AssistantOperator,
			input.CommissionBasis,
			input.CommissionRate,
			isActive,
			input.ProjectTier,
			input.Country,
			input.VATEnabled,
		)
		var err error
		item, err = scanProjectItem(row)
		if err == pgx.ErrNoRows {
			return projects.ErrNotFound
		}
		return mapProjectConstraintError(err)
	})
	return item, err
}

func (s *ProjectStore) MoveProject(ctx context.Context, projectID int64, direction string) (projects.ProjectItem, error) {
	if direction != "up" && direction != "down" {
		return projects.ProjectItem{}, projects.NewAPIError(http.StatusBadRequest, "direction must be 'up' or 'down'")
	}
	var item projects.ProjectItem
	err := s.inTx(ctx, func(db DB) error {
		var err error
		item, err = moveProjectWithDB(ctx, db, projectID, direction)
		return err
	})
	return item, err
}

func (s *ProjectStore) MoveProjectAudited(
	ctx context.Context,
	projectID int64,
	direction string,
	entry audit.Entry,
) (projects.ProjectItem, error) {
	if direction != "up" && direction != "down" {
		return projects.ProjectItem{}, projects.NewAPIError(http.StatusBadRequest, "direction must be 'up' or 'down'")
	}
	if s == nil || s.db == nil {
		return projects.ProjectItem{}, errors.New("project database is nil")
	}
	if s.auditor == nil {
		return projects.ProjectItem{}, errors.New("project audit service is nil")
	}

	var item projects.ProjectItem
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		var err error
		item, err = moveProjectWithDB(ctx, NewTxDB(tx), projectID, direction)
		if err != nil {
			return err
		}
		entry.AfterJSON = item
		if err := s.auditor.LogActionTx(ctx, tx, entry); err != nil {
			return fmt.Errorf("write project move audit: %w", err)
		}
		return nil
	})
	return item, err
}

func moveProjectWithDB(
	ctx context.Context,
	db DB,
	projectID int64,
	direction string,
) (projects.ProjectItem, error) {
	var currentOrder int
	var active bool
	err := db.QueryRow(
		ctx,
		`select sort_order, coalesce(is_active, true)
		 from public.projects where id = $1 for update`,
		projectID,
	).Scan(&currentOrder, &active)
	if err == pgx.ErrNoRows {
		return projects.ProjectItem{}, projects.ErrNotFound
	}
	if err != nil {
		return projects.ProjectItem{}, err
	}

	operator := "<"
	order := "desc"
	if direction == "down" {
		operator = ">"
		order = "asc"
	}
	var neighborID int64
	var neighborOrder int
	err = db.QueryRow(
		ctx,
		`select id, sort_order
		 from public.projects
		 where coalesce(is_active, true) = $1 and sort_order `+operator+` $2
		 order by sort_order `+order+`, id `+order+`
		 limit 1 for update`,
		active,
		currentOrder,
	).Scan(&neighborID, &neighborOrder)
	if err == pgx.ErrNoRows {
		if direction == "up" {
			return projects.ProjectItem{}, projects.NewAPIError(http.StatusBadRequest, "已在最顶部")
		}
		return projects.ProjectItem{}, projects.NewAPIError(http.StatusBadRequest, "已在最底部")
	}
	if err != nil {
		return projects.ProjectItem{}, err
	}
	execer, ok := db.(Execer)
	if !ok {
		return projects.ProjectItem{}, errors.New("project database does not support writes")
	}
	if _, err := execer.Exec(ctx,
		`update public.projects
		 set sort_order = case id when $1 then $2 when $3 then $4 end
		 where id in ($1, $3)`,
		projectID, neighborOrder, neighborID, currentOrder,
	); err != nil {
		return projects.ProjectItem{}, err
	}
	return scanProjectItem(db.QueryRow(
		ctx,
		`select `+projectSelectColumns+` from public.projects where id = $1`,
		projectID,
	))
}

func (s *ProjectStore) ListProjectShops(ctx context.Context, projectID int64) ([]projects.ProjectShopItem, error) {
	rows, err := s.db.Query(
		ctx,
		`select id, country, shop_id, shop_name, seller_identity_expected_alias,
		        seller_identity_aliases::text, seller_identity_source,
		        seller_identity_required
		 from public.project_shops
		 where project_id = $1
		 order by country asc`,
		projectID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]projects.ProjectShopItem, 0)
	for rows.Next() {
		item, err := scanProjectShop(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *ProjectStore) UpsertProjectShop(
	ctx context.Context,
	projectID int64,
	country string,
	input projects.ShopUpsert,
) (*projects.ProjectShopItem, projects.ProjectShopItem, error) {
	var before *projects.ProjectShopItem
	var after projects.ProjectShopItem
	err := s.inTx(ctx, func(db DB) error {
		existing, err := getProjectShop(ctx, db, projectID, country)
		if err != nil {
			return err
		}
		before = existing
		shopName := chooseOptionalString(input.ShopName, existing, func(item *projects.ProjectShopItem) *string { return item.ShopName })
		expectedAlias := chooseOptionalString(input.SellerIdentityExpectedAlias, existing, func(item *projects.ProjectShopItem) *string { return item.SellerIdentityExpectedAlias })
		identitySource := chooseOptionalString(input.SellerIdentitySource, existing, func(item *projects.ProjectShopItem) *string { return item.SellerIdentitySource })
		aliases := []string{}
		required := true
		if existing != nil {
			aliases = append(aliases, existing.SellerIdentityAliases...)
			required = existing.SellerIdentityRequired
		}
		if input.SellerIdentityAliases.Present {
			aliases = append([]string{}, input.SellerIdentityAliases.Value...)
		}
		if input.SellerIdentityRequired.Present {
			if input.SellerIdentityRequired.Value == nil {
				required = true
			} else {
				required = *input.SellerIdentityRequired.Value
			}
		}
		aliasJSON, err := json.Marshal(aliases)
		if err != nil {
			return err
		}
		row := db.QueryRow(
			ctx,
			`insert into public.project_shops (
			   project_id, country, shop_id, shop_name,
			   seller_identity_expected_alias, seller_identity_aliases,
			   seller_identity_source, seller_identity_required
			 ) values ($1, $2, $3, $4, $5, $6::json, $7, $8)
			 on conflict (project_id, country) do update set
			   shop_id = excluded.shop_id,
			   shop_name = excluded.shop_name,
			   seller_identity_expected_alias = excluded.seller_identity_expected_alias,
			   seller_identity_aliases = excluded.seller_identity_aliases,
			   seller_identity_source = excluded.seller_identity_source,
			   seller_identity_required = excluded.seller_identity_required
			 returning id, country, shop_id, shop_name,
			           seller_identity_expected_alias, seller_identity_aliases::text,
			           seller_identity_source, seller_identity_required`,
			projectID, country, input.ShopID, shopName, expectedAlias, aliasJSON, identitySource, required,
		)
		after, err = scanProjectShop(row)
		return mapShopConstraintError(err)
	})
	return before, after, err
}

func (s *ProjectStore) DeleteProjectShop(ctx context.Context, projectID int64, country string) (bool, error) {
	var deleted bool
	err := s.inTx(ctx, func(db DB) error {
		err := db.QueryRow(
			ctx,
			`delete from public.project_shops
			 where project_id = $1 and country = $2
			 returning true`,
			projectID,
			country,
		).Scan(&deleted)
		if err == pgx.ErrNoRows {
			deleted = false
			return nil
		}
		return err
	})
	return deleted, err
}

func (s *ProjectStore) GetProjectContext(ctx context.Context, projectID int64) (projects.ProjectContext, error) {
	var name string
	var projectJSON, skuJSON pgtype.Text
	err := s.db.QueryRow(
		ctx,
		`select project_name, project_context::text, sku_context::text
		 from public.projects where id = $1`,
		projectID,
	).Scan(&name, &projectJSON, &skuJSON)
	if err == pgx.ErrNoRows {
		return projects.ProjectContext{}, projects.ErrNotFound
	}
	if err != nil {
		return projects.ProjectContext{}, err
	}
	projectContext, err := decodeProjectContext([]byte(projectJSON.String))
	if err != nil {
		return projects.ProjectContext{}, err
	}
	skuContext, err := decodeProjectContext([]byte(skuJSON.String))
	if err != nil {
		return projects.ProjectContext{}, err
	}
	return projects.ProjectContext{
		ProjectID: projectID, ProjectName: name,
		ProjectContext: projectContext, SKUContext: skuContext,
	}, nil
}

func (s *ProjectStore) PatchProjectContext(
	ctx context.Context,
	projectID int64,
	projectPatch map[string]any,
	skuPatch map[string]any,
	_ string,
) (projects.ProjectContext, error) {
	var result projects.ProjectContext
	err := s.inTx(ctx, func(db DB) error {
		current, err := getProjectContext(ctx, db, projectID)
		if err != nil {
			return err
		}
		if projectPatch != nil {
			current.ProjectContext = mergeProjectContext(current.ProjectContext, projectPatch)
		}
		if skuPatch != nil {
			for key, value := range skuPatch {
				current.SKUContext[key] = value
			}
		}
		projectJSON, err := json.Marshal(current.ProjectContext)
		if err != nil {
			return err
		}
		skuJSON, err := json.Marshal(current.SKUContext)
		if err != nil {
			return err
		}
		var ignored string
		err = db.QueryRow(
			ctx,
			`update public.projects
			 set project_context = $2::json, sku_context = $3::json
			 where id = $1
			 returning project_name`,
			projectID, projectJSON, skuJSON,
		).Scan(&ignored)
		if err != nil {
			return err
		}
		current.ProjectName = ignored
		result = current
		return nil
	})
	return result, err
}

func (s *ProjectStore) inTx(ctx context.Context, fn func(DB) error) error {
	if s.db == nil {
		return errors.New("project database is nil")
	}
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		return fn(NewTxDB(tx))
	})
}

type projectScanner interface {
	Scan(dest ...any) error
}

func scanProjectItem(scanner projectScanner) (projects.ProjectItem, error) {
	var (
		item            projects.ProjectItem
		brandName       pgtype.Text
		storeAddress    pgtype.Text
		projectOperator pgtype.Text
		assistant       pgtype.Text
		commissionBasis pgtype.Text
		commissionRate  pgtype.Numeric
		sourceFile      pgtype.Text
		projectContext  pgtype.Text
		skuContext      pgtype.Text
		projectTier     pgtype.Text
	)
	err := scanner.Scan(
		&item.ID,
		&item.Name,
		&brandName,
		&storeAddress,
		&projectOperator,
		&assistant,
		&commissionBasis,
		&commissionRate,
		&item.SortOrder,
		&item.IsActive,
		&sourceFile,
		&projectContext,
		&skuContext,
		&projectTier,
		&item.Country,
		&item.VATEnabled,
	)
	if err != nil {
		return projects.ProjectItem{}, err
	}
	item.BrandName = Text(brandName)
	item.StoreAddress = Text(storeAddress)
	item.ProjectOperator = Text(projectOperator)
	item.AssistantOperator = Text(assistant)
	item.CommissionBasis = Text(commissionBasis)
	item.SourceFile = Text(sourceFile)
	item.ProjectTier = Text(projectTier)
	if commissionRate.Valid {
		value, err := commissionRate.Float64Value()
		if err != nil {
			return projects.ProjectItem{}, err
		}
		if value.Valid {
			item.CommissionRate = &value.Float64
		}
	}
	if item.Country == "" {
		item.Country = "US"
	}
	item.CountryName = projects.CountryName(item.Country)
	item.HasContext = jsonObjectHasValues(projectContext.String) || jsonObjectHasValues(skuContext.String)
	return item, nil
}

func scanProjectShop(scanner projectScanner) (projects.ProjectShopItem, error) {
	var (
		item           projects.ProjectShopItem
		shopName       pgtype.Text
		expectedAlias  pgtype.Text
		aliasesJSON    pgtype.Text
		identitySource pgtype.Text
	)
	if err := scanner.Scan(
		&item.ID,
		&item.Country,
		&item.ShopID,
		&shopName,
		&expectedAlias,
		&aliasesJSON,
		&identitySource,
		&item.SellerIdentityRequired,
	); err != nil {
		return projects.ProjectShopItem{}, err
	}
	item.ShopName = Text(shopName)
	item.SellerIdentityExpectedAlias = Text(expectedAlias)
	item.SellerIdentitySource = Text(identitySource)
	item.SellerIdentityAliases = []string{}
	if aliasesJSON.Valid && strings.TrimSpace(aliasesJSON.String) != "" {
		if err := json.Unmarshal([]byte(aliasesJSON.String), &item.SellerIdentityAliases); err != nil {
			return projects.ProjectShopItem{}, err
		}
	}
	if item.SellerIdentityAliases == nil {
		item.SellerIdentityAliases = []string{}
	}
	return item, nil
}

func getProjectShop(ctx context.Context, db DB, projectID int64, country string) (*projects.ProjectShopItem, error) {
	item, err := scanProjectShop(db.QueryRow(
		ctx,
		`select id, country, shop_id, shop_name, seller_identity_expected_alias,
		        seller_identity_aliases::text, seller_identity_source,
		        seller_identity_required
		 from public.project_shops where project_id = $1 and country = $2`,
		projectID, country,
	))
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func getProjectContext(ctx context.Context, db DB, projectID int64) (projects.ProjectContext, error) {
	var result projects.ProjectContext
	var projectJSON, skuJSON pgtype.Text
	err := db.QueryRow(
		ctx,
		`select project_name, project_context::text, sku_context::text
		 from public.projects where id = $1 for update`,
		projectID,
	).Scan(&result.ProjectName, &projectJSON, &skuJSON)
	if err == pgx.ErrNoRows {
		return projects.ProjectContext{}, projects.ErrNotFound
	}
	if err != nil {
		return projects.ProjectContext{}, err
	}
	result.ProjectID = projectID
	result.ProjectContext, err = decodeProjectContext([]byte(projectJSON.String))
	if err != nil {
		return projects.ProjectContext{}, err
	}
	result.SKUContext, err = decodeProjectContext([]byte(skuJSON.String))
	return result, err
}

func decodeProjectContext(raw []byte) (map[string]any, error) {
	result := map[string]any{}
	if len(strings.TrimSpace(string(raw))) == 0 || string(raw) == "null" {
		return result, nil
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	if result == nil {
		result = map[string]any{}
	}
	return result, nil
}

func mergeProjectContext(base, patch map[string]any) map[string]any {
	result := make(map[string]any, len(base)+len(patch))
	for key, value := range base {
		result[key] = value
	}
	for key, value := range patch {
		patchMap, patchOK := value.(map[string]any)
		baseMap, baseOK := result[key].(map[string]any)
		if patchOK && baseOK {
			result[key] = mergeProjectContext(baseMap, patchMap)
		} else {
			result[key] = value
		}
	}
	return result
}

func chooseOptionalString(
	input projects.OptionalString,
	existing *projects.ProjectShopItem,
	getter func(*projects.ProjectShopItem) *string,
) *string {
	if input.Present {
		return normalizeProjectText(input.Value)
	}
	if existing == nil {
		return nil
	}
	return getter(existing)
}

func normalizeProjectText(value *string) *string {
	if value == nil {
		return nil
	}
	normalized := strings.TrimSpace(*value)
	if normalized == "" {
		return nil
	}
	return &normalized
}

func normalizeProjectOperators(value *string) *string {
	if value == nil {
		return nil
	}
	parts := strings.FieldsFunc(*value, func(r rune) bool {
		switch r {
		case '、', ',', '，', ';', '\n':
			return true
		default:
			return false
		}
	})
	unique := make([]string, 0, len(parts))
	seen := make(map[string]bool, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" || seen[part] {
			continue
		}
		seen[part] = true
		unique = append(unique, part)
	}
	if len(unique) == 0 {
		return nil
	}
	joined := strings.Join(unique, "、")
	return &joined
}

func normalizeCommissionRate(value *float64) *float64 {
	if value == nil {
		return nil
	}
	normalized := *value
	if normalized > 1 {
		normalized /= 100
	}
	return &normalized
}

func normalizeProjectTier(value *string) *string {
	if value == nil {
		return nil
	}
	normalized := strings.ToUpper(strings.TrimSpace(*value))
	if normalized == "" {
		return nil
	}
	return &normalized
}

func mapProjectConstraintError(err error) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return projects.ErrConflict
	}
	return err
}

func mapShopConstraintError(err error) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return projects.NewAPIError(http.StatusConflict, "shop_id/shop_name is already mapped to another project")
	}
	return err
}

func jsonObjectHasValues(raw string) bool {
	values, err := decodeProjectContext([]byte(raw))
	return err == nil && len(values) > 0
}

func int64Pointer(value int64) *int64 { return &value }
