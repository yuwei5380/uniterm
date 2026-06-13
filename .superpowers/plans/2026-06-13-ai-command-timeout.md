# AI Command Timeout & Interactive Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AI fine-grained control over command timeout, enable waiting for long-running commands without re-sending, and allow responding to interactive terminal prompts (passwords, confirmations).

**Architecture:** Three new tools (`wait_for_output`, `send_terminal_key`, `interrupt_command`) sit alongside `execute_command`. `execute_command` gains a `timeout` parameter. All tools share a single `watchOutput` primitive that streams terminal output and checks for the completion marker — duplicated from and replacing the current inline Promise in `executeCommand`.

**Tech Stack:** Vue 3 + TypeScript (frontend), Wails v2 runtime

**Current branch:** `fix/ai-conversation`

---

## File Structure

| File | Role | Change |
|------|------|--------|
| `frontend/src/services/terminalAgent.ts` | Command execution & output watching | Extract `watchOutput`; add `timeout` to `executeCommand`; add `waitForOutput`, `sendTerminalKey` |
| `frontend/src/services/llm.ts` | Tool definitions | Add `wait_for_output`, `send_terminal_key`, `interrupt_command`; update `execute_command` schema |
| `frontend/src/services/agent.ts` | Agent loop | Handle tool calls for the 3 new tools |
| `frontend/src/stores/aiStore.ts` | System prompt | Update SYSTEM_RULES to document new tools and their usage |

---

## Architecture: How `watchOutput` Works

Every tool that needs to observe terminal output (`execute_command`, `wait_for_output`) uses the same shared primitive:

```
watchOutput(sessionId, marker, timeoutMs) → Promise<{ output, exitCode, timedOut }>
```

It listens to `session:data` events, scans for the marker (first occurrence = command echo, second = actual marker printed), and resolves when the marker is found or timeout elapses. On timeout, it returns the output accumulated so far with `timedOut: true` — the caller (AI) decides what to do next.

Three callers:

| Caller | Sends command first? | After watchOutput returns... |
|--------|---------------------|------------------------------|
| `execute_command` | Yes — writes command + marker + newline | Returns full result to AI |
| `wait_for_output` | No — command already running | Returns accumulated output + timedOut flag |
| `send_terminal_key` | Writes text/control char, then watches briefly | Returns what appears after the input |

---

### Task 1: Extract `watchOutput` primitive

**Files:**
- Modify: `frontend/src/services/terminalAgent.ts`

**Background:** Currently `executeCommand()` builds the marker inline, sends the command, and creates a Promise that wraps the `session:data` listener + `setTimeout`. This Promise logic is the "watch for marker or timeout" pattern. We extract it into a standalone `watchOutput` function so `wait_for_output` and the enhanced `execute_command` can share it.

- [ ] **Step 1: Add `watchOutput` function before `executeCommand`**

In `frontend/src/services/terminalAgent.ts`, insert between the imports (line 5) and the `executeCommand` function (line 11):

```typescript
interface WatchResult {
  output: string
  timedOut: boolean
}

function watchOutput(
  sessionId: string,
  marker: string,
  timeoutMs: number
): { promise: Promise<WatchResult>; cleanup: () => void } {
  let timeoutId: ReturnType<typeof setTimeout>
  let unsubscribe: (() => void) | null = null
  let resolved = false
  let output = ''
  let lastScanPos = 0
  let markerSeen = false

  const cleanup = () => {
    clearTimeout(timeoutId)
    unsubscribe?.()
    resolved = true
  }

  const promise = new Promise<WatchResult>((resolve) => {
    unsubscribe = EventsOn('session:data', (payload: { id: string; data: string }) => {
      if (payload.id !== sessionId || resolved) return

      output += payload.data
      const clean = stripAnsi(output)

      const scanStart = Math.max(0, lastScanPos - marker.length)
      lastScanPos = clean.length
      let searchIdx = scanStart
      while ((searchIdx = clean.indexOf(marker, searchIdx)) !== -1) {
        searchIdx += marker.length
        if (!markerSeen) {
          markerSeen = true
          continue
        }
        cleanup()
        const result = clean.slice(0, searchIdx - marker.length).trim()
        resolve({ output: result, timedOut: false })
        return
      }
    })

    timeoutId = setTimeout(() => {
      cleanup()
      resolve({
        output: stripAnsi(output).trim(),
        timedOut: true,
      })
    }, timeoutMs)
  })

  return { promise, cleanup }
}
```

