# uniTerm 更新检查 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 添加 GitHub Releases 更新检查功能：手动检查 + 自动定期检查，在设置关于页和全局 banner 提示。

**Architecture:** Go 后端 `backend/update/checker.go` 负责请求 GitHub Releases API 进行版本比较；前端通过简单 composable `useUpdateCheck.ts` 共享状态和管理定时器，无需 Pinia store。Go 方法通过 Wails Bind 自动暴露。

**Tech Stack:** Go (net/http), TypeScript/Vue 3 (composable, reactive), Wails v2 Bind

---

### Task 1: Go 后端 — 创建 `backend/update/checker.go`

**Files:**
- Create: `backend/update/checker.go`

- [ ] **Step 1: Write `checker.go`**

```go
package update

import (
	"encoding/json"
	"net/http"
	"time"
)

// UpdateInfo is the result returned to the frontend.
type UpdateInfo struct {
	HasUpdate    bool   `json:"hasUpdate"`
	Current      string `json:"current"`
	Latest       string `json:"latest"`
	ReleaseURL   string `json:"releaseUrl"`
	ReleaseNotes string `json:"releaseNotes"`
}

type githubRelease struct {
	TagName string `json:"tag_name"`
	HTMLURL string `json:"html_url"`
	Body    string `json:"body"`
}

// Check compares the current version against the latest GitHub release.
func Check(currentVersion string) *UpdateInfo {
	info := &UpdateInfo{
		Current:   currentVersion,
		HasUpdate: false,
	}

	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequest(
		"GET",
		"https://api.github.com/repos/ys-ll/uniterm/releases/latest",
		nil,
	)
	if err != nil {
		return info
	}
	req.Header.Set("User-Agent", "uniTerm")

	resp, err := client.Do(req)
	if err != nil {
		return info
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return info
	}

	var release githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return info
	}

	info.Latest = release.TagName
	info.ReleaseURL = release.HTMLURL
	info.ReleaseNotes = release.Body

	if release.TagName != currentVersion {
		info.HasUpdate = true
	}

	return info
}
```

- [ ] **Step 2: Verify Go compiles**

```bash
cd backend/update && go build ./...
```

Expected: no errors.

---

### Task 2: Go — 在 `app.go` 添加 `CheckForUpdate()` 方法

**Files:**
- Modify: `app.go`

- [ ] **Step 1: Add import and method to `app.go`**

At the top of `app.go`, add the import (alphabetical among existing imports):

```go
"github.com/ys-ll/uniterm/backend/update"
```

Add this method near `GetAppInfo()` (around line 757):

```go
func (a *App) CheckForUpdate() *update.UpdateInfo {
	return update.Check(Version)
}
```

- [ ] **Step 2: Verify Go compiles**

```bash
go build ./...
```

Expected: no errors.

---

### Task 3: 前端 — 创建 `types/update.ts`

**Files:**
- Create: `frontend/src/types/update.ts`

- [ ] **Step 1: Write types file**

```typescript
export interface UpdateInfo {
  hasUpdate: boolean
  current: string
  latest: string
  releaseUrl: string
  releaseNotes: string
}
```

---

### Task 4: 前端 — 创建 `composables/useUpdateCheck.ts`

**Files:**
- Create: `frontend/src/composables/useUpdateCheck.ts`

- [ ] **Step 1: Write composable**

