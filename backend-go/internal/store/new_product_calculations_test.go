package store

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/new_product_calculations"
)

func TestNewProductCalculationStoreListFiltersAndMapsRows(t *testing.T) {
	db := &stage3BDB{
		row:  stage3BRow{values: []any{int64(1)}},
		rows: &stage3BRows{batches: [][]any{newProductCalculationRowValues(41)}},
	}
	projectID := int64(7)
	calculationType := "profit_calc"
	country := "US"
	got, err := NewProductCalculationStore(db).List(context.Background(), new_product_calculations.ListFilter{
		ProjectID:       &projectID,
		CalculationType: &calculationType,
		Country:         &country,
		Page:            2,
		PageSize:        25,
		Operator:        "林一",
	})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if got.Total != 1 || got.Page != 2 || got.PageSize != 25 || len(got.Items) != 1 {
		t.Fatalf("List() = %#v, want one paginated row", got)
	}
	item := got.Items[0]
	if item.ID != 41 || item.ProjectID != 7 || item.SKU != "SKU-中文" ||
		item.Warnings == nil || len(item.Warnings) != 1 || item.Warnings[0] != "重量依据为亚马逊计费重" {
		t.Errorf("item = %#v, want persisted identifiers and exact warning text", item)
	}
	if item.ASIN != nil || item.Country != nil || item.Notes != nil || item.Source != nil ||
		item.ObservedAt != nil || item.CreatedBy != nil {
		t.Errorf("nullable columns = %#v, want nulls preserved", item)
	}
	if len(db.queryRowCalls) != 1 || !strings.Contains(strings.ToLower(db.queryRowCalls[0].sql), "count(*)") {
		t.Fatalf("count query = %#v, want count query", db.queryRowCalls)
	}
	if len(db.queryCalls) != 1 {
		t.Fatalf("Query() calls = %d, want one page query", len(db.queryCalls))
	}
	query := strings.ToLower(db.queryCalls[0].sql)
	for _, fragment := range []string{
		"from public.new_product_calculations",
		"project_id = $1",
		"calculation_type = $2",
		"country = $3",
		"project_operator",
		"assistant_operator",
		"order by n.updated_at desc",
		"limit $6 offset $7",
	} {
		if !strings.Contains(query, fragment) {
			t.Errorf("List SQL missing %q: %s", fragment, query)
		}
	}
	args := db.queryCalls[0].args
	if len(args) != 7 || args[0] != &projectID || args[1] != &calculationType ||
		args[2] != &country || args[3] != false || args[4] != "林一" ||
		args[5] != 25 || args[6] != 25 {
		t.Errorf("List args = %#v, want filters, actor, and pagination", args)
	}
}

func TestNewProductCalculationStoreListDefaultsAndCapsPageSize(t *testing.T) {
	db := &stage3BDB{
		row:  stage3BRow{values: []any{int64(0)}},
		rows: &stage3BRows{},
	}
	got, err := NewProductCalculationStore(db).List(context.Background(), new_product_calculations.ListFilter{
		Page:     0,
		PageSize: 800,
		Operator: "operator",
	})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if got.Page != 1 || got.PageSize != 500 || got.Items == nil {
		t.Fatalf("List() pagination/items = (%d, %d, %#v), want (1, 500, empty)", got.Page, got.PageSize, got.Items)
	}
	if args := db.queryCalls[0].args; args[5] != 500 || args[6] != 0 {
		t.Errorf("query pagination args = %#v, want limit 500 offset 0", args[5:])
	}
	query := strings.ToLower(db.queryCalls[0].sql)
	if !strings.Contains(query, "$4::boolean") || !strings.Contains(query, "$5::text") {
		t.Errorf("unfiltered list SQL = %s, want actor-scoped membership predicate", query)
	}
}

