# 侧边栏历史命令面板 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在侧边栏新增历史命令面板，从设置中迁移历史管理，始终记录命令历史。

**Architecture:** 新建 `HistoryPanel.vue` 组件，复用 `useSuggestions` 的历史缓存和现有 Wails API。侧边栏加第三个图标按钮。`BaseTerminal.vue` 中移除智能提示对历史记录的开关控制。

**Tech Stack:** Vue 3 + TypeScript + Element Plus + lucide-vue

---

## 文件结构

| 文件 | 职责 | 新建/修改 |
|------|------|-----------|
| `components/HistoryPanel.vue` | 历史命令面板 | 新建 |
| `components/Sidebar.vue` | 加第三个图标按钮 + 条件渲染 | 修改 |
| `components/BaseTerminal.vue` | 历史记录常驻开启 | 修改 |
| `components/SettingsTab.vue` | 移除历史管理 section | 修改 |
| `i18n/locales/*.json` (9 个) | 新增 `quickCommands.historyTab` key | 修改 |

---

### Task 1: 历史记录常驻开启

**Files:**
- Modify: `frontend/src/components/BaseTerminal.vue`

- [ ] **Step 1: BaseTerminal.vue — 始终启用历史记录**

Read `BaseTerminal.vue`。找到两处 `enableHistory: smartOn`（约 571 行和 1110 行），将 `smartOn` 替换为 `true`：

```typescript
// Line ~567-571 (onMounted)
const smartOn = settingsStore.settings.terminal.smartCompletion ?? true
terminalInput = useTerminalInput(terminal, {
  mode: props.mode,
  sessionId: props.sessionId,
  enableHistory: true,  // was: smartOn
  onHistoryExtract: (command: string) => {
    suggestions.addHistoryCommand(command)
  },
  onResetSuppress: () => {
    suggestions.resetSuppress()
  },
})

// Line ~1106-1110 (watch sessionId)
const smartOn = settingsStore.settings.terminal.smartCompletion ?? true
terminalInput = useTerminalInput(terminal, {
  mode: props.mode,
  sessionId: newId,
  enableHistory: true,  // was: smartOn
  onHistoryExtract: (command: string) => {
    suggestions.addHistoryCommand(command)
  },
  onResetSuppress: () => {
    suggestions.resetSuppress()
  },
})
```

Also at line ~581 and ~1119, `suggestions.loadHistory()` is called inside `if (smartOn)`. Move it outside the condition so it always runs:

```typescript
// Line ~580-582 (onMounted)
if (smartOn) {
  suggestions.loadHistory()
}
// Change to:
suggestions.loadHistory()
```

Same for line ~1119.

- [ ] **Step 2: Build**

```bash
cd c:/Users/Admin/Documents/Workspaces/uniTerm/frontend && npm run build
```

Expected: Build passes.

---

### Task 2: HistoryPanel 组件

**Files:**
- Create: `frontend/src/components/HistoryPanel.vue`

- [ ] **Step 1: 创建 HistoryPanel.vue**