```typescript
import { ref } from 'vue'
import { CheckForUpdate } from '../../wailsjs/go/main/App'
import type { UpdateInfo } from '../types/update'

const AUTO_CHECK_KEY = 'update.autoCheck'
const DISMISSED_KEY = 'update.dismissedVersion'

// Shared reactive state (singleton across components)
const updateInfo = ref<UpdateInfo | null>(null)
const checking = ref(false)
const dismissedVersion = ref(localStorage.getItem(DISMISSED_KEY) || '')
const autoCheck = ref(localStorage.getItem(AUTO_CHECK_KEY) === 'true')

let timer: ReturnType<typeof setInterval> | null = null

function startTimer() {
  stopTimer()
  timer = setInterval(() => {
    checkForUpdate()
  }, 24 * 60 * 60 * 1000)
}

function stopTimer() {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

async function checkForUpdate(): Promise<UpdateInfo | null> {
  checking.value = true
  try {
    const info = await CheckForUpdate()
    updateInfo.value = info
    return info
  } catch (e) {
    console.error('Update check failed:', e)
    return null
  } finally {
    checking.value = false
  }
}

function setAutoCheck(enabled: boolean) {
  autoCheck.value = enabled
  localStorage.setItem(AUTO_CHECK_KEY, String(enabled))
  if (enabled) {
    startTimer()
  } else {
    stopTimer()
  }
}

function dismissUpdate() {
  if (updateInfo.value) {
    dismissedVersion.value = updateInfo.value.latest
    localStorage.setItem(DISMISSED_KEY, updateInfo.value.latest)
  }
}

function initAutoCheck() {
  if (autoCheck.value) {
    setTimeout(() => checkForUpdate(), 5000)
    startTimer()
  }
}

export function useUpdateCheck() {
  return {
    updateInfo,
    checking,
    dismissedVersion,
    autoCheck,
    checkForUpdate,
    setAutoCheck,
    dismissUpdate,
    initAutoCheck,
  }
}
```

---

### Task 5: i18n — 添加翻译 key

**Files:**
- Modify: `frontend/src/i18n/locales/zh-CN.json`
- Modify: `frontend/src/i18n/locales/en.json`
- Modify: `frontend/src/i18n/locales/zh-TW.json`
- Modify: `frontend/src/i18n/locales/ja.json`
- Modify: `frontend/src/i18n/locales/ko.json`
- Modify: `frontend/src/i18n/locales/de.json`
- Modify: `frontend/src/i18n/locales/es.json`
- Modify: `frontend/src/i18n/locales/fr.json`
- Modify: `frontend/src/i18n/locales/ru.json`

- [ ] **Step 1: Add keys to `zh-CN.json`**

Add after `"settings.version"`:

```json
"settings.checkUpdate": "检查更新",
"settings.checking": "正在检查...",
"settings.upToDate": "已是最新版本",
"settings.foundNewVersion": "发现新版本",
"settings.autoCheckUpdate": "自动检查更新",
"settings.openRelease": "查看详情",
"settings.dismiss": "忽略",
"settings.checkUpdateFailed": "检查更新失败",
```

- [ ] **Step 2: Add keys to `en.json`**

```json
"settings.checkUpdate": "Check for Updates",
"settings.checking": "Checking...",
"settings.upToDate": "You're up to date",
"settings.foundNewVersion": "New version available",
"settings.autoCheckUpdate": "Automatically check for updates",
"settings.openRelease": "View details",
"settings.dismiss": "Dismiss",
"settings.checkUpdateFailed": "Update check failed",
```

- [ ] **Step 3: Add keys to `zh-TW.json`**

```json
"settings.checkUpdate": "檢查更新",
"settings.checking": "正在檢查...",
"settings.upToDate": "已是最新版本",
"settings.foundNewVersion": "發現新版本",
"settings.autoCheckUpdate": "自動檢查更新",
"settings.openRelease": "檢視詳情",
"settings.dismiss": "忽略",
"settings.checkUpdateFailed": "檢查更新失敗",
```

- [ ] **Step 4: Add keys to `ja.json`**

```json
"settings.checkUpdate": "更新を確認",
"settings.checking": "確認中...",
"settings.upToDate": "最新バージョンです",
"settings.foundNewVersion": "新しいバージョンがあります",
"settings.autoCheckUpdate": "更新を自動確認",
"settings.openRelease": "詳細を見る",
"settings.dismiss": "無視",
"settings.checkUpdateFailed": "更新確認に失敗しました",
```

- [ ] **Step 5: Add keys to `ko.json`**

```json
"settings.checkUpdate": "업데이트 확인",
"settings.checking": "확인 중...",
"settings.upToDate": "최신 버전입니다",
"settings.foundNewVersion": "새 버전이 있습니다",
"settings.autoCheckUpdate": "자동 업데이트 확인",
"settings.openRelease": "자세히 보기",
"settings.dismiss": "무시",
"settings.checkUpdateFailed": "업데이트 확인 실패",
```

