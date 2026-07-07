# 音声入力+LLM解釈による筋トレ記録(実装プラン)

> ステータス: **未着手(プランのみ)**
> 前提: 終了パネルの「詳細な記録(`note`)」実装済み(2026-07 / PR #3)
> 着手条件: Anthropic APIキーの取得・Functionsシークレットへの登録

## 目的

筋トレ終了時に「ベンチ60キロ10回3セットやって、あと腕立て20回」のように**声で話すだけ**で、
LLMが種目・重量・回数・セット数を解釈して記録のサジェストを出し、タップで確定できるようにする。

現状の自由テキスト(`note`)は残しつつ、構造化データ(`exercises`)を追加する。
将来的には「ベンチプレスの重量推移グラフ」など種目別の分析につなげられる。

## 全体構成(3段階)

```
① 音声→テキスト     ブラウザのWeb Speech API(無料・APIキー不要・クライアント完結)
② テキスト→構造化   Cloud Functions(callable)経由で Claude API に投げる
③ サジェスト→確認   「腕立て 20回×1」等のチップ表示 → タップで確定 → Firestoreに保存
```

- Claude API は音声を直接受け取れないため、文字起こしはブラウザ側で行う
- ②③は入力手段に依存しない。音声が使えない環境でも「詳細な記録」欄への手入力から同じ整理フローが使える

## 段階的リリース

1. **フェーズ1: テキスト→LLM整理(②③のみ)**
   終了パネルの「詳細な記録」欄の横に「✨ 記録を整理」ボタンを置き、入力済みテキストを構造化。
   iOS音声の不確実性を切り離して、LLM解釈の品質を先に確かめる。
2. **フェーズ2: 🎤 音声入力(①)**
   `webkitSpeechRecognition`(`lang: 'ja-JP'`)で認識結果をテキスト欄に流し込む。
   非対応環境ではボタンを非表示にしてフェーズ1の挙動にフォールバック。

## ① 音声→テキスト(Web Speech API)

- `window.SpeechRecognition || window.webkitSpeechRecognition` を使用。`lang = "ja-JP"`、`interimResults = true` で認識途中もテキスト欄に反映
- **既知のリスク: iOSのPWA(ホーム画面追加)モードで音声認識が不安定**。
  対応: API が無い/`start()` が失敗する環境では🎤ボタンを出さない(機能検出でフォールバック)
- マイク許可はユーザー操作(🎤タップ)起点で要求する

## ② テキスト→構造化(Cloud Functions + Claude API)

### 関数

`sendWorkout` と同様の callable 関数を `functions/index.js` に追加:

- 名前: `parseWorkoutNote`(region: `asia-northeast1`)
- 認証必須(`req.auth` チェック)
- 入力: `{ text: string }`(200文字制限 — `note` の上限と揃える)
- 出力: `{ exercises: [...] }`(下記スキーマ)
- 乱用対策: 文字数制限に加え、必要なら1ユーザーあたり日次回数制限(Firestoreカウンタ)

### APIキー管理

- Firebase Functions のシークレットを使用: `firebase functions:secrets:set ANTHROPIC_API_KEY`
- コード側は `defineSecret("ANTHROPIC_API_KEY")` を関数の `secrets` に指定
- クライアントには一切露出しない

### Claude API 呼び出し

Node SDK `@anthropic-ai/sdk` を functions に追加。**structured outputs**(`output_config.format` に
JSONスキーマ指定)を使うことで、必ずスキーマに合致したJSONが返ることがAPI側で保証される
(パース失敗のリトライ処理がほぼ不要になる)。

```js
const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic({ apiKey: anthropicKey.value() });

const response = await client.messages.create({
  model: "claude-opus-4-8", // コスト重視なら "claude-haiku-4-5"(下記参照)
  max_tokens: 1024,
  system:
    "あなたは筋トレ記録の解析器です。日本語の話し言葉から種目・重量・回数・セット数を抽出します。" +
    "曖昧な場合は無理に埋めず省略します。種目名は一般的な名称に正規化します(例:「ベンチ」→「ベンチプレス」)。",
  messages: [{ role: "user", content: text }],
  output_config: {
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          exercises: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },        // 例: "ベンチプレス"
                weight_kg: { type: "number" },   // 自重系は省略
                reps: { type: "integer" },
                sets: { type: "integer" },
              },
              required: ["name"],
              additionalProperties: false,
            },
          },
        },
        required: ["exercises"],
        additionalProperties: false,
      },
    },
  },
});
```

### モデル選定とコスト

1回の解釈は入力 ~400トークン(system + スキーマ + 発話)・出力 ~150トークン程度の小さな抽出タスク。

| モデル | 単価(入力/出力・100万トークンあたり) | 1回あたり目安 |
|---|---|---|
| Claude Opus 4.8(`claude-opus-4-8`)— 標準の推奨 | $5 / $25 | 約0.4円 |
| Claude Haiku 4.5(`claude-haiku-4-5`)— 軽量・高速 | $1 / $5 | 約0.1円 |

- 単純抽出なので Haiku 4.5 でも十分こなせる可能性が高く、応答も速い。両方試して決めるのが早い
- 月30回使ってもコストは十数円以下。実質問題にならない
- 最新の単価・モデルIDは実装時に [Anthropic のモデル一覧](https://platform.claude.com/docs/en/about-claude/models/overview) で要確認

## ③ サジェスト→確認→保存

### UI(終了パネル)

```
詳細な記録(任意・200文字まで)
[ テキストエリア                🎤 ]
[ ✨ 記録を整理 ]
→ サジェストチップ: [ベンチプレス 60kg 10回×3 ×] [腕立て伏せ 20回×1 ×]
   (×で個別削除。誤解釈はチップを消すだけ)
[ 💪 終了する ]  ← 確定時にまとめて保存
```

- LLM呼び出し中はボタンをスピナー表示。失敗してもテキスト(`note`)はそのまま保存されるので機能劣化しない
- サジェストは**必ずユーザー確認を挟む**(勝手に保存しない)

### データモデル

`users/{uid}/sessions/{day}` に追加(既存フィールドはそのまま):

```
note:      string          // 自由テキスト(既存・原文として残す)
exercises: [                // 新規: 確定した構造化データ
  { name: "ベンチプレス", weight_kg: 60, reps: 10, sets: 3 },
  { name: "腕立て伏せ", reps: 20, sets: 1 },
]
```

- `firestore.rules`: 本人更新可フィールドに `exercises` を追加
  (現在: `['mood', 'moodAt', 'endedAt', 'doneMessage', 'note']`)
- 表示: 記録タブの履歴で `note` の代わりに(または併記で)種目リストを表示

## 実装ステップまとめ

1. [ ] Anthropic APIキー取得 → `firebase functions:secrets:set ANTHROPIC_API_KEY`
2. [ ] `functions/`: `@anthropic-ai/sdk` 追加、`parseWorkoutNote` callable 実装
3. [ ] `firestore.rules`: `exercises` を本人更新可に追加
4. [ ] 終了パネル: 「✨ 記録を整理」ボタン+サジェストチップUI(フェーズ1)
5. [ ] 記録タブ履歴に種目表示
6. [ ] 🎤ボタン+Web Speech API(フェーズ2・機能検出でフォールバック)
7. [ ] (将来)種目別の推移グラフ

## 注意点

- **APIキーは絶対にクライアント(public/)に置かない**。呼び出しは必ずFunctions経由
- 通知の「届いたかは分からない」仕様には一切影響しない(自分の記録の話のみ)
- LLM解釈が失敗・不正確でも原文 `note` が常に残る設計にする(サジェストは上乗せ機能)
- iOS PWAの音声認識は実機確認必須。ダメならフェーズ1のまま運用できる