```vue
<template>
  <div class="history-panel">
    <div class="qc-toolbar">
      <el-input
        v-model="searchQuery"
        :placeholder="t('settings.historySearchPlaceholder')"
        clearable
        size="small"
        class="qc-search-input"
        @keydown="onListKeydown"
      />
    </div>

    <div class="qc-list" ref="listRef" tabindex="0" @keydown="onListKeydown">
      <div
        v-for="entry in filteredEntries"
        :key="entry.id"
        class="qc-item"
        :class="{ active: selectedIds.has(entry.id) }"
        @click="onItemClick($event, entry)"
        @dblclick="runCommand(entry)"
        @contextmenu.prevent="onContextMenu($event, entry)"
        @mouseenter="hoveredId = entry.id"
        @mouseleave="hoveredId = null"
      >
        <span class="history-command">{{ entry.command }}</span>
        <div v-if="selectedIds.size <= 1 && (selectedIds.has(entry.id) || hoveredId === entry.id)" class="qc-item-actions" :class="{ visible: selectedIds.has(entry.id) || hoveredId === entry.id }">
          <button class="qc-action-btn run" @click.stop="runCommand(entry)" :title="t('quickCommands.run')">
            <Play :size="14" />
          </button>
          <button class="qc-action-btn paste" @click.stop="pasteCommand(entry)" :title="t('quickCommands.paste')">
            <Clipboard :size="14" />
          </button>
          <button class="qc-action-btn delete" @click.stop="deleteEntries([entry.id])" :title="t('sidebar.delete')">
            <X :size="14" />
          </button>
        </div>
      </div>

      <div v-if="filteredEntries.length === 0" class="qc-empty">
        {{ searchQuery ? t('sidebar.noSearchResults') : t('settings.historyEmpty') }}
      </div>
    </div>

    <!-- Context menu -->
    <div
      v-show="menuVisible"
      class="qc-context-menu"
      :style="menuStyle"
      @click.stop
    >
      <div class="menu-item" :class="{ disabled: selectedIds.size > 1 }" @click="selectedIds.size <= 1 && runCommand(menuTarget!)">{{ t('quickCommands.run') }}</div>
      <div class="menu-item" :class="{ disabled: selectedIds.size > 1 }" @click="selectedIds.size <= 1 && pasteCommand(menuTarget!)">{{ t('quickCommands.paste') }}</div>
      <div class="menu-item" :class="{ disabled: selectedIds.size > 1 }" @click="selectedIds.size <= 1 && saveAsQuickCommand(menuTarget!)">{{ t('quickCommands.saveAs') }}</div>
      <div class="menu-divider" />
      <div class="menu-item danger" @click="deleteSelected(); closeMenu()">{{ t('sidebar.delete') }}</div>
    </div>

    <!-- Quick command edit dialog -->
    <QuickCommandEditDialog
      v-model="editDialogVisible"
      :initial-command="editingCmdCommand"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { Play, Clipboard, X } from '@lucide/vue'
import { useSuggestions, type HistoryEntry } from '../composables/useSuggestions'
import { useTabStore } from '../stores/tabStore'
import { usePanelStore } from '../stores/panelStore'
import { useQuickCommandStore } from '../stores/quickCommandStore'
import { SessionWrite } from '../../wailsjs/go/main/App'
import { useI18n } from '../i18n'
import QuickCommandEditDialog from './QuickCommandEditDialog.vue'

const { t } = useI18n()
const suggestions = useSuggestions()
const tabStore = useTabStore()
const panelStore = usePanelStore()
const qcStore = useQuickCommandStore()

const searchQuery = ref('')
const selectedIds = ref<Set<string>>(new Set())
const focusedId = ref<string | null>(null)
const hoveredId = ref<string | null>(null)
const listRef = ref<HTMLDivElement | null>(null)
const lastClickId = ref<string | null>(null)

const menuVisible = ref(false)
const menuStyle = ref({ left: '0px', top: '0px' })
const menuTarget = ref<HistoryEntry | null>(null)

const editDialogVisible = ref(false)
const editingCmdCommand = ref('')

function saveAsQuickCommand(entry: HistoryEntry) {
  editingCmdCommand.value = entry.command
  editDialogVisible.value = true
  closeMenu()
}

const entries = ref<HistoryEntry[]>([])

onMounted(async () => {
  entries.value = await suggestions.loadHistory()
  document.addEventListener('click', closeMenu)
})

onUnmounted(() => {
  document.removeEventListener('click', closeMenu)
})

const filteredEntries = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return entries.value
  return entries.value.filter(e => e.command.toLowerCase().includes(q))
})

function getAllVisibleIds(): string[] {
  return filteredEntries.value.map(e => e.id)
}

function onListKeydown(e: KeyboardEvent) {
  const ids = getAllVisibleIds()
  if (ids.length === 0) return
  const idx = ids.indexOf(focusedId.value || '')

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    const nextIdx = idx >= 0 && idx < ids.length - 1 ? idx + 1 : 0
    focusedId.value = ids[nextIdx]
    selectedIds.value = new Set([ids[nextIdx]])
    lastClickId.value = ids[nextIdx]
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    const prevIdx = idx > 0 ? idx - 1 : ids.length - 1
    focusedId.value = ids[prevIdx]
    selectedIds.value = new Set([ids[prevIdx]])
    lastClickId.value = ids[prevIdx]
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (selectedIds.value.size === 1 && focusedId.value) {
      const entry = entries.value.find(e => e.id === focusedId.value)
      if (entry) runCommand(entry)
    }
  } else if (e.key === 'Delete') {
    e.preventDefault()
    deleteSelected()
  }
}

function onItemClick(e: MouseEvent, entry: HistoryEntry) {
  if (e.shiftKey && lastClickId.value) {
    const ids = getAllVisibleIds()
    const anchorIdx = ids.indexOf(lastClickId.value)
    const currentIdx = ids.indexOf(entry.id)
    if (anchorIdx >= 0 && currentIdx >= 0) {
      const [start, end] = anchorIdx < currentIdx ? [anchorIdx, currentIdx] : [currentIdx, anchorIdx]
      selectedIds.value = new Set(ids.slice(start, end + 1))
    }
  } else if (e.ctrlKey || e.metaKey) {
    const next = new Set(selectedIds.value)
    if (next.has(entry.id)) next.delete(entry.id)
    else next.add(entry.id)
    selectedIds.value = next
    lastClickId.value = entry.id
    focusedId.value = entry.id
  } else {
    selectedIds.value = new Set([entry.id])
    lastClickId.value = entry.id
    focusedId.value = entry.id
  }
}

function getTargetSessionIds(): string[] {
  const activeTabId = tabStore.activeTabId
  if (!activeTabId) return []
  const tab = tabStore.tabs.find(t => t.id === activeTabId)
  if (!tab) return []
  if (tab.type === 'workspace' && tabStore.isBroadcasting(tab.id)) {
    const ids: string[] = []
    for (const pid of tab.panelIds) {
      const p = panelStore.getPanel(pid)
      if (p?.sessionId && (p.type === 'ssh' || p.type === 'local')) {
        ids.push(p.sessionId)
      }
    }
    return ids
  }
  const activePanelId = tab.type === 'workspace' ? tab.activePanelId : (tab.type === 'terminal' ? tab.panelId : null)
  if (!activePanelId) return []
  const panel = panelStore.getPanel(activePanelId)
  if (!panel?.sessionId) return []
  return [panel.sessionId]
}

function runCommand(entry: HistoryEntry) {
  const sids = getTargetSessionIds()
  if (sids.length === 0) return
  const text = entry.command.endsWith('\n') ? entry.command : entry.command + '\n'
  for (const sid of sids) {
    SessionWrite(sid, text)
  }
}

function pasteCommand(entry: HistoryEntry) {
  const sids = getTargetSessionIds()
  if (sids.length === 0) return
  for (const sid of sids) {
    SessionWrite(sid, entry.command)
  }
}

function deleteEntries(ids: string[]) {
  suggestions.removeHistoryCommandsById(ids)
  entries.value = entries.value.filter(e => !ids.includes(e.id))
  selectedIds.value = new Set()
}

function deleteSelected() {
  const ids = [...selectedIds.value]
  if (ids.length === 0) return
  deleteEntries(ids)
}

function onContextMenu(e: MouseEvent, entry: HistoryEntry) {
  e.stopPropagation()
  window.dispatchEvent(new CustomEvent('global:close-context-menus'))
  menuTarget.value = entry
  if (!selectedIds.value.has(entry.id)) {
    selectedIds.value = new Set([entry.id])
    focusedId.value = entry.id
  }
  menuStyle.value = clampMenuPosition(e.clientX, e.clientY)
  menuVisible.value = true
}

function closeMenu() { menuVisible.value = false }

function clampMenuPosition(x: number, y: number) {
  const mx = Math.min(x, window.innerWidth - 160)
  const my = Math.min(y, window.innerHeight - 100)
  return { left: mx + 'px', top: my + 'px' }
}

watch(searchQuery, () => {
  const ids = getAllVisibleIds()
  if (ids.length > 0) {
    focusedId.value = ids[0]
    selectedIds.value = new Set([ids[0]])
    lastClickId.value = ids[0]
  } else {
    focusedId.value = null
    selectedIds.value = new Set()
  }
})
</script>

<style scoped>
.history-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.history-command {
  flex: 1;
  font-family: var(--font-mono, 'Consolas', 'Courier New', monospace);
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
```

