// 接單後台的 Service Worker：唯一職責是在瀏覽器被切到背景、螢幕鎖定、甚至完全關閉時，
// 收到伺服器推播並跳出系統通知。
//
// 重要限制（iOS/Android 皆然）：Service Worker 內無法播放 Web Audio，
// 所以「大聲的警報聲」只能在後台頁面處於前景時由頁面本身播放；
// 背景狀態下只會有作業系統的通知音（音量由系統控制，無法自訂或連續響）。

const NOTIFICATION_TAG = 'new-order';

self.addEventListener('install', event => {
  // 新版本立即接手，店家不必手動關掉所有分頁
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  // iOS 規定每一則推播都必須顯示使用者看得到的通知，否則會撤銷訂閱，
  // 所以即使 payload 壞掉也要跳出一則通知。
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (error) {
    payload = {};
  }

  const title = payload.title || '有新訂單';
  const options = {
    body: payload.body || '請開啟後台查看',
    icon: 'images/logo.jpg',
    badge: 'images/logo.jpg',
    tag: payload.tag || NOTIFICATION_TAG,
    renotify: true,        // 同一個 tag 的後續訂單仍要再次提醒
    requireInteraction: true, // Android 上通知會留著不自動消失
    vibrate: [300, 120, 300, 120, 300],
    data: { url: payload.url || '/merchant.html?view=orders&status=pending', orderId: payload.orderId || '' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/merchant.html?view=orders&status=pending';

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

    // 後台已經開著就直接聚焦，並通知頁面切到接單區、把待接的單叫出來
    for (const client of allClients) {
      if (client.url.includes('merchant.html')) {
        await client.focus();
        client.postMessage({
          type: 'open-pending-orders',
          orderId: (event.notification.data && event.notification.data.orderId) || ''
        });
        return;
      }
    }

    // 沒開著就開一個，網址帶參數讓頁面自己導到接單區
    await self.clients.openWindow(target);
  })());
});
