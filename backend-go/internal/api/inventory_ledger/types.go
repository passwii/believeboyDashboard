package inventory_ledger

import "context"
import "errors"

var (
	// ErrProjectNotFound indicates the requested project does not exist.
	ErrProjectNotFound = errors.New("project not found")
	// ErrProjectForbidden indicates the caller lacks permission to access the project.
	ErrProjectForbidden = errors.New("forbidden")
)

type SkuMonthEom struct {
	MSKU        string  `json:"msku"`
	Title       *string `json:"title"`
	QtyEOM      int     `json:"qty_eom"`
	SellableQty int     `json:"sellable_qty"`
	DamagedQty  int     `json:"damaged_qty"`
	PrevQtyEOM  *int    `json:"prev_qty_eom"`
	Change      *int    `json:"change"`
}

type DispositionSummary struct {
	Disposition string  `json:"disposition"`
	QtyEOM      int     `json:"qty_eom"`
	PctOfTotal  float64 `json:"pct_of_total"`
}

type ReceiptCluster struct {
	Date      string `json:"date"`
	Location  string `json:"location"`
	SKUSet    string `json:"sku_set"`
	SKUCount  int    `json:"sku_count"`
	TotalQty  int    `json:"total_qty"`
	ClusterID string `json:"cluster_id"`
}

type SkuMonthEvents struct {
	MSKU               string  `json:"msku"`
	Title              *string `json:"title"`
	TotalReceipts      int     `json:"total_receipts"`
	TotalShipments     int     `json:"total_shipments"`
	TotalReturns       int     `json:"total_returns"`
	TotalDamaged       int     `json:"total_damaged"`
	TotalLost          int     `json:"total_lost"`
	TotalDisposed      int     `json:"total_disposed"`
	TotalFound         int     `json:"total_found"`
	TotalVendorReturns int     `json:"total_vendor_returns"`
	TotalTransfer      int     `json:"total_transfer"`
	TotalOther         int     `json:"total_other"`
	NetChange          int     `json:"net_change"`
}

type LocationDetail struct {
	MSKU        string  `json:"msku"`
	Title       *string `json:"title"`
	Location    string  `json:"location"`
	Disposition string  `json:"disposition"`
	QtyEOM      int     `json:"qty_eom"`
}

type IntegrityMismatch struct {
	MSKU         string `json:"msku"`
	Location     string `json:"location"`
	Disposition  string `json:"disposition"`
	PrevEnding   int    `json:"prev_ending"`
	CurrStarting int    `json:"curr_starting"`
	Diff         int    `json:"diff"`
}

type IntegrityComparison struct {
	MSKU         string `json:"msku"`
	Location     string `json:"location"`
	Disposition  string `json:"disposition"`
	State        string `json:"state"`
	PrevEnding   *int   `json:"prev_ending"`
	CurrStarting *int   `json:"curr_starting"`
	Diff         *int   `json:"diff"`
}

type IntegrityCheckResult struct {
	ReportMonth   string                `json:"report_month"`
	Country       *string               `json:"country"`
	Status        string                `json:"status"` // "OK", "MISMATCH", "PENDING"
	MismatchCount int                   `json:"mismatch_count"`
	Mismatches    []IntegrityMismatch   `json:"mismatches"`
	Comparisons   []IntegrityComparison `json:"comparisons"`
	CheckedAt     string                `json:"checked_at"`
}

type MonthlySnapshotResponse struct {
	ReportMonth        string                `json:"report_month"`
	Country            *string               `json:"country"`
	SKUCount           int                   `json:"sku_count"`
	TotalQty           int                   `json:"total_qty"`
	DispositionSummary []DispositionSummary  `json:"disposition_summary"`
	SKUs               []SkuMonthEom         `json:"skus"`
	Integrity          *IntegrityCheckResult `json:"integrity"`
}

type EventsResponse struct {
	ReportMonth string           `json:"report_month"`
	Country     *string          `json:"country"`
	SKUs        []SkuMonthEvents `json:"skus"`
}

