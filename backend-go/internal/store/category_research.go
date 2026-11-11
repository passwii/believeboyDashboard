package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/category_research"
)

type CategoryResearchStore struct {
	db FullDB
}

const maxCategoryResearchUploadBytes = 50 * 1024 * 1024

type categoryTrendMetricRow struct {
	asin        string
	parentASIN  *string
	yearMonth   string
	monthlySale int
}

func NewCategoryResearchStore(db FullDB) *CategoryResearchStore {
	return &CategoryResearchStore{db: db}
}

func normalizeCategoryMarketplace(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	switch value {
	case "USA", "AMAZON.COM":
		return "US"
	case "GB", "AMAZON.CO.UK":
		return "UK"
	case "GERMANY", "AMAZON.DE":
		return "DE"
	case "FRANCE", "AMAZON.FR":
		return "FR"
	case "ITALY", "AMAZON.IT":
		return "IT"
	case "SPAIN", "AMAZON.ES":
		return "ES"
	case "JAPAN", "AMAZON.CO.JP":
		return "JP"
	case "CANADA", "AMAZON.CA":
		return "CA"
	}
	if value == "" {
		return "US"
	}
	return value
}

func normalizeCategoryKeyword(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func (s *CategoryResearchStore) ListDatasets(ctx context.Context, filter category_research.CategoryResearchFilter) ([]category_research.CategoryResearchDatasetItem, error) {
	var conditions []string
	var args []any
	idx := 1

	if filter.CurrentOnly {
		conditions = append(conditions, "is_current = true")
	}
	if filter.Marketplace != nil && *filter.Marketplace != "" {
		conditions = append(conditions, fmt.Sprintf("marketplace = $%d", idx))
		args = append(args, normalizeCategoryMarketplace(*filter.Marketplace))
		idx++
	}
	if filter.CategoryKeywordEn != nil && *filter.CategoryKeywordEn != "" {
		conditions = append(conditions, fmt.Sprintf("category_keyword_en = $%d", idx))
		args = append(args, normalizeCategoryKeyword(*filter.CategoryKeywordEn))
		idx++
	}

	where := ""
	if len(conditions) > 0 {
		where = "where " + strings.Join(conditions, " and ")
	}

	querySQL := fmt.Sprintf(`
		select
			id, marketplace, category_keyword_en, category_name_zh, version, is_current,
			superseded_at, upload_file_id, upload_file_path, original_filename, stored_filename,
			file_size_bytes, file_sha256, ingestion_status, ingestion_error, data_date::text,
			row_count_products, row_count_trends, quality_warnings::text, created_by,
			created_at, updated_at
		from public.category_research_datasets
		%s
		order by data_date desc, created_at desc, id desc
	`, where)

	rows, err := s.db.Query(ctx, querySQL, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []category_research.CategoryResearchDatasetItem
	for rows.Next() {
		var it category_research.CategoryResearchDatasetItem
		var supersededAt, createdAt, updatedAt *time.Time
		var qwJSON *string
		var fileSizeBytesVal *int
		if err := rows.Scan(
			&it.ID, &it.Marketplace, &it.CategoryKeywordEn, &it.CategoryNameZh, &it.Version, &it.IsCurrent,
			&supersededAt, &it.UploadFileID, &it.UploadFilePath, &it.OriginalFilename, &it.StoredFilename,
			&fileSizeBytesVal, &it.FileSHA256, &it.IngestionStatus, &it.IngestionError, &it.DataDate,
			&it.RowCountProducts, &it.RowCountTrends, &qwJSON, &it.CreatedBy,
			&createdAt, &updatedAt,
		); err != nil {
			return nil, err
		}
		if fileSizeBytesVal != nil {
			v := int64(*fileSizeBytesVal)
			it.FileSizeBytes = &v
		}
		if supersededAt != nil {
			s := supersededAt.UTC().Format(time.RFC3339Nano)
			it.SupersededAt = &s
		}
		if createdAt != nil {
			s := createdAt.UTC().Format(time.RFC3339Nano)
			it.CreatedAt = &s
		}
		if updatedAt != nil {
			s := updatedAt.UTC().Format(time.RFC3339Nano)
			it.UpdatedAt = &s
		}
		populateCategoryDatasetDateParts(&it)
		it.QualityWarnings = map[string]any{}
		if qwJSON != nil && *qwJSON != "" {
			_ = json.Unmarshal([]byte(*qwJSON), &it.QualityWarnings)
		}
		items = append(items, it)
	}
	if items == nil {
		items = []category_research.CategoryResearchDatasetItem{}
	}
	return items, rows.Err()
}

func (s *CategoryResearchStore) GetDataset(ctx context.Context, datasetID int64) (*category_research.CategoryResearchDatasetItem, error) {
	querySQL := `
		select
			id, marketplace, category_keyword_en, category_name_zh, version, is_current,
			superseded_at, upload_file_id, upload_file_path, original_filename, stored_filename,
			file_size_bytes, file_sha256, ingestion_status, ingestion_error, data_date::text,
			row_count_products, row_count_trends, quality_warnings::text, created_by,
			created_at, updated_at
		from public.category_research_datasets
		where id = $1
	`
	var it category_research.CategoryResearchDatasetItem
	var supersededAt, createdAt, updatedAt *time.Time
	var qwJSON *string
	var fileSizeBytesVal *int
	err := s.db.QueryRow(ctx, querySQL, datasetID).Scan(
		&it.ID, &it.Marketplace, &it.CategoryKeywordEn, &it.CategoryNameZh, &it.Version, &it.IsCurrent,
		&supersededAt, &it.UploadFileID, &it.UploadFilePath, &it.OriginalFilename, &it.StoredFilename,
		&fileSizeBytesVal, &it.FileSHA256, &it.IngestionStatus, &it.IngestionError, &it.DataDate,
		&it.RowCountProducts, &it.RowCountTrends, &qwJSON, &it.CreatedBy,
		&createdAt, &updatedAt,
	)
	if err == nil && fileSizeBytesVal != nil {
		v := int64(*fileSizeBytesVal)
		it.FileSizeBytes = &v
	}
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, category_research.ErrDatasetNotFound
		}
		return nil, err
	}
	if supersededAt != nil {
		s := supersededAt.UTC().Format(time.RFC3339Nano)
		it.SupersededAt = &s
	}
	if createdAt != nil {
		s := createdAt.UTC().Format(time.RFC3339Nano)
		it.CreatedAt = &s
	}
	if updatedAt != nil {
		s := updatedAt.UTC().Format(time.RFC3339Nano)
		it.UpdatedAt = &s
	}
	populateCategoryDatasetDateParts(&it)
	it.QualityWarnings = map[string]any{}
	if qwJSON != nil && *qwJSON != "" {
		_ = json.Unmarshal([]byte(*qwJSON), &it.QualityWarnings)
	}
	return &it, nil
}

func populateCategoryDatasetDateParts(dataset *category_research.CategoryResearchDatasetItem) {
	if dataset.DataDate == nil {
		return
	}
	parsed, err := time.Parse("2006-01-02", *dataset.DataDate)
	if err != nil {
		return
	}
	year, month, day := parsed.Year(), int(parsed.Month()), parsed.Day()
	dataset.DataYear = &year
	dataset.DataMonth = &month
	dataset.DataDay = &day
}

