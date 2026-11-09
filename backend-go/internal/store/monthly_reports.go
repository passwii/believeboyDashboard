package store

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"mime"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/monthly_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type MonthlyReportStore struct {
	db         FullDB
	resultRoot string
	uploadRoot string
}

// MonthlyReportComputedResult is the worker-owned calculation artifact that
// FinalizeCompletedReport persists atomically with the report row.
type MonthlyReportComputedResult struct {
	ResultPath   string
	Transactions []MonthlyReportComputedTransaction
	PT3          map[string]string
	PT4          map[string]string
	SettlementID string
}

type MonthlyReportComputedTransaction struct {
	SourceRowNo            int
	TransactionDate        time.Time
	SettlementID           string
	TransactionType        string
	OrderID                string
	SKU                    string
	Description            string
	Quantity               int
	Marketplace            string
	AccountType            string
	Fulfillment            string
	OrderCity              string
	OrderState             string
	OrderPostal            string
	TaxCollectionModel     string
	ProductSales           string
	ProductSalesTax        string
	ShippingCredits        string
	ShippingCreditsTax     string
	GiftWrapCredits        string
	GiftWrapCreditsTax     string
	RegulatoryFee          string
	RegulatoryFeeTax       string
	PromotionalRebates     string
	PromotionalRebatesTax  string
	MarketplaceWithheldTax string
	SellingFees            string
	FBAFees                string
	OtherTransactionFees   string
	OtherAmount            string
	Total                  string
	RawRowJSON             []byte
}

const monthlyReportJobType = "monthly_report"

type monthlyReportJobPayload struct {
	JobType string                 `json:"job_type"`
	FileID  string                 `json:"file_id"`
	Params  monthlyReportJobParams `json:"params"`
}

type monthlyReportJobParams struct {
	ReportID          int64   `json:"report_id"`
	ProjectID         int64   `json:"project_id"`
	ProjectName       string  `json:"project_name"`
	Country           string  `json:"country"`
	ReportMonth       string  `json:"report_month"`
	TransactionFileID string  `json:"transaction_file_id"`
	SummaryPDFFileID  *string `json:"summary_pdf_file_id,omitempty"`
}

func NewMonthlyReportStore(db FullDB) *MonthlyReportStore {
	return NewMonthlyReportStoreWithRoots(
		db,
		storageRoot("MONTHLY_REPORT_RESULT_ROOT", "backend/storage/results"),
		storageRoot("UPLOAD_ROOT", "backend/storage/uploads"),
	)
}

func NewMonthlyReportStoreWithRoots(
	db FullDB,
	resultRoot string,
	uploadRoot string,
) *MonthlyReportStore {
	return &MonthlyReportStore{
		db:         db,
		resultRoot: strings.TrimSpace(resultRoot),
		uploadRoot: strings.TrimSpace(uploadRoot),
	}
}

func (s *MonthlyReportStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, monthly_reports.Store) error,
) error {
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txStore := NewMonthlyReportStoreWithRoots(
			NewTxDB(tx),
			s.resultRoot,
			s.uploadRoot,
		)
		return fn(ctx, tx, txStore)
	})
}

func (s *MonthlyReportStore) VerifyProjectAccess(
	ctx context.Context,
	projectID int64,
	operator string,
	isAdmin bool,
) error {
	var projectOperator, assistantOperator *string
	err := s.db.QueryRow(
		ctx,
		`select project_operator, assistant_operator
		 from public.projects
		 where id = $1`,
		projectID,
	).Scan(&projectOperator, &assistantOperator)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return monthly_reports.ErrProjectNotFound
		}
		return err
	}
	if isAdmin {
		return nil
	}

	operator = strings.TrimSpace(operator)
	if operator == "" {
		return monthly_reports.ErrProjectForbidden
	}
	if textContainsName(projectOperator, operator) || textContainsName(assistantOperator, operator) {
		return nil
	}
	return monthly_reports.ErrProjectForbidden
}

func (s *MonthlyReportStore) List(
	ctx context.Context,
	filter monthly_reports.MonthlyReportListFilter,
) ([]monthly_reports.MonthlyReport, error) {
	if filter.ProjectID != nil {
		if err := s.VerifyProjectAccess(
			ctx,
			*filter.ProjectID,
			filter.Operator,
			filter.IsAdmin,
		); err != nil {
			return nil, err
		}
	}

	where := make([]string, 0, 5)
	args := make([]any, 0, 5)
	nextArg := func(value any) string {
		args = append(args, value)
		return fmt.Sprintf("$%d", len(args))
	}

	if filter.ProjectID != nil {
		where = append(where, "r.project_id = "+nextArg(*filter.ProjectID))
	} else if !filter.IsAdmin {
		projectIDs, err := s.AccessibleProjectIDs(ctx, filter.Operator)
		if err != nil {
			return nil, err
		}
		if len(projectIDs) == 0 {
			return []monthly_reports.MonthlyReport{}, nil
		}
		where = append(where, "r.project_id = any("+nextArg(projectIDs)+")")
	}
	if !filter.IncludeHistory {
		where = append(where, "r.is_current = true")
	}
	if filter.Country != nil {
		where = append(where, "r.country = "+nextArg(*filter.Country))
	}
	if filter.ReportMonth != nil {
		where = append(where, "r.report_month = "+nextArg(*filter.ReportMonth))
	}
	if filter.Year != nil {
		where = append(
			where,
			"substring(r.report_month from 1 for 4) = "+nextArg(strconv.Itoa(*filter.Year)),
		)
	}
	if filter.Month != nil {
		where = append(
			where,
			"substring(r.report_month from 6 for 2) = lpad("+nextArg(strconv.Itoa(*filter.Month))+", 2, '0')",
		)
	}
	if filter.Status != nil {
		status, err := databaseStatus(*filter.Status)
		if err != nil {
			return nil, err
		}
		where = append(where, "r.status::text = "+nextArg(status))
	}

	whereSQL := ""
	if len(where) > 0 {
		whereSQL = "where " + strings.Join(where, "\n  and ")
	}
	paginationSQL := ""
	if filter.Limit != nil {
		paginationSQL += "\n\t\t limit " + nextArg(*filter.Limit)
		if filter.Offset > 0 {
			paginationSQL += " offset " + nextArg(filter.Offset)
		}
	} else if filter.Offset > 0 {
		paginationSQL += "\n\t\t limit all offset " + nextArg(filter.Offset)
	}
	rows, err := s.db.Query(
		ctx,
		monthlyReportBaseSelect+`
		 from public.monthly_reports r
		 join public.projects p on p.id = r.project_id
		`+whereSQL+`
		 order by r.report_month desc, r.id desc`+paginationSQL,
		args...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]monthly_reports.MonthlyReport, 0)
	for rows.Next() {
		item, scanErr := scanMonthlyReport(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *MonthlyReportStore) GetReport(
	ctx context.Context,
	reportID int64,
) (*monthly_reports.MonthlyReportDetail, error) {
	var projectOperator, assistantOperator *string
	report, err := scanMonthlyReportWithProject(
		s.db.QueryRow(
			ctx,
			monthlyReportBaseSelect+`,
			       p.project_operator, p.assistant_operator
			 from public.monthly_reports r
			 join public.projects p on p.id = r.project_id
			 where r.id = $1`,
			reportID,
		),
		&projectOperator,
		&assistantOperator,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, monthly_reports.ErrReportNotFound
		}
		return nil, err
	}

	pt3, err := s.loadCalculationMap(ctx, monthlyReportPT3CalculationTable, reportID)
	if err != nil {
		return nil, err
	}
	pt4, err := s.loadCalculationMap(ctx, monthlyReportPT4CalculationTable, reportID)
	if err != nil {
		return nil, err
	}

	fobCost, firstLegCost, err := s.loadPurchaseCosts(
		ctx,
		report.ProjectID,
		report.Country,
		reportID,
	)
	if err != nil {
		return nil, err
	}
	exchangeRate, err := s.loadExchangeRate(
		ctx,
		countryCurrency(report.Country),
		report.ReportMonth,
	)
	if err != nil {
		return nil, err
	}

	year, month := splitReportMonth(report.ReportMonth)
	detail := buildMonthlyReportDetail(
		*report,
		projectOperator,
		assistantOperator,
		pt3,
		pt4,
		fobCost,
		firstLegCost,
		exchangeRate,
	)
	detail.Year = year
	detail.Month = month
	return detail, nil
}

