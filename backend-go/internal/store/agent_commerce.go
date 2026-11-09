package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_commerce"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

const agentCommerceSKUSelectColumns = `
	id, project_id, project_name, sku, asin, fnsku, product_name, father_id,
	fob_unit_cost, first_leg_cost_rmb, package_length_cm, package_width_cm, package_height_cm, weight_kg,
	carton_length_cm, carton_width_cm, carton_height_cm, carton_weight_kg, units_per_carton,
	currency, country, sort_order, coalesce(is_active, true),
	sku_factory_info::text, sku_factory_info_updated_at, sku_factory_info_updated_by,
	fnsku_label_r2_key, fnsku_label_r2_url,
	product_image_r2_key, product_image_r2_url, product_image_thumbnail_r2_key, product_image_thumbnail_r2_url,
	product_image_uploaded_at, product_image_uploaded_by,
	listing_title, listing_bullet_1, listing_bullet_2, listing_bullet_3, listing_bullet_4, listing_bullet_5,
	listing_description, listing_selling_points, listing_copy_updated_at, listing_copy_updated_by,
	created_at, updated_at
`

type AgentCommerceStore struct {
	db      FullDB
	auditor audit.Service
}

var _ agent_commerce.Store = (*AgentCommerceStore)(nil)

func NewAgentCommerceStore(db FullDB, auditor audit.Service) *AgentCommerceStore {
	return &AgentCommerceStore{db: db, auditor: auditor}
}

func (s *AgentCommerceStore) VerifyProject(
	ctx context.Context,
	projectID int64,
) (*agent_commerce.ProjectInfo, error) {
	if s == nil || s.db == nil {
		return nil, agent_commerce.ErrServiceUnavailable
	}
	return verifyAgentCommerceProject(ctx, s.db, projectID)
}

func verifyAgentCommerceProject(
	ctx context.Context,
	db FullDB,
	projectID int64,
) (*agent_commerce.ProjectInfo, error) {
	var project agent_commerce.ProjectInfo
	err := db.QueryRow(
		ctx,
		`select id, project_name from public.projects where id = $1`,
		projectID,
	).Scan(&project.ID, &project.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, agent_commerce.ErrProjectNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("verify agent commerce project: %w", err)
	}
	return &project, nil
}

func (s *AgentCommerceStore) RecordAudit(
	ctx context.Context,
	entry agent_commerce.AuditEntry,
) error {
	if s == nil || s.db == nil {
		return agent_commerce.ErrServiceUnavailable
	}
	if s.auditor == nil {
		return agent_commerce.ErrServiceUnavailable
	}
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		return s.auditor.LogActionTx(ctx, tx, toAgentCommerceAuditEntry(entry))
	})
}

func (s *AgentCommerceStore) writeAudit(
	ctx context.Context,
	tx pgx.Tx,
	entry agent_commerce.AuditEntry,
) error {
	if s.auditor == nil {
		return agent_commerce.ErrServiceUnavailable
	}
	if err := s.auditor.LogActionTx(ctx, tx, toAgentCommerceAuditEntry(entry)); err != nil {
		return fmt.Errorf("write agent commerce audit: %w", err)
	}
	return nil
}

func toAgentCommerceAuditEntry(entry agent_commerce.AuditEntry) audit.Entry {
	return audit.Entry{
		Action:         entry.Action,
		TargetType:     entry.TargetType,
		TargetID:       entry.TargetID,
		Operator:       entry.Operator,
		Result:         entry.Result,
		TraceID:        entry.TraceID,
		RequestMethod:  entry.RequestMethod,
		RequestPath:    entry.RequestPath,
		IPAddress:      entry.IPAddress,
		UserAgent:      entry.UserAgent,
		BeforeJSON:     entry.BeforeJSON,
		AfterJSON:      entry.AfterJSON,
		AgentID:        entry.AgentID,
		AgentName:      entry.AgentName,
		IdempotencyKey: entry.IdempotencyKey,
		ErrorMessage:   entry.ErrorMessage,
	}
}

