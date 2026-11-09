package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_commerce"
)

func (s *AgentCommerceStore) ResolveShipment(
	ctx context.Context,
	projectID int64,
	shipmentNo string,
) (*agent_commerce.ShipmentDetail, error) {
	if s == nil || s.db == nil {
		return nil, agent_commerce.ErrServiceUnavailable
	}
	shipmentNo = strings.TrimSpace(shipmentNo)
	if shipmentNo == "" {
		return nil, agent_commerce.ErrShipmentNotFound
	}
	var id int64
	err := s.db.QueryRow(
		ctx,
		`select id
		   from public.shipment_schedules
		  where project_id = $1 and shipment_no = $2
		  order by id desc
		  limit 1`,
		projectID,
		shipmentNo,
	).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, agent_commerce.ErrShipmentNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("resolve agent commerce shipment: %w", err)
	}
	detail, err := NewShipmentScheduleStore(s.db).GetShipmentSchedule(ctx, id)
	if err != nil {
		return nil, err
	}
	if detail == nil || detail.ProjectID != projectID {
		return nil, agent_commerce.ErrShipmentNotFound
	}
	items := make([]agent_commerce.ShipmentItemRow, 0, len(detail.Items))
	for _, item := range detail.Items {
		items = append(items, agent_commerce.ShipmentItemRow{
			SKU:         item.SKU,
			Quantity:    item.Quantity,
			CartonCount: item.CartonCount,
		})
	}
	return &agent_commerce.ShipmentDetail{
		ID:          detail.ID,
		ProjectID:   detail.ProjectID,
		ProjectName: detail.ProjectName,
		Country:     detail.Country,
		ShipmentNo:  detail.ShipmentNo,
		Items:       items,
	}, nil
}

func (s *AgentCommerceStore) ListFBABoxDetails(
	ctx context.Context,
	projectID int64,
	shipmentNos []string,
) (agent_commerce.FBABoxData, error) {
	if s == nil || s.db == nil {
		return agent_commerce.FBABoxData{}, agent_commerce.ErrServiceUnavailable
	}
	var count int
	if err := s.db.QueryRow(
		ctx,
		`select count(*)
		   from public.shipment_schedule_items i
		   join public.shipment_schedules s on s.id = i.shipment_schedule_id
		  where s.project_id = $1 and s.shipment_no = any($2)`,
		projectID,
		shipmentNos,
	).Scan(&count); err != nil {
		return agent_commerce.FBABoxData{}, err
	}
	if count > maxAgentCommerceExportRows {
		return agent_commerce.FBABoxData{}, agent_commerce.ErrExportTooLarge
	}
	response, err := NewShipmentScheduleStore(s.db).ListFbaBoxDetails(
		ctx,
		[]int64{projectID},
		nil,
		shipmentNos,
	)
	if err != nil {
		return agent_commerce.FBABoxData{}, err
	}
	items := make([]agent_commerce.FBABoxItem, 0, len(response.Items))
	for _, item := range response.Items {
		items = append(items, agent_commerce.FBABoxItem{
			ProjectID:                  item.ProjectID,
			ProjectName:                item.ProjectName,
			Country:                    item.Country,
			ShipmentNo:                 item.ShipmentNo,
			WarehouseCode:              item.WarehouseCode,
			SKU:                        item.SKU,
			ProductName:                item.ProductName,
			ASIN:                       item.ASIN,
			FNSKU:                      item.FNSKU,
			PackageLengthCM:            item.PackageLengthCM,
			PackageWidthCM:             item.PackageWidthCM,
			PackageHeightCM:            item.PackageHeightCM,
			WeightKG:                   item.WeightKG,
			LengthCM:                   item.LengthCM,
			WidthCM:                    item.WidthCM,
			HeightCM:                   item.HeightCM,
			CartonWeightKG:             item.CartonWeightKG,
			Quantity:                   item.Quantity,
			UnitsPerCarton:             item.UnitsPerCarton,
			CartonCount:                item.CartonCount,
			FullCartonCount:            item.FullCartonCount,
			PartialCartonUnits:         item.PartialCartonUnits,
			OuterBoxText:               item.OuterBoxText,
			TotalWeightKG:              item.TotalWeightKG,
			TotalVolumeM3:              item.TotalVolumeM3,
			FBALabelPrefix:             item.FBALabelPrefix,
			TrackingNo:                 item.TrackingNo,
			ProductImageThumbnailR2URL: item.ProductImageThumbnailR2URL,
			ProductImageR2URL:          item.ProductImageR2URL,
		})
	}
	if err := s.attachFBABoxImageKeys(ctx, projectID, items); err != nil {
		return agent_commerce.FBABoxData{}, err
	}
	return agent_commerce.FBABoxData{Items: items}, nil
}

