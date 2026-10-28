package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"testing"
)

func TestBodyReadErrorsPreserveClassification(t *testing.T) {
	tests := []struct {
		name       string
		readErr    error
		wantIs     []error
		wantNotIs  []error
		withOutput bool
	}{
		{
			name:       "canceled decoded body",
			readErr:    context.Canceled,
			wantIs:     []error{context.Canceled},
			wantNotIs:  []error{ErrNetwork},
			withOutput: true,
		},
		{
			name:       "deadline drained body",
			readErr:    context.DeadlineExceeded,
			wantIs:     []error{context.DeadlineExceeded},
			wantNotIs:  []error{ErrNetwork},
			withOutput: false,
		},
		{
			name:       "transport failure decoded body",
			readErr:    errors.New("connection reset while reading"),
			wantIs:     []error{ErrNetwork},
			withOutput: true,
		},
		{
			name:       "transport failure drained body",
			readErr:    errors.New("unexpected EOF"),
			wantIs:     []error{ErrNetwork},
			withOutput: false,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			sessions := newTestSessionStore()
			saveTestSession(t, sessions)
			client := newTestClient(t, stubHTTPClient{fn: func(*http.Request) (*http.Response, error) {
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body: &failingReadCloser{
						reader: &dataThenErrorReader{
							data: []byte(`{"count":`),
							err:  test.readErr,
						},
					},
				}, nil
			}}, sessions)

			var output *UnreadCountResponse
			var response UnreadCountResponse
			if test.withOutput {
				output = &response
			}
			err := client.Get(context.Background(), "/api/v1/notifications/unread-count", output)
			for _, target := range test.wantIs {
				if !errors.Is(err, target) {
					t.Errorf("error = %v, want errors.Is(%v)", err, target)
				}
			}
			for _, target := range test.wantNotIs {
				if errors.Is(err, target) {
					t.Errorf("error = %v, did not want errors.Is(%v)", err, target)
				}
			}
		})
	}
}

type dataThenErrorReader struct {
	data []byte
	err  error
}

func (r *dataThenErrorReader) Read(p []byte) (int, error) {
	if len(r.data) > 0 {
		n := copy(p, r.data)
		r.data = r.data[n:]
		return n, nil
	}
	return 0, r.err
}

type failingReadCloser struct {
	reader io.Reader
}

func (r *failingReadCloser) Read(p []byte) (int, error) {
	return r.reader.Read(p)
}

func (r *failingReadCloser) Close() error {
	return nil
}
