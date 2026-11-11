package store

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/category_research"
)

func (s *CategoryResearchStore) buildCategoryBundleZip(ctx context.Context, dataset category_research.CategoryResearchDatasetItem, overview category_research.CategoryResearchOverviewResponse, products []category_research.CategoryResearchProductRow, trends []categoryTrendMetricRow) ([]byte, error) {
	baseSlug := categoryExportBaseSlug(dataset)
	parts := make([]categoryBundlePart, 0, 4)
	summaryPDF, err := s.buildCategorySummaryPDF(ctx, dataset, overview)
	if err == nil {
		parts = append(parts, categoryBundlePart{Name: baseSlug + "-summary.pdf", Data: summaryPDF})
	}
	workbookSheets := buildCategoryOverviewExportSheets(overview)
	workbook, err := buildCategoryXLSX(workbookSheets)
	if err != nil {
		return nil, err
	}
	parts = append(parts, categoryBundlePart{Name: baseSlug + "-analysis.xlsx", Data: workbook})
	productCSV, err := rowsToCSVAny(buildCategoryProductExportRows(products))
	if err != nil {
		return nil, err
	}
	parts = append(parts, categoryBundlePart{Name: baseSlug + "-products.csv", Data: productCSV})
	trendCSV, err := rowsToCSVAny(buildCategoryTrendExportRows(trends))
	if err != nil {
		return nil, err
	}
	parts = append(parts, categoryBundlePart{Name: baseSlug + "-trends.csv", Data: trendCSV})
	if strings.TrimSpace(dataset.UploadFilePath) != "" {
		if raw, readErr := os.ReadFile(filepath.Clean(dataset.UploadFilePath)); readErr == nil {
			parts = append(parts, categoryBundlePart{Name: baseSlug + "-raw.xlsx", Data: raw})
		}
	}
	return buildCategoryBundleArchive(parts)
}

type categoryBundlePart struct {
	Name string
	Data []byte
}

func buildCategoryBundleArchive(parts []categoryBundlePart) ([]byte, error) {
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, part := range parts {
		entry, err := writer.Create(part.Name)
		if err != nil {
			return nil, err
		}
		if _, err := entry.Write(part.Data); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func rowsToCSVAny(rows [][]any) ([]byte, error) {
	converted := make([][]string, 0, len(rows))
	for _, row := range rows {
		values := make([]string, 0, len(row))
		for _, cell := range row {
			if cell == nil {
				values = append(values, "")
				continue
			}
			values = append(values, fmt.Sprint(cell))
		}
		converted = append(converted, values)
	}
	return rowsToCSV(converted)
}

func rowsToCSV(rows [][]string) ([]byte, error) {
	var buffer bytes.Buffer
	writer := csv.NewWriter(&buffer)
	writer.Comma = ','
	for _, row := range rows {
		if err := writer.Write(row); err != nil {
			return nil, err
		}
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func categoryExportBaseSlug(dataset category_research.CategoryResearchDatasetItem) string {
	keywordSlug := safeStoragePathSegment(dataset.CategoryKeywordEn, "category-research")
	return fmt.Sprintf("category-research-%s-%s-v%d", strings.ToLower(dataset.Marketplace), keywordSlug, dataset.Version)
}
