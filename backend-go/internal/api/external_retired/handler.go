package external_retired

import (
	"net/http"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const externalPrefix = "/api/v1/external"

// Handler serves the retired external namespace with an explicit migration signal.
type Handler struct{}

func NewHandler() *Handler {
	return &Handler{}
}

// Gone maps every legacy /api/v1/external/* request to its /api/v1/agent/* successor.
func (*Handler) Gone(w http.ResponseWriter, r *http.Request) {
	suffix := strings.TrimPrefix(r.URL.Path, externalPrefix)
	successor := "/api/v1/agent" + suffix
	w.Header().Set("Link", `<`+successor+`>; rel="successor-version"`)
	w.Header().Set("Deprecation", "true")
	_ = httpapi.WriteJSON(w, http.StatusGone, map[string]string{
		"detail":    "该接口已下线，请迁移到 /api/v1/agent/*（路径后缀不变）",
		"successor": successor,
	})
}