func TestNewProductCalculationStoreGetUsesProjectSkuAndType(t *testing.T) {
	db := &stage3BDB{row: stage3BRow{values: newProductCalculationRowValues(41)}}
	item, err := NewProductCalculationStore(db).Get(context.Background(), 7, "SKU-中文", "profit_reverse")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if item == nil || item.ID != 41 || item.CalculationType != "profit_calc" {
		t.Fatalf("Get() = %#v, want persisted row", item)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("QueryRow() calls = %d, want 1", len(db.queryRowCalls))
	}
	query := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(query, "from public.new_product_calculations") ||
		!strings.Contains(query, "project_id = $1") ||
		!strings.Contains(query, "sku = $2") ||
		!strings.Contains(query, "calculation_type = $3") {
		t.Errorf("Get SQL = %s, want project/SKU/type lookup", query)
	}
	if !reflect.DeepEqual(db.queryRowCalls[0].args, []any{int64(7), "SKU-中文", "profit_reverse"}) {
		t.Errorf("Get args = %#v, want key tuple", db.queryRowCalls[0].args)
	}
}

func TestNewProductCalculationStoreUpsertPersistsAndReturnsRow(t *testing.T) {
	db := newProductUpsertTestDB(newProductCalculationRowValues(41))
	input := new_product_calculations.CreateRequest{
		ProjectID:                 7,
		ProjectName:               "client-supplied-name",
		SKU:                       "SKU-中文",
		CalculationType:           "profit_calc",
		PackageLengthCM:           10,
		PackageWidthCM:            8,
		PackageHeightCM:           4,
		WeightKG:                  0.4,
		FOBProductCostRMB:         30,
		FirstLegCostRMB:           5,
		SalePriceUSD:              20,
		AdvertisingRate:           0.1,
		ReturnLossRate:            0.04,
		StorageMonths:             1,
		InboundPlacementMode:      "single_destination",
		USDToRMBRate:              7.1,
		USDToRMBRateSource:        "monthly",
		ChargeableWeightRule:      "实重",
		FulfillmentFeeRuleLabel:   "配送费规则",
		InboundConfigFeeRuleLabel: "入库配置费规则",
		StorageFeeRuleLabel:       "仓储费规则",
		Warnings:                  []string{"尺寸需复核", "重量依据为亚马逊计费重"},
	}
	item, err := NewProductCalculationStore(db).Upsert(context.Background(), input, "林一")
	if err != nil {
		t.Fatalf("Upsert() error = %v", err)
	}
	if item == nil || item.ID != 41 {
		t.Fatalf("Upsert() = %#v, want returned persisted row", item)
	}
	if len(db.queryRowCalls) != 3 {
		t.Fatalf("QueryRow() calls = %d, want project, product master, and INSERT RETURNING", len(db.queryRowCalls))
	}
	call := db.queryRowCalls[len(db.queryRowCalls)-1]
	query := strings.ToLower(call.sql)
	for _, fragment := range []string{
		"insert into public.new_product_calculations",
		"on conflict (project_id, sku, calculation_type) do update",
		"updated_at = now()",
		"warnings_json",
		"returning",
	} {
		if !strings.Contains(query, fragment) {
			t.Errorf("Upsert SQL missing %q: %s", fragment, query)
		}
	}
	args := call.args
	if want := len(newProductCalculationInsertColumns) + 1; len(args) != want {
		t.Errorf("Upsert args count = %d, want %d insert values plus operator flag", len(args), want)
	}
	if len(args) < 6 || args[0] != int64(7) || args[1] != "北美项目" ||
		args[2] != "SKU-中文" || args[5] != "profit_calc" {
		t.Errorf("Upsert leading args = %#v, want project/name/SKU/type", args[:min(len(args), 6)])
	}
	columnArgs := make(map[string]any, len(newProductCalculationInsertColumns))
	for index, column := range newProductCalculationInsertColumns {
		columnArgs[column] = args[index]
	}
	if columnArgs["ddp_cost_usd"] == 0 || columnArgs["profit_usd"] == 0 ||
		columnArgs["total_fee_usd"] == 0 || columnArgs["size_tier"] == "" ||
		columnArgs["fulfillment_fee_rule_label"] == "" {
		t.Errorf("derived values were not recalculated: %#v", columnArgs)
	}
	if columnArgs["usd_to_rmb_rate_source"] != "manual" {
		t.Errorf("rate source = %#v, want manual", columnArgs["usd_to_rmb_rate_source"])
	}
	foundWarnings, foundOperator := false, false
	for _, arg := range args {
		if raw, ok := arg.([]byte); ok && string(raw) == `["尺寸需复核","重量依据为亚马逊计费重"]` {
			foundWarnings = true
		}
		if operator, ok := arg.(*string); ok && operator != nil && *operator == "林一" {
			foundOperator = true
		}
	}
	if !foundWarnings || !foundOperator {
		t.Errorf("Upsert args = %#v, want exact warning JSON and operator", args)
	}
}

