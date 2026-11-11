package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/vat_invoices"
)

type VatInvoiceStore struct {
	db FullDB
}

const (
	maxVATInvoicePDFBytes = 20 * 1024 * 1024
	vatStatusDraft        = "draft"
	vatStatusIssued       = "issued"
	vatStatusVoided       = "voided"
)

const vatAttachInvoicePDFSQL = `
	update public.vat_invoices
	set r2_key = $1,
	    r2_url = $2,
	    status = case when status = 'draft' then 'issued' else status end,
	    updated_at = now()
	where id = $3
	returning invoice_no, status
`

const vatVoidInvoiceSQL = `
	update public.vat_invoices
	set status = 'voided', void_reason = $1, updated_at = now()
	where id = $2
`

func NewVatInvoiceStore(db FullDB) *VatInvoiceStore {
	return &VatInvoiceStore{db: db}
}

func validVATInvoiceStatus(status string) bool {
	switch status {
	case vatStatusDraft, vatStatusIssued, vatStatusVoided:
		return true
	default:
		return false
	}
}

func formatVATAmount(value float64) string {
	return strconv.FormatFloat(value, 'f', 2, 64)
}

func round2(val float64) float64 {
	return math.Round(val*100) / 100
}

func splitVat(incl float64, ratePct float64) (excl float64, vat float64, roundedIncl float64) {
	r := ratePct / 100.0
	excl = round2(incl / (1.0 + r))
	vat = round2(incl - excl)
	return excl, vat, round2(incl)
}

func computeInvoiceTotals(lines []vat_invoices.VatInvoiceLineIn, shippingIncl float64) (float64, float64, float64, []any) {
	type bucket struct {
		rate         float64
		itemExcl     float64
		itemVat      float64
		shippingExcl float64
		shippingVat  float64
	}

	buckets := make(map[float64]*bucket)
	itemsTotal := 0.0

	for _, ln := range lines {
		subIncl := float64(ln.Qty) * ln.UnitPriceInclVat
		excl, vat, incl := splitVat(subIncl, ln.VatRate)
		itemsTotal = round2(itemsTotal + incl)

		b, ok := buckets[ln.VatRate]
		if !ok {
			b = &bucket{rate: ln.VatRate}
			buckets[ln.VatRate] = b
		}
		b.itemExcl = round2(b.itemExcl + excl)
		b.itemVat = round2(b.itemVat + vat)
	}

	if len(lines) > 0 {
		firstRate := lines[0].VatRate
		shipExcl, shipVat, _ := splitVat(shippingIncl, firstRate)
		b, ok := buckets[firstRate]
		if !ok {
			b = &bucket{rate: firstRate}
			buckets[firstRate] = b
		}
		b.shippingExcl = round2(b.shippingExcl + shipExcl)
		b.shippingVat = round2(b.shippingVat + shipVat)
	}

	var rates []float64
	for r := range buckets {
		rates = append(rates, r)
	}
	sort.Float64s(rates)

	var summary []any
	subtotalExcl := 0.0
	for _, r := range rates {
		b := buckets[r]
		tot := round2(b.itemExcl + b.itemVat + b.shippingExcl + b.shippingVat)
		summary = append(summary, map[string]any{
			"rate":          b.rate,
			"item_excl":     b.itemExcl,
			"item_vat":      b.itemVat,
			"shipping_excl": b.shippingExcl,
			"shipping_vat":  b.shippingVat,
			"total":         tot,
		})
		subtotalExcl = round2(subtotalExcl + b.itemExcl + b.shippingExcl)
	}

	totalIncl := round2(itemsTotal + shippingIncl)
	totalVat := round2(totalIncl - subtotalExcl)
	return subtotalExcl, totalVat, totalIncl, summary
}

func (s *VatInvoiceStore) VerifyProjectAccess(ctx context.Context, projectID int64, op string, isAdmin bool) error {
	if isAdmin {
		return nil
	}
	var projOp, asstOp *string
	err := s.db.QueryRow(ctx, "select project_operator, assistant_operator from public.projects where id = $1", projectID).Scan(&projOp, &asstOp)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return vat_invoices.ErrProjectNotFound
		}
		return err
	}
	op = strings.TrimSpace(op)
	if op == "" {
		return vat_invoices.ErrProjectForbidden
	}
	if textContainsName(projOp, op) || textContainsName(asstOp, op) {
		return nil
	}
	return vat_invoices.ErrProjectForbidden
}

