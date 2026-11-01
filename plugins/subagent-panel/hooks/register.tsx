import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, RenderInput, Timer } from 'claude-code'

import type { AgentRow, Estimate, Step, TypeHistory } from '../types'
import { addRun, estimate, formatDuration } from './estimate'
import { POSE_LABEL, clipColumns, poseOf } from './activity'
import { describeCall } from './humanize'

const PANE = 'subagents'
const TITLE = 'Subagents'
const STORE_PLAN_MODE = 'isPlanMode'
const MAX_AGENTS = 30
const MAX_CALLS = 1000

// shape 標籤：AgentRow 欄位改變時要換，才不會讀到舊版存下的值
const agents = atom({ plugin: 'subagent-panel', key: 'agents' } as const, [], {
  shape: 'agents-2',
})
const folded = atom({ plugin: 'subagent-panel', key: 'folded' } as const, [])
const openSteps = atom({ plugin: 'subagent-panel', key: 'openSteps' } as const, [])
const removed = atom({ plugin: 'subagent-panel', key: 'removed' } as const, [])
const isHidden = atom({ plugin: 'subagent-panel', key: 'isHidden' } as const, false)
const isBandMode = atom({ plugin: 'subagent-panel', key: 'isBandMode' } as const, false)
const isCollapsed = atom({ plugin: 'subagent-panel', key: 'isCollapsed' } as const, false)
const isPlanMode = atom({ plugin: 'subagent-panel', key: 'isPlanMode' } as const, true)

const estimates = atom({ plugin: 'subagent-panel', key: 'estimates' } as const, {}, {
  shape: 'estimates-1',
})

const ESTIMATE_MS = 60_000

function historyKey(type: string): string {
  return `history:${type}`
}

async function historyOf($: EngineInterface, type: string): Promise<TypeHistory | undefined> {
  const saved = await $.store.get(historyKey(type))
  if (typeof saved !== 'object' || saved === null) {
    return undefined
  }
  const value = saved as Partial<TypeHistory>
  return typeof value.runs === 'number' && typeof value.avgSteps === 'number' && typeof value.avgMs === 'number'
    ? { runs: value.runs, avgSteps: value.avgSteps, avgMs: value.avgMs }
    : undefined
}

/** 重新估算所有執行中 subagent 的進度與剩餘時間 */
async function refreshEstimates($: EngineInterface): Promise<void> {
  const list = await read($, agents)
  const now = await $.clock.now()
  const next: Record<string, Estimate> = {}
  for (const row of list) {
    if (row.status === 'running') {
      next[row.id] = estimate(row, await historyOf($, row.type), now)
    }
  }
  await update($, estimates, current => {
    const kept: Record<string, Estimate> = {}
    for (const [id, value] of Object.entries(current)) {
      if (list.some(row => row.id === id && row.status !== 'running')) {
        kept[id] = value
      }
    }
    return { ...kept, ...next }
  })
}

// 計時器：每分鐘重算剩餘時間；有 agent 在跑才開，全部結束就停
let ticker: Timer | undefined

function startTicker($: EngineInterface): void {
  if (ticker !== undefined) {
    return
  }
  ticker = $.clock.every(ESTIMATE_MS, () => {
    void tick($)
  })
}

async function tick($: EngineInterface): Promise<void> {
  const list = await read($, agents)
  if (!list.some(row => row.status === 'running')) {
    ticker?.cancel()
    ticker = undefined
    return
  }
  await refreshEstimates($)
}

// mod 自己提供給 subagent 回報進度的兩個工具
const PLAN_TOOL = 'mcp__subagent-panel__plan_steps'
const STEP_TOOL = 'mcp__subagent-panel__step_status'

const PLAN_INSTRUCTION =
  `\n\n（進度回報：開始動手前，先呼叫 ${PLAN_TOOL} 列出你預計的步驟；` +
  `每開始一步就用 ${STEP_TOOL} 標成 in_progress，做完標成 completed。` +
  `這兩個工具若沒列在你的工具清單裡，先用 ToolSearch 查 "select:${PLAN_TOOL},${STEP_TOOL}"；` +
  '真的沒有的話，改用 TaskCreate／TaskUpdate 或 TodoWrite；都沒有就直接做。' +
  '步驟描述請用一般人看得懂的白話（例如「查詢使用者資料表的欄位」「跑後端單元測試」），不要寫指令；' +
  '呼叫 Bash／PowerShell 時，description 參數也請用一句繁體中文白話說明這個指令在做什麼。）'

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