func TestNewProductCalculationStoreUpsertOverwritesSameProjectSKUAndType(t *testing.T) {
	db := newProductUpsertTestDB(newProductCalculationRowValues(41))
	input := new_product_calculations.CreateRequest{
		ProjectID: 7, ProjectName: "北美项目", SKU: "SKU-中文",
		CalculationType: "profit_calc",
		PackageLengthCM: 10, PackageWidthCM: 8, PackageHeightCM: 4, WeightKG: 0.4,
		FOBProductCostRMB: 30, FirstLegCostRMB: 5, SalePriceUSD: 20,
		AdvertisingRate: 0.1, ReturnLossRate: 0.04, StorageMonths: 1,
		InboundPlacementMode: "single_destination", USDToRMBRate: 7.1,
		Warnings: []string{},
	}
	store := NewProductCalculationStore(db)
	first, err := store.Upsert(context.Background(), input, "林一")
	if err != nil {
		t.Fatalf("first Upsert() error = %v", err)
	}
	input.SalePriceUSD = 29.99
	second, err := store.Upsert(context.Background(), input, "林一")
	if err != nil {
		t.Fatalf("second Upsert() error = %v", err)
	}
	if first == nil || second == nil || first.ID != second.ID {
		t.Fatalf("upsert IDs = (%#v, %#v), want same persisted row ID", first, second)
	}
	if len(db.queryRowCalls) != 6 {
		t.Fatalf("QueryRow calls = %d, want project/product/insert per create/update", len(db.queryRowCalls))
	}
	for _, call := range db.queryRowCalls {
		query := strings.ToLower(call.sql)
		if !strings.Contains(query, "insert into public.new_product_calculations") {
			continue
		}
		if !strings.Contains(query, "on conflict (project_id, sku, calculation_type) do update") {
			t.Errorf("upsert SQL = %s, want unique-key conflict update", query)
		}
		if len(call.args) < 6 || call.args[0] != int64(7) ||
			call.args[2] != "SKU-中文" || call.args[5] != "profit_calc" {
			t.Errorf("upsert key args = %#v, want stable project/SKU/type", call.args[:min(len(call.args), 6)])
		}
	}
}

func TestNewProductCalculationStoreUpsertSolvesSuggestedSalePrice(t *testing.T) {
	db := newProductUpsertTestDB(newProductCalculationRowValues(41))
	target := 0.25
	input := new_product_calculations.CreateRequest{
		ProjectID: 7, ProjectName: "client", SKU: "SKU-中文",
		CalculationType: "profit_reverse",
		PackageLengthCM: 10, PackageWidthCM: 8, PackageHeightCM: 4, WeightKG: 0.4,
		FOBProductCostRMB: 30, FirstLegCostRMB: 5, SalePriceUSD: 0.01,
		TargetProfitRate: &target,
		AdvertisingRate:  0.1, ReturnLossRate: 0.04, StorageMonths: 1,
		InboundPlacementMode: "single_destination", USDToRMBRate: 7.1,
	}
	if _, err := NewProductCalculationStore(db).Upsert(
		context.Background(),
		input,
		"林一",
	); err != nil {
		t.Fatalf("Upsert(profit_reverse) error = %v", err)
	}
	insertCall := db.queryRowCalls[len(db.queryRowCalls)-1]
	columnArgs := make(map[string]any, len(newProductCalculationInsertColumns))
	for index, column := range newProductCalculationInsertColumns {
		columnArgs[column] = insertCall.args[index]
	}
	salePrice, ok := columnArgs["sale_price_usd"].(float64)
	if !ok || salePrice <= input.SalePriceUSD {
		t.Fatalf("sale_price_usd = %#v, want solved price above input", columnArgs["sale_price_usd"])
	}
	if columnArgs["calculation_type"] != "profit_reverse" {
		t.Fatalf("calculation_type = %#v, want profit_reverse", columnArgs["calculation_type"])
	}
}