func (s *CategoryResearchStore) ImportDataset(ctx context.Context, marketplace string, keywordEn string, nameZh string, filename string, fileBytes []byte, createdBy string) (*category_research.CategoryResearchImportResponse, error) {
	var resp *category_research.CategoryResearchImportResponse
	if len(fileBytes) == 0 {
		return nil, errors.New("上传文件为空")
	}
	if len(fileBytes) > maxCategoryResearchUploadBytes {
		return nil, fmt.Errorf("上传文件超过 50MB 上限")
	}
	marketplace = normalizeCategoryMarketplace(marketplace)
	keywordEn = normalizeCategoryKeyword(keywordEn)
	nameZh = strings.TrimSpace(nameZh)
	if keywordEn == "" || nameZh == "" {
		return nil, errors.New("category_keyword_en and category_name_zh are required")
	}
	safeFilename := safeUploadFilename(filename, "category_research.xlsx")
	if ext := normalizedFileExtension(safeFilename); ext != ".xlsx" && ext != ".csv" {
		return nil, fmt.Errorf("不支持的文件扩展名 %q，仅支持 .xlsx 和 .csv", ext)
	}
	parsed, err := parseCategoryResearchFile(safeFilename, fileBytes)
	if err != nil {
		return nil, err
	}
	qualityJSON, err := json.Marshal(parsed.QualityWarnings)
	if err != nil {
		return nil, err
	}

	hash := sha256.Sum256(fileBytes)
	sha256Hex := hex.EncodeToString(hash[:])
	uploadFileID := fmt.Sprintf("dataset_%d", time.Now().UnixNano())
	uploadFilePath := path.Join("category_research", safeStoragePathSegment(marketplace, "US"), uploadFileID+"_"+safeFilename)

	err = RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)

		// 1. Get next version for marketplace + keyword
		var currentMaxVersion int
		if err := txDB.QueryRow(ctx, `
			select coalesce(max(version), 0)
			from public.category_research_datasets
			where marketplace = $1 and category_keyword_en = $2
		`, marketplace, keywordEn).Scan(&currentMaxVersion); err != nil {
			return err
		}
		nextVersion := currentMaxVersion + 1

		// 2. Mark previous as superseded
		if _, err := txDB.Exec(ctx, `
			update public.category_research_datasets
			set is_current = false, superseded_at = now()
			where marketplace = $1 and category_keyword_en = $2 and is_current = true
		`, marketplace, keywordEn); err != nil {
			return err
		}

		// 3. Insert new dataset
		var datasetID int64
		err := txDB.QueryRow(ctx, `
			insert into public.category_research_datasets (
				marketplace, category_keyword_en, category_name_zh, version, is_current,
				upload_file_id, upload_file_path, original_filename, stored_filename,
				file_size_bytes, file_sha256, ingestion_status, data_date,
				row_count_products, row_count_trends, quality_warnings, created_by,
				created_at, updated_at
			) values (
				$1, $2, $3, $4, true,
				$5, $6, $7, $7,
				$8, $9, 'success', current_date,
				$10, $11, $12::jsonb, $13,
				now(), now()
			)
			returning id
		`, marketplace, keywordEn, nameZh, nextVersion,
			uploadFileID, uploadFilePath, safeFilename,
			int64(len(fileBytes)), sha256Hex,
			len(parsed.Products), len(parsed.Trends), string(qualityJSON), createdBy,
		).Scan(&datasetID)
		if err != nil {
			return err
		}

		for _, product := range parsed.Products {
			extractedJSON, err := json.Marshal(product.ExtractedDimensions)
			if err != nil {
				return err
			}
			rawJSON, err := json.Marshal(product.RawRow)
			if err != nil {
				return err
			}
			if _, err := txDB.Exec(ctx, `
				insert into public.category_research_product_details (
					dataset_id, source_row_no, asin, parent_asin, product_name, brand, seller,
					price_usd, monthly_sales, monthly_revenue_usd, rating, review_count,
					launch_date, listing_age_days, fba_fee_usd, fulfillment_method,
					bbx_seller_attribute, variant_count, has_main_image_video,
					is_climate_pledge_friendly, has_brand_store, seller_country_region,
					is_amazon, is_new_90d, extracted_dimensions, manual_dimensions, raw_row
				) values (
					$1, $2, $3, $4, $5, $6, $7,
					$8, $9, $10, $11, $12,
					$13::date, $14, $15, $16,
					$17, $18, $19,
					$20, $21, $22,
					$23, $24, $25::jsonb, '{}'::jsonb, $26::jsonb
				)
			`,
				datasetID, product.SourceRowNo, product.ASIN, product.ParentASIN,
				product.ProductName, product.Brand, product.Seller,
				product.PriceUSD, product.MonthlySales, product.MonthlyRevenueUSD,
				product.Rating, product.ReviewCount, product.LaunchDate,
				product.ListingAgeDays, product.FBAPriceUSD, product.FulfillmentMethod,
				product.BBXSellerAttribute, product.VariantCount, product.HasMainImageVideo,
				product.IsClimatePledgeFriendly, product.HasBrandStore, product.SellerCountryRegion,
				product.IsAmazon, product.IsNew90d, string(extractedJSON), string(rawJSON),
			); err != nil {
				return err
			}
		}

		for _, trend := range parsed.Trends {
			if _, err := txDB.Exec(ctx, `
				insert into public.category_research_sales_trends (
					dataset_id, asin, parent_asin, year_month, monthly_sales
				) values ($1, $2, $3, $4, $5)
			`,
				datasetID, trend.ASIN, trend.ParentASIN, trend.YearMonth, trend.MonthlySale,
			); err != nil {
				return err
			}
		}

		resp = &category_research.CategoryResearchImportResponse{
			DatasetID:        datasetID,
			Version:          nextVersion,
			IsCurrent:        true,
			RowCountProducts: len(parsed.Products),
			RowCountTrends:   len(parsed.Trends),
			QualityWarnings:  parsed.QualityWarnings,
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return resp, nil
}

