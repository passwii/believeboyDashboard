package category_research

import (
	"context"
	"errors"
)

var (
	ErrDatasetNotFound = errors.New("Dataset not found")
	ErrAsinRequired    = errors.New("asin is required")
)

type CategoryResearchDatasetItem struct {
	ID                 int64          `json:"id"`
	Marketplace        string         `json:"marketplace"`
	CategoryKeywordEn  string         `json:"category_keyword_en"`
	CategoryNameZh     string         `json:"category_name_zh"`
	Version            int            `json:"version"`
	IsCurrent          bool           `json:"is_current"`
	SupersededAt       *string        `json:"superseded_at"`
	UploadFileID       string         `json:"upload_file_id"`
	UploadFilePath     string         `json:"upload_file_path"`
	OriginalFilename   *string        `json:"original_filename"`
	StoredFilename     string         `json:"stored_filename"`
	FileSizeBytes      *int64         `json:"file_size_bytes"`
	FileSHA256         *string        `json:"file_sha256"`
	IngestionStatus    string         `json:"ingestion_status"`
	IngestionError     *string        `json:"ingestion_error"`
	DataDate           *string        `json:"data_date"`
	DataYear           *int           `json:"data_year"`
	DataMonth          *int           `json:"data_month"`
	DataDay            *int           `json:"data_day"`
	RowCountProducts   int            `json:"row_count_products"`
	RowCountTrends     int            `json:"row_count_trends"`
	QualityWarnings    map[string]any `json:"quality_warnings"`
	CreatedBy          *string        `json:"created_by"`
	CreatedAt          *string        `json:"created_at"`
	UpdatedAt          *string        `json:"updated_at"`
}

type CategoryResearchImportResponse struct {
	DatasetID        int64          `json:"dataset_id"`
	Version          int            `json:"version"`
	IsCurrent        bool           `json:"is_current"`
	RowCountProducts int            `json:"row_count_products"`
	RowCountTrends   int            `json:"row_count_trends"`
	QualityWarnings  map[string]any `json:"quality_warnings"`
}

type CategoryResearchRecomputeResponse struct {
	DatasetID        int64          `json:"dataset_id"`
	RowCountProducts int            `json:"row_count_products"`
	RowCountTrends   int            `json:"row_count_trends"`
	QualityWarnings  map[string]any `json:"quality_warnings"`
}

type CategoryResearchBatchRecomputeResponse struct {
	Matched    int     `json:"matched"`
	Recomputed int     `json:"recomputed"`
	DatasetIDs []int64 `json:"dataset_ids"`
}

type CategoryResearchOverviewKpis struct {
	SampleCount            int     `json:"sample_count"`
	BrandCount             int     `json:"brand_count"`
	AveragePriceUsd        float64 `json:"average_price_usd"`
	TotalMonthlySales      int     `json:"total_monthly_sales"`
	TotalMonthlyRevenueUsd float64 `json:"total_monthly_revenue_usd"`
	AmazonShare            float64 `json:"amazon_share"`
}

type CategoryResearchBucketItem struct {
	Label string `json:"label"`
	Count int    `json:"count"`
}

type CategoryResearchBrandShareItem struct {
	Brand        string  `json:"brand"`
	MonthlySales int     `json:"monthly_sales"`
	Share        float64 `json:"share"`
}

type CategoryResearchQuantileBandItem struct {
	Label    string  `json:"label"`
	MinPrice float64 `json:"min_price"`
	MaxPrice float64 `json:"max_price"`
	Count    int     `json:"count"`
}

type CategoryResearchPriceStats struct {
	Mean   float64 `json:"mean"`
	Median float64 `json:"median"`
	P25    float64 `json:"p25"`
	P75    float64 `json:"p75"`
}

type CategoryResearchPriceSalesPoint struct {
	ASIN         *string `json:"asin"`
	PriceUsd     float64 `json:"price_usd"`
	MonthlySales int     `json:"monthly_sales"`
}