- [ ] **Step 2: Rewrite `executeCommand` to use `watchOutput`**

Replace the current `executeCommand` body (lines 11-95) with the version below. The function signature adds an optional `timeoutMs` parameter (default 60000 to match current behavior). On timeout, output is returned with a clear marker so AI knows the command didn't finish.

```typescript
export async function executeCommand(
  command: string,
  timeoutMs: number = 60000
): Promise<ExecuteResult> {
  const tabStore = useTabStore()
  const panelStore = usePanelStore()

  const lockedPanelId = tabStore.getAILockedPanel()
  let panel = lockedPanelId ? panelStore.getPanel(lockedPanelId) : null

  if (!panel) {
    const activeTab = tabStore.activeTab
    if (activeTab?.type === 'terminal' || activeTab?.type === 'settings') {
      panel = panelStore.getPanel(activeTab.panelId)
    } else if (activeTab?.type === 'workspace' && activeTab.activePanelId) {
      panel = panelStore.getPanel(activeTab.activePanelId)
    }
  }

  if (!panel || !panel.sessionId) {
    throw new Error('No active terminal session')
  }

  const sessionId = panel.sessionId

  const marker = `__AI_DONE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`
  const shellPath = panel.config?.shellPath
  const fullCommand = buildCommand(command, marker, shellPath)

  const lowerShell = (shellPath || '').toLowerCase()
  let newline: string
  if (lowerShell.includes('powershell') || lowerShell.includes('pwsh')) {
    newline = '\r'
  } else if (lowerShell.includes('cmd')) {
    newline = '\r\n'
  } else if (lowerShell.includes('bash') || lowerShell.includes('sh')) {
    newline = '\r\n'
  } else {
    newline = '\n'
  }

  await SessionWrite(sessionId, fullCommand + newline)

  const { promise } = watchOutput(sessionId, marker, timeoutMs)
  const result = await promise

  if (result.timedOut) {
    return {
      output: result.output
        + `\n\n⚠️ Command did not complete within ${timeoutMs / 1000}s.`
        + ` The command may still be running. Do NOT re-send the same command.`
        + `\n- If the output shows a prompt (password, y/n, etc.), use send_terminal_key to respond.`
        + `\n- If the output shows progress (building, downloading, etc.), use wait_for_output to keep waiting.`
        + `\n- If you need to cancel the command, use interrupt_command.`,
      exitCode: -1,
    }
  }

  return { output: result.output, exitCode: 0 }
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/services/terminalAgent.ts
git commit -m "refactor(ai): extract watchOutput primitive, add configurable timeout to executeCommand"
```

---

### Task 2: Add `waitForOutput` function

**Files:**
- Modify: `frontend/src/services/terminalAgent.ts`

**Background:** When `execute_command` times out but the AI sees the command is still making progress, it can call `wait_for_output` to keep waiting WITHOUT sending another command. This function uses `watchOutput` but doesn't write anything to the terminal — it just watches for the command's echo marker or timeout.

Key design decision: `wait_for_output` can't know the original command's marker (it was generated inside `execute_command`). Instead, it scans for the **shell prompt re-appearing** — when the prompt returns, the previous command has completed. A fallback approach: watch for any new output and use user-specified timeout.

Simpler approach: `wait_for_output` watches for a new unique marker by sending only the marker echo (no command), which means the marker appears when the prior command finishes. Actually, even simpler: just listen for output changes and return what's new after the timeout.

The cleanest approach: `wait_for_output` sends a lightweight marker-only command and watches for it. This doesn't interfere with the running command — it only echoes when the shell prompt comes back.

- [ ] **Step 1: Add `waitForOutput` function**

Add after `executeCommand` in `frontend/src/services/terminalAgent.ts`:

```typescript
export async function waitForOutput(
  timeoutMs: number = 30000
): Promise<ExecuteResult> {
  const tabStore = useTabStore()
  const panelStore = usePanelStore()

  const lockedPanelId = tabStore.getAILockedPanel()
  let panel = lockedPanelId ? panelStore.getPanel(lockedPanelId) : null

  if (!panel) {
    const activeTab = tabStore.activeTab
    if (activeTab?.type === 'terminal' || activeTab?.type === 'settings') {
      panel = panelStore.getPanel(activeTab.panelId)
    } else if (activeTab?.type === 'workspace' && activeTab.activePanelId) {
      panel = panelStore.getPanel(activeTab.activePanelId)
    }
  }

  if (!panel || !panel.sessionId) {
    throw new Error('No active terminal session')
  }

  const sessionId = panel.sessionId
  const marker = `__AI_WAIT_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`

  // Send a lightweight marker command that will only execute when the
  // shell prompt returns (i.e. the currently running command has finished).
  // Use \n to queue it after the running command.
  const shellPath = panel.config?.shellPath
  const lowerShell = (shellPath || '').toLowerCase()
  let markerCmd: string
  if (lowerShell.includes('powershell') || lowerShell.includes('pwsh')) {
    markerCmd = `Write-Output "${marker}"`
  } else if (lowerShell.includes('cmd')) {
    markerCmd = `echo ${marker}`
  } else {
    markerCmd = `echo "${marker}"`
  }
  await SessionWrite(sessionId, markerCmd + '\n')

  const { promise } = watchOutput(sessionId, marker, timeoutMs)
  const result = await promise

  if (result.timedOut) {
    return {
      output: result.output
        + `\n\n⚠️ Still waiting after ${timeoutMs / 1000}s.`
        + ` The command may still be running or stuck.`
        + `\n- Use interrupt_command to cancel, or wait_for_output again to keep waiting.`,
      exitCode: -1,
    }
  }

  return { output: result.output, exitCode: 0 }
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/services/terminalAgent.ts
git commit -m "feat(ai): add waitForOutput for long-running commands"
```

---

### Task 3: Add `sendTerminalKey` function

**Files:**
- Modify: `frontend/src/services/terminalAgent.ts`

**Background:** This sends raw input (text or control characters) to the terminal WITHOUT waiting for a marker. The AI uses this to respond to interactive prompts. After sending, it watches for a brief moment to capture any immediate response.

- [ ] **Step 1: Add `sendTerminalKey` function**

Add after `waitForOutput` in `frontend/src/services/terminalAgent.ts`:

```typescript
export interface SendKeyResult {
  output: string
}

export async function sendTerminalKey(
  input?: string,
  control?: 'ctrl_c' | 'ctrl_d' | 'enter'
): Promise<SendKeyResult> {
  const tabStore = useTabStore()
  const panelStore = usePanelStore()

  const lockedPanelId = tabStore.getAILockedPanel()
  let panel = lockedPanelId ? panelStore.getPanel(lockedPanelId) : null

  if (!panel) {
    const activeTab = tabStore.activeTab
    if (activeTab?.type === 'terminal' || activeTab?.type === 'settings') {
      panel = panelStore.getPanel(activeTab.panelId)
    } else if (activeTab?.type === 'workspace' && activeTab.activePanelId) {
      panel = panelStore.getPanel(activeTab.activePanelId)
    }
  }

  if (!panel || !panel.sessionId) {
    throw new Error('No active terminal session')
  }

  const sessionId = panel.sessionId

  // Resolve control character
  let data: string
  if (control === 'ctrl_c') {
    data = '\x03'
  } else if (control === 'ctrl_d') {
    data = '\x04'
  } else if (control === 'enter') {
    data = '\n'
  } else if (input !== undefined) {
    data = input
  } else {
    throw new Error('Either input or control must be provided')
  }

  await SessionWrite(sessionId, data)

  // Brief wait to capture any immediate response (e.g., password acceptance,
  // command output after the input is consumed)
  const marker = `__AI_KEY_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`
  const shellPath = panel.config?.shellPath
  const lowerShell = (shellPath || '').toLowerCase()
  let markerCmd: string
  if (lowerShell.includes('powershell') || lowerShell.includes('pwsh')) {
    markerCmd = `Write-Output "${marker}"`
  } else if (lowerShell.includes('cmd')) {
    markerCmd = `echo ${marker}`
  } else {
    markerCmd = `echo "${marker}"`
  }
  await SessionWrite(sessionId, markerCmd + '\n')

  // Short timeout: we only want to capture immediate reaction, not wait for
  // the next long-running command to finish.
  const { promise } = watchOutput(sessionId, marker, 5000)
  const result = await promise

  return { output: result.output }
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/services/terminalAgent.ts
git commit -m "feat(ai): add sendTerminalKey for interactive terminal input"
```

---

### Task 4: Add new tool definitions

**Files:**
- Modify: `frontend/src/services/llm.ts`