func TestNewProductCalculationStoreUpsertSupportsLegacyFBMAndReverseSnapshots(t *testing.T) {
	base := new_product_calculations.CreateRequest{
		ProjectID: 7, ProjectName: "client", SKU: "SKU-中文",
		PackageLengthCM: 10, PackageWidthCM: 8, PackageHeightCM: 4, WeightKG: 0.4,
		FOBProductCostRMB: 30, FirstLegCostRMB: 5, SalePriceUSD: 20,
		AdvertisingRate: 0.1, ReturnLossRate: 0.04, StorageMonths: 1,
		InboundPlacementMode: "single_destination", USDToRMBRate: 7.1,
	}

	fbmDB := newProductUpsertTestDB(newProductCalculationRowValues(41))
	fbm := base
	fbm.CalculationType = "fbm_calc"
	fbm.FBAFulfillmentFeeUSD = 5.5
	if _, err := NewProductCalculationStore(fbmDB).Upsert(
		context.Background(),
		fbm,
		"林一",
	); err != nil {
		t.Fatalf("Upsert(legacy fbm) error = %v", err)
	}
	fbmArgs := mapNewProductInsertArgs(fbmDB.queryRowCalls[len(fbmDB.queryRowCalls)-1].args)
	if fbmArgs["delivery_fee_usd"] != 5.5 {
		t.Fatalf("delivery_fee_usd = %#v, want legacy FBA fee fallback", fbmArgs["delivery_fee_usd"])
	}

	reverseDB := newProductUpsertTestDB(newProductCalculationRowValues(41))
	reverse := base
	reverse.CalculationType = "profit_reverse"
	if _, err := NewProductCalculationStore(reverseDB).Upsert(
		context.Background(),
		reverse,
		"林一",
	); err != nil {
		t.Fatalf("Upsert(reverse without target) error = %v", err)
	}
	reverseArgs := mapNewProductInsertArgs(
		reverseDB.queryRowCalls[len(reverseDB.queryRowCalls)-1].args,
	)
	if reverseArgs["calculation_type"] != "profit_reverse" ||
		reverseArgs["sale_price_usd"] != 20.0 {
		t.Fatalf("reverse fallback args = %#v", reverseArgs)
	}
}

func TestNewProductCalculationStoreVerifyProjectAccessChecksExistenceAndOperators(t *testing.T) {
	tests := []struct {
		name      string
		row       pgx.Row
		operator  string
		admin     bool
		wantError error
	}{
		{
			name: "project operator match", row: stage3BRow{values: []any{"Alice, Bob", "Assistant"}},
			operator: "Bob",
		},
		{
			name: "assistant operator match", row: stage3BRow{values: []any{"Alice", "林一、王二"}},
			operator: "王二",
		},
		{
			name: "admin still requires existing project", row: stage3BRow{values: []any{nil, nil}},
			admin: true,
		},
		{
			name: "forbidden operator", row: stage3BRow{values: []any{"Alice", "Bob"}},
			operator: "Eve", wantError: new_product_calculations.ErrProjectForbidden,
		},
		{
			name: "missing project", row: stage3BRow{err: pgx.ErrNoRows},
			operator: "Alice", wantError: new_product_calculations.ErrProjectNotFound,
		},
		{
			name: "admin missing project", row: stage3BRow{err: pgx.ErrNoRows},
			admin: true, wantError: new_product_calculations.ErrProjectNotFound,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			db := &stage3BDB{row: test.row}
			err := NewProductCalculationStore(db).VerifyProjectAccess(context.Background(), 7, test.operator, test.admin)
			if !errors.Is(err, test.wantError) {
				t.Fatalf("VerifyProjectAccess() error = %v, want %v", err, test.wantError)
			}
			if len(db.queryRowCalls) != 1 ||
				!strings.Contains(strings.ToLower(db.queryRowCalls[0].sql), "assistant_operator") {
				t.Errorf("project query = %#v, want both operator columns", db.queryRowCalls)
			}
		})
	}
}