func (s *MonthlyReportStore) Generate(
	ctx context.Context,
	input monthly_reports.MonthlyReportGenerateInput,
) (*monthly_reports.MonthlyReport, error) {
	var generated *monthly_reports.MonthlyReport
	err := s.RunInTx(ctx, func(
		txCtx context.Context,
		_ pgx.Tx,
		txStore monthly_reports.Store,
	) error {
		transactionStore, ok := txStore.(*MonthlyReportStore)
		if !ok {
			return errors.New("monthly report transaction store has unexpected type")
		}
		var generateErr error
		generated, generateErr = transactionStore.generate(txCtx, input)
		return generateErr
	})
	if err != nil {
		return nil, err
	}
	return generated, nil
}

func (s *MonthlyReportStore) MarkGenerationFailed(
	ctx context.Context,
	reportID, jobID int64,
	message string,
) error {
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		if _, err := txDB.Exec(
			ctx,
			`update public.monthly_reports
			 set status = 'failed'::public.jobstatus,
			     error_message = $2,
			     updated_at = now()
			 where id = $1`,
			reportID,
			message,
		); err != nil {
			return fmt.Errorf("mark monthly report failed: %w", err)
		}
		if jobID > 0 {
			if _, err := txDB.Exec(
				ctx,
				`update public.jobs
				 set status = 'failed'::public.jobstatus,
				     updated_at = now()
				 where id = $1`,
				jobID,
			); err != nil {
				return fmt.Errorf("mark monthly report job failed: %w", err)
			}
		}
		return nil
	})
}

func (s *MonthlyReportStore) PromoteCompletedReport(
	ctx context.Context,
	reportID int64,
) error {
	return s.RunInTx(ctx, func(
		txCtx context.Context,
		_ pgx.Tx,
		txStore monthly_reports.Store,
	) error {
		transactionStore, ok := txStore.(*MonthlyReportStore)
		if !ok {
			return errors.New("monthly report transaction store has unexpected type")
		}
		return transactionStore.promoteCompletedReport(txCtx, reportID)
	})
}

func (s *MonthlyReportStore) FinalizeCompletedReport(
	ctx context.Context,
	reportID int64,
	jobID int64,
	result MonthlyReportComputedResult,
) error {
	if reportID <= 0 {
		return errors.New("monthly report id must be positive")
	}
	if jobID <= 0 {
		return errors.New("monthly report job id must be positive")
	}
	if err := validateMonthlyReportComputedResult(result); err != nil {
		return err
	}
	resultPath, err := s.validateMonthlyReportWorkbook(result.ResultPath)
	if err != nil {
		return err
	}
	result.ResultPath = resultPath

	return s.RunInTx(ctx, func(
		txCtx context.Context,
		tx pgx.Tx,
		txStore monthly_reports.Store,
	) error {
		transactionStore, ok := txStore.(*MonthlyReportStore)
		if !ok {
			return errors.New("monthly report transaction store has unexpected type")
		}

		var projectID int64
		var projectName, country, reportMonth, status string
		var supersededAt *time.Time
		if err := transactionStore.db.QueryRow(
			txCtx,
			`select project_id, project_name, country, report_month,
			        status::text, superseded_at
			 from public.monthly_reports
			 where id = $1
			 for update`,
			reportID,
		).Scan(
			&projectID,
			&projectName,
			&country,
			&reportMonth,
			&status,
			&supersededAt,
		); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return monthly_reports.ErrReportNotFound
			}
			return err
		}
		if status == "failed" || supersededAt != nil {
			return monthly_reports.ErrReportNotReady
		}

		lockKey := fmt.Sprintf("monthly_report:%d:%s:%s", projectID, country, reportMonth)
		var locked int
		if err := transactionStore.db.QueryRow(
			txCtx,
			`select 1
			 from (select pg_advisory_xact_lock(hashtext($1))) as report_lock`,
			lockKey,
		).Scan(&locked); err != nil {
			return err
		}

		for _, table := range []string{
			"monthly_report_transactions",
			"monthly_report_pt3_calculation",
			"monthly_report_pt4_calculation",
		} {
			if _, err := transactionStore.db.Exec(
				txCtx,
				`delete from public.`+table+` where report_id = $1`,
				reportID,
			); err != nil {
				return fmt.Errorf("clear monthly report %s: %w", table, err)
			}
		}

		if err := insertMonthlyReportTransactions(
			txCtx,
			transactionStore.db,
			reportID,
			projectName,
			reportMonth,
			result.Transactions,
		); err != nil {
			return err
		}
		if err := insertMonthlyReportPT3(
			txCtx,
			transactionStore.db,
			reportID,
			projectName,
			reportMonth,
			result.PT3,
		); err != nil {
			return err
		}
		if err := insertMonthlyReportPT4(
			txCtx,
			transactionStore.db,
			reportID,
			projectName,
			reportMonth,
			result.PT4,
		); err != nil {
			return err
		}

		now := time.Now().UTC()
		settlementID := firstNonEmptyComputedSettlementID(result)
		tag, err := transactionStore.db.Exec(
			txCtx,
			`update public.monthly_reports
			 set status = 'success',
			     result_file_path = $2,
			     settlement_id = nullif($3, ''),
			     error_message = null,
			     computed_at = $4,
			     updated_at = $4,
			     calculation_version = greatest(calculation_version, 1),
			     total_transactions = $5,
			     total_orders = $6,
			     total_refunds = $7,
			     total_adjustments = $8,
			     total_service_fees = $9,
			     total_trans_fees = $10
			 where id = $1`,
			reportID,
			resultPath,
			settlementID,
			now,
			len(result.Transactions),
			countComputedTransactions(result.Transactions, "Order"),
			countComputedTransactions(result.Transactions, "Refund"),
			countComputedTransactions(result.Transactions, "Adjustment"),
			countComputedTransactions(result.Transactions, "Service Fee"),
			countComputedTransactions(result.Transactions, "FBA Transaction Fees"),
		)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return monthly_reports.ErrReportNotFound
		}

		if err := transactionStore.promoteCompletedReport(txCtx, reportID); err != nil {
			return err
		}

		if _, err := transactionStore.db.Exec(
			txCtx,
			`update public.jobs
			 set updated_at = $2
			 where id = $1`,
			jobID,
			now,
		); err != nil {
			return err
		}
		return nil
	})
}

func (s *MonthlyReportStore) validateMonthlyReportWorkbook(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("monthly report result path is required")
	}
	if !filepath.IsAbs(path) {
		return "", errors.New("monthly report result path must be absolute")
	}
	resolved := existingRegularFile(&path, s.resultRoot)
	if resolved == "" {
		return "", errors.New("monthly report result path is missing or outside the controlled result root")
	}
	if strings.ToLower(filepath.Ext(resolved)) != ".xlsx" {
		return "", errors.New("monthly report result path must use the .xlsx extension")
	}
	file, err := os.Open(resolved)
	if err != nil {
		return "", fmt.Errorf("open monthly report workbook: %w", err)
	}
	defer file.Close()

	var magic [4]byte
	if _, err := file.Read(magic[:]); err != nil {
		return "", fmt.Errorf("read monthly report workbook header: %w", err)
	}
	if !bytes.Equal(magic[:], []byte{'P', 'K', 0x03, 0x04}) {
		return "", errors.New("monthly report result is not an xlsx zip archive")
	}
	return resolved, nil
}

