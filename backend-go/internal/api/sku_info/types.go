package sku_info

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
)

var (
	ErrProjectNotFound = errors.New("项目不存在")
	ErrSkuNotFound     = errors.New("SKU 记录不存在")
)

type SkuRecordItem struct {
	ID                         int64             `json:"id"`
	ProjectID                  int64             `json:"-"`
	ProjectName                string            `json:"project_name"`
	SKU                        string            `json:"sku"`
	ASIN                       string            `json:"asin"`
	FNSKU                      *string           `json:"fnsku"`
	ProductName                *string           `json:"product_name"`
	FatherID                   *string           `json:"father_id"`
	FOBUnitCost                float64           `json:"fob_unit_cost"`
	FirstLegCostRMB            float64           `json:"first_leg_cost_rmb"`
	PackageLengthCM            float64           `json:"package_length_cm"`
	PackageWidthCM             float64           `json:"package_width_cm"`
	PackageHeightCM            float64           `json:"package_height_cm"`
	WeightKG                   float64           `json:"weight_kg"`
	CartonLengthCM             float64           `json:"carton_length_cm"`
	CartonWidthCM              float64           `json:"carton_width_cm"`
	CartonHeightCM             float64           `json:"carton_height_cm"`
	CartonWeightKG             float64           `json:"carton_weight_kg"`
	UnitsPerCarton             int               `json:"units_per_carton"`
	Currency                   string            `json:"currency"`
	Country                    string            `json:"country"`
	SortOrder                  int               `json:"sort_order"`
	IsActive                   bool              `json:"is_active"`
	SkuFactoryInfo             map[string]string `json:"sku_factory_info"`
	SkuFactoryInfoUpdatedAt    *string           `json:"sku_factory_info_updated_at"`
	SkuFactoryInfoUpdatedBy    *string           `json:"sku_factory_info_updated_by"`
	FnskuLabelR2Key            *string           `json:"fnsku_label_r2_key"`
	FnskuLabelR2URL            *string           `json:"fnsku_label_r2_url"`
	ProductImageR2Key          *string           `json:"product_image_r2_key"`
	ProductImageR2URL          *string           `json:"product_image_r2_url"`
	ProductImageThumbnailR2Key *string           `json:"product_image_thumbnail_r2_key"`
	ProductImageThumbnailR2URL *string           `json:"product_image_thumbnail_r2_url"`
	ProductImageUploadedAt     *string           `json:"product_image_uploaded_at"`
	ProductImageUploadedBy     *string           `json:"product_image_uploaded_by"`
	ListingTitle               *string           `json:"listing_title"`
	ListingBullet1             *string           `json:"listing_bullet_1"`
	ListingBullet2             *string           `json:"listing_bullet_2"`
	ListingBullet3             *string           `json:"listing_bullet_3"`
	ListingBullet4             *string           `json:"listing_bullet_4"`
	ListingBullet5             *string           `json:"listing_bullet_5"`
	ListingDescription         *string           `json:"listing_description"`
	ListingSellingPoints       *string           `json:"listing_selling_points"`
	ListingCopyUpdatedAt       *string           `json:"listing_copy_updated_at"`
	ListingCopyUpdatedBy       *string           `json:"listing_copy_updated_by"`
	MarketplaceURL             *string           `json:"marketplace_url"`
}

type SkuRecordsPage struct {
	Items    []SkuRecordItem `json:"items"`
	Page     int             `json:"page"`
	PageSize int             `json:"page_size"`
	Total    *int            `json:"total"`
	HasNext  bool            `json:"has_next"`
}

type SkuRecordCreate struct {
	ProjectName          string            `json:"project_name"`
	SKU                  string            `json:"sku"`
	ASIN                 string            `json:"asin"`
	FNSKU                *string           `json:"fnsku"`
	ProductName          *string           `json:"product_name"`
	FatherID             *string           `json:"father_id"`
	FOBUnitCost          *float64          `json:"fob_unit_cost"`
	FirstLegCostRMB      *float64          `json:"first_leg_cost_rmb"`
	PackageLengthCM      *float64          `json:"package_length_cm"`
	PackageWidthCM       *float64          `json:"package_width_cm"`
	PackageHeightCM      *float64          `json:"package_height_cm"`
	WeightKG             *float64          `json:"weight_kg"`
	CartonLengthCM       *float64          `json:"carton_length_cm"`
	CartonWidthCM        *float64          `json:"carton_width_cm"`
	CartonHeightCM       *float64          `json:"carton_height_cm"`
	CartonWeightKG       *float64          `json:"carton_weight_kg"`
	UnitsPerCarton       *int              `json:"units_per_carton"`
	Currency             string            `json:"currency"`
	Country              string            `json:"country"`
	SortOrder            *int              `json:"sort_order"`
	IsActive             bool              `json:"is_active"`
	SourceFile           *string           `json:"source_file"`
	SkuFactoryInfo       map[string]string `json:"sku_factory_info"`
	ListingTitle         *string           `json:"listing_title"`
	ListingBullet1       *string           `json:"listing_bullet_1"`
	ListingBullet2       *string           `json:"listing_bullet_2"`
	ListingBullet3       *string           `json:"listing_bullet_3"`
	ListingBullet4       *string           `json:"listing_bullet_4"`
	ListingBullet5       *string           `json:"listing_bullet_5"`
	ListingDescription   *string           `json:"listing_description"`
	ListingSellingPoints *string           `json:"listing_selling_points"`
}

