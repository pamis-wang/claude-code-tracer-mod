# claude-code-tracer-mod

Claude Code 的追蹤 mod（外掛名稱 `tracer`，指令 `/tracer`）：不用 proxy，直接在 Claude Code 內部看每個請求的 token、cache、成本，subagent 的表現，context 與配額，cache TTL 倒數，以及 system prompt 的版本變化。

有兩種看法：

- **終端機面板**（`/tracer`）：聊天旁的側邊面板，加上輸入框下方的狀態列，隨時看一眼
- **網頁儀表板**（`/tracer web`）：在瀏覽器開啟，看完整細節

## 安裝

在 Claude Code 的輸入框：

```
/plugin install tracer --marketplace pamis-wang/claude-code-tracer-mod
```

或在終端機：

```
claude plugin install tracer --marketplace pamis-wang/claude-code-tracer-mod
```

第一次會問要不要加入 marketplace（`github:pamis-wang/claude-code-tracer-mod`），按 `y`；範圍選 user（預設），之後開的終端機 session 與 VS Code 都會載入。安裝時可以設定 `cacheTtlMinutes`：Max 方案選 60，Pro 或 API key 選 5。

**桌面版 app 不適用。** 桌面版的 Cowork session 跑在 Anthropic 的雲端容器裡，mod 也在容器裡載入，所以資料寫到容器的 `~/.claude/tracer/data/`，不在你的電腦上。`/tracer web` 也開不了：它在容器裡開 `file://`，你的瀏覽器看不到那個檔案。容器在 session 結束後會被回收，資料跟著消失。請在終端機或 VS Code 使用。

## 使用

- `/tracer`：開關面板（`/tracer open`、`/tracer close`）
- `/tracer web`：在瀏覽器開啟網頁儀表板
- `/tracer stats [on|off]`：統計列
- `/tracer intercept [all|tools|off]`：攔截請求或工具呼叫
- `/config`：`cacheTtlMinutes` 選 60（Max 方案）或 5（Pro／API key）

## 網頁儀表板

mod 把每個 session 的資料寫到 `~/.claude/tracer/data/`，儀表板是同一個資料夾裡的 `index.html`，直接從本機檔案開啟，每 2 秒自動更新。不跑 server，也不經過 proxy。