func validateMonthlyReportComputedResult(result MonthlyReportComputedResult) error {
	if strings.TrimSpace(result.ResultPath) == "" {
		return errors.New("monthly report result path is required")
	}
	if len(result.PT3) == 0 {
		return errors.New("monthly report PT3 payload is required")
	}
	if len(result.PT4) == 0 {
		return errors.New("monthly report PT4 payload is required")
	}
	for key, value := range result.PT3 {
		if err := validateMonthlyReportAmount(value); err != nil {
			return fmt.Errorf("monthly report PT3 %s: %w", key, err)
		}
	}
	for key, value := range result.PT4 {
		if err := validateMonthlyReportAmount(value); err != nil {
			return fmt.Errorf("monthly report PT4 %s: %w", key, err)
		}
	}
	for index, row := range result.Transactions {
		if row.TransactionDate.IsZero() {
			return fmt.Errorf("monthly report transaction %d date is required", index+1)
		}
		if strings.TrimSpace(row.TransactionType) == "" {
			return fmt.Errorf("monthly report transaction %d type is required", index+1)
		}
		if len(row.RawRowJSON) > 0 && !json.Valid(row.RawRowJSON) {
			return fmt.Errorf("monthly report transaction %d raw_row is invalid JSON", index+1)
		}
		for name, value := range map[string]string{
			"product sales":            row.ProductSales,
			"product sales tax":        row.ProductSalesTax,
			"shipping credits":         row.ShippingCredits,
			"shipping credits tax":     row.ShippingCreditsTax,
			"gift wrap credits":        row.GiftWrapCredits,
			"gift wrap credits tax":    row.GiftWrapCreditsTax,
			"regulatory fee":           row.RegulatoryFee,
			"regulatory fee tax":       row.RegulatoryFeeTax,
			"promotional rebates":      row.PromotionalRebates,
			"promotional rebates tax":  row.PromotionalRebatesTax,
			"marketplace withheld tax": row.MarketplaceWithheldTax,
			"selling fees":             row.SellingFees,
			"fba fees":                 row.FBAFees,
			"other transaction fees":   row.OtherTransactionFees,
			"other":                    row.OtherAmount,
			"total":                    row.Total,
		} {
			if err := validateMonthlyReportAmount(value); err != nil {
				return fmt.Errorf("monthly report transaction %d %s: %w", index+1, name, err)
			}
		}
	}
	return nil
}

func validateMonthlyReportAmount(value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	number, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
		return fmt.Errorf("invalid numeric value %q", value)
	}
	return nil
}

var monthlyReportTransactionColumns = []string{
	"report_id",
	"project_name",
	"report_month",
	"source_row_no",
	"transaction_date",
	"settlement_id",
	"transaction_type",
	"order_id",
	"sku",
	"description",
	"quantity",
	"marketplace",
	"account_type",
	"fulfillment",
	"order_city",
	"order_state",
	"order_postal",
	"tax_collection_model",
	"product_sales",
	"product_sales_tax",
	"shipping_credits",
	"shipping_credits_tax",
	"gift_wrap_credits",
	"gift_wrap_credits_tax",
	"regulatory_fee",
	"regulatory_fee_tax",
	"promotional_rebates",
	"promotional_rebates_tax",
	"marketplace_withheld_tax",
	"selling_fees",
	"fba_fees",
	"other_transaction_fees",
	"other_amount",
	"total",
	"raw_row",
}

func insertMonthlyReportTransactions(
	ctx context.Context,
	db Execer,
	reportID int64,
	projectName string,
	reportMonth string,
	rows []MonthlyReportComputedTransaction,
) error {
	const chunkSize = 100
	for start := 0; start < len(rows); start += chunkSize {
		end := start + chunkSize
		if end > len(rows) {
			end = len(rows)
		}
		var sql strings.Builder
		sql.WriteString("insert into public.monthly_report_transactions (")
		sql.WriteString(strings.Join(monthlyReportTransactionColumns, ", "))
		sql.WriteString(") values ")
		args := make([]any, 0, (end-start)*len(monthlyReportTransactionColumns))
		for index := start; index < end; index++ {
			if index > start {
				sql.WriteString(", ")
			}
			sql.WriteString("(")
			row := rows[index]
			rawRow := row.RawRowJSON
			if len(rawRow) == 0 {
				rawRow = []byte("{}")
			}
			values := []any{
				reportID,
				projectName,
				reportMonth,
				row.SourceRowNo,
				row.TransactionDate,
				nullableMonthlyReportText(row.SettlementID),
				strings.TrimSpace(row.TransactionType),
				nullableMonthlyReportText(row.OrderID),
				nullableMonthlyReportText(row.SKU),
				nullableMonthlyReportText(row.Description),
				row.Quantity,
				nullableMonthlyReportText(row.Marketplace),
				nullableMonthlyReportText(row.AccountType),
				nullableMonthlyReportText(row.Fulfillment),
				nullableMonthlyReportText(row.OrderCity),
				nullableMonthlyReportText(row.OrderState),
				nullableMonthlyReportText(row.OrderPostal),
				nullableMonthlyReportText(row.TaxCollectionModel),
				monthlyReportNumeric(row.ProductSales),
				monthlyReportNumeric(row.ProductSalesTax),
				monthlyReportNumeric(row.ShippingCredits),
				monthlyReportNumeric(row.ShippingCreditsTax),
				monthlyReportNumeric(row.GiftWrapCredits),
				monthlyReportNumeric(row.GiftWrapCreditsTax),
				monthlyReportNumeric(row.RegulatoryFee),
				monthlyReportNumeric(row.RegulatoryFeeTax),
				monthlyReportNumeric(row.PromotionalRebates),
				monthlyReportNumeric(row.PromotionalRebatesTax),
				monthlyReportNumeric(row.MarketplaceWithheldTax),
				monthlyReportNumeric(row.SellingFees),
				monthlyReportNumeric(row.FBAFees),
				monthlyReportNumeric(row.OtherTransactionFees),
				monthlyReportNumeric(row.OtherAmount),
				monthlyReportNumeric(row.Total),
				rawRow,
			}
			if len(values) != len(monthlyReportTransactionColumns) {
				return errors.New("monthly report transaction payload column mismatch")
			}
			for valueIndex, value := range values {
				if valueIndex > 0 {
					sql.WriteString(", ")
				}
				args = append(args, value)
				sql.WriteString("$")
				sql.WriteString(strconv.Itoa(len(args)))
			}
			sql.WriteString(")")
		}
		if _, err := db.Exec(ctx, sql.String(), args...); err != nil {
			return fmt.Errorf("insert monthly report transactions: %w", err)
		}
	}
	return nil
}

var monthlyReportPT3Columns = []string{
	"income_product_sales_non_fba",
	"income_product_sale_refunds_non_fba",
	"income_fba_product_sales",
	"income_fba_product_sale_refunds",
	"income_fba_inventory_credit",
	"income_fba_liquidation_proceeds",
	"income_shipping_credits",
	"income_shipping_credit_refunds",
	"income_gift_wrap_credits",
	"income_gift_wrap_credits_refunds",
	"income_promotional_rebates",
	"income_promotional_rebate_refunds",
	"income_a_to_z_guarantee_claims",
	"income_chargebacks",
	"income_safe_t_reimbursement",
	"income_total",
	"income_vat_total",
	"income_sales_with_tax",
	"expense_seller_fulfilled_selling_fees",
	"expense_fba_selling_fees",
	"expense_selling_fee_refunds",
	"expense_fba_transaction_fees",
	"expense_fba_transaction_fee_refunds",
	"expense_other_transaction_fees",
	"expense_other_transaction_fee_refunds",
	"expense_fba_inventory_and_inbound_services_fees",
	"expense_shipping_label_purchases",
	"expense_shipping_label_refunds",
	"expense_carrier_shipping_label_adjustments",
	"expense_service_fees",
	"expense_refund_administration_fees",
	"expense_adjustments",
	"expense_cost_of_advertising",
	"expense_refund_for_advertiser",
	"expense_liquidations_fees",
	"expense_receivables",
	"expense_deductions",
	"expense_amazon_shipping_charge_adjustments",
	"expense_total",
	"amazon_pay_back",
	"advertising_percentage",
}