The component reuses QuickCommandsPanel CSS classes (`.qc-toolbar`, `.qc-search-input`, `.qc-list`, `.qc-item`, `.qc-item.active`, `.qc-item-actions`, `.qc-action-btn`, `.qc-context-menu`, `.menu-item`, `.menu-divider`, `.qc-empty`). These styles are already defined in QuickCommandsPanel.vue but are scoped. Since HistoryPanel is a separate component, you need to **either copy the relevant QC CSS into HistoryPanel's `<style scoped>` block, or make the QC styles global**.

**Recommended approach:** Copy the relevant CSS from QuickCommandsPanel.vue into HistoryPanel.vue. The styles to copy are listed below.

### Step 2: Add required CSS

Add these styles to HistoryPanel's `<style scoped>` (after the `.history-panel` and `.history-command` styles above):

```css
.qc-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px 6px;
  flex-shrink: 0;
}

.qc-search-input { flex: 1; min-width: 0; }

.qc-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 8px;
}

.qc-item {
  display: flex;
  align-items: center;
  padding: 8px 10px;
  gap: 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.12s ease;
  margin-bottom: 2px;
  user-select: none;
}

.qc-item:hover { background: var(--bg-hover); }

.qc-item.active {
  background: var(--accent-subtle);
  box-shadow: inset 0 0 0 1px var(--accent-dim);
}

.qc-item.active .history-command { color: var(--accent); }

.qc-item-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
  visibility: hidden;
  opacity: 0;
  transition: opacity 0.12s ease, visibility 0.12s ease;
}

.qc-item-actions.visible { visibility: visible; opacity: 1; }

.qc-action-btn {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-muted);
  background: transparent;
}

.qc-action-btn:hover { color: var(--text-primary); background: var(--bg-hover); }
.qc-action-btn.run:hover { color: var(--success-color, #22c55e); }
.qc-action-btn.paste:hover { color: var(--accent-color, #22d3ee); }
.qc-action-btn.delete:hover { color: var(--danger-color, #f56c6c); }

.qc-empty {
  padding: 24px 12px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}

.qc-context-menu {
  position: fixed;
  z-index: 9999;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: var(--shadow-lg);
  padding: 4px;
  min-width: 140px;
}

.qc-context-menu .menu-item {
  padding: 6px 10px;
  font-size: 12px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-primary);
}

.qc-context-menu .menu-item:hover { background: var(--bg-hover); }
.qc-context-menu .menu-item.danger { color: var(--danger-color, #f56c6c); }
.qc-context-menu .menu-item.disabled { color: var(--text-disabled); pointer-events: none; }

.qc-context-menu .menu-divider {
  height: 1px;
  background: var(--border-color);
  margin: 4px 6px;
}
```

