package pricing

import "math/big"

var (
	cmPerInch       = mustDecimal("2.54")
	kgPerPound      = mustDecimal("0.45359237")
	ouncesPerPound  = mustDecimal("16")
	dimensionalDiv  = mustDecimal("139")
	cubicInPerCubic = mustDecimal("1728")
	returnRelief    = mustDecimal("0.20")
	standardStorage = mustDecimal("0.78")
	oversizeStorage = mustDecimal("0.56")
)

type weightFee struct {
	upper *big.Rat
	fees  [3]*big.Rat
	label string
}

type inboundFee struct {
	upper *big.Rat
	fee   *big.Rat
	label string
}

func feeValues(a, b, c string) [3]*big.Rat {
	return [3]*big.Rat{mustDecimal(a), mustDecimal(b), mustDecimal(c)}
}

var smallStandardFees = []weightFee{
	{mustDecimal("2"), feeValues("2.43", "3.32", "3.58"), "不超过 2 盎司"},
	{mustDecimal("4"), feeValues("2.49", "3.42", "3.68"), "2 至 4 盎司"},
	{mustDecimal("6"), feeValues("2.56", "3.45", "3.71"), "4 至 6 盎司"},
	{mustDecimal("8"), feeValues("2.66", "3.54", "3.80"), "6 至 8 盎司"},
	{mustDecimal("10"), feeValues("2.77", "3.68", "3.94"), "8 至 10 盎司"},
	{mustDecimal("12"), feeValues("2.82", "3.78", "4.04"), "10 至 12 盎司"},
	{mustDecimal("14"), feeValues("2.92", "3.91", "4.17"), "12 至 14 盎司"},
	{mustDecimal("16"), feeValues("2.95", "3.96", "4.22"), "14 至 16 盎司"},
}

var largeStandardFees = []weightFee{
	{div(mustDecimal("4"), ouncesPerPound), feeValues("2.91", "3.73", "3.99"), "不超过 4 盎司"},
	{div(mustDecimal("8"), ouncesPerPound), feeValues("3.13", "3.95", "4.21"), "4 至 8 盎司"},
	{div(mustDecimal("12"), ouncesPerPound), feeValues("3.38", "4.20", "4.46"), "8 至 12 盎司"},
	{div(mustDecimal("16"), ouncesPerPound), feeValues("3.78", "4.60", "4.86"), "12 至 16 盎司"},
	{mustDecimal("1.25"), feeValues("4.22", "5.04", "5.30"), "1 至 1.25 磅"},
	{mustDecimal("1.5"), feeValues("4.60", "5.42", "5.68"), "1.25 至 1.5 磅"},
	{mustDecimal("1.75"), feeValues("4.75", "5.57", "5.83"), "1.5 至 1.75 磅"},
	{mustDecimal("2"), feeValues("5.00", "5.82", "6.08"), "1.75 至 2 磅"},
	{mustDecimal("2.25"), feeValues("5.10", "5.92", "6.18"), "2 至 2.25 磅"},
	{mustDecimal("2.5"), feeValues("5.28", "6.10", "6.36"), "2.25 至 2.5 磅"},
	{mustDecimal("2.75"), feeValues("5.44", "6.26", "6.52"), "2.5 至 2.75 磅"},
	{mustDecimal("3"), feeValues("5.85", "6.67", "6.93"), "2.75 至 3 磅"},
}

var smallStandardInboundFees = []inboundFee{
	{mustDecimal("8"), mustDecimal("0.32"), "不超过 8 盎司"},
	{mustDecimal("16"), mustDecimal("0.32"), "8 至 16 盎司"},
}

var largeStandardInboundFees = []inboundFee{
	{div(mustDecimal("12"), ouncesPerPound), mustDecimal("0.40"), "不超过 12 盎司"},
	{mustDecimal("1.5"), mustDecimal("0.50"), "12 盎司至 1.5 磅"},
	{mustDecimal("3"), mustDecimal("0.60"), "1.5 至 3 磅"},
	{mustDecimal("5"), mustDecimal("0.76"), "3 至 5 磅"},
	{mustDecimal("7"), mustDecimal("0.98"), "5 至 7 磅"},
	{mustDecimal("10"), mustDecimal("1.20"), "7 至 10 磅"},
	{mustDecimal("15"), mustDecimal("1.50"), "10 至 15 磅"},
	{mustDecimal("20"), mustDecimal("1.90"), "15 至 20 磅"},
}

var smallOversizeInboundFees = []inboundFee{
	{mustDecimal("5"), mustDecimal("1.60"), "小于或等于 5 磅"},
	{mustDecimal("12"), mustDecimal("2.40"), "5 至 12 磅"},
	{mustDecimal("28"), mustDecimal("3.50"), "12 至 28 磅"},
	{mustDecimal("42"), mustDecimal("4.95"), "28 至 42 磅"},
	{mustDecimal("50"), mustDecimal("5.95"), "42 至 50 磅"},
}

var largeOversizeInboundFees = []inboundFee{
	{mustDecimal("5"), mustDecimal("1.80"), "小于或等于 5 磅"},
	{mustDecimal("12"), mustDecimal("2.90"), "5 至 12 磅"},
	{mustDecimal("28"), mustDecimal("4.10"), "12 至 28 磅"},
	{mustDecimal("42"), mustDecimal("5.60"), "28 至 42 磅"},
	{mustDecimal("50"), mustDecimal("6.50"), "42 至 50 磅"},
}

var tierLabels = map[string]string{
	"small_standard":    "小号标准尺寸",
	"large_standard":    "大号标准尺寸",
	"small_oversize":    "小号大件",
	"large_oversize":    "大号大件",
	"oversize_0_50":     "超大件（0 至 50 磅）",
	"oversize_50_70":    "超大件（50 至 70 磅）",
	"oversize_70_150":   "超大件（70 至 150 磅）",
	"oversize_150_plus": "超大件（150 磅以上）",
}

var vatRates = map[string]*big.Rat{
	"DE": mustDecimal("0.19"),
	"UK": mustDecimal("0.20"),
}