var monthlyReportPT4Columns = []string{
	"income_sales",
	"income_refund",
	"income_adjustment",
	"income_other",
	"income_total",
	"expense_selling_fee",
	"expense_fba_fee",
	"expense_inventory_fee",
	"expense_service_fee",
	"expense_advertising",
	"expense_other_fees",
	"expense_total",
	"expense_vat_total",
	"amazon_pay_back",
	"credit_card_deduction_usd",
}

func insertMonthlyReportPT3(
	ctx context.Context,
	db Execer,
	reportID int64,
	projectName string,
	reportMonth string,
	values map[string]string,
) error {
	return insertMonthlyReportCalculation(
		ctx,
		db,
		"monthly_report_pt3_calculation",
		monthlyReportPT3Columns,
		reportID,
		projectName,
		reportMonth,
		values,
	)
}

func insertMonthlyReportPT4(
	ctx context.Context,
	db Execer,
	reportID int64,
	projectName string,
	reportMonth string,
	values map[string]string,
) error {
	return insertMonthlyReportCalculation(
		ctx,
		db,
		"monthly_report_pt4_calculation",
		monthlyReportPT4Columns,
		reportID,
		projectName,
		reportMonth,
		values,
	)
}

func insertMonthlyReportCalculation(
	ctx context.Context,
	db Execer,
	table string,
	columns []string,
	reportID int64,
	projectName string,
	reportMonth string,
	values map[string]string,
) error {
	args := []any{reportID, projectName, reportMonth}
	payloadFields := []string{
		"'report_id', $1",
		"'project_name', $2",
		"'report_month', $3",
	}
	for _, column := range columns {
		args = append(args, monthlyReportNumeric(values[column]))
		payloadFields = append(
			payloadFields,
			"'"+column+"', $"+strconv.Itoa(len(args)),
		)
	}
	sql := "insert into public." + table + `
		select populated.*
		  from jsonb_populate_record(
		    null::public.` + table + `,
		    (jsonb_build_object(` + strings.Join(payloadFields, ", ") + `)
		      || jsonb_build_object(
		        'id', nextval(pg_get_serial_sequence('public.` + table + `', 'id')),
		        'calculation_version', 1,
		        'computed_at', now(),
		        'created_at', now(),
		        'updated_at', now()
		      )
		    )
		  ) populated`
	if _, err := db.Exec(ctx, sql, args...); err != nil {
		return fmt.Errorf("insert %s: %w", table, err)
	}
	return nil
}

func nullableMonthlyReportText(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return value
}

func monthlyReportAmountOrZero(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "0"
	}
	return value
}

func monthlyReportNumeric(value string) pgtype.Numeric {
	value = monthlyReportAmountOrZero(value)
	negative := strings.HasPrefix(value, "-")
	value = strings.TrimPrefix(value, "-")
	parts := strings.SplitN(value, ".", 2)
	integerPart := strings.TrimSpace(parts[0])
	if integerPart == "" {
		integerPart = "0"
	}
	fractionalDigits := 0
	digits := integerPart
	if len(parts) == 2 {
		fraction := strings.TrimSpace(parts[1])
		fractionalDigits = len(fraction)
		digits += fraction
	}
	digits = strings.TrimLeft(digits, "0")
	if digits == "" {
		digits = "0"
	}
	number, ok := new(big.Int).SetString(digits, 10)
	if !ok {
		number = big.NewInt(0)
	}
	if negative && number.Sign() != 0 {
		number.Neg(number)
	}
	return pgtype.Numeric{
		Int:   number,
		Exp:   -int32(fractionalDigits),
		Valid: true,
	}
}

func firstNonEmptyComputedSettlementID(result MonthlyReportComputedResult) string {
	if value := strings.TrimSpace(result.SettlementID); value != "" {
		return value
	}
	for _, row := range result.Transactions {
		if value := strings.TrimSpace(row.SettlementID); value != "" {
			return value
		}
	}
	return ""
}

func countComputedTransactions(rows []MonthlyReportComputedTransaction, transactionType string) int {
	count := 0
	for _, row := range rows {
		if strings.TrimSpace(row.TransactionType) == transactionType {
			count++
		}
	}
	return count
}

func (s *MonthlyReportStore) promoteCompletedReport(
	ctx context.Context,
	reportID int64,
) error {
	var projectID int64
	var country, reportMonth string
	if err := s.db.QueryRow(
		ctx,
		`select project_id, country, report_month
		 from public.monthly_reports
		 where id = $1`,
		reportID,
	).Scan(&projectID, &country, &reportMonth); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return monthly_reports.ErrReportNotFound
		}
		return err
	}

	lockKey := fmt.Sprintf("monthly_report:%d:%s:%s", projectID, country, reportMonth)
	var locked int
	if err := s.db.QueryRow(
		ctx,
		`select 1
		 from (select pg_advisory_xact_lock(hashtext($1))) as report_lock`,
		lockKey,
	).Scan(&locked); err != nil {
		return err
	}

	var status string
	var active bool
	if err := s.db.QueryRow(
		ctx,
		`select status::text, superseded_at is null
		 from public.monthly_reports
		 where id = $1
		 for update`,
		reportID,
	).Scan(&status, &active); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return monthly_reports.ErrReportNotFound
		}
		return err
	}
	if status != "success" || !active {
		return monthly_reports.ErrReportNotReady
	}

	if _, err := s.db.Exec(
		ctx,
		`update public.monthly_reports
		 set is_current = false,
		     superseded_at = now(),
		     updated_at = now()
		 where project_id = $1
		   and country = $2
		   and report_month = $3
		   and id <> $4
		   and is_current = true`,
		projectID,
		country,
		reportMonth,
		reportID,
	); err != nil {
		return fmt.Errorf("supersede current monthly reports: %w", err)
	}
	if _, err := s.db.Exec(
		ctx,
		`update public.monthly_reports
		 set is_current = true,
		     superseded_at = null,
		     updated_at = now()
		 where id = $1`,
		reportID,
	); err != nil {
		return fmt.Errorf("promote completed monthly report: %w", err)
	}
	return nil
}

