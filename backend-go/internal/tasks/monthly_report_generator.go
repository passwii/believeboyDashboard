package tasks

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

const (
	defaultMonthlyReportInputLimit = int64(50 * 1024 * 1024)
	monthlyReportProjectLimit      = 80
	monthlyReportFilenameLimit     = 120
)

type MonthlyReportGenerationInput struct {
	JobID             int64
	ProjectID         int64
	ProjectName       string
	Country           string
	ReportMonth       string
	TransactionFileID string
}

type FileMonthlyReportGenerator struct {
	uploadRoot    string
	resultRoot    string
	maxInputBytes int64
}

func NewFileMonthlyReportGenerator(uploadRoot, resultRoot string) *FileMonthlyReportGenerator {
	return NewFileMonthlyReportGeneratorWithLimit(
		uploadRoot,
		resultRoot,
		defaultMonthlyReportInputLimit,
	)
}

func NewFileMonthlyReportGeneratorWithLimit(
	uploadRoot string,
	resultRoot string,
	maxInputBytes int64,
) *FileMonthlyReportGenerator {
	return &FileMonthlyReportGenerator{
		uploadRoot:    uploadRoot,
		resultRoot:    resultRoot,
		maxInputBytes: maxInputBytes,
	}
}

func (generator *FileMonthlyReportGenerator) Generate(
	ctx context.Context,
	input MonthlyReportGenerationInput,
) (*store.MonthlyReportComputedResult, error) {
	if ctx == nil {
		return nil, errors.New("monthly report context is required")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	normalized, err := validateMonthlyReportGenerationInput(input)
	if err != nil {
		return nil, err
	}
	if generator == nil {
		return nil, fmt.Errorf("%w: monthly report generator", ErrDependencyNotConfigured)
	}
	limit := generator.maxInputBytes
	if limit <= 0 {
		return nil, errors.New("monthly report input size limit must be positive")
	}

	data, _, err := generator.resolveTransactionCSV(normalized)
	if err != nil {
		return nil, err
	}
	rows, detectedLocale, err := parseMonthlyPaymentCSV(data, normalized.Country)
	if err != nil {
		return nil, err
	}
	if err := validateMonthlyPaymentRows(rows, normalized.Country, normalized.ReportMonth, detectedLocale); err != nil {
		return nil, err
	}
	classified := classifyMonthlyPaymentRows(rows)
	pt3, pt4 := computeMonthlyFinancialMetrics(classified, normalized.Country)
	computedTransactions := buildMonthlyReportComputedTransactions(rows)
	resultPath, err := generator.writeWorkbook(
		normalized,
		rows,
		classified,
		pt3,
		pt4,
	)
	if err != nil {
		return nil, err
	}

	return &store.MonthlyReportComputedResult{
		ResultPath:   resultPath,
		Transactions: computedTransactions,
		PT3:          formatMonthlyAmountMap(pt3),
		PT4:          formatMonthlyAmountMap(pt4),
		SettlementID: firstMonthlySettlementID(rows),
	}, nil
}

func validateMonthlyReportGenerationInput(
	input MonthlyReportGenerationInput,
) (MonthlyReportGenerationInput, error) {
	if input.JobID <= 0 {
		return input, errors.New("monthly report job_id must be positive")
	}
	if input.ProjectID <= 0 {
		return input, errors.New("monthly report project_id must be positive")
	}
	input.ProjectName = strings.TrimSpace(input.ProjectName)
	if input.ProjectName == "" {
		return input, errors.New("monthly report project_name is required")
	}
	if strings.IndexFunc(input.ProjectName, unicode.IsControl) >= 0 {
		return input, errors.New("monthly report project_name contains control characters")
	}
	country, err := normalizeTaskCountry(input.Country)
	if err != nil {
		return input, err
	}
	input.Country = country
	month := strings.TrimSpace(input.ReportMonth)
	parsed, err := time.Parse("2006-01", month)
	if err != nil || parsed.Format("2006-01") != month {
		return input, errors.New("monthly report report_month must be YYYY-MM")
	}
	input.ReportMonth = month
	input.TransactionFileID = strings.TrimSpace(input.TransactionFileID)
	if input.TransactionFileID == "" {
		return input, errors.New("monthly report transaction_file_id is required")
	}
	if strings.IndexFunc(input.TransactionFileID, unicode.IsControl) >= 0 ||
		strings.ContainsAny(input.TransactionFileID, `/\`) ||
		input.TransactionFileID == "." ||
		input.TransactionFileID == ".." ||
		filepath.Base(input.TransactionFileID) != input.TransactionFileID {
		return input, errors.New("monthly report transaction_file_id must be a safe filename")
	}
	return input, nil
}

func normalizeTaskCountry(value string) (string, error) {
	normalized := strings.ToUpper(strings.TrimSpace(value))
	switch normalized {
	case "", "US", "USA", "美国", "美国站":
		return "US", nil
	case "DE", "GERMANY", "德国", "德国站":
		return "DE", nil
	case "UK", "GB", "UNITED KINGDOM", "英国", "英国站":
		return "UK", nil
	default:
		return "", errors.New("monthly report country must be one of US, DE, UK")
	}
}

func (generator *FileMonthlyReportGenerator) resolveTransactionCSV(
	input MonthlyReportGenerationInput,
) ([]byte, string, error) {
	root, err := controlledDirectory(generator.uploadRoot, false)
	if err != nil {
		return nil, "", fmt.Errorf("resolve monthly report upload root: %w", err)
	}
	projectFolder := safeMonthlyProjectFolder(input.ProjectName)
	for _, typeFolder := range []string{"payment-report", "payment_report"} {
		relative := filepath.Join(projectFolder, typeFolder, input.TransactionFileID)
		candidate, err := controlledRegularFile(root, relative)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, "", err
		}
		if strings.ToLower(filepath.Ext(candidate)) != ".csv" {
			return nil, "", fmt.Errorf("monthly report transaction file extension must be .csv")
		}
		info, err := os.Lstat(candidate)
		if err != nil {
			return nil, "", fmt.Errorf("stat monthly report transaction file: %w", err)
		}
		if info.Size() > generator.maxInputBytes {
			return nil, "", fmt.Errorf(
				"monthly report transaction file size %d exceeds limit %d",
				info.Size(),
				generator.maxInputBytes,
			)
		}
		file, err := os.Open(candidate)
		if err != nil {
			return nil, "", fmt.Errorf("open monthly report transaction file: %w", err)
		}
		defer file.Close()
		openedInfo, err := file.Stat()
		if err != nil {
			return nil, "", fmt.Errorf("stat opened monthly report transaction file: %w", err)
		}
		if !os.SameFile(info, openedInfo) {
			return nil, "", errors.New("monthly report transaction file changed while opening")
		}
		data, err := io.ReadAll(io.LimitReader(file, generator.maxInputBytes+1))
		if err != nil {
			return nil, "", fmt.Errorf("read monthly report transaction file: %w", err)
		}
		if int64(len(data)) > generator.maxInputBytes {
			return nil, "", fmt.Errorf(
				"monthly report transaction file size exceeds limit %d",
				generator.maxInputBytes,
			)
		}
		return data, candidate, nil
	}
	return nil, "", fmt.Errorf(
		"monthly report transaction file not found: %s",
		input.TransactionFileID,
	)
}

func controlledDirectory(root string, create bool) (string, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return "", errors.New("root path is required")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	if create {
		if err := os.MkdirAll(absolute, 0o700); err != nil {
			return "", err
		}
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("root path must be a directory")
	}
	return resolved, nil
}

func controlledRegularFile(root, relative string) (string, error) {
	relative = filepath.Clean(relative)
	if filepath.IsAbs(relative) || relative == "." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("relative path escapes controlled root")
	}
	parts := strings.Split(relative, string(filepath.Separator))
	current := root
	for _, part := range parts {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("monthly report path contains symlink: %s", current)
		}
	}
	info, err := os.Lstat(filepath.Join(root, relative))
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("monthly report transaction path must be a regular file")
	}
	resolved, err := filepath.EvalSymlinks(filepath.Join(root, relative))
	if err != nil {
		return "", err
	}
	if !pathWithinDirectory(root, resolved) {
		return "", errors.New("monthly report transaction path escapes controlled root")
	}
	return resolved, nil
}

func safeMonthlyProjectFolder(value string) string {
	var builder strings.Builder
	for _, character := range strings.TrimSpace(value) {
		switch {
		case strings.ContainsRune(`\/:*?"<>|`, character), unicode.IsControl(character):
			builder.WriteByte('-')
		case unicode.IsSpace(character):
			builder.WriteByte('-')
		default:
			builder.WriteRune(character)
		}
	}
	safe := strings.Trim(builder.String(), " .-")
	if safe == "" {
		safe = "project"
	}
	runes := []rune(safe)
	if len(runes) > monthlyReportProjectLimit {
		safe = string(runes[:monthlyReportProjectLimit])
	}
	return safe
}

