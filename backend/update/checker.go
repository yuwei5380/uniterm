package update

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/ys-ll/uniterm/backend/log"
)

// UpdateInfo is the result returned to the frontend.
type UpdateInfo struct {
	HasUpdate  bool   `json:"hasUpdate"`
	Current    string `json:"current"`
	Latest     string `json:"latest"`
	ReleaseURL string `json:"releaseUrl"`
}

type githubRelease struct {
	TagName string `json:"tag_name"`
	HTMLURL string `json:"html_url"`
	Body    string `json:"body"`
}

type cacheEntry struct {
	Result    UpdateInfo `json:"result"`
	Timestamp time.Time  `json:"timestamp"`
}

const cacheTTL = 5 * time.Minute

func cachePath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "uniTerm", "update_cache.json")
}

func loadCache() *cacheEntry {
	path := cachePath()
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var entry cacheEntry
	if err := json.Unmarshal(data, &entry); err != nil {
		return nil
	}
	if time.Since(entry.Timestamp) > cacheTTL {
		return nil
	}
	return &entry
}

func saveCache(entry *cacheEntry) {
	path := cachePath()
	if path == "" {
		return
	}
	os.MkdirAll(filepath.Dir(path), 0755)
	data, _ := json.Marshal(entry)
	_ = os.WriteFile(path, data, 0600)
}

// Check compares the current version against the latest GitHub release.
func Check(currentVersion string) (*UpdateInfo, error) {
	if cached := loadCache(); cached != nil {
		result := cached.Result
		result.Current = currentVersion
		result.HasUpdate = result.Latest != currentVersion
		log.Writef("[update] returning disk-cached result, age=%s", time.Since(cached.Timestamp))
		return &result, nil
	}

	log.Writef("[update] Check called, current=%s", currentVersion)

	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequest(
		"GET",
		"https://api.github.com/repos/ys-ll/uniterm/releases/latest",
		nil,
	)
	if err != nil {
		log.Writef("[update] create request error: %v", err)
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("User-Agent", "uniTerm")

	resp, err := client.Do(req)
	if err != nil {
		log.Writef("[update] api request error: %v", err)
		return nil, fmt.Errorf("api request: %w", err)
	}
	defer resp.Body.Close()

	log.Writef("[update] GitHub API response status: %d", resp.StatusCode)

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	var release githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		log.Writef("[update] decode error: %v", err)
		return nil, fmt.Errorf("decode response: %w", err)
	}

	log.Writef("[update] latest=%s", release.TagName)

	result := UpdateInfo{
		Current:    currentVersion,
		Latest:     release.TagName,
		ReleaseURL: release.HTMLURL,
		HasUpdate:  release.TagName != currentVersion,
	}

	saveCache(&cacheEntry{Result: result, Timestamp: time.Now()})

	return &result, nil
}