type ReceiptClustersResponse struct {
	ReportMonth string           `json:"report_month"`
	Country     *string          `json:"country"`
	Clusters    []ReceiptCluster `json:"clusters"`
}

type LocationDetailResponse struct {
	ReportMonth string           `json:"report_month"`
	Country     *string          `json:"country"`
	Rows        []LocationDetail `json:"rows"`
}

type MonthsResponse struct {
	ProjectID int64    `json:"project_id"`
	Country   *string  `json:"country"`
	Months    []string `json:"months"`
}

type TrendMonthItem struct {
	ReportMonth    string  `json:"report_month"`
	SKUCount       int     `json:"sku_count"`
	TotalQtyEOM    int     `json:"total_qty_eom"`
	TotalReceipts  int     `json:"total_receipts"`
	TotalShipments int     `json:"total_shipments"`
	TotalReturns   int     `json:"total_returns"`
	TotalDamaged   int     `json:"total_damaged"`
	TotalLost      int     `json:"total_lost"`
	TotalDisposed  int     `json:"total_disposed"`
	DamagedPct     float64 `json:"damaged_pct"`
}

type TrendResponse struct {
	ProjectID int64            `json:"project_id"`
	Country   *string          `json:"country"`
	Months    []TrendMonthItem `json:"months"`
}

type LedgerSummaryRow struct {
	ID                  int64   `json:"id"`
	Date                string  `json:"date"`
	FNSKU               *string `json:"fnsku"`
	ASIN                *string `json:"asin"`
	MSKU                string  `json:"msku"`
	Title               *string `json:"title"`
	Disposition         string  `json:"disposition"`
	Location            string  `json:"location"`
	StartingBalance     int     `json:"starting_balance"`
	InTransitBetween    int     `json:"in_transit_between"`
	Receipts            int     `json:"receipts"`
	CustomerShipments   int     `json:"customer_shipments"`
	CustomerReturns     int     `json:"customer_returns"`
	VendorReturns       int     `json:"vendor_returns"`
	WarehouseTransferIO int     `json:"warehouse_transfer_io"`
	Found               int     `json:"found"`
	Lost                int     `json:"lost"`
	Damaged             int     `json:"damaged"`
	Disposed            int     `json:"disposed"`
	OtherEvents         int     `json:"other_events"`
	EndingBalance       int     `json:"ending_balance"`
	UnknownEvents       int     `json:"unknown_events"`
	Store               *string `json:"store"`
	BatchID             *int64  `json:"batch_id"`
}

type LedgerSummaryResponse struct {
	ReportMonth string             `json:"report_month"`
	Country     *string            `json:"country"`
	Rows        []LedgerSummaryRow `json:"rows"`
}

type LedgerDetailRow struct {
	ID                   int64   `json:"id"`
	Date                 string  `json:"date"`
	FNSKU                *string `json:"fnsku"`
	ASIN                 *string `json:"asin"`
	MSKU                 string  `json:"msku"`
	Title                *string `json:"title"`
	EventType            string  `json:"event_type"`
	ReferenceID          *string `json:"reference_id"`
	Quantity             int     `json:"quantity"`
	FulfillmentCenter    string  `json:"fulfillment_center"`
	Disposition          string  `json:"disposition"`
	Reason               *string `json:"reason"`
	Country              *string `json:"country"`
	ReconciledQuantity   *int    `json:"reconciled_quantity"`
	UnreconciledQuantity *int    `json:"unreconciled_quantity"`
	DateAndTime          *string `json:"date_and_time"`
	Store                *string `json:"store"`
	BatchID              *int64  `json:"batch_id"`
}

type LedgerDetailResponse struct {
	ReportMonth string            `json:"report_month"`
	Country     *string           `json:"country"`
	Rows        []LedgerDetailRow `json:"rows"`
}