/** 清除一個 subagent：整塊執行過程與估算都拿掉，之後的事件也不再加回來 */
async function removeAgent($: EngineInterface, agentId: string): Promise<void> {
  await update($, removed, ids => (ids.includes(agentId) ? ids : [...ids, agentId].slice(-200)))
  await update($, agents, list => list.filter(row => row.id !== agentId))
  await update($, estimates, current => {
    const kept = { ...current }
    delete kept[agentId]
    return kept
  })
  await update($, folded, ids => ids.filter(id => id !== agentId))
  await update($, openSteps, keys => keys.filter(key => !key.startsWith(`${agentId}:`)))
}

function patch(list: AgentRow[], id: string, change: (row: AgentRow) => AgentRow): AgentRow[] {
  return list.map(row => (row.id === id ? change(row) : row))
}

/** 遇到還沒登記的 subagent（例如沒經過 agent.spawn hook 的）就從 $.agent.list() 補上 */
async function ensureAgent($: EngineInterface, agentId: string, model?: string): Promise<void> {
  const list = await read($, agents)
  if (list.some(row => row.id === agentId) || (await read($, removed)).includes(agentId)) {
    return
  }
  const info = (await $.agent.list()).find(one => one.id === agentId)
  if (info === undefined) {
    return // 不是列表上的 agent（workflow、壓縮等內部 fork），不顯示
  }
  const now = await $.clock.now()
  await update($, agents, current =>
    current.some(row => row.id === agentId)
      ? current
      : [
          ...current,
          {
            id: agentId,
            description: info.description || info.name || info.type,
            type: info.type,
            model: model ?? '?',
            status: 'running' as const,
            startedAt: now,
            calls: [],
            plan: null,
          },
        ].slice(-MAX_AGENTS),
  )
  startTicker($)
  await refreshEstimates($)
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/\[.*\]$/, '')
}

function progressOf(row: AgentRow): string {
  if (row.plan !== null && row.plan.length > 0) {
    const done = row.plan.filter(step => step.state === 'done').length
    const at = row.plan.findIndex(step => step.state === 'current')
    const position = at >= 0 ? at + 1 : done
    return `步驟 ${position}/${row.plan.length}`
  }
  const count = row.calls.length
  if (row.status === 'running') {
    return count === 0 ? '準備中' : `第 ${count} 步（總數未定）`
  }
  return `共 ${count} 步`
}

function seconds(row: AgentRow): string {
  if (row.endedAt === undefined) {
    return ''
  }
  return ` · ${Math.max(0, Math.round((row.endedAt - row.startedAt) / 1000))}s`
}

/** 顯示面板：先試側邊欄；終端機太窄擺不出來時，改畫在輸入框上方 */
async function show($: EngineInterface): Promise<void> {
  const wasHidden = await read($, isHidden)
  await update($, isHidden, () => false)
  // 從窄邊展開：一樣先關再開，寬度才會恢復
  if (wasHidden && (await $.ui.panes()).some(pane => pane.id === PANE)) {
    await $.ui.close({ id: PANE })
  }
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  await update($, isBandMode, () => !opened.isPlaced)
}

/** 縮成窄邊時側邊欄的寬度（引擎最少給 24 欄） */
const MINI_COLUMNS = 24

/**
 * 隱藏：側邊欄還擺得出來時縮成一條窄邊，只留「展開」按鈕；
 * 畫在輸入框上方時，收成一列按鈕。下一個 subagent 被呼叫時自動展開。
 */