- [ ] **Step 6: Add keys to `de.json`**

```json
"settings.checkUpdate": "Nach Updates suchen",
"settings.checking": "Suche...",
"settings.upToDate": "Neueste Version installiert",
"settings.foundNewVersion": "Neue Version verfügbar",
"settings.autoCheckUpdate": "Automatisch nach Updates suchen",
"settings.openRelease": "Details anzeigen",
"settings.dismiss": "Ignorieren",
"settings.checkUpdateFailed": "Update-Prüfung fehlgeschlagen",
```

- [ ] **Step 7: Add keys to `es.json`**

```json
"settings.checkUpdate": "Buscar actualizaciones",
"settings.checking": "Buscando...",
"settings.upToDate": "Está usando la versión más reciente",
"settings.foundNewVersion": "Nueva versión disponible",
"settings.autoCheckUpdate": "Buscar actualizaciones automáticamente",
"settings.openRelease": "Ver detalles",
"settings.dismiss": "Ignorar",
"settings.checkUpdateFailed": "Error al buscar actualizaciones",
```

- [ ] **Step 8: Add keys to `fr.json`**

```json
"settings.checkUpdate": "Rechercher des mises à jour",
"settings.checking": "Recherche...",
"settings.upToDate": "Vous utilisez la dernière version",
"settings.foundNewVersion": "Nouvelle version disponible",
"settings.autoCheckUpdate": "Rechercher automatiquement les mises à jour",
"settings.openRelease": "Voir les détails",
"settings.dismiss": "Ignorer",
"settings.checkUpdateFailed": "Échec de la recherche de mises à jour",
```

- [ ] **Step 9: Add keys to `ru.json`**

```json
"settings.checkUpdate": "Проверить обновления",
"settings.checking": "Проверка...",
"settings.upToDate": "У вас последняя версия",
"settings.foundNewVersion": "Доступна новая версия",
"settings.autoCheckUpdate": "Автоматически проверять обновления",
"settings.openRelease": "Подробнее",
"settings.dismiss": "Скрыть",
"settings.checkUpdateFailed": "Не удалось проверить обновления",
```

---

### Task 6: 前端 — 更新 `SettingsTab.vue` 关于区域

**Files:**
- Modify: `frontend/src/components/SettingsTab.vue`

- [ ] **Step 1: Replace the about section**

Replace the `v-if="settingsStore.activeCategory === 'about'"` block (third section in `.settings-panel`).

Replace the existing "关于" block:

```html
<!-- 关于 -->
<div v-if="settingsStore.activeCategory === 'about'" class="settings-section">
  <h2 class="section-title">{{ t('settings.about') }}</h2>
  <div class="about-content">
    <div class="about-appname">uniTerm</div>
    <p class="about-desc">{{ t('settings.aboutDesc') }}</p>
    <div class="about-version">{{ t('settings.version') }}: {{ appVersion }}</div>
  </div>
</div>
```

With:

```html
<!-- 关于 -->
<div v-if="settingsStore.activeCategory === 'about'" class="settings-section">
  <h2 class="section-title">{{ t('settings.about') }}</h2>
  <div class="about-content">
    <div class="about-appname">uniTerm</div>
    <p class="about-desc">{{ t('settings.aboutDesc') }}</p>
    <div class="about-version">
      {{ t('settings.version') }}: {{ updateCheck.updateInfo?.current || '...' }}
    </div>
    <div class="about-update-actions">
      <el-button
        size="small"
        :loading="updateCheck.checking"
        @click="handleCheckUpdate"
      >
        {{ updateCheck.checking ? t('settings.checking') : t('settings.checkUpdate') }}
      </el-button>
    </div>
    <div class="about-auto-check">
      <el-checkbox
        :model-value="updateCheck.autoCheck"
        @change="updateCheck.setAutoCheck"
      >
        {{ t('settings.autoCheckUpdate') }}
      </el-checkbox>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Remove old version variable and add import + handler**

Remove the existing `appVersion` declaration:
```typescript
const appVersion = import.meta.env.VITE_VERSION || 'dev'
```

Add import near other composable imports:
```typescript
import { useUpdateCheck } from '../composables/useUpdateCheck'
```

Add composable initialization (near other store/composable declarations, after `const syncStore = useSyncStore()`):
```typescript
const updateCheck = useUpdateCheck()
```

Add handler function (near `handleSyncNow`):
```typescript
async function handleCheckUpdate() {
  const info = await updateCheck.checkForUpdate()
  if (!info) {
    ElMessage.error(t('settings.checkUpdateFailed'))
  } else if (info.hasUpdate) {
    ElMessage.success(t('settings.foundNewVersion') + ': ' + info.latest)
  } else {
    ElMessage.success(t('settings.upToDate'))
  }
}
```

- [ ] **Step 3: Add styles for new about elements**

Add before the closing `</style>` tag:

```css
.about-update-actions {
  margin-top: 20px;
}
.about-auto-check {
  margin-top: 12px;
  font-size: 13px;
  font-family: var(--font-ui);
}
```

---

### Task 7: 前端 — 在 `App.vue` 添加全局更新横幅

**Files:**
- Modify: `frontend/src/App.vue`

- [ ] **Step 1: Add banner HTML**

Add between `<AppHeader />` and `<div class="main-content">` (below the AppHeader block, above the main-content div):

```html
<!-- Update banner -->
<div
  v-if="showUpdateBanner && updateCheck.updateInfo"
  class="update-banner"
