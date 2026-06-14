# SSH 隧道功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在连接配置中新增 SSH 隧道选项，选择已有 SSH 连接作为跳板，通过本地端口转发（-L）访问目标。

**Architecture:** 新增 TunnelService 集中管理隧道生命周期。CreateSession 时若配置了隧道，先建立 SSH 连接并开启本地端口转发，再将 config.Host/Port 替换为 127.0.0.1:本地端口，后续各 session 类型无需改动。

**Tech Stack:** Go (golang.org/x/crypto/ssh), Vue 3 + TypeScript + Element Plus, Wails v2

---

### Task 1: Go — ConnectionConfig 加 TunnelSSHConnID

**Files:**
- Modify: `backend/session/session.go:19-42`

- [ ] **Step 1: 添加字段**

在 `ConnectionConfig` 结构体中，`PostLoginScript` 字段后添加：

```go
type ConnectionConfig struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Type     string  `json:"type"`
	Host     string  `json:"host"`
	Port     int     `json:"port"`
	User     string  `json:"user"`
	AuthType string  `json:"authType"`
	// Password is stored in plaintext JSON. Will be migrated to OS keychain in a future iteration.
	Password string  `json:"password,omitempty"`
	KeyPath  string  `json:"keyPath,omitempty"`
	GroupId  *string `json:"groupId,omitempty"`
	// RDP-specific fields
	RdpFixedWidth  int  `json:"rdpFixedWidth,omitempty"`
	RdpFixedHeight int  `json:"rdpFixedHeight,omitempty"`
	RdpSmartSizing bool `json:"rdpSmartSizing"`
	// Local terminal shell path
	ShellPath string `json:"shellPath,omitempty"`
	// Database-specific fields
	DBType string `json:"dbType,omitempty"` // "mysql", "postgres", "rqlite"
	DBName string `json:"dbName,omitempty"` // default database name
	// SSH post-login script: commands to execute after successful login
	PostLoginScript string `json:"postLoginScript,omitempty"`
	// SSH tunnel: reference to an existing SSH connection used as a jump host.
	// When set, the connection goes through local port forwarding:
	//   127.0.0.1:auto-port → tunnel SSH → target Host:Port
	TunnelSSHConnID string `json:"tunnelSSHConnId,omitempty"`
}
```

- [ ] **Step 2: 验证编译**

```bash
cd backend && go build ./session/
```

Expected: 编译通过，无错误。

- [ ] **Step 3: 提交**

```bash
git add backend/session/session.go && echo "Ready to commit"
```

---

### Task 2: Go — 创建 TunnelService

**Files:**
- Create: `backend/session/tunnel_service.go`

- [ ] **Step 1: 创建 tunnel_service.go**

