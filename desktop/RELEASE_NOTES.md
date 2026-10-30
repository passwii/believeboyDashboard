# BelieveBoy Desktop 0.2.0

Release date: 2026-10-30

## Added

- Native Gateway settings with URL validation, trailing-slash normalization,
  public liveness checks, saved/runtime Gateway labels, and a restart notice.
- Keychain credentials are bound to the Gateway origin; changing origin
  clears the old credentials before any authenticated request.
- LastRoute restoration for authenticated launches and debounced persistence
  for Home, Projects, Operations, Reports, AI, and Settings navigation.
- Native error and connection states for invalid addresses, network failures,
  and HTTP errors.
- macOS build, ad-hoc DMG, Developer ID signing, notarization, and artifact
  verification instructions in `README.md`.

## Behavior

- Gateway values must use `http://` or `https://`.
- Connection tests use the unauthenticated `/api/v1/health/live` endpoint.
- An invalid or unknown `LastRoute` falls back to Home when authenticated and
  to Login when no saved session exists.
- Saved Gateway changes apply after the app restarts; the current client stays
  on the Gateway used at launch.
- Route persistence failures are logged and never block navigation.

## Validation

- `go test ./... -count=1`
- `go test -race ./... -count=1`
- `CGO_ENABLED=0 go test ./... -count=1`
- `go vet ./...`
- `go tool mygo vet`
- `go tool mygo build -skip-dmg`

The desktop remains a native MyGo window without WebView or Next.js content.