- [ ] **Step 3: Build**

```bash
cd c:/Users/Admin/Documents/Workspaces/uniTerm/frontend && npm run build
```

Expected: Build passes (component exists but not yet imported by Sidebar).

---

### Task 3: 侧边栏集成

**Files:**
- Modify: `frontend/src/components/Sidebar.vue`

- [ ] **Step 1: 添加 History 图标导入和第三个按钮**

Read `Sidebar.vue`。Import 行添加 `History`：

```typescript
import { X, ChevronRight, ChevronDown, Filter, Check, Network, Zap, History } from '@lucide/vue'
```

Import 组件：
```typescript
import HistoryPanel from './HistoryPanel.vue'
```

`activeView` ref 类型扩展：
```typescript
const activeView = ref<'connections' | 'quickCommands' | 'history'>('connections')
```

Template 中添加第三个按钮（在 Zap 按钮之后，X 按钮之前）：
```html
<button class="sidebar-tab" :class="{ active: activeView === 'history' }" @click="activeView = 'history'" :title="t('quickCommands.historyTab')"><el-icon><History :size="16" /></el-icon></button>
```

Template 中添加条件渲染（在 QuickCommandsPanel 之后）：
```html
<HistoryPanel v-if="activeView === 'history'" />
```

- [ ] **Step 2: Build**

```bash
cd c:/Users/Admin/Documents/Workspaces/uniTerm/frontend && npm run build
```