func TestNewProductCalculationStoreProjectIDAndDeleteHandleMissingRows(t *testing.T) {
	db := &stage3BDB{row: stage3BRow{values: []any{int64(7)}}}
	projectID, err := NewProductCalculationStore(db).ProjectID(context.Background(), 41)
	if err != nil || projectID != 7 {
		t.Fatalf("ProjectID() = (%d, %v), want (7, nil)", projectID, err)
	}
	if len(db.queryRowCalls) != 1 ||
		!strings.Contains(strings.ToLower(db.queryRowCalls[0].sql), "select project_id") {
		t.Fatalf("ProjectID query = %#v, want snapshot project lookup", db.queryRowCalls)
	}

	for _, test := range []struct {
		tag  string
		want bool
	}{
		{tag: "DELETE 1", want: true},
		{tag: "DELETE 0", want: false},
	} {
		t.Run(test.tag, func(t *testing.T) {
			writeDB := &stage3BDB{execTag: pgconn.NewCommandTag(test.tag)}
			deleted, err := NewProductCalculationStore(writeDB).Delete(context.Background(), 41)
			if err != nil || deleted != test.want {
				t.Fatalf("Delete() = (%v, %v), want (%v, nil)", deleted, err, test.want)
			}
			if len(writeDB.execCalls) != 1 ||
				!strings.Contains(strings.ToLower(writeDB.execCalls[0].sql), "delete from public.new_product_calculations") {
				t.Fatalf("Delete SQL = %#v, want scoped table delete", writeDB.execCalls)
			}
		})
	}
}

func newProductCalculationRowValues(id int64) []any {
	now := time.Date(2026, 11, 8, 9, 30, 0, 0, time.UTC)
	return []any{
		id, int64(7), "北美项目", "SKU-中文", nil, nil, "profit_calc",
		10.0, 8.0, 4.0, 0.4,
		30.0, 5.0, 35.0, 5.0,
		20.0, 0.25, 0.1, 0.04, 1.0, "single_destination",
		7.1, "monthly",
		"small_standard", "小号标准件", "under_10", "$10 以下",
		4.0, 3.0, 2.0, 14.0, 24.0, 0.000014,
		0.88, 14.08, 0.01, 0.88, 14.08, "实重",
		"配送费规则", "入库配置费规则", "仓储费规则",
		3.0, 2.0, 0.8, 4.0, 0.3, 0.2, 6.0,
		0.0, 0.0, 0.0,
		14.0, 9.0, 0.45, 0.0, nil, nil,
		[]byte(`["重量依据为亚马逊计费重"]`), nil, nil, nil, nil, now, now,
	}
}

type stage3BQueryCall struct {
	sql  string
	args []any
}

type stage3BDB struct {
	row           pgx.Row
	queryRow      func(string, []any) pgx.Row
	rows          Rows
	queryCalls    []stage3BQueryCall
	queryRowCalls []stage3BQueryCall
	execCalls     []stage3BQueryCall
	execTag       pgconn.CommandTag
	execErr       error
}

func (db *stage3BDB) Query(_ context.Context, sql string, args ...any) (Rows, error) {
	db.queryCalls = append(db.queryCalls, stage3BQueryCall{sql: sql, args: args})
	return db.rows, nil
}

