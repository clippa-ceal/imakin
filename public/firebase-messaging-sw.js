/* バックグラウンドでプッシュ通知を受け取るためのService Worker
   ※ firebase-config.js と同じ値をここにも貼り付けてください
   (Service WorkerはESモジュールをimportできないため二重管理になっています) */
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyDVecx5qNf9dViBI44a8et1oej5iK-4irk",
  authDomain: "imakin-2e8b9.firebaseapp.com",
  projectId: "imakin-2e8b9",
  storageBucket: "imakin-2e8b9.firebasestorage.app",
  messagingSenderId: "721006229188",
  appId: "1:721006229188:web:4f55b81946551d27b23b91",
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
