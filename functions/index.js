const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();

/** "HH:MM" → 分に変換 */
const toMin = (s) => {
  const [h, m] = String(s).split(":").map(Number);
  return h * 60 + m;
};

/** 今の日本時間が start〜end の時間帯に入っているか(夜またぎ対応) */
function nowInWindow(start, end) {
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const cur = toMin(fmt.format(new Date()));
  const s = toMin(start || "00:00");
  const e = toMin(end || "23:59");
  if (s <= e) return cur >= s && cur <= e;
  return cur >= s || cur <= e; // 例: 22:00〜06:00
}

/**
 * 「今から筋トレするよ」通知を送る。
 * - 通知はどこにも保存しない(あとから参照できない仕様)
 * - 誰に届いたかは呼び出し元に返さない(既読不明の仕様)
 */
const STAMPS = ["👍", "🔥", "💪", "🤣"];

exports.sendWorkout = onCall({ region: "asia-northeast1" }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "ログインが必要です");
  const uid = req.auth.uid;

  // kind: start=筋トレ開始(既定) / done=終了報告 / stamp=フキダシへのスタンプ
  const kind = ["start", "done", "stamp"].includes(req.data?.kind) ? req.data.kind : "start";
  const untilTime = kind === "start" ? String(req.data?.untilTime || "") : "";
  const message = String(req.data?.message || "").trim();
  const replyTo = req.data?.replyTo ? String(req.data.replyTo) : null;

  if (kind === "start" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(untilTime)) {
    throw new HttpsError("invalid-argument", "終了時刻の形式が不正です");
  }
  if (kind === "stamp") {
    if (!STAMPS.includes(message)) throw new HttpsError("invalid-argument", "スタンプが不正です");
    if (!replyTo) throw new HttpsError("invalid-argument", "スタンプの宛先がありません");
  }
  if ([...message].length > 20) {
    throw new HttpsError("invalid-argument", "メッセージは20文字までです");
  }

  const senderSnap = await db.doc(`users/${uid}`).get();
  if (!senderSnap.exists) throw new HttpsError("failed-precondition", "ユーザー情報がありません");
  const senderName = senderSnap.data().name || "友達";

  // 送信先: 返信なら相手1人、通常は友達全員
  const friendsSnap = await db.collection("friends").where("users", "array-contains", uid).get();
  const friendUids = friendsSnap.docs
    .map((d) => d.data().users.find((u) => u !== uid))
    .filter(Boolean);

  let recipients;
  if (replyTo) {
    if (!friendUids.includes(replyTo)) {
      throw new HttpsError("permission-denied", "友達にしか返信できません");
    }
    recipients = [replyTo];
  } else {
    recipients = friendUids;
  }

  // 受信者ごとの設定を確認して、届けるべきトークンを集める
  const tokens = [];
  const tokenOwner = {}; // token -> uid (無効トークン削除用)
  await Promise.all(recipients.map(async (rid) => {
    const sSnap = await db.doc(`users/${rid}/private/settings`).get();
    const s = sSnap.exists ? sSnap.data() : {};
    if (s.enabled === false) return;                       // 全体オフ
    if ((s.snoozeUntil || 0) > Date.now()) return;         // 一時オフ中
    if (s.muted && s.muted[uid]) return;                   // この送信者をミュート中
    if (!nowInWindow(s.timeStart, s.timeEnd)) return;      // 時間帯の外

    const tSnap = await db.collection(`users/${rid}/fcmTokens`).get();
    tSnap.forEach((t) => { tokens.push(t.id); tokenOwner[t.id] = rid; });
  }));

  if (tokens.length > 0) {
    // data-onlyメッセージ: 表示はService Worker側で行う
    const res = await getMessaging().sendEachForMulticast({
      tokens,
      data: { senderUid: uid, senderName, untilTime, message, kind },
      webpush: { headers: { Urgency: "high", TTL: "3600" } },
    });
    // 無効になったトークンを掃除
    const cleanup = [];
    res.responses.forEach((r, i) => {
      if (!r.success && r.error?.code === "messaging/registration-token-not-registered") {
        const t = tokens[i];
        cleanup.push(db.doc(`users/${tokenOwner[t]}/fcmTokens/${t}`).delete());
      }
    });
    await Promise.all(cleanup);
  }

  // 誰に何件届いたかは意図的に返さない
  return { ok: true };
});
