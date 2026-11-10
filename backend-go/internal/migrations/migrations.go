// Package migrations embeds the Goose migration set for the dashboard
// database. The baseline is a frozen schema dump at Alembic revision 285;
// existing databases are stamped as version 1 by the migrate command and
// never execute the baseline SQL.
package migrations

import "embed"

// FS contains the SQL migration files under sql/.
//
//go:embed sql/*.sql
var FS embed.FS

// Dir is the path passed to goose inside FS.
const Dir = "sql"
