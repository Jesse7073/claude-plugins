import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'subagent-panel',
  component: 'Pane',
  requestId: 'subagents',
  props: {
    title: 'Subagents',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('面板顯示 subagent 的任務、模型、步驟並標示目前步驟', async ($, on) => {
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('tool.register', (_, e) => ({ value: { tool: 'mcp__subagent-panel__' + e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('agent.list', () => ({
    value: [{ id: 'a1', description: '搜尋登入流程', type: 'Explore', status: 'running' }],
  }))
  on('tool.call', () => ({ result: {} }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  mock.clock(on, { now: 1000 })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'find login', description: '搜尋登入流程', subagentType: 'Explore' })
  await $.tool.call({ tool: 'Grep', pattern: 'login', agentId: 'a1' })
  await $.tool.call({
    tool: 'TodoWrite',
    agentId: 'a1',
    todos: [
      { content: '找進入點', status: 'completed', activeForm: '找進入點中' },
      { content: '追 session 建立', status: 'in_progress', activeForm: '追 session 建立中' },
      { content: '整理結論', status: 'pending', activeForm: '整理結論中' },
    ],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /haiku-5-5 · 步驟 2\/3/ })).toBeDefined()

  // 預設展開：每個步驟都看得到，目前步驟用 ▶ 標示；點這一列可以收起
  expect((await ui.find({ type: 'Text', text: /▶/ }))?.text).toBe('  ├ ▶ 追 session 建立中')
  expect((await ui.find({ type: 'Text', text: /找進入點/ }))?.text).toBe('  ├ ✓ 找進入點')
  expect((await ui.find({ type: 'Text', text: /整理結論/ }))?.text).toBe('  └ ○ 整理結論')
  // 標題列：彩色狀態計數；進度條 + 百分比
  expect(await ui.find({ type: 'Text', text: /● 1 執行中/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /━+ +50%/ })).toBeDefined()
  await ui.press({ key: 'row-a1' })
  expect(await ui.find({ type: 'Text', text: /▶/ })).toBeUndefined()
  await ui.press({ key: 'row-a1' })
  expect(await ui.find({ type: 'Text', text: /▶/ })).toBeDefined()

  // 整個面板收合
  await ui.press({ key: 'toggle-all' })
  expect(await ui.find({ type: 'Text', text: /步驟 2\/3/ })).toBeUndefined()
  await ui.unmount()
})

function stubs(
  on: Parameters<Parameters<typeof test>[1]>[1],
  isPlaced: boolean,
  calls?: string[],
  skipToolCall = false,
) {
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('tool.register', (_, e) => ({ value: { tool: 'mcp__subagent-panel__' + e.name } }))
  on('ui.open', () => {
    calls?.push('open')
    return { value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'too narrow' } }
  })
  on('ui.close', () => {
    calls?.push('close')
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: isPlaced ? [{ id: 'subagents', title: 'Subagents', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'b1' }))
  on('agent.list', () => ({
    value: [{ id: 'b1', description: '整理文件', type: 'general-purpose', status: 'running' }],
  }))
  if (!skipToolCall) {
    on('tool.call', () => ({ result: {} }))
  }
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  return mock.clock(on, { now: 1000 })
}

test('進度條與剩餘時間每分鐘重新估算', async ($, on) => {
  const clock = stubs(on, true)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'go', description: '整理文件', subagentType: 'general-purpose' })
  await $.tool.call({
    tool: 'TodoWrite',
    agentId: 'b1',
    todos: [
      { content: 'a', status: 'completed', activeForm: 'a' },
      { content: 'b', status: 'completed', activeForm: 'b' },
      { content: 'c', status: 'pending', activeForm: 'c' },
      { content: 'd', status: 'pending', activeForm: 'd' },
    ],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // 剛開始還估不出來
  expect(await ui.find({ type: 'Text', text: /剩餘時間估算中/ })).toBeDefined()

  // 一分鐘後依計畫重算：完成 2/4 = 50%，已花 60 秒 → 剩約 1 分
  await clock.advance(60_000)
  const eta = await ui.find({ type: 'Text', text: /剩約/ })
  expect(eta?.text).toContain(' 50%')
  expect(eta?.text).toContain('剩約 1 分 0 秒')
  expect(eta?.text).toContain('依計畫')
  await ui.unmount()
})

test('TaskCreate／TaskUpdate 當作計畫步驟', async ($, on) => {
  stubs(on, true, undefined, true)
  let next = 0
  on('tool.call', (_, e) =>
    e.tool === 'TaskCreate'
      ? { result: { task: { id: String(++next), subject: e.subject } } }
      : e.tool === 'TaskUpdate'
        ? { result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }
        : { result: {} },
  )
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'go', description: '整理文件', subagentType: 'general-purpose' })
  for (const subject of ['讀設定', '改程式', '跑測試']) {
    await $.tool.call({ tool: 'TaskCreate', agentId: 'b1', subject, description: subject, activeForm: `${subject}中` })
  }
  await $.tool.call({ tool: 'TaskUpdate', agentId: 'b1', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', agentId: 'b1', taskId: '2', status: 'in_progress' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /步驟 2\/3/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /▶/ }))?.text).toBe('  ├ ▶ 改程式中')
  expect((await ui.find({ type: 'Text', text: /讀設定/ }))?.text).toBe('  ├ ✓ 讀設定')
  expect((await ui.find({ type: 'Text', text: /跑測試/ }))?.text).toBe('  └ ○ 跑測試')
  // 任務工具本身不算一般步驟，剩餘時間依計畫估
  expect(await ui.find({ type: 'Text', text: /TaskCreate/ })).toBeUndefined()
  await ui.unmount()
})

test('隱藏按鈕收起面板，下一個 subagent 被呼叫時自動出現', async ($, on) => {
  const calls: string[] = []
  const clock = stubs(on, true, calls)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'go', description: '整理文件', subagentType: 'general-purpose' })
  await clock.advance(0)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'hide' })
  // docked: the panel shrinks to a narrow strip instead of closing
  expect(calls).toEqual(['open', 'close', 'open'])

  await $.agent.spawn({ prompt: 'again', description: '再一個', subagentType: 'general-purpose' })
  await clock.advance(0)
  await ui.unmount()
  expect(calls).toEqual(['open', 'close', 'open', 'close', 'open'])
})