func (s *VatInvoiceStore) EnsureVatEnabled(ctx context.Context, projectID int64) error {
	var vatEnabled bool
	err := s.db.QueryRow(ctx, "select coalesce(vat_enabled, false) from public.projects where id = $1", projectID).Scan(&vatEnabled)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return vat_invoices.ErrProjectNotFound
		}
		return err
	}
	if !vatEnabled {
		return vat_invoices.ErrVatNotEnabled
	}
	return nil
}

// ---------------------------------------------------------------------------
// Entity Store
// ---------------------------------------------------------------------------

func (s *VatInvoiceStore) ListEntities(ctx context.Context, projectID int64) ([]vat_invoices.VatEntityResponse, error) {
	rows, err := s.db.Query(ctx, `
		select id, project_id, country, company_name, vat_id, address_line, postal_code, city, email, is_default, created_at, updated_at
		from public.vat_entities
		where project_id = $1
		order by country asc
	`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []vat_invoices.VatEntityResponse
	for rows.Next() {
		var it vat_invoices.VatEntityResponse
		var createdAt, updatedAt time.Time
		if err := rows.Scan(
			&it.ID, &it.ProjectID, &it.Country, &it.CompanyName, &it.VatID,
			&it.AddressLine, &it.PostalCode, &it.City, &it.Email, &it.IsDefault,
			&createdAt, &updatedAt,
		); err != nil {
			return nil, err
		}
		it.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
		it.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
		items = append(items, it)
	}
	if items == nil {
		items = []vat_invoices.VatEntityResponse{}
	}
	return items, rows.Err()
}

func (s *VatInvoiceStore) UpsertEntity(ctx context.Context, payload vat_invoices.VatEntityCreate) (*vat_invoices.VatEntityResponse, error) {
	querySQL := `
		insert into public.vat_entities (
			project_id, country, company_name, vat_id, address_line, postal_code, city, email, is_default, created_at, updated_at
		) values (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now()
		)
		on conflict (project_id, country) do update set
			company_name = excluded.company_name,
			vat_id = excluded.vat_id,
			address_line = excluded.address_line,
			postal_code = excluded.postal_code,
			city = excluded.city,
			email = excluded.email,
			is_default = excluded.is_default,
			updated_at = now()
		returning id, created_at, updated_at
	`
	var id int64
	var createdAt, updatedAt time.Time
	err := s.db.QueryRow(ctx, querySQL,
		payload.ProjectID, payload.Country, payload.CompanyName, payload.VatID,
		payload.AddressLine, payload.PostalCode, payload.City, payload.Email, payload.IsDefault,
	).Scan(&id, &createdAt, &updatedAt)
	if err != nil {
		return nil, err
	}

	return &vat_invoices.VatEntityResponse{
		VatEntityBase: payload.VatEntityBase,
		ID:            id,
		ProjectID:     payload.ProjectID,
		CreatedAt:     createdAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:     updatedAt.UTC().Format(time.RFC3339Nano),
	}, nil
}

func (s *VatInvoiceStore) GetEntity(ctx context.Context, entityID int64) (*vat_invoices.VatEntityResponse, error) {
	querySQL := `
		select id, project_id, country, company_name, vat_id, address_line, postal_code, city, email, is_default, created_at, updated_at
		from public.vat_entities
		where id = $1
	`
	var it vat_invoices.VatEntityResponse
	var createdAt, updatedAt time.Time
	err := s.db.QueryRow(ctx, querySQL, entityID).Scan(
		&it.ID, &it.ProjectID, &it.Country, &it.CompanyName, &it.VatID,
		&it.AddressLine, &it.PostalCode, &it.City, &it.Email, &it.IsDefault,
		&createdAt, &updatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, vat_invoices.ErrVatEntityNotFound
		}
		return nil, err
	}
	it.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	it.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	return &it, nil
}