```go
package session

import (
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// tunnelEntry holds the SSH client and listener for a single tunnel.
type tunnelEntry struct {
	sshClient *ssh.Client
	listener  net.Listener
}

// TunnelService manages SSH tunnel lifecycles.
// Each session that uses a tunnel gets its own SSH connection
// and local listener. The key is the parent session ID.
type TunnelService struct {
	mu       sync.Mutex
	tunnels  map[string]*tunnelEntry
}

func NewTunnelService() *TunnelService {
	return &TunnelService{
		tunnels: make(map[string]*tunnelEntry),
	}
}

// Start establishes an SSH connection using the given config, opens a local
// TCP listener on an auto-assigned port, and forwards every accepted connection
// to targetHost:targetPort through the SSH tunnel.
// Returns the local port number that was assigned.
func (ts *TunnelService) Start(sessionID string, sshConfig ConnectionConfig, targetHost string, targetPort int) (int, error) {
	ts.mu.Lock()
	defer ts.mu.Unlock()

	if _, exists := ts.tunnels[sessionID]; exists {
		return 0, fmt.Errorf("tunnel already exists for session %s", sessionID)
	}

	// 1. Establish SSH connection
	authMethods := makeSSHAuthMethods(sshConfig)
	addr := fmt.Sprintf("%s:%d", sshConfig.Host, sshConfig.Port)
	clientConfig := &ssh.ClientConfig{
		User:            sshConfig.User,
		Auth:            authMethods,
		Timeout:         30 * time.Second,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	}

	conn, err := net.DialTimeout("tcp", addr, clientConfig.Timeout)
	if err != nil {
		return 0, fmt.Errorf("tunnel ssh dial: %w", err)
	}

	sshConn, chans, reqs, err := ssh.NewClientConn(conn, addr, clientConfig)
	if err != nil {
		conn.Close()
		return 0, fmt.Errorf("tunnel ssh handshake: %w", err)
	}
	client := ssh.NewClient(sshConn, chans, reqs)

	// 2. Listen on random local port
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		client.Close()
		return 0, fmt.Errorf("tunnel listen: %w", err)
	}

	localPort := listener.Addr().(*net.TCPAddr).Port
	target := fmt.Sprintf("%s:%d", targetHost, targetPort)

	// 3. Accept loop — forward each connection through SSH
	go func() {
		for {
			localConn, err := listener.Accept()
			if err != nil {
				// Listener closed; tunnel is shutting down
				return
			}
			go func() {
				remoteConn, err := client.Dial("tcp", target)
				if err != nil {
					localConn.Close()
					return
				}
				// Bidirectional copy
				go func() {
					io.Copy(remoteConn, localConn)
					remoteConn.Close()
				}()
				go func() {
					io.Copy(localConn, remoteConn)
					localConn.Close()
				}()
			}()
		}
	}()

	ts.tunnels[sessionID] = &tunnelEntry{
		sshClient: client,
		listener:  listener,
	}

	return localPort, nil
}

// Stop closes the tunnel and SSH connection for the given session.
func (ts *TunnelService) Stop(sessionID string) {
	ts.mu.Lock()
	defer ts.mu.Unlock()

	entry, ok := ts.tunnels[sessionID]
	if !ok {
		return
	}
	delete(ts.tunnels, sessionID)

	entry.listener.Close()
	entry.sshClient.Close()
}

// Shutdown closes all tunnels. Call on app shutdown.
func (ts *TunnelService) Shutdown() {
	ts.mu.Lock()
	defer ts.mu.Unlock()

	for id, entry := range ts.tunnels {
		entry.listener.Close()
		entry.sshClient.Close()
		delete(ts.tunnels, id)
	}
}
```

- [ ] **Step 2: 验证编译**

```bash
cd backend && go build ./session/
```

Expected: 编译通过。

- [ ] **Step 3: 提交**

```bash
git add backend/session/tunnel_service.go && echo "Ready to commit"
```

---

### Task 3: Go — App 集成 TunnelService

**Files:**
- Modify: `app.go:32-47` (App struct)
- Modify: `app.go:53-120` (startup)
- Modify: `app.go:122-128` (shutdown)
- Modify: `app.go:424-521` (CreateSession)
- Modify: `app.go:523-528` (CloseSession)

- [ ] **Step 1: App 结构体加 tunnelService 字段**

在 `App` struct 的 `chatCancelMu` 字段后添加：

```go
type App struct {
	ctx                  context.Context
	sessionManager       *session.SessionManager
	connectionStore      *store.ConnectionStore
	aiSessionStore       *store.AISessionStore
	settingsStore        *store.SettingsStore
	terminalHistoryStore *store.TerminalHistoryStore
	syncService          *sync.SyncService
	tunnelService        *session.TunnelService   // <-- 新增
	mainHwnd            uintptr
	originalWndProc     uintptr
	wndProcCb           uintptr
	inSizeMove          bool
	webviewDataPath     string
	chatCancel          context.CancelFunc
	chatCancelMu        stdsync.Mutex
}
```

- [ ] **Step 2: startup 中初始化 tunnelService**

在 `a.sessionManager = session.NewSessionManager()` 之后添加：

```go
a.tunnelService = session.NewTunnelService()
```

- [ ] **Step 3: shutdown 中清理 tunnelService**

在 `shutdown` 方法中，`a.sessionManager.CloseAll()` 之前添加：

```go
if a.tunnelService != nil {
	a.tunnelService.Shutdown()
}
```