type CategoryResearchAdvancedMetrics struct {
	MarketConcentration map[string]any `json:"market_concentration"`
	BrandMonopoly       map[string]any `json:"brand_monopoly"`
	SellerMonopoly      map[string]any `json:"seller_monopoly"`
	ProductMonopoly     map[string]any `json:"product_monopoly"`
	ChinaSellerComp     map[string]any `json:"china_seller_competition"`
	MarketGrowth        map[string]any `json:"market_growth"`
	Seasonality         map[string]any `json:"seasonality"`
	ReviewResearch      map[string]any `json:"review_research"`
	PriceBandOpps       []any          `json:"price_band_opportunities"`
	NewProductOpp       map[string]any `json:"new_product_opportunity"`
	SupplyComplexity    map[string]any `json:"supply_complexity"`
	AsinMomentum        []any          `json:"asin_momentum"`
	DataQuality         map[string]any `json:"data_quality"`
	DimensionBlocks     []any          `json:"dimension_blocks"`
	MetricDefinitions   []any          `json:"metric_definitions"`
	ActionRecs          []any          `json:"action_recommendations"`
	Signals             []any          `json:"signals"`
	DimensionProfiles   []any          `json:"dimension_profiles"`
	PriceBandStandard   string         `json:"price_band_standard"`
}

type CategoryResearchOverviewResponse struct {
	Dataset                 CategoryResearchDatasetItem        `json:"dataset"`
	Kpis                    CategoryResearchOverviewKpis       `json:"kpis"`
	BrandSalesShare         []CategoryResearchBrandShareItem   `json:"brand_sales_share"`
	ListingAgeDistribution  []CategoryResearchBucketItem       `json:"listing_age_distribution"`
	LaunchMonthDistribution []CategoryResearchBucketItem       `json:"launch_month_distribution"`
	FulfillmentDistribution []CategoryResearchBucketItem       `json:"fulfillment_distribution"`
	FixedPriceBands         []CategoryResearchBucketItem       `json:"fixed_price_bands"`
	QuantilePriceBands      []CategoryResearchQuantileBandItem `json:"quantile_price_bands"`
	PriceStats              CategoryResearchPriceStats         `json:"price_stats"`
	PriceSalesCorrelation   float64                            `json:"price_sales_correlation"`
	FbaFeeDistribution      []CategoryResearchBucketItem       `json:"fba_fee_distribution"`
	PriceSalesPoints        []CategoryResearchPriceSalesPoint  `json:"price_sales_points"`
	AvailableAsins          []string                           `json:"available_asins"`
	AdvancedMetrics         CategoryResearchAdvancedMetrics    `json:"advanced_metrics"`
}

type CategoryResearchProductRow struct {
	ID                       int64             `json:"id"`
	SourceRowNo              int               `json:"source_row_no"`
	ASIN                     *string           `json:"asin"`
	ParentASIN               *string           `json:"parent_asin"`
	ProductName              *string           `json:"product_name"`
	Brand                    *string           `json:"brand"`
	Seller                   *string           `json:"seller"`
	PriceUsd                 *float64          `json:"price_usd"`
	MonthlySales             int               `json:"monthly_sales"`
	MonthlyRevenueUsd        *float64          `json:"monthly_revenue_usd"`
	Rating                   *float64          `json:"rating"`
	ReviewCount              int               `json:"review_count"`
	LaunchDate               *string           `json:"launch_date"`
	ListingAgeDays           *int              `json:"listing_age_days"`
	FbaFeeUsd                *float64          `json:"fba_fee_usd"`
	FulfillmentMethod        *string           `json:"fulfillment_method"`
	BbxSellerAttribute       *string           `json:"bbx_seller_attribute"`
	VariantCount             *int              `json:"variant_count"`
	HasMainImageVideo        *bool             `json:"has_main_image_video"`
	IsClimatePledgeFriendly  *bool             `json:"is_climate_pledge_friendly"`
	HasBrandStore            *bool             `json:"has_brand_store"`
	SellerCountryRegion      *string           `json:"seller_country_region"`
	IsAmazon                 bool              `json:"is_amazon"`
	IsNew90d                 bool              `json:"is_new_90d"`
	ExtractedDimensions      map[string]string `json:"extracted_dimensions"`
	ManualDimensions         map[string]string `json:"manual_dimensions"`
	EffectiveDimensions      map[string]string `json:"effective_dimensions"`
}

