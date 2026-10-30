# BelieveBoy Desktop

BelieveBoy Desktop is the native macOS workbench built with Go and MyGo `ui`.
It does not embed a WebView, Next.js pages, or Bun output at runtime.

## Gateway configuration

The app stores non-secret settings in:

```text
~/Library/Application Support/BelieveBoy/config.json
```

Open **系统设置** in the app to edit `api_base_url`. The field accepts only
`http://` and `https://`, removes trailing slashes, and can run a public
`GET /api/v1/health/live` check without sending the current account credentials.
Saving changes the local config only; the status panel asks the user to
restart before the new Gateway is used by login and data requests.
The same form is reachable from the login screen and with `Cmd+,`, so an
unreachable Gateway can be corrected before signing in.

Saved Keychain credentials are bound to the normalized Gateway origin
(scheme, host, and non-default port). If the configured origin changes, the
old credentials are cleared before any authenticated request and the user must
sign in again.

The last valid workspace route is stored as `last_route`. It is restored only
when the saved Keychain session is present and the route is one of the native
workspace pages. Invalid routes, missing sessions, and the `/login` route fall
back to login or home. Route writes are debounced and never block navigation.

## Local build

Requirements: Go 1.27.3, macOS 13 or later, and Xcode Command Line Tools.

```sh
cd desktop
go tool mygo doctor
go test ./... -count=1
go test -race ./... -count=1
CGO_ENABLED=0 go test ./... -count=1
go vet ./...
go tool mygo vet

# Native .app without a disk image.
go tool mygo build -skip-dmg

# Ad-hoc signed local DMG. It runs on the build machine but Gatekeeper blocks
# it on other Macs.
go tool mygo build -sign -
```

The version in `mygo.json` is `0.2.0`. Bump it for every distributable build
and update `RELEASE_NOTES.md`.

## Signed and notarized distribution

External distribution needs an Apple Developer ID Application certificate.
The identity and notary profile are release-machine credentials and must not
be committed.

1. Store notary credentials once:

   ```sh
   xcrun notarytool store-credentials believeboy-notary
   ```

   Enter the requested Apple credentials when prompted.

2. For the release build, add the following fields to `macos` in `mygo.json`
   on the release machine:

   ```json
   "signingIdentity": "Developer ID Application: Your Name (TEAMID)",
   "notarize": {
     "keychainProfile": "believeboy-notary"
   }
   ```

3. Build the universal app and DMG:

   ```sh
   go tool mygo build -platform darwin/universal
   ```

   MyGo signs the app and DMG, submits the DMG with `notarytool --wait`, and
   staples the ticket.

4. Verify the release artifacts:

   ```sh
   codesign --verify --deep --strict --verbose=2 \
     "build/darwin-universal/BelieveBoy.app"
   spctl --assess --type execute --verbose=4 \
     "build/darwin-universal/BelieveBoy.app"
   xcrun stapler validate \
     "build/darwin-universal/BelieveBoy 0.2.0.dmg"
   hdiutil verify "build/darwin-universal/BelieveBoy 0.2.0.dmg"
   ```

If the release-machine fields are not present, keep local builds ad hoc with
`-sign -`; do not distribute that DMG outside the build machine.

## Verification scope

Automated tests cover URL validation, Gateway settings states, initial route
restoration, debounced route persistence, API health probing, and native
source guards. Visual review of the running macOS window remains a separate
Stage 3 acceptance step.