func pathWithinDirectory(root, candidate string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(candidate))
	if err != nil || filepath.IsAbs(relative) {
		return false
	}
	return relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func safeMonthlyReportFilename(projectName, reportMonth string) string {
	var builder strings.Builder
	for _, character := range strings.TrimSpace(projectName) {
		switch {
		case strings.ContainsRune(`\/:*?"<>|`, character), unicode.IsControl(character):
			continue
		default:
			builder.WriteRune(character)
		}
	}
	project := strings.TrimSpace(builder.String())
	if project == "" {
		project = "unknown"
	}
	name := project + "_Monthly_Report_" + strings.TrimSpace(reportMonth) + ".xlsx"
	runes := []rune(name)
	if len(runes) > monthlyReportFilenameLimit {
		suffix := "_Monthly_Report_" + strings.TrimSpace(reportMonth) + ".xlsx"
		maxProjectRunes := monthlyReportFilenameLimit - len([]rune(suffix))
		if maxProjectRunes < 1 {
			maxProjectRunes = 1
		}
		name = string([]rune(project)[:maxProjectRunes]) + suffix
	}
	if filepath.Base(name) != name {
		return "monthly-report.xlsx"
	}
	return name
}

func (generator *FileMonthlyReportGenerator) writeWorkbook(
	input MonthlyReportGenerationInput,
	rows []*monthlyPaymentRow,
	classified monthlyClassifiedRows,
	pt3, pt4 monthlyAmountMap,
) (string, error) {
	root, err := controlledDirectory(generator.resultRoot, true)
	if err != nil {
		return "", fmt.Errorf("resolve monthly report result root: %w", err)
	}
	jobDir := filepath.Join(root, fmt.Sprintf("%d", input.JobID))
	if info, err := os.Lstat(jobDir); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return "", errors.New("monthly report job result directory is unsafe")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if err := os.MkdirAll(jobDir, 0o700); err != nil {
		return "", fmt.Errorf("create monthly report job directory: %w", err)
	}
	if err := os.Chmod(jobDir, 0o700); err != nil {
		return "", fmt.Errorf("secure monthly report job directory: %w", err)
	}

	filename := safeMonthlyReportFilename(input.ProjectName, input.ReportMonth)
	workbookData, err := buildMonthlyReportWorkbook(
		input,
		rows,
		classified,
		pt3,
		pt4,
	)
	if err != nil {
		return "", err
	}
	temporary, err := os.CreateTemp(jobDir, ".monthly-report-*.xlsx")
	if err != nil {
		return "", fmt.Errorf("create temporary monthly report workbook: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return "", fmt.Errorf("secure temporary monthly report workbook: %w", err)
	}
	if _, err := temporary.Write(workbookData); err != nil {
		_ = temporary.Close()
		return "", fmt.Errorf("write monthly report workbook: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return "", fmt.Errorf("sync monthly report workbook: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return "", fmt.Errorf("close monthly report workbook: %w", err)
	}

	destination := filepath.Join(jobDir, filename)
	if info, err := os.Lstat(destination); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return "", errors.New("monthly report destination path is unsafe")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		return "", fmt.Errorf("publish monthly report workbook: %w", err)
	}
	return destination, nil
}

func firstMonthlySettlementID(rows []*monthlyPaymentRow) string {
	for _, row := range rows {
		if value := strings.TrimSpace(row.fields["settlement id"]); value != "" {
			return value
		}
	}
	return ""
}

func buildMonthlyReportComputedTransactions(rows []*monthlyPaymentRow) []store.MonthlyReportComputedTransaction {
	transactions := make([]store.MonthlyReportComputedTransaction, 0, len(rows))
	for index, row := range rows {
		rawJSON, err := row.rawJSON()
		if err != nil {
			rawJSON = []byte("{}")
		}
		transactions = append(transactions, store.MonthlyReportComputedTransaction{
			SourceRowNo:            index + 1,
			TransactionDate:        row.transactionDate,
			SettlementID:           row.fields["settlement id"],
			TransactionType:        row.fields["type"],
			OrderID:                row.fields["order id"],
			SKU:                    row.fields["sku"],
			Description:            row.fields["description"],
			Quantity:               row.quantity,
			Marketplace:            row.fields["marketplace"],
			AccountType:            row.fields["account type"],
			Fulfillment:            row.fields["fulfillment"],
			OrderCity:              row.fields["order city"],
			OrderState:             row.fields["order state"],
			OrderPostal:            row.fields["order postal"],
			TaxCollectionModel:     row.fields["tax collection model"],
			ProductSales:           row.displayAmount("product sales"),
			ProductSalesTax:        row.displayAmount("product sales tax"),
			ShippingCredits:        row.displayAmount("shipping credits"),
			ShippingCreditsTax:     row.displayAmount("shipping credits tax"),
			GiftWrapCredits:        row.displayAmount("gift wrap credits"),
			GiftWrapCreditsTax:     row.displayAmount("giftwrap credits tax"),
			RegulatoryFee:          row.displayAmount("regulatory fee"),
			RegulatoryFeeTax:       row.displayAmount("tax on regulatory fee"),
			PromotionalRebates:     row.displayAmount("promotional rebates"),
			PromotionalRebatesTax:  row.displayAmount("promotional rebates tax"),
			MarketplaceWithheldTax: row.displayAmount("marketplace withheld tax"),
			SellingFees:            row.displayAmount("selling fees"),
			FBAFees:                row.displayAmount("fba fees"),
			OtherTransactionFees:   row.displayAmount("other transaction fees"),
			OtherAmount:            row.displayAmount("other"),
			Total:                  row.displayAmount("total"),
			RawRowJSON:             rawJSON,
		})
	}
	return transactions
}