func (s *MonthlyReportStore) generate(
	ctx context.Context,
	input monthly_reports.MonthlyReportGenerateInput,
) (*monthly_reports.MonthlyReport, error) {
	transactionFileID := strings.TrimSpace(dereferenceString(input.TransactionFileID))
	if transactionFileID == "" {
		return nil, monthly_reports.ErrTransactionFileRequired
	}
	summaryPDFFileID := trimOptionalString(input.SummaryPDFFileID)

	var projectID int64
	var projectName string
	var projectOperator, assistantOperator *string
	var err error
	if input.ProjectID != nil {
		err = s.db.QueryRow(
			ctx,
			`select id, project_name, project_operator, assistant_operator
			 from public.projects
			 where id = $1`,
			*input.ProjectID,
		).Scan(&projectID, &projectName, &projectOperator, &assistantOperator)
	} else {
		err = s.db.QueryRow(
			ctx,
			`select id, project_name, project_operator, assistant_operator
			 from public.projects
			 where project_name = $1`,
			strings.TrimSpace(dereferenceString(input.ProjectName)),
		).Scan(&projectID, &projectName, &projectOperator, &assistantOperator)
	}
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, monthly_reports.ErrProjectNotFound
		}
		return nil, err
	}
	if !input.IsAdmin {
		operator := strings.TrimSpace(input.Operator)
		if operator == "" ||
			(!textContainsName(projectOperator, operator) &&
				!textContainsName(assistantOperator, operator)) {
			return nil, monthly_reports.ErrProjectForbidden
		}
	}

	lockKey := fmt.Sprintf(
		"monthly_report:%d:%s:%s",
		projectID,
		input.Country,
		input.ReportMonth,
	)
	var locked int
	if err := s.db.QueryRow(
		ctx,
		`select 1
		 from (select pg_advisory_xact_lock(hashtext($1))) as report_lock`,
		lockKey,
	).Scan(&locked); err != nil {
		return nil, err
	}

	var latestVersion int
	if err := s.db.QueryRow(
		ctx,
		`select coalesce(max(version), 0)
		 from public.monthly_reports
		 where project_id = $1
		   and country = $2
		   and report_month = $3`,
		projectID,
		input.Country,
		input.ReportMonth,
	).Scan(&latestVersion); err != nil {
		return nil, err
	}
	nextVersion := latestVersion + 1

	var currentExists bool
	if err := s.db.QueryRow(
		ctx,
		`select exists(
		   select 1
		   from public.monthly_reports
		   where project_id = $1
		     and country = $2
		     and report_month = $3
		     and is_current = true
		 )`,
		projectID,
		input.Country,
		input.ReportMonth,
	).Scan(&currentExists); err != nil {
		return nil, err
	}

	isCurrent := !currentExists
	generationStatus := "pending"
	if !input.Async {
		generationStatus = "running"
	}

	report, err := scanMonthlyReport(s.db.QueryRow(
		ctx,
		`insert into public.monthly_reports (
		   project_id, project_name, country, report_month, version, is_current,
		   transaction_file_id, transaction_file_path, summary_pdf_file_id,
		   status, calculation_version, created_at, updated_at
		 )
		 values (
		   $1, $2, $3, $4, $5, $6,
		   $7, $8, $9,
		   $10::public.jobstatus, 1, now(), now()
		 )
		 returning
		   id, project_id, project_name, country, report_month, version, is_current,
		   superseded_at, status::text, settlement_id,
		   total_transactions, total_orders, total_refunds, total_adjustments,
		   total_service_fees, total_trans_fees,
		   result_file_path, error_message, calculation_version, computed_at,
		   created_at, updated_at, summary_pdf_file_path, summary_pdf_r2_url`,
		projectID,
		projectName,
		input.Country,
		input.ReportMonth,
		nextVersion,
		isCurrent,
		transactionFileID,
		"",
		summaryPDFFileID,
		generationStatus,
	))
	if err != nil {
		return nil, err
	}

	payload, err := json.Marshal(monthlyReportJobPayload{
		JobType: monthlyReportJobType,
		FileID:  transactionFileID,
		Params: monthlyReportJobParams{
			ReportID:          report.ID,
			ProjectID:         projectID,
			ProjectName:       projectName,
			Country:           input.Country,
			ReportMonth:       input.ReportMonth,
			TransactionFileID: transactionFileID,
			SummaryPDFFileID:  summaryPDFFileID,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("marshal monthly report job payload: %w", err)
	}
	var operator *string
	if trimmedOperator := strings.TrimSpace(input.Operator); trimmedOperator != "" {
		operator = &trimmedOperator
	}
	var jobID int64
	if err := s.db.QueryRow(
		ctx,
		`insert into public.jobs (
		   job_type, status, payload_json, operator, created_at, updated_at
		 )
		 values (
		   $1, 'pending'::public.jobstatus, $2::json, $3, now(), now()
		 )
		 returning id`,
		monthlyReportJobType,
		string(payload),
		operator,
	).Scan(&jobID); err != nil {
		return nil, fmt.Errorf("insert monthly report job: %w", err)
	}
	report.JobID = jobID
	return report, nil
}

func (s *MonthlyReportStore) GetStatus(
	ctx context.Context,
	reportID int64,
) (*monthly_reports.MonthlyReportStatusResponse, error) {
	var databaseStatusValue string
	var errorMessage *string
	var createdAt, updatedAt time.Time
	err := s.db.QueryRow(
		ctx,
		`select status::text, error_message, created_at, updated_at
		 from public.monthly_reports
		 where id = $1`,
		reportID,
	).Scan(&databaseStatusValue, &errorMessage, &createdAt, &updatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, monthly_reports.ErrReportNotFound
		}
		return nil, err
	}

	status := apiStatus(databaseStatusValue)
	stage, progress, message := statusProgress(status)
	return &monthly_reports.MonthlyReportStatusResponse{
		ReportID:     reportID,
		Status:       status,
		Stage:        stage,
		Progress:     progress,
		Message:      monthlyReportStringPointerValue(message),
		ErrorMessage: errorMessage,
		CreatedAt:    httpapi.Timestamp(createdAt),
		UpdatedAt:    httpapi.Timestamp(updatedAt),
	}, nil
}

func (s *MonthlyReportStore) ConfirmReport(
	ctx context.Context,
	reportID int64,
) (*monthly_reports.MonthlyReport, error) {
	var databaseStatusValue string
	err := s.db.QueryRow(
		ctx,
		`select status::text
		 from public.monthly_reports
		 where id = $1
		 for update`,
		reportID,
	).Scan(&databaseStatusValue)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, monthly_reports.ErrReportNotFound
		}
		return nil, err
	}
	if databaseStatusValue != "success" {
		return nil, monthly_reports.ErrReportNotReady
	}

	var alreadyConfirmed bool
	if err := s.db.QueryRow(
		ctx,
		`select exists(
		   select 1
		   from public.operation_audit_logs
		   where action = 'monthly_reports.confirm'
		     and target_type = 'monthly_report'
		     and target_id = $1
		     and result = 'success'
		 )`,
		strconv.FormatInt(reportID, 10),
	).Scan(&alreadyConfirmed); err != nil {
		return nil, err
	}
	if alreadyConfirmed {
		return nil, monthly_reports.ErrAlreadyConfirmed
	}

	report, err := scanMonthlyReport(s.db.QueryRow(
		ctx,
		`update public.monthly_reports
		 set updated_at = now()
		 where id = $1
		 returning
		   id, project_id, project_name, country, report_month, version, is_current,
		   superseded_at, status::text, settlement_id,
		   total_transactions, total_orders, total_refunds, total_adjustments,
		   total_service_fees, total_trans_fees,
		   result_file_path, error_message, calculation_version, computed_at,
		   created_at, updated_at, summary_pdf_file_path, summary_pdf_r2_url`,
		reportID,
	))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, monthly_reports.ErrReportNotFound
		}
		return nil, err
	}
	return report, nil
}

func (s *MonthlyReportStore) DeleteDraft(
	ctx context.Context,
	reportID int64,
) (*monthly_reports.MonthlyReport, error) {
	report, err := scanMonthlyReport(s.db.QueryRow(
		ctx,
		monthlyReportBaseSelect+`
		 from public.monthly_reports r
		 join public.projects p on p.id = r.project_id
		 where r.id = $1
		 for update of r`,
		reportID,
	))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, monthly_reports.ErrReportNotFound
		}
		return nil, err
	}

	var confirmed bool
	if err := s.db.QueryRow(
		ctx,
		`select exists(
		   select 1
		   from public.operation_audit_logs
		   where action = 'monthly_reports.confirm'
		     and target_type = 'monthly_report'
		     and target_id = $1
		     and result = 'success'
		 )`,
		strconv.FormatInt(reportID, 10),
	).Scan(&confirmed); err != nil {
		return nil, err
	}
	if confirmed {
		return nil, monthly_reports.ErrReportFinalized
	}

	tag, err := s.db.Exec(
		ctx,
		`delete from public.monthly_reports where id = $1`,
		reportID,
	)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, monthly_reports.ErrReportNotFound
	}
	return report, nil
}

