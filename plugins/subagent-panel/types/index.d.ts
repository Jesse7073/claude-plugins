export type StepState = 'done' | 'current' | 'pending'

/** 一個步驟：工具呼叫或 subagent 自己寫的待辦項目 */
/** active：進行中時顯示的文字（TaskCreate／TodoWrite 的 activeForm） */
export type Step = {
  id?: string
  /** 白話的一句說明 */
  label: string
  active?: string
  state: StepState
  /** 工具名稱（判斷正在做什麼用） */
  tool?: string
  /** 原始的指令或參數，點開步驟時才顯示 */
  detail?: string
  /** 工具呼叫發生時，計畫裡正在進行的是第幾步（從 0 開始） */
  plan?: number
}

export type AgentStatusTag = 'running' | 'done' | 'failed' | 'aborted'

export type AgentRow = {
  id: string
  description: string
  type: string
  model: string
  status: AgentStatusTag
  startedAt: number
  endedAt?: number
  /** 每次工具呼叫算一步 */
  calls: Step[]
  /** subagent 用 TodoWrite 寫下的計畫；null 表示沒有計畫 */
  plan: Step[] | null
}

/** 一次剩餘時間估算（每分鐘重算） */
export type Estimate = {
  /** 0–1 */
  progress: number
  /** null 表示資料還不夠，估不出來 */
  remainingMs: number | null
  /** plan：依 TodoWrite 計畫；history：依同類型過去的平均步數；guess：沒有歷史，用預設值 */
  basis: 'plan' | 'history' | 'guess' | 'done'
  /** 估算時間點 */
  at: number
}

/** 某個 subagent 類型過去的執行紀錄（跨 session 保存在 $.store） */
export type TypeHistory = { runs: number; avgSteps: number; avgMs: number }

declare module 'claude-code' {
  interface PluginState {
    'subagent-panel': {
      agents: Shaped<AgentRow[]>
      /** 使用者收合了步驟清單的 subagent（預設全部展開） */
      folded: string[]
      /** 使用者按了隱藏；下次有 subagent 被呼叫時自動恢復 */
      isHidden: boolean
      /** 側邊欄沒被擺出來（終端機太窄），改畫在輸入框上方 */
      isBandMode: boolean
      /** 使用者點開看原始指令的步驟（`<agentId>:<步驟 key>`） */
      openSteps: string[]
      /** 使用者按了清除的 subagent，之後的事件不再把它加回來 */
      removed: string[]
      /** agent id → 最近一次估算 */
      estimates: Shaped<Record<string, Estimate>>
      isCollapsed: boolean
      isPlanMode: boolean
    }
  }
}