**Background:** Three new tools need to be registered so the LLM API knows about them. Also update the `execute_command` schema to include the new `timeout` parameter.

- [ ] **Step 1: Update `AVAILABLE_TOOLS`**

Replace the current `AVAILABLE_TOOLS` array (lines 101-121) in `frontend/src/services/llm.ts`. Keep the existing `execute_command` tool but add `timeout` to its properties. Add the three new tools.

```typescript
export const AVAILABLE_TOOLS = [
  {
    name: 'execute_command',
    description: 'Execute a shell command in the active terminal session and return its output. You MUST classify every command with a risk level. Use "timeout" to control how long to wait — short commands need less time, long tasks (builds, installs) need more.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute. Use syntax appropriate for the current shell (provided in context).'
        },
        risk: {
          type: 'string',
          enum: ['read', 'write', 'dangerous'],
          description: 'The risk level of this command:\n- "read": only inspects/views data, absolutely no modifications (e.g. ls, cat, grep, head, tail, df, du, ps, top, find, pwd, whoami, git status, git log, docker ps, npm list)\n- "write": modifies or creates data but not system-destructive (e.g. echo > file, touch, mkdir, cp, mv, git commit, curl POST, npm install, pip install)\n- "dangerous": potentially destructive or system-altering (e.g. rm, > overwrite, chmod, chown, shutdown, mkfs, dd, reboot, force push)'
        },
        timeout: {
          type: 'number',
          description: 'Maximum seconds to wait for command completion. Default 60s. Use 5-10s for quick commands (ls, cat, pwd), 30-60s for moderate tasks, 120-300s for long tasks (npm install, docker build, git clone). NEVER set below 5s.'
        }
      },
      required: ['command', 'risk']
    }
  },
  {
    name: 'wait_for_output',
    description: 'Wait for the currently running command to finish WITHOUT sending a new command. Use this when execute_command timed out but you can see the command is still making progress (building, downloading, compiling). You can call this repeatedly to wait in stages.',
    input_schema: {
      type: 'object',
      properties: {
        timeout: {
          type: 'number',
          description: 'Maximum seconds to wait. Default 30s. Use 15-30s for active progress checks, 60-120s for slower operations.'
        }
      }
    }
  },
  {
    name: 'send_terminal_key',
    description: 'Send text input or a control character to the active terminal. Use this to respond to interactive prompts (password, yes/no, confirmation) or to press Enter. IMPORTANT: only use this when you can SEE a prompt in the terminal output — never guess that a prompt is there.',
    input_schema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Text to send to the terminal (e.g., a password, "y" for confirmation, or an empty string to just press Enter).'
        },
        control: {
          type: 'string',
          enum: ['ctrl_c', 'ctrl_d', 'enter'],
          description: 'Send a control character instead of text. "ctrl_c" interrupts/cancels the running command. "ctrl_d" sends EOF. "enter" sends a newline.'
        }
      },
    }
  },
  {
    name: 'interrupt_command',
    description: 'Send Ctrl+C to cancel the currently running command. Use this when a command is stuck, hanging, or you realize it needs to be stopped. After interrupting, you can send a new command.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  }
]
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/services/llm.ts
git commit -m "feat(ai): add wait_for_output, send_terminal_key, interrupt_command tool definitions"
```

---

### Task 5: Handle new tool calls in agent loop

**Files:**
- Modify: `frontend/src/services/agent.ts`

**Background:** `runAgent()` currently only handles `execute_command` tool calls. We need to add handlers for the three new tools. Import the new functions, then add `if` branches after the existing `execute_command` handler.

- [ ] **Step 1: Update imports**

In `frontend/src/services/agent.ts`, change line 2:

```typescript
// Before:
import { executeCommand } from './terminalAgent'

// After:
import { executeCommand, waitForOutput, sendTerminalKey } from './terminalAgent'
```

- [ ] **Step 2: Add tool handlers in the agent loop**

In `frontend/src/services/agent.ts`, after the `if (tu.name === 'execute_command')` block (after line 379), add handlers for the new tools. Insert the new code between the closing `}` of the `execute_command` block and the closing `}` of the `if (toolUses.length === 0)` block.

Locate this structure around lines 336-379:

```typescript
    // Process exactly one tool call
    const tu = toolUses[0]
    if (tu.name === 'execute_command') {
      // ... existing handler ...
    }
  }  // <-- end of while loop
```

And expand to:

