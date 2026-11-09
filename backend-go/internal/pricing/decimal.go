package pricing

import (
	"fmt"
	"math"
	"math/big"
	"strconv"
)

func decimal(value float64) (*big.Rat, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return nil, fmt.Errorf("value must be finite")
	}
	text := strconv.FormatFloat(value, 'f', -1, 64)
	rat, ok := new(big.Rat).SetString(text)
	if !ok {
		return nil, fmt.Errorf("invalid decimal %q", text)
	}
	return rat, nil
}

func mustDecimal(value string) *big.Rat {
	rat, ok := new(big.Rat).SetString(value)
	if !ok {
		panic("invalid pricing decimal constant: " + value)
	}
	return rat
}

func add(a, b *big.Rat) *big.Rat {
	return new(big.Rat).Add(a, b)
}

func sub(a, b *big.Rat) *big.Rat {
	return new(big.Rat).Sub(a, b)
}

func mul(a, b *big.Rat) *big.Rat {
	return new(big.Rat).Mul(a, b)
}

func div(a, b *big.Rat) *big.Rat {
	return new(big.Rat).Quo(a, b)
}

func maxRat(a, b *big.Rat) *big.Rat {
	if a.Cmp(b) >= 0 {
		return new(big.Rat).Set(a)
	}
	return new(big.Rat).Set(b)
}

func quantize(value *big.Rat, places int) *big.Rat {
	scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(places)), nil)
	scaledNumerator := new(big.Int).Mul(value.Num(), scale)
	quotient := new(big.Int)
	remainder := new(big.Int)
	quotient.QuoRem(scaledNumerator, value.Denom(), remainder)
	absRemainder := new(big.Int).Abs(remainder)
	if new(big.Int).Lsh(absRemainder, 1).Cmp(value.Denom()) >= 0 {
		if scaledNumerator.Sign() < 0 {
			quotient.Sub(quotient, big.NewInt(1))
		} else {
			quotient.Add(quotient, big.NewInt(1))
		}
	}
	return new(big.Rat).SetFrac(quotient, scale)
}

func ceilPositive(value *big.Rat) int64 {
	if value.Sign() <= 0 {
		return 0
	}
	quotient := new(big.Int)
	remainder := new(big.Int)
	quotient.QuoRem(value.Num(), value.Denom(), remainder)
	if remainder.Sign() > 0 {
		quotient.Add(quotient, big.NewInt(1))
	}
	return quotient.Int64()
}

func float64Value(value *big.Rat) float64 {
	result, _ := value.Float64()
	return result
}

func quantizedFloat(value *big.Rat, places int) float64 {
	return float64Value(quantize(value, places))
}
