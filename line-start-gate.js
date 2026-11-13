(function () {
  let overlay = null;
  let checking = null;
  let chatUrl = '';

  async function jsonRequest(path, options = {}) {
    const response = await fetch(path, { cache: 'no-store', ...options });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '暫時無法驗證，請稍後再試');
    return data;
  }

  function loggedIn() {
    return Boolean(window.liff?.isLoggedIn?.() && window.liff.getIDToken?.());
  }

  function show(message) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'line-start-title');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:#0008;display:flex;align-items:center;justify-content:center;padding:20px;overflow:auto';
      const panel = document.createElement('section');
      panel.style.cssText = 'background:white;color:#202020;border-radius:8px;padding:24px;width:100%;max-width:380px;box-sizing:border-box;line-height:1.6';
      panel.innerHTML = '<h2 id="line-start-title" style="font-size:22px;margin:0 0 12px">請先按「開始使用」</h2><p id="line-start-message" role="status"></p><div id="line-start-actions" style="display:flex;flex-wrap:wrap;gap:10px"></div>';
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
    }
    overlay.querySelector('#line-start-message').textContent = message;
    const actions = overlay.querySelector('#line-start-actions');
    actions.replaceChildren();
    function button(label, action, primary = false) {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = label;
      element.style.cssText = `padding:12px 16px;border:1px solid #ddd;border-radius:6px;font-size:16px;cursor:pointer;background:${primary ? '#087f42' : '#fff'};color:${primary ? '#fff' : '#202020'}`;
      element.addEventListener('click', action);
      actions.appendChild(element);
    }
    if (!loggedIn()) {
      button('登入 LINE', () => {
        if (!window.liff?.login) { show('LINE 登入尚未就緒，請重新開啟訂餐頁。'); return; }
        const redirectUrl = new URL(location.href);
        for (const key of ['code', 'state', 'liffClientId', 'liffRedirectUri']) redirectUrl.searchParams.delete(key);
        window.liff.login({ redirectUri: redirectUrl.href });
      }, true);
    } else {
      if (chatUrl) button('前往官方帳號', () => { location.href = chatUrl; }, true);
      button('我已按開始使用', () => ensure());
    }
    button('稍後', () => { overlay.remove(); overlay = null; });
  }

  async function check() {
    try {
      const config = await jsonRequest('/api/line/start/config');
      if (!config.required) return true;
      chatUrl = config.chatUrl;
      if (!loggedIn()) { show('請先登入 LINE，再到官方帳號送出「開始使用」。'); return false; }
      const status = await jsonRequest('/api/line/start/status', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${window.liff.getIDToken()}` }, body: '{}'
      });
      if (!status.started) {
        show('請到官方帳號按「開始使用」或送出同名文字訊息，完成後再回來點餐。');
        return false;
      }
      overlay?.remove();
      overlay = null;
      return true;
    } catch (error) { show(error.message); return false; }
  }

  function ensure() {
    if (!checking) checking = check().finally(() => { checking = null; });
    return checking;
  }
  window.LineStartGate = { ensure };
})();