func (db *stage3BDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	db.queryRowCalls = append(db.queryRowCalls, stage3BQueryCall{sql: sql, args: args})
	if db.queryRow != nil {
		return db.queryRow(sql, args)
	}
	if db.row == nil {
		return stage3BRow{err: pgx.ErrNoRows}
	}
	return db.row
}

func newProductUpsertTestDB(insertedRow []any) *stage3BDB {
	return &stage3BDB{
		queryRow: func(sql string, _ []any) pgx.Row {
			switch {
			case strings.Contains(sql, "select project_name"):
				return stage3BRow{values: []any{"北美项目", 0.15}}
			case strings.Contains(sql, "from public.product_costs"):
				return stage3BRow{values: []any{
					"B0TEST", "US", 30.0, 5.0, 10.0, 8.0, 4.0, 0.4,
				}}
			default:
				return stage3BRow{values: insertedRow}
			}
		},
	}
}

func mapNewProductInsertArgs(args []any) map[string]any {
	result := make(map[string]any, len(newProductCalculationInsertColumns))
	for index, column := range newProductCalculationInsertColumns {
		result[column] = args[index]
	}
	return result
}

func (*stage3BDB) Ping(context.Context) error { return nil }

func (db *stage3BDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	db.execCalls = append(db.execCalls, stage3BQueryCall{sql: sql, args: args})
	return db.execTag, db.execErr
}

func (*stage3BDB) Begin(context.Context) (pgx.Tx, error) {
	return nil, errors.New("unexpected transaction")
}

type stage3BRow struct {
	values []any
	err    error
}

func (row stage3BRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	if len(dest) != len(row.values) {
		return fmt.Errorf("scan destination count %d does not match value count %d", len(dest), len(row.values))
	}
	for index, value := range row.values {
		switch target := dest[index].(type) {
		case *int:
			number, ok := value.(int)
			if !ok {
				return fmt.Errorf("scan value %d is not int: %T", index, value)
			}
			*target = number
		case *int64:
			number, ok := value.(int64)
			if !ok {
				return fmt.Errorf("scan value %d is not int64: %T", index, value)
			}
			*target = number
		case *float64:
			number, ok := value.(float64)
			if !ok {
				return fmt.Errorf("scan value %d is not float64: %T", index, value)
			}
			*target = number
		case *string:
			text, ok := value.(string)
			if !ok {
				return fmt.Errorf("scan value %d is not string: %T", index, value)
			}
			*target = text
		case **string:
			if value == nil {
				*target = nil
				continue
			}
			switch text := value.(type) {
			case string:
				*target = &text
			case *string:
				*target = text
			default:
				return fmt.Errorf("scan value %d is not nullable string: %T", index, value)
			}
		case **float64:
			if value == nil {
				*target = nil
				continue
			}
			switch number := value.(type) {
			case float64:
				*target = &number
			case *float64:
				*target = number
			default:
				return fmt.Errorf("scan value %d is not nullable float64: %T", index, value)
			}
		case **time.Time:
			if value == nil {
				*target = nil
				continue
			}
			switch timestamp := value.(type) {
			case time.Time:
				*target = &timestamp
			case *time.Time:
				*target = timestamp
			default:
				return fmt.Errorf("scan value %d is not nullable time: %T", index, value)
			}
		case *pgtype.Float8:
			if value == nil {
				*target = pgtype.Float8{}
				continue
			}
			number, ok := value.(float64)
			if !ok {
				return fmt.Errorf("scan value %d is not float64: %T", index, value)
			}
			*target = pgtype.Float8{Float64: number, Valid: true}
		case *[]byte:
			if value == nil {
				*target = nil
				continue
			}
			raw, ok := value.([]byte)
			if !ok {
				return fmt.Errorf("scan value %d is not bytes: %T", index, value)
			}
			*target = raw
		case *time.Time:
			timestamp, ok := value.(time.Time)
			if !ok {
				return fmt.Errorf("scan value %d is not time.Time: %T", index, value)
			}
			*target = timestamp
		default:
			return fmt.Errorf("unsupported scan destination %T", dest[index])
		}
	}
	return nil
}