func (s *AgentCommerceStore) attachFBABoxImageKeys(
	ctx context.Context,
	projectID int64,
	items []agent_commerce.FBABoxItem,
) error {
	if len(items) == 0 {
		return nil
	}
	skuSet := make(map[string]bool, len(items))
	skus := make([]string, 0, len(items))
	for _, item := range items {
		if strings.TrimSpace(item.SKU) == "" || skuSet[item.SKU] {
			continue
		}
		skuSet[item.SKU] = true
		skus = append(skus, item.SKU)
	}
	if len(skus) == 0 {
		return nil
	}
	rows, err := s.db.Query(
		ctx,
		`select project_id, upper(country), sku,
		        product_image_thumbnail_r2_key, product_image_r2_key
		   from public.product_costs
		  where project_id = $1 and sku = any($2)`,
		projectID,
		skus,
	)
	if err != nil {
		return fmt.Errorf("load FBA product image keys: %w", err)
	}
	defer rows.Close()
	type productKey struct {
		projectID int64
		country   string
		sku       string
	}
	type imageKeys struct {
		thumbnail *string
		original  *string
	}
	keys := make(map[productKey]imageKeys, len(skus))
	for rows.Next() {
		var key productKey
		var thumbnail, original *string
		if err := rows.Scan(&key.projectID, &key.country, &key.sku, &thumbnail, &original); err != nil {
			return err
		}
		keys[key] = imageKeys{thumbnail: thumbnail, original: original}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for index := range items {
		key := productKey{
			projectID: items[index].ProjectID,
			country:   strings.ToUpper(strings.TrimSpace(items[index].Country)),
			sku:       items[index].SKU,
		}
		imageKeys := keys[key]
		items[index].ProductImageThumbnailR2Key = imageKeys.thumbnail
		items[index].ProductImageR2Key = imageKeys.original
	}
	return nil
}

func (s *AgentCommerceStore) PrepareShipmentTemplate(
	ctx context.Context,
	projectID int64,
	shipmentNo string,
) (*agent_commerce.ShipmentTemplateData, error) {
	if s == nil || s.db == nil {
		return nil, agent_commerce.ErrServiceUnavailable
	}
	detail, err := s.ResolveShipment(ctx, projectID, shipmentNo)
	if err != nil {
		return nil, err
	}
	if len(detail.Items) > maxAgentCommerceExportRows {
		return nil, agent_commerce.ErrExportTooLarge
	}
	skus := make([]string, 0, len(detail.Items))
	for _, item := range detail.Items {
		skus = append(skus, item.SKU)
	}
	cartons := make(map[string]agent_commerce.CartonInfo, len(skus))
	if len(skus) > 0 {
		rows, err := s.db.Query(
			ctx,
			`select sku, coalesce(units_per_carton, 0),
			        carton_length_cm, carton_width_cm, carton_height_cm, carton_weight_kg
			   from public.product_costs
			  where project_id = $1 and upper(country) = upper($2) and sku = any($3)
			  order by sort_order asc, id asc`,
			projectID,
			detail.Country,
			skus,
		)
		if err != nil {
			return nil, fmt.Errorf("load shipment template carton data: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var sku string
			var info agent_commerce.CartonInfo
			var length, width, height, weight *float64
			if err := rows.Scan(
				&sku,
				&info.UnitsPerCarton,
				&length,
				&width,
				&height,
				&weight,
			); err != nil {
				return nil, err
			}
			info.CartonLengthCM = floatPointerValue(length)
			info.CartonWidthCM = floatPointerValue(width)
			info.CartonHeightCM = floatPointerValue(height)
			info.CartonWeightKG = floatPointerValue(weight)
			cartons[sku] = info
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return &agent_commerce.ShipmentTemplateData{
		Detail:  detail,
		Cartons: cartons,
	}, nil
}

func floatPointerValue(value *float64) float64 {
	if value == nil {
		return 0
	}
	return *value
}