```typescript
    // Process exactly one tool call
    const tu = toolUses[0]
    if (tu.name === 'execute_command') {
      const command = tu.input.command as string
      const timeoutSec = (tu.input.timeout as number) || 60
      const timeoutMs = Math.max(5000, Math.min(timeoutSec * 1000, 300000)) // clamp 5s–300s

      const risk = getRisk(tu)

      if (shouldConfirm(risk)) {
        store.setPendingCommand({
          messageId: assistantMsg.id,
          toolId: tu.id,
          command,
          risk,
          dangerous: risk === 'dangerous'
        })
        assistantMsg.tool_calls = [{
          id: tu.id,
          type: 'function' as const,
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input)
          }
        }]
        store.isRunning = false
        cleanupStreamListeners()
        return
      }

      // Auto-execute
      try {
        const result = await executeCommand(command, timeoutMs)
        store.addMessage({
          id: `msg-${Date.now()}`,
          role: 'tool',
          content: result.output,
          tool_call_id: tu.id
        })
      } catch (e: any) {
        store.addMessage({
          id: `msg-${Date.now()}`,
          role: 'tool',
          content: `[Error executing command: ${e.message ?? e}]`,
          tool_call_id: tu.id
        })
      }
    } else if (tu.name === 'wait_for_output') {
      const timeoutSec = (tu.input.timeout as number) || 30
      const timeoutMs = Math.max(5000, Math.min(timeoutSec * 1000, 300000))

      try {
        const result = await waitForOutput(timeoutMs)
        store.addMessage({
          id: `msg-${Date.now()}`,
          role: 'tool',
          content: result.output,
          tool_call_id: tu.id
        })
      } catch (e: any) {
        store.addMessage({
          id: `msg-${Date.now()}`,
          role: 'tool',
          content: `[Error waiting for output: ${e.message ?? e}]`,
          tool_call_id: tu.id
        })
      }
    } else if (tu.name === 'send_terminal_key') {
      const input = tu.input.input as string | undefined
      const control = tu.input.control as string | undefined

      try {
        const result = await sendTerminalKey(
          input,
          control as 'ctrl_c' | 'ctrl_d' | 'enter' | undefined
        )
        store.addMessage({
          id: `msg-${Date.now()}`,
          role: 'tool',
          content: result.output || '(input sent)',
          tool_call_id: tu.id
        })
      } catch (e: any) {
        store.addMessage({
          id: `msg-${Date.now()}`,
          role: 'tool',
          content: `[Error sending terminal input: ${e.message ?? e}]`,
          tool_call_id: tu.id
        })
      }
    } else if (tu.name === 'interrupt_command') {
      try {
        const result = await sendTerminalKey(undefined, 'ctrl_c')
        store.addMessage({
          id: `msg-${Date.now()}`,
          role: 'tool',
          content: result.output || 'Sent Ctrl+C to interrupt the running command.',
          tool_call_id: tu.id
        })
      } catch (e: any) {
        store.addMessage({
          id: `msg-${Date.now()}`,
          role: 'tool',
          content: `[Error sending Ctrl+C: ${e.message ?? e}]`,
          tool_call_id: tu.id
        })
      }
    }
  }
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/services/agent.ts
git commit -m "feat(ai): handle wait_for_output, send_terminal_key, interrupt_command in agent loop"
```

---

### Task 6: Update system prompt

**Files:**
- Modify: `frontend/src/stores/aiStore.ts`

**Background:** The system prompt tells the AI how to use its tools. Update it to document the new tools and describe the correct workflow for interactive prompts and long-running commands.

- [ ] **Step 1: Replace SYSTEM_RULES**

Replace lines 48-77 in `frontend/src/stores/aiStore.ts`:

```typescript
const SYSTEM_RULES = `You are an AI assistant inside uniTerm, a terminal emulator. You can execute shell commands in the user's active terminal to help them complete tasks.

AVAILABLE TOOLS:
1. execute_command — Run a shell command and wait for its output. Set timeout based on expected duration.
2. wait_for_output — Continue waiting for the currently running command. Use when a previous command timed out but you see it's still making progress.
3. send_terminal_key — Send text or control keys to the terminal. Use ONLY when you can SEE an interactive prompt in the output.
4. interrupt_command — Send Ctrl+C to cancel the running command.

CRITICAL RULES:
- You can only send ONE tool call at a time. Never send multiple tool calls in a single response.
- Always explain what you are about to do before executing commands.
- If a command might be destructive, warn the user.

