# SSH 隧道功能设计

## 概述

在 uniTerm 的连接配置中，新增"SSH 隧道"选项：任何连接可以选择一个已有的 SSH 连接作为跳板，通过该 SSH 隧道访问目标。实现方式为本地端口转发（`-L`），本地监听端口自动分配。

## 需求摘要

- 连接配置中增加"SSH 隧道"下拉选择框，选项来自已有的 SSH 连接
- 默认不启用隧道（空选项）
- 隧道模式：本地转发（-L），本地端口自动分配
- 选中的 SSH 连接信息用于建立隧道，不复用已有 SSH 终端会话
- 隧道配置随连接配置持久化
- 连接断开时隧道自动关闭

## 架构

### 新增：TunnelService

`backend/session/tunnel_service.go` — 集中管理所有 SSH 隧道的生命周期。

```
TunnelService
├── Start(tunnelSSH ConnectionConfig, targetHost string, targetPort int) → localPort int
│   1. 用 tunnelSSH 配置建立 SSH 连接
│   2. ssh.Client.Listen("tcp", "127.0.0.1:0") 自动分配端口
│   3. 每个 accept 的本地连接通过 SSH 转发到 targetHost:targetPort
│   4. 返回本地监听端口号
│
├── Stop(sessionID string) → 关闭该 session 关联的隧道和 SSH 连接
│
└── Shutdown() → 关闭所有隧道
```

内部维护 `map[string]*tunnelState`，key 为 session ID。

### 连接流程改造

在 `app.go` 的 `CreateSession` 中：

```
如果 config.TunnelSSHConnID != "":
  1. 从 connectionStore 加载隧道 SSH 的 ConnectionConfig
  2. localPort = tunnelService.Start(隧道SSH配置, config.Host, config.Port)
  3. config.Host = "127.0.0.1", config.Port = localPort
然后正常执行 session.Connect(config)
```

隧道建立失败时，直接返回错误，不建立主连接。

各 Session 类型（SSH、Database、Telnet 等）**无需修改**——它们收到的已经是隧道后的地址。

### 断开流程

在 `CloseSession` 中，如果该 session 使用了隧道，调用 `tunnelService.Stop(sessionID)`。

## 数据模型

### ConnectionConfig 新增字段

```go
// backend/session/session.go
type ConnectionConfig struct {
    // ... 现有字段 ...
    TunnelSSHConnID string `json:"tunnelSSHConnId,omitempty"` // 隧道 SSH 连接 ID
}
```

```typescript
// frontend/src/types/session.ts
export interface ConnectionConfig {
    // ... 现有字段 ...
    tunnelSSHConnId?: string  // 隧道 SSH 连接 ID
}
```

持久化在 `connections.json` 中，随同步功能一起同步。

## 前端 UI

### ConnectionForm.vue 新增

在 `postLoginScript` 下拉框之后、表单末尾之前，新增隧道选择：

```
┌─ SSH 隧道 ───────────────────────────────┐
│  隧道连接: [下拉选择已有 SSH 连接 ▼]       │
│  (可选，选择后该连接将通过此 SSH 隧道访问)   │
└──────────────────────────────────────────┘
```

下拉选项：
- 默认：空（不使用隧道）
- 从 `connectionStore.connections` 中过滤 `type === 'ssh'` 的连接

## 适用范围

SSH 隧道本质是 TCP 端口转发，凡 Go 后端通过 TCP dial 连接的都能走隧道。
前端直连或非 TCP 协议的例外。

| 类型 | 隧道 | 原因 |
|------|:----:|------|
| SSH 终端 | ✅ | Go 端 TCP dial 到目标 22 |
| SFTP | ✅ | Go 端 TCP dial 到目标 22 |
| Monitor | ✅ | Go 端 TCP dial 到目标 22 |
| Database | ✅ | Go 端 TCP dial（MySQL/PostgreSQL/rqlite） |
| Telnet | ✅ | Go 端 TCP dial |
| RDP | ✅ | Go 端 TCP dial，Windows 原生控件 |
| VNC | ✅ | VNCProxy 本地代理 + TCP dial |
| SPICE | ❌ | 前端 WebSocket 直连目标，不经后端 TCP dial |
| Mosh | ❌ | 数据面走 UDP，非 TCP |
| Local | ❌ | 本地终端，不连远程 |

SPICE 后续可加，需要实现类似 VNCProxy 的本地 WebSocket 代理。

## 涉及文件

| 文件 | 操作 |
|------|------|
| `backend/session/tunnel_service.go` | **新增** |
| `backend/session/session.go` | `ConnectionConfig` 加 `TunnelSSHConnID` |
| `app.go` | `CreateSession` 注入隧道逻辑；`CloseSession` 关闭隧道；`App` 结构体加 `tunnelService` |
| `frontend/src/types/session.ts` | `ConnectionConfig` 加 `tunnelSSHConnId` |
| `frontend/src/components/ConnectionForm.vue` | 表单新增隧道选择下拉框 |

## 错误处理

| 场景 | 处理 |
|------|------|
| 隧道 SSH 连接不存在 | 连接前校验，返回明确错误信息 |
| 隧道 SSH 认证失败 | 隧道建立失败，返回错误给前端 |
| 目标不可达 | SSH 转发层面报错，返回给前端 |
| 隧道 SSH 连接断开 | 主连接也随之断开 |
| 主连接断开 | 隧道自动关闭 |

## 测试要点

- 隧道建立：本地端口正确分配，目标可达
- 隧道断开：主连接断开后隧道正确释放
- 持久化：保存/加载连接时 `tunnelSSHConnId` 正确读写
- 边界：引用不存在/已删除的 SSH 连接时的提示
- 多隧道：多个连接同时使用不同 SSH 隧道不冲突
