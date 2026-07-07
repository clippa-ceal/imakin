import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, onSnapshot, runTransaction,
  serverTimestamp, deleteField, getDocs, documentId,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getMessaging, getToken, onMessage, isSupported as messagingSupported,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { firebaseConfig, vapidKey } from "./firebase-config.js";

const $ = (id) => document.getElementById(id);
const screens = { setup: $("screen-setup"), auth: $("screen-auth"), main: $("screen-main") };

function showScreen(name) {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
}

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2600);
}

// ---- Firebase未設定なら案内画面だけ出して終了 ----
if (firebaseConfig.apiKey.startsWith("PASTE")) {
  showScreen("setup");
} else {
  main();
}

function main() {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const functions = getFunctions(app, "asia-northeast1");

  let me = null;            // firebase user
  let myProfile = null;     // users/{uid} doc data
  let mySettings = null;    // users/{uid}/private/settings
  let friendProfiles = {};  // uid -> profile
  let replyTo = null;       // { uid, name }
  let unsubscribers = [];

  // ---------- 認証 ----------
  $("btn-login").addEventListener("click", async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
        await signInWithRedirect(auth, provider);
      } else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
        const err = $("auth-error");
        err.textContent = "ログインに失敗しました: " + e.code;
        err.hidden = false;
      }
    }
  });

  $("btn-logout").addEventListener("click", () => signOut(auth));

  // PWAインストール導線(Chromeがインストール可能と判断したときだけ出る)
  let deferredInstall = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e;
    $("install-card").hidden = false;
  });
  $("btn-install").addEventListener("click", async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => {});
    deferredInstall = null;
    $("install-card").hidden = true;
  });

  // 表示名の変更
  $("btn-save-name").addEventListener("click", async () => {
    const name = $("display-name").value.trim();
    if (!name) { toast("名前を入力してください"); return; }
    try {
      await updateDoc(doc(db, "users", me.uid), { name });
      myProfile.name = name;
      updateGreeting();
      toast("名前を変更しました");
    } catch (e) {
      console.error(e);
      toast("変更に失敗しました");
    }
  });

  onAuthStateChanged(auth, async (user) => {
    unsubscribers.forEach((u) => u());
    unsubscribers = [];
    me = user;
    if (!user) { exitWorkout(); showScreen("auth"); return; }
    await ensureUserDocs(user);
    showScreen("main");
    $("home-greeting").textContent = `${myProfile.name} さん、今日もやりますか`;
    $("my-code").textContent = myProfile.friendCode;
    $("display-name").value = myProfile.name;
    watchSettings();
    watchRequests();
    watchFriends();
    setupMessaging().catch(console.error);
    handleUrlReply();
    restoreWorkout(); // 終了予定+60分以内ならリロードしても筋トレ中画面に戻る
  });

  // ---------- 初回ユーザー作成 ----------
  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const randomCode = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");

  async function ensureUserDocs(user) {
    const uref = doc(db, "users", user.uid);
    const snap = await getDoc(uref);
    if (snap.exists()) { myProfile = snap.data(); return; }

    // 友達コードを衝突しないように採番
    let code = null;
    for (let i = 0; i < 5 && !code; i++) {
      const c = randomCode();
      try {
        await runTransaction(db, async (tx) => {
          const cref = doc(db, "friendCodes", c);
          const cs = await tx.get(cref);
          if (cs.exists()) throw new Error("collision");
          tx.set(cref, { uid: user.uid });
        });
        code = c;
      } catch { /* retry */ }
    }
    if (!code) throw new Error("友達コードの採番に失敗しました");

    myProfile = {
      name: user.displayName || "名無しリフター",
      photo: user.photoURL || "",
      friendCode: code,
      createdAt: Date.now(),
    };
    await setDoc(uref, myProfile);
    await setDoc(doc(db, "users", user.uid, "private", "settings"), {
      enabled: true, snoozeUntil: 0, timeStart: "00:00", timeEnd: "23:59", muted: {},
    });
  }

  // ---------- タブ切替 ----------
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  function switchTab(tab) {
    // 友達ページは設定のサブページ扱い(ナビ上は設定をハイライト)
    const navTab = tab === "friends" ? "settings" : tab;
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === navTab));
    document.querySelectorAll(".tab-page").forEach((p) => { p.hidden = p.id !== "tab-" + tab; });
    if (tab === "history") loadHistory();
    if (tab === "reply") refreshChicks(); // 友達の宣言を最新化
  }
  $("btn-open-friends").addEventListener("click", () => switchTab("friends"));
  $("btn-friends-back").addEventListener("click", () => switchTab("settings"));

  // ---------- ホーム:送信 ----------
  const untilInput = $("until-time");
  {
    const d = new Date(Date.now() + 60 * 60 * 1000); // デフォルト:1時間後まで
    untilInput.value = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  $("message").addEventListener("input", () => {
    $("msg-count").textContent = String($("message").value.length);
  });

  // 時刻プリセット:現在の設定に+N分ずつ積み上げる(+20→+5で25分後)
  const setUntilFromTs = (ts) => {
    const d = new Date(ts);
    untilInput.value = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const hhmmToTodayTs = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0); // 当日扱い(表示はHH:MMのみ見るので日付は影響しない)
    return d.getTime();
  };
  document.querySelectorAll("#time-presets .preset-chip[data-min]").forEach((b) => {
    b.addEventListener("click", () => {
      const base = untilInput.value ? hhmmToTodayTs(untilInput.value) : Date.now();
      setUntilFromTs(base + Number(b.dataset.min) * 60000);
    });
  });
  // 現在時刻に戻す(積み上げのやり直し用)
  $("btn-now-reset").addEventListener("click", () => setUntilFromTs(Date.now()));

  // 定型メッセージ
  document.querySelectorAll("#msg-presets .preset-chip").forEach((b) => {
    b.addEventListener("click", () => {
      $("message").value = b.textContent;
      $("msg-count").textContent = String(b.textContent.length);
    });
  });

  $("btn-goto-friends").addEventListener("click", () => switchTab("friends"));
  // みんなタブ:共鳴して全員に宣言(直近で始めた人の終了時刻に合わせる)
  $("btn-resonate-all").addEventListener("click", () => composeResonate(activeFriends[0]?.untilTime));

  $("btn-send").addEventListener("click", async () => {
    const btn = $("btn-send");
    const untilTime = untilInput.value;
    const message = $("message").value.trim();
    if (!untilTime) { toast("終了時刻を入れてください"); return; }
    // 現在時刻以前を選ぶと翌日扱い(24時間セッション)になってしまうので入力エラーにする
    if (untilToTs(untilTime) - Date.now() > 12 * 3600000) {
      toast("終了時刻が過去になっています。「+5分」などで未来の時刻にしてください");
      return;
    }
    if (message.length > 20) { toast("メッセージは20文字までです"); return; }
    btn.disabled = true;
    try {
      const send = httpsCallable(functions, "sendWorkout");
      await send({ untilTime, message, replyTo: replyTo?.uid ?? null });
      toast(replyTo ? `${replyTo.name}さんと一緒に筋トレ開始💪` : "みんなに宣言しました💪");
      $("message").value = "";
      $("msg-count").textContent = "0";
      const withName = replyTo?.name || "";
      clearReply();
      enterWorkout({
        endTs: untilToTs(untilTime), startTs: Date.now(),
        untilTime, message, withName, bubbles: [],
      });
      refreshChicks(); // 今日のひよこを反映
    } catch (e) {
      console.error(e);
      toast("送信に失敗しました: " + (e.message || e.code));
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- 宣言モード(通常 / 共鳴 / 一緒に筋トレ) ----------
  // 受け取った終了時刻を自分の入力にプリフィル(同じ時間で揃えやすく)
  function prefillUntil(untilTime) {
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(untilTime || "")) untilInput.value = untilTime;
  }

  // 一緒に筋トレ:その人だけに宣言(1対1)
  function composeTogether(uid, name, untilTime) {
    replyTo = { uid, name };
    prefillUntil(untilTime);
    $("reply-chip-text").textContent = `🤝 ${name} さんと一緒に筋トレ`;
    $("reply-chip").hidden = false;
    $("btn-send").textContent = `🤝 ${name} さんと筋トレ開始`;
    switchTab("declare");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // 共鳴:自分も全員に宣言(受け取った時間に合わせる)
  function composeResonate(untilTime) {
    replyTo = null;
    prefillUntil(untilTime);
    $("reply-chip-text").textContent = "🔗 共鳴して宣言(全員に届きます)";
    $("reply-chip").hidden = false;
    $("btn-send").textContent = "🔥 共鳴して宣言する";
    switchTab("declare");
    window.scrollTo({ top: 0, behavior: "smooth" });
    toast("🔗 共鳴!同じ時間で宣言しよう");
  }

  function clearReply() {
    replyTo = null;
    $("reply-chip").hidden = true;
    $("btn-send").textContent = "🔥 みんなに宣言する";
  }
  $("reply-chip-clear").addEventListener("click", clearReply);

  function handleUrlReply() {
    const p = new URLSearchParams(location.search);
    if (p.get("replyTo")) {
      composeTogether(p.get("replyTo"), p.get("name") || "友達");
      history.replaceState(null, "", location.pathname);
    }
  }

  // ---------- ひよこ(直近14日の筋トレ記録) ----------
  const CHICK_COLOR_CYCLE = ["", "c-pink", "c-green", "c-blue", "c-purple", "c-orange"];
  const CHICK_CACHE_KEY = "imakinChickCache";
  let chickCounts = {};      // uid -> 直近14日の筋トレ日数
  let chickWeek = {};        // uid -> 今週の筋トレ日数
  let chickFriendUids = [];  // 友達のuid一覧(watchFriendsが更新)
  let activeFriends = [];    // いま筋トレ中の友達 [{uid, untilTime, message, startAt}]
  let lastMood = null;       // 自分の直近の振り返り { day, mood }
  try {
    const c = JSON.parse(localStorage.getItem(CHICK_CACHE_KEY)) || {};
    chickCounts = c.counts || {};
    chickWeek = c.week || {};
  } catch { /* 破損時は無視 */ }
  let myDays = new Set();    // 自分の筋トレ日(直近14日、ストリーク計算用)

  const localDayStr = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const chickCutoffDay = () => localDayStr(Date.now() - 13 * 86400000);

  // 連続日数(今日まだやっていなくても昨日までの連続は生きている扱い)
  function streakFrom(daySet, maxDays) {
    let streak = 0;
    for (let i = 0; i < maxDays; i++) {
      if (daySet.has(localDayStr(Date.now() - i * 86400000))) streak++;
      else if (i === 0) continue;
      else break;
    }
    return streak;
  }

  // 今週(月曜はじまり)の筋トレ日数
  function thisWeekCount() {
    const dow = (new Date().getDay() + 6) % 7; // 月曜=0
    let c = 0;
    for (let i = 0; i <= dow; i++) {
      if (myDays.has(localDayStr(Date.now() - i * 86400000))) c++;
    }
    return c;
  }

  function updateGreeting() {
    if (!myProfile) return;
    const streak = streakFrom(myDays, 14);
    const goal = mySettings?.weeklyGoal || 0;
    const parts = [];
    if (streak >= 2) parts.push(`${streak}日連続🔥`);
    if (goal > 0) {
      const left = goal - thisWeekCount();
      parts.push(left > 0 ? `目標まであと${left}日` : "今週の目標達成🎉");
    }
    $("home-greeting").textContent =
      `${myProfile.name} さん、` + (parts.length ? parts.join("・") + " " : "") + "今日もやりますか";
    // 前回の振り返り
    const lm = $("last-mood");
    if (lastMood && MOOD_EMOJI[lastMood.mood]) {
      const [, m2, d2] = lastMood.day.split("-").map(Number);
      lm.hidden = false;
      lm.textContent = `前回の振り返り: ${MOOD_EMOJI[lastMood.mood]} ${MOOD_LABEL[lastMood.mood]}(${m2}/${d2})`;
    } else {
      lm.hidden = true;
    }
  }

  // 「HH:MM」の終了予定を、開始時刻を基準にタイムスタンプへ(夜またぎ対応)
  function endTsFrom(startTs, untilTime) {
    if (!startTs || !untilTime) return 0;
    const [h, m] = String(untilTime).split(":").map(Number);
    const d = new Date(startTs);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= startTs) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  async function refreshChicks() {
    if (!me) return;
    renderChicks(); // まず前回の値で即描画し、取得後に差し替える
    const cutoff = chickCutoffDay();
    const activeNow = [];
    await Promise.all([me.uid, ...chickFriendUids].map(async (uid) => {
      try {
        const snap = await getDocs(query(
          collection(db, "users", uid, "sessions"),
          where(documentId(), ">=", cutoff),
        ));
        chickCounts[uid] = snap.size;
        const weekCutoff = localDayStr(Date.now() - ((new Date().getDay() + 6) % 7) * 86400000);
        chickWeek[uid] = snap.docs.filter((d) => d.id >= weekCutoff).length;
        if (uid === me.uid) {
          myDays = new Set(snap.docs.map((d) => d.id));
          const withMood = snap.docs.filter((d) => d.data().mood)
            .sort((a, b) => (a.id < b.id ? 1 : -1))[0];
          lastMood = withMood ? { day: withMood.id, mood: withMood.data().mood } : null;
        }
        // 友達が「いま筋トレ中」かどうか(終了予定がまだ先で、終了ボタンも押していない)
        if (uid !== me.uid) {
          snap.forEach((d) => {
            const s = d.data();
            const end = endTsFrom(s.lastStartAt, s.untilTime);
            const ended = (s.endedAt || 0) >= s.lastStartAt; // 最後の開始より後に終了済み
            if (end && !ended && Date.now() < end && Date.now() - s.lastStartAt < 12 * 3600000) {
              const starts = Array.isArray(s.starts) ? s.starts : [];
              const message = starts.length ? (starts[starts.length - 1].message || "") : "";
              activeNow.push({ uid, untilTime: s.untilTime, message, startAt: s.lastStartAt });
            }
          });
        }
      } catch (e) { console.error(e); }
    }));
    activeFriends = activeNow.sort((a, b) => b.startAt - a.startAt);
    localStorage.setItem(CHICK_CACHE_KEY, JSON.stringify({ counts: chickCounts, week: chickWeek }));
    renderChicks();
    renderReplyList();
    updateGreeting();
  }

  // 「みんな」タブを開いている間は自動で最新化する
  // (友達が早めに終了したときも、開き直さなくても消えるように)
  const replyTabVisible = () =>
    me && document.visibilityState === "visible" && !$("tab-reply").hidden;
  setInterval(() => { if (replyTabVisible()) refreshChicks(); }, 60000);
  document.addEventListener("visibilitychange", () => {
    if (replyTabVisible()) refreshChicks();
  });

  // 返信タブ:いま筋トレ中の友達の宣言を一覧表示
  function renderReplyList() {
    const list = $("reply-list");
    if (!list) return;
    const badge = $("reply-badge");
    badge.hidden = activeFriends.length === 0;
    badge.textContent = String(activeFriends.length);
    // 誰か筋トレ中なら「共鳴して宣言(全員へ)」を出す
    const resonateBtn = $("btn-resonate-all");
    if (resonateBtn) resonateBtn.hidden = activeFriends.length === 0;
    list.innerHTML = "";
    if (activeFriends.length === 0) {
      list.innerHTML = `<li class="muted">いま筋トレ中の友達はいません。宣言が届くとここに出ます💪</li>`;
      return;
    }
    for (const a of activeFriends) {
      const p = friendProfiles[a.uid] || {};
      const name = p.name || "友達";
      const li = document.createElement("li");
      li.className = "reply-item";
      const img = document.createElement("img");
      img.className = "avatar"; img.src = p.photo || "icon.svg"; img.alt = "";
      const body = document.createElement("div");
      body.className = "reply-body";
      const nm = document.createElement("p");
      nm.className = "reply-name";
      nm.textContent = `${name}・〜${a.untilTime} まで`;
      const msg = document.createElement("p");
      msg.className = "reply-msg";
      msg.textContent = a.message ? `「${a.message}」` : "💪🔥";
      body.append(nm, msg);
      const like = document.createElement("button");
      like.className = "btn ghost small-btn";
      like.textContent = "👍";
      like.title = "👍を送る";
      like.addEventListener("click", () => sendQuickStamp(a.uid, name));
      const together = document.createElement("button");
      together.className = "btn primary small-btn";
      together.textContent = "🤝 一緒に";
      together.title = "一緒に筋トレ(この人に宣言)";
      together.addEventListener("click", () => composeTogether(a.uid, name, a.untilTime));
      li.append(img, body, like, together);
      list.appendChild(li);
    }
  }

  // 👍だけワンタップで送る(バナー/返信タブ共通)
  async function sendQuickStamp(uid, name) {
    try {
      await httpsCallable(functions, "sendWorkout")({ kind: "stamp", message: "👍", replyTo: uid });
      toast(`${name} さんに 👍 を送りました`);
    } catch (e) {
      console.error(e);
      toast("送れませんでした");
    }
  }

  function renderChicks() {
    const list = $("chick-list");
    if (!me) return;
    // 今週の進捗(週目標があれば ◯/◯日)
    const goal = mySettings?.weeklyGoal || 0;
    const wc = thisWeekCount();
    const wp = $("week-progress");
    wp.hidden = false;
    wp.textContent = goal > 0
      ? (wc >= goal ? `今週 ${wc}/${goal}日 — 目標達成🎉` : `今週 ${wc}/${goal}日`)
      : `今週 ${wc}日`;
    // 目標を達成した週は、その週に一度だけお祝いトースト
    if (goal > 0 && wc >= goal) {
      const weekKey = localDayStr(Date.now() - ((new Date().getDay() + 6) % 7) * 86400000);
      if (localStorage.getItem("imakinGoalCelebrated") !== weekKey) {
        localStorage.setItem("imakinGoalCelebrated", weekKey);
        toast("🎉 今週の目標を達成しました!ナイス!");
      }
    }
    list.innerHTML = "";
    const rows = [
      { uid: me.uid, name: "あなた", self: true },
      ...chickFriendUids.map((u) => ({ uid: u, name: friendProfiles[u]?.name || "友達" })),
    ];
    for (const r of rows) {
      const n = Math.min(chickCounts[r.uid] || 0, 14);
      const li = document.createElement("li");
      li.className = "chick-row" + (r.self ? " self" : "");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = r.name;
      const chicks = document.createElement("span");
      chicks.className = "chicks";
      const color = r.self ? "" : (mySettings?.chickColors?.[r.uid] || "");
      if (color) chicks.classList.add(color);
      if (n === 0) {
        const z = document.createElement("span");
        z.className = "muted small";
        z.textContent = "まだなし";
        chicks.appendChild(z);
      } else {
        const emoji = n >= 7 ? "🐔" : "🐤"; // 14日中7日以上でにわとりに育つ
        for (let i = 0; i < n; i++) {
          const c = document.createElement("span");
          c.className = "chick";
          c.textContent = emoji;
          chicks.appendChild(c);
        }
      }
      // 週目標を達成した週は王冠
      if (r.self && goal > 0 && wc >= goal) {
        const crown = document.createElement("span");
        crown.textContent = "👑";
        chicks.appendChild(crown);
      }
      // にわとりに進化した週は一度だけお祝い
      if (r.self && n >= 7) {
        const weekKey = localDayStr(Date.now() - ((new Date().getDay() + 6) % 7) * 86400000);
        if (localStorage.getItem("imakinChicken") !== weekKey) {
          localStorage.setItem("imakinChicken", weekKey);
          toast("🐔 ひよこがにわとりに進化しました!");
        }
      }
      const count = document.createElement("span");
      count.className = "chick-count";
      const total = document.createElement("span");
      total.textContent = `${n}日`;
      const wk = document.createElement("small");
      wk.textContent = `今週${chickWeek[r.uid] || 0}`;
      count.append(total, wk);
      li.append(name, chicks, count);
      if (r.self) li.addEventListener("click", () => switchTab("history"));
      else li.addEventListener("click", () => cycleChickColor(r.uid, chicks));
      list.appendChild(li);
    }
  }

  function cycleChickColor(uid, chicksEl) {
    const cur = mySettings?.chickColors?.[uid] || "";
    const next = CHICK_COLOR_CYCLE[(CHICK_COLOR_CYCLE.indexOf(cur) + 1) % CHICK_COLOR_CYCLE.length];
    CHICK_COLOR_CYCLE.forEach((c) => c && chicksEl.classList.remove(c));
    if (next) chicksEl.classList.add(next);
    if (!mySettings) mySettings = {};
    if (!mySettings.chickColors) mySettings.chickColors = {};
    mySettings.chickColors[uid] = next; // 先にローカル反映(タップの手応え優先)
    updateDoc(doc(db, "users", me.uid, "private", "settings"), {
      [`chickColors.${uid}`]: next || deleteField(),
    }).catch(console.error);
  }

  // ---------- 記録(セッション履歴) ----------
  const MOOD_EMOJI = { fire: "🔥", good: "😊", meh: "🫠" };
  const MOOD_LABEL = { fire: "やり切った", good: "ぼちぼち", meh: "さぼり気味" };

  // 週の目標設定
  document.querySelectorAll("#goal-chips .preset-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      updateDoc(settingsRef(), { weeklyGoal: Number(btn.dataset.goal) });
      toast(btn.dataset.goal === "0" ? "目標をなしにしました" : `目標を${btn.textContent}にしました💪`);
    });
  });
  function renderGoalChips() {
    const g = mySettings?.weeklyGoal || 0;
    document.querySelectorAll("#goal-chips .preset-chip").forEach((b) => {
      b.classList.toggle("active", Number(b.dataset.goal) === g);
    });
  }

  const fmtTime = (ts) => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  const HIST_CACHE_KEY = "imakinHistCache";

  async function loadHistory() {
    if (!me) return;
    // まず前回の内容を即表示して、裏で最新に差し替える
    let hasCache = false;
    try {
      const cached = JSON.parse(localStorage.getItem(HIST_CACHE_KEY));
      if (Array.isArray(cached)) { renderHistory(cached); hasCache = true; }
    } catch { /* キャッシュ破損時は無視 */ }
    if (!hasCache) $("history-list").innerHTML = `<li class="muted">読み込み中…</li>`;
    try {
      const snap = await getDocs(query(
        collection(db, "users", me.uid, "sessions"),
        where(documentId(), ">=", localDayStr(Date.now() - 59 * 86400000)),
      ));
      const entries = snap.docs.map((d) => {
        const s = d.data();
        return {
          id: d.id,
          starts: Array.isArray(s.starts) && s.starts.length
            ? s.starts
            : [{ at: s.lastStartAt, untilTime: s.untilTime || "", message: "" }],
          mood: s.mood || "",
          doneMessage: s.doneMessage || "",
          note: s.note || "",
        };
      });
      localStorage.setItem(HIST_CACHE_KEY, JSON.stringify(entries));
      renderHistory(entries);
    } catch (e) {
      console.error(e);
      if (!hasCache) {
        $("history-list").innerHTML =
          `<li class="muted">読み込みに失敗しました(${e.code || e.message || "不明なエラー"})</li>`;
      }
    }
  }

  function renderHistory(entries) {
    const list = $("history-list");
    list.innerHTML = "";
    if (entries.length === 0) {
      $("history-stats").hidden = true;
      $("mood-stats").hidden = true;
      renderWeeksView(new Set());
      list.innerHTML = `<li class="muted">まだ記録がありません。ホームから「筋トレ開始」を送ると、その日のひよこ🐤がここに並びます</li>`;
      return;
    }
    // 統計: 今月の日数と連続日数
    const ids = new Set(entries.map((x) => x.id));
    const monthPrefix = localDayStr(Date.now()).slice(0, 7);
    const monthCount = entries.filter((x) => x.id.startsWith(monthPrefix)).length;
    const streak = streakFrom(ids, 60);
    // 直近60日のベスト連続記録
    let best = 0, run = 0, prev = null;
    [...ids].sort().forEach((id) => {
      const [y, m, d] = id.split("-").map(Number);
      const t = new Date(y, m - 1, d).getTime();
      run = (prev !== null && t - prev === 86400000) ? run + 1 : 1;
      best = Math.max(best, run);
      prev = t;
    });
    let streakText = "";
    if (streak >= 2 && streak >= best) streakText = ` ・ ${streak}日連続🔥 自己ベスト🏅`;
    else if (streak >= 2) streakText = ` ・ ${streak}日連続🔥(ベスト ${best}日)`;
    else if (best >= 2) streakText = ` ・ ベスト ${best}日連続`;
    $("history-stats").hidden = false;
    $("history-stats").textContent = `今月 ${monthCount}日` + streakText;
    // 気分の集計(振り返りした日ぶん)
    const moodCount = { fire: 0, good: 0, meh: 0 };
    entries.forEach((x) => { if (moodCount[x.mood] !== undefined) moodCount[x.mood]++; });
    const totalMood = moodCount.fire + moodCount.good + moodCount.meh;
    $("mood-stats").hidden = totalMood === 0;
    if (totalMood > 0) {
      $("mood-stats").textContent = `振り返り: 🔥${moodCount.fire} 😊${moodCount.good} 🫠${moodCount.meh}`;
    }
    renderWeeksView(ids);
    const week = ["日", "月", "火", "水", "木", "金", "土"];
    const sorted = entries.slice().sort((a, b) => (a.id < b.id ? 1 : -1)); // 新しい日付順
    for (const entry of sorted) {
      const [y, mo, da] = entry.id.split("-").map(Number);
      const date = new Date(y, mo - 1, da);
      const li = document.createElement("li");
      li.className = "history-day" + (entry.id === localDayStr(Date.now()) ? " today" : "");
      li.dataset.day = entry.id;
      const head = document.createElement("div");
      head.className = "history-date";
      head.textContent = `${mo}月${da}日(${week[date.getDay()]}) `
        + "🐤".repeat(Math.min(entry.starts.length, 5))
        + (entry.mood ? ` ${MOOD_EMOJI[entry.mood] || ""}` : "");
      const ul = document.createElement("ul");
      ul.className = "history-starts";
      for (const st of entry.starts) {
        const row = document.createElement("li");
        row.textContent =
          (st.at ? fmtTime(st.at) : "--:--") +
          (st.untilTime ? ` → 〜${st.untilTime}` : "") +
          (st.message ? ` 「${st.message}」` : "");
        ul.appendChild(row);
      }
      if (entry.doneMessage) {
        const row = document.createElement("li");
        row.textContent = `🎉 「${entry.doneMessage}」`;
        ul.appendChild(row);
      }
      li.append(head, ul);
      if (entry.note) {
        const note = document.createElement("p");
        note.className = "history-note";
        note.textContent = entry.note;
        li.appendChild(note);
      }
      list.appendChild(li);
    }
  }

  // 先週+今週の14日グリッド(やった日は🐤)と、先週比較・よくやる曜日
  function renderWeeksView(ids) {
    const todayStr = localDayStr(Date.now());
    const dow = (new Date().getDay() + 6) % 7; // 月曜=0
    const thisMonday = Date.now() - dow * 86400000;
    const cal = $("dot-cal");
    cal.innerHTML = "";
    const names = ["月", "火", "水", "木", "金", "土", "日"];
    names.forEach((w) => {
      const h = document.createElement("span");
      h.className = "dow";
      h.textContent = w;
      cal.appendChild(h);
    });
    let lastWeek = 0, thisWeek = 0;
    for (let i = -7; i < 7; i++) {
      const ts = thisMonday + i * 86400000;
      const day = localDayStr(ts);
      const did = ids.has(day);
      if (did) { if (i < 0) lastWeek++; else thisWeek++; }
      const c = document.createElement("span");
      c.className = "cell";
      if (day === todayStr) c.classList.add("today");
      if (did) {
        c.textContent = "🐤";
        // タップでその日の履歴へ
        c.style.cursor = "pointer";
        c.addEventListener("click", () => {
          const target = document.querySelector(`#history-list li[data-day="${day}"]`);
          if (!target) return;
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          target.classList.add("flash");
          setTimeout(() => target.classList.remove("flash"), 1500);
        });
      }
      else if (ts > Date.now()) { c.classList.add("future"); c.textContent = "・"; }
      else { c.classList.add("miss"); c.textContent = "・"; }
      cal.appendChild(c);
    }
    const cmp = $("week-compare");
    cmp.hidden = false;
    const diff = thisWeek - lastWeek;
    cmp.textContent = `先週 ${lastWeek}日 → 今週 ${thisWeek}日`
      + (diff > 0 ? " 📈 先週超え!" : diff === 0 && thisWeek > 0 ? "(先週と同ペース)" : "");
    // よくやる曜日(直近60日で2回以上の上位2つ)
    const dowCount = [0, 0, 0, 0, 0, 0, 0];
    ids.forEach((id) => {
      const [y, m, d] = id.split("-").map(Number);
      dowCount[(new Date(y, m - 1, d).getDay() + 6) % 7]++;
    });
    const best = dowCount.map((c, i) => ({ c, i }))
      .filter((x) => x.c >= 2).sort((a, b) => b.c - a.c).slice(0, 2);
    $("dow-hint").hidden = best.length === 0;
    if (best.length) {
      $("dow-hint").textContent = `よくやる曜日: ${best.map((x) => `${names[x.i]}曜`).join("・")}`;
    }
  }

  // ---------- 筋トレ中の画面(時計 + フキダシ付箋) ----------
  const WORKOUT_KEY = "imakinWorkout";
  const BUBBLE_COLORS = ["#ffe082", "#ffab91", "#a5d6a7", "#90caf9", "#f48fb1", "#e6ee9c"];
  let workout = null;       // { endTs, untilTime, message, bubbles: [] }
  let workoutTimer = null;
  let wakeLock = null;

  function untilToTs(untilTime) {
    const [h, m] = untilTime.split(":").map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); // 夜またぎ
    return d.getTime();
  }

  function enterWorkout(state) {
    workout = state;
    saveWorkout();
    $("workout-until").textContent =
      `〜${state.untilTime} まで` + (state.withName ? `(${state.withName}さんと)` : "");
    $("workout-msg").textContent = state.message || "";
    $("workout-msg").hidden = !state.message;
    $("finish-panel").hidden = true;
    $("finish-message").value = "";
    $("finish-note").value = "";
    finishMood = null; // 前回セッションの振り返り選択を持ち越さない
    $("stamp-picker").hidden = true;
    stampTarget = null;
    $("bubble-layer").innerHTML = "";
    $("workout-hint").hidden = state.bubbles.length > 0;
    state.bubbles.forEach(renderBubble);
    $("workout-screen").hidden = false;
    clearInterval(workoutTimer);
    workoutTimer = setInterval(workoutTick, 1000);
    workoutTick();
    acquireWakeLock();
  }

  function workoutTick() {
    const now = new Date();
    $("wo-hm").textContent = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    $("wo-s").textContent = String(now.getSeconds()).padStart(2, "0");
    const left = workout.endTs - now.getTime();
    const startTs = workout.startTs || (workout.endTs - 3600000);
    const prog = Math.min(1, Math.max(0, (now.getTime() - startTs) / (workout.endTs - startTs)));
    $("wo-bar").style.width = (prog * 100).toFixed(1) + "%";
    if (left <= 0) {
      $("wo-remain").textContent = "時間だ!お疲れさま 💪";
      if (!workout.celebrated) {
        workout.celebrated = true;
        saveWorkout();
        celebrate();
      }
      return;
    }
    const s = Math.floor(left / 1000);
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    $("wo-remain").textContent =
      "あと " + (hh > 0 ? `${hh}:${String(mm).padStart(2, "0")}` : String(mm)) + `:${String(ss).padStart(2, "0")}`;
  }

  function exitWorkout() {
    workout = null;
    localStorage.removeItem(WORKOUT_KEY);
    clearInterval(workoutTimer);
    workoutTimer = null;
    $("workout-screen").hidden = true;
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }

  function saveWorkout() {
    if (workout) localStorage.setItem(WORKOUT_KEY, JSON.stringify(workout));
  }

  function restoreWorkout() {
    try {
      const s = JSON.parse(localStorage.getItem(WORKOUT_KEY));
      if (s && s.endTs > Date.now()) { enterWorkout(s); return; }
      // 終了予定を過ぎていても6時間以内なら、振り返りパネルを開いた状態で復元する
      // (時間切れ後にアプリを開き直しても記録のチャンスを失わない)
      if (s && Date.now() - s.endTs < 6 * 3600000) { enterWorkout(s); openFinishPanel(); return; }
      localStorage.removeItem(WORKOUT_KEY);
    } catch { localStorage.removeItem(WORKOUT_KEY); }
  }

  function bubbleColor(uid) {
    let h = 0;
    for (const c of String(uid)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return BUBBLE_COLORS[h % BUBBLE_COLORS.length];
  }

  function addWorkoutBubble(d) {
    const b = {
      uid: d.senderUid || "",
      name: d.senderName || "友達",
      message: d.message || "",
      untilTime: d.untilTime || "",
      kind: d.kind || "start",
      x: 4 + Math.random() * 44,   // %(フキダシの幅ぶん右端を空ける)
      y: 6 + Math.random() * 72,   // %
      tilt: +(Math.random() * 14 - 7).toFixed(1),
    };
    workout.bubbles.push(b);
    if (workout.bubbles.length > 40) workout.bubbles.shift();
    saveWorkout();
    $("workout-hint").hidden = true;
    renderBubble(b);
    navigator.vibrate?.(80); // 着弾の手応え
  }

  function renderBubble(b) {
    // 相手が押してくれたスタンプはハンコ風に表示
    if (b.kind === "stamp") {
      const el = document.createElement("div");
      el.className = "stamp-float";
      el.style.left = b.x + "%";
      el.style.top = b.y + "%";
      el.style.setProperty("--tilt", b.tilt + "deg");
      const em = document.createElement("span");
      em.className = "stamp-emoji";
      em.textContent = b.message || "👍";
      const nm = document.createElement("span");
      nm.className = "stamp-name";
      nm.textContent = b.name;
      el.append(em, nm);
      $("bubble-layer").appendChild(el);
      return;
    }
    const el = document.createElement("div");
    el.className = "bubble";
    el.style.left = b.x + "%";
    el.style.top = b.y + "%";
    el.style.setProperty("--tilt", b.tilt + "deg");
    el.style.setProperty("--bubble-bg", bubbleColor(b.uid));
    const name = document.createElement("span");
    name.className = "bubble-name";
    name.textContent =
      b.kind === "done" ? `${b.name}・筋トレ終了🎉`
      : b.untilTime ? `${b.name}・〜${b.untilTime}` : b.name;
    const msg = document.createElement("span");
    msg.className = "bubble-msg";
    msg.textContent = b.message || "💪🔥";
    el.append(name, msg);
    if (b.stamp) {
      const mark = document.createElement("span");
      mark.className = "bubble-stamp";
      mark.textContent = b.stamp;
      el.appendChild(mark);
    }
    el.addEventListener("click", () => openStampPicker(b, el));
    $("bubble-layer").appendChild(el);
    fadeOldBubbles();
  }

  // フキダシが増えすぎたら古いものを小さく薄くする(直近12個をくっきり表示)
  function fadeOldBubbles() {
    const kids = [...$("bubble-layer").children];
    const over = kids.length - 12;
    kids.forEach((el, i) => el.classList.toggle("old", i < over));
  }

  // ---------- フキダシへのスタンプ ----------
  const STAMPS = ["👍", "🔥", "💪", "🤣"];
  let stampTarget = null; // { b, el }
  {
    const picker = $("stamp-picker");
    STAMPS.forEach((s) => {
      const btn = document.createElement("button");
      btn.className = "stamp-btn";
      btn.textContent = s;
      btn.addEventListener("click", () => applyStamp(s));
      picker.appendChild(btn);
    });
    const x = document.createElement("button");
    x.className = "chip-x";
    x.textContent = "×";
    x.addEventListener("click", () => { picker.hidden = true; stampTarget = null; });
    picker.appendChild(x);
  }

  function openStampPicker(b, el) {
    stampTarget = { b, el };
    $("stamp-picker").hidden = false;
  }

  async function applyStamp(emoji) {
    if (!stampTarget) return;
    const { b, el } = stampTarget;
    stampTarget = null;
    $("stamp-picker").hidden = true;
    b.stamp = emoji;
    saveWorkout();
    let mark = el.querySelector(".bubble-stamp");
    if (!mark) {
      mark = document.createElement("span");
      mark.className = "bubble-stamp";
      el.appendChild(mark);
    }
    mark.textContent = emoji;
    if (!b.uid) return;
    try {
      const send = httpsCallable(functions, "sendWorkout");
      await send({ kind: "stamp", message: emoji, replyTo: b.uid });
      toast(`${b.name} さんに ${emoji} を送りました`);
    } catch (e) {
      console.error(e);
      toast("スタンプを送れませんでした");
    }
  }

  // 時間切れのお祝い(紙吹雪+バイブ)
  function celebrate() {
    navigator.vibrate?.([120, 60, 120]);
    const colors = ["#ff7a3c", "#ffb03c", "#a5d6a7", "#90caf9", "#f48fb1", "#ffe082"];
    const host = $("workout-screen");
    for (let i = 0; i < 26; i++) {
      const p = document.createElement("span");
      p.className = "confetti";
      p.style.left = Math.random() * 100 + "%";
      p.style.background = colors[i % colors.length];
      p.style.animationDelay = (Math.random() * 0.8).toFixed(2) + "s";
      host.appendChild(p);
      setTimeout(() => p.remove(), 4200);
    }
  }

  // 筋トレ中は画面をスリープさせない(非対応ブラウザでは何もしない)
  async function acquireWakeLock() {
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* 対応していなくてもOK */ }
  }
  document.addEventListener("visibilitychange", () => {
    if (workout && document.visibilityState === "visible") acquireWakeLock();
  });

  // ×も終了ボタンも同じ振り返りパネルを開く(終了経路は1本。「筋トレに戻る」でキャンセル可)
  $("workout-exit").addEventListener("click", () => openFinishPanel());

  // ---------- 筋トレ終了(「終わったよ」メッセージ) ----------
  // 終了報告は、セッション中に反応(フキダシ・スタンプ)をくれた相手にだけ送る
  function workoutReactedUids() {
    return [...new Set((workout?.bubbles || []).map((b) => b.uid).filter(Boolean))];
  }

  // 振り返り(気分3択)。その日のsessionsドキュメントに保存
  let finishMood = null;
  document.querySelectorAll(".mood-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      finishMood = btn.dataset.mood;
      document.querySelectorAll(".mood-btn").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });
  // 終了をセッション記録に書く(振り返り・ひとこと・詳細な記録も入力があれば一緒に)。
  // 友達側の「いま筋トレ中」判定は endedAt >= lastStartAt で「終了済み」とみなす。
  // 同じ日に2回目の終了をしても、ひとこと・詳細な記録は上書きせず追記する
  async function saveFinish(w = workout) {
    if (!w || !me) return;
    // DOMの値はawaitより前に読む(exitWorkout後や次のセッション開始でリセットされるため)
    const doneMessage = $("finish-message").value.trim();
    const note = $("finish-note").value.trim();
    const day = localDayStr(w.startTs || Date.now());
    const ref = doc(db, "users", me.uid, "sessions", day);
    const data = { endedAt: Date.now() };
    if (finishMood) { data.mood = finishMood; data.moodAt = Date.now(); }
    if (doneMessage) data.doneMessage = doneMessage;
    if (note) data.note = note;
    if (doneMessage || note) {
      try {
        const cur = (await getDoc(ref)).data() || {};
        if (doneMessage && cur.doneMessage) data.doneMessage = `${cur.doneMessage} / ${doneMessage}`;
        if (note && cur.note) data.note = `${cur.note}\n${note}`;
      } catch { /* 読めなければそのまま書く(従来の上書き挙動) */ }
    }
    try {
      await updateDoc(ref, data);
    } catch (e) {
      console.error(e);
      toast("記録の保存に失敗しました");
    }
  }

  function openFinishPanel() {
    if (!workout) return;
    const reacted = workoutReactedUids();
    finishMood = null;
    document.querySelectorAll(".mood-btn").forEach((b) => b.classList.remove("active"));
    // 「終わったよ」送信は反応をくれた人がいるときだけ選べる(既定ON)
    $("finish-send-row").hidden = reacted.length === 0;
    $("finish-send-check").checked = true;
    $("finish-send-label").textContent = `反応をくれた${reacted.length}人に「終わったよ」を送る`;
    $("finish-panel").hidden = false;
  }
  $("btn-workout-done").addEventListener("click", openFinishPanel);
  $("btn-finish-back").addEventListener("click", () => { $("finish-panel").hidden = true; });
  $("btn-finish-done").addEventListener("click", async () => {
    const btn = $("btn-finish-done");
    const reacted = workoutReactedUids();
    const message = $("finish-message").value.trim();
    btn.disabled = true;
    try {
      if (reacted.length > 0 && $("finish-send-check").checked) {
        const send = httpsCallable(functions, "sendWorkout");
        await send({ kind: "done", message, to: reacted });
        toast("筋トレ終了を知らせました🎉");
      }
      saveFinish(); // 非同期。失敗時は中でトースト表示
      $("finish-panel").hidden = true;
      exitWorkout();
    } catch (e) {
      console.error(e);
      // 終了せずパネルを残すのでやり直せる。オフラインでも送信チェックを外せば終了できる
      toast("送信に失敗しました。電波が無いときはチェックを外すと送らずに終了できます");
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- 友達 ----------
  $("my-code").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(myProfile.friendCode);
      toast("コードをコピーしました");
    } catch { /* http環境などでは失敗する */ }
  });

  // 友達コードを共有(共有シート非対応ならコピー)
  $("btn-share-code").addEventListener("click", async () => {
    const text = `イマキン💪で友達になろう!\n友達コード: ${myProfile.friendCode}\n${location.origin}`;
    try {
      if (navigator.share) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); toast("招待メッセージをコピーしました"); }
    } catch { /* 共有キャンセル時は何もしない */ }
  });

  $("btn-add-friend").addEventListener("click", async () => {
    const errEl = $("friend-error");
    errEl.hidden = true;
    const code = $("add-code").value.trim().toUpperCase();
    if (code.length !== 6) { showFriendError("6文字のコードを入力してください"); return; }
    if (code === myProfile.friendCode) { showFriendError("それはあなた自身のコードです"); return; }
    try {
      const cs = await getDoc(doc(db, "friendCodes", code));
      if (!cs.exists()) { showFriendError("そのコードのユーザーが見つかりません"); return; }
      const toUid = cs.data().uid;
      const fid = [me.uid, toUid].sort().join("_");
      if ((await getDoc(doc(db, "friends", fid))).exists()) {
        showFriendError("すでに友達です"); return;
      }
      if ((await getDoc(doc(db, "requests", `${me.uid}_${toUid}`))).exists()) {
        showFriendError("すでに申請済みです(相手の承認待ち)"); return;
      }
      if ((await getDoc(doc(db, "requests", `${toUid}_${me.uid}`))).exists()) {
        showFriendError("相手からあなたに申請が届いています。下の「届いている申請」から承認してください"); return;
      }
      await setDoc(doc(db, "requests", `${me.uid}_${toUid}`), {
        from: me.uid, to: toUid, fromName: myProfile.name, fromPhoto: myProfile.photo,
        createdAt: Date.now(),
      });
      $("add-code").value = "";
      toast("申請を送りました");
    } catch (e) {
      console.error(e);
      showFriendError("申請に失敗しました: " + (e.code || e.message || ""));
    }
  });
  function showFriendError(msg) {
    const el = $("friend-error");
    el.textContent = msg;
    el.hidden = false;
  }

  function watchRequests() {
    const q = query(collection(db, "requests"), where("to", "==", me.uid));
    unsubscribers.push(onSnapshot(q, (snap) => {
      const list = $("request-list");
      list.innerHTML = "";
      $("requests-card").hidden = snap.empty;
      $("req-badge").hidden = snap.empty;
      $("req-badge").textContent = String(snap.size);
      $("friends-req-hint").hidden = snap.empty;
      $("friends-req-hint").textContent = `⚠️ 承認待ちの友達申請が ${snap.size} 件あります`;
      snap.forEach((d) => {
        const r = d.data();
        const li = document.createElement("li");
        li.innerHTML = `
          <img class="avatar" src="${r.fromPhoto || "icon.svg"}" alt="">
          <span class="name"></span>
          <button class="btn primary small-btn ok">承認</button>
          <button class="btn ghost small-btn ng">拒否</button>`;
        li.querySelector(".name").textContent = r.fromName;
        li.querySelector(".ok").addEventListener("click", async () => {
          const fid = [r.from, r.to].sort().join("_");
          await setDoc(doc(db, "friends", fid), { users: [r.from, r.to].sort(), createdAt: Date.now() });
          await deleteDoc(doc(db, "requests", d.id));
          toast("友達になりました🤝");
        });
        li.querySelector(".ng").addEventListener("click", () => deleteDoc(doc(db, "requests", d.id)));
        list.appendChild(li);
      });
    }));
  }

  function watchFriends() {
    const q = query(collection(db, "friends"), where("users", "array-contains", me.uid));
    unsubscribers.push(onSnapshot(q, async (snap) => {
      const list = $("friend-list");
      const uids = [];
      snap.forEach((d) => {
        const other = d.data().users.find((u) => u !== me.uid);
        if (other) uids.push({ uid: other, fid: d.id });
      });
      chickFriendUids = uids.map((u) => u.uid);
      $("no-friends-card").hidden = uids.length > 0;
      refreshChicks();
      // プロフィールを取得(キャッシュ利用)
      await Promise.all(uids.map(async ({ uid }) => {
        if (!friendProfiles[uid]) {
          const s = await getDoc(doc(db, "users", uid));
          friendProfiles[uid] = s.exists() ? s.data() : { name: "退会ユーザー", photo: "" };
        }
      }));
      list.innerHTML = "";
      if (uids.length === 0) {
        list.innerHTML = `<li class="muted">まだ友達がいません</li>`;
        return;
      }
      for (const { uid, fid } of uids) {
        const p = friendProfiles[uid];
        const mutedNow = !!mySettings?.muted?.[uid];
        const li = document.createElement("li");
        li.innerHTML = `
          <img class="avatar" src="${p.photo || "icon.svg"}" alt="">
          <span class="name"></span>
          <label class="switch"><input type="checkbox" ${mutedNow ? "" : "checked"}><span class="slider"></span></label>
          <button class="chip-x del" title="友達解除">×</button>`;
        li.querySelector(".name").textContent = p.name;
        li.querySelector("input").addEventListener("change", (ev) => {
          const sref = doc(db, "users", me.uid, "private", "settings");
          updateDoc(sref, { [`muted.${uid}`]: ev.target.checked ? deleteField() : true });
        });
        li.querySelector(".del").addEventListener("click", async () => {
          if (confirm(`${p.name} さんを友達から外しますか?`)) await deleteDoc(doc(db, "friends", fid));
        });
        list.appendChild(li);
      }
    }));
  }

  // ---------- 設定 ----------
  function watchSettings() {
    const sref = doc(db, "users", me.uid, "private", "settings");
    unsubscribers.push(onSnapshot(sref, (snap) => {
      mySettings = snap.data() || {};
      $("time-start").value = mySettings.timeStart || "00:00";
      $("time-end").value = mySettings.timeEnd || "23:59";
      renderNotifyStatus();
      renderGoalChips();
      renderChicks(); // ひよこの色設定・週目標を反映
    }));
  }

  const settingsRef = () => doc(db, "users", me.uid, "private", "settings");

  $("time-start").addEventListener("change", (e) => updateDoc(settingsRef(), { timeStart: e.target.value }));
  $("time-end").addEventListener("change", (e) => updateDoc(settingsRef(), { timeEnd: e.target.value }));

  // 引退タイマー(3時間/半日/1日/無期限)
  document.querySelectorAll(".snooze").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.hours === "forever") {
        updateDoc(settingsRef(), { enabled: false, snoozeUntil: 0, snoozeSetAt: Date.now() });
        toast("無期限で引退しました。復帰を待ってます");
      } else {
        updateDoc(settingsRef(), {
          enabled: true,
          snoozeUntil: Date.now() + Number(btn.dataset.hours) * 3600 * 1000,
          snoozeSetAt: Date.now(),
        });
        toast(`${btn.textContent}の引退タイマーを設定しました`);
      }
    });
  });
  $("btn-comeback").addEventListener("click", () => {
    updateDoc(settingsRef(), { enabled: true, snoozeUntil: 0 });
    toast("💪 電撃復帰!");
  });

  // サーバー(sendWorkout)と同じ時間帯判定(夜またぎ対応)
  function nowInWindow(start, end) {
    const toMin = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; };
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const s = toMin(start || "00:00");
    const e = toMin(end || "23:59");
    return s <= e ? (cur >= s && cur <= e) : (cur >= s || cur <= e);
  }

  function untilText(ts) {
    const prefix = localDayStr(ts) === localDayStr(Date.now()) ? "今日" : "明日";
    return `${prefix} ${fmtTime(ts)}`;
  }

  // いまの受信状態と、オフならその理由を表示する
  function renderNotifyStatus() {
    if (!mySettings) return;
    const until = mySettings.snoozeUntil || 0;
    const setAt = mySettings.snoozeSetAt || 0;
    let status, reason = "";
    if (mySettings.enabled === false) {
      status = "🏝 無期限で引退中";
      reason = (setAt ? `${fmtTime(setAt)} に引退しました。` : "") + "下のボタンでいつでも復帰できます";
    } else if (until > Date.now()) {
      status = `😴 引退中(${untilText(until)} まで)`;
      reason = (setAt ? `${fmtTime(setAt)} に設定した` : "") + "引退タイマーが動いています";
    } else if (!nowInWindow(mySettings.timeStart, mySettings.timeEnd)) {
      status = "🌙 いまは受け取らない時間帯";
      reason = `受け取る時間帯が ${mySettings.timeStart || "00:00"}〜${mySettings.timeEnd || "23:59"} に設定されています`;
    } else {
      status = "✅ 通知を受け取り中";
    }
    $("notify-status").textContent = status;
    $("notify-reason").textContent = reason;
    $("notify-reason").hidden = !reason;
    $("btn-comeback").hidden = !(mySettings.enabled === false || until > Date.now());
  }
  // タイマー切れや時間帯の変わり目を表示に反映(1分ごと)
  setInterval(() => { if (me && mySettings) renderNotifyStatus(); }, 60000);

  // ---------- プッシュ通知 ----------
  async function setupMessaging() {
    const supported = await messagingSupported();
    const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    $("ios-hint").hidden = !(isIos && !standalone);

    if (!supported) {
      $("perm-status").textContent = "このブラウザはプッシュ通知に対応していません";
      $("btn-enable-push").disabled = true;
      return;
    }

    updatePermStatus();
    $("btn-enable-push").addEventListener("click", enablePush);
    if (Notification.permission === "granted") await enablePush(); // トークン更新
  }

  function updatePermStatus() {
    const p = Notification.permission;
    $("perm-status").textContent =
      p === "granted" ? "✅ この端末で通知を受け取れます"
      : p === "denied" ? "❌ ブラウザ設定で通知がブロックされています"
      : "まだ通知が許可されていません";
    $("btn-enable-push").hidden = p === "granted";
  }

  async function enablePush() {
    try {
      const perm = await Notification.requestPermission();
      updatePermStatus();
      if (perm !== "granted") return;
      const reg = await navigator.serviceWorker.register("firebase-messaging-sw.js");
      const messaging = getMessaging(app);
      const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: reg });
      if (token) {
        await setDoc(doc(db, "users", me.uid, "fcmTokens", token), {
          updatedAt: serverTimestamp(), ua: navigator.userAgent.slice(0, 200),
        });
      }
      // アプリを開いているときに届いた通知はバナー表示
      onMessage(messaging, (payload) => {
        const d = payload.data || {};
        if (workout) addWorkoutBubble(d); // 筋トレ中はフキダシ付箋で貼る
        else showBanner(d.senderUid, d.senderName || "友達", d.untilTime || "", d.message || "", d.kind || "start");
        if ((d.kind || "start") === "start") refreshChicks(); // 「いま筋トレ中」を更新
      });
    } catch (e) {
      console.error(e);
      $("perm-status").textContent = "通知の設定に失敗しました: " + (e.message || "");
    }
  }

  function showBanner(uid, name, untilTime, message, kind = "start") {
    if (kind === "done") {
      $("banner-title").textContent = `🎉 ${name} が筋トレ終了!`;
      $("banner-msg").textContent = message ? `「${message}」` : "お疲れさま!";
    } else if (kind === "stamp") {
      $("banner-title").textContent = `${name} がスタンプを押したよ`;
      $("banner-msg").textContent = message || "👍";
    } else {
      $("banner-title").textContent = `💪 ${name} が筋トレ開始!`;
      $("banner-msg").textContent = `${untilTime}まで` + (message ? `「${message}」` : "");
    }
    $("banner").hidden = false;
    // 誰かの筋トレ開始のときだけ「共鳴 / 一緒に筋トレ」を出す
    const isStart = kind === "start";
    $("banner-resonate").hidden = !isStart;
    $("banner-together").hidden = !isStart;
    $("banner-like").hidden = kind === "stamp"; // スタンプ通知には👍を出さない
    $("banner-like").onclick = () => { $("banner").hidden = true; sendQuickStamp(uid, name); };
    $("banner-resonate").onclick = () => { $("banner").hidden = true; composeResonate(untilTime); };
    $("banner-together").onclick = () => { $("banner").hidden = true; composeTogether(uid, name, untilTime); };
    $("banner-close").onclick = () => { $("banner").hidden = true; };
    clearTimeout(showBanner._t);
    // 開始通知は共鳴の判断に時間がかかるので長め、それ以外は短め
    showBanner._t = setTimeout(() => { $("banner").hidden = true; }, isStart ? 25000 : 12000);
  }
}
