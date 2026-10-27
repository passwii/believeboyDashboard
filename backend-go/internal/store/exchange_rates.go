package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/exchange_rates"
)

type ExchangeRateStore struct {
	db DB
}

func NewExchangeRateStore(db DB) *ExchangeRateStore {
	return &ExchangeRateStore{db: db}
}

func (s *ExchangeRateStore) List(
	ctx context.Context,
	currency *string,
	yearMonth *string,
	page int,
	pageSize int,
) ([]exchange_rates.ExchangeRate, int, error) {
	page = max(page, 1)
	pageSize = min(max(pageSize, 1), 200)

	var total int
	if err := s.db.QueryRow(
		ctx,
		`select count(*)
		 from public.exchange_rates
		 where ($1::text is null or currency = $1)
		   and ($2::text is null or year_month = $2)`,
		currency,
		yearMonth,
	).Scan(&total); err != nil {
		return nil, 0, err
	}

	rows, err := s.db.Query(
		ctx,
		`select
		   id, currency, currency_name, year_month, rate, description,
		   note_images, created_at, updated_at
		 from public.exchange_rates
		 where ($1::text is null or currency = $1)
		   and ($2::text is null or year_month = $2)
		 order by year_month desc, currency asc
		 offset $3
		 limit $4`,
		currency,
		yearMonth,
		(page-1)*pageSize,
		pageSize,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	items := make([]exchange_rates.ExchangeRate, 0)
	for rows.Next() {
		item, err := scanExchangeRate(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return items, total, nil
}

func (s *ExchangeRateStore) Resolve(
	ctx context.Context,
	currency string,
	yearMonth string,
) (*exchange_rates.ExchangeRate, error) {
	queries := []struct {
		sql  string
		args []any
	}{
		{
			sql: `select
			        id, currency, currency_name, year_month, rate, description,
			        note_images, created_at, updated_at
			      from public.exchange_rates
			      where currency = $1 and year_month = $2
			      limit 1`,
			args: []any{currency, yearMonth},
		},
		{
			sql: `select
			        id, currency, currency_name, year_month, rate, description,
			        note_images, created_at, updated_at
			      from public.exchange_rates
			      where currency = $1 and year_month <= $2
			      order by year_month desc, id desc
			      limit 1`,
			args: []any{currency, yearMonth},
		},
		{
			sql: `select
			        id, currency, currency_name, year_month, rate, description,
			        note_images, created_at, updated_at
			      from public.exchange_rates
			      where currency = $1
			      order by year_month desc, id desc
			      limit 1`,
			args: []any{currency},
		},
	}

	for _, query := range queries {
		row := s.db.QueryRow(ctx, query.sql, query.args...)
		item, err := scanExchangeRateRow(row)
		if err == nil {
			return &item, nil
		}
		if err != pgx.ErrNoRows {
			return nil, err
		}
	}
	return nil, nil
}

func (s *ExchangeRateStore) ListOptionRows(ctx context.Context) ([]exchange_rates.ExchangeRate, error) {
	rows, err := s.db.Query(
		ctx,
		`select
		   id, currency, currency_name, year_month, rate, description,
		   note_images, created_at, updated_at
		 from public.exchange_rates
		 order by year_month desc, currency asc`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]exchange_rates.ExchangeRate, 0)
	for rows.Next() {
		item, err := scanExchangeRate(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *ExchangeRateStore) Get(ctx context.Context, id int64) (*exchange_rates.ExchangeRate, error) {
	row := s.db.QueryRow(
		ctx,
		`select
		   id, currency, currency_name, year_month, rate, description,
		   note_images, created_at, updated_at
		 from public.exchange_rates
		 where id = $1
		 limit 1`,
		id,
	)
	item, err := scanExchangeRate(row)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

type exchangeRateScanner interface {
	Scan(dest ...any) error
}

func scanExchangeRateRow(row pgx.Row) (exchange_rates.ExchangeRate, error) {
	return scanExchangeRate(row)
}

func scanExchangeRate(scanner exchangeRateScanner) (exchange_rates.ExchangeRate, error) {
	var (
		id           int64
		currency     string
		currencyName pgtype.Text
		yearMonth    string
		rate         pgtype.Numeric
		description  pgtype.Text
		noteImages   []byte
		createdAt    pgtype.Timestamptz
		updatedAt    pgtype.Timestamptz
	)
	if err := scanner.Scan(
		&id,
		&currency,
		&currencyName,
		&yearMonth,
		&rate,
		&description,
		&noteImages,
		&createdAt,
		&updatedAt,
	); err != nil {
		return exchange_rates.ExchangeRate{}, err
	}

	rateValue, err := numericFloat64(rate)
	if err != nil {
		return exchange_rates.ExchangeRate{}, fmt.Errorf("scan exchange rate %d rate: %w", id, err)
	}
	images, err := decodeNoteImages(noteImages)
	if err != nil {
		return exchange_rates.ExchangeRate{}, fmt.Errorf("scan exchange rate %d note_images: %w", id, err)
	}

	return exchange_rates.ExchangeRate{
		ID:           id,
		Currency:     currency,
		CurrencyName: Text(currencyName),
		YearMonth:    yearMonth,
		Rate:         rateValue,
		Description:  Text(description),
		NoteImages:   images,
		CreatedAt:    createdAt.Time,
		UpdatedAt:    updatedAt.Time,
	}, nil
}

func numericFloat64(value pgtype.Numeric) (float64, error) {
	if !value.Valid {
		return 0, nil
	}
	text, err := value.Value()
	if err != nil {
		return 0, err
	}
	switch typed := text.(type) {
	case string:
		return strconv.ParseFloat(typed, 64)
	case []byte:
		return strconv.ParseFloat(string(typed), 64)
	default:
		return strconv.ParseFloat(fmt.Sprint(typed), 64)
	}
}

func decodeNoteImages(raw []byte) ([]map[string]any, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var images []map[string]any
	if err := json.Unmarshal(raw, &images); err != nil {
		return nil, err
	}
	return images, nil
}
