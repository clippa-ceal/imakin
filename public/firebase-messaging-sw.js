/* バックグラウンドでプッシュ通知を受け取るためのService Worker
   ※ firebase-config.js と同じ値をここにも貼り付けてください
   (Service WorkerはESモジュールをimportできないため二重管理になっています) */
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID",
});

const messaging = firebase.messaging();

// data-onlyメッセージを通知として表示する
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  const title = `💪 ${d.senderName || "友達"} が筋トレ開始!`;
  const body = `${d.untilTime || ""}まで` + (d.message ? `「${d.message}」` : "");
  self.registration.showNotification(title, {
    body,
    icon: "/icon-192.png",
    tag: "workout-" + (d.senderUid || ""),
    data: { url: `/?replyTo=${d.senderUid || ""}&name=${encodeURIComponent(d.senderName || "")}` },
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) { c.navigate(url); return c.focus(); }
      }
      return clients.openWindow(url);
    })
  );
});