type CategoryResearchProductsResponse struct {
	DatasetID int64                        `json:"dataset_id"`
	Page      int                          `json:"page"`
	PageSize  int                          `json:"page_size"`
	HasNext   bool                         `json:"has_next"`
	Rows      []CategoryResearchProductRow `json:"rows"`
}

type CategoryResearchTrendPoint struct {
	YearMonth    string `json:"year_month"`
	MonthlySales int    `json:"monthly_sales"`
}

type CategoryResearchTrendResponse struct {
	DatasetID int64                        `json:"dataset_id"`
	ASIN      string                       `json:"asin"`
	Points    []CategoryResearchTrendPoint `json:"points"`
}

type CategoryResearchMarketTrendPoint struct {
	YearMonth    string `json:"year_month"`
	MonthlySales int    `json:"monthly_sales"`
}

type CategoryResearchMarketTrendResponse struct {
	DatasetID int64                              `json:"dataset_id"`
	Months    int                                `json:"months"`
	Points    []CategoryResearchMarketTrendPoint `json:"points"`
}

type CategoryResearchManualDimensionUpsertItem struct {
	ProductRowID int64   `json:"product_row_id"`
	Key          string  `json:"key"`
	Value        *string `json:"value"`
}

type CategoryResearchManualDimensionUpsertRequest struct {
	Items []CategoryResearchManualDimensionUpsertItem `json:"items"`
}

type CategoryResearchManualDimensionUpsertResponse struct {
	DatasetID    int64 `json:"dataset_id"`
	UpdatedCount int   `json:"updated_count"`
}

type CategoryResearchExportItem struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Description string `json:"description"`
	Filename    string `json:"filename"`
	Format      string `json:"format"`
	Available   bool   `json:"available"`
}

type CategoryResearchExportListResponse struct {
	DatasetID int64                        `json:"dataset_id"`
	Items     []CategoryResearchExportItem `json:"items"`
}

type CategoryResearchFilter struct {
	Marketplace       *string
	CategoryKeywordEn *string
	CurrentOnly       bool
}

type CategoryResearchProductsFilter struct {
	DatasetID          int64
	Page               int
	PageSize           int
	Brand              *string
	FulfillmentMethod  *string
	PriceBand          *string
	PriceBandStandard  *string
	PriceBandBreaks    *string
}

type Store interface {
	ListDatasets(ctx context.Context, filter CategoryResearchFilter) ([]CategoryResearchDatasetItem, error)
	GetDataset(ctx context.Context, datasetID int64) (*CategoryResearchDatasetItem, error)
	ImportDataset(ctx context.Context, marketplace string, keywordEn string, nameZh string, filename string, fileBytes []byte, createdBy string) (*CategoryResearchImportResponse, error)
	GetDatasetOverview(ctx context.Context, datasetID int64, priceBandStandard string, priceBandBreaks string) (*CategoryResearchOverviewResponse, error)
	RecomputeDataset(ctx context.Context, datasetID int64) (*CategoryResearchRecomputeResponse, error)
	BatchRecomputeDatasets(ctx context.Context, marketplace *string, keywordEn *string, includeHistory bool) (*CategoryResearchBatchRecomputeResponse, error)
	ListProducts(ctx context.Context, filter CategoryResearchProductsFilter) ([]CategoryResearchProductRow, bool, error)
	UpsertManualDimensions(ctx context.Context, datasetID int64, items []CategoryResearchManualDimensionUpsertItem) (int, error)
	GetTrend(ctx context.Context, datasetID int64, asin string) ([]CategoryResearchTrendPoint, error)
	GetMarketTrend(ctx context.Context, datasetID int64, months int) ([]CategoryResearchMarketTrendPoint, error)
	ListExports(ctx context.Context, datasetID int64) ([]CategoryResearchExportItem, error)
	GetExportData(ctx context.Context, datasetID int64, exportKey string, priceBandStandard string, priceBandBreaks string) (string, []byte, error)
}