func (s *CategoryResearchStore) GetDatasetOverview(ctx context.Context, datasetID int64, priceBandStandard string, priceBandBreaks string) (*category_research.CategoryResearchOverviewResponse, error) {
	dataset, err := s.GetDataset(ctx, datasetID)
	if err != nil {
		return nil, err
	}

	rows, err := s.db.Query(ctx, `
		select
			id, source_row_no, asin, parent_asin, product_name, brand, seller,
			price_usd, monthly_sales, monthly_revenue_usd, rating, review_count,
			launch_date::text, listing_age_days, fba_fee_usd, fulfillment_method,
			bbx_seller_attribute, variant_count, has_main_image_video,
			is_climate_pledge_friendly, has_brand_store, seller_country_region,
			is_amazon, is_new_90d, extracted_dimensions::text, manual_dimensions::text
		from public.category_research_product_details
		where dataset_id = $1
		order by monthly_sales desc, id asc
	`, datasetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var products []category_research.CategoryResearchProductRow
	for rows.Next() {
		var row category_research.CategoryResearchProductRow
		var extractedJSON, manualJSON *string
		if err := rows.Scan(
			&row.ID, &row.SourceRowNo, &row.ASIN, &row.ParentASIN, &row.ProductName,
			&row.Brand, &row.Seller, &row.PriceUsd, &row.MonthlySales, &row.MonthlyRevenueUsd,
			&row.Rating, &row.ReviewCount, &row.LaunchDate, &row.ListingAgeDays, &row.FbaFeeUsd,
			&row.FulfillmentMethod, &row.BbxSellerAttribute, &row.VariantCount,
			&row.HasMainImageVideo, &row.IsClimatePledgeFriendly, &row.HasBrandStore,
			&row.SellerCountryRegion, &row.IsAmazon, &row.IsNew90d, &extractedJSON, &manualJSON,
		); err != nil {
			return nil, err
		}
		row.ExtractedDimensions = map[string]string{}
		if extractedJSON != nil && *extractedJSON != "" {
			_ = json.Unmarshal([]byte(*extractedJSON), &row.ExtractedDimensions)
		}
		row.ManualDimensions = map[string]string{}
		if manualJSON != nil && *manualJSON != "" {
			_ = json.Unmarshal([]byte(*manualJSON), &row.ManualDimensions)
		}
		row.EffectiveDimensions = map[string]string{}
		for key, value := range row.ExtractedDimensions {
			row.EffectiveDimensions[key] = value
		}
		for key, value := range row.ManualDimensions {
			if value == "" {
				delete(row.EffectiveDimensions, key)
			} else {
				row.EffectiveDimensions[key] = value
			}
		}
		products = append(products, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	trendRows, err := s.db.Query(ctx, `
		select asin, parent_asin, year_month, monthly_sales
		from public.category_research_sales_trends
		where dataset_id = $1
		order by asin asc, year_month asc
	`, datasetID)
	if err != nil {
		return nil, err
	}
	defer trendRows.Close()

	var trends []categoryTrendMetricRow
	availableASINsSet := make(map[string]struct{})
	for trendRows.Next() {
		var trend categoryTrendMetricRow
		if err := trendRows.Scan(&trend.asin, &trend.parentASIN, &trend.yearMonth, &trend.monthlySale); err != nil {
			return nil, err
		}
		trends = append(trends, trend)
		if normalized := normalizeASIN(trend.asin); normalized != "" {
			availableASINsSet[normalized] = struct{}{}
		}
	}
	if err := trendRows.Err(); err != nil {
		return nil, err
	}

	totalSales := 0
	totalRevenue := 0.0
	amazonCount := 0
	brandSales := make(map[string]int)
	sellerSales := make(map[string]int)
	asinSales := make(map[string]int)
	brandCountSet := make(map[string]struct{})
	var prices []float64
	var points []category_research.CategoryResearchPriceSalesPoint
	ageDistribution := map[string]int{"未知": 0, "0-90天": 0, "91-180天": 0, "181-365天": 0, "365天+": 0}
	fulfillmentDistribution := make(map[string]int)
	launchMonthDistribution := make(map[string]int)
	fbaDistribution := map[string]int{"0-5%": 0, "5-10%": 0, "10-15%": 0, "15%+": 0, "未知": 0}
	chinaSellerSales := 0
	chinaSellerCount := 0
	missingSellerCountry := 0
	missingBrand := 0
	unknownFulfillment := 0
	missingFBA := 0
	ratingSum := 0.0
	ratingCount := 0
	lowReviewCount := 0

	for _, product := range products {
		totalSales += product.MonthlySales
		if product.MonthlyRevenueUsd != nil {
			totalRevenue = round2(totalRevenue + *product.MonthlyRevenueUsd)
		}
		if product.IsAmazon {
			amazonCount++
		}
		brand := "Unknown"
		if product.Brand != nil && strings.TrimSpace(*product.Brand) != "" {
			brand = strings.TrimSpace(*product.Brand)
			brandCountSet[brand] = struct{}{}
		} else {
			missingBrand++
		}
		brandSales[brand] += product.MonthlySales
		seller := "Unknown"
		if product.Seller != nil && strings.TrimSpace(*product.Seller) != "" {
			seller = strings.TrimSpace(*product.Seller)
		}
		sellerSales[seller] += product.MonthlySales
		if asin := normalizedOptionalValue(product.ASIN); asin != "" {
			asinSales[asin] += product.MonthlySales
		}
		if product.PriceUsd != nil && *product.PriceUsd > 0 {
			prices = append(prices, *product.PriceUsd)
			points = append(points, category_research.CategoryResearchPriceSalesPoint{
				ASIN:         product.ASIN,
				PriceUsd:     *product.PriceUsd,
				MonthlySales: product.MonthlySales,
			})
		}
		switch {
		case product.ListingAgeDays == nil:
			ageDistribution["未知"]++
		case *product.ListingAgeDays <= 90:
			ageDistribution["0-90天"]++
		case *product.ListingAgeDays <= 180:
			ageDistribution["91-180天"]++
		case *product.ListingAgeDays <= 365:
			ageDistribution["181-365天"]++
		default:
			ageDistribution["365天+"]++
		}
		fulfillment := "未知"
		if product.FulfillmentMethod != nil && strings.TrimSpace(*product.FulfillmentMethod) != "" {
			fulfillment = strings.TrimSpace(*product.FulfillmentMethod)
		} else {
			unknownFulfillment++
		}
		fulfillmentDistribution[fulfillment]++
		if product.LaunchDate != nil && *product.LaunchDate != "" {
			if parsed, err := time.Parse("2006-01-02", *product.LaunchDate); err == nil {
				launchMonthDistribution[parsed.Format("2006-01")]++
			}
		}
		if product.FbaFeeUsd == nil || product.PriceUsd == nil || *product.PriceUsd <= 0 {
			fbaDistribution["未知"]++
			if product.FbaFeeUsd == nil {
				missingFBA++
			}
		} else {
			ratio := *product.FbaFeeUsd / *product.PriceUsd
			switch {
			case ratio < 0.05:
				fbaDistribution["0-5%"]++
			case ratio < 0.10:
				fbaDistribution["5-10%"]++
			case ratio < 0.15:
				fbaDistribution["10-15%"]++
			default:
				fbaDistribution["15%+"]++
			}
		}
		sellerCountry := strings.ToLower(normalizedOptionalValue(product.SellerCountryRegion))
		if sellerCountry == "" {
			missingSellerCountry++
		} else if strings.Contains(sellerCountry, "china") || strings.Contains(sellerCountry, "cn") || strings.Contains(sellerCountry, "中国") {
			chinaSellerSales += product.MonthlySales
			chinaSellerCount++
		}
		if product.Rating != nil {
			ratingSum += *product.Rating
			ratingCount++
			if product.ReviewCount < 50 {
				lowReviewCount++
			}
		}
	}

	// Brand shares are fractions (0..1), matching the Python contract and
	// frontend percentage formatter. Do not emit 0..100 percentages here.
	var brandItems []category_research.CategoryResearchBrandShareItem
	for brand, sales := range brandSales {
		share := 0.0
		if totalSales > 0 {
			share = math.Round(float64(sales)/float64(totalSales)*1_000_000) / 1_000_000
		}
		brandItems = append(brandItems, category_research.CategoryResearchBrandShareItem{
			Brand:        brand,
			MonthlySales: sales,
			Share:        share,
		})
	}
	sort.Slice(brandItems, func(i, j int) bool {
		if brandItems[i].MonthlySales != brandItems[j].MonthlySales {
			return brandItems[i].MonthlySales > brandItems[j].MonthlySales
		}
		return brandItems[i].Brand < brandItems[j].Brand
	})
	if len(brandItems) > 10 {
		brandItems = brandItems[:10]
	}

	sort.Float64s(prices)
	meanPrice := 0.0
	if len(prices) > 0 {
		sum := 0.0
		for _, price := range prices {
			sum += price
		}
		meanPrice = round2(sum / float64(len(prices)))
	}
	priceStats := category_research.CategoryResearchPriceStats{
		Mean:   meanPrice,
		Median: round2(quantileSorted(prices, 0.5)),
		P25:    round2(quantileSorted(prices, 0.25)),
		P75:    round2(quantileSorted(prices, 0.75)),
	}
	bandName, breaks := resolveCategoryPriceBandSpec(priceBandStandard, priceBandBreaks, prices)
	fixedBands := buildFixedPriceBands(prices, breaks)
	quantileBands := buildQuantilePriceBands(prices)
	priceBandOpportunities := buildCategoryPriceBandOpportunities(products, breaks, totalSales, totalRevenue)

	sort.Slice(points, func(i, j int) bool {
		if points[i].MonthlySales != points[j].MonthlySales {
			return points[i].MonthlySales > points[j].MonthlySales
		}
		return normalizedOptionalValue(points[i].ASIN) < normalizedOptionalValue(points[j].ASIN)
	})
	if len(points) > 300 {
		points = points[:300]
	}

	availableASINs := make([]string, 0, len(availableASINsSet))
	for asin := range availableASINsSet {
		availableASINs = append(availableASINs, asin)
	}
	sort.Strings(availableASINs)

	brandCounter := make(map[string]int)
	for brand, sales := range brandSales {
		brandCounter[brand] = sales
	}
	marketConcentration := buildCategoryMarketConcentration(brandCounter, totalSales)
	brandRisk := categoryConcentrationRisk(anyFloat(marketConcentration["cr3"]), anyFloat(marketConcentration["hhi"]))
	sellerConcentration := buildCategoryMarketConcentration(sellerSales, totalSales)
	sellerRisk := categoryConcentrationRisk(anyFloat(sellerConcentration["cr3"]), anyFloat(sellerConcentration["hhi"]))
	productConcentration := buildCategoryMarketConcentration(asinSales, totalSales)
	productRisk := categoryConcentrationRisk(anyFloat(productConcentration["cr3"]), anyFloat(productConcentration["hhi"]))

	amazonShare := 0.0
	if len(products) > 0 {
		amazonShare = math.Round(float64(amazonCount)/float64(len(products))*1_000_000) / 1_000_000
	}
	chinaShare := 0.0
	if totalSales > 0 {
		chinaShare = math.Round(float64(chinaSellerSales)/float64(totalSales)*1_000_000) / 1_000_000
	}
	chinaCountShare := 0.0
	if len(products) > 0 {
		chinaCountShare = math.Round(float64(chinaSellerCount)/float64(len(products))*1_000_000) / 1_000_000
	}
	productTop1Share := anyFloat(productConcentration["cr1"])
	productTop3Share := anyFloat(productConcentration["cr3"])
	productTop10Share := anyFloat(productConcentration["cr10"])

	qualityWarnings := dataset.QualityWarnings
	missingTrendCount := anyInt(qualityWarnings["missing_trend_for_asin_count"])
	invalidPriceCount := anyInt(qualityWarnings["invalid_price_count"])
	invalidFBACount := anyInt(qualityWarnings["invalid_fba_fee_count"])
	duplicateASINCount := anyInt(qualityWarnings["duplicate_asin_count"])
	dataQuality := buildCategoryDataQuality(
		dataset.RowCountProducts,
		missingTrendCount,
		invalidPriceCount,
		invalidFBACount,
		duplicateASINCount,
		missingFBA,
		missingSellerCountry,
		missingBrand,
		unknownFulfillment,
	)
	marketGrowth := buildCategoryMarketGrowth(trends)
	seasonality := buildCategorySeasonality(trends)
	avgRating := 0.0
	if ratingCount > 0 {
		avgRating = math.Round(ratingSum/float64(ratingCount)*100) / 100
	}
	lowReviewShare := 0.0
	if len(products) > 0 {
		lowReviewShare = math.Round(float64(lowReviewCount)/float64(len(products))*1_000_000) / 1_000_000
	}
	newProductShare, newProductSalesShare := buildCategoryNewProductShares(products, totalSales)
	dimensionProfiles := buildCategoryDimensionProfiles(products)

	return &category_research.CategoryResearchOverviewResponse{
		Dataset: *dataset,
		Kpis: category_research.CategoryResearchOverviewKpis{
			SampleCount:            len(products),
			BrandCount:             len(brandCountSet),
			AveragePriceUsd:        meanPrice,
			TotalMonthlySales:      totalSales,
			TotalMonthlyRevenueUsd: totalRevenue,
			AmazonShare:            amazonShare,
		},
		BrandSalesShare:         brandItems,
		ListingAgeDistribution:  orderedBuckets(ageDistribution, []string{"未知", "0-90天", "91-180天", "181-365天", "365天+"}),
		LaunchMonthDistribution: orderedLaunchMonths(launchMonthDistribution),
		FulfillmentDistribution: orderedBuckets(fulfillmentDistribution, nil),
		FixedPriceBands:         fixedBands,
		QuantilePriceBands:      quantileBands,
		PriceStats:              priceStats,
		PriceSalesCorrelation:   round6(priceSalesCorrelation(products)),
		FbaFeeDistribution:      orderedBuckets(fbaDistribution, []string{"0-5%", "5-10%", "10-15%", "15%+", "未知"}),
		PriceSalesPoints:        points,
		AvailableAsins:          availableASINs,
		AdvancedMetrics: category_research.CategoryResearchAdvancedMetrics{
			MarketConcentration: marketConcentration,
			BrandMonopoly: map[string]any{
				"brand_cr3": marketConcentration["cr3"], "brand_cr5": marketConcentration["cr5"],
				"brand_cr10": marketConcentration["cr10"], "brand_hhi": marketConcentration["hhi"],
				"risk_level": brandRisk,
			},
			SellerMonopoly: map[string]any{
				"seller_count": len(sellerSales),
				"seller_cr3":   sellerConcentration["cr3"], "seller_cr5": sellerConcentration["cr5"],
				"seller_cr10": sellerConcentration["cr10"], "seller_hhi": sellerConcentration["hhi"],
				"amazon_seller_sales_share": amazonShare, "risk_level": sellerRisk,
				"top_sellers": buildCategoryTopSalesShares(sellerSales, totalSales, "seller", 10),
			},
			ProductMonopoly: map[string]any{
				"asin_top1_share": productTop1Share,
				"asin_top3_share": productTop3Share, "asin_top10_share": productTop10Share,
				"top1_to_top100_ratio": categoryTopRatio(asinSales),
				"risk_level":           productRisk,
				"top_asins":            buildCategoryTopSalesShares(asinSales, totalSales, "asin", 10),
			},
			ChinaSellerComp: map[string]any{
				"china_seller_sales_share": chinaShare,
				"china_seller_count_share": chinaCountShare,
				"risk_level":               concentrationRiskFromShare(chinaShare),
			},
			MarketGrowth: marketGrowth,
			Seasonality:  seasonality,
			ReviewResearch: map[string]any{
				"average_rating": avgRating, "low_review_product_share": lowReviewShare,
			},
			PriceBandOpps: priceBandOpportunities,
			NewProductOpp: map[string]any{
				"new_product_share": newProductShare, "new_product_sales_share": newProductSalesShare,
				"opportunity_level": productOpportunityLevel(newProductSalesShare),
			},
			SupplyComplexity: map[string]any{
				"complexity_level": supplyComplexityLevel(fulfillmentDistribution, len(products)),
			},
			AsinMomentum:      []any{},
			DataQuality:       dataQuality,
			DimensionProfiles: dimensionProfiles,
			PriceBandStandard: bandName,
			DimensionBlocks:   []any{},
			MetricDefinitions: []any{},
			ActionRecs:        []any{},
			Signals:           []any{},
		},
	}, nil
}

func normalizedOptionalValue(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func quantileSorted(values []float64, q float64) float64 {
	if len(values) == 0 {
		return 0
	}
	if len(values) == 1 {
		return values[0]
	}
	if q <= 0 {
		return values[0]
	}
	if q >= 1 {
		return values[len(values)-1]
	}
	position := q * float64(len(values)-1)
	lower := int(math.Floor(position))
	upper := int(math.Ceil(position))
	if lower == upper {
		return values[lower]
	}
	weight := position - float64(lower)
	return values[lower]*(1-weight) + values[upper]*weight
}

func resolveCategoryPriceBandSpec(standard string, breaksText string, prices []float64) (string, []float64) {
	presets := map[string][]float64{
		"default": {50, 100, 150},
		"value":   {30, 60, 100, 150},
		"premium": {100, 150, 200, 300},
	}
	if breaks, ok := presets[strings.ToLower(strings.TrimSpace(standard))]; ok {
		return strings.ToLower(strings.TrimSpace(standard)), breaks
	}
	if strings.TrimSpace(breaksText) != "" {
		var values []float64
		for _, part := range strings.Split(breaksText, ",") {
			part = strings.NewReplacer("$", "", " ", "").Replace(part)
			number, ok := parseOptionalFloat(part)
			if ok && number != nil && *number > 0 {
				values = append(values, *number)
			}
		}
		sort.Float64s(values)
		if len(values) > 0 {
			return "custom", values
		}
	}
	if len(prices) < 3 {
		return "default", []float64{50, 100, 150}
	}
	q1 := quantileSorted(prices, 0.25)
	q3 := quantileSorted(prices, 0.75)
	width := 2 * (q3 - q1) / math.Cbrt(float64(len(prices)))
	if width <= 0 {
		width = (prices[len(prices)-1] - prices[0]) / math.Cbrt(float64(len(prices)))
	}
	if width <= 0 {
		return "default", []float64{50, 100, 150}
	}
	step := nicePriceStep(width)
	var breaks []float64
	current := math.Ceil(prices[0]/step) * step
	for current < prices[len(prices)-1] && len(breaks) < 8 {
		if current > prices[0] {
			breaks = append(breaks, current)
		}
		current += step
	}
	return "scientific_refined", breaks
}

func nicePriceStep(value float64) float64 {
	if value <= 0 {
		return 1
	}
	magnitude := math.Pow(10, math.Floor(math.Log10(value)))
	normalized := value / magnitude
	var result float64
	switch {
	case normalized < 1.5:
		result = 1
	case normalized < 3.5:
		result = 2
	case normalized < 7.5:
		result = 5
	default:
		result = 10
	}
	return result * magnitude
}

func buildFixedPriceBands(prices []float64, breaks []float64) []category_research.CategoryResearchBucketItem {
	labels := make([]string, 0, len(breaks)+1)
	lower := 0.0
	for _, upper := range breaks {
		labels = append(labels, fmt.Sprintf("$%.0f-$%.0f", lower, upper))
		lower = upper
	}
	labels = append(labels, fmt.Sprintf("$%.0f+", lower))
	counts := make([]int, len(labels))
	for _, price := range prices {
		idx := len(labels) - 1
		lower = 0
		for breakIdx, upper := range breaks {
			if price >= lower && price < upper {
				idx = breakIdx
				break
			}
			lower = upper
		}
		counts[idx]++
	}
	items := make([]category_research.CategoryResearchBucketItem, len(labels))
	for idx, label := range labels {
		items[idx] = category_research.CategoryResearchBucketItem{Label: label, Count: counts[idx]}
	}
	return items
}

func buildCategoryPriceBandOpportunities(products []category_research.CategoryResearchProductRow, breaks []float64, totalSales int, totalRevenue float64) []any {
	labels := make([]string, 0, len(breaks)+1)
	lowerBounds := make([]float64, 0, len(breaks)+1)
	upperBounds := make([]*float64, 0, len(breaks)+1)
	lower := 0.0
	for _, upper := range breaks {
		upperValue := upper
		labels = append(labels, fmt.Sprintf("$%.0f-$%.0f", lower, upper))
		lowerBounds = append(lowerBounds, lower)
		upperBounds = append(upperBounds, &upperValue)
		lower = upper
	}
	labels = append(labels, fmt.Sprintf("$%.0f+", lower))
	lowerBounds = append(lowerBounds, lower)
	upperBounds = append(upperBounds, nil)

	type bandAggregate struct {
		count     int
		sales     int
		revenue   float64
		ratingSum float64
		ratingN   int
	}
	aggregates := make([]bandAggregate, len(labels))
	for _, product := range products {
		if product.PriceUsd == nil {
			continue
		}
		index := len(labels) - 1
		for idx := range labels {
			upper := upperBounds[idx]
			if product.PriceUsd != nil && *product.PriceUsd >= lowerBounds[idx] &&
				(upper == nil || *product.PriceUsd < *upper) {
				index = idx
				break
			}
		}
		aggregates[index].count++
		aggregates[index].sales += product.MonthlySales
		if product.MonthlyRevenueUsd != nil {
			aggregates[index].revenue += *product.MonthlyRevenueUsd
		}
		if product.Rating != nil {
			aggregates[index].ratingSum += *product.Rating
			aggregates[index].ratingN++
		}
	}
	out := make([]any, len(labels))
	for idx, label := range labels {
		aggregate := aggregates[idx]
		salesShare := 0.0
		if totalSales > 0 {
			salesShare = round6(float64(aggregate.sales) / float64(totalSales))
		}
		revenueShare := 0.0
		if totalRevenue > 0 {
			revenueShare = round6(aggregate.revenue / totalRevenue)
		}
		averageRating := 0.0
		if aggregate.ratingN > 0 {
			averageRating = round2(aggregate.ratingSum / float64(aggregate.ratingN))
		}
		out[idx] = map[string]any{
			"label": label, "count": aggregate.count, "monthly_sales": aggregate.sales,
			"sales_share": salesShare, "monthly_revenue_usd": round2(aggregate.revenue),
			"revenue_share": revenueShare, "average_rating": averageRating,
		}
	}
	return out
}

func resolveCategoryPriceBandBounds(target string, breaks []float64) (float64, *float64, bool) {
	lower := 0.0
	for idx, upperValue := range breaks {
		key := fmt.Sprintf("band_%d", idx)
		label := fmt.Sprintf("$%.0f-$%.0f", lower, upperValue)
		if target == key || target == label {
			upper := upperValue
			return lower, &upper, true
		}
		lower = upperValue
	}
	finalKey := fmt.Sprintf("band_%d", len(breaks))
	finalLabel := fmt.Sprintf("$%.0f+", lower)
	if target == finalKey || target == finalLabel {
		return lower, nil, true
	}
	return 0, nil, false
}

func buildQuantilePriceBands(prices []float64) []category_research.CategoryResearchQuantileBandItem {
	if len(prices) == 0 {
		return []category_research.CategoryResearchQuantileBandItem{}
	}
	minPrice := prices[0]
	p25 := round2(quantileSorted(prices, 0.25))
	p50 := round2(quantileSorted(prices, 0.5))
	p75 := round2(quantileSorted(prices, 0.75))
	p100 := prices[len(prices)-1]
	counts := [4]int{}
	for _, price := range prices {
		switch {
		case price <= p25:
			counts[0]++
		case price <= p50:
			counts[1]++
		case price <= p75:
			counts[2]++
		default:
			counts[3]++
		}
	}
	return []category_research.CategoryResearchQuantileBandItem{
		{Label: "Q1", MinPrice: minPrice, MaxPrice: p25, Count: counts[0]},
		{Label: "Q2", MinPrice: p25, MaxPrice: p50, Count: counts[1]},
		{Label: "Q3", MinPrice: p50, MaxPrice: p75, Count: counts[2]},
		{Label: "Q4", MinPrice: p75, MaxPrice: p100, Count: counts[3]},
	}
}

func priceSalesCorrelation(rows []category_research.CategoryResearchProductRow) float64 {
	var prices, sales []float64
	for _, row := range rows {
		if row.PriceUsd != nil {
			prices = append(prices, *row.PriceUsd)
			sales = append(sales, float64(row.MonthlySales))
		}
	}
	if len(prices) < 2 {
		return 0
	}
	meanPrice, meanSales := 0.0, 0.0
	for idx := range prices {
		meanPrice += prices[idx]
		meanSales += sales[idx]
	}
	meanPrice /= float64(len(prices))
	meanSales /= float64(len(sales))
	var covariance, priceVariance, salesVariance float64
	for idx := range prices {
		priceDelta := prices[idx] - meanPrice
		salesDelta := sales[idx] - meanSales
		covariance += priceDelta * salesDelta
		priceVariance += priceDelta * priceDelta
		salesVariance += salesDelta * salesDelta
	}
	if priceVariance == 0 || salesVariance == 0 {
		return 0
	}
	return covariance / math.Sqrt(priceVariance*salesVariance)
}

func orderedBuckets(values map[string]int, preferred []string) []category_research.CategoryResearchBucketItem {
	keys := make([]string, 0, len(values))
	if preferred != nil {
		keys = append(keys, preferred...)
	} else {
		for key := range values {
			keys = append(keys, key)
		}
		sort.Slice(keys, func(i, j int) bool {
			if values[keys[i]] != values[keys[j]] {
				return values[keys[i]] > values[keys[j]]
			}
			return keys[i] < keys[j]
		})
	}
	items := make([]category_research.CategoryResearchBucketItem, 0, len(keys))
	for _, key := range keys {
		items = append(items, category_research.CategoryResearchBucketItem{Label: key, Count: values[key]})
	}
	return items
}

func orderedLaunchMonths(values map[string]int) []category_research.CategoryResearchBucketItem {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(keys)))
	items := make([]category_research.CategoryResearchBucketItem, 0, len(keys))
	for _, key := range keys {
		items = append(items, category_research.CategoryResearchBucketItem{Label: key, Count: values[key]})
	}
	return items
}

func buildCategoryMarketConcentration(salesByGroup map[string]int, total int) map[string]any {
	sales := make([]int, 0, len(salesByGroup))
	for _, value := range salesByGroup {
		sales = append(sales, value)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(sales)))
	result := map[string]any{"cr1": 0.0, "cr3": 0.0, "cr5": 0.0, "cr10": 0.0, "hhi": 0.0}
	if total <= 0 {
		return result
	}
	hhi := 0.0
	for _, salesValue := range sales {
		share := float64(salesValue) / float64(total)
		hhi += share * share * 10000
	}
	result["hhi"] = math.Round(hhi*100) / 100
	for idx, cutoff := range []int{1, 3, 5, 10} {
		var sum int
		for i := 0; i < cutoff && i < len(sales); i++ {
			sum += sales[i]
		}
		result[[]string{"cr1", "cr3", "cr5", "cr10"}[idx]] = round6(float64(sum) / float64(total))
	}
	return result
}

func buildCategoryTopSalesShares(salesByGroup map[string]int, total int, key string, limit int) []any {
	type groupSales struct {
		name  string
		sales int
	}
	groups := make([]groupSales, 0, len(salesByGroup))
	for name, sales := range salesByGroup {
		groups = append(groups, groupSales{name: name, sales: sales})
	}
	sort.Slice(groups, func(i, j int) bool {
		if groups[i].sales != groups[j].sales {
			return groups[i].sales > groups[j].sales
		}
		return groups[i].name < groups[j].name
	})
	out := make([]any, 0, min(limit, len(groups)))
	for idx := 0; idx < limit && idx < len(groups); idx++ {
		share := 0.0
		if total > 0 {
			share = round6(float64(groups[idx].sales) / float64(total))
		}
		out = append(out, map[string]any{
			key: groups[idx].name, "monthly_sales": groups[idx].sales, "share": share,
		})
	}
	return out
}

func categoryTopRatio(asinSales map[string]int) float64 {
	var sales []int
	for _, value := range asinSales {
		sales = append(sales, value)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(sales)))
	if len(sales) == 0 {
		return 0
	}
	top100 := 0
	for idx := 0; idx < 100 && idx < len(sales); idx++ {
		top100 += sales[idx]
	}
	if top100 <= 0 {
		return 0
	}
	return round6(float64(sales[0]) / float64(top100))
}