>
  <span class="update-banner-text">
    {{ t('settings.foundNewVersion') }}: {{ updateCheck.updateInfo.latest }}
  </span>
  <span class="update-banner-actions">
    <a class="update-banner-link" @click.prevent="openReleaseUrl">{{ t('settings.openRelease') }}</a>
    <a class="update-banner-link" @click.prevent="dismissBanner">{{ t('settings.dismiss') }}</a>
  </span>
</div>
```

- [ ] **Step 2: Add imports**

Add import:
```typescript
import { useUpdateCheck } from './composables/useUpdateCheck'
```

Add composable initialization (near other store declarations):
```typescript
const updateCheck = useUpdateCheck()
```

- [ ] **Step 3: Add computed and methods**

Add after the `rdpOverlayCount` block:

```typescript
const showUpdateBanner = computed(() => {
  const info = updateCheck.updateInfo
  return info?.hasUpdate && updateCheck.dismissedVersion !== info.latest
})

function openReleaseUrl() {
  if (updateCheck.updateInfo?.releaseUrl) {
    window.open(updateCheck.updateInfo.releaseUrl, '_blank')
  }
}

function dismissBanner() {
  updateCheck.dismissUpdate()
}
```

- [ ] **Step 4: Call `initAutoCheck()` in `onMounted`**

Add after `settingsStore.init()`:
```typescript
updateCheck.initAutoCheck()
```

- [ ] **Step 5: Add banner styles**

Add before the closing `</style>` tag:

```css
.update-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 8px 16px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-family: var(--font-ui);
  flex-shrink: 0;
}
.update-banner-text {
  display: flex;
  align-items: center;
  gap: 8px;
}
.update-banner-actions {
  display: flex;
  gap: 12px;
}
.update-banner-link {
  color: #fff;
  text-decoration: underline;
  cursor: pointer;
  opacity: 0.9;
}
.update-banner-link:hover {
  opacity: 1;
}
```

---

### Task 8: 构建验证

- [ ] **Step 1: Build frontend**

```bash
cd frontend && npm run build
```

Expected: no errors.

- [ ] **Step 2: Build Go backend**

```bash
go build ./...
```

Expected: no errors.

---

### Task 9: 运行验证

- [ ] **Step 1: Launch app**

```bash
wails dev
```

- [ ] **Step 2: Manual check**

1. 打开 Settings → 关于（About）页面
2. 确认显示当前版本号
3. 点击"检查更新"按钮
4. 确认正确提示"已是最新版本"或"发现新版本"
5. 如发现新版本，确认 AppHeader 下方显示蓝色横幅
6. 点击横幅"查看详情"确认打开 GitHub Releases 页面
7. 点击横幅"忽略"确认横幅消失

- [ ] **Step 3: Auto check**

1. 勾选"自动检查更新"复选框
2. 关闭应用重新启动
3. 等待 5 秒，确认自动执行了一次检查