test('終端機太窄擺不出側邊欄時，改畫在輸入框上方', async ($, on) => {
  const clock = stubs(on, false)
  // 隱藏後交還給引擎畫（引擎在這裡什麼都不畫）
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'go', description: '整理文件', subagentType: 'general-purpose' })
  await clock.advance(0)

  const band = await $.ui.mount({
    plugin: 'subagent-panel',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 60, scroll: { offset: 0, bodyRows: 19 }, view: {} },
  })
  expect(await band.find({ type: 'Text', text: /整理文件/ })).toBeDefined()
  await band.press({ key: 'hide' })
  expect(await band.find({ type: 'Text', text: /整理文件/ })).toBeUndefined()
  await band.unmount()
})

test('步驟很多時全部列出並畫捲軸', async ($, on) => {
  stubs(on, true)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'go', description: '整理文件', subagentType: 'general-purpose' })
  for (let at = 0; at < 40; at += 1) {
    await $.tool.call({ tool: 'Read', file_path: `/f${at}.md`, agentId: 'b1' })
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /讀取 f0\.md/ }))?.text).toContain('├ ✓ 讀取 f0.md')
  expect((await ui.find({ type: 'Text', text: /讀取 f39\.md/ }))?.text).toContain('└ ✓ 讀取 f39.md')
  expect(await ui.find({ type: 'Box', key: 'scrollbar' })).toBeDefined()
  await ui.unmount()
})

test('subagent 用 mod 自己的 plan_steps／step_status 回報進度', async ($, on) => {
  stubs(on, true)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'go', description: 'docs', subagentType: 'general-purpose' })
  const planned = await $.tool.call({
    tool: 'mcp__subagent-panel__plan_steps',
    agentId: 'b1',
    steps: ['read src', 'read pom', 'summarize'],
  })
  expect(planned.result).toContain('3')
  await $.tool.call({ tool: 'mcp__subagent-panel__step_status', agentId: 'b1', step: 1, status: 'completed' })
  await $.tool.call({ tool: 'mcp__subagent-panel__step_status', agentId: 'b1', step: 2, status: 'in_progress' })
  await $.tool.call({ tool: 'Read', file_path: '/pom.xml', agentId: 'b1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /2\/3/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /▶/ }))?.text).toBe('  ├ ▶ read pom ▾')
  // the progress tools themselves are not listed as steps
  expect(await ui.find({ type: 'Text', text: /plan_steps/ })).toBeUndefined()
  await ui.unmount()
})

test('steps read as plain sentences, tap to see the command, and a subagent can be cleared', async ($, on) => {
  stubs(on, true)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'go', description: 'docs', subagentType: 'general-purpose' })
  await $.tool.call({ tool: 'Bash', command: 'cd /repo && git log --oneline -5', agentId: 'b1' })
  await $.tool.call({ tool: 'Bash', command: 'mvn -q test', description: '跑後端單元測試', agentId: 'b1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /✓ 查看 git 提交紀錄/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✓ 跑後端單元測試/ })).toBeDefined()
  // the raw command only shows after tapping the step
  expect(await ui.find({ type: 'Text', text: /git log --oneline/ })).toBeUndefined()
  const stepButton = await ui.find({ type: 'Button', text: /查看 git 提交紀錄/ })
  expect(stepButton?.key).toMatch(/^step-b1:c/)
  await ui.press({ key: stepButton?.key ?? '' })
  expect(await ui.find({ type: 'Text', text: /git log --oneline -5/ })).toBeDefined()

  // clear removes the whole block; later events do not bring it back
  await ui.press({ key: 'remove-b1' })
  expect(await ui.find({ type: 'Text', text: /docs/ })).toBeUndefined()
  await $.tool.call({ tool: 'Read', file_path: '/a.md', agentId: 'b1' })
  expect(await ui.find({ type: 'Text', text: /docs/ })).toBeUndefined()
  await ui.unmount()
})

test('hidden while docked: the side strip keeps an expand button', async ($, on) => {
  const calls: string[] = []
  const clock = stubs(on, true, calls)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'go', description: 'docs', subagentType: 'general-purpose' })
  await clock.advance(0)

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'hide' })
  expect(await pane.find({ type: 'Text', text: /docs/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /1 執行中/ })).toBeDefined()
  await pane.press({ key: 'reopen' })
  expect(calls).toEqual(['open', 'close', 'open', 'close', 'open'])
  expect(await pane.find({ type: 'Text', text: /docs/ })).toBeDefined()
  await pane.unmount()
})

test('hidden while above the prompt: a one-line button brings the panel back', async ($, on) => {
  const clock = stubs(on, false)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'go', description: 'docs', subagentType: 'general-purpose' })
  await clock.advance(0)

  const band = await $.ui.mount({
    plugin: 'subagent-panel',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 60, scroll: { offset: 0, bodyRows: 19 }, view: {} },
  })
  await band.press({ key: 'hide' })
  expect(await band.find({ type: 'Text', text: /顯示 Subagent 面板/ })).toBeDefined()
  await band.press({ key: 'reopen' })
  expect(await band.find({ type: 'Text', text: /docs/ })).toBeDefined()
  await band.unmount()
})
