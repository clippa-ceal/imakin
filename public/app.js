import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, onSnapshot, runTransaction,
  serverTimestamp, deleteField, getDocs,
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

  onAuthStateChanged(auth, async (user) => {
    unsubscribers.forEach((u) => u());
    unsubscribers = [];
    me = user;
    if (!user) { showScreen("auth"); return; }
    await ensureUserDocs(user);
    showScreen("main");
    $("home-greeting").textContent = `${myProfile.name} さん、今日もやりますか`;
    $("my-code").textContent = myProfile.friendCode;
    watchSettings();
    watchRequests();
    watchFriends();
    setupMessaging().catch(console.error);
    handleUrlReply();
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
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    document.querySelectorAll(".tab-page").forEach((p) => { p.hidden = p.id !== "tab-" + tab; });
  }

  // ---------- ホーム:送信 ----------
  const untilInput = $("until-time");
  {
    const d = new Date(Date.now() + 60 * 60 * 1000); // デフォルト:1時間後まで
    untilInput.value = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  $("message").addEventListener("input", () => {
    $("msg-count").textContent = String($("message").value.length);
  });

  $("btn-send").addEventListener("click", async () => {
    const btn = $("btn-send");
    const untilTime = untilInput.value;
    const message = $("message").value.trim();
    if (!untilTime) { toast("終了時刻を入れてください"); return; }
    if (message.length > 20) { toast("メッセージは20文字までです"); return; }
    btn.disabled = true;
    try {
      const send = httpsCallable(functions, "sendWorkout");
      await send({ untilTime, message, replyTo: replyTo?.uid ?? null });
      toast(replyTo ? `${replyTo.name}さんに返信しました💪` : "送信しました💪");
      $("message").value = "";
      $("msg-count").textContent = "0";
      clearReply();
    } catch (e) {
      console.error(e);
      toast("送信に失敗しました: " + (e.message || e.code));
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- 返信 ----------
  function setReply(uid, name) {
    replyTo = { uid, name };
    $("reply-chip-text").textContent = `↩ ${name} さんへ返信`;
    $("reply-chip").hidden = false;
    switchTab("home");
  }
  function clearReply() {
    replyTo = null;
    $("reply-chip").hidden = true;
  }
  $("reply-chip-clear").addEventListener("click", clearReply);

  function handleUrlReply() {
    const p = new URLSearchParams(location.search);
    if (p.get("replyTo")) {
      setReply(p.get("replyTo"), p.get("name") || "友達");
      history.replaceState(null, "", location.pathname);
    }
  }

  // ---------- 友達 ----------
  $("my-code").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(myProfile.friendCode);
      toast("コードをコピーしました");
    } catch { /* http環境などでは失敗する */ }
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
      await setDoc(doc(db, "requests", `${me.uid}_${toUid}`), {
        from: me.uid, to: toUid, fromName: myProfile.name, fromPhoto: myProfile.photo,
        createdAt: Date.now(),
      });
      $("add-code").value = "";
      toast("申請を送りました");
    } catch (e) {
      console.error(e);
      showFriendError("申請に失敗しました");
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
      $("master-toggle").checked = mySettings.enabled !== false;
      $("time-start").value = mySettings.timeStart || "00:00";
      $("time-end").value = mySettings.timeEnd || "23:59";
      renderSnooze();
    }));
  }

  const settingsRef = () => doc(db, "users", me.uid, "private", "settings");

  $("master-toggle").addEventListener("change", (e) => updateDoc(settingsRef(), { enabled: e.target.checked }));
  $("time-start").addEventListener("change", (e) => updateDoc(settingsRef(), { timeStart: e.target.value }));
  $("time-end").addEventListener("change", (e) => updateDoc(settingsRef(), { timeEnd: e.target.value }));

  document.querySelectorAll(".snooze").forEach((btn) => {
    btn.addEventListener("click", () => {
      let until;
      if (btn.dataset.hours === "today") {
        const d = new Date();
        d.setHours(23, 59, 59, 999);
        until = d.getTime();
      } else {
        until = Date.now() + Number(btn.dataset.hours) * 3600 * 1000;
      }
      updateDoc(settingsRef(), { snoozeUntil: until });
    });
  });
  $("btn-unsnooze").addEventListener("click", () => updateDoc(settingsRef(), { snoozeUntil: 0 }));

  function renderSnooze() {
    const until = mySettings.snoozeUntil || 0;
    const active = until > Date.now();
    $("snooze-status").hidden = !active;
    $("btn-unsnooze").hidden = !active;
    if (active) {
      const d = new Date(until);
      $("snooze-status").textContent =
        `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} まで通知オフ中`;
    }
  }

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
        showBanner(d.senderUid, d.senderName || "友達", d.untilTime || "", d.message || "");
      });
    } catch (e) {
      console.error(e);
      $("perm-status").textContent = "通知の設定に失敗しました: " + (e.message || "");
    }
  }

  function showBanner(uid, name, untilTime, message) {
    $("banner-title").textContent = `💪 ${name} が筋トレ開始!`;
    $("banner-msg").textContent = `${untilTime}まで` + (message ? `「${message}」` : "");
    $("banner").hidden = false;
    $("banner-reply").onclick = () => { $("banner").hidden = true; setReply(uid, name); };
    $("banner-close").onclick = () => { $("banner").hidden = true; };
    clearTimeout(showBanner._t);
    showBanner._t = setTimeout(() => { $("banner").hidden = true; }, 15000);
  }
}