- **Dashboard**：專案 → session → 工作流程時間軸三欄
  - 專案依工作目錄分組：`/` 與 `\`、磁碟代號大小寫都視為同一個；不同資料夾同名時加上上層資料夾區分
  - session 卡片：標題、模型、turn 數、成本、context 長條、cache TTL 倒數
  - 時間軸：主對話與每個 subagent 各一條 lane；每個請求一條長條（高度＝context 使用率，顏色＝cache read／write／input），下方是成本軌與事件軌（錯誤、cache miss、compaction、寫檔）；上方縮圖可拖曳縮放，Ctrl＋滾輪縮放
  - 點 lane 看 agent 卡片，點請求看請求卡片（含 TTFT）與逐步內容：prompt、thinking、回覆、每個工具呼叫的輸入與結果（Edit 顯示新舊差異）
- **Usage**：5 小時／每週配額、今日與本月成本、最近 30 天每日成本（依專案堆疊）、每日 token 與 cache 命中率、每月成本、專案排行
- **System Prompt**：每個 session 的 system prompt 版本、各區段全文、與上一版的差異（每段標出增減行數，例如 +12／−3 行；可隱藏 2 行以內的小改動）

另外：

- **星號**：`f` 為目前的專案、session 或請求加星，`n`／`N` 在加星項目間跳轉，`p` 列出某個專案或 session 底下加星的項目。星號存在瀏覽器裡；加星的 session 超過保留期也會留在列表
- **健康分數**：每張 session 卡片右側的分數（0–100），從 100 分依 8 個訊號扣分：context 壓力、compaction、截斷／拒答、卡住迴圈（同一個工具呼叫、輸入完全相同，連續重複）、延遲漂移、工具錯誤率、cache 效率、權限拒絕，每個訊號依嚴重度最多扣 40 分。80 以上綠、50–79 黃、50 以下紅；滑過去看每一項扣了多少
- **token 縮圖**：步驟列表左邊的長條，高度是這個請求用掉的 context 比例，深藍色是先前累積的 context，下面是這個 turn 的每一步（依文字長度估算）
- **Raw**：請求明細最下面可以展開 tracer 記下的這個請求的完整資料（不是原始 HTTP 內容，mod 拿不到）
- 上方列顯示統計列與攔截的開關狀態，有請求或工具呼叫正在等你回答時會出現 **等你回應**

按 `?` 看全部快捷鍵；網址會記住目前的選取，可以加入書籤或分享。

資料保留 120 天（超過的 session 會從列表移除，加星的除外）。

## 匯入舊資料

在 clone 下來的資料夾裡執行（clone 見下方「修改」）：

```
node tools/import.mjs
```

把儀表板還沒有的 session 從 Claude Code 的對話紀錄（`~/.claude/projects/`）匯入：提示詞、回覆、工具呼叫的輸入與結果、subagent、時間與用量都會還原；成本依每個請求的用量估算，再按 Claude Code 記錄的各模型實際成本校正。

`--dry-run` 只顯示會匯入什麼；`--force` 重新匯入先前匯入過的；`--exclude=<id 前綴,…>` 排除指定的 session。即時記錄的 session 不會被覆蓋。

## 統計列與攔截

- **統計列**（預設開啟）：每個回覆下方多一行 `tracer · ctx 28% (290k/1M) · 1.2k in / 800 out · cache 命中 99% · $0.15`。只顯示在畫面上，不會寫進對話紀錄，模型也讀不到，所以不會截斷 subagent 的回報。`/tracer stats` 開關
- **攔截請求**：`/tracer intercept` 攔下一個主對話請求，`/tracer intercept all` 每個都攔。請求送出前會跳出選項：放行、換模型、調整 effort、拒絕。mod 只能改模型與 effort，改不了訊息內容與 system prompt
- **攔截工具呼叫**：`/tracer intercept tools` 開關。每個工具呼叫執行前會問你：放行、拒絕，或在 Other 輸入改過的輸入（Bash 可以直接輸入新指令，其他工具輸入 JSON）
- `/tracer intercept off` 全部關閉

## 面板（VS Code 與終端機）

`/tracer` 開關的側邊面板，VS Code 的 Claude 與終端機都能用。每一頁頂端有一張用彩色方塊字元畫的圖（VS Code 的 Claude 面板不畫 SVG，所以用文字畫，兩邊看到的一樣）：

- **時間軸**：主對話與最近 6 個 subagent 各一條 lane，兩列 `▁▂▃▄▅▆▇█` 疊成 16 階的長條：高度＝context 使用率（依各 lane 的最高點縮放，標題列有 peak %），顏色＝cache 狀況（青：命中 ≥80%、黃：≥50%、橘：<50%、紅：有工具錯誤）。一段時間沒動靜的空檔壓縮成 `┊`
- **Subagent**：甘特圖，每個 subagent 從開始到結束一條 `━`，結尾標 ✓／✗／●，標題列有耗時與成本
- **Context**：context 組成的堆疊長條與圖例，以及 5 小時／7 天配額長條（`┃` 是時間已過的位置）

面板分四頁（按 1～4 或點選切換）：

- **時間軸**：主對話每個 turn 的 prompt、耗時、成本（含 subagent）、token、cache 命中率、工具；cache miss 與超過 TTL 會標出
- **Subagent**：每個 subagent 的類型、任務、模型、結果、耗時、成本、token、工具與失敗次數
- **Context**：context 使用率與分類明細、記憶檔、5h / 7d 配額、cache 倒數、session 合計
- **Prompt**：system prompt 版本記錄，各區段全文與逐行差異

輸入框下方的狀態列固定顯示 `tracer $成本 · ctx % · cache 剩餘`，cache 快過期時會提醒一次。

## 成本怎麼算

成本來自 Claude Code 自己的成本帳本，不內建價目表。每個請求的成本是它結束當下帳本增加的金額，所以主對話與各 subagent 的成本加總等於帳本總額；同一瞬間有多個請求結束時，拆分為估算。

## System prompt 怎麼取得

Claude Code 內建的安全外掛會讓 `prompt.compose` 事件跳過使用者的 mod，所以 tracer 在每個主對話 turn 開始時主動呼叫 `$.prompt.compose()`，取得引擎此刻會送出的 system prompt，內容有變才記成新版本。

## 修改

clone 下來，從本機資料夾安裝：

```
git clone https://github.com/pamis-wang/claude-code-tracer-mod.git
claude plugin install tracer --marketplace ./claude-code-tracer-mod
```

已經從 GitHub 安裝過的話，先移除那份 marketplace（`claude plugin marketplace remove tracer-local`），兩份同名。

之後直接改這個資料夾，在 session 裡執行 `/reload-plugins` 就生效；網頁檔案會在下一個 session 開始時同步到 `~/.claude/tracer/`。在資料夾裡檢查與測試：

```
claude plugin validate .
claude plugin test .
```

## 檔案

| 檔案 | 用途 |
|---|---|
| `.claude-plugin/plugin.json` | mod 資訊與設定項 |
| `.claude-plugin/marketplace.json` | 讓這個資料夾成為本機 marketplace |
| `hooks/register.tsx` | 掛 hook、終端機面板、狀態列、`/tracer` 指令 |
| `hooks/recorder.ts` | 把資料寫成網頁讀得到的檔案 |
| `hooks/charts.ts` | 面板的文字圖表（時間軸 lane、甘特圖、context 組成、配額） |
| `web/index.html`、`style.css` | 網頁儀表板的頁面與樣式 |
| `web/app.js` | 載入資料、專案與 session 欄、上方列、快捷鍵 |
| `web/timeline.js` | 工作流程時間軸、卡片、逐步內容 |
| `web/pages.js` | Usage 頁與 System Prompt 頁 |
| `types/index.d.ts` | 面板狀態的型別 |
| `tools/import.mjs` | 匯入 Claude Code 對話紀錄 |
| `tests/tracer.test.tsx` | 測試 |

## 授權

MIT，見 [LICENSE](LICENSE)。