async function hide($: EngineInterface): Promise<void> {
  await update($, isHidden, () => true)
  if (await read($, isBandMode)) {
    await $.ui.close({ id: PANE })
    return
  }
  // 已開著的側邊欄再 open 只會改標題、不會改寬度，所以先關再用窄寬度重開
  await $.ui.close({ id: PANE })
  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: MINI_COLUMNS })
  if (!opened.isPlaced) {
    await update($, isBandMode, () => true)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'subagents',
      description: '開啟 subagent 面板（加 clear 可清空已完成的）',
    })
    const saved = await $.store.get(STORE_PLAN_MODE)
    // 預設開啟；只有使用者按過關閉（存成 false）才關
    await update($, isPlanMode, () => saved !== false)

    await $.tool.register({
      name: 'plan_steps',
      description:
        '只給 subagent 用：開始工作前列出你預計的步驟，讓使用者在面板上看到總步驟數與進度。' +
        '再呼叫一次會整個取代舊的計畫。',
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: '依序列出每個步驟，各用一句簡短描述',
          },
        },
        required: ['steps'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'step_status',
      description: '只給 subagent 用：回報某個步驟開始（in_progress）或完成（completed）。step 從 1 開始，對應 plan_steps 的順序。',
      inputSchema: {
        type: 'object',
        properties: {
          step: { type: 'integer', minimum: 1 },
          status: { type: 'string', enum: ['in_progress', 'completed'] },
        },
        required: ['step', 'status'],
      },
      isDeferred: false,
    })

    return next(e)
  })

  on('command.run', { command: 'subagents' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, agents, list => list.filter(row => row.status === 'running'))
      return { text: '已清空結束的 subagent。' }
    }
    await show($)
    return { text: 'Subagent 面板已開啟。' }
  })

  // 1. subagent 誕生：記下任務描述、類型、模型
  on('agent.spawn', async ($, e, next) => {
    const isPlan = (await read($, isPlanMode)) && !e.fork && e.resume === undefined && e.workflow === undefined
    const input = isPlan ? { ...e, prompt: e.prompt + PLAN_INSTRUCTION } : e
    const result = await next(input)

    if (result.agentId !== undefined) {
      const agentId = result.agentId
      const now = await $.clock.now()
      // 被清除過的 subagent 又被叫醒時，重新顯示
      await update($, removed, ids => ids.filter(id => id !== agentId))
      await update($, agents, list => {
        const known = list.find(row => row.id === agentId)
        if (known !== undefined) {
          return patch(list, agentId, row => ({
            ...row,
            description: e.description || row.description,
            type: e.subagentType,
            model: result.model,
            status: 'running',
            endedAt: undefined,
          }))
        }
        const row: AgentRow = {
          id: agentId,
          description: e.description || e.name || e.subagentType,
          type: e.subagentType,
          model: result.model,
          status: 'running',
          startedAt: now,
          calls: [],
          plan: null,
        }
        return [...list, row].slice(-MAX_AGENTS)
      })
      startTicker($)
      await refreshEstimates($)
      void show($)
    }

    return result
  })

  // 2. 每次送出模型請求：記下實際使用的模型
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await ensureAgent($, agentId, e.model)
      await update($, agents, list => patch(list, agentId, row => ({ ...row, model: e.model })))
    }
    return yield* next(e)
  })

  // 3. 每次工具呼叫：算一步；TodoWrite／TaskCreate／TaskUpdate 則是 subagent 自己的計畫
  on('tool.call', async ($, e, next) => {
    // mod 自己的進度工具：直接回答，不交給引擎
    if (e.tool === PLAN_TOOL || e.tool === STEP_TOOL) {
      const args = e as unknown as Record<string, unknown>
      if (e.agentId === undefined) {
        return { result: '這個工具只給 subagent 回報進度用，主對話不需要呼叫。' }
      }
      const agentId = e.agentId
      await ensureAgent($, agentId)

      if (e.tool === PLAN_TOOL) {
        const steps = Array.isArray(args.steps) ? args.steps.filter((one): one is string => typeof one === 'string') : []
        if (steps.length === 0) {
          return { result: 'steps 不能是空的。' }
        }
        const plan: Step[] = steps.map(label => ({ label: clip(label, 80), state: 'pending' }))
        await update($, agents, list => patch(list, agentId, row => ({ ...row, plan })))
        await refreshEstimates($)
        return { result: `已記錄 ${steps.length} 個步驟。開始每一步時用 step_status 回報。` }
      }

      const index = typeof args.step === 'number' ? Math.floor(args.step) - 1 : -1
      const state: Step['state'] = args.status === 'completed' ? 'done' : 'current'
      let isKnown = false
      await update($, agents, list =>
        patch(list, agentId, row => {
          if (row.plan === null || index < 0 || index >= row.plan.length) {
            return row
          }
          isKnown = true
          return { ...row, plan: row.plan.map((one, at) => (at === index ? { ...one, state } : one)) }
        }),
      )
      if (!isKnown) {
        return { result: '找不到這個步驟：請先用 plan_steps 列出步驟，step 從 1 開始。' }
      }
      await refreshEstimates($)
      return { result: 'ok' }
    }

    if (e.agentId === undefined) {
      return next(e) // 主迴圈的呼叫不管
    }
    const agentId = e.agentId
    await ensureAgent($, agentId)

    if (e.tool === 'TodoWrite') {
      const plan: Step[] = e.todos.map(todo => ({
        label: clip(todo.status === 'in_progress' ? todo.activeForm || todo.content : todo.content, 80),
        state: todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'current' : 'pending',
      }))
      await update($, agents, list => patch(list, agentId, row => ({ ...row, plan })))
      await refreshEstimates($)
      return next(e)
    }

    // TaskCreate：新增一個計畫步驟（任務 id 要等工具回傳才知道）
    if (e.tool === 'TaskCreate') {
      const ran = await next(e)
      if (ran.result !== undefined && !ran.isError) {
        const task: Step = {
          id: ran.result.task.id,
          label: clip(e.subject, 80),
          active: e.activeForm === undefined ? undefined : clip(e.activeForm, 80),
          state: 'pending',
        }
        await update($, agents, list => patch(list, agentId, row => ({ ...row, plan: [...(row.plan ?? []), task] })))
        await refreshEstimates($)
      }
      return ran
    }

    // TaskUpdate：改計畫步驟的狀態或標題
    if (e.tool === 'TaskUpdate') {
      const ran = await next(e)
      if (ran.result !== undefined && !ran.isError) {
        await update($, agents, list =>
          patch(list, agentId, row => {
            if (row.plan === null) {
              return row
            }
            const plan = row.plan
              .filter(one => !(one.id === e.taskId && e.status === 'deleted'))
              .map(one => {
                if (one.id !== e.taskId) {
                  return one
                }
                const state: Step['state'] =
                  e.status === 'completed'
                    ? 'done'
                    : e.status === 'in_progress'
                      ? 'current'
                      : e.status === 'pending'
                        ? 'pending'
                        : one.state
                return {
                  ...one,
                  label: e.subject === undefined ? one.label : clip(e.subject, 80),
                  active: e.activeForm === undefined ? one.active : clip(e.activeForm, 80),
                  state,
                }
              })
            return { ...row, plan }
          }),
        )
        await refreshEstimates($)
      }
      return ran
    }

    if ((await read($, removed)).includes(agentId)) {
      return next(e)
    }
    const described = describeCall(e)
    const owner = (await read($, agents)).find(row => row.id === agentId)
    const planAt = owner?.plan?.findIndex(one => one.state === 'current') ?? -1
    const step: Step = {
      id: e.tool_use_id,
      label: clip(described.label, 80),
      tool: e.tool,
      detail: described.detail.slice(0, 2000),
      state: 'current',
      plan: planAt >= 0 ? planAt : undefined,
    }
    await update($, agents, list =>
      patch(list, agentId, row => ({ ...row, calls: [...row.calls, step].slice(-MAX_CALLS) })),
    )
    try {
      return await next(e)
    } finally {
      await update($, agents, list =>
        patch(list, agentId, row => ({
          ...row,
          calls: row.calls.map(one => (one.id === step.id ? { ...one, state: 'done' as const } : one)),
        })),
      )
      // 還沒有剩餘時間時，每做完一步就試著估第一次；之後交給每分鐘的計時器
      const guess = (await read($, estimates))[agentId]
      if (guess === undefined || guess.remainingMs === null) {
        await refreshEstimates($)
      }
    }
  })

  // 4. subagent 結束
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      const now = await $.clock.now()
      const info = (await $.agent.list()).find(one => one.id === agentId)
      const status = e.isAborted ? 'aborted' : info?.status === 'failed' ? 'failed' : 'done'
      await update($, agents, list =>
        patch(list, agentId, row => ({
          ...row,
          status,
          endedAt: now,
          calls: row.calls.map(step => (step.state === 'current' ? { ...step, state: 'done' as const } : step)),
        })),
      )
      const row = (await read($, agents)).find(one => one.id === agentId)
      if (row !== undefined) {
        // 正常完成的才記進歷史，讓之後同類型的估算更準
        if (status === 'done') {
          const steps = row.plan !== null && row.plan.length > 0 ? row.plan.length : row.calls.length
          await $.store.set(historyKey(row.type), addRun(await historyOf($, row.type), steps, now - row.startedAt))
        }
        await update($, estimates, current => ({ ...current, [agentId]: estimate(row, undefined, now) }))
      }
    }
    return next(e)
  })


  // 5. 使用者自己按掉側邊欄 = 隱藏
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      await update($, isHidden, () => true)
      await update($, isBandMode, () => false)
    }
    return next(e)
  })

  // 6a. 側邊欄（全螢幕版面且夠寬時停靠在對話旁邊，否則在輸入框上方）
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)

    // 縮成窄邊：只留展開按鈕和數量
    if (await read($, isHidden)) {
      const list = await read($, agents)
      const running = list.filter(row => row.status === 'running').length
      return (
        <Box flexDirection="column">
          <Button key="reopen" variant="primary" label="◂ 展開" onPress={() => show($)} />
          <Text bold> Subagents</Text>
          <Text color={running > 0 ? 'warning' : 'subtle'}> ● {running} 執行中</Text>
          <Text dimColor> ✔ {list.length - running} 已結束</Text>
        </Box>
      )
    }

    const width = Math.max(20, e.props.bodyColumns - 2) // 右邊留一欄給捲軸
    const lines = await bodyLines($, e, width)
    const total = lines.reduce((sum, line) => sum + line.height, 0)
    const { offset, bodyRows } = e.props.scroll

    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        {lines.map(line => line.node)}
        {total > bodyRows && bodyRows > 0 && (
          <Box
            key="scrollbar"
            position="absolute"
            top={Math.min(offset, Math.max(0, total - bodyRows))}
            left={e.props.bodyColumns - 1}
            width={1}
            height={bodyRows}
            flexDirection="column"
          >
            {scrollbar(total, bodyRows, offset).map(isThumb =>
              isThumb ? <Text color="claude">█</Text> : <Text dimColor>│</Text>,
            )}
          </Box>
        )}
      </Box>
    )
  })

  // 6b. 側邊欄擺不出來時，畫在輸入框上方（任何寬度都會顯示，太高時可用滾輪捲動）
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    // 側邊欄被關掉、或擺不出來時隱藏：留一列按鈕在輸入框上方，按一下就把面板叫回來
    const isDocked = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
    if ((await read($, isHidden)) && !isDocked) {
      const { Box, Button, Text } = $.ui.resolve(e)
      const list = await read($, agents)
      const running = list.filter(row => row.status === 'running').length
      return (
        <Box key="reopen-row" flexDirection="row" height={1} overflow="hidden">
          <Button key="reopen" plain onPress={() => show($)}>
            <Text color="claude">▸ 顯示 Subagent 面板</Text>
            <Text dimColor>
              {' '}
              {running} 執行中 · {list.length - running} 已結束
            </Text>
          </Button>
        </Box>
      )
    }
    if (!(await read($, isBandMode))) {
      return next(e)
    }
    const { Box } = $.ui.resolve(e)
    const lines = await bodyLines($, e, Math.max(20, e.props.bodyColumns))
    return <Box flexDirection="column">{lines.map(line => line.node)}</Box>
  })
}

