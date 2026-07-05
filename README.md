# イマキン 💪 — 「今から筋トレするよ」を友達に飛ばすアプリ

SNS×筋トレのPWA(スマホのホーム画面に追加して使うWebアプリ)。

## できること

- **友達登録**: 6文字の友達コードを交換 → 申請 → 承認で友達に
- **筋トレ開始通知**: 「何時まで」+「一言メッセージ(20文字)」を友達全員にプッシュ通知
- **返信**: 届いた通知から、同じフォーマット(時刻+一言)で相手に返せる
- **筋トレ中の画面**: 開始を知らせると時計+カウントダウンの画面に切り替わり、届いた返信がフキダシ型の付箋でペタペタ貼られる(画面スリープ防止付き)。フキダシにはスタンプ(👍🔥💪🤣)を押して相手に飛ばせる。終了時は「終わったよ」の一言を送れる
- **ひよこ記録**: 筋トレした日は `users/{uid}/sessions/{日付}` に記録され、ホームに直近14日ぶんのひよこ🐤が自分+友達分並ぶ(友達ごとに色を変えられる)。「記録」タブで日ごとのセッション一覧(開始時刻・何時まで・一言)も見られる
- **終了報告の相手**: 「終わったよ」はセッション中に反応(フキダシ・スタンプ)をくれた相手にだけ届く
- **受信側のカスタマイズ**:
  - 全体オン/オフ、「1時間オフ」「3時間オフ」「今日はオフ」のワンタップ切替
  - 通知を受け取る時間帯(夜またぎOK)
  - 人ごとのミュート(相手には分からない)
- **あえて無い機能(仕様)**: 既読・到達確認は無し。受け損ねた通知はどこにも残らない。

## 技術構成

| 役割 | 使用技術 |
|---|---|
| フロント | 素のHTML/JS/CSS(ビルド不要)、PWA |
| 認証 | Firebase Auth(Googleログイン) |
| DB | Cloud Firestore |
| プッシュ通知 | Firebase Cloud Messaging(Web Push) |
| 通知送信ロジック | Cloud Functions(`sendWorkout`、東京リージョン) |
| ホスティング | Firebase Hosting |
| デプロイ | GitHub Actions(mainにpushで自動) |

通知は**どこにも保存しない**設計(Cloud Functionsが受信者の設定を見てFCMに流すだけ)。

## 初期セットアップ(最初に1回だけ)

### 1. Firebaseプロジェクトを作る

1. https://console.firebase.google.com で「プロジェクトを追加」(名前は `imakin` など)
2. **Blazeプラン(従量課金)に切り替え**(Cloud Functionsに必要。無料枠が大きいので通常は0円)
3. **Authentication** → ログイン方法 → **Google** を有効化
4. **Firestore Database** → データベースを作成(ロケーション: `asia-northeast1`)
5. プロジェクトの設定 → 全般 → 「アプリを追加」→ **ウェブアプリ** を登録
6. 表示された `firebaseConfig` の値を以下の **2ファイル** に貼り付け:
   - `public/firebase-config.js`
   - `public/firebase-messaging-sw.js`
7. プロジェクトの設定 → **Cloud Messaging** → ウェブプッシュ証明書 → 「鍵ペアを生成」
   → その鍵を `public/firebase-config.js` の `vapidKey` に貼り付け
8. `.firebaserc` の `YOUR-PROJECT-ID` を実際のプロジェクトIDに変更

### 2. 初回デプロイ(このPCから)

```sh
npm install -g firebase-tools
firebase login
firebase deploy
```

表示された `https://<プロジェクトID>.web.app` がアプリのURL。

### 3. GitHubからの自動デプロイ(スマホ開発用)

1. Firebaseコンソール → プロジェクトの設定 → **サービスアカウント** → 「新しい秘密鍵の生成」でJSONをダウンロード
2. GitHubリポジトリ → Settings → Secrets and variables → Actions で登録:
   - `FIREBASE_SERVICE_ACCOUNT`: JSONファイルの中身を丸ごと貼り付け
   - `FIREBASE_PROJECT_ID`: プロジェクトID
3. 以降、`main` にpushするだけで自動デプロイされる

## スマホでの使い方

- **Android**: ChromeでアプリのURLを開く → メニュー → 「ホーム画面に追加」→ 設定タブで通知を許可
- **iPhone**: Safariで開く → 共有 → 「ホーム画面に追加」→ **追加したアイコンから開いて** 通知を許可(iOS 16.4以上)

## データ構造(Firestore)

```
users/{uid}                     … 公開プロフィール(名前・写真・友達コード)
users/{uid}/private/settings    … 通知設定(本人のみ閲覧可): enabled, snoozeUntil, timeStart, timeEnd, muted{}
users/{uid}/fcmTokens/{token}   … プッシュ通知の宛先(本人のみ)
friendCodes/{code}              … 友達コード → uid の逆引き
requests/{from_to}              … 友達申請
friends/{uidA_uidB}             … 友達関係(uid昇順で連結)
```

## 今後の改善候補

- 友達承認をCloud Functions経由にして、申請なしの友達作成をルールで防ぐ
- 通知のクールダウン(連打スパム防止)
- トレーニング終了時刻が過ぎたら自動で「おつかれ!」を出す、など