type stage3BRows struct {
	batches [][]any
	index   int
	err     error
}

func (rows *stage3BRows) Next() bool {
	if rows.index >= len(rows.batches) {
		return false
	}
	rows.index++
	return true
}

func (rows *stage3BRows) Scan(dest ...any) error {
	if rows.index == 0 || rows.index > len(rows.batches) {
		return errors.New("Scan called without a current row")
	}
	return (stage3BRow{values: rows.batches[rows.index-1]}).Scan(dest...)
}

func (rows *stage3BRows) Err() error { return rows.err }
func (*stage3BRows) Close()          {}


func TestNewProductCalculationStoreUpsertMissingMasterProductSucceeds(t *testing.T) {
	db := &stage3BDB{
		queryRow: func(sql string, _ []any) pgx.Row {
			switch {
			case strings.Contains(sql, "select project_name"):
				return stage3BRow{values: []any{"北美项目", 0.15}}
			case strings.Contains(sql, "from public.product_costs"):
				return stage3BRow{err: pgx.ErrNoRows}
			default:
				return stage3BRow{values: newProductCalculationRowValues(42)}
			}
		},
	}
	input := new_product_calculations.CreateRequest{
		ProjectID: 7, ProjectName: "北美项目", SKU: "NEW-SKU-WITHOUT-MASTER",
		CalculationType: "profit_calc",
		PackageLengthCM: 10, PackageWidthCM: 8, PackageHeightCM: 4, WeightKG: 0.4,
		FOBProductCostRMB: 30, FirstLegCostRMB: 5, SalePriceUSD: 20,
		AdvertisingRate: 0.1, ReturnLossRate: 0.04, StorageMonths: 1,
		InboundPlacementMode: "single_destination", USDToRMBRate: 7.1,
	}
	item, err := NewProductCalculationStore(db).Upsert(context.Background(), input, "林一")
	if err != nil {
		t.Fatalf("Upsert() with un-costed new SKU should succeed, got error = %v", err)
	}
	if item == nil || item.ID != 42 {
		t.Fatalf("Upsert() item = %#v, want ID 42", item)
	}
}

func TestNewProductCalculationStoreUpsertPreservesPrecalculatedWireMetrics(t *testing.T) {
	db := newProductUpsertTestDB(newProductCalculationRowValues(43))
	input := new_product_calculations.CreateRequest{
		ProjectID: 7, ProjectName: "北美项目", SKU: "PRECALCULATED-SKU",
		CalculationType: "profit_calc",
		PackageLengthCM: 10, PackageWidthCM: 8, PackageHeightCM: 4, WeightKG: 0.4,
		FOBProductCostRMB: 30, FirstLegCostRMB: 5, SalePriceUSD: 25.5,
		AdvertisingRate: 0.1, ReturnLossRate: 0.04, StorageMonths: 1,
		InboundPlacementMode: "single_destination", USDToRMBRate: 7.1,
		TotalFeeUSD: 11.23, ProfitUSD: 8.45, PayoutUSD: 14.27, ProfitRate: 0.331,
		FBAFulfillmentFeeUSD: 4.56,
	}
	item, err := NewProductCalculationStore(db).Upsert(context.Background(), input, "林一")
	if err != nil {
		t.Fatalf("Upsert() with precalculated metrics error = %v", err)
	}
	if item == nil {
		t.Fatal("Upsert() returned nil item")
	}
	insertCall := db.queryRowCalls[len(db.queryRowCalls)-1]
	args := mapNewProductInsertArgs(insertCall.args)
	if args["total_fee_usd"] != 11.23 {
		t.Errorf("total_fee_usd = %v, want 11.23", args["total_fee_usd"])
	}
	if args["profit_usd"] != 8.45 {
		t.Errorf("profit_usd = %v, want 8.45", args["profit_usd"])
	}
	if args["payout_usd"] != 14.27 {
		t.Errorf("payout_usd = %v, want 14.27", args["payout_usd"])
	}
}