/** 捲軸：每一列是否為滑塊 */
function scrollbar(total: number, window: number, offset: number): boolean[] {
  const thumb = Math.max(1, Math.round((window * window) / total))
  const maxOffset = Math.max(1, total - window)
  const start = Math.round((Math.min(offset, maxOffset) / maxOffset) * (window - thumb))
  return Array.from({ length: window }, (_, at) => at >= start && at < start + thumb)
}

/** 0–1 的進度：有計畫看計畫，否則看最近一次估算；結束了就是 1 */
function progressFraction(row: AgentRow, guess: Estimate | undefined): number {
  if (row.status === 'done') {
    return 1
  }
  if (row.plan !== null && row.plan.length > 0) {
    const done = row.plan.filter(step => step.state === 'done').length
    const current = row.plan.some(step => step.state === 'current') ? 0.5 : 0
    return Math.min(1, (done + current) / row.plan.length)
  }
  return guess?.progress ?? 0
}

/** 進度條右邊的文字 */
function etaText(row: AgentRow, guess: Estimate | undefined): string {
  if (row.status !== 'running') {
    const used = row.endedAt !== undefined ? formatDuration(row.endedAt - row.startedAt) : '?'
    return row.status === 'done' ? `用時 ${used}` : `已中斷 · 用時 ${used}`
  }
  if (guess === undefined || guess.remainingMs === null) {
    return '剩餘時間估算中…'
  }
  return `剩約 ${formatDuration(guess.remainingMs)}`
}