func scanAgentCommerceSKURecord(row pgx.Row) (*agent_commerce.SKURecord, error) {
	var item agent_commerce.SKURecord
	var factoryInfoJSON *string
	var factoryUpdatedAt, imageUploadedAt, listingUpdatedAt *time.Time
	var fnskuLabelKey, productImageKey, productImageThumbKey *string
	var createdAt, updatedAt time.Time
	err := row.Scan(
		&item.ID, &item.ProjectID, &item.ProjectName, &item.SKU, &item.ASIN,
		&item.FNSKU, &item.ProductName, &item.FatherID,
		&item.FOBUnitCost, &item.FirstLegCostRMB,
		&item.PackageLengthCM, &item.PackageWidthCM, &item.PackageHeightCM, &item.WeightKG,
		&item.CartonLengthCM, &item.CartonWidthCM, &item.CartonHeightCM,
		&item.CartonWeightKG, &item.UnitsPerCarton,
		&item.Currency, &item.Country, &item.SortOrder, &item.IsActive,
		&factoryInfoJSON, &factoryUpdatedAt, &item.SKUFactoryInfoUpdatedBy,
		&fnskuLabelKey, &item.FNSKULabelR2URL,
		&productImageKey, &item.ProductImageR2URL,
		&productImageThumbKey, &item.ProductImageThumbnailR2URL,
		&imageUploadedAt, &item.ProductImageUploadedBy,
		&item.ListingTitle, &item.ListingBullet1, &item.ListingBullet2,
		&item.ListingBullet3, &item.ListingBullet4, &item.ListingBullet5,
		&item.ListingDescription, &item.ListingSellingPoints,
		&listingUpdatedAt, &item.ListingCopyUpdatedBy,
		&createdAt, &updatedAt,
	)
	if err != nil {
		return nil, err
	}
	if factoryInfoJSON != nil && strings.TrimSpace(*factoryInfoJSON) != "" {
		_ = json.Unmarshal([]byte(*factoryInfoJSON), &item.SKUFactoryInfo)
	}
	if factoryUpdatedAt != nil {
		value := factoryUpdatedAt.UTC().Format(time.RFC3339Nano)
		item.SKUFactoryInfoUpdatedAt = &value
	}
	if imageUploadedAt != nil {
		value := imageUploadedAt.UTC().Format(time.RFC3339Nano)
		item.ProductImageUploadedAt = &value
	}
	if listingUpdatedAt != nil {
		value := listingUpdatedAt.UTC().Format(time.RFC3339Nano)
		item.ListingCopyUpdatedAt = &value
	}
	item.MarketplaceURL = buildAgentCommerceMarketplaceURL(item.Country, item.ASIN)
	item.FNSKULabelR2Key = fnskuLabelKey
	item.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	item.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	_ = productImageKey
	_ = productImageThumbKey
	return &item, nil
}

func buildAgentCommerceMarketplaceURL(country, asin string) *string {
	country = strings.ToUpper(strings.TrimSpace(country))
	asin = strings.TrimSpace(asin)
	if asin == "" {
		return nil
	}
	var domain string
	switch country {
	case "US":
		domain = "amazon.com"
	case "DE":
		domain = "amazon.de"
	case "UK", "GB":
		domain = "amazon.co.uk"
	case "JP":
		domain = "amazon.co.jp"
	case "FR":
		domain = "amazon.fr"
	case "IT":
		domain = "amazon.it"
	case "ES":
		domain = "amazon.es"
	case "CA":
		domain = "amazon.ca"
	case "MX":
		domain = "amazon.com.mx"
	case "AU":
		domain = "amazon.com.au"
	default:
		return nil
	}
	value := fmt.Sprintf("https://www.%s/dp/%s", domain, asin)
	return &value
}

func getAgentCommerceSKUByID(
	ctx context.Context,
	db FullDB,
	projectID, recordID int64,
	forUpdate bool,
) (*agent_commerce.SKURecord, error) {
	query := `select ` + agentCommerceSKUSelectColumns + `
		from public.product_costs
		where id = $1 and project_id = $2`
	if forUpdate {
		query += ` for update`
	}
	item, err := scanAgentCommerceSKURecord(db.QueryRow(ctx, query, recordID, projectID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, agent_commerce.ErrSKUNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get agent commerce sku: %w", err)
	}
	return item, nil
}

func getAgentCommerceSKUByKey(
	ctx context.Context,
	db FullDB,
	projectID int64,
	sku, asin, country string,
	forUpdate bool,
) (*agent_commerce.SKURecord, error) {
	query := `select ` + agentCommerceSKUSelectColumns + `
		from public.product_costs
		where project_id = $1 and sku = $2 and asin = $3 and country = $4
		limit 1`
	if forUpdate {
		query += ` for update`
	}
	item, err := scanAgentCommerceSKURecord(db.QueryRow(ctx, query, projectID, sku, asin, country))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get agent commerce sku by key: %w", err)
	}
	return item, nil
}

func listAgentCommerceSKUsByIDs(
	ctx context.Context,
	db FullDB,
	projectID int64,
	recordIDs []int64,
	forUpdate bool,
) (map[int64]*agent_commerce.SKURecord, error) {
	if len(recordIDs) == 0 {
		return map[int64]*agent_commerce.SKURecord{}, nil
	}
	query := `select ` + agentCommerceSKUSelectColumns + `
		from public.product_costs
		where project_id = $1 and id = any($2)`
	if forUpdate {
		query += ` for update`
	}
	rows, err := db.Query(ctx, query, projectID, recordIDs)
	if err != nil {
		return nil, fmt.Errorf("list agent commerce skus by ids: %w", err)
	}
	defer rows.Close()
	result := make(map[int64]*agent_commerce.SKURecord, len(recordIDs))
	for rows.Next() {
		item, err := scanAgentCommerceSKURecord(rows)
		if err != nil {
			return nil, err
		}
		result[item.ID] = item
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}