- [ ] **Step 4: CreateSession 中注入隧道逻辑**

流程：先创建 session → 建隧道（用 session ID 做 key）→ 修改 config → Connect。逻辑插入在 `s, err := a.sessionManager.Create(...)` 之后、`SetOnDataCallback` 之前。

保存原始 Host/Port，在 `manager.Create` 拿到 session ID 后建立隧道，然后替换 config.Host/Port 为 `127.0.0.1:localPort`。

**修改 manager.go 的 Create 方法**，只在 `config.ID` 为空时才生成 UUID（`backend/session/manager.go:25`）：

```go
if config.ID == "" {
    config.ID = uuid.New().String()
}
```

**修改 CreateSession**，在 `manager.Create` 成功后、session 回调注册前插入隧道逻辑：

```go
	s, err := a.sessionManager.Create(sessionType, config)
	if err != nil {
		log.Writef("[CreateSession] manager.Create failed: %v", err)
		return nil, err
	}
	log.Writef("[CreateSession] session created, id=%s", s.ID())

	// ── SSH Tunnel ──────────────────────────────────────────────
	if config.TunnelSSHConnID != "" && a.tunnelService != nil {
		if a.connectionStore == nil {
			_ = a.sessionManager.Close(s.ID())
			return nil, fmt.Errorf("connection store not initialized")
		}
		data, err := a.connectionStore.Load()
		if err != nil {
			_ = a.sessionManager.Close(s.ID())
			return nil, fmt.Errorf("load connections for tunnel: %w", err)
		}
		var tunnelSSHConfig *session.ConnectionConfig
		for _, c := range data.Connections {
			if c.ID == config.TunnelSSHConnID {
				tunnelSSHConfig = &c
				break
			}
		}
		if tunnelSSHConfig == nil {
			_ = a.sessionManager.Close(s.ID())
			return nil, fmt.Errorf("tunnel SSH connection not found: %s", config.TunnelSSHConnID)
		}

		localPort, err := a.tunnelService.Start(s.ID(), *tunnelSSHConfig, config.Host, config.Port)
		if err != nil {
			_ = a.sessionManager.Close(s.ID())
			return nil, fmt.Errorf("tunnel start: %w", err)
		}
		log.Writef("[CreateSession] tunnel established for session=%s via ssh=%s, localPort=%d",
			s.ID(), config.TunnelSSHConnID, localPort)
		config.Host = "127.0.0.1"
		config.Port = localPort
	}
	// ── End SSH Tunnel ──────────────────────────────────────────

- [ ] **Step 5: CloseSession 中关闭隧道**

在 `CloseSession` 方法中，`a.sessionManager.Close(sessionID)` 之后添加：

```go
func (a *App) CloseSession(sessionID string) error {
	if a.sessionManager == nil {
		return fmt.Errorf("session manager not initialized")
	}
	if a.tunnelService != nil {
		a.tunnelService.Stop(sessionID)
	}
	return a.sessionManager.Close(sessionID)
}
```

- [ ] **Step 6: 验证编译**

```bash
cd backend && go build ./...
```

Expected: 编译通过。

- [ ] **Step 7: 提交**

```bash
git add app.go backend/session/manager.go && echo "Ready to commit"
```

---

### Task 4: 前端 — TypeScript 类型加 tunnelSSHConnId

**Files:**
- Modify: `frontend/src/types/session.ts:8-28`

- [ ] **Step 1: 添加字段**

在 `ConnectionConfig` interface 中，`postLoginScript` 后添加：

```typescript
export interface ConnectionConfig {
  id: string
  name: string
  type: 'ssh' | 'telnet' | 'mosh' | 'rdp' | 'vnc' | 'spice' | 'database' | 'local' | 'sftp' | 'monitor'
  host: string
  port: number
  user: string
  authType: 'password' | 'key' | 'agent'
  password?: string
  keyPath?: string
  groupId?: string
  // RDP-specific
  rdpFixedWidth?: number
  rdpFixedHeight?: number
  rdpSmartSizing?: boolean
  // Local terminal shell path
  shellPath?: string
  dbType?: string
  dbName?: string
  postLoginScript?: string
  // SSH tunnel: reference to an existing SSH connection used as a jump host
  tunnelSSHConnId?: string
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
cd frontend && npx vue-tsc --noEmit
```

Expected: 无类型错误。

- [ ] **Step 3: 提交**

```bash
git add frontend/src/types/session.ts && echo "Ready to commit"
```

---

### Task 5: 前端 — ConnectionForm 隧道下拉框

**Files:**
- Modify: `frontend/src/components/ConnectionForm.vue`

- [ ] **Step 1: 模板中添加隧道选择下拉框**

在 `postLoginScript` 的 `el-form-item` 之后、`</el-form>` 之前添加：

```vue
      <el-form-item :label="t('conn.tunnel')">
        <el-select
          v-model="form.tunnelSSHConnId"
          :placeholder="t('conn.tunnelPlaceholder')"
          clearable
        >
          <el-option
            v-for="c in sshConnections"
            :key="c.id"
            :label="c.name"
            :value="c.id"
          />
        </el-select>
      </el-form-item>
```

- [ ] **Step 2: script 中添加 sshConnections 计算属性**

在 `<script setup lang="ts">` 中，`category` computed 之后添加：

```typescript
const sshConnections = computed(() =>
  connectionStore.connections.filter(c => c.type === 'ssh')
)
```

- [ ] **Step 3: resetForm 中添加字段重置**

在 `resetForm` 函数中，`form.postLoginScript = ''` 之后添加：

```typescript
  form.tunnelSSHConnId = undefined
```

- [ ] **Step 4: 验证编译**

```bash
cd frontend && npx vue-tsc --noEmit && npm run build
```

Expected: 编译通过，无错误。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/components/ConnectionForm.vue && echo "Ready to commit"
```

---

### Task 6: i18n — 添加隧道相关翻译键

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

- [ ] **Step 1: 添加 zh-CN 翻译**

在 `zh-CN.json` 末尾（最后一个键值对后加逗号，`}` 之前）添加：

```json
  "conn.tunnel": "SSH 隧道",
  "conn.tunnelPlaceholder": "选择 SSH 连接作为跳板..."
```

- [ ] **Step 2: 添加 en 翻译**

在 `en.json` 末尾添加：

```json
  "conn.tunnel": "SSH Tunnel",
  "conn.tunnelPlaceholder": "Select SSH connection as jump host..."
```

- [ ] **Step 3: 添加其余语言翻译**（至少包含 zh-TW, ja）

对 `zh-TW.json`：

```json
  "conn.tunnel": "SSH 隧道",
  "conn.tunnelPlaceholder": "選擇 SSH 連線作為跳板..."
```

对 `ja.json`：

```json
  "conn.tunnel": "SSH トンネル",
  "conn.tunnelPlaceholder": "ジャンプホストのSSH接続を選択..."
```

对 `ko.json`, `de.json`, `es.json`, `fr.json`, `ru.json` 直接用英文兜底（i18n 会自动 fallback 到 en）。

- [ ] **Step 4: 提交**

```bash
git add frontend/src/i18n/locales/*.json && echo "Ready to commit"
```

---

### Task 7: 完整构建验证

- [ ] **Step 1: 清理并构建前端**

```bash
cd frontend && rm -rf dist node_modules/.vite .vite && npm run build
```

Expected: 构建成功。

- [ ] **Step 2: 编译后端**

```bash
cd c:/Users/yowsa/Documents/workspace/uniterm && go build -o /dev/null ./...
```

Expected: 编译成功，无错误。

- [ ] **Step 3: 提交所有剩余改动**

```bash
git status
git add -A
git diff --cached --stat
echo "All changes staged. Ready for final commit."
```

---

### 执行顺序

Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7

Task 4、5、6 可以并行（均为前端改动，互不依赖），但 Task 4 和 5 都依赖 Task 6 的 i18n key；实际上 Task 5 用到的 `t('conn.tunnel')` 在 i18n 中，若 key 不存在会 fallback 显示 key 本身，所以 Task 5 和 6 顺序可互换。
