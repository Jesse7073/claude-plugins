import type { AgentRow, Estimate, TypeHistory } from '../types'

/** 沒有歷史資料時，假設一個 subagent 大約走這麼多步 */
export const DEFAULT_STEPS = 15

/**
 * 估算一個執行中 subagent 的進度與剩餘時間。
 *
 * - 有 TodoWrite 計畫：進度 = 已完成步驟（目前步驟算半步）/ 總步驟
 * - 沒有計畫：用同類型 subagent 過去平均走幾步當作預期總步數
 * 剩餘時間 = 已花時間 ×（1 − 進度）/ 進度
 */
export function estimate(row: AgentRow, history: TypeHistory | undefined, now: number): Estimate {
  const elapsed = Math.max(0, now - row.startedAt)

  if (row.status !== 'running') {
    return { progress: 1, remainingMs: 0, basis: 'done', at: now }
  }

  let progress: number
  let basis: Estimate['basis']
  if (row.plan !== null && row.plan.length > 0) {
    const done = row.plan.filter(step => step.state === 'done').length
    const current = row.plan.some(step => step.state === 'current') ? 0.5 : 0
    progress = (done + current) / row.plan.length
    basis = 'plan'
  } else {
    const expected = history !== undefined && history.runs > 0 ? history.avgSteps : DEFAULT_STEPS
    const steps = row.calls.length
    // 超過預期步數時不要卡在 100%，讓它慢慢逼近
    progress = steps <= expected * 0.9 ? steps / expected : 0.9 + 0.09 * (1 - Math.exp(-(steps - expected * 0.9) / expected))
    basis = history !== undefined && history.runs > 0 ? 'history' : 'guess'
  }
  progress = Math.min(0.99, Math.max(0, progress))

  let remainingMs: number | null
  if (progress < 0.03 || elapsed < 5000) {
    // 太早，靠歷史平均時間猜
    remainingMs = history !== undefined && history.runs > 0 ? Math.max(0, history.avgMs - elapsed) : null
  } else {
    remainingMs = Math.round((elapsed * (1 - progress)) / progress)
  }

  return { progress, remainingMs, basis, at: now }
}

/** 把一次完成的執行加進該類型的歷史平均 */
export function addRun(history: TypeHistory | undefined, steps: number, ms: number): TypeHistory {
  const runs = (history?.runs ?? 0) + 1
  // 最多看最近 20 次的權重，讓估計跟得上習慣的改變
  const weight = 1 / Math.min(runs, 20)
  const avgSteps = history === undefined ? steps : history.avgSteps + (steps - history.avgSteps) * weight
  const avgMs = history === undefined ? ms : history.avgMs + (ms - history.avgMs) * weight
  return { runs, avgSteps, avgMs }
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  if (total < 60) {
    return `${total} 秒`
  }
  const minutes = Math.floor(total / 60)
  if (minutes < 60) {
    return `${minutes} 分 ${total % 60} 秒`
  }
  return `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分`
}

/** 文字進度條，例如 ██████░░░░ 60% */
export function progressBar(progress: number, cells: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, progress)) * cells)
  return '█'.repeat(filled) + '░'.repeat(cells - filled) + ` ${Math.round(progress * 100)}%`
}