Expected: Build succeeds.

---

### Task 4: i18n

**Files:**
- Modify: `frontend/src/i18n/locales/zh-CN.json`
- Modify: `frontend/src/i18n/locales/en.json`
- Modify: `frontend/src/i18n/locales/zh-TW.json`
- Modify: `frontend/src/i18n/locales/ja.json`
- Modify: `frontend/src/i18n/locales/ko.json`
- Modify: `frontend/src/i18n/locales/fr.json`
- Modify: `frontend/src/i18n/locales/de.json`
- Modify: `frontend/src/i18n/locales/es.json`
- Modify: `frontend/src/i18n/locales/ru.json`

- [ ] **Step 1: 添加 `quickCommands.historyTab` key 到所有 locale 文件**

Add near the existing `quickCommands.quickCommandsTab` key:

zh-CN: `"quickCommands.historyTab": "历史命令"`, `"quickCommands.saveAs": "保存为快捷命令"`
en: `"quickCommands.historyTab": "History"`, `"quickCommands.saveAs": "Save as Quick Command"`
zh-TW: `"quickCommands.historyTab": "歷史命令"`, `"quickCommands.saveAs": "儲存為快捷命令"`
ja: `"quickCommands.historyTab": "履歴"`, `"quickCommands.saveAs": "クイックコマンドに保存"`
ko: `"quickCommands.historyTab": "명령 기록"`, `"quickCommands.saveAs": "빠른 명령으로 저장"`
fr: `"quickCommands.historyTab": "Historique"`, `"quickCommands.saveAs": "Enregistrer comme commande rapide"`
de: `"quickCommands.historyTab": "Verlauf"`, `"quickCommands.saveAs": "Als Schnellbefehl speichern"`
es: `"quickCommands.historyTab": "Historial"`, `"quickCommands.saveAs": "Guardar como comando rápido"`
ru: `"quickCommands.historyTab": "История"`, `"quickCommands.saveAs": "Сохранить как быструю команду"`

- [ ] **Step 2: Build**

```bash
cd c:/Users/Admin/Documents/Workspaces/uniTerm/frontend && npm run build
```

---

### Task 5: 从设置中移除历史管理

**Files:**
- Modify: `frontend/src/components/SettingsTab.vue`

- [ ] **Step 1: 移除历史 section 模板**

Read `SettingsTab.vue`。删除 lines 255-317（`activeCategory === 'history'` 的整个 `<div>` section）。

- [ ] **Step 2: 移除导航中 history 类目**

Line 559-561:
```typescript
if (smartOn) {
  cats.splice(4, 0, { key: 'history', label: t('settings.history'), icon: History })
}
```
删除这三行。

- [ ] **Step 3: 移除不再使用的 script 变量**

Remove history-related refs and functions:
- `historySearch`, `historyEntries`, `historySelectedIds`
- `refreshHistory`, `toggleSelectAllHistory`, `isAllHistorySelected`, `toggleHistorySelection`, `deleteHistoryItem`, `deleteSelectedHistory`
- Related computed/watchers

Also remove unused imports: `Trash2`, `Search` (if only used by history section).

- [ ] **Step 4: Build**

```bash
cd c:/Users/Admin/Documents/Workspaces/uniTerm/frontend && npm run build
```

Expected: Build passes.

---

### Task 6: 完整构建 + 验证

- [ ] **Step 1: Clean + full build**

```bash
cd c:/Users/Admin/Documents/Workspaces/uniTerm/frontend && rm -rf dist node_modules/.vite && npm run build && cd .. && wails build -platform windows/amd64
```

Expected: Build succeeds.

- [ ] **Step 2: 验证清单**
1. 侧边栏第三个 History 图标按钮 → 切换正常
2. 历史面板显示命令列表
3. 搜索过滤正常，自动选中第一项
4. 单击选中，Ctrl/Shift 多选
5. 双击/Enter（单选）→ Run 发送到终端
6. hover 按钮：Run/Paste/Delete（多选时 Run/Paste 隐藏）
7. 右键菜单：Run/Paste 多选置灰，删除始终可用
8. 关闭智能提示后，新命令依然被记录
9. 设置中历史管理已移除
10. 广播模式下发送到所有面板
