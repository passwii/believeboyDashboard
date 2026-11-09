package product_label

import "context"

type GenerateInput struct {
	Filename    string
	PDFBytes    []byte
	Text        string
	MadeInChina bool
}

type Generator interface {
	Generate(ctx context.Context, input GenerateInput) ([]byte, string, error)
}
