# 侧边栏历史命令面板 — 设计文档

## 概述

在侧边栏新增"历史命令"面板，将设置中的历史管理功能迁移到侧边栏，作为第三个可切换面板。

## 侧边栏布局

```
┌──────────────────────────┐
│ [📶] [⚡] [📋]       [X] │  ← 连接 / 快捷命令 / 历史 (History 图标)
├──────────────────────────┤
│ [搜索历史命令...]    [×]  │  ← el-input clearable
│                          │
│ git status               │  ← 无复选框，选中高亮
│ npm run dev              │     hover: Run/Paste/删除 按钮（多选时 Run/Paste 隐藏）
│ docker ps                │     Ctrl/Shift 多选
│ ssh root@1.2.3.4         │     双击/Enter: Run
│                          │
└──────────────────────────┘
```

## 数据来源

复用现有基础设施：
- `useSuggestions.historyCache` — `Map<string, HistoryEntry>`
- `useSuggestions.loadHistory()` — 从后端加载
- Wails API: `SaveTerminalHistory` / `LoadTerminalHistory` / `DeleteTerminalHistoryEntry`

不新建 store，直接用 `useSuggestions` 实例。

## HistoryPanel 组件

新组件：`components/HistoryPanel.vue`

### 布局
- 搜索框（`el-input` clearable size="small"）
- 列表（`div.qc-list` 风格，和快捷命令一致）
- 底部操作栏（有选中时显示删除按钮）

### 命令项显示
- 单行文本，命令内容，等宽字体浅色
- 无名称，仅显示命令文本

### 交互

| 操作 | 触发 | 效果 |
|------|------|------|
| 选中 | 单击 | 高亮该项 |
| 多选 | Ctrl+点击 切换 | 添加到选中集合 |
| 范围选择 | Shift+点击 | 选择范围 |
| Run | 双击 / Enter（单选）/ 点击 Run 按钮 | 发送到活跃终端，追加 `\n`。多选时 Enter 不生效 |
| Paste | 点击 Paste 按钮 | 原样粘贴 |
| 删除 | hover 删除按钮 或 右键 删除 | 确认后删除，支持多选批量 |
| 右键菜单 | Run / Paste / 保存为快捷命令 / 删除。多选时 Run/Paste 置灰 |
| 搜索 | 输入搜索 | 过滤匹配项，展开第一项并自动选中 |

### 发送机制
- 复用快捷命令面板的 `getTargetSessionIds()` 逻辑
- 广播模式下发送到 workspace 所有面板

## 侧边栏变更

- 加第三个图标按钮：`History`（和设置中历史图标一致）
- `activeView` 类型扩展：`'connections' | 'quickCommands' | 'history'`
- 条件渲染 `<HistoryPanel v-if="activeView === 'history'" />`

## 历史记录常驻开启

当前历史记录依赖 `smartCompletion` 开关，关闭后不再记录命令。修改为始终记录：

- `BaseTerminal.vue`：`useTerminalInput` 的 `enableHistory` 参数始终为 `true`
- `useSuggestions.ts`：`loadHistory()` 始终调用，不再受开关控制
- 智能提示开关仅控制**建议弹窗的显示**，不影响历史记录

## SettingsTab 变更

- 移除 `activeCategory === 'history'` 的整个 section
- 移除左侧导航中 history 类目注入

## i18n

新增 key：
```
quickCommands.historyTab       历史命令 (zh) / History (en) / ...
```

复用现有 key：
```
settings.history
settings.historySearchPlaceholder
settings.historyDeleteSelected
settings.historyEmpty
(etc — 从 SettingsTab 已有 key)
```

## 验证点

1. 侧边栏第三个图标按钮 → 切换到历史面板
2. 历史面板显示命令列表
3. 搜索过滤正常
4. 单击选中，Ctrl/Shift 多选
5. 双击/Enter → Run 发送到终端
6. Paste → 原样粘贴
7. hover 按钮：Run / Paste / Delete
8. 右键菜单：Run / Paste / 删除选中
9. 批量删除
10. 广播模式下发送到所有面板
11. 设置中历史管理已移除
