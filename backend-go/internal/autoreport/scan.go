package autoreport

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// File is one watched report file resolved to its project.
type File struct {
	Path        string
	ProjectName string
	Country     string
}

// ErrNotEligible marks paths outside the watched project folders.
var ErrNotEligible = errors.New("path is not inside a watched project folder")

// Eligible resolves the project and country for a file path.
//
// Layout mirrors the Python service:
//
//	<root>/<project>/report.xlsx      -> project, default country
//	<root>/<project>/美国/report.xlsx  -> project, US
func (c Config) Eligible(path string) (File, error) {
	clean := filepath.Clean(path)
	projectDir, country := c.projectDirForFile(clean)
	projectName := filepath.Base(projectDir)
	if !c.ProjectByName(projectName) {
		return File{}, ErrNotEligible
	}
	return File{Path: clean, ProjectName: projectName, Country: country}, nil
}

// projectDirForFile walks up one level when the file sits in a country subfolder.
func (c Config) projectDirForFile(path string) (string, string) {
	dir := filepath.Dir(path)
	if country, ok := CountrySubfolders[filepath.Base(dir)]; ok {
		return filepath.Dir(dir), country
	}
	return dir, c.Country
}

// Collect returns every supported, not-yet-archived file under the watched projects.
func (c Config) Collect() ([]File, []error) {
	files := make([]File, 0, 128)
	var errs []error
	for _, project := range c.Projects {
		projectDir := filepath.Join(c.WatchRoot, project)
		info, err := os.Stat(projectDir)
		if err != nil || !info.IsDir() {
			if err != nil && !errors.Is(err, fs.ErrNotExist) {
				errs = append(errs, err)
			}
			continue
		}
		roots := []string{projectDir}
		for sub := range CountrySubfolders {
			countryDir := filepath.Join(projectDir, sub)
			if info, err := os.Stat(countryDir); err == nil && info.IsDir() {
				roots = append(roots, countryDir)
			}
		}
		for _, root := range roots {
			entries, err := os.ReadDir(root)
			if err != nil {
				errs = append(errs, err)
				continue
			}
			for _, entry := range entries {
				if entry.IsDir() {
					continue
				}
				if !c.SupportedExtension(filepath.Ext(entry.Name())) {
					continue
				}
				path := filepath.Join(root, entry.Name())
				country := c.Country
				if mapped, ok := CountrySubfolders[filepath.Base(root)]; ok {
					country = mapped
				}
				files = append(files, File{Path: path, ProjectName: project, Country: country})
			}
		}
	}
	return files, errs
}

// IsArchiveDir reports whether a directory name is an archive subfolder.
func (c Config) IsArchiveDir(name string) bool {
	return name == c.ProcessedSubdir || name == c.AdProcessedSubdir || c.IgnoredDirs[name]
}

// NormalizeProjectName trims surrounding whitespace.
func NormalizeProjectName(name string) string { return strings.TrimSpace(name) }