func (s *VatInvoiceStore) UpdateEntity(ctx context.Context, entityID int64, payload vat_invoices.VatEntityUpdate) (*vat_invoices.VatEntityResponse, error) {
	existing, err := s.GetEntity(ctx, entityID)
	if err != nil {
		return nil, err
	}

	var sets []string
	var args []any
	idx := 2
	args = append(args, entityID)

	if payload.CompanyName != nil {
		sets = append(sets, fmt.Sprintf("company_name = $%d", idx))
		args = append(args, *payload.CompanyName)
		idx++
		existing.CompanyName = *payload.CompanyName
	}
	if payload.VatID != nil {
		sets = append(sets, fmt.Sprintf("vat_id = $%d", idx))
		args = append(args, *payload.VatID)
		idx++
		existing.VatID = *payload.VatID
	}
	if payload.AddressLine != nil {
		sets = append(sets, fmt.Sprintf("address_line = $%d", idx))
		args = append(args, *payload.AddressLine)
		idx++
		existing.AddressLine = *payload.AddressLine
	}
	if payload.PostalCode != nil {
		sets = append(sets, fmt.Sprintf("postal_code = $%d", idx))
		args = append(args, *payload.PostalCode)
		idx++
		existing.PostalCode = *payload.PostalCode
	}
	if payload.City != nil {
		sets = append(sets, fmt.Sprintf("city = $%d", idx))
		args = append(args, *payload.City)
		idx++
		existing.City = *payload.City
	}
	if payload.Email != nil {
		sets = append(sets, fmt.Sprintf("email = $%d", idx))
		args = append(args, *payload.Email)
		idx++
		existing.Email = *payload.Email
	}
	if payload.IsDefault != nil {
		sets = append(sets, fmt.Sprintf("is_default = $%d", idx))
		args = append(args, *payload.IsDefault)
		idx++
		existing.IsDefault = *payload.IsDefault
	}

	if len(sets) == 0 {
		return existing, nil
	}

	sets = append(sets, "updated_at = now()")
	querySQL := fmt.Sprintf("update public.vat_entities set %s where id = $1 returning updated_at", strings.Join(sets, ", "))
	var updatedAt time.Time
	if err := s.db.QueryRow(ctx, querySQL, args...).Scan(&updatedAt); err != nil {
		return nil, err
	}
	existing.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	return existing, nil
}

func (s *VatInvoiceStore) DeleteEntity(ctx context.Context, entityID int64) error {
	tag, err := s.db.Exec(ctx, "delete from public.vat_entities where id = $1", entityID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return vat_invoices.ErrVatEntityNotFound
	}
	return nil
}

// ---------------------------------------------------------------------------
// Invoice Store
// ---------------------------------------------------------------------------

