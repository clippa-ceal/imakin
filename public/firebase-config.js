// Firebaseコンソール → プロジェクトの設定 → マイアプリ(ウェブ) の値
// ※ この値は「秘密」ではないので、そのままGitにコミットしてOKです
export const firebaseConfig = {
  apiKey: "AIzaSyDVecx5qNf9dViBI44a8et1oej5iK-4irk",
  authDomain: "imakin-2e8b9.firebaseapp.com",
  projectId: "imakin-2e8b9",
  storageBucket: "imakin-2e8b9.firebasestorage.app",
  messagingSenderId: "721006229188",
  appId: "1:721006229188:web:4f55b81946551d27b23b91",
};

// Firebaseコンソール → プロジェクトの設定 → Cloud Messaging →
// 「ウェブプッシュ証明書」の鍵ペアを生成してコピー
export const vapidKey = "PASTE_VAPID_KEY";
