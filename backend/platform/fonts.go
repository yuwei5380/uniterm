package platform

import "sort"

// GetFontFamilies returns sorted unique monospaced font family names.
func GetFontFamilies() ([]string, error) {
	families, err := getSystemFonts()
	if err != nil {
		return nil, err
	}
	return uniqueSorted(families), nil
}

func uniqueSorted(items []string) []string {
	seen := make(map[string]bool, len(items))
	result := make([]string, 0, len(items))
	for _, item := range items {
		if item == "" {
			continue
		}
		if seen[item] {
			continue
		}
		seen[item] = true
		result = append(result, item)
	}
	sort.Strings(result)
	return result
}