func anyFloat(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case int:
		return float64(typed)
	default:
		return 0
	}
}

func anyInt(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case json.Number:
		number, _ := typed.Int64()
		return int(number)
	default:
		return 0
	}
}

func categoryConcentrationRisk(cr3, hhi float64) string {
	if cr3 >= 0.7 || hhi >= 2500 {
		return "high"
	}
	if cr3 >= 0.45 || hhi >= 1500 {
		return "medium"
	}
	return "low"
}

func concentrationRiskFromShare(share float64) string {
	if share >= 0.7 {
		return "high"
	}
	if share >= 0.45 {
		return "medium"
	}
	return "low"
}

func round6(value float64) float64 {
	return math.Round(value*1_000_000) / 1_000_000
}

func buildCategoryDataQuality(baseCount, missingTrend, invalidPrice, invalidFBA, duplicateASIN, missingFBA, missingSellerCountry, missingBrand, unknownFulfillment int) map[string]any {
	base := float64(max(1, baseCount))
	completenessPenalty := (float64(missingFBA)/base)*0.35 +
		(float64(missingSellerCountry)/base)*0.25 +
		(float64(missingBrand)/base)*0.2 +
		(float64(missingTrend)/base)*0.2
	validityPenalty := (float64(invalidPrice)/base)*0.55 + (float64(invalidFBA)/base)*0.45
	consistencyPenalty := (float64(duplicateASIN)/base)*0.6 + (float64(unknownFulfillment)/base)*0.4
	coveragePenalty := float64(missingTrend) / base
	completeness := maxFloat(0, 100*(1-math.Min(1, completenessPenalty)))
	validity := maxFloat(0, 100*(1-math.Min(1, validityPenalty)))
	consistency := maxFloat(0, 100*(1-math.Min(1, consistencyPenalty)))
	coverage := maxFloat(0, 100*(1-math.Min(1, coveragePenalty)))
	score := completeness*0.3 + validity*0.3 + consistency*0.2 + coverage*0.2
	level := "poor"
	switch {
	case score >= 92:
		level = "excellent"
	case score >= 82:
		level = "good"
	case score >= 68:
		level = "fair"
	}
	warningDensity := math.Round(
		float64(missingTrend+invalidPrice+invalidFBA+duplicateASIN+missingFBA+missingSellerCountry+missingBrand+unknownFulfillment)/base*10000,
	) / 10000
	return map[string]any{
		"score":                        round2(score),
		"missing_trend_for_asin_count": missingTrend,
		"invalid_price_count":          invalidPrice,
		"invalid_fba_fee_count":        invalidFBA,
		"duplicate_asin_count":         duplicateASIN,
		"missing_fba_fee_count":        missingFBA,
		"missing_seller_country_count": missingSellerCountry,
		"missing_brand_count":          missingBrand,
		"unknown_fulfillment_count":    unknownFulfillment,
		"completeness_score":           round2(completeness),
		"validity_score":               round2(validity),
		"consistency_score":            round2(consistency),
		"coverage_score":               round2(coverage),
		"level":                        level,
		"warning_density":              warningDensity,
	}
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func buildCategoryMarketGrowth(trends []categoryTrendMetricRow) map[string]any {
	monthly := make(map[string]int)
	for _, trend := range trends {
		monthly[trend.yearMonth] += trend.monthlySale
	}
	keys := make([]string, 0, len(monthly))
	for key := range monthly {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	sales := make([]float64, len(keys))
	for idx, key := range keys {
		sales[idx] = float64(monthly[key])
	}
	result := map[string]any{
		"trend_slope": 0.0, "last12_vs_prev12_growth": 0.0,
		"cagr_like_growth": 0.0, "growth_level": "stable", "growth_tier": "stable",
	}
	if len(sales) < 2 {
		return result
	}
	sumX, sumY, sumXY, sumXX := 0.0, 0.0, 0.0, 0.0
	for idx, value := range sales {
		x := float64(idx)
		sumX += x
		sumY += value
		sumXY += x * value
		sumXX += x * x
	}
	n := float64(len(sales))
	slopeDenominator := n*sumXX - sumX*sumX
	slope := 0.0
	if slopeDenominator != 0 {
		slope = (n*sumXY - sumX*sumY) / slopeDenominator
	}
	split := len(sales) / 2
	prev := 0.0
	last := 0.0
	if len(sales) >= 24 {
		for _, value := range sales[len(sales)-24 : len(sales)-12] {
			prev += value
		}
		for _, value := range sales[len(sales)-12:] {
			last += value
		}
	} else if len(sales) >= 12 {
		for _, value := range sales[:split] {
			prev += value
		}
		for _, value := range sales[split:] {
			last += value
		}
	} else {
		for _, value := range sales[:len(sales)-1] {
			prev += value
		}
		last = sales[len(sales)-1]
	}
	growth := 0.0
	if prev > 0 {
		growth = last/prev - 1
	} else if last > 0 {
		growth = 1
	}
	cagr := 0.0
	if sales[0] > 0 {
		cagr = math.Pow(sales[len(sales)-1]/sales[0], 12/float64(max(1, len(sales)-1))) - 1
	} else if sales[len(sales)-1] > 0 {
		cagr = 1
	}
	level := "stable"
	if growth >= 0.08 || cagr >= 0.1 {
		level = "growing"
	} else if growth <= -0.08 || cagr <= -0.08 {
		level = "shrinking"
	}
	tier := "stable"
	anchor := math.Max(growth, cagr)
	switch {
	case anchor >= 0.25:
		tier = "explosive"
	case anchor >= 0.12:
		tier = "fast_growing"
	case anchor >= 0.03:
		tier = "growing"
	case anchor > -0.03:
		tier = "stable"
	case anchor > -0.12:
		tier = "softening"
	default:
		tier = "shrinking"
	}
	result["last12_vs_prev12_growth"] = round6(growth)
	result["cagr_like_growth"] = round6(cagr)
	result["trend_slope"] = math.Round(slope*10000) / 10000
	result["growth_level"] = level
	result["growth_tier"] = tier
	return result
}

func buildCategorySeasonality(trends []categoryTrendMetricRow) map[string]any {
	monthly := make(map[string]int)
	for _, trend := range trends {
		monthly[trend.yearMonth] += trend.monthlySale
	}
	keys := make([]string, 0, len(monthly))
	for key := range monthly {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var sales []float64
	for _, key := range keys {
		sales = append(sales, float64(monthly[key]))
	}
	result := map[string]any{
		"peak3_month_sales_share": 0.0, "monthly_sales_cv": 0.0,
		"seasonality_level": "weak", "seasonality_tier": "balanced",
		"recommended_entry_months": []string{},
	}
	if len(sales) == 0 {
		return result
	}
	total := 0.0
	for _, value := range sales {
		total += value
	}
	sortedSales := append([]float64(nil), sales...)
	sort.Sort(sort.Reverse(sort.Float64Slice(sortedSales)))
	peak := 0.0
	for idx := 0; idx < 3 && idx < len(sortedSales); idx++ {
		peak += sortedSales[idx]
	}
	peakShare := 0.0
	if total > 0 {
		peakShare = peak / total
	}
	mean := total / float64(len(sales))
	variance := 0.0
	for _, value := range sales {
		variance += (value - mean) * (value - mean)
	}
	cv := 0.0
	if mean > 0 {
		cv = math.Sqrt(variance/float64(len(sales))) / mean
	}
	level := "weak"
	if peakShare >= 0.45 || cv >= 0.6 {
		level = "strong"
	} else if peakShare >= 0.32 || cv >= 0.35 {
		level = "moderate"
	}
	tier := "balanced"
	switch {
	case peakShare >= 0.58 || cv >= 0.85:
		tier = "extreme"
	case peakShare >= 0.45 || cv >= 0.6:
		tier = "strong"
	case peakShare >= 0.38 || cv >= 0.45:
		tier = "elevated"
	case peakShare >= 0.32 || cv >= 0.35:
		tier = "moderate"
	case peakShare >= 0.26 || cv >= 0.22:
		tier = "mild"
	}
	result["peak3_month_sales_share"] = round6(peakShare)
	result["monthly_sales_cv"] = round6(cv)
	result["seasonality_level"] = level
	result["seasonality_tier"] = tier
	type monthValue struct {
		month int
		sales int
	}
	monthSource := make(map[int]int)
	for _, key := range keys {
		if len(key) < 7 {
			continue
		}
		month, err := strconv.Atoi(key[len(key)-2:])
		if err == nil && month >= 1 && month <= 12 {
			monthSource[month] += monthly[key]
		}
	}
	var monthValues []monthValue
	for month, value := range monthSource {
		monthValues = append(monthValues, monthValue{month: month, sales: value})
	}
	sort.Slice(monthValues, func(i, j int) bool {
		if monthValues[i].sales != monthValues[j].sales {
			return monthValues[i].sales > monthValues[j].sales
		}
		return monthValues[i].month < monthValues[j].month
	})
	recommended := make([]string, 0, 3)
	for idx := 0; idx < 3 && idx < len(monthValues); idx++ {
		entryMonth := monthValues[idx].month - 1
		if entryMonth == 0 {
			entryMonth = 12
		}
		monthText := fmt.Sprintf("%02d", entryMonth)
		if !categoryContainsString(recommended, monthText) {
			recommended = append(recommended, monthText)
		}
	}
	result["recommended_entry_months"] = recommended
	return result
}

func categoryContainsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func buildCategoryNewProductShares(products []category_research.CategoryResearchProductRow, totalSales int) (float64, float64) {
	if len(products) == 0 {
		return 0, 0
	}
	newCount := 0
	newSales := 0
	for _, product := range products {
		if product.IsNew90d {
			newCount++
			newSales += product.MonthlySales
		}
	}
	countShare := round6(float64(newCount) / float64(len(products)))
	salesShare := 0.0
	if totalSales > 0 {
		salesShare = round6(float64(newSales) / float64(totalSales))
	}
	return countShare, salesShare
}

func productOpportunityLevel(share float64) string {
	switch {
	case share >= 0.35:
		return "high"
	case share >= 0.15:
		return "medium"
	default:
		return "low"
	}
}

func supplyComplexityLevel(distribution map[string]int, total int) string {
	if total <= 0 {
		return "low"
	}
	unknown := distribution["未知"]
	if float64(unknown)/float64(total) >= 0.5 {
		return "high"
	}
	if float64(unknown)/float64(total) >= 0.2 {
		return "medium"
	}
	return "low"
}

func buildCategoryDimensionProfiles(products []category_research.CategoryResearchProductRow) []any {
	if len(products) == 0 {
		return []any{}
	}
	coverage := make(map[string]int)
	values := make(map[string]map[string]int)
	for _, product := range products {
		for key, value := range product.ExtractedDimensions {
			if strings.TrimSpace(value) == "" {
				continue
			}
			coverage[key]++
			if values[key] == nil {
				values[key] = make(map[string]int)
			}
			values[key][value]++
		}
	}
	var profiles []any
	dimensionLabels := map[string]string{
		"blade_material":   "Blade Material",
		"product_material": "Material",
		"color":            "Color",
		"size":             "Size",
	}
	for key, count := range coverage {
		type valueCount struct {
			value string
			count int
		}
		var sortedValues []valueCount
		for value, countForValue := range values[key] {
			sortedValues = append(sortedValues, valueCount{value: value, count: countForValue})
		}
		sort.Slice(sortedValues, func(i, j int) bool {
			if sortedValues[i].count != sortedValues[j].count {
				return sortedValues[i].count > sortedValues[j].count
			}
			return sortedValues[i].value < sortedValues[j].value
		})
		topValues := make([]any, 0, min(10, len(sortedValues)))
		for idx := 0; idx < 10 && idx < len(sortedValues); idx++ {
			topValues = append(topValues, map[string]any{
				"value": sortedValues[idx].value, "count": sortedValues[idx].count,
				"share": round6(float64(sortedValues[idx].count) / float64(max(1, count))),
			})
		}
		label := dimensionLabels[key]
		if label == "" {
			label = strings.ReplaceAll(key, "_", " ")
		}
		profiles = append(profiles, map[string]any{
			"key": key, "label": label, "coverage": round6(float64(count) / float64(len(products))),
			"distinct_count": len(values[key]), "top_values": topValues,
		})
	}
	sort.Slice(profiles, func(i, j int) bool {
		return anyFloat(profiles[i].(map[string]any)["coverage"]) > anyFloat(profiles[j].(map[string]any)["coverage"])
	})
	return profiles
}

func (s *CategoryResearchStore) RecomputeDataset(ctx context.Context, datasetID int64) (*category_research.CategoryResearchRecomputeResponse, error) {
	dataset, err := s.GetDataset(ctx, datasetID)
	if err != nil {
		return nil, err
	}
	var productCount, trendCount, invalidPriceCount, missingFBACount, missingTrendCount int
	err = RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		if err := txDB.QueryRow(ctx, `
			select
				(select count(*) from public.category_research_product_details where dataset_id = $1),
				(select count(*) from public.category_research_sales_trends where dataset_id = $1),
				(select count(*) from public.category_research_product_details where dataset_id = $1 and price_usd is null),
				(select count(*) from public.category_research_product_details where dataset_id = $1 and fba_fee_usd is null),
				(select count(distinct p.asin)
				 from public.category_research_product_details p
				 where p.dataset_id = $1
				   and nullif(btrim(p.asin), '') is not null
				   and not exists (
				     select 1 from public.category_research_sales_trends t
				     where t.dataset_id = p.dataset_id and t.asin = p.asin
				   ))
		`, datasetID).Scan(
			&productCount, &trendCount, &invalidPriceCount, &missingFBACount, &missingTrendCount,
		); err != nil {
			return err
		}
		warnings := make(map[string]any, len(dataset.QualityWarnings)+5)
		for key, value := range dataset.QualityWarnings {
			warnings[key] = value
		}
		warnings["invalid_price_count"] = invalidPriceCount
		warnings["missing_fba_fee_count"] = missingFBACount
		warnings["missing_trend_for_asin_count"] = missingTrendCount
		qualityJSON, err := json.Marshal(warnings)
		if err != nil {
			return err
		}
		if _, err := txDB.Exec(ctx, `
			update public.category_research_datasets
			set row_count_products = $1,
			    row_count_trends = $2,
			    quality_warnings = $3::jsonb,
			    ingestion_status = 'success',
			    ingestion_error = null,
			    updated_at = now()
			where id = $4
		`, productCount, trendCount, string(qualityJSON), datasetID); err != nil {
			return err
		}
		dataset.RowCountProducts = productCount
		dataset.RowCountTrends = trendCount
		dataset.QualityWarnings = warnings
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &category_research.CategoryResearchRecomputeResponse{
		DatasetID:        datasetID,
		RowCountProducts: productCount,
		RowCountTrends:   trendCount,
		QualityWarnings:  dataset.QualityWarnings,
	}, nil
}

func (s *CategoryResearchStore) BatchRecomputeDatasets(ctx context.Context, marketplace *string, keywordEn *string, includeHistory bool) (*category_research.CategoryResearchBatchRecomputeResponse, error) {
	datasets, err := s.ListDatasets(ctx, category_research.CategoryResearchFilter{
		Marketplace:       marketplace,
		CategoryKeywordEn: keywordEn,
		CurrentOnly:       !includeHistory,
	})
	if err != nil {
		return nil, err
	}
	var ids []int64
	recomputed := 0
	for _, ds := range datasets {
		ids = append(ids, ds.ID)
		if _, err := s.RecomputeDataset(ctx, ds.ID); err != nil {
			return nil, fmt.Errorf("recompute dataset %d: %w", ds.ID, err)
		}
		recomputed++
	}
	return &category_research.CategoryResearchBatchRecomputeResponse{
		Matched:    len(ids),
		Recomputed: recomputed,
		DatasetIDs: ids,
	}, nil
}

func (s *CategoryResearchStore) ListProducts(ctx context.Context, filter category_research.CategoryResearchProductsFilter) ([]category_research.CategoryResearchProductRow, bool, error) {
	if _, err := s.GetDataset(ctx, filter.DatasetID); err != nil {
		return nil, false, err
	}

	var conditions []string
	var args []any
	conditions = append(conditions, "dataset_id = $1")
	args = append(args, filter.DatasetID)
	idx := 2

	if filter.Brand != nil && *filter.Brand != "" {
		conditions = append(conditions, fmt.Sprintf("brand = $%d", idx))
		args = append(args, *filter.Brand)
		idx++
	}
	if filter.FulfillmentMethod != nil && *filter.FulfillmentMethod != "" {
		conditions = append(conditions, fmt.Sprintf("fulfillment_method = $%d", idx))
		args = append(args, *filter.FulfillmentMethod)
		idx++
	}
	if filter.PriceBand != nil && strings.TrimSpace(*filter.PriceBand) != "" {
		standard := ""
		if filter.PriceBandStandard != nil {
			standard = *filter.PriceBandStandard
		}
		breaksText := ""
		if filter.PriceBandBreaks != nil {
			breaksText = *filter.PriceBandBreaks
		}
		_, breaks := resolveCategoryPriceBandSpec(standard, breaksText, nil)
		target := strings.TrimSpace(*filter.PriceBand)
		lower, upper, found := resolveCategoryPriceBandBounds(target, breaks)
		if found {
			conditions = append(conditions, "price_usd is not null", fmt.Sprintf("price_usd >= $%d", idx))
			args = append(args, lower)
			idx++
			if upper != nil {
				conditions = append(conditions, fmt.Sprintf("price_usd < $%d", idx))
				args = append(args, *upper)
				idx++
			}
		}
	}

	where := "where " + strings.Join(conditions, " and ")
	limit := filter.PageSize
	offset := (filter.Page - 1) * filter.PageSize
	if offset < 0 {
		offset = 0
	}

	querySQL := fmt.Sprintf(`
		select
			id, source_row_no, asin, parent_asin, product_name, brand, seller,
			price_usd, monthly_sales, monthly_revenue_usd, rating, review_count,
			launch_date::text, listing_age_days, fba_fee_usd, fulfillment_method,
			bbx_seller_attribute, variant_count, has_main_image_video,
			is_climate_pledge_friendly, has_brand_store, seller_country_region,
			is_amazon, is_new_90d, extracted_dimensions::text, manual_dimensions::text
		from public.category_research_product_details
		%s
		order by monthly_sales desc, id asc
		limit $%d offset $%d
	`, where, idx, idx+1)
	args = append(args, limit+1, offset)

	rows, err := s.db.Query(ctx, querySQL, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()

	var prods []category_research.CategoryResearchProductRow
	for rows.Next() {
		var pr category_research.CategoryResearchProductRow
		var extJSON, manJSON *string
		if err := rows.Scan(
			&pr.ID, &pr.SourceRowNo, &pr.ASIN, &pr.ParentASIN, &pr.ProductName, &pr.Brand, &pr.Seller,
			&pr.PriceUsd, &pr.MonthlySales, &pr.MonthlyRevenueUsd, &pr.Rating, &pr.ReviewCount,
			&pr.LaunchDate, &pr.ListingAgeDays, &pr.FbaFeeUsd, &pr.FulfillmentMethod,
			&pr.BbxSellerAttribute, &pr.VariantCount, &pr.HasMainImageVideo,
			&pr.IsClimatePledgeFriendly, &pr.HasBrandStore, &pr.SellerCountryRegion,
			&pr.IsAmazon, &pr.IsNew90d, &extJSON, &manJSON,
		); err != nil {
			return nil, false, err
		}
		pr.ExtractedDimensions = map[string]string{}
		if extJSON != nil && *extJSON != "" {
			_ = json.Unmarshal([]byte(*extJSON), &pr.ExtractedDimensions)
		}
		pr.ManualDimensions = map[string]string{}
		if manJSON != nil && *manJSON != "" {
			_ = json.Unmarshal([]byte(*manJSON), &pr.ManualDimensions)
		}
		pr.EffectiveDimensions = map[string]string{}
		for k, v := range pr.ExtractedDimensions {
			pr.EffectiveDimensions[k] = v
		}
		for k, v := range pr.ManualDimensions {
			pr.EffectiveDimensions[k] = v
		}
		prods = append(prods, pr)
	}

	hasNext := len(prods) > limit
	if hasNext {
		prods = prods[:limit]
	}
	if prods == nil {
		prods = []category_research.CategoryResearchProductRow{}
	}
	return prods, hasNext, nil
}

func (s *CategoryResearchStore) UpsertManualDimensions(ctx context.Context, datasetID int64, items []category_research.CategoryResearchManualDimensionUpsertItem) (int, error) {
	if _, err := s.GetDataset(ctx, datasetID); err != nil {
		return 0, err
	}

	count := 0
	for _, item := range items {
		if strings.TrimSpace(item.Key) == "" {
			continue
		}
		// Read current manual_dimensions
		var currentJSON *string
		err := s.db.QueryRow(ctx, "select manual_dimensions::text from public.category_research_product_details where id = $1 and dataset_id = $2", item.ProductRowID, datasetID).Scan(&currentJSON)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			return count, err
		}
		dims := map[string]string{}
		if currentJSON != nil && *currentJSON != "" {
			if err := json.Unmarshal([]byte(*currentJSON), &dims); err != nil {
				return count, err
			}
		}
		if item.Value == nil || *item.Value == "" {
			delete(dims, item.Key)
		} else {
			dims[item.Key] = *item.Value
		}
		bytes, err := json.Marshal(dims)
		if err != nil {
			return count, err
		}
		_, err = s.db.Exec(ctx, "update public.category_research_product_details set manual_dimensions = $1::jsonb where id = $2 and dataset_id = $3", string(bytes), item.ProductRowID, datasetID)
		if err != nil {
			return count, err
		}
		count++
	}
	return count, nil
}

func (s *CategoryResearchStore) GetTrend(ctx context.Context, datasetID int64, asin string) ([]category_research.CategoryResearchTrendPoint, error) {
	if _, err := s.GetDataset(ctx, datasetID); err != nil {
		return nil, err
	}

	normalized := strings.ToUpper(strings.TrimSpace(asin))
	rows, err := s.db.Query(ctx, `
		select year_month, monthly_sales
		from public.category_research_sales_trends
		where dataset_id = $1 and asin = $2
		order by year_month asc
	`, datasetID, normalized)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var points []category_research.CategoryResearchTrendPoint
	for rows.Next() {
		var pt category_research.CategoryResearchTrendPoint
		if err := rows.Scan(&pt.YearMonth, &pt.MonthlySales); err != nil {
			return nil, err
		}
		points = append(points, pt)
	}
	if points == nil {
		points = []category_research.CategoryResearchTrendPoint{}
	}
	return points, rows.Err()
}

func (s *CategoryResearchStore) GetMarketTrend(ctx context.Context, datasetID int64, months int) ([]category_research.CategoryResearchMarketTrendPoint, error) {
	if _, err := s.GetDataset(ctx, datasetID); err != nil {
		return nil, err
	}

	rows, err := s.db.Query(ctx, `
		select year_month, sum(monthly_sales)
		from public.category_research_sales_trends
		where dataset_id = $1
		group by year_month
		order by year_month asc
	`, datasetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	totalsByMonth := make(map[string]int)
	for rows.Next() {
		var pt category_research.CategoryResearchMarketTrendPoint
		if err := rows.Scan(&pt.YearMonth, &pt.MonthlySales); err != nil {
			return nil, err
		}
		totalsByMonth[pt.YearMonth] = pt.MonthlySales
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(totalsByMonth) == 0 {
		return []category_research.CategoryResearchMarketTrendPoint{}, nil
	}
	var monthKeys []string
	for month := range totalsByMonth {
		if _, err := time.Parse("2006-01", month); err == nil {
			monthKeys = append(monthKeys, month)
		}
	}
	if len(monthKeys) == 0 {
		return []category_research.CategoryResearchMarketTrendPoint{}, nil
	}
	sort.Strings(monthKeys)
	latest, _ := time.Parse("2006-01", monthKeys[len(monthKeys)-1])
	start := latest.AddDate(0, -(months - 1), 0)
	var points []category_research.CategoryResearchMarketTrendPoint
	for current := start; !current.After(latest); current = current.AddDate(0, 1, 0) {
		month := current.Format("2006-01")
		points = append(points, category_research.CategoryResearchMarketTrendPoint{
			YearMonth:    month,
			MonthlySales: totalsByMonth[month],
		})
	}
	return points, nil
}

func (s *CategoryResearchStore) ListExports(ctx context.Context, datasetID int64) ([]category_research.CategoryResearchExportItem, error) {
	dataset, err := s.GetDataset(ctx, datasetID)
	if err != nil {
		return nil, err
	}
	base := fmt.Sprintf(
		"category-research-%s-%s-v%d",
		strings.ToLower(dataset.Marketplace),
		safeStoragePathSegment(dataset.CategoryKeywordEn, "category-research"),
		dataset.Version,
	)
	return []category_research.CategoryResearchExportItem{
		{Key: "analysis_workbook", Label: "分析结果 Excel", Description: "概览、品牌、价格带、产品明细与趋势", Filename: base + "-analysis.xlsx", Format: "xlsx", Available: true},
		{Key: "overview", Label: "概览报表", Description: "包含大盘指标与核心分布", Filename: base + "-overview.xlsx", Format: "xlsx", Available: true},
		{Key: "products", Label: "产品明细", Description: "结构化产品明细", Filename: base + "-products.xlsx", Format: "xlsx", Available: true},
		{Key: "trends", Label: "销量趋势", Description: "ASIN 月度销量趋势", Filename: base + "-trends.xlsx", Format: "xlsx", Available: true},
	}, nil
}

func (s *CategoryResearchStore) GetExportData(ctx context.Context, datasetID int64, exportKey string, priceBandStandard string, priceBandBreaks string) (string, []byte, error) {
	dataset, err := s.GetDataset(ctx, datasetID)
	if err != nil {
		return "", nil, err
	}
	if exportKey == "summary_pdf" {
		overview, err := s.GetDatasetOverview(ctx, datasetID, priceBandStandard, priceBandBreaks)
		if err != nil {
			return "", nil, err
		}
		content, err := s.buildCategorySummaryPDF(ctx, *dataset, *overview)
		if err != nil {
			return "", nil, err
		}
		keywordSlug := safeStoragePathSegment(dataset.CategoryKeywordEn, "category-research")
		filename := fmt.Sprintf(
			"category-research-%s-%s-v%d-summary.pdf",
			strings.ToLower(dataset.Marketplace), keywordSlug, dataset.Version,
		)
		return safeUploadFilename(filename, "category-research-summary.pdf"), content, nil
	}
	if exportKey != "overview" && exportKey != "analysis_workbook" && exportKey != "products" && exportKey != "trends" {
		return "", nil, fmt.Errorf("unsupported export key %q", exportKey)
	}
	products, err := s.listAllCategoryProducts(ctx, datasetID)
	if err != nil {
		return "", nil, err
	}
	trends, err := s.listAllCategoryTrends(ctx, datasetID)
	if err != nil {
		return "", nil, err
	}

	var sheets []exportSheet
	switch exportKey {
	case "overview", "analysis_workbook":
		overview, err := s.GetDatasetOverview(ctx, datasetID, priceBandStandard, priceBandBreaks)
		if err != nil {
			return "", nil, err
		}
		sheets = buildCategoryOverviewExportSheets(*overview)
	case "products":
		sheets = []exportSheet{{
			Name: "产品明细",
			Rows: buildCategoryProductExportRows(products),
		}}
	case "trends":
		sheets = []exportSheet{{
			Name: "销量趋势",
			Rows: buildCategoryTrendExportRows(trends),
		}}
	}

	content, err := buildCategoryXLSX(sheets)
	if err != nil {
		return "", nil, err
	}
	exportSlug := exportKey
	if exportKey == "analysis_workbook" {
		exportSlug = "analysis"
	}
	keywordSlug := safeStoragePathSegment(dataset.CategoryKeywordEn, "category-research")
	filename := fmt.Sprintf(
		"category-research-%s-%s-v%d-%s.xlsx",
		strings.ToLower(dataset.Marketplace),
		keywordSlug,
		dataset.Version,
		exportSlug,
	)
	return safeUploadFilename(filename, "category-research.xlsx"), content, nil
}

func (s *CategoryResearchStore) listAllCategoryProducts(ctx context.Context, datasetID int64) ([]category_research.CategoryResearchProductRow, error) {
	rows, err := s.db.Query(ctx, `
		select
			id, source_row_no, asin, parent_asin, product_name, brand, seller,
			price_usd, monthly_sales, monthly_revenue_usd, rating, review_count,
			launch_date::text, listing_age_days, fba_fee_usd, fulfillment_method,
			bbx_seller_attribute, variant_count, has_main_image_video,
			is_climate_pledge_friendly, has_brand_store, seller_country_region,
			is_amazon, is_new_90d, extracted_dimensions::text, manual_dimensions::text
		from public.category_research_product_details
		where dataset_id = $1
		order by monthly_sales desc, id asc
	`, datasetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var products []category_research.CategoryResearchProductRow
	for rows.Next() {
		var row category_research.CategoryResearchProductRow
		var extractedJSON, manualJSON *string
		if err := rows.Scan(
			&row.ID, &row.SourceRowNo, &row.ASIN, &row.ParentASIN, &row.ProductName,
			&row.Brand, &row.Seller, &row.PriceUsd, &row.MonthlySales, &row.MonthlyRevenueUsd,
			&row.Rating, &row.ReviewCount, &row.LaunchDate, &row.ListingAgeDays, &row.FbaFeeUsd,
			&row.FulfillmentMethod, &row.BbxSellerAttribute, &row.VariantCount,
			&row.HasMainImageVideo, &row.IsClimatePledgeFriendly, &row.HasBrandStore,
			&row.SellerCountryRegion, &row.IsAmazon, &row.IsNew90d, &extractedJSON, &manualJSON,
		); err != nil {
			return nil, err
		}
		row.ExtractedDimensions = map[string]string{}
		row.ManualDimensions = map[string]string{}
		if extractedJSON != nil && *extractedJSON != "" {
			_ = json.Unmarshal([]byte(*extractedJSON), &row.ExtractedDimensions)
		}
		if manualJSON != nil && *manualJSON != "" {
			_ = json.Unmarshal([]byte(*manualJSON), &row.ManualDimensions)
		}
		products = append(products, row)
	}
	if products == nil {
		products = []category_research.CategoryResearchProductRow{}
	}
	return products, rows.Err()
}

func (s *CategoryResearchStore) listAllCategoryTrends(ctx context.Context, datasetID int64) ([]categoryTrendMetricRow, error) {
	rows, err := s.db.Query(ctx, `
		select asin, parent_asin, year_month, monthly_sales
		from public.category_research_sales_trends
		where dataset_id = $1
		order by asin asc, year_month asc, id asc
	`, datasetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var trends []categoryTrendMetricRow
	for rows.Next() {
		var point categoryTrendMetricRow
		if err := rows.Scan(&point.asin, &point.parentASIN, &point.yearMonth, &point.monthlySale); err != nil {
			return nil, err
		}
		trends = append(trends, point)
	}
	if trends == nil {
		trends = []categoryTrendMetricRow{}
	}
	return trends, rows.Err()
}

func buildCategoryOverviewExportSheets(overview category_research.CategoryResearchOverviewResponse) []exportSheet {
	summaryRows := [][]any{
		{"分类调研概览"},
		{"类目", overview.Dataset.CategoryNameZh},
		{"关键词", overview.Dataset.CategoryKeywordEn},
		{"站点", overview.Dataset.Marketplace},
		{"版本", overview.Dataset.Version},
		{"数据日期", categoryExportString(overview.Dataset.DataDate)},
		{"样本数", overview.Kpis.SampleCount},
		{"品牌数", overview.Kpis.BrandCount},
		{"平均价格(USD)", overview.Kpis.AveragePriceUsd},
		{"总月销量", overview.Kpis.TotalMonthlySales},
		{"总月销售额(USD)", overview.Kpis.TotalMonthlyRevenueUsd},
		{"Amazon商品占比", overview.Kpis.AmazonShare},
		{"价格均值", overview.PriceStats.Mean},
		{"价格中位数", overview.PriceStats.Median},
		{"价格P25", overview.PriceStats.P25},
		{"价格P75", overview.PriceStats.P75},
		{"价格销量相关系数", overview.PriceSalesCorrelation},
		{"数据质量分", anyFloat(overview.AdvancedMetrics.DataQuality["score"])},
	}
	brandRows := [][]any{{"品牌", "月销量", "销量份额"}}
	for _, item := range overview.BrandSalesShare {
		brandRows = append(brandRows, []any{item.Brand, item.MonthlySales, item.Share})
	}
	priceBandRows := [][]any{{"价格带", "样本数"}}
	for _, item := range overview.FixedPriceBands {
		priceBandRows = append(priceBandRows, []any{item.Label, item.Count})
	}
	return []exportSheet{
		{Name: "概览", Rows: summaryRows},
		{Name: "品牌分析", Rows: brandRows},
		{Name: "价格带", Rows: priceBandRows},
	}
}

func buildCategoryProductExportRows(products []category_research.CategoryResearchProductRow) [][]any {
	rows := [][]any{{
		"行号", "ASIN", "父ASIN", "产品名称", "品牌", "卖家", "价格(USD)",
		"月销量", "月销售额(USD)", "评分", "评论数", "上架日期", "上架天数",
		"FBA费用(USD)", "物流方式", "BBX卖家属性", "变体数量", "主图视频",
		"气候承诺友好", "品牌旗舰店", "卖家国家/地区", "Amazon自营", "90天新品",
		"提取维度", "人工维度",
	}}
	for _, product := range products {
		rows = append(rows, []any{
			product.SourceRowNo, categoryExportString(product.ASIN), categoryExportString(product.ParentASIN),
			categoryExportString(product.ProductName), categoryExportString(product.Brand), categoryExportString(product.Seller),
			categoryExportFloat(product.PriceUsd), product.MonthlySales, categoryExportFloat(product.MonthlyRevenueUsd),
			categoryExportFloat(product.Rating), product.ReviewCount, product.LaunchDate, categoryExportInt(product.ListingAgeDays),
			categoryExportFloat(product.FbaFeeUsd), categoryExportString(product.FulfillmentMethod),
			categoryExportString(product.BbxSellerAttribute), categoryExportInt(product.VariantCount),
			categoryExportBool(product.HasMainImageVideo), categoryExportBool(product.IsClimatePledgeFriendly),
			categoryExportBool(product.HasBrandStore), categoryExportString(product.SellerCountryRegion),
			product.IsAmazon, product.IsNew90d,
			marshalStringMap(product.ExtractedDimensions), marshalStringMap(product.ManualDimensions),
		})
	}
	return rows
}

func buildCategoryTrendExportRows(trends []categoryTrendMetricRow) [][]any {
	rows := [][]any{{"ASIN", "父ASIN", "年月", "月销量"}}
	for _, trend := range trends {
		rows = append(rows, []any{trend.asin, categoryExportString(trend.parentASIN), trend.yearMonth, trend.monthlySale})
	}
	return rows
}

func categoryExportString(value *string) any {
	if value == nil {
		return ""
	}
	return *value
}

func categoryExportFloat(value *float64) any {
	if value == nil {
		return ""
	}
	return *value
}

func categoryExportInt(value *int) any {
	if value == nil {
		return ""
	}
	return *value
}

func categoryExportBool(value *bool) any {
	if value == nil {
		return ""
	}
	return *value
}

func marshalStringMap(value map[string]string) string {
	if len(value) == 0 {
		return "{}"
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(encoded)
}