type SkuRecordUpdate struct {
	SKU                  *string           `json:"sku"`
	ASIN                 *string           `json:"asin"`
	FNSKU                *string           `json:"fnsku"`
	ProductName          *string           `json:"product_name"`
	FatherID             *string           `json:"father_id"`
	FOBUnitCost          *float64          `json:"fob_unit_cost"`
	FirstLegCostRMB      *float64          `json:"first_leg_cost_rmb"`
	PackageLengthCM      *float64          `json:"package_length_cm"`
	PackageWidthCM       *float64          `json:"package_width_cm"`
	PackageHeightCM      *float64          `json:"package_height_cm"`
	WeightKG             *float64          `json:"weight_kg"`
	CartonLengthCM       *float64          `json:"carton_length_cm"`
	CartonWidthCM        *float64          `json:"carton_width_cm"`
	CartonHeightCM       *float64          `json:"carton_height_cm"`
	CartonWeightKG       *float64          `json:"carton_weight_kg"`
	UnitsPerCarton       *int              `json:"units_per_carton"`
	Currency             *string           `json:"currency"`
	Country              *string           `json:"country"`
	SortOrder            *int              `json:"sort_order"`
	IsActive             *bool             `json:"is_active"`
	SourceFile           *string           `json:"source_file"`
	SkuFactoryInfo       map[string]string `json:"sku_factory_info"`
	ListingTitle         *string           `json:"listing_title"`
	ListingBullet1       *string           `json:"listing_bullet_1"`
	ListingBullet2       *string           `json:"listing_bullet_2"`
	ListingBullet3       *string           `json:"listing_bullet_3"`
	ListingBullet4       *string           `json:"listing_bullet_4"`
	ListingBullet5       *string           `json:"listing_bullet_5"`
	ListingDescription   *string           `json:"listing_description"`
	ListingSellingPoints *string           `json:"listing_selling_points"`
}

type SkuRecordSortMove struct {
	Direction string `json:"direction"` // "up" or "down"
}

type SkuRecordBulkCreate struct {
	Items      []SkuRecordCreate `json:"items"`
	SourceFile *string           `json:"source_file"`
}

type SkuRecordImportResponse struct {
	Inserted int `json:"inserted"`
	Updated  int `json:"updated"`
	Total    int `json:"total"`
	Skipped  int `json:"skipped"`
}

type SkuRecordUpsertResponse struct {
	Item   SkuRecordItem `json:"item"`
	Action string        `json:"action"` // "created" or "updated"
}

type SkuRecordBulkUpsertResponse struct {
	Inserted int `json:"inserted"`
	Updated  int `json:"updated"`
	Total    int `json:"total"`
}

type SkuRecordFirstLegRecalculateRequest struct {
	ProjectName       string  `json:"project_name"`
	UnitPricePerKgRMB float64 `json:"unit_price_per_kg_rmb"`
	SKU               *string `json:"sku"`
	ASIN              *string `json:"asin"`
	Country           *string `json:"country"`
	IsActive          *bool   `json:"is_active"`
}

type SkuRecordFirstLegRecalculateResponse struct {
	Updated           int     `json:"updated"`
	UnitPricePerKgRMB float64 `json:"unit_price_per_kg_rmb"`
}

type BatchUpdateFactoryInfoRequest struct {
	SKUIDs         []int64           `json:"sku_ids"`
	SkuFactoryInfo map[string]string `json:"sku_factory_info"`
}

type BatchUpdateFactoryInfoResponse struct {
	Updated int     `json:"updated"`
	SKUIDs  []int64 `json:"sku_ids"`
}

type BatchUpdateListingCopyItem struct {
	ID                   int64   `json:"id"`
	ListingTitle         *string `json:"listing_title"`
	ListingBullet1       *string `json:"listing_bullet_1"`
	ListingBullet2       *string `json:"listing_bullet_2"`
	ListingBullet3       *string `json:"listing_bullet_3"`
	ListingBullet4       *string `json:"listing_bullet_4"`
	ListingBullet5       *string `json:"listing_bullet_5"`
	ListingDescription   *string `json:"listing_description"`
	ListingSellingPoints *string `json:"listing_selling_points"`
}

type BatchUpdateListingCopyRequest struct {
	Items []BatchUpdateListingCopyItem `json:"items"`
}