func (s *VatInvoiceStore) ListInvoices(ctx context.Context, filter vat_invoices.VatInvoiceFilter) ([]vat_invoices.VatInvoiceListItem, error) {
	var conditions []string
	var args []any
	idx := 1

	if filter.ProjectID != nil && *filter.ProjectID > 0 {
		conditions = append(conditions, fmt.Sprintf("i.project_id = $%d", idx))
		args = append(args, *filter.ProjectID)
		idx++
	}
	if filter.Status != nil && *filter.Status != "" {
		if !validVATInvoiceStatus(*filter.Status) {
			return nil, fmt.Errorf("invalid vat invoice status %q", *filter.Status)
		}
		conditions = append(conditions, fmt.Sprintf("i.status = $%d", idx))
		args = append(args, *filter.Status)
		idx++
	}
	if filter.DateFrom != nil && *filter.DateFrom != "" {
		conditions = append(conditions, fmt.Sprintf("i.invoice_date >= $%d::date", idx))
		args = append(args, *filter.DateFrom)
		idx++
	}
	if filter.DateTo != nil && *filter.DateTo != "" {
		conditions = append(conditions, fmt.Sprintf("i.invoice_date <= $%d::date", idx))
		args = append(args, *filter.DateTo)
		idx++
	}
	if filter.Q != nil && *filter.Q != "" {
		pattern := "%" + *filter.Q + "%"
		conditions = append(conditions, fmt.Sprintf("(i.invoice_no ilike $%d or i.order_id ilike $%d)", idx, idx))
		args = append(args, pattern)
		idx++
	}

	where := ""
	if len(conditions) > 0 {
		where = "where " + strings.Join(conditions, " and ")
	}

	limit := filter.Limit
	if limit <= 0 {
		limit = 100
	}
	offset := filter.Offset
	if offset < 0 {
		offset = 0
	}

	querySQL := fmt.Sprintf(`
		select
			i.id, i.invoice_no, i.project_id, coalesce(p.project_name, ''),
			i.currency, i.order_id, coalesce(i.buyer->>'name', ''),
			i.invoice_date::text, i.subtotal_excl, i.total_vat, i.total_incl,
			i.status, (i.r2_key is not null and i.r2_key != ''),
			i.created_at, i.updated_at
		from public.vat_invoices i
		left join public.projects p on p.id = i.project_id
		%s
		order by i.invoice_date desc, i.id desc
		limit $%d offset $%d
	`, where, idx, idx+1)
	args = append(args, limit, offset)

	rows, err := s.db.Query(ctx, querySQL, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []vat_invoices.VatInvoiceListItem
	for rows.Next() {
		var it vat_invoices.VatInvoiceListItem
		var createdAt, updatedAt time.Time
		var subtotalExcl, totalVat, totalIncl float64
		if err := rows.Scan(
			&it.ID, &it.InvoiceNo, &it.ProjectID, &it.ProjectName,
			&it.Currency, &it.OrderID, &it.BuyerName,
			&it.InvoiceDate, &subtotalExcl, &totalVat, &totalIncl,
			&it.Status, &it.HasPdf, &createdAt, &updatedAt,
		); err != nil {
			return nil, err
		}
		it.SubtotalExcl = formatVATAmount(subtotalExcl)
		it.TotalVat = formatVATAmount(totalVat)
		it.TotalIncl = formatVATAmount(totalIncl)
		it.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
		it.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
		items = append(items, it)
	}
	if items == nil {
		items = []vat_invoices.VatInvoiceListItem{}
	}
	return items, rows.Err()
}

func (s *VatInvoiceStore) GetInvoice(ctx context.Context, invoiceID int64) (*vat_invoices.VatInvoiceResponse, error) {
	querySQL := `
		select
			id, invoice_no, project_id, seller_entity_id,
			seller_snapshot::text, buyer::text, currency, order_id,
			invoice_date::text, shipping_incl_vat, subtotal_excl, total_vat, total_incl,
			summary_by_rate::text, r2_key, r2_url, status, void_reason, created_by,
			created_at, updated_at
		from public.vat_invoices
		where id = $1
	`
	var it vat_invoices.VatInvoiceResponse
	var sellerJSON, buyerJSON, summaryJSON *string
	var createdAt, updatedAt time.Time
	err := s.db.QueryRow(ctx, querySQL, invoiceID).Scan(
		&it.ID, &it.InvoiceNo, &it.ProjectID, &it.SellerEntityID,
		&sellerJSON, &buyerJSON, &it.Currency, &it.OrderID,
		&it.InvoiceDate, &it.ShippingInclVat, &it.SubtotalExcl, &it.TotalVat, &it.TotalIncl,
		&summaryJSON, &it.R2Key, &it.R2URL, &it.Status, &it.VoidReason, &it.CreatedBy,
		&createdAt, &updatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, vat_invoices.ErrVatInvoiceNotFound
		}
		return nil, err
	}

	it.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	it.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	it.SellerSnapshot = map[string]any{}
	if sellerJSON != nil && *sellerJSON != "" {
		_ = json.Unmarshal([]byte(*sellerJSON), &it.SellerSnapshot)
	}
	it.Buyer = map[string]any{}
	if buyerJSON != nil && *buyerJSON != "" {
		_ = json.Unmarshal([]byte(*buyerJSON), &it.Buyer)
	}
	it.SummaryByRate = []any{}
	if summaryJSON != nil && *summaryJSON != "" {
		_ = json.Unmarshal([]byte(*summaryJSON), &it.SummaryByRate)
	}

	// Fetch invoice lines
	lineRows, err := s.db.Query(ctx, `
		select id, line_no, description, asin, qty, unit_price_incl_vat, vat_rate, line_excl, line_vat, line_incl
		from public.vat_invoice_lines
		where invoice_id = $1
		order by line_no asc
	`, invoiceID)
	if err != nil {
		return nil, err
	}
	defer lineRows.Close()

	it.Lines = []vat_invoices.VatInvoiceLineResponse{}
	for lineRows.Next() {
		var ln vat_invoices.VatInvoiceLineResponse
		if err := lineRows.Scan(
			&ln.ID, &ln.LineNo, &ln.Description, &ln.ASIN, &ln.Qty,
			&ln.UnitPriceInclVat, &ln.VatRate, &ln.LineExcl, &ln.LineVat, &ln.LineIncl,
		); err != nil {
			return nil, err
		}
		it.Lines = append(it.Lines, ln)
	}

	return &it, nil
}

