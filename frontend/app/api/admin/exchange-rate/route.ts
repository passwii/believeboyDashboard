import { NextRequest, NextResponse } from 'next/server';
import { requireAdminSession, requireUserSession } from '@/lib/auth/server';
import { exchangeRateDb, ExchangeRateFilters } from '@/lib/db';

// GET: Fetch all exchange rates with optional filtering
export async function GET(request: NextRequest) {
  try {
    const session = await requireUserSession()
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url);
    const currency = searchParams.get('currency') || undefined;
    const year_month = searchParams.get('year_month') || undefined;

    const filters: ExchangeRateFilters = {};
    if (currency) filters.currency = currency;
    if (year_month) filters.year_month = year_month;

    const exchangeRates = await exchangeRateDb.getAll(filters);
    return NextResponse.json({ success: true, data: exchangeRates.data });
  } catch (error) {
    console.error('Error fetching exchange rates:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch exchange rates' },
      { status: 500 }
    );
  }
}

// POST: Create a new exchange rate
export async function POST(request: NextRequest) {
  try {
    const session = await requireAdminSession()
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json();
    const { currency, year_month, rate } = body;

    // Validation
    if (!currency || !year_month || rate === undefined || rate === null) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: currency, year_month, rate' },
        { status: 400 }
      );
    }

    if (typeof rate !== 'number' || rate <= 0) {
      return NextResponse.json(
        { success: false, error: 'Rate must be a positive number' },
        { status: 400 }
      );
    }

    // Check for existing record
    const existing = await exchangeRateDb.getByCurrencyAndMonth(currency, year_month);
    if (existing) {
      return NextResponse.json(
        { success: false, error: 'Exchange rate for this currency and month already exists' },
        { status: 409 }
      );
    }

    const newExchangeRate = await exchangeRateDb.create({ currency, year_month, rate });
    return NextResponse.json({ success: true, data: newExchangeRate }, { status: 201 });
  } catch (error) {
    console.error('Error creating exchange rate:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create exchange rate' },
      { status: 500 }
    );
  }
}
