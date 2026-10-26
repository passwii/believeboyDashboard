package httpserver

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
)

type ReverseProxy struct {
	handler *httputil.ReverseProxy
}

func NewReverseProxy(origin string, logger *slog.Logger) (*ReverseProxy, error) {
	target, err := url.Parse(origin)
	if err != nil {
		return nil, err
	}
	if target.Scheme == "" || target.Host == "" {
		return nil, errors.New("must be an absolute HTTP URL")
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil, errors.New("must use http or https")
	}

	logger = loggerOrDefault(logger)
	handler := httputil.NewSingleHostReverseProxy(target)
	handler.FlushInterval = -1
	handler.ErrorHandler = func(w http.ResponseWriter, r *http.Request, proxyErr error) {
		if errors.Is(r.Context().Err(), context.Canceled) {
			return
		}

		logger.ErrorContext(
			r.Context(),
			"reverse proxy request failed",
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.String("request_id", RequestIDFromContext(r.Context())),
			slog.Any("error", proxyErr),
		)
		http.Error(w, "bad gateway", http.StatusBadGateway)
	}

	return &ReverseProxy{handler: handler}, nil
}

func (p *ReverseProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.handler.ServeHTTP(w, r)
}
