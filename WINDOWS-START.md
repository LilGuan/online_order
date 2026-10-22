# Windows 一鍵啟動

雙擊專案根目錄的 `start-online-order.bat`。

批次檔會檢查 Node.js 22.12 以上、npm 和 cloudflared，安裝 npm 依賴、檢查伺服器語法、build Vue 前台，再啟動訂餐服務與固定網址的 Cloudflare Named Tunnel。缺少 Node.js 或 cloudflared 時會嘗試用 Windows 的 winget 安裝；安裝後請重新開啟批次檔。沒有 winget 時需先自行安裝這兩個程式。

## 第一次設定

1. 將完整專案放在 Windows 電腦，並將原本的 `.env` 放在專案根目錄。不要分享或公開這個檔案。
2. 將已建立的同一條 Cloudflare Named Tunnel 憑證 JSON 放入 `%USERPROFILE%\.cloudflared\`。登入 Cloudflare 本身不會重新產生原 Tunnel 的本機憑證。
3. 建立 `%USERPROFILE%\.cloudflared\config.yml`，沿用原 Tunnel ID，將路徑換成這台 Windows 的實際路徑：

```yaml
tunnel: 79f309e6-ea8b-4357-bc2d-d518a0a98d5f
credentials-file: 'C:\Users\你的Windows使用者名稱\.cloudflared\79f309e6-ea8b-4357-bc2d-d518a0a98d5f.json'
ingress:
  - hostname: order.chiufood.com
    service: http://localhost:3000
  - service: http_status:404
```

`.env` 的 `CLOUDFLARE_TUNNEL_NAME` 沿用 `online-order`。如果有 `CLOUDFLARED_BIN`，請移除 Mac 的 `/opt/homebrew/bin/cloudflared` 或改成 Windows 的 cloudflared.exe 路徑。若 Tunnel 設定檔放在別處，可設定 `CLOUDFLARED_CONFIG`。

若 `.env` 使用不同的 `PORT`，也要同步修改 `config.yml` 的 `service` 連接埠。

## 日常使用

保持啟動視窗開啟。後台是 `http://localhost:3000/merchant.html`，正式網址仍為 `https://order.chiufood.com/merchant.html`。顯示本機後台網址僅代表本機服務就緒，外部連線仍需 Tunnel 成功連線。

按 Ctrl+C 停止這次啟動的服務；如 cmd 詢問是否終止批次工作，請輸入 Y。不要同時啟動多份批次檔。連接埠被占用時會停止，避免關閉其他程式。

如果原本 Mac 仍在運行同一個 Tunnel，請先停止原主機的這條 Tunnel，再將 Windows 當作主機；否則同一網址的請求可能被分配到兩台不同的訂餐伺服器。

此批次檔不會自動選取或配對藍牙印表機；仍需在 Chrome 後台按藍牙快捷鍵授權。`.bat` 只適用於 Windows，macOS 原本的啟動指令仍為 `npm run watch:tunnel`。