type IngestBatchInfo struct {
	ID                       int64   `json:"id"`
	ProjectID                int64   `json:"project_id"`
	ReportMonth              string  `json:"report_month"`
	SourceFilename           string  `json:"source_filename"`
	FileHash                 string  `json:"file_hash"`
	FileSizeBytes            int64   `json:"file_size_bytes"`
	FileKind                 string  `json:"file_kind"`
	LoadedBy                 *string `json:"loaded_by"`
	LoadedAt                 string  `json:"loaded_at"`
	CompletedAt              *string `json:"completed_at"`
	Status                   string  `json:"status"`
	RowsParsed               int     `json:"rows_parsed"`
	RowsWrittenSummary       int     `json:"rows_written_summary"`
	RowsWrittenDetail        int     `json:"rows_written_detail"`
	RowsSkippedDuplicate     int     `json:"rows_skipped_duplicate"`
	RowsFailedValidation     int     `json:"rows_failed_validation"`
	ErrorMessage             *string `json:"error_message"`
	ConsistencyCheck         *string `json:"consistency_check"`
	ConsistencyMismatchCount int     `json:"consistency_mismatch_count"`
}

type IngestBatchesResponse struct {
	ProjectID int64             `json:"project_id"`
	Country   *string           `json:"country"`
	Batches   []IngestBatchInfo `json:"batches"`
}

type ConsistencyMismatch struct {
	MSKU           string `json:"msku"`
	Location       string `json:"location"`
	Disposition    string `json:"disposition"`
	DetailQuantity int    `json:"detail_quantity"`
	SummaryDelta   int    `json:"summary_delta"`
	Diff           int    `json:"diff"`
}

type ConsistencyCheckResult struct {
	ReportMonth   string                `json:"report_month"`
	Country       *string               `json:"country"`
	Status        string                `json:"status"` // "OK", "MISMATCH", "PENDING"
	MismatchCount int                   `json:"mismatch_count"`
	Mismatches    []ConsistencyMismatch `json:"mismatches"`
	CheckedAt     string                `json:"checked_at"`
}

type LedgerMonthAnalysisResponse struct {
	ProjectID   int64                   `json:"project_id"`
	ProjectName string                  `json:"project_name"`
	Country     *string                 `json:"country"`
	ReportMonth string                  `json:"report_month"`
	StartDate   string                  `json:"start_date"`
	EndDate     string                  `json:"end_date"`
	GeneratedAt string                  `json:"generated_at"`
	SummaryRows []LedgerSummaryRow      `json:"summary_rows"`
	DetailRows  []LedgerDetailRow       `json:"detail_rows"`
	Snapshot    MonthlySnapshotResponse `json:"snapshot"`
	Trend       TrendResponse           `json:"trend"`
	Consistency ConsistencyCheckResult  `json:"consistency"`
	Batches     []IngestBatchInfo       `json:"batches"`
}

type Store interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, op string, isAdmin bool) error
	ListMonths(ctx context.Context, projectID int64, country *string) (MonthsResponse, error)
	GetSnapshot(ctx context.Context, projectID int64, country *string, month string) (MonthlySnapshotResponse, error)
	GetEvents(ctx context.Context, projectID int64, country *string, month string) (EventsResponse, error)
	GetClusters(ctx context.Context, projectID int64, country *string, month string) (ReceiptClustersResponse, error)
	GetLocationDetail(ctx context.Context, projectID int64, country *string, month string) (LocationDetailResponse, error)
	GetTrend(ctx context.Context, projectID int64, country *string) (TrendResponse, error)
	GetDetail(ctx context.Context, projectID int64, country *string, month string, msku, eventType *string) (LedgerDetailResponse, error)
	GetSummary(ctx context.Context, projectID int64, country *string, month string, msku, disposition *string) (LedgerSummaryResponse, error)
	ListBatches(ctx context.Context, projectID int64, country *string) (IngestBatchesResponse, error)
	GetConsistency(ctx context.Context, projectID int64, country *string, month string) (ConsistencyCheckResult, error)
	GetMonthAnalysis(ctx context.Context, projectID int64, country *string, month string) (LedgerMonthAnalysisResponse, error)
}