TIMEOUT GUIDELINES:
- Quick commands (ls, cat, pwd, whoami): timeout=10
- Normal commands (grep, find, df, systemctl status): timeout=30
- Moderate tasks (package install, git clone shallow): timeout=120
- Long tasks (full build, docker build, large download): timeout=300
- NEVER use timeout below 5 seconds.

HANDLING TIMEOUTS:
When execute_command times out, read the output carefully:
- If output shows a prompt (password, y/n, [sudo], "Are you sure?"): use send_terminal_key to respond.
- If output shows progress (percentage, compiling, downloading): use wait_for_output to keep waiting.
- If output is empty or shows an error: the command may be stuck. Use interrupt_command, then reassess.
- NEVER re-send the same command after a timeout — this causes duplicate commands to pile up.

INTERACTIVE PROMPTS:
When you see a password prompt: ask the user for the password, then use send_terminal_key.
When you see y/n or confirmation: use send_terminal_key with input: "y" or "n".
When you see a pager (less/more): use send_terminal_key with control: "ctrl_c" to exit the pager.

SHELL AWARENESS:
- At the START of EVERY response, read the shell/panel context in the user's message. IGNORE any memory of what the previous shell was — only the latest context matters.
- The user may switch terminal tabs at any time. Each terminal is an independent environment. ALWAYS reassess before proceeding.
- When the terminal type changes, switch to the NEW shell's command syntax immediately. NEVER mix commands from different shell types.
- Do NOT invoke a different shell executable from within the current terminal. ALWAYS use the native syntax of the CURRENT shell only.

RISK CLASSIFICATION:
Every execute_command call MUST include a "risk" field:
- "read": only inspects/views data, no modifications at all
- "write": modifies or creates data, but not system-destructive
- "dangerous": potentially destructive or system-altering
For chained commands, classify based on the MOST risky operation in the chain.

--- NEGATIVE EXAMPLES (STRICTLY FORBIDDEN) ---
❌ In Git Bash, do NOT run: Get-CimInstance Win32_LogicalDisk
❌ In PowerShell, do NOT run: ls -la /mnt/c/
❌ In CMD, do NOT run: df -h
❌ In Git Bash, do NOT run: powershell.exe -Command "..."
❌ In PowerShell, do NOT run: bash -c "..."
Use ONLY the current shell's native syntax.`
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/stores/aiStore.ts
git commit -m "feat(ai): update system prompt with new tools and timeout guidelines"
```

---

### Task 7: Build, test, and final commit

**Files:**
- None (build verification)

- [ ] **Step 1: Clean build the frontend**

```bash
cd frontend
rm -rf dist node_modules/.vite .vite
npm run build
```

Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 2: Start the app and smoke test**

```bash
cd ..
wails dev
```

Smoke test:
1. Open AI sidebar, send a message like "run ls"
2. Verify the AI uses `execute_command` with a `timeout` parameter
3. Verify the output is returned correctly

- [ ] **Step 3: Final commit (if any fixes)**

```bash
git add -A
git commit -m "chore: build verification after AI command timeout feature"
```

---

## Self-Review

**1. Spec coverage:**
- ✅ `execute_command` with configurable `timeout` — Task 1, Step 2
- ✅ `wait_for_output` — Task 2
- ✅ `send_terminal_key` — Task 3
- ✅ `interrupt_command` — Task 3 (reuses `sendTerminalKey`), Task 4 (tool def), Task 5 (handler)
- ✅ System prompt update — Task 6
- ✅ AI timeout guidance — Task 6 (TIMEOUT GUIDELINES, HANDLING TIMEOUTS sections)

**2. Placeholder scan:** No TBD, TODO, or vague instructions. All code is concrete.

**3. Type consistency:**
- `watchOutput` returns `{ promise, cleanup }` with `WatchResult` type — used by `execute_command` (Task 1), `wait_for_output` (Task 2), `send_terminal_key` (Task 3)
- `sendTerminalKey` signature `(input?: string, control?: 'ctrl_c' | 'ctrl_d' | 'enter')` — matches import in Task 5
- `waitForOutput` signature `(timeoutMs: number)` — matches import in Task 5
- All tool input schemas (Task 4) match the `tu.input` property accesses in Task 5
- `AVAILABLE_TOOLS` export used in `agent.ts` line 1 — unchanged import path
