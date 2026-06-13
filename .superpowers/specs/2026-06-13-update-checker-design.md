# uniTerm 更新检查设计

## 概述

在 uniTerm 中添加更新检查功能：支持手动检查 GitHub Releases 获取新版本，以及可选的后台自动定期检查。仅做通知提示，不自动下载/安装。

## 功能范围

- **手动检查**：设置 → 关于页面"检查更新"按钮
- **自动检查**：可选的复选框，开启后在启动时 + 每 24 小时检查一次
- **提示横幅**：发现新版本时在界面顶部显示，可关闭
- **通知内容**：新版本号、release notes、GitHub Release 链接
- **更新源**：GitHub Releases API（`/releases/latest`，仅正式 release）
- **不包含**：自动下载、自动安装、增量更新

## 架构

```
┌─────────────────────────────────────────────┐
│  前端 (Vue/TS)                              │
│  ┌──────────────┐  ┌──────────────────────┐ │
│  │ useUpdateCheck │  │ SettingsTab / 关于    │ │
│  │ (composable)   │  │ - 显示版本号          │ │
│  │ - autoCheck   │  │ - 检查更新按钮        │ │
│  │ - timer 24h   │  │ - 自动检查复选框      │ │
│  └──────┬───────┘  └──────────────────────┘ │
│         │ Wails Bind                         │
├─────────┼────────────────────────────────────┤
│  后端 (Go)                                   │
│  ┌──────┴───────┐  ┌──────────────────────┐ │
│  │ app.go       │  │ backend/update/       │ │
│  │ CheckForUpdate│  │ checker.go           │ │
│  │ ()           │  │ - 请求 GitHub API     │ │
│  └──────────────┘  │ - 解析版本            │ │
│                    │ - 比较版本            │ │
│                    └──────────────────────┘ │
└─────────────────────────────────────────────┘
```

## 后端设计

### 新目录：`backend/update/`

#### `checker.go`

核心函数 `Check(currentVersion string) UpdateInfo`：

1. 请求 `GET https://api.github.com/repos/ys-ll/uniterm/releases/latest`
2. 带 `User-Agent: uniTerm` header，超时 10s
3. 解析 JSON，提取 `tag_name`、`html_url`、`body`
4. `tag_name !== current` → 有新版本
5. 返回 `UpdateInfo`

#### 版本比较

- `latest.tag_name !== current` → 有新版本

#### 数据结构

```go
type UpdateInfo struct {
    HasUpdate    bool   `json:"hasUpdate"`
    Current      string `json:"current"`
    Latest       string `json:"latest"`
    ReleaseURL   string `json:"releaseUrl"`
    ReleaseNotes string `json:"releaseNotes"`
}
```

### `app.go` 新增方法

```go
func (a *App) CheckForUpdate() *update.UpdateInfo {
    return update.Check(Version)
}
```

无需改动 `main.go` — `Version` 变量已存在，通过 ldflags 在构建时注入。

## 前端设计

### 新文件

| 文件 | 用途 |
|------|------|
| `frontend/src/composables/useUpdateCheck.ts` | 共享状态 composable |

### `composables/useUpdateCheck.ts`

Vue composable，模块级 `ref` 实现跨组件共享状态，无需 Pinia store：

- `updateInfo` — 检查结果（模块级共享）
- `autoCheck` — 自动检查开关，持久化 localStorage
- `checking` — 是否正在检查
- `dismissedVersion` — 用户已忽略的版本号

方法：
- `checkForUpdate()` — 调 Go 方法，更新 `updateInfo`
- `setAutoCheck(enabled)` — 切换并持久化 + 启停 timer
- `dismissUpdate()` — 忽略当前版本
- `initAutoCheck()` — 若 `autoCheck` 则 5s 后首次检查 + 启动 24h 定时器

### SettingsTab "关于"区域

在设置页面底部新增"关于"区块：

```
─────────────────────────
  关于 uniTerm
  当前版本: v2026.06.13-alpha  [检查更新]
  ☐ 自动检查更新
─────────────────────────
```

- 版本号从 `updateInfo.current` 获取（启动时调用一次 `checkForUpdate()` 拿到 current）
- 点击"检查更新"按钮 → `updateStore.checkForUpdate()`
- 检查中按钮显示 loading，完成后：
  - 有新版本 → 弹出提示 / 触发全局 banner
  - 无更新 → "已是最新版本" 提示
- 复选框绑定 `updateStore.autoCheck`

### 更新提示横幅

在 `AppHeader` 下方或 `App.vue` 主区域顶部显示条件横幅：

```
┌──────────────────────────────────────────────┐
│ 发现新版本 v2026.06.14  [查看详情]  [✕ 忽略] │
└──────────────────────────────────────────────┘
```

- 条件：`updateInfo.hasUpdate === true` 且 `dismissedVersion !== updateInfo.latest`
- "查看详情" → `window.open(updateInfo.releaseUrl, '_blank')`
- "忽略" → `dismissUpdate()`

### 全局 Banner 组件（内联在 App.vue 或独立）

直接在 `App.vue` 内嵌一个 `v-if` 的 banner div，避免过度封装。

## 错误处理

- GitHub API 请求失败（网络错误、rate limit、超时）：`CheckForUpdate()` 返回 `HasUpdate: false`，Go 端 `log.Writef` 记录错误。前端"检查更新"按钮失败时展示一次性 toast 提示。
- Rate limit 应对：未认证的 GitHub API 限速 60 次/小时。24h 间隔 + 手动触发，远在限制内。
- 版本号解析失败：安全降级，返回 `HasUpdate: false`。

## 不涉及

- 自动下载安装包
- 增量更新/热更新
- 更新进度条
- 多 channel（beta/stable）
- GitHub Enterprise / 自定义更新服务器
- macOS Sparkle / Windows MSIX 等原生更新框架集成