func (s *VatInvoiceStore) CreateInvoice(ctx context.Context, payload vat_invoices.VatInvoiceCreate, createdBy string) (*vat_invoices.VatInvoiceResponse, error) {
	var resp *vat_invoices.VatInvoiceResponse

	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)

		// 1. Seller snapshot if entity provided
		sellerSnapshot := map[string]any{}
		var vatID string
		if payload.SellerEntityID != nil {
			var country, companyName, addressLine, postalCode, city, email string
			err := txDB.QueryRow(ctx, `
				select country, company_name, vat_id, address_line, postal_code, city, email
				from public.vat_entities
				where id = $1
			`, *payload.SellerEntityID).Scan(&country, &companyName, &vatID, &addressLine, &postalCode, &city, &email)
			if err == nil {
				sellerSnapshot = map[string]any{
					"country":      country,
					"company_name": companyName,
					"vat_id":       vatID,
					"address_line": addressLine,
					"postal_code":  postalCode,
					"city":         city,
					"email":        email,
				}
			} else if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}

		// 2. Calculations
		subtotalExcl, totalVat, totalIncl, summaryByRate := computeInvoiceTotals(payload.Lines, payload.ShippingInclVat)

		status := payload.Status
		if status == "" {
			status = vatStatusDraft
		}
		if !validVATInvoiceStatus(status) {
			return fmt.Errorf("invalid vat invoice status %q", status)
		}

		sellerBytes, err := json.Marshal(sellerSnapshot)
		if err != nil {
			return err
		}
		buyerBytes, err := json.Marshal(payload.Buyer)
		if err != nil {
			return err
		}
		summaryBytes, err := json.Marshal(summaryByRate)
		if err != nil {
			return err
		}

		// 3. Insert invoice with draft placeholder
		placeholderNo := fmt.Sprintf("DRAFT-%d", time.Now().UnixNano())
		insertSQL := `
			insert into public.vat_invoices (
				invoice_no, project_id, seller_entity_id, seller_snapshot, buyer,
				currency, order_id, invoice_date, shipping_incl_vat, subtotal_excl,
				total_vat, total_incl, summary_by_rate, status, created_by,
				created_at, updated_at
			) values (
				$1, $2, $3, $4::jsonb, $5::jsonb,
				$6, $7, $8::date, $9, $10,
				$11, $12, $13::jsonb, $14, $15,
				now(), now()
			)
			returning id, created_at, updated_at
		`
		var invoiceID int64
		var createdAt, updatedAt time.Time
		err = txDB.QueryRow(ctx, insertSQL,
			placeholderNo, payload.ProjectID, payload.SellerEntityID, string(sellerBytes), string(buyerBytes),
			payload.Currency, payload.OrderID, payload.InvoiceDate, payload.ShippingInclVat, subtotalExcl,
			totalVat, totalIncl, string(summaryBytes), status, createdBy,
		).Scan(&invoiceID, &createdAt, &updatedAt)
		if err != nil {
			return err
		}

		// 4. Compute real invoice_no: INV-{vat_no}-{year}-{id:06d}
		year := time.Now().Year()
		if len(payload.InvoiceDate) >= 4 {
			if y, parseErr := strconv.Atoi(payload.InvoiceDate[:4]); parseErr == nil {
				year = y
			}
		}
		cleanVat := strings.ReplaceAll(strings.TrimSpace(vatID), " ", "")
		if cleanVat == "" {
			cleanVat = "NA"
		}
		realInvoiceNo := fmt.Sprintf("INV-%s-%d-%06d", cleanVat, year, invoiceID)

		_, err = txDB.Exec(ctx, "update public.vat_invoices set invoice_no = $1 where id = $2", realInvoiceNo, invoiceID)
		if err != nil {
			return err
		}

		// 5. Insert lines
		var linesResp []vat_invoices.VatInvoiceLineResponse
		for idx, ln := range payload.Lines {
			lineNo := idx + 1
			subIncl := float64(ln.Qty) * ln.UnitPriceInclVat
			excl, vat, incl := splitVat(subIncl, ln.VatRate)

			var lineID int64
			err := txDB.QueryRow(ctx, `
				insert into public.vat_invoice_lines (
					invoice_id, line_no, description, asin, qty,
					unit_price_incl_vat, vat_rate, line_excl, line_vat, line_incl
				) values (
					$1, $2, $3, $4, $5,
					$6, $7, $8, $9, $10
				)
				returning id
			`, invoiceID, lineNo, ln.Description, ln.ASIN, ln.Qty,
				ln.UnitPriceInclVat, ln.VatRate, excl, vat, incl).Scan(&lineID)
			if err != nil {
				return err
			}

			linesResp = append(linesResp, vat_invoices.VatInvoiceLineResponse{
				VatInvoiceLineIn: ln,
				ID:               lineID,
				LineNo:           lineNo,
				LineExcl:         excl,
				LineVat:          vat,
				LineIncl:         incl,
			})
		}

		buyerMap := map[string]any{}
		_ = json.Unmarshal(buyerBytes, &buyerMap)

		resp = &vat_invoices.VatInvoiceResponse{
			ID:              invoiceID,
			InvoiceNo:       realInvoiceNo,
			ProjectID:       payload.ProjectID,
			SellerEntityID:  payload.SellerEntityID,
			SellerSnapshot:  sellerSnapshot,
			Buyer:           buyerMap,
			Currency:        payload.Currency,
			OrderID:         payload.OrderID,
			InvoiceDate:     payload.InvoiceDate,
			ShippingInclVat: payload.ShippingInclVat,
			SubtotalExcl:    subtotalExcl,
			TotalVat:        totalVat,
			TotalIncl:       totalIncl,
			SummaryByRate:   summaryByRate,
			Status:          status,
			CreatedBy:       &createdBy,
			CreatedAt:       createdAt.UTC().Format(time.RFC3339Nano),
			UpdatedAt:       updatedAt.UTC().Format(time.RFC3339Nano),
			Lines:           linesResp,
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return resp, nil
}