function basisText(guess: Estimate | undefined): string {
  if (guess === undefined || guess.remainingMs === null) {
    return ''
  }
  return guess.basis === 'plan' ? '依計畫' : guess.basis === 'history' ? '依過去紀錄' : '粗估'
}

const STATUS_LOOK = {
  running: { icon: '●', color: 'warning' },
  done: { icon: '✓', color: 'success' },
  failed: { icon: '✗', color: 'error' },
  aborted: { icon: '✗', color: 'error' },
} as const

type Line = { node: RenderChildren; height: number }

/**
 * 面板內容，切成一列一列（每個 node 的高度已知），
 * 側邊欄才能算出總高度畫捲軸。
 */
async function bodyLines(
  $: EngineInterface,
  e: RenderInput<'Pane' | 'AbovePrompt'>,
  width: number,
): Promise<Line[]> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const list = await read($, agents)
  const foldedIds = await read($, folded)
  const collapsed = await read($, isCollapsed)
  const planMode = await read($, isPlanMode)
  const guesses = await read($, estimates)
  const openKeys = await read($, openSteps)
  const running = list.filter(row => row.status === 'running').length
  const done = list.filter(row => row.status === 'done').length
  const failed = list.length - running - done
  const lines: Line[] = []
  const one = (node: RenderChildren) => lines.push({ node, height: 1 })
  const gap = (key: string) => one(<Box key={key} height={1} />)
  const pad = '  '

  const toggleAll = () => update($, isCollapsed, value => !value)
  const togglePlan = async () => {
    const value = await update($, isPlanMode, current => !current)
    await $.store.set(STORE_PLAN_MODE, value)
  }

  // ── 標題列：名稱 + 三種狀態的數量
  one(
    <Box key="title" height={1} overflow="hidden">
      <Button key="toggle-all" plain onPress={toggleAll}>
        <Text dimColor>{collapsed ? '▸ ' : '▾ '}</Text>
        <Text bold>Subagents</Text>
        <Text>{'   '}</Text>
        <Text color={running > 0 ? 'warning' : 'subtle'}>● {running} 執行中</Text>
        <Text>{'  '}</Text>
        <Text color={done > 0 ? 'success' : 'subtle'}>✓ {done} 完成</Text>
        {failed > 0 && <Text>{'  '}</Text>}
        {failed > 0 && <Text color="error">✗ {failed} 中斷</Text>}
      </Button>
    </Box>,
  )
  one(
    <Box key="buttons" height={1} overflow="hidden">
      <Button key="hide" label="隱藏" onPress={() => hide($)} />
      <Text> </Text>
      <Button
        key="plan-mode"
        label={planMode ? '規劃步驟：開' : '規劃步驟：關'}
        variant={planMode ? 'primary' : 'secondary'}
        onPress={togglePlan}
      />
    </Box>,
  )
  one(
    <Text key="rule" color="subtle" wrap="truncate">
      {'─'.repeat(Math.max(10, width))}
    </Text>,
  )

  if (collapsed) {
    return lines
  }

  if (list.length === 0) {
    one(
      <Text key="empty" dimColor>
        {pad}還沒有 subagent。呼叫 subagent 時這裡會自動出現。
      </Text>,
    )
  }

  list
    .slice()
    .reverse()
    .forEach((row, index) => {
      const isOpen = !foldedIds.includes(row.id)
      const toggle = () =>
        update($, folded, ids => (ids.includes(row.id) ? ids.filter(id => id !== row.id) : [...ids, row.id]))
      const look = STATUS_LOOK[row.status]
      const guess = guesses[row.id]

      if (index > 0) {
        gap(`gap-${row.id}`)
      }

      // ── 第一列：狀態圖示 + 任務名稱（點了收合），右邊清除
      one(
        <Box key={`head-${row.id}`} flexDirection="row" height={1} overflow="hidden">
          <Box flexGrow={1} overflow="hidden">
            <Button key={`row-${row.id}`} plain onPress={toggle}>
              <Text color={look.color}>{look.icon}</Text>
              <Text> </Text>
              <Text bold>{clipColumns(row.description, Math.max(8, width - 8))}</Text>
              <Text dimColor>{isOpen ? ' ▾' : ' ▸'}</Text>
            </Button>
          </Box>
          <Button key={`remove-${row.id}`} plain onPress={() => removeAgent($, row.id)}>
            <Text color="subtle">✕</Text>
          </Button>
        </Box>,
      )

      // ── 第二列：類型 · 模型 · 步驟，執行中再加上正在做的事
      const meta = `${row.type} · ${shortModel(row.model)} · ${progressOf(row)}`
      const doing = row.status === 'running' ? POSE_LABEL[poseOf(row)] : ''
      one(
        <Text key={`meta-${row.id}`} wrap="truncate">
          <Text dimColor>
            {pad}
            {clipColumns(meta, Math.max(8, width - 4 - (doing ? 8 : 0)))}
          </Text>
          {doing && <Text color="claude"> · {doing}</Text>}
        </Text>,
      )

      // ── 第三列：細線進度條 + 百分比 + 剩餘時間
      const fraction = progressFraction(row, guess)
      const barCells = Math.max(8, Math.min(28, width - 26))
      const filled = Math.round(fraction * barCells)
      const barColor = row.status === 'running' ? 'claude' : row.status === 'done' ? 'success' : 'error'
      const basis = row.status === 'running' ? basisText(guess) : ''
      one(
        <Text key={`bar-${row.id}`} wrap="truncate">
          <Text>{pad}</Text>
          <Text color={barColor}>{'━'.repeat(filled)}</Text>
          <Text color="subtle">{'━'.repeat(barCells - filled)}</Text>
          <Text bold> {String(Math.round(fraction * 100)).padStart(3)}%</Text>
          <Text dimColor>
            {'  '}
            {etaText(row, guess)}
          </Text>
          {basis && <Text color="subtle">（{basis}）</Text>}
        </Text>,
      )

      if (!isOpen) {
        return
      }

      // ── 步驟清單：樹狀，目前那步醒目，做完的變淡
      const plan = row.plan !== null && row.plan.length > 0 ? row.plan : null
      if ((plan ?? row.calls).length === 0) {
        one(
          <Text key={`none-${row.id}`} color="subtle">
            {pad}└ 還沒有步驟
          </Text>,
        )
        return
      }

      const stepLine = (step: Step, isLast: boolean, openKey: string, canOpen: boolean, isStepOpen: boolean) => {
        const label = step.state === 'current' && step.active !== undefined ? step.active : step.label
        const mark = step.state === 'current' ? '▶' : step.state === 'done' ? '✓' : '○'
        const markColor = step.state === 'current' ? 'claude' : step.state === 'done' ? 'success' : 'subtle'
        const fold = canOpen ? (isStepOpen ? ' ▴' : ' ▾') : ''
        const text = clipColumns(label, Math.max(8, width - 8 - fold.length))
        const body = (
          <Text wrap="truncate">
            <Text color="subtle">
              {pad}
              {isLast ? '└ ' : '├ '}
            </Text>
            <Text color={markColor}>{mark}</Text>
            <Text> </Text>
            {step.state === 'current' ? (
              <Text color="claude" bold>
                {text}
              </Text>
            ) : step.state === 'done' ? (
              <Text dimColor>{text}</Text>
            ) : (
              <Text>{text}</Text>
            )}
            <Text color="subtle">{fold}</Text>
          </Text>
        )
        const toggleStep = () =>
          update($, openSteps, keys =>
            keys.includes(openKey) ? keys.filter(key => key !== openKey) : [...keys, openKey],
          )
        one(
          <Box key={`line-${openKey}`} height={1} overflow="hidden">
            {canOpen ? (
              <Button key={`step-${openKey}`} plain onPress={toggleStep}>
                {body}
              </Button>
            ) : (
              body
            )}
          </Box>,
        )
      }

      /** 展開的內容前面接一條樹的直線，最後一步則留空 */
      const gutter = (isLast: boolean) => `${pad}${isLast ? ' ' : '│'}   `
      const detailLines = (detail: string, key: string, isLast: boolean, extra: string) => {
        const prefix = gutter(isLast) + extra
        wrapColumns(detail, Math.max(10, width - prefix.length)).forEach((part, at) =>
          one(
            <Text key={`${key}-d${at}`} wrap="truncate">
              <Text color="subtle">{prefix}</Text>
              <Text color="suggestion">{part}</Text>
            </Text>,
          ),
        )
      }

      if (plan !== null) {
        // 有計畫：計畫步驟，點開看這一步實際做了哪些動作與指令
        const groups: Array<{ step: Step; openKey: string; calls: Step[] }> = plan.map((step, at) => ({
          step,
          openKey: `${row.id}:p${at}`,
          calls: row.calls.filter(call => call.plan === at),
        }))
        const loose = row.calls.filter(call => call.plan === undefined)
        if (loose.length > 0) {
          groups.unshift({
            step: { label: `準備動作（${loose.length}）`, state: 'done' },
            openKey: `${row.id}:other`,
            calls: loose,
          })
        }
        groups.forEach((group, at) => {
          const isLast = at === groups.length - 1
          const isStepOpen = openKeys.includes(group.openKey)
          stepLine(group.step, isLast, group.openKey, group.calls.length > 0, isStepOpen)
          if (!isStepOpen) {
            return
          }
          group.calls.forEach((call, callAt) => {
            const key = `${group.openKey}-c${callAt}`
            one(
              <Text key={key} wrap="truncate">
                <Text color="subtle">{gutter(isLast)}</Text>
                <Text color={call.state === 'current' ? 'claude' : 'subtle'}>{call.state === 'current' ? '▶' : '·'}</Text>
                <Text dimColor={call.state === 'done'}> {clipColumns(call.label, Math.max(8, width - 10))}</Text>
              </Text>,
            )
            if (call.detail) {
              detailLines(call.detail, key, isLast, '  ')
            }
          })
        })
      } else {
        // 沒有計畫：每個動作一步，點開看原始指令
        row.calls.forEach((call, at) => {
          const isLast = at === row.calls.length - 1
          const openKey = `${row.id}:c${call.id ?? at}`
          const isStepOpen = openKeys.includes(openKey)
          stepLine(call, isLast, openKey, Boolean(call.detail), isStepOpen)
          if (isStepOpen && call.detail) {
            detailLines(call.detail, openKey, isLast, '')
          }
        })
      }
    })

  return lines
}

function columnsOf(char: string): number {
  return (char.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1
}

/** 依顯示寬度把文字切成多列（中文算 2 欄），最多 20 列 */
function wrapColumns(text: string, width: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    let used = 0
    for (const char of paragraph) {
      const size = columnsOf(char)
      if (used + size > width) {
        out.push(line)
        line = ''
        used = 0
      }
      line += char
      used += size
    }
    out.push(line)
  }
  return out.length > 20 ? [...out.slice(0, 19), `…（還有 ${out.length - 19} 列）`] : out
}
