// subagent 正在做什麼（依目前的工具呼叫判斷），以及依顯示寬度裁切文字

import type { AgentRow } from '../types'

export type Activity = 'reading' | 'typing' | 'command' | 'web' | 'thinking' | 'sleeping' | 'failed'

export const POSE_LABEL: Record<Activity, string> = {
  reading: '閱讀中',
  typing: '修改檔案中',
  command: '執行指令中',
  web: '上網查資料',
  thinking: '思考中',
  sleeping: '完成',
  failed: '中斷',
}

const TOOL_ACTIVITY: Record<string, Activity> = {
  Read: 'reading',
  Grep: 'reading',
  Glob: 'reading',
  LS: 'reading',
  NotebookRead: 'reading',
  Edit: 'typing',
  MultiEdit: 'typing',
  Write: 'typing',
  NotebookEdit: 'typing',
  Bash: 'command',
  PowerShell: 'command',
  BashOutput: 'command',
  KillShell: 'command',
  WebFetch: 'web',
  WebSearch: 'web',
}

/** 從 agent 的狀態與正在進行的工具呼叫判斷它在做什麼 */
export function poseOf(row: AgentRow): Activity {
  if (row.status === 'done') {
    return 'sleeping'
  }
  if (row.status === 'failed' || row.status === 'aborted') {
    return 'failed'
  }
  const current = [...row.calls].reverse().find(step => step.state === 'current')
  if (current === undefined) {
    return 'thinking'
  }
  return TOOL_ACTIVITY[current.tool ?? ''] ?? 'thinking'
}

function columnsOf(char: string): number {
  const code = char.codePointAt(0) ?? 0
  return code >= 0x1100 &&
    (code <= 0x115f ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      code >= 0x20000)
    ? 2
    : 1
}

/** 依顯示寬度裁切（中文字算兩欄） */
export function clipColumns(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  const chars = [...one]
  const total = chars.reduce((sum, char) => sum + columnsOf(char), 0)
  if (total <= max) {
    return one
  }
  let width = 0
  let out = ''
  for (const char of chars) {
    const w = columnsOf(char)
    if (width + w > max - 1) {
      break
    }
    out += char
    width += w
  }
  return out + '…'
}