func (s *MonthlyReportStore) ExportReport(
	ctx context.Context,
	reportID int64,
	format string,
) (*monthly_reports.MonthlyReportExport, error) {
	detail, err := s.GetReport(ctx, reportID)
	if err != nil {
		return nil, err
	}
	if detail.Report.Status != monthly_reports.MonthlyReportStatusCompleted {
		return nil, monthly_reports.ErrReportNotReady
	}

	switch format {
	case monthly_reports.MonthlyReportExportFormatExcel:
		if path := existingRegularFile(detail.Report.ExportFilePath, s.resultRoot); path != "" {
			return &monthly_reports.MonthlyReportExport{
				Filename:    filepath.Base(path),
				ContentType: contentTypeForPath(path),
				Path:        path,
			}, nil
		}
		filename := safeExportFilename(detail.Report.ProjectName, detail.Report.ReportMonth) + ".csv"
		content, err := renderMonthlyReportCSV(detail)
		if err != nil {
			return nil, err
		}
		return &monthly_reports.MonthlyReportExport{
			Filename:    filename,
			ContentType: "text/csv; charset=utf-8",
			Content:     content,
		}, nil
	case monthly_reports.MonthlyReportExportFormatPDF:
		if detail.Report.SummaryPDFR2URL != nil &&
			strings.TrimSpace(*detail.Report.SummaryPDFR2URL) != "" {
			if safeURL, ok := monthly_reports.SafeSummaryPDFRedirect(
				*detail.Report.SummaryPDFR2URL,
			); ok {
				return &monthly_reports.MonthlyReportExport{RedirectURL: &safeURL}, nil
			}
		}
		if path := existingRegularFile(detail.Report.SummaryPDFStoragePath, s.uploadRoot); path != "" {
			return &monthly_reports.MonthlyReportExport{
				Filename:    filepath.Base(path),
				ContentType: "application/pdf",
				Path:        path,
			}, nil
		}
		return nil, monthly_reports.ErrExportNotFound
	default:
		return nil, monthly_reports.ErrExportNotFound
	}
}

func (s *MonthlyReportStore) ExportReportFile(
	ctx context.Context,
	reportID int64,
) (*monthly_reports.MonthlyReportExport, error) {
	detail, err := s.GetReport(ctx, reportID)
	if err != nil {
		return nil, err
	}
	if detail.Report.Status != monthly_reports.MonthlyReportStatusCompleted {
		return nil, monthly_reports.ErrReportNotReady
	}
	path := existingRegularFile(detail.Report.ExportFilePath, s.resultRoot)
	if path == "" {
		return nil, monthly_reports.ErrExportNotFound
	}
	return &monthly_reports.MonthlyReportExport{
		Filename:    filepath.Base(path),
		ContentType: contentTypeForPath(path),
		Path:        path,
		ProjectID:   detail.Report.ProjectID,
	}, nil
}

