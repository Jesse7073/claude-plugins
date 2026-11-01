# claude-plugins

Jesse 的 Claude Code plugin 市集。

| Plugin | 說明 |
| --- | --- |
| [subagent-panel](plugins/subagent-panel) | 側邊面板：即時顯示每個 subagent 在做什麼、用哪個模型、步驟進度與預估剩餘時間 |

## 安裝

需要 Claude Code v2.1.287 以上（`claude --version` 查看）。

在 Claude Code 的輸入框：

```
/plugin install subagent-panel --marketplace Jesse7073/claude-plugins
```

出現 `Add marketplace?` 時按 `y`，範圍選 user（預設第一個）即可。

或在終端機：

```
claude plugin install subagent-panel --marketplace Jesse7073/claude-plugins
```

在 Claude 桌面版（不能用 `/plugin`）：點輸入框旁的 **+** → **Plugins** → **Add marketplace**，輸入 `Jesse7073/claude-plugins`，再 **Add plugin**。

## 更新

```
claude plugin marketplace update jesse-local
claude plugin update subagent-panel@jesse-local
```

之後在 Claude Code 裡執行 `/reload-plugins`，或重開 Claude Code。

## 授權

MIT，見 [LICENSE](LICENSE)。
