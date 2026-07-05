// Firebaseコンソール → プロジェクトの設定 → マイアプリ(ウェブ) からコピーして貼り付ける
// ※ この値は「秘密」ではないので、そのままGitにコミットしてOKです
export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID",
};

// Firebaseコンソール → プロジェクトの設定 → Cloud Messaging →
// 「ウェブプッシュ証明書」の鍵ペアを生成してコピー
export const vapidKey = "PASTE_VAPID_KEY";