func (s *MonthlyReportStore) AccessibleProjectIDs(
	ctx context.Context,
	operator string,
) ([]int64, error) {
	operator = strings.TrimSpace(operator)
	if operator == "" {
		return []int64{}, nil
	}
	rows, err := s.db.Query(
		ctx,
		`select id
		 from public.projects
		 where coalesce(is_active, true) = true
		   and (
		     exists (
		       select 1
		       from unnest(regexp_split_to_array(
		         coalesce(project_operator, ''),
		         '[、,，;' || chr(10) || ']+'
		       )) as names(value)
		       where btrim(names.value) = $1
		     )
		     or exists (
		       select 1
		       from unnest(regexp_split_to_array(
		         coalesce(assistant_operator, ''),
		         '[、,，;' || chr(10) || ']+'
		       )) as names(value)
		       where btrim(names.value) = $1
		     )
		   )
		 order by id asc`,
		operator,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	ids := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

func (s *MonthlyReportStore) loadCalculationMap(
	ctx context.Context,
	table string,
	reportID int64,
) (map[string]float64, error) {
	query := fmt.Sprintf(
		`select (
		   to_jsonb(calculation)
		   - 'id'
		   - 'report_id'
		   - 'project_name'
		   - 'report_month'
		   - 'calculation_version'
		   - 'computed_at'
		   - 'created_at'
		   - 'updated_at'
		 )::text
		 from public.%s calculation
		 where calculation.report_id = $1`,
		table,
	)
	var payload string
	err := s.db.QueryRow(ctx, query, reportID).Scan(&payload)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	values := make(map[string]float64)
	if err := json.Unmarshal([]byte(payload), &values); err != nil {
		return nil, fmt.Errorf("decode %s: %w", table, err)
	}
	return values, nil
}

func (s *MonthlyReportStore) loadPurchaseCosts(
	ctx context.Context,
	projectID int64,
	country string,
	reportID int64,
) (float64, float64, error) {
	var fobCost, firstLegCost float64
	err := s.db.QueryRow(
		ctx,
		`select
		   coalesce(sum(transaction_totals.quantity * costs.fob_unit_cost), 0)::float8,
		   coalesce(sum(transaction_totals.quantity * costs.first_leg_cost_rmb), 0)::float8
		 from (
		   select report_rows.sku, sum(report_rows.quantity)::numeric as quantity
		   from public.monthly_report_transactions report_rows
		   where report_rows.report_id = $3
		     and report_rows.sku is not null
		     and lower(btrim(report_rows.transaction_type)) in ('order', 'bestellung')
		   group by report_rows.sku
		 ) transaction_totals
		 join lateral (
		   select product_costs.fob_unit_cost, product_costs.first_leg_cost_rmb
		   from public.product_costs product_costs
		   where product_costs.project_id = $1
		     and product_costs.country = $2
		     and lower(btrim(product_costs.sku)) = lower(btrim(transaction_totals.sku))
		     and product_costs.is_active = true
		   order by product_costs.updated_at desc, product_costs.id desc
		   limit 1
		 ) costs on true
		`,
		projectID,
		country,
		reportID,
	).Scan(&fobCost, &firstLegCost)
	if err != nil {
		return 0, 0, err
	}
	return fobCost, firstLegCost, nil
}

func (s *MonthlyReportStore) loadExchangeRate(
	ctx context.Context,
	currency string,
	reportMonth string,
) (*float64, error) {
	var rate float64
	err := s.db.QueryRow(
		ctx,
		`select rate::float8
		 from public.exchange_rates
		 where currency = $1
		   and year_month <= $2
		 order by year_month desc, id desc
		 limit 1`,
		currency,
		reportMonth,
	).Scan(&rate)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &rate, nil
}

const monthlyReportBaseSelect = `
	select
	  r.id, r.project_id, coalesce(r.project_name, p.project_name),
	  r.country, r.report_month, r.version, r.is_current, r.superseded_at,
	  r.status::text, r.settlement_id,
	  r.total_transactions, r.total_orders, r.total_refunds, r.total_adjustments,
	  r.total_service_fees, r.total_trans_fees,
	  r.result_file_path, r.error_message, r.calculation_version, r.computed_at,
	  r.created_at, r.updated_at, r.summary_pdf_file_path, r.summary_pdf_r2_url
`

// The deployed PostgreSQL schema uses singular calculation table names.
const (
	monthlyReportPT3CalculationTable = "monthly_report_pt3_calculation"
	monthlyReportPT4CalculationTable = "monthly_report_pt4_calculation"
)

type monthlyReportScanner interface {
	Scan(dest ...any) error
}

func scanMonthlyReport(scanner monthlyReportScanner) (*monthly_reports.MonthlyReport, error) {
	var report monthly_reports.MonthlyReport
	var supersededAt, computedAt pgtype.Timestamptz
	var databaseStatusValue string
	var resultFilePath, summaryPDFFilePath, summaryPDFR2URL, errorMessage *string
	var createdAt, updatedAt time.Time
	err := scanner.Scan(
		&report.ID,
		&report.ProjectID,
		&report.ProjectName,
		&report.Country,
		&report.ReportMonth,
		&report.Version,
		&report.IsCurrent,
		&supersededAt,
		&databaseStatusValue,
		&report.SettlementID,
		&report.TotalTransactions,
		&report.TotalOrders,
		&report.TotalRefunds,
		&report.TotalAdjustments,
		&report.TotalServiceFees,
		&report.TotalTransFees,
		&resultFilePath,
		&errorMessage,
		&report.CalculationVersion,
		&computedAt,
		&createdAt,
		&updatedAt,
		&summaryPDFFilePath,
		&summaryPDFR2URL,
	)
	if err != nil {
		return nil, err
	}
	report.Status = apiStatus(databaseStatusValue)
	report.SupersededAt = optionalTimestamp(supersededAt)
	report.ComputedAt = optionalTimestamp(computedAt)
	report.CreatedAt = httpapi.Timestamp(createdAt)
	report.UpdatedAt = httpapi.Timestamp(updatedAt)
	report.ResultFilePath = resultFilePath
	report.SummaryPDFR2URL = summaryPDFR2URL
	report.ErrorMessage = errorMessage
	report.ExportFilePath = resultFilePath
	report.SummaryPDFStoragePath = summaryPDFFilePath
	return &report, nil
}

func scanMonthlyReportWithProject(
	scanner monthlyReportScanner,
	projectOperator **string,
	assistantOperator **string,
) (*monthly_reports.MonthlyReport, error) {
	var report monthly_reports.MonthlyReport
	var supersededAt, computedAt pgtype.Timestamptz
	var databaseStatusValue string
	var resultFilePath, summaryPDFFilePath, summaryPDFR2URL, errorMessage *string
	var createdAt, updatedAt time.Time
	err := scanner.Scan(
		&report.ID,
		&report.ProjectID,
		&report.ProjectName,
		&report.Country,
		&report.ReportMonth,
		&report.Version,
		&report.IsCurrent,
		&supersededAt,
		&databaseStatusValue,
		&report.SettlementID,
		&report.TotalTransactions,
		&report.TotalOrders,
		&report.TotalRefunds,
		&report.TotalAdjustments,
		&report.TotalServiceFees,
		&report.TotalTransFees,
		&resultFilePath,
		&errorMessage,
		&report.CalculationVersion,
		&computedAt,
		&createdAt,
		&updatedAt,
		&summaryPDFFilePath,
		&summaryPDFR2URL,
		projectOperator,
		assistantOperator,
	)
	if err != nil {
		return nil, err
	}
	report.Status = apiStatus(databaseStatusValue)
	report.SupersededAt = optionalTimestamp(supersededAt)
	report.ComputedAt = optionalTimestamp(computedAt)
	report.CreatedAt = httpapi.Timestamp(createdAt)
	report.UpdatedAt = httpapi.Timestamp(updatedAt)
	report.ResultFilePath = resultFilePath
	report.SummaryPDFR2URL = summaryPDFR2URL
	report.ErrorMessage = errorMessage
	report.ExportFilePath = resultFilePath
	report.SummaryPDFStoragePath = summaryPDFFilePath
	return &report, nil
}

func buildMonthlyReportDetail(
	report monthly_reports.MonthlyReport,
	projectOperator *string,
	assistantOperator *string,
	pt3 map[string]float64,
	pt4 map[string]float64,
	fobCost float64,
	firstLegCost float64,
	exchangeRate *float64,
) *monthly_reports.MonthlyReportDetail {
	incomeTotal := mapValue(pt3, "income_total")
	expenseTotal := mapValue(pt3, "expense_total")
	incomeVATTotal := mapValue(pt3, "income_vat_total")
	incomeSalesWithTax := mapValue(pt3, "income_sales_with_tax")
	amazonPayBack := mapValue(pt4, "amazon_pay_back")
	creditCardDeduction := mapValue(pt4, "credit_card_deduction_usd")
	totalCostRMB := roundMonthlyMoney(fobCost + firstLegCost)

	purchaseCost := monthly_reports.MonthlyReportPurchaseCost{
		FOBCostRMB:      roundMonthlyMoney(fobCost),
		FirstLegCostRMB: roundMonthlyMoney(firstLegCost),
		TotalCostRMB:    totalCostRMB,
		ExchangeRate:    exchangeRate,
	}
	netProfit := amazonPayBack - creditCardDeduction
	var netProfitRMB float64
	if exchangeRate != nil && *exchangeRate > 0 {
		totalCostLocal := roundMonthlyMoney(totalCostRMB / *exchangeRate)
		purchaseCost.TotalCostLocal = &totalCostLocal
		netProfit -= totalCostLocal
		netProfitRMB = roundMonthlyMoney(netProfit * *exchangeRate)
	}
	netProfit = roundMonthlyMoney(netProfit)
	var netProfitRate float64
	if incomeTotal != 0 {
		netProfitRate = roundMonthlyRatio(netProfit / incomeTotal)
	}
	currency := countryCurrency(report.Country)
	var netProfitUSD *float64
	if currency == "USD" {
		netProfitUSD = &netProfit
	}

	detail := &monthly_reports.MonthlyReportDetail{
		Report: report,
		Project: monthly_reports.MonthlyReportProject{
			ID:                report.ProjectID,
			ProjectName:       report.ProjectName,
			Country:           report.Country,
			ProjectOperator:   projectOperator,
			AssistantOperator: assistantOperator,
		},
		SalesSummary: monthly_reports.MonthlyReportSalesSummary{
			IncomeTotal:        roundMonthlyMoney(incomeTotal),
			IncomeVATTotal:     roundMonthlyMoney(incomeVATTotal),
			IncomeSalesWithTax: roundMonthlyMoney(incomeSalesWithTax),
			ExpenseTotal:       roundMonthlyMoney(expenseTotal),
			AmazonPayBack:      roundMonthlyMoney(amazonPayBack),
			NetAmount:          roundMonthlyMoney(incomeTotal + expenseTotal),
		},
		Settlement: monthly_reports.MonthlyReportSettlementSummary{
			SettlementID:      report.SettlementID,
			TotalTransactions: report.TotalTransactions,
			TotalOrders:       report.TotalOrders,
			TotalRefunds:      report.TotalRefunds,
			TotalAdjustments:  report.TotalAdjustments,
			TotalServiceFees:  report.TotalServiceFees,
			TotalTransFees:    report.TotalTransFees,
		},
		PlatformFees: feeBreakdown(pt3, monthlyReportPlatformFees),
		RefundFees:   feeBreakdown(pt3, monthlyReportRefundFees),
		PurchaseCost: purchaseCost,
		Profit: monthly_reports.MonthlyReportProfit{
			Currency:      currency,
			NetProfit:     netProfit,
			NetProfitRMB:  netProfitRMB,
			NetProfitUSD:  netProfitUSD,
			NetProfitRate: netProfitRate,
		},
		PT3: pt3,
		PT4: pt4,
	}
	return detail
}

var monthlyReportPlatformFees = []monthlyReportFeeDefinition{
	{Key: "expense_seller_fulfilled_selling_fees", Label: "Seller fulfilled selling fees"},
	{Key: "expense_fba_selling_fees", Label: "FBA selling fees"},
	{Key: "expense_fba_transaction_fees", Label: "FBA transaction fees"},
	{Key: "expense_other_transaction_fees", Label: "Other transaction fees"},
	{Key: "expense_fba_inventory_and_inbound_services_fees", Label: "FBA inventory and inbound services fees"},
	{Key: "expense_shipping_label_purchases", Label: "Shipping label purchases"},
	{Key: "expense_carrier_shipping_label_adjustments", Label: "Carrier shipping label adjustments"},
	{Key: "expense_service_fees", Label: "Service fees"},
	{Key: "expense_cost_of_advertising", Label: "Cost of advertising"},
	{Key: "expense_liquidations_fees", Label: "Liquidations fees"},
	{Key: "expense_receivables", Label: "Receivables"},
	{Key: "expense_deductions", Label: "Deductions"},
	{Key: "expense_amazon_shipping_charge_adjustments", Label: "Amazon shipping charge adjustments"},
}

var monthlyReportRefundFees = []monthlyReportFeeDefinition{
	{Key: "expense_selling_fee_refunds", Label: "Selling fee refunds"},
	{Key: "expense_fba_transaction_fee_refunds", Label: "FBA transaction fee refunds"},
	{Key: "expense_other_transaction_fee_refunds", Label: "Other transaction fee refunds"},
	{Key: "expense_shipping_label_refunds", Label: "Shipping label refunds"},
	{Key: "expense_refund_administration_fees", Label: "Refund administration fees"},
	{Key: "expense_refund_for_advertiser", Label: "Refund for advertiser"},
}

type monthlyReportFeeDefinition struct {
	Key   string
	Label string
}

func feeBreakdown(
	values map[string]float64,
	definitions []monthlyReportFeeDefinition,
) []monthly_reports.MonthlyReportFee {
	fees := make([]monthly_reports.MonthlyReportFee, 0, len(definitions))
	for _, definition := range definitions {
		amount := roundMonthlyMoney(mapValue(values, definition.Key))
		if amount == 0 {
			continue
		}
		fees = append(fees, monthly_reports.MonthlyReportFee{
			Key:    definition.Key,
			Label:  definition.Label,
			Amount: amount,
		})
	}
	return fees
}

func renderMonthlyReportCSV(detail *monthly_reports.MonthlyReportDetail) ([]byte, error) {
	var buffer bytes.Buffer
	writer := csv.NewWriter(&buffer)
	if err := writer.Write([]string{
		"report_id",
		"project_id",
		"project_name",
		"country",
		"report_month",
		"status",
		"income_total",
		"expense_total",
		"amazon_pay_back",
		"fob_cost_rmb",
		"first_leg_cost_rmb",
		"net_profit",
		"net_profit_rmb",
	}); err != nil {
		return nil, err
	}
	if err := writer.Write([]string{
		strconv.FormatInt(detail.Report.ID, 10),
		strconv.FormatInt(detail.Report.ProjectID, 10),
		csvSafeText(detail.Report.ProjectName),
		csvSafeText(detail.Report.Country),
		csvSafeText(detail.Report.ReportMonth),
		csvSafeText(detail.Report.Status),
		formatFloat(detail.SalesSummary.IncomeTotal),
		formatFloat(detail.SalesSummary.ExpenseTotal),
		formatFloat(detail.SalesSummary.AmazonPayBack),
		formatFloat(detail.PurchaseCost.FOBCostRMB),
		formatFloat(detail.PurchaseCost.FirstLegCostRMB),
		formatFloat(detail.Profit.NetProfit),
		formatFloat(detail.Profit.NetProfitRMB),
	}); err != nil {
		return nil, err
	}
	if err := writer.Write(nil); err != nil {
		return nil, err
	}

	keys := make([]string, 0, len(detail.PT3))
	for key := range detail.PT3 {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if err := writer.Write([]string{
			csvSafeText(key),
			formatFloat(detail.PT3[key]),
		}); err != nil {
			return nil, err
		}
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func csvSafeText(value string) string {
	if value == "" {
		return value
	}
	switch value[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return "'" + value
	default:
		return value
	}
}

func databaseStatus(status string) (string, error) {
	switch status {
	case monthly_reports.MonthlyReportStatusPending:
		return "pending", nil
	case monthly_reports.MonthlyReportStatusCalculating:
		return "running", nil
	case monthly_reports.MonthlyReportStatusCompleted:
		return "success", nil
	case monthly_reports.MonthlyReportStatusFailed:
		return "failed", nil
	default:
		return "", errors.New("unknown monthly report status")
	}
}

func apiStatus(status string) string {
	switch status {
	case "running":
		return monthly_reports.MonthlyReportStatusCalculating
	case "success":
		return monthly_reports.MonthlyReportStatusCompleted
	case "failed":
		return monthly_reports.MonthlyReportStatusFailed
	default:
		return monthly_reports.MonthlyReportStatusPending
	}
}

func statusProgress(status string) (string, int, string) {
	switch status {
	case monthly_reports.MonthlyReportStatusCalculating:
		return "processing", 50, "处理中：任务执行中"
	case monthly_reports.MonthlyReportStatusCompleted:
		return "completed", 100, "处理完成：报表已生成，可下载"
	case monthly_reports.MonthlyReportStatusFailed:
		return "failed", 100, "处理失败"
	default:
		return "started", 5, "处理中：任务排队中"
	}
}

func optionalTimestamp(value pgtype.Timestamptz) *string {
	if !value.Valid {
		return nil
	}
	return httpapi.OptionalTimestamp(&value.Time)
}

func mapValue(values map[string]float64, key string) float64 {
	if values == nil {
		return 0
	}
	return values[key]
}

func roundMonthlyMoney(value float64) float64 {
	return math.Round(value*100) / 100
}

func roundMonthlyRatio(value float64) float64 {
	return math.Round(value*10000) / 10000
}

func splitReportMonth(reportMonth string) (int, int) {
	parsed, err := time.Parse("2006-01", reportMonth)
	if err != nil {
		return 0, 0
	}
	return parsed.Year(), int(parsed.Month())
}

func countryCurrency(country string) string {
	switch strings.ToUpper(strings.TrimSpace(country)) {
	case "DE":
		return "EUR"
	case "UK", "GB":
		return "GBP"
	default:
		return "USD"
	}
}

func storageRoot(envName, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(envName)); value != "" {
		return value
	}
	return fallback
}

func existingRegularFile(path *string, root string) string {
	if path == nil {
		return ""
	}
	trimmed := strings.TrimSpace(*path)
	if trimmed == "" {
		return ""
	}
	for _, part := range strings.Split(filepath.ToSlash(trimmed), "/") {
		if part == ".." {
			return ""
		}
	}

	root = strings.TrimSpace(root)
	if root == "" {
		return ""
	}
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return ""
	}
	candidate := trimmed
	if !filepath.IsAbs(candidate) {
		candidate = filepath.Join(absoluteRoot, candidate)
	}
	candidate = filepath.Clean(candidate)

	resolvedRoot, err := filepath.EvalSymlinks(absoluteRoot)
	if err != nil {
		return ""
	}
	resolvedCandidate, err := filepath.EvalSymlinks(candidate)
	if err != nil || !pathWithinRoot(resolvedRoot, resolvedCandidate) {
		return ""
	}
	info, err := os.Stat(resolvedCandidate)
	if err != nil || info.IsDir() || !info.Mode().IsRegular() {
		return ""
	}
	return resolvedCandidate
}

func pathWithinRoot(root, candidate string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(candidate))
	if err != nil || filepath.IsAbs(relative) {
		return false
	}
	return relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func contentTypeForPath(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".xlsx":
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	case ".xls":
		return "application/vnd.ms-excel"
	case ".csv":
		return "text/csv; charset=utf-8"
	case ".pdf":
		return "application/pdf"
	default:
		extension := filepath.Ext(path)
		if contentType := mime.TypeByExtension(extension); contentType != "" {
			return contentType
		}
		return "application/octet-stream"
	}
}

func safeExportFilename(projectName, reportMonth string) string {
	raw := strings.TrimSpace(projectName) + "_Monthly_Report_" + strings.TrimSpace(reportMonth)
	var builder strings.Builder
	for _, character := range raw {
		switch {
		case character >= 'a' && character <= 'z',
			character >= 'A' && character <= 'Z',
			character >= '0' && character <= '9',
			character == '_',
			character == '-',
			character >= 0x80:
			builder.WriteRune(character)
		case character == ' ', character == '/', character == '\\':
			builder.WriteByte('_')
		}
	}
	name := strings.Trim(builder.String(), "._-")
	if name == "" {
		return "monthly-report"
	}
	return name
}

func formatFloat(value float64) string {
	return strconv.FormatFloat(value, 'f', 2, 64)
}

func trimOptionalString(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func dereferenceString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func monthlyReportStringPointerValue(value string) *string {
	return &value
}
