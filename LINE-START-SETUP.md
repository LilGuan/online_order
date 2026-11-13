# LINE 開始使用驗證

客人按「開始使用」時，按鈕會以客人身分送出同名文字訊息。Webhook 收到並驗證 LINE 簽章後，在會員資料記錄 `lineStartedAt`，再回覆「線上點餐」連結。只加好友、只開網址或只提供 UUID 不算完成。

## 首次設定

1. 在 LINE Developers 選擇**邱媽媽美食的 Messaging API channel**，從 Basic settings 取得 Channel secret。這不是 LINE Login 的 secret，也不是 LINE Pay 的 secret。
2. 在本機 `.env` 加入以下設定，先維持驗證關閉，重新啟動服務：

```dotenv
LINE_MESSAGING_CHANNEL_SECRET=填入Messaging_API_Channel_secret
LINE_START_REQUIRED=false
```

`LINE_CHANNEL_ACCESS_TOKEN` 必須屬於相同的 Messaging API channel。請勿把 secret 貼到聊天室或放入前端。

LINE Login／LIFF channel 與 Messaging API channel 必須屬於同一個 Provider，兩邊識別到的使用者 ID 才能一致。

3. 在該 channel 的 Messaging API → Webhook settings 將 URL 設成 `https://order.chiufood.com/api/line/webhook`，按 Verify，成功後開啟 Use webhook。若該官方帳號原先已有其他 Webhook 接收程式，需先合併事件處理，不能直接覆蓋原網址。
4. 官方帳號管理後台開啟「聊天」。加入好友時，本程式會回覆含「開始使用」按鈕的歡迎訊息；若原本也有加入好友歡迎訊息，可自行保留或調整，避免重複。
5. 用測試 LINE 帳號加好友，或先在聊天室傳一則訊息，確認能收到「開始使用」按鈕。按下後應看到客人送出的「開始使用」文字，以及「已完成開始使用」回覆。
6. 確認上一步成功後，將 `.env` 的 `LINE_START_REQUIRED=true` 並重新啟動。原有客人也需要完成一次「開始使用」，才可繼續下單。

可選填 `LINE_OFFICIAL_ACCOUNT_ID=@你的官方帳號ID`；未填時程式透過 Bot info API 取得。在網頁看到驗證提示後，「前往官方帳號」會帶入「開始使用」文字，**客人仍需按送出**，再回網頁按「我已按開始使用」。

## 驗證範圍

- 舊版菜單、商品明細、加入購物車、購物車入口、送出訂單都會檢查。
- Vue 版菜單及購物車同步檢查。
- API 在建立正式訂單前，用 LINE ID token 驗證本人，再確認伺服器會員資料的開始使用狀態；不能偽造 UUID 或 localStorage 略過。
- 前台測試連結仍需通過原本的伺服器測試 token 驗證，不要求真實 LINE 開始使用。
- 狀態沿用既有會員資料與同步機制，不需要新建資料表。
- 封鎖官方帳號的 unfollow 事件會清除開始使用狀態，重新加入後需再完成。
- 關閉開關或未設定 secret 時不啟用下單限制，避免設定未完成造成所有人無法下單。

## 最小驗收

1. 未完成開始使用的帳號直接開點餐網址：應提示開始使用。
2. 未帶 LINE ID token 或只帶 UUID 直接呼叫送單 API：應被拒絕，且不新增訂單。
3. 按聊天室「開始使用」後返回網頁確認：應通過驗證，再次按送單才建立訂單。
4. 另一位 LINE 使用者不能沿用上一位的完成狀態。
5. Webhook 無簽章或錯誤簽章：應回傳 401；Verify 的空事件陣列應回傳成功。