type BatchUpdateListingCopyResponse struct {
	Updated    int     `json:"updated"`
	Skipped    int     `json:"skipped"`
	UpdatedIDs []int64 `json:"updated_ids"`
}

type GetFnskuLabelsBySkusRequest struct {
	ProjectName string   `json:"project_name"`
	SKUs        []string `json:"skus"`
}

type SkuRecordFnskuLabelItem struct {
	ID              int64   `json:"id"`
	SKU             string  `json:"sku"`
	FnskuLabelR2Key *string `json:"fnsku_label_r2_key"`
}

type FnskuLabelsResponse struct {
	SkuRecords []SkuRecordFnskuLabelItem `json:"sku_records"`
}

type ParseFactoryInfoRequest struct {
	Description string `json:"description"`
}

type ParseFactoryInfoResponse struct {
	Result map[string]string `json:"result"`
	Raw    string            `json:"raw"`
}

type FnskuLabelUploadResponse struct {
	SkuRecordID              int64   `json:"sku_record_id"`
	FnskuLabelR2Key          string  `json:"fnsku_label_r2_key"`
	FnskuLabelR2URL          string  `json:"fnsku_label_r2_url"`
	FnskuVerified            bool    `json:"fnsku_verified"`
	FnskuFoundInPDF          *string `json:"fnsku_found_in_pdf"`
	FnskuVerificationMessage string  `json:"fnsku_verification_message"`
}

type BatchFnskuLabelDownloadRequest struct {
	SkuRecordIDs []int64 `json:"sku_record_ids"`
}

type SkuProductImageUploadResponse struct {
	SkuRecordID                int64  `json:"sku_record_id"`
	ProductImageR2Key          string `json:"product_image_r2_key"`
	ProductImageR2URL          string `json:"product_image_r2_url"`
	ProductImageThumbnailR2Key string `json:"product_image_thumbnail_r2_key"`
	ProductImageThumbnailR2URL string `json:"product_image_thumbnail_r2_url"`
	UploadedAt                 string `json:"uploaded_at"`
}

type SkuProductImageDeleteResponse struct {
	SkuRecordID int64 `json:"sku_record_id"`
	Deleted     bool  `json:"deleted"`
}

type SkuFilter struct {
	ProjectName  *string
	SKU          *string
	ASIN         *string
	Country      *string
	IsActive     *bool
	Page         int
	PageSize     int
	IncludeTotal bool
	Operator     string
	IsAdmin      bool
}

type ProjectReader interface {
	GetProject(ctx context.Context, id int64) (*projects.ProjectItem, error)
	GetProjectByName(ctx context.Context, name string) (*projects.ProjectItem, error)
	ListManage(ctx context.Context, operator string, isAdmin bool, isLeader bool) ([]projects.ProjectItem, error)
}

type Store interface {
	ListSkuRecords(ctx context.Context, filter SkuFilter) (SkuRecordsPage, error)
	GetSkuRecord(ctx context.Context, id int64) (*SkuRecordItem, error)
	GetProjectIDsBySkuIDs(ctx context.Context, ids []int64) (map[int64]int64, error)
	CreateOrUpdateSkuRecord(ctx context.Context, create SkuRecordCreate, operator string) (SkuRecordItem, string, error)
	BulkCreateOrUpdateSkuRecords(ctx context.Context, bulk SkuRecordBulkCreate, operator string) (SkuRecordBulkUpsertResponse, error)
	UpdateSkuRecord(ctx context.Context, id int64, update SkuRecordUpdate, operator string) (*SkuRecordItem, error)
	DeleteSkuRecord(ctx context.Context, id int64) (bool, error)
	MoveSkuRecord(ctx context.Context, id int64, direction string) (*SkuRecordItem, error)
	RecalculateFirstLegCosts(ctx context.Context, req SkuRecordFirstLegRecalculateRequest) (int, error)
	SyncFirstLegFromShipment(ctx context.Context, projectName, country string) (int, error)
	BatchUpdateFactoryInfo(ctx context.Context, req BatchUpdateFactoryInfoRequest, operator string) (int, []int64, error)
	BatchUpdateListingCopy(ctx context.Context, req BatchUpdateListingCopyRequest, operator string) (int, int, []int64, error)
	GetFnskuLabelsBySkus(ctx context.Context, projectName string, skus []string) ([]SkuRecordFnskuLabelItem, error)
	ExportCSV(ctx context.Context, filter SkuFilter) (string, []byte, error)
	ImportCSV(ctx context.Context, projectName string, data []byte, operator string) (SkuRecordImportResponse, error)
}

func BuildMarketplaceURL(country, asin string) *string {
	c := strings.ToUpper(strings.TrimSpace(country))
	a := strings.TrimSpace(asin)
	if a == "" {
		return nil
	}
	var domain string
	switch c {
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
	u := fmt.Sprintf("https://www.%s/dp/%s", domain, a)
	return &u
}