func (s *VatInvoiceStore) AttachInvoicePdf(ctx context.Context, invoiceID int64, filename string, pdfBytes []byte) (*vat_invoices.VatInvoicePdfUploadResponse, error) {
	if len(pdfBytes) == 0 {
		return nil, errors.New("PDF 文件为空")
	}
	if len(pdfBytes) > maxVATInvoicePDFBytes {
		return nil, fmt.Errorf("PDF 文件超过 %dMB 上限", maxVATInvoicePDFBytes/(1024*1024))
	}
	if !bytes.HasPrefix(bytes.TrimSpace(pdfBytes), []byte("%PDF-")) {
		return nil, errors.New("文件内容不是有效的 PDF")
	}
	safeFilename := safeUploadFilename(filename, fmt.Sprintf("invoice-%d.pdf", invoiceID))
	if ext := normalizedFileExtension(safeFilename); ext != ".pdf" {
		return nil, fmt.Errorf("不支持的文件扩展名 %q，仅支持 .pdf", ext)
	}
	key := fmt.Sprintf("vat-invoices/%d_%s", invoiceID, safeFilename)
	url := fmt.Sprintf("https://pub-r2.believeboy.com/%s", key)

	var invoiceNo, status string
	err := s.db.QueryRow(ctx, vatAttachInvoicePDFSQL, key, url, invoiceID).Scan(&invoiceNo, &status)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, vat_invoices.ErrVatInvoiceNotFound
		}
		return nil, err
	}

	return &vat_invoices.VatInvoicePdfUploadResponse{
		ID:        invoiceID,
		InvoiceNo: invoiceNo,
		R2Key:     key,
		R2URL:     url,
		Status:    status,
	}, nil
}

func (s *VatInvoiceStore) VoidInvoice(ctx context.Context, invoiceID int64, reason string) (*vat_invoices.VatInvoiceResponse, error) {
	tag, err := s.db.Exec(ctx, vatVoidInvoiceSQL, reason, invoiceID)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, vat_invoices.ErrVatInvoiceNotFound
	}
	return s.GetInvoice(ctx, invoiceID)
}
