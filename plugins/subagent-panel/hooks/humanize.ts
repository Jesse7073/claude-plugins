/**
 * 把一次工具呼叫寫成人看得懂的一句話（label），
 * 原始的指令／參數放在 detail，使用者點開步驟時才顯示。
 */

export type Described = { label: string; detail: string }

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function quote(text: string, max = 30): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return `「${one.length > max ? one.slice(0, max - 1) + '…' : one}」`
}

function hostOf(url: string): string {
  const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(url)
  return match?.[1] ?? url
}

/** 常見 shell 指令的白話說明；認不出來就回 undefined */
export function explainCommand(command: string): string | undefined {
  // 去掉開頭的 cd xxx && / ; ，看真正在做的那段
  const parts = command
    .split(/&&|;|\|\|/)
    .map(one => one.trim())
    .filter(one => one.length > 0 && !/^cd\s/.test(one))
  const main = (parts[0] ?? command).trim()
  const extra = parts.length > 1 ? ' 等多個動作' : ''
  const words = main.split(/\s+/)
  const head = basename(words[0] ?? '').replace(/\.(exe|cmd|bat)$/i, '')
  const rest = words.slice(1).join(' ')

  const rules: Array<[RegExp, string]> = [
    [/^git log/, '查看 git 提交紀錄'],
    [/^git status/, '查看哪些檔案有變更'],
    [/^git diff/, '比對檔案修改了什麼'],
    [/^git show/, '查看某次提交的內容'],
    [/^git (branch|checkout|switch)/, '查看或切換 git 分支'],
    [/^git (add|commit)/, '提交修改到 git'],
    [/^git (push|pull|fetch)/, '和遠端 git 同步'],
    [/^git blame/, '查看每一行是誰改的'],
    [/^(mvn|mvnw|\.\/mvnw)\b.*\b(test|verify)\b/, '執行 Maven 測試'],
    [/^(mvn|mvnw|\.\/mvnw)\b.*\b(package|install|compile)\b/, '用 Maven 建置專案'],
    [/^(gradle|gradlew|\.\/gradlew)\b.*\btest\b/, '執行 Gradle 測試'],
    [/^(gradle|gradlew|\.\/gradlew)\b.*\b(build|assemble)\b/, '用 Gradle 建置專案'],
    [/^(npm|pnpm|yarn|bun)\s+(run\s+)?test/, '執行前端／Node 測試'],
    [/^(npm|pnpm|yarn|bun)\s+(i|install|add)\b/, '安裝套件'],
    [/^(npm|pnpm|yarn|bun)\s+run\s+build/, '建置前端專案'],
    [/^(npm|pnpm|yarn|bun)\s+run\s+(\S+)/, '執行專案腳本'],
    [/^(npx|tsc)\b.*tsc|^tsc\b/, '做 TypeScript 型別檢查'],
    [/^(pytest|python -m pytest)/, '執行 Python 測試'],
    [/^(python|python3|py)\b/, '執行 Python 程式'],
    [/^(node|deno|bun)\b/, '執行 JavaScript 程式'],
    [/^(java|javac)\b/, '執行或編譯 Java 程式'],
    [/^docker\b.*\b(compose\s+)?up\b/, '啟動 Docker 服務'],
    [/^docker\b/, '操作 Docker 容器'],
    [/^(curl|wget|Invoke-WebRequest)\b/, '呼叫網址取得資料'],
    [/^(ls|dir|Get-ChildItem|tree)\b/, '列出資料夾內容'],
    [/^(cat|type|Get-Content|head|tail|less|more)\b/, '讀取檔案內容'],
    [/^sed -n/, '讀取檔案的某幾行'],
    [/^(grep|rg|Select-String|findstr)\b/, '在檔案中搜尋文字'],
    [/^find\b/, '尋找檔案'],
    [/^(wc)\b/, '計算檔案行數'],
    [/^(mkdir|New-Item)\b/, '建立資料夾或檔案'],
    [/^(rm|del|Remove-Item)\b/, '刪除檔案'],
    [/^(cp|copy|Copy-Item|mv|move|Move-Item)\b/, '複製或搬移檔案'],
    [/^(echo|printf|Write-Output)\b/, '輸出文字'],
    [/^(which|where|Get-Command)\b/, '確認某個程式裝在哪裡'],
    [/^(psql|mysql|sqlite3)\b/, '查詢資料庫'],
    [/^claude\b/, '執行 Claude Code 指令'],
  ]
  const line = `${head} ${rest}`.trim()
  for (const [pattern, text] of rules) {
    if (pattern.test(line) || pattern.test(main)) {
      return text + extra
    }
  }
  return undefined
}

/** 把一次工具呼叫寫成白話 */
export function describeCall(e: { tool: string }): Described {
  const args = e as unknown as Record<string, unknown>
  const text = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '')

  switch (e.tool) {
    case 'Bash':
    case 'PowerShell': {
      const command = text('command')
      const description = text('description')
      return { label: description || explainCommand(command) || '執行指令', detail: command }
    }
    case 'Read': {
      const path = text('file_path')
      const offset = typeof args.offset === 'number' ? args.offset : undefined
      const limit = typeof args.limit === 'number' ? args.limit : undefined
      const range = offset !== undefined && limit !== undefined ? `（第 ${offset}–${offset + limit} 行）` : ''
      return { label: `讀取 ${basename(path)}${range}`, detail: path }
    }
    case 'Grep': {
      const pattern = text('pattern')
      const where = text('glob') || text('path')
      return {
        label: `搜尋${quote(pattern)}${where ? `（在 ${basename(where)}）` : ''}`,
        detail: [`pattern: ${pattern}`, text('path') && `path: ${text('path')}`, text('glob') && `glob: ${text('glob')}`]
          .filter(Boolean)
          .join('\n'),
      }
    }
    case 'Glob': {
      const pattern = text('pattern')
      return { label: `尋找符合${quote(pattern)}的檔案`, detail: [pattern, text('path')].filter(Boolean).join('\n') }
    }
    case 'Edit':
    case 'MultiEdit':
      return { label: `修改 ${basename(text('file_path'))}`, detail: text('file_path') }
    case 'Write':
      return { label: `寫入 ${basename(text('file_path'))}`, detail: text('file_path') }
    case 'NotebookEdit':
      return { label: `修改筆記本 ${basename(text('notebook_path'))}`, detail: text('notebook_path') }
    case 'WebFetch':
      return { label: `讀取網頁 ${hostOf(text('url'))}`, detail: text('url') }
    case 'WebSearch':
      return { label: `上網搜尋${quote(text('query'))}`, detail: text('query') }
    case 'Agent':
      return { label: `交派子任務：${text('description') || '（未命名）'}`, detail: text('prompt') }
    case 'ToolSearch':
      return { label: '載入需要的工具', detail: text('query') }
    case 'Skill':
      return { label: `使用技能 ${text('skill')}`, detail: text('args') }
    case 'AskUserQuestion':
      return { label: '詢問使用者', detail: '' }
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(e.tool)
      if (mcp !== null) {
        const own: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(args)) {
          if (!['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'].includes(key)) {
            own[key] = value
          }
        }
        return { label: `使用 ${mcp[1]} 的 ${mcp[2]}`, detail: JSON.stringify(own).slice(0, 500) }
      }
      return { label: `使用 ${e.tool}`, detail: '' }
    }
  }
}
