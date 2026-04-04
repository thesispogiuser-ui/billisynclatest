/* ============================================================
   BILLISYNC V13 — APP.JS
   - Dedicated register page
   - No browser popups (alert/confirm replaced)
   - Reservation system for occupied tables
   - VIP tables removed (all Standard)
   - Daily / Weekly / Monthly income reports (Shopkeeper)
   - Balance per-member (Firebase accounts)
   - Free 20 mins for new registrations
   ============================================================ */

const ACCOUNTS_REF    = "billisync_accounts";
const RESERVATION_REF = "billisync_reservations";
const NOTIFICATIONS_REF = "billisync_notifications";
const REVENUE_RESET_REF = "billisync_revenue_reset";
const STORAGE_KEY     = "billisync_data";
const SESSION_KEY     = "billisync_session";
const FB_REF_NAME     = "billisync_app_v2";
const ALERT_MS        = 3 * 60 * 1000;   // 3-minute alert

const TABLES = [
  { id: 1, name: "Table 1", type: "Standard", rate: 250 },
  { id: 2, name: "Table 2", type: "Standard", rate: 250 },
  { id: 3, name: "Table 3", type: "Standard", rate: 250 },
  { id: 4, name: "Table 4", type: "Standard", rate: 250 },
  { id: 5, name: "Table 5", type: "Standard", rate: 250 },
  { id: 6, name: "Table 6", type: "Standard", rate: 250 },
];

// Built-in fallback accounts
const BUILTIN_ACCOUNTS = {
  member:     { username:"member",     password:"member123", role:"member",      name:"Juan Dela Cruz", bal:0 },
  shopkeeper: { username:"shopkeeper", password:"shop123",   role:"shopkeeper",  name:"Admin Boss",     bal:0 },
};

const INIT_STATE = () => ({
  bal: 0,
  tables: TABLES.map(t => ({ ...t, status:"available", user:null, start:null, alertAt:null, reservedBy:null, downpayment:0, walkin:false, walkinName:null })),
  logs: [],
});

let db            = null;
let stateRef      = null;
let APP           = null;
let USER          = null;
let VIEW          = "main";
let REPORT_PERIOD = "daily";
let isFirebase    = false;
let tickTimer     = null;
let alertSound    = null;
let activeAlertIds    = new Set();
let alertedPlayedIds  = new Set();
let reservations  = [];       // live list from Firebase
let membersList   = [];       // live list of member accounts
let SELECTED_MEMBER = null;  // member username being edited in balance panel
let BALANCE_INPUT_CACHE = {}; // preserves typed values across re-renders
let notifications = [];       // live notifications for current member
let revenueResetData = null;  // revenue reset tracking


/* ============================================================
   AUDIO
   ============================================================ */
function setupAudio() {
  if (alertSound) return;
  alertSound = new Audio("rickroll.mp3");
  alertSound.loop = true;
  alertSound.volume = 1.0;
}
function unlockAudio() {
  setupAudio();
  const p = alertSound.play();
  if (p) p.then(()=>{ alertSound.pause(); alertSound.currentTime=0; }).catch(()=>{});
  window.removeEventListener("click", unlockAudio);
  window.removeEventListener("keydown", unlockAudio);
  window.removeEventListener("touchstart", unlockAudio);
}
window.addEventListener("click",      unlockAudio, { once:true });
window.addEventListener("keydown",    unlockAudio, { once:true });
window.addEventListener("touchstart", unlockAudio, { once:true });

function playAlert()  { setupAudio(); if (!USER) return; alertSound.play().catch(()=>{}); }
function stopAlert()  { if (!alertSound) return; alertSound.pause(); alertSound.currentTime=0; }

// ── ARDUINO BUZZER TRIGGER ───────────────────────────────────
function triggerArduinoBuzz() {
  if (!isFirebase || !db) return;
  db.ref("billisync_buzzer/triggeredAt").set(Date.now())
    .then(()=>console.log("🔔 Arduino buzz triggered"))
    .catch(e=>console.warn("Buzz trigger failed:", e));
}


/* ============================================================
   HELPERS
   ============================================================ */
function peso(n) {
  return "₱" + Number(n||0).toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2});
}
function ftime(ms) {
  if (!ms || ms<0) return "0:00";
  const t=Math.floor(ms/1000), h=Math.floor(t/3600), m=Math.floor((t%3600)/60), s=t%60;
  if (h>0) return h+":"+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0");
  return m+":"+String(s).padStart(2,"0");
}
function timeStr(ts) { return new Date(ts).toLocaleTimeString(); }
function dateStr(ts) { return new Date(ts).toLocaleDateString("en-PH",{year:"numeric",month:"short",day:"numeric"}); }

function calcCost(startTime, rate, freeMs) {
  if (!startTime) return 0;
  let elapsed = Date.now() - startTime;
  if (freeMs && freeMs > 0) elapsed = Math.max(0, elapsed - freeMs);
  return Math.ceil((elapsed / 3600000) * rate * 100) / 100;
}

function setSyncStatus(status) {
  const el = document.getElementById("sync-indicator");
  if (!el) return;
  el.className = "sync-indicator";
  if (status==="live")  { el.classList.add("sync-live");  el.innerHTML='<span class="dot dot-on"></span> Live Sync'; }
  else if(status==="local") { el.classList.add("sync-local"); el.innerHTML="● Local Only"; }
  else                  { el.classList.add("sync-off");   el.innerHTML="● Offline"; }
}

// In-UI toast (no popups)
function toast(msg, type="info") {
  let t = document.getElementById("bs-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "bs-toast";
    document.body.appendChild(t);
  }
  t.className = "bs-toast bs-toast-"+type;
  t.textContent = msg;
  t.style.opacity = "1";
  clearTimeout(t._timer);
  t._timer = setTimeout(()=>{ t.style.opacity="0"; }, 3200);
}

// Inline error helper
function setError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hide", !msg);
}
function setSuccess(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hide", !msg);
}

/* ============================================================
   NOTIFICATIONS
   ============================================================ */
function sendNotification(username, type, message, amount) {
  if (!isFirebase || !db) return;
  const notif = {
    username, type, message, amount: amount||0,
    time: Date.now(), read: false
  };
  db.ref(NOTIFICATIONS_REF+"/"+username).push(notif);
}

function markNotifRead(key) {
  if (!USER || !isFirebase || !db) return;
  db.ref(NOTIFICATIONS_REF+"/"+USER.username+"/"+key+"/read").set(true);
}

function markAllNotifsRead() {
  if (!USER || !isFirebase || !db) return;
  notifications.forEach(n => {
    if (!n.read) db.ref(NOTIFICATIONS_REF+"/"+USER.username+"/"+n.key+"/read").set(true);
  });
  notifications = notifications.map(n => ({...n, read: true}));
  render();
}

function dismissNotif(key) {
  if (!USER || !isFirebase || !db) return;
  db.ref(NOTIFICATIONS_REF+"/"+USER.username+"/"+key).remove();
}

function getUnreadCount() {
  return notifications.filter(n => !n.read).length;
}


/* ============================================================
   PAGE ROUTING  (replaces showPage / showRegister)
   ============================================================ */
function showPage(page) {
  const pages = ["login","register","member","shop"];
  pages.forEach(p => {
    const el = document.getElementById("pg-"+p);
    if (el) el.classList.toggle("hide", p !== page);
  });
  // sync indicator only shown outside auth pages
}

function showLogin()    { showPage("login"); }
function showRegister() { showPage("register"); }


/* ============================================================
   AUTH — LOGIN / LOGOUT / REGISTER
   ============================================================ */
function togglePw() {
  const inp=document.getElementById("inp-pass");
  const btn=document.getElementById("pw-toggle-btn");
  inp.type=inp.type==="password"?"text":"password";
  btn.textContent=inp.type==="password"?"SHOW":"HIDE";
}
function toggleRegPw() {
  const inp=document.getElementById("reg-pass");
  if (!inp) return;
  inp.type=inp.type==="password"?"text":"password";
}

function doLogin(e) {
  e.preventDefault();
  const u = document.getElementById("inp-user").value.trim().toLowerCase();
  const p = document.getElementById("inp-pass").value;
  setError("login-error","");

  if (!u || !p) { setError("login-error","Enter both fields"); return; }

  const btn = document.getElementById("login-btn");
  btn.textContent="LOGGING IN..."; btn.disabled=true;

  // Try Firebase accounts first, then builtins
  function tryLogin(accounts) {
    const acc = Object.values(accounts).find(a=>a.username===u && a.password===p);
    if (!acc) {
      setError("login-error","Invalid username or password");
      btn.textContent="LOG IN"; btn.disabled=false;
      return;
    }
    USER = { ...acc };
    VIEW = "main";
    persistSession();
    document.getElementById("inp-user").value="";
    document.getElementById("inp-pass").value="";
    btn.textContent="LOG IN"; btn.disabled=false;
    // If Firebase member, refresh bal from DB to ensure up-to-date
    if (isFirebase && db && USER.role==="member") {
      db.ref(ACCOUNTS_REF+"/"+USER.username).once("value").then(snap=>{
        const fresh = snap.val();
        if (fresh) {
          USER.bal = fresh.bal||0;
          if (fresh.avatarUrl) USER.avatarUrl = fresh.avatarUrl;
          persistSession();
        }
        initDashboard();
      }).catch(()=>initDashboard());
    } else {
      initDashboard();
    }
  }

  if (isFirebase && db) {
    db.ref(ACCOUNTS_REF).once("value").then(snap=>{
      const fbAccs = snap.val() || {};
      const merged = { ...BUILTIN_ACCOUNTS, ...fbAccs };
      tryLogin(merged);
    }).catch(()=>tryLogin(BUILTIN_ACCOUNTS));
  } else {
    tryLogin(BUILTIN_ACCOUNTS);
  }
}

function doLogout() {
  USER = null; VIEW="main";
  persistSession(); stopAlert();
  showPage("login");
}

function createAccount() {
  const uname = (document.getElementById("reg-user")?.value||"").trim().toLowerCase();
  const pass  = (document.getElementById("reg-pass")?.value||"");
  const pass2 = (document.getElementById("reg-pass2")?.value||"");

  setError("reg-error","");
  setSuccess("reg-success","");

  if (!uname||!pass||!pass2)    { setError("reg-error","Please fill in all fields."); return; }
  if (pass.length < 6)          { setError("reg-error","Password must be at least 6 characters."); return; }
  if (pass !== pass2)           { setError("reg-error","Passwords do not match."); return; }
  if (BUILTIN_ACCOUNTS[uname])  { setError("reg-error","That username is reserved."); return; }

  const btn=document.getElementById("reg-btn");
  btn.textContent="Creating..."; btn.disabled=true;

  function doCreate() {
    const newAcc = { username:uname, password:pass, role:"member", name:uname, bal:0 };
    if (isFirebase && db) {
      db.ref(ACCOUNTS_REF+"/"+uname).once("value").then(snap=>{
        if (snap.exists()) {
          setError("reg-error","Username already taken. Try another.");
          btn.textContent="🎱 REGISTER NOW"; btn.disabled=false;
          return;
        }
        db.ref(ACCOUNTS_REF+"/"+uname).set(newAcc).then(()=>{
          setSuccess("reg-success","✅ Account created! Ask the shopkeeper to load your balance. Redirecting…");
          setTimeout(()=>{ clearRegForm(); showPage("login"); }, 2200);
        }).catch(()=>{
          setError("reg-error","Failed to save. Check Firebase rules.");
          btn.textContent="🎱 REGISTER NOW"; btn.disabled=false;
        });
      });
    } else {
      const local = JSON.parse(localStorage.getItem("bs_local_accounts")||"{}");
      if (local[uname]) { setError("reg-error","Username already taken."); btn.textContent="🎱 REGISTER NOW"; btn.disabled=false; return; }
      local[uname] = newAcc;
      localStorage.setItem("bs_local_accounts", JSON.stringify(local));
      setSuccess("reg-success","✅ Account created! (Local mode) Ask the shopkeeper to load your balance. Redirecting…");
      setTimeout(()=>{ clearRegForm(); showPage("login"); }, 2200);
    }
  }
  doCreate();
}

function clearRegForm() {
  ["reg-user","reg-pass","reg-pass2"].forEach(id=>{
    const el=document.getElementById(id); if(el) el.value="";
  });
  setError("reg-error",""); setSuccess("reg-success","");
  const btn=document.getElementById("reg-btn");
  if(btn){ btn.textContent="🎱 REGISTER NOW"; btn.disabled=false; }
}

function persistSession() {
  if (USER) localStorage.setItem(SESSION_KEY, JSON.stringify(USER));
  else      localStorage.removeItem(SESSION_KEY);
}

function restoreSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) USER = JSON.parse(raw);
  } catch(_) {}
}

function initDashboard() {
  if (!USER) { showPage("login"); return; }
  if (USER.role==="member")      { showPage("member"); document.getElementById("m-username").textContent=USER.name; }
  else if(USER.role==="shopkeeper"){ showPage("shop"); document.getElementById("s-username").textContent=USER.name; }
  render();
}


/* ============================================================
   FIREBASE / STATE
   ============================================================ */
function goFallback() {
  isFirebase = false; setSyncStatus("local");
  const raw = localStorage.getItem(STORAGE_KEY);
  APP = raw ? JSON.parse(raw) : INIT_STATE();
  if (!raw) localStorage.setItem(STORAGE_KEY, JSON.stringify(APP));
  window.addEventListener("storage", e=>{
    if (e.key===STORAGE_KEY && USER) { APP=JSON.parse(e.newValue); checkAlerts(); render(); }
  });
}

function saveState(ns) {
  APP = ns;
  if (isFirebase && stateRef) {
    stateRef.set(ns).catch(err=>{ console.warn(err); isFirebase=false; setSyncStatus("local"); localStorage.setItem(STORAGE_KEY,JSON.stringify(ns)); });
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ns));
  }
}

function ensureStateShape(val) {
  if (!val) return INIT_STATE();
  if (!Array.isArray(val.tables)) val.tables = INIT_STATE().tables;
  if (!Array.isArray(val.logs))   val.logs = [];
  val.tables = val.tables.map((t,i)=>({
    ...TABLES[i], ...t,
    alertAt:    t&&t.alertAt    ? t.alertAt    : null,
    reservedBy: t&&t.reservedBy ? t.reservedBy : null,
    downpayment:t&&t.downpayment? t.downpayment: 0,
    walkin:     t&&t.walkin     ? t.walkin     : false,
    walkinName: t&&t.walkinName ? t.walkinName : null,
  }));
  if (typeof val.bal !== "number") val.bal = 0;
  return val;
}

function initApp() {
  try {
    if (typeof firebaseConfig==="undefined") throw new Error("no config");
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    db = firebase.database();
    stateRef = db.ref(FB_REF_NAME);

    stateRef.on("value", snap=>{
      APP = ensureStateShape(snap.val());
      if (!snap.val()) stateRef.set(INIT_STATE());
      setSyncStatus("live"); isFirebase=true;
      checkAlerts(); render();
    }, err=>{ console.warn(err); goFallback(); checkAlerts(); render(); });

    // Listen to reservations
    db.ref(RESERVATION_REF).on("value", snap=>{
      const raw = snap.val();
      reservations = raw ? Object.entries(raw).map(([k,v])=>({key:k,...v})) : [];
      render();
    });

    // Listen to member accounts for shopkeeper member list
    db.ref(ACCOUNTS_REF).on("value", snap=>{
      const raw = snap.val() || {};
      membersList = Object.values(raw).filter(a=>a.role==="member");
      // If logged-in user is a member, sync their balance live
      if (USER && USER.role==="member") {
        const fresh = raw[USER.username];
        if (fresh && fresh.bal !== USER.bal) {
          USER.bal = fresh.bal||0;
          persistSession();
        }
      }
      render();
    });

    // Listen to notifications for current member
    if (USER && USER.role==="member") {
      db.ref(NOTIFICATIONS_REF+"/"+USER.username).on("value", snap=>{
        const raw = snap.val();
        notifications = raw ? Object.entries(raw).map(([k,v])=>({key:k,...v})).sort((a,b)=>b.time-a.time) : [];
        render();
        // Show toast for newest unread
        const newest = notifications.find(n=>!n.read);
        if (newest && (Date.now()-newest.time)<8000) {
          toast("💰 "+newest.message, "success");
        }
      });
    }

    // Listen to revenue reset tracking
    db.ref(REVENUE_RESET_REF).on("value", snap=>{
      revenueResetData = snap.val() || null;
      render();
    });

    isFirebase=true; setSyncStatus("live");
  } catch(e) { console.warn(e); goFallback(); }

  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(()=>{ if(APP){ checkAlerts(); if(USER) render(); } }, 1000);
}


/* ============================================================
   RESERVATIONS
   ============================================================ */
const DOWNPAYMENT_AMOUNT = 50; // ₱50 downpayment to reserve an available table

// Show a modal appended to <body> — survives Firebase re-renders that wipe main content
function showReservePrompt(tableId) {
  if (!USER || !APP) return;
  if ((USER.bal||0) <= 0) { toast("No balance. Ask the shopkeeper to load your account first.","warn"); return; }
  const t = (APP.tables||[]).find(x=>x.id===tableId);
  if (!t || t.status!=="available") { toast("Table is no longer available.","info"); return; }
  if ((USER.bal||0) < DOWNPAYMENT_AMOUNT) {
    toast(`Need at least ${peso(DOWNPAYMENT_AMOUNT)} balance to reserve a table.`,"warn");
    return;
  }

  // Remove any stale modal
  const old = document.getElementById("dp-modal");
  if (old) old.remove();

  const modal = document.createElement("div");
  modal.id = "dp-modal";
  modal.style.cssText = `
    position:fixed;inset:0;z-index:999;
    background:rgba(0,0,0,.72);backdrop-filter:blur(5px);
    display:flex;align-items:center;justify-content:center;padding:20px;
    opacity:0;transition:opacity .22s ease;
  `;
  modal.innerHTML = `
    <div style="
      background:linear-gradient(155deg,#1c1c1c,#242424);
      border:1.5px solid rgba(245,197,66,.35);
      border-radius:20px;padding:32px 28px 28px;
      max-width:380px;width:100%;
      box-shadow:0 0 60px rgba(245,197,66,.08),0 30px 60px rgba(0,0,0,.55);
      transform:translateY(18px) scale(.96);transition:transform .22s ease;
    " id="dp-modal-box">
      <div style="font-size:42px;text-align:center;margin-bottom:12px">🔖</div>
      <div style="font-size:19px;font-weight:800;text-align:center;color:#f5c542;margin-bottom:14px">Reserve ${t.name}?</div>
      <div style="font-size:14px;color:#ddd;text-align:center;line-height:1.65;margin-bottom:10px">
        A downpayment of <span style="color:#f5c542;font-weight:700;font-size:16px">${peso(DOWNPAYMENT_AMOUNT)}</span>
        will be deducted from your balance to hold this table exclusively for you.
      </div>
      <div style="text-align:center;font-size:13px;color:#ccc;margin-bottom:4px">
        Your balance: <strong>${peso(USER.bal||0)}</strong>
      </div>
      <div style="text-align:center;font-size:12px;color:#888;margin-bottom:16px">
        After payment: <strong>${peso((USER.bal||0)-DOWNPAYMENT_AMOUNT)}</strong>
      </div>
      <div style="
        background:rgba(245,197,66,.06);border:1px solid rgba(245,197,66,.15);
        border-radius:10px;padding:10px 12px;font-size:12px;color:#aaa;
        text-align:center;line-height:1.5;margin-bottom:22px;
      ">⚠️ No one else can use or reserve this table while you hold it.</div>
      <div style="display:flex;gap:10px">
        <button class="btn btn-ghost" style="flex:1;padding:13px;font-size:14px"
          onclick="document.getElementById('dp-modal').remove()">Cancel</button>
        <button class="btn btn-gold" style="flex:1;padding:13px;font-size:14px;font-weight:700"
          onclick="confirmReserveAvailable(${tableId})">✅ Pay ${peso(DOWNPAYMENT_AMOUNT)}</button>
      </div>
    </div>`;

  // Click backdrop to dismiss
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);

  // Animate in
  requestAnimationFrame(() => {
    modal.style.opacity = "1";
    const box = document.getElementById("dp-modal-box");
    if (box) box.style.transform = "translateY(0) scale(1)";
  });
}

function cancelReservePrompt() {
  const m = document.getElementById("dp-modal");
  if (m) m.remove();
}

// Confirm reserve — close modal, deduct downpayment, mark table reserved
function confirmReserveAvailable(tableId) {
  if (!USER || !APP) return;
  const tables = APP.tables||[];
  const t = tables.find(x=>x.id===tableId);

  // Close modal immediately so user sees the action happened
  const m = document.getElementById("dp-modal");
  if (m) m.remove();

  if (!t || t.status!=="available") { toast("Table is no longer available.","warn"); render(); return; }
  if ((USER.bal||0) < DOWNPAYMENT_AMOUNT) { toast("Insufficient balance for downpayment.","warn"); return; }

  // Deduct downpayment from member's account
  const newBal = (USER.bal||0) - DOWNPAYMENT_AMOUNT;
  if (isFirebase && db) {
    db.ref(ACCOUNTS_REF+"/"+USER.username+"/bal").set(newBal);
  }
  USER.bal = newBal;
  persistSession();

  // Mark table as reserved
  const ns = { ...APP };
  ns.tables = tables.map(x=> x.id===tableId
    ? { ...x, status:"reserved", reservedBy:USER.username, downpayment:DOWNPAYMENT_AMOUNT, start:null, user:null }
    : { ...x });
  ns.logs = [...(ns.logs||[]), {
    time:Date.now(),
    msg:USER.username+" reserved "+t.name+" — "+peso(DOWNPAYMENT_AMOUNT)+" downpayment",
    type:"reserve", amount:DOWNPAYMENT_AMOUNT, user:USER.username
  }];
  saveState(ns);
  toast(`✅ ${t.name} reserved! ${peso(DOWNPAYMENT_AMOUNT)} downpayment deducted.`,"success");
}

// Reserve an OCCUPIED table (queue only, no downpayment since table isn't free yet)
function reserveTable(tableId) {
  if (!USER || !APP) return;
  if ((USER.bal||0) <= 0) { toast("No balance. Ask the shopkeeper to load your account first.","warn"); return; }
  const t = (APP.tables||[]).find(x=>x.id===tableId);
  if (!t || t.status==="available") { toast("Table is available — you can use it directly!","info"); return; }
  if (t.status==="reserved" && t.reservedBy!==USER.username) {
    toast("This table is already reserved by someone else.","warn"); return;
  }

  const already = reservations.find(r=>r.table===tableId && r.user===USER.username);
  if (already) { toast("You already have a reservation for this table.","warn"); return; }

  if ((USER.bal||0) < DOWNPAYMENT_AMOUNT) {
    toast(`Need at least ${peso(DOWNPAYMENT_AMOUNT)} balance to join the queue.`,"warn");
    return;
  }

  const entry = { user:USER.username, name:USER.username, table:tableId, tableName:t.name, time:Date.now() };
  if (isFirebase && db) {
    db.ref(RESERVATION_REF).push(entry);
    toast("✅ You're in the queue for "+t.name,"success");
  } else {
    reservations.push({ key:"local_"+Date.now(), ...entry });
    toast("✅ Added to queue (local)","success");
    render();
  }
}

function cancelReservation(key) {
  if (isFirebase && db) {
    db.ref(RESERVATION_REF+"/"+key).remove();
    toast("Removed from queue.","info");
  } else {
    reservations = reservations.filter(r=>r.key!==key);
    toast("Removed from queue.","info");
    render();
  }
}

// Cancel a reserved-available table — refund downpayment
function cancelAvailableReservation(tableId) {
  if (!USER || !APP) return;
  const tables = APP.tables||[];
  const t = tables.find(x=>x.id===tableId);
  if (!t || t.status!=="reserved" || t.reservedBy!==USER.username) return;

  // Refund downpayment
  const refund = t.downpayment||0;
  if (refund > 0) {
    const newBal = (USER.bal||0) + refund;
    if (isFirebase && db) db.ref(ACCOUNTS_REF+"/"+USER.username+"/bal").set(newBal);
    USER.bal = newBal;
    persistSession();
  }

  const ns = { ...APP };
  ns.tables = tables.map(x=> x.id===tableId
    ? { ...x, status:"available", reservedBy:null, downpayment:0 }
    : { ...x });
  ns.logs = [...(ns.logs||[]), {
    time:Date.now(),
    msg:USER.username+" cancelled reservation for "+t.name+(refund>0?" — "+peso(refund)+" refunded":""),
    type:"cancel", user:USER.username
  }];
  saveState(ns);
  toast(refund>0 ? `Reservation cancelled. ${peso(refund)} refunded.` : "Reservation cancelled.","info");
}

function shopCancelReservation(key) { cancelReservation(key); }

// Shopkeeper cancel a reserved-available table (admin override, refund dp)
function shopCancelAvailableReservation(tableId) {
  if (!APP) return;
  const tables = APP.tables||[];
  const t = tables.find(x=>x.id===tableId);
  if (!t || t.status!=="reserved") return;

  const refund = t.downpayment||0;
  if (refund > 0 && isFirebase && db) {
    const memberAcc = membersList.find(m=>m.username===t.reservedBy);
    const currentBal = memberAcc ? (memberAcc.bal||0) : 0;
    db.ref(ACCOUNTS_REF+"/"+t.reservedBy+"/bal").set(currentBal+refund);
    const idx = membersList.findIndex(m=>m.username===t.reservedBy);
    if (idx>=0) membersList[idx].bal = currentBal+refund;
  }

  const ns = { ...APP };
  ns.tables = tables.map(x=> x.id===tableId
    ? { ...x, status:"available", reservedBy:null, downpayment:0 }
    : { ...x });
  ns.logs = [...(ns.logs||[]), {
    time:Date.now(),
    msg:"Admin cancelled reservation for "+t.name+" (@"+t.reservedBy+")"+(refund>0?" — "+peso(refund)+" refunded":""),
    type:"cancel"
  }];
  saveState(ns);
  toast("Reservation cancelled"+(refund>0?" & "+peso(refund)+" refunded":""),"info");
}


/* ============================================================
   TABLE ACTIONS
   ============================================================ */
function memberUseTable(id) {
  if (!APP||!USER) return;
  const bal = USER.bal||0;
  if (bal <= 0) { toast("No balance. Ask the shopkeeper to load your account.","warn"); return; }
  const tables = APP.tables||[];
  const target = tables.find(t=>t.id===id);
  if (!target) return;
  if (target.status==="occupied") return;
  // Block if reserved by someone else
  if (target.status==="reserved" && target.reservedBy!==USER.username) {
    toast("This table is reserved by someone else.","warn"); return;
  }

  const ns = { ...APP };
  ns.tables = tables.map(t=> t.id===id
    ? { ...t, status:"occupied", user:USER.username, start:Date.now(), freeMs:0, alertAt:null, reservedBy:null, downpayment:0 }
    : { ...t });
  // Downpayment already paid — note it in log
  const dp = target.downpayment||0;
  ns.logs = [...(ns.logs||[]), {
    time:Date.now(),
    msg:USER.username+" started "+target.name+(dp>0?" (dp: "+peso(dp)+")":""),
    type:"start", user:USER.username
  }];
  saveState(ns);

  // remove any queue reservations this user had for this table
  reservations.filter(r=>r.user===USER.username && r.table===id).forEach(r=>cancelReservation(r.key));
}

function memberStopTable(id) {
  if (!APP||!USER) return;
  const tables = APP.tables||[];
  const myTable = tables.find(t=>t.id===id && t.user===USER.username && t.status==="occupied");
  if (!myTable) return;

  const c = calcCost(myTable.start, myTable.rate, myTable.freeMs);

  // Deduct from the member's own Firebase account balance
  if (isFirebase && db) {
    const newBal = Math.max(0, (USER.bal||0) - c);
    db.ref(ACCOUNTS_REF+"/"+USER.username+"/bal").set(newBal);
    USER.bal = newBal;
    persistSession();
  }

  const ns = { ...APP };
  ns.tables = tables.map(t=> t.id===myTable.id ? { ...t, status:"available", user:null, start:null, freeMs:0, alertAt:null, reservedBy:null, downpayment:0 } : { ...t });
  ns.logs   = [...(ns.logs||[]), { time:Date.now(), msg:USER.username+" stopped "+myTable.name+" — "+peso(c)+" charged", type:"stop", amount:c, user:USER.username }];
  saveState(ns);
  triggerArduinoBuzz(); // 🔔 Tutunog ang Arduino buzzer
  activeAlertIds.delete(id); alertedPlayedIds.delete(id);
  if (!activeAlertIds.size) stopAlert();
}

function memberStopAllMyTables() {
  const my = (APP?.tables||[]).filter(t=>t.user===USER.username && t.status==="occupied");
  my.forEach(t=>memberStopTable(t.id));
}

function shopForceStop(id) {
  if (!APP) return;
  const t = (APP.tables||[]).find(x=>x.id===id);
  if (!t||t.status!=="occupied") return;
  if (t.walkin) { toast("Use 'Collect & Stop' for walk-in sessions.","warn"); return; }
  const c = calcCost(t.start, t.rate, t.freeMs);

  // Deduct from the member's own Firebase account balance
  if (isFirebase && db) {
    const memberAcc = membersList.find(m=>m.username===t.user);
    const currentBal = memberAcc ? (memberAcc.bal||0) : 0;
    const newBal = Math.max(0, currentBal - c);
    db.ref(ACCOUNTS_REF+"/"+t.user+"/bal").set(newBal);
    // Update local membersList immediately
    const idx = membersList.findIndex(m=>m.username===t.user);
    if (idx>=0) membersList[idx].bal = newBal;
    // If this is the currently logged-in member (shouldn't happen but safe)
    if (USER && USER.username===t.user) { USER.bal=newBal; persistSession(); }
  }

  const ns = { ...APP };
  ns.tables = (ns.tables||[]).map(x=> x.id===id ? { ...x, status:"available", user:null, start:null, freeMs:0, alertAt:null, reservedBy:null, downpayment:0 } : { ...x });
  ns.logs   = [...(ns.logs||[]), { time:Date.now(), msg:"Admin stopped "+t.name+" (@"+t.user+") — "+peso(c)+" charged", type:"stop", amount:c, user:t.user }];
  saveState(ns);
  triggerArduinoBuzz(); // 🔔 Tutunog ang Arduino buzzer
  activeAlertIds.delete(id); alertedPlayedIds.delete(id);
  if (!activeAlertIds.size) stopAlert();
}

function shopStopAll() {
  if (!APP) return;
  const occ = (APP.tables||[]).filter(t=>t.status==="occupied" && !t.walkin);
  if (!occ.length) { toast("No member tables are occupied.","info"); return; }
  const ns = { ...APP };
  occ.forEach(t=>{
    const c = calcCost(t.start,t.rate,t.freeMs);
    // Deduct from each member's own account
    if (isFirebase && db) {
      const memberAcc = membersList.find(m=>m.username===t.user);
      const currentBal = memberAcc ? (memberAcc.bal||0) : 0;
      const newBal = Math.max(0, currentBal - c);
      db.ref(ACCOUNTS_REF+"/"+t.user+"/bal").set(newBal);
      const idx = membersList.findIndex(m=>m.username===t.user);
      if (idx>=0) membersList[idx].bal = newBal;
    }
    ns.logs = [...(ns.logs||[]), { time:Date.now(), msg:"Admin stopped "+t.name+" (@"+t.user+") — "+peso(c)+" charged", type:"stop", amount:c, user:t.user }];
  });
  ns.tables = (ns.tables||[]).map(t=> t.walkin ? { ...t } : { ...t, status:"available", user:null, start:null, freeMs:0, alertAt:null, reservedBy:null, downpayment:0 });
  saveState(ns); activeAlertIds.clear(); alertedPlayedIds.clear(); stopAlert();
  triggerArduinoBuzz(); // 🔔 Tutunog ang Arduino buzzer
  toast("All tables stopped.","success");
}

/* ============================================================
   WALK-IN MODE
   ============================================================ */
function showWalkinModal(tableId) {
  if (!APP) return;
  const t = (APP.tables||[]).find(x=>x.id===tableId);
  if (!t || t.status!=="available") { toast("Table is not available.","warn"); return; }

  const old = document.getElementById("walkin-modal");
  if (old) old.remove();

  const modal = document.createElement("div");
  modal.id = "walkin-modal";
  modal.style.cssText = `
    position:fixed;inset:0;z-index:999;
    background:rgba(0,0,0,.72);backdrop-filter:blur(5px);
    display:flex;align-items:center;justify-content:center;padding:20px;
    opacity:0;transition:opacity .22s ease;
  `;
  modal.innerHTML = `
    <div style="
      background:linear-gradient(155deg,#1c1c1c,#242424);
      border:1.5px solid rgba(100,200,255,.25);
      border-radius:20px;padding:32px 28px 28px;
      max-width:380px;width:100%;
      box-shadow:0 0 60px rgba(100,200,255,.06),0 30px 60px rgba(0,0,0,.55);
      transform:translateY(18px) scale(.96);transition:transform .22s ease;
    " id="walkin-modal-box">
      <div style="font-size:40px;text-align:center;margin-bottom:12px">🚶</div>
      <div style="font-size:19px;font-weight:800;text-align:center;color:#64c8ff;margin-bottom:6px">Walk-In — ${t.name}</div>
      <div style="font-size:13px;color:#aaa;text-align:center;margin-bottom:20px">Start a session for a walk-in guest. Payment is collected in cash when they stop.</div>
      <label style="font-size:12px;font-weight:600;color:var(--dm);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:6px">Guest Name <span style="color:var(--dm);font-weight:400">(optional)</span></label>
      <input id="walkin-name-input" class="input" type="text" placeholder="e.g. Juan, Table 1 Guest…" maxlength="30"
        style="margin-bottom:20px"
        onkeydown="if(event.key==='Enter') confirmWalkin(${tableId})">
      <div style="display:flex;gap:10px">
        <button class="btn btn-ghost" style="flex:1;padding:13px;font-size:14px"
          onclick="document.getElementById('walkin-modal').remove()">Cancel</button>
        <button class="btn" style="flex:1;padding:13px;font-size:14px;font-weight:700;background:#1a3a4a;border:1.5px solid #64c8ff;color:#64c8ff"
          onclick="confirmWalkin(${tableId})">▶ Start Session</button>
      </div>
    </div>`;

  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
  requestAnimationFrame(()=>{
    modal.style.opacity = "1";
    const box = document.getElementById("walkin-modal-box");
    if (box) box.style.transform = "translateY(0) scale(1)";
    const inp = document.getElementById("walkin-name-input");
    if (inp) inp.focus();
  });
}

function confirmWalkin(tableId) {
  if (!APP) return;
  const tables = APP.tables||[];
  const t = tables.find(x=>x.id===tableId);
  if (!t || t.status!=="available") { toast("Table is no longer available.","warn"); const m=document.getElementById("walkin-modal"); if(m)m.remove(); return; }

  const nameInput = document.getElementById("walkin-name-input");
  const guestName = (nameInput ? nameInput.value.trim() : "") || "Walk-in Guest";

  const m = document.getElementById("walkin-modal");
  if (m) m.remove();

  const ns = { ...APP };
  const walkinUser = "walkin_"+tableId;
  ns.tables = tables.map(x=> x.id===tableId
    ? { ...x, status:"occupied", user:walkinUser, start:Date.now(), freeMs:0, alertAt:null,
        reservedBy:null, downpayment:0, walkin:true, walkinName:guestName }
    : { ...x });
  ns.logs = [...(ns.logs||[]), {
    time:Date.now(),
    msg:"Walk-in started on "+t.name+" ("+guestName+")",
    type:"start", user:walkinUser
  }];
  saveState(ns);
  toast("✅ Walk-in session started on "+t.name,"success");
}

function shopStopWalkin(id) {
  if (!APP) return;
  const t = (APP.tables||[]).find(x=>x.id===id);
  if (!t || t.status!=="occupied" || !t.walkin) return;

  const c = calcCost(t.start, t.rate, t.freeMs);
  const guestName = t.walkinName || "Walk-in Guest";

  // Show cash payment modal
  const old = document.getElementById("walkin-pay-modal");
  if (old) old.remove();

  const modal = document.createElement("div");
  modal.id = "walkin-pay-modal";
  modal.style.cssText = `
    position:fixed;inset:0;z-index:999;
    background:rgba(0,0,0,.75);backdrop-filter:blur(5px);
    display:flex;align-items:center;justify-content:center;padding:20px;
    opacity:0;transition:opacity .22s ease;
  `;
  modal.innerHTML = `
    <div style="
      background:linear-gradient(155deg,#1a2010,#222);
      border:1.5px solid rgba(80,220,80,.3);
      border-radius:20px;padding:32px 28px 28px;
      max-width:380px;width:100%;
      box-shadow:0 0 60px rgba(80,220,80,.07),0 30px 60px rgba(0,0,0,.55);
      transform:translateY(18px) scale(.96);transition:transform .22s ease;
    " id="walkin-pay-box">
      <div style="font-size:40px;text-align:center;margin-bottom:12px">💵</div>
      <div style="font-size:19px;font-weight:800;text-align:center;color:var(--gr);margin-bottom:6px">Collect Payment</div>
      <div style="font-size:13px;color:#aaa;text-align:center;margin-bottom:20px">${t.name} · ${guestName}</div>

      <div style="background:rgba(80,220,80,.07);border:1px solid rgba(80,220,80,.2);border-radius:12px;padding:16px;margin-bottom:20px;text-align:center">
        <div style="font-size:12px;color:var(--dm);margin-bottom:4px">Duration</div>
        <div style="font-size:18px;font-weight:700;color:var(--tx);margin-bottom:12px">${ftime(Date.now()-t.start)}</div>
        <div style="font-size:12px;color:var(--dm);margin-bottom:4px">Total Due (Cash)</div>
        <div style="font-size:36px;font-weight:900;color:var(--gr)">${peso(c)}</div>
      </div>

      <div style="font-size:12px;color:var(--dm);margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:1px">Cash Received</div>
      <input id="walkin-cash-input" class="input" type="number" min="0" placeholder="${c}" value="${c}"
        style="margin-bottom:8px;font-size:18px;font-weight:700;text-align:center"
        oninput="updateWalkinChange(${c})">
      <div id="walkin-change-display" style="text-align:center;font-size:14px;color:var(--gr);font-weight:700;min-height:22px;margin-bottom:20px"></div>

      <div style="display:flex;gap:10px">
        <button class="btn btn-ghost" style="flex:1;padding:13px;font-size:14px"
          onclick="document.getElementById('walkin-pay-modal').remove()">Cancel</button>
        <button class="btn btn-primary" style="flex:1;padding:13px;font-size:14px;font-weight:700"
          onclick="confirmWalkinStop(${id},${c})">✅ Paid — Stop Session</button>
      </div>
    </div>`;

  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
  requestAnimationFrame(()=>{
    modal.style.opacity = "1";
    const box = document.getElementById("walkin-pay-box");
    if (box) box.style.transform = "translateY(0) scale(1)";
    updateWalkinChange(c);
  });
}

function updateWalkinChange(totalDue) {
  const inp = document.getElementById("walkin-cash-input");
  const disp = document.getElementById("walkin-change-display");
  if (!inp || !disp) return;
  const cash = parseFloat(inp.value)||0;
  const change = cash - totalDue;
  if (cash <= 0) { disp.textContent = ""; return; }
  if (change < 0) {
    disp.style.color = "var(--dn)";
    disp.textContent = "Short by "+peso(Math.abs(change));
  } else if (change === 0) {
    disp.style.color = "var(--gr)";
    disp.textContent = "Exact change ✓";
  } else {
    disp.style.color = "var(--go)";
    disp.textContent = "Change: "+peso(change);
  }
}

function confirmWalkinStop(id, cost) {
  if (!APP) return;
  const m = document.getElementById("walkin-pay-modal");
  if (m) m.remove();

  const tables = APP.tables||[];
  const t = tables.find(x=>x.id===id);
  if (!t) return;

  const ns = { ...APP };
  ns.tables = tables.map(x=> x.id===id
    ? { ...x, status:"available", user:null, start:null, freeMs:0, alertAt:null, reservedBy:null, downpayment:0, walkin:false, walkinName:null }
    : { ...x });
  ns.logs = [...(ns.logs||[]), {
    time:Date.now(),
    msg:"Walk-in stopped "+t.name+" ("+(t.walkinName||"Guest")+") — "+peso(cost)+" cash collected",
    type:"stop", amount:cost, user:t.user
  }];
  saveState(ns);
  triggerArduinoBuzz(); // 🔔 Tutunog ang Arduino buzzer
  activeAlertIds.delete(id); alertedPlayedIds.delete(id);
  if (!activeAlertIds.size) stopAlert();
  toast("💵 "+peso(cost)+" collected — session ended","success");
}

function shopAddBalance(amt) {
  if (!APP) return;
  const ns = { ...APP };
  ns.bal  = (ns.bal||0)+amt;
  ns.logs = [...(ns.logs||[]), { time:Date.now(), msg:"Admin added "+peso(amt)+" to member balance", type:"admin", amount:amt }];
  saveState(ns); toast("Added "+peso(amt)+" to balance","success");
}

// Per-member balance (Firebase accounts)
function selectMember(username) {
  if (SELECTED_MEMBER === username) {
    delete BALANCE_INPUT_CACHE[username];
    SELECTED_MEMBER = null;
  } else {
    SELECTED_MEMBER = username;
  }
  CONFIRM_REMOVE_MEMBER = null;
  render();
}

let CONFIRM_REMOVE_MEMBER = null;

function promptRemoveMember(username) {
  CONFIRM_REMOVE_MEMBER = username;
  render();
}

function cancelRemoveMember() {
  CONFIRM_REMOVE_MEMBER = null;
  render();
}

function removeMember(username) {
  if (!username) return;
  // Block removing the built-in demo accounts
  if (username === "member" || username === "shopkeeper") {
    toast("Built-in demo accounts cannot be removed.","warn");
    CONFIRM_REMOVE_MEMBER = null;
    render();
    return;
  }
  // If member has an active session, stop it first without deducting (just free the table)
  if (APP) {
    const ns = { ...APP };
    ns.tables = (ns.tables||[]).map(t=>
      t.user === username && t.status === "occupied"
        ? { ...t, status:"available", user:null, start:null, freeMs:0, alertAt:null, reservedBy:null, downpayment:0 }
        : t
    );
    // Also clear any reservations held by this member
    ns.tables = ns.tables.map(t=>
      t.reservedBy === username && t.status === "reserved"
        ? { ...t, status:"available", reservedBy:null, downpayment:0 }
        : t
    );
    ns.logs = [...(ns.logs||[]), { time:Date.now(), msg:"Admin removed member @"+username, type:"admin" }];
    saveState(ns);
  }
  // Remove from Firebase accounts
  if (isFirebase && db) {
    db.ref(ACCOUNTS_REF+"/"+username).remove();
  }
  // Remove from local membersList
  membersList = membersList.filter(m => m.username !== username);
  SELECTED_MEMBER = null;
  CONFIRM_REMOVE_MEMBER = null;
  toast("Member @"+username+" has been removed.","success");
  render();
}

function memberAddBalance(username, amt) {
  if (!isFirebase || !db) { toast("Firebase required for per-member balance","warn"); return; }
  db.ref(ACCOUNTS_REF+"/"+username).once("value").then(snap=>{
    const acc = snap.val();
    if (!acc) { toast("Member not found","warn"); return; }
    const newBal = (acc.bal||0) + amt;
    db.ref(ACCOUNTS_REF+"/"+username+"/bal").set(newBal).then(()=>{
      // log it
      const ns = { ...APP };
      ns.logs = [...(ns.logs||[]), { time:Date.now(), msg:"Admin "+(amt>0?"added":"removed")+" "+peso(Math.abs(amt))+" "+(amt>0?"to":"from")+" @"+username, type:"admin", amount:Math.abs(amt) }];
      saveState(ns);
      // Send notification to member
      sendNotification(username, "balance_added", "Shopkeeper added "+peso(amt)+" to your account! New balance: "+peso(newBal), amt);
      toast((amt>0?"Added ":"Removed ")+peso(Math.abs(amt))+(amt>0?" to ":" from ")+"@"+username, amt>0?"success":"warn");
    });
  });
}

function memberRemoveBalance(username, amt) {
  if (!isFirebase || !db) { toast("Firebase required for per-member balance","warn"); return; }
  db.ref(ACCOUNTS_REF+"/"+username).once("value").then(snap=>{
    const acc = snap.val();
    if (!acc) { toast("Member not found","warn"); return; }
    const newBal = Math.max(0, (acc.bal||0) - amt);
    db.ref(ACCOUNTS_REF+"/"+username+"/bal").set(newBal).then(()=>{
      const ns = { ...APP };
      ns.logs = [...(ns.logs||[]), { time:Date.now(), msg:"Admin removed "+peso(amt)+" from @"+username, type:"admin", amount:amt }];
      saveState(ns);
      toast("Removed "+peso(amt)+" from @"+username,"warn");
    });
  });
}

function memberSetBalance(username) {
  const raw = (BALANCE_INPUT_CACHE[username] || "").toString().trim();
  if (raw === "") { toast("Enter an amount first","warn"); return; }
  const val = parseFloat(raw);
  if (isNaN(val) || val < 0) { toast("Enter a valid amount","warn"); return; }
  const rounded = Math.round(val * 100) / 100;

  if (isFirebase && db) {
    db.ref(ACCOUNTS_REF+"/"+username+"/bal").set(rounded).then(()=>{
      const ns = { ...APP };
      ns.logs = [...(ns.logs||[]), { time:Date.now(), msg:"Admin set @"+username+" balance to "+peso(rounded), type:"admin" }];
      saveState(ns);
      // Send notification to member
      sendNotification(username, "balance_set", "Shopkeeper updated your balance to "+peso(rounded), rounded);
      delete BALANCE_INPUT_CACHE[username];
      toast("✅ Balance set to "+peso(rounded)+" for @"+username,"success");
    }).catch(()=>{ toast("Failed to update balance","warn"); });
  } else {
    const idx = membersList.findIndex(m=>m.username===username);
    if (idx>=0) membersList[idx].bal = rounded;
    if (USER && USER.username===username) { USER.bal=rounded; persistSession(); }
    const ns = { ...APP };
    ns.logs = [...(ns.logs||[]), { time:Date.now(), msg:"Admin set @"+username+" balance to "+peso(rounded), type:"admin" }];
    saveState(ns);
    delete BALANCE_INPUT_CACHE[username];
    toast("✅ Balance set to "+peso(rounded)+" for @"+username,"success");
  }
}

function shopReset() {
  // No confirm() — use inline confirmation widget
  const body = USER.role==="shopkeeper" ? document.getElementById("s-body") : null;
  if (!body) return;
  const old = body.innerHTML;
  body.innerHTML = `
    <div class="confirm-box">
      <div style="font-size:32px;margin-bottom:8px">⚠️</div>
      <div style="font-size:17px;font-weight:700;margin-bottom:6px">Reset All Data?</div>
      <div style="color:var(--dm);font-size:13px;margin-bottom:20px">This will clear all sessions, logs, and restore default balance. This cannot be undone.</div>
      <div style="display:flex;gap:10px;justify-content:center">
        <button class="btn btn-danger" onclick="confirmReset()">Yes, Reset Everything</button>
        <button class="btn btn-ghost" onclick="render()">Cancel</button>
      </div>
    </div>`;
}

function confirmReset() {
  saveState(INIT_STATE());
  // clear all reservations
  if (isFirebase && db) db.ref(RESERVATION_REF).remove();
  else reservations = [];
  toast("System reset complete.","success");
}

/* ============================================================
   REVENUE RESET (Daily)
   ============================================================ */
function getEffectiveRevenue(logs) {
  const stopLogs = (logs||[]).filter(l=>l.type==="stop");
  const totalAllTime = stopLogs.reduce((s,l)=>s+(l.amount||0),0);
  if (!revenueResetData || !revenueResetData.lastResetTime) return totalAllTime;
  // Return only revenue earned since last reset
  const sinceReset = stopLogs.filter(l=>l.time > revenueResetData.lastResetTime);
  return sinceReset.reduce((s,l)=>s+(l.amount||0),0);
}

function showRevenueResetConfirm() {
  const old = document.getElementById("rev-reset-modal");
  if (old) old.remove();

  const modal = document.createElement("div");
  modal.id = "rev-reset-modal";
  modal.style.cssText = `
    position:fixed;inset:0;z-index:999;
    background:rgba(0,0,0,.76);backdrop-filter:blur(6px);
    display:flex;align-items:center;justify-content:center;padding:20px;
    opacity:0;transition:opacity .22s ease;
  `;
  const lastReset = revenueResetData?.lastResetTime ? new Date(revenueResetData.lastResetTime).toLocaleString("en-PH") : "Never";
  modal.innerHTML = `
    <div style="
      background:linear-gradient(155deg,#1c1200,#1a1a1a);
      border:1.5px solid rgba(245,197,66,.3);
      border-radius:20px;padding:32px 28px 28px;
      max-width:380px;width:100%;
      box-shadow:0 0 60px rgba(245,197,66,.08),0 30px 60px rgba(0,0,0,.55);
      transform:translateY(18px) scale(.96);transition:transform .22s ease;
    " id="rev-reset-box">
      <div style="font-size:40px;text-align:center;margin-bottom:12px">🔄</div>
      <div style="font-size:19px;font-weight:800;text-align:center;color:var(--go);margin-bottom:10px">Reset Daily Revenue?</div>
      <div style="font-size:13px;color:#ccc;text-align:center;line-height:1.65;margin-bottom:14px">
        This resets the <strong>Total Revenue</strong> counter to ₱0.00. All session logs are preserved — only the revenue display is reset.
      </div>
      <div style="background:rgba(245,197,66,.06);border:1px solid rgba(245,197,66,.15);border-radius:10px;padding:10px 14px;text-align:center;margin-bottom:22px;font-size:12px;color:#aaa">
        Last reset: <strong style="color:var(--go)">${lastReset}</strong>
      </div>
      <div style="display:flex;gap:10px">
        <button class="btn btn-ghost" style="flex:1;padding:13px" onclick="document.getElementById('rev-reset-modal').remove()">Cancel</button>
        <button class="btn btn-gold" style="flex:1;padding:13px;font-weight:700" onclick="confirmRevenueReset()">✅ Reset Revenue</button>
      </div>
    </div>`;
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
  requestAnimationFrame(()=>{
    modal.style.opacity = "1";
    const box = document.getElementById("rev-reset-box");
    if (box) box.style.transform = "translateY(0) scale(1)";
  });
}

function confirmRevenueReset() {
  const m = document.getElementById("rev-reset-modal");
  if (m) m.remove();
  const resetData = { lastResetTime: Date.now(), resetBy: USER.username };
  if (isFirebase && db) {
    db.ref(REVENUE_RESET_REF).set(resetData);
  } else {
    revenueResetData = resetData;
  }
  const ns = { ...APP };
  ns.logs = [...(ns.logs||[]), { time:Date.now(), msg:"Admin reset daily revenue counter", type:"admin" }];
  saveState(ns);
  toast("✅ Revenue counter reset to ₱0.00","success");
}


/* ============================================================
   ALERTS
   ============================================================ */
function checkAlerts() {
  if (!APP||!USER) { activeAlertIds.clear(); stopAlert(); return; }
  const now=Date.now(), tables=APP.tables||[];
  const shouldAlert = new Set();

  tables.forEach(t=>{
    if (t.status==="occupied" && t.start && (now-t.start)>=ALERT_MS) {
      // Only alert shopkeeper, or the member who owns this specific table
      if (USER.role==="shopkeeper" || t.user===USER.username) {
        shouldAlert.add(t.id);
      }
    }
  });

  shouldAlert.forEach(id=>{ if(!alertedPlayedIds.has(id)){ alertedPlayedIds.add(id); playAlert(); } });
  alertedPlayedIds.forEach(id=>{ if(!shouldAlert.has(id)) alertedPlayedIds.delete(id); });
  activeAlertIds = shouldAlert;
  if (!activeAlertIds.size) stopAlert();
}


/* ============================================================
   REPORTS HELPERS
   ============================================================ */
function getReportLogs(period) {
  const logs = (APP?.logs||[]).filter(l=>l.type==="stop");
  const now = Date.now();
  return logs.filter(l=>{
    if (period==="daily")   return (now-l.time) < 86400000;
    if (period==="weekly")  return (now-l.time) < 7*86400000;
    if (period==="monthly") return (now-l.time) < 30*86400000;
    return true;
  });
}

function buildReportHTML() {
  const period = REPORT_PERIOD;
  const logs   = getReportLogs(period);
  const total  = logs.reduce((s,l)=>s+(l.amount||parseFloat((l.msg||"").match(/₱([\d,.]+)/)?.[1]?.replace(/,/g,"")||"0")),0);
  const sessions = logs.length;

  // Group by day for chart bars
  const byDay = {};
  logs.forEach(l=>{
    const d = new Date(l.time).toLocaleDateString("en-PH",{month:"short",day:"numeric"});
    byDay[d]=(byDay[d]||0)+(l.amount||0);
  });
  const days = Object.entries(byDay).slice(-7);
  const maxVal = Math.max(...days.map(d=>d[1]),1);

  const periodLabel = { daily:"Today", weekly:"This Week", monthly:"This Month" }[period];

  let h = `
    <div class="report-header">
      <div>
        <div style="font-size:20px;font-weight:700">📊 Income Report — ${periodLabel}</div>
        <div style="color:var(--dm);font-size:13px;margin-top:2px">${sessions} session(s) completed</div>
      </div>
      <div class="period-tabs">
        <button class="period-tab ${period==="daily"?"active":""}"   onclick="setReportPeriod('daily')">Daily</button>
        <button class="period-tab ${period==="weekly"?"active":""}"  onclick="setReportPeriod('weekly')">Weekly</button>
        <button class="period-tab ${period==="monthly"?"active":""}" onclick="setReportPeriod('monthly')">Monthly</button>
      </div>
    </div>

    <div class="stats-grid" style="margin-bottom:20px">
      <div class="stat-card"><div class="label">Total Income</div><div class="value green">${peso(total)}</div></div>
      <div class="stat-card"><div class="label">Sessions</div><div class="value">${sessions}</div></div>
      <div class="stat-card"><div class="label">Avg per Session</div><div class="value gold">${sessions?peso(total/sessions):"—"}</div></div>
      <div class="stat-card"><div class="label">Period</div><div class="value" style="font-size:14px">${periodLabel}</div></div>
    </div>`;

  // Bar chart
  if (days.length) {
    h += `<div class="report-chart-wrap">
      <div style="font-size:13px;font-weight:700;margin-bottom:12px;color:var(--dm);text-transform:uppercase;letter-spacing:1px">Revenue by Day</div>
      <div class="bar-chart">`;
    days.forEach(([d,v])=>{
      const pct = Math.max(4, Math.round((v/maxVal)*100));
      h += `<div class="bar-col">
        <div class="bar-label-top">${peso(v)}</div>
        <div class="bar-bar" style="height:${pct}%"></div>
        <div class="bar-label">${d}</div>
      </div>`;
    });
    h += `</div></div>`;
  } else {
    h += `<div class="empty-state"><div class="icon">📈</div><div class="title">No data yet</div><div class="sub">Completed sessions will appear here.</div></div>`;
  }

  // Table breakdown
  if (sessions) {
    const byTable = {};
    logs.forEach(l=>{
      const m = (l.msg||"").match(/stopped (Table \d+)/);
      const nm = m?m[1]:"Other";
      byTable[nm]=(byTable[nm]||0)+(l.amount||0);
    });
    h += `<div class="report-table-wrap">
      <div style="font-size:13px;font-weight:700;margin-bottom:10px;color:var(--dm);text-transform:uppercase;letter-spacing:1px">Breakdown by Table</div>`;
    Object.entries(byTable).forEach(([nm,v])=>{
      const pct = Math.round((v/total)*100);
      h += `<div class="report-row">
        <span style="font-weight:600">${nm}</span>
        <div style="flex:1;margin:0 12px;background:rgba(255,255,255,.05);border-radius:4px;height:6px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:var(--gr);border-radius:4px"></div>
        </div>
        <span class="green">${peso(v)}</span>
        <span class="dim" style="font-size:11px;width:32px;text-align:right">${pct}%</span>
      </div>`;
    });
    h += `</div>`;
  }

  // Recent log
  h += `<div style="margin-top:20px">
    <div style="font-size:13px;font-weight:700;margin-bottom:10px;color:var(--dm);text-transform:uppercase;letter-spacing:1px">Recent Completed Sessions</div>
    <div class="log-wrap">`;
  if (!logs.length) h+=`<div class="log-empty">No sessions in this period</div>`;
  [...logs].reverse().slice(0,20).forEach(l=>{
    h+=`<div class="log-item">
      <span style="color:var(--go)">${l.msg}</span>
      <span class="dim" style="font-size:10px;white-space:nowrap">${dateStr(l.time)} ${timeStr(l.time)}</span>
    </div>`;
  });
  h += `</div></div>`;
  return h;
}

function setReportPeriod(p) { REPORT_PERIOD=p; render(); }


/* ============================================================
   RENDER — MEMBER
   ============================================================ */
function renderMember(now, tables, logs, bal) {
  // Always use the member's own balance from USER object (kept live via Firebase listener)
  const myBal = USER.bal || 0;

  document.getElementById("m-nav").innerHTML = [
    ["main","📊 Dashboard"], ["tables","🎱 Tables"], ["reservations","🔖 My Reservations"], ["account","👤 Account"],
  ].map(([k,l])=>{
    const isCurrent = VIEW===k;
    return `<button class="nav-btn ${isCurrent?"active-green":""}" onclick="setView('${k}')">${l}</button>`;
  }).join("");

  const body    = document.getElementById("m-body");
  const myTables= tables.filter(t=>t.user===USER.username && t.status==="occupied");
  const totalCost=myTables.reduce((s,t)=>s+calcCost(t.start,t.rate,t.freeMs),0);
  const avail   = tables.filter(t=>t.status==="available").length;
  const occ     = tables.filter(t=>t.status==="occupied").length;
  const myLogs  = logs.filter(l=>l.msg&&l.msg.includes(USER.username));
  const myReservations = reservations.filter(r=>r.user===USER.username);

  let h="";

  if (VIEW==="main") {
    h += `<div class="stats-grid">
      <div class="stat-card"><div class="label">Balance</div><div class="value" style="color:${myBal<=0?"var(--dn)":myBal<200?"var(--go)":"var(--gr)"}">${peso(myBal)}</div></div>
      <div class="stat-card"><div class="label">Active Tables</div><div class="value" style="color:${myTables.length?"var(--go)":"#555"}">${myTables.length||"None"}</div></div>
      <div class="stat-card"><div class="label">Running Cost</div><div class="value" style="color:${totalCost>myBal?"var(--dn)":"var(--go)"}">${myTables.length?peso(totalCost):"—"}</div></div>
      <div class="stat-card"><div class="label">Sessions</div><div class="value">${myLogs.filter(l=>l.type==="start").length}</div></div>
    </div>`;

    if (myTables.length) {
      h += `<div class="session-banner" style="flex-direction:column;gap:12px">
        <div><div class="session-banner-title">Your Active Tables</div><div class="session-banner-sub">${myTables.length} active · alert at 3 min</div></div>
        <div class="mini-list" style="width:100%">`;
      myTables.forEach(t=>{
        const elapsed=now-t.start, isAlert=elapsed>=ALERT_MS;
        h+=`<div class="mini-card">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
            <div>
              <div class="session-banner-title">${t.name} ${isAlert?'<span class="badge-alert">🚨 ALERT</span>':''}</div>
              <div class="session-banner-sub">${peso(t.rate)}/hr · ⏱ ${ftime(elapsed)} · ${peso(calcCost(t.start,t.rate,t.freeMs))}</div>
            </div>
            <button class="btn btn-danger" onclick="memberStopTable(${t.id})">⬛ Stop & Pay</button>
          </div>
        </div>`;
      });
      h+=`</div></div>`;
      if (activeAlertIds.size) h+=`<div class="alert-strip">🚨 Time alert active. End your session to stop the alarm.</div>`;
    } else if (myBal > 0) {
      h+=`<div class="empty-state"><div class="icon">🎱</div><div class="title">No active session</div><div class="sub">Pick a table to start playing.</div><button class="btn btn-primary" onclick="setView('tables')">Browse Tables →</button></div>`;
    } else {
      h+=`<div class="empty-state-danger">
        <div class="icon" style="font-size:40px;margin-bottom:8px">💸</div>
        <div class="red" style="font-size:16px;font-weight:600">No Balance</div>
        <div class="dim" style="font-size:13px;margin-top:6px">Ask the shopkeeper to load balance onto your account.</div>
      </div>`;
    }

  } else if (VIEW==="tables") {
    const reserved = tables.filter(t=>t.status==="reserved").length;
    h+=`<div class="section-header"><div class="section-title"><span class="green">●</span> Choose a Table</div>
      <span class="dim" style="font-size:12px">${avail} free · ${reserved} reserved · ${occ} occupied</span>
    </div>`;

    if (myBal <= 0) {
      h+=`<div class="alert-strip" style="margin-bottom:14px">💸 You have no balance. The shopkeeper needs to load your account before you can use or reserve a table.</div>`;
    }

    h+=`<div class="table-grid">`;
    tables.forEach(t=>{
      const isOcc      = t.status==="occupied";
      const isReserved = t.status==="reserved";
      const isFree     = t.status==="available";
      const isMine     = t.user===USER.username;
      const isMyReserve= isReserved && t.reservedBy===USER.username;
      const isOthersRes= isReserved && t.reservedBy!==USER.username;
      const elapsed    = isOcc&&t.start ? now-t.start : 0;
      const isAlert    = isOcc && elapsed>=ALERT_MS;

      // Card border colour
      let cardClass = "table-card";
      if (isOcc)      cardClass += " occupied";
      if (isMyReserve)cardClass += " reserved-mine";
      if (isOthersRes)cardClass += " reserved-other";

      // Status label & colour
      let statusLabel, statusColor;
      if (isFree)          { statusLabel="Available";          statusColor="var(--gr)"; }
      else if (isMyReserve){ statusLabel="Reserved by You";    statusColor="var(--go)"; }
      else if (isOthersRes){ statusLabel="Reserved";           statusColor="#e67e22"; }
      else if (isMine)     { statusLabel="Your Session";       statusColor="var(--go)"; }
      else                 { statusLabel="Occupied";           statusColor="var(--dn)"; }

      h+=`<div class="${cardClass}">
        <div class="table-card-head"><span class="table-card-name">${t.name}</span><span class="badge badge-std">Standard</span></div>
        <div class="table-card-status">
          <span class="dot" style="background:${isFree?"var(--gr)":isMyReserve||isOthersRes?"#e67e22":"#e74c3c"};width:7px;height:7px;border-radius:50%;display:inline-block"></span>
          <span style="font-size:12px;color:${statusColor};font-weight:600;margin-left:4px">${statusLabel}</span>
          ${isAlert?'<span class="badge-alert">🚨 ALERT</span>':""}
        </div>
        <div class="table-card-rate">${peso(t.rate)}/hr</div>`;

      if (isOcc && t.start) {
        h+=`<div class="table-card-timer">⏱ ${ftime(elapsed)} — ${peso(calcCost(t.start,t.rate,t.freeMs))}</div>`;
      }
      if (isMyReserve) {
        h+=`<div style="font-size:11px;color:var(--go);margin-bottom:6px">🔖 Downpayment paid: ${peso(t.downpayment||0)}</div>`;
      }
      if (isOthersRes) {
        h+=`<div style="font-size:11px;color:#e67e22;margin-bottom:6px">🔒 Reserved by @${t.reservedBy}</div>`;
      }

      // ACTION BUTTONS
      if (isFree && myBal > 0) {
        h+=`<div style="display:flex;gap:6px;margin-bottom:6px">
          <button class="btn btn-primary btn-sm" style="flex:1" onclick="memberUseTable(${t.id})">▶ Use Now</button>
          <button class="btn btn-gold btn-sm" style="flex:1" onclick="showReservePrompt(${t.id})">🔖 Reserve</button>
        </div>`;
      } else if (isFree && myBal <= 0) {
        h+=`<button class="btn btn-ghost btn-full btn-sm" disabled>🔒 No Balance</button>`;
      } else if (isMyReserve) {
        h+=`<div style="display:flex;gap:6px">
          <button class="btn btn-primary btn-full btn-sm" style="flex:1" onclick="memberUseTable(${t.id})">▶ Start Session</button>
          <button class="btn btn-ghost btn-sm" onclick="cancelAvailableReservation(${t.id})">✖</button>
        </div>`;
      } else if (isOthersRes) {
        h+=`<button class="btn btn-ghost btn-full btn-sm" disabled>🔒 Table Reserved</button>`;
      } else if (isMine) {
        h+=`<button class="btn btn-danger btn-full btn-sm" onclick="memberStopTable(${t.id})">⬛ End Session</button>`;
      } else if (isOcc && !isMine) {
        h+=`<button class="btn btn-ghost btn-full btn-sm" disabled>🔒 Table Occupied</button>`;
      }

      h+=`</div>`;
    });
    h+=`</div>`;

  } else if (VIEW==="reservations") {
    h+=`<div class="section-header"><div class="section-title">🔖 My Reservations</div></div>`;
    const myReservedTables = tables.filter(t=>t.status==="reserved" && t.reservedBy===USER.username);
    const myQueueReservations = reservations.filter(r=>r.user===USER.username);
    const hasAny = myReservedTables.length || myQueueReservations.length;

    if (!hasAny) {
      h+=`<div class="empty-state"><div class="icon">🔖</div><div class="title">No reservations</div>
        <div class="sub">On the Tables page you can reserve an available table.</div>
        <button class="btn btn-primary" onclick="setView('tables')">View Tables →</button></div>`;
    } else {
      h+=`<div class="mini-list">`;

      // Reserved tables (downpayment paid, table locked for you)
      myReservedTables.forEach(t=>{
        h+=`<div class="mini-card" style="border-color:var(--go)">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
            <div>
              <div style="font-weight:700">🔒 ${t.name} <span style="font-size:11px;color:var(--go);background:rgba(80,200,80,.1);padding:2px 7px;border-radius:20px">RESERVED FOR YOU</span></div>
              <div style="font-size:12px;color:var(--dm);margin-top:4px">Downpayment paid: <span style="color:var(--go);font-weight:600">${peso(t.downpayment||0)}</span></div>
              <div style="font-size:11px;color:var(--gr);margin-top:2px">✅ Table locked — no one else can use it</div>
            </div>
            <div style="display:flex;gap:8px;flex-direction:column;align-items:flex-end">
              <button class="btn btn-primary btn-sm" onclick="memberUseTable(${t.id})">▶ Start Now</button>
              <button class="btn btn-ghost btn-sm" onclick="cancelAvailableReservation(${t.id})">Cancel & Refund</button>
            </div>
          </div>
        </div>`;
      });

      // Queue reservations (waiting for an occupied table to free up)
      myQueueReservations.forEach(r=>{
        const tbl = tables.find(x=>x.id===r.table);
        const currentUser = tbl ? (tbl.walkin ? (tbl.walkinName||"Walk-in") : "@"+(tbl.user||"?")) : "?";
        const elapsed = tbl && tbl.start ? ftime(Date.now()-tbl.start) : "—";
        h+=`<div class="mini-card" style="border-color:#64c8ff">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
            <div>
              <div style="font-weight:700">⏳ ${r.tableName} <span style="font-size:11px;color:#64c8ff;background:rgba(100,200,255,.1);padding:2px 7px;border-radius:20px">IN QUEUE</span></div>
              <div style="font-size:12px;color:var(--dm);margin-top:4px">Currently used by: <span style="font-weight:600;color:var(--tx)">${currentUser}</span></div>
              <div style="font-size:11px;color:var(--dm);margin-top:2px">⏱ Elapsed: ${elapsed} · You'll be notified when it's free</div>
            </div>
            <button class="btn btn-ghost btn-sm" onclick="cancelReservation('${r.key}')">Leave Queue</button>
          </div>
        </div>`;
      });

      h+=`</div>`;
    }

  } else if (VIEW==="account") {
    const avatarUrl = USER.avatarUrl || "";
    h+=`<div style="max-width:500px">
      <div class="profile-card">
        <div class="profile-header">

          <!-- PROFILE PICTURE -->
          <div style="position:relative;display:inline-block">
            <div id="profile-avatar-display" style="
              width:72px;height:72px;border-radius:50%;
              border:2.5px solid var(--gr);
              overflow:hidden;
              display:flex;align-items:center;justify-content:center;
              background:rgba(80,200,80,.1);
              cursor:pointer;
              flex-shrink:0;
            " onclick="document.getElementById('avatar-file-input').click()" title="Click to change photo">
              ${avatarUrl
                ? `<img src="${avatarUrl}" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
                : ""}
              <div style="font-size:28px;display:${avatarUrl?"none":"flex"};align-items:center;justify-content:center;width:100%;height:100%">👤</div>
            </div>
            <div style="
              position:absolute;bottom:0;right:0;
              width:22px;height:22px;border-radius:50%;
              background:var(--gr);display:flex;align-items:center;justify-content:center;
              font-size:12px;cursor:pointer;border:2px solid #1a1a1a;
            " onclick="document.getElementById('avatar-file-input').click()" title="Change photo">✏️</div>
            <input type="file" id="avatar-file-input" accept="image/*" style="display:none" onchange="handleAvatarUpload(event)">
          </div>

          <div style="margin-left:16px">
            <div class="profile-name">@${USER.username}</div>
            <div class="profile-sub" style="color:var(--gr)">Member</div>
            <div style="font-size:11px;color:var(--dm);margin-top:4px">Click photo to change</div>
          </div>
        </div>
        <div class="profile-stats">
          <div>
            <div class="label" style="font-size:10px;font-weight:600;color:var(--dm);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px">Balance</div>
            <div style="font-size:22px;font-weight:700;color:${myBal>0?"var(--gr)":"var(--dn)"}">${peso(myBal)}</div>
          </div>
          <div>
            <div class="label" style="font-size:10px;font-weight:600;color:var(--dm);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px">Total Sessions</div>
            <div style="font-size:22px;font-weight:700">${myLogs.filter(l=>l.type==="start").length}</div>
          </div>
        </div>
      </div>

      <!-- CHANGE USERNAME -->
      <div class="mini-card" style="margin-bottom:12px">
        <div style="font-size:13px;font-weight:700;color:var(--dm);text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">🔑 Change Username</div>
        <label class="form-label">New Username</label>
        <input class="input" id="edit-user-inp" placeholder="Enter new username" style="margin-bottom:10px">
        <label class="form-label">Current Password (to confirm)</label>
        <input class="input" id="edit-user-pass" type="password" placeholder="Enter your password" style="margin-bottom:10px">
        <div id="edit-user-err" class="login-error hide"></div>
        <button class="btn btn-primary btn-sm" onclick="saveUsername()">Change Username</button>
      </div>

      <!-- CHANGE PASSWORD -->
      <div class="mini-card" style="margin-bottom:20px">
        <div style="font-size:13px;font-weight:700;color:var(--dm);text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">🔒 Change Password</div>
        <label class="form-label">Current Password</label>
        <input class="input" id="edit-pw-old" type="password" placeholder="Enter current password" style="margin-bottom:10px">
        <label class="form-label">New Password</label>
        <input class="input" id="edit-pw-new" type="password" placeholder="Enter new password (min 6 chars)" style="margin-bottom:10px">
        <label class="form-label">Confirm New Password</label>
        <input class="input" id="edit-pw-new2" type="password" placeholder="Repeat new password" style="margin-bottom:10px">
        <div id="edit-pw-err" class="login-error hide"></div>
        <button class="btn btn-primary btn-sm" onclick="savePassword()">Change Password</button>
      </div>

      <!-- SESSION HISTORY -->
      <div style="font-size:15px;font-weight:700;margin-bottom:10px">📋 Session History</div>
      <div class="log-wrap">`;
    if (!myLogs.length) h+=`<div class="log-empty">No sessions yet</div>`;
    [...myLogs].reverse().forEach(l=>{
      h+=`<div class="log-item"><span style="color:${l.type==="start"?"var(--gr)":"var(--go)"}">${l.msg}</span><span class="dim" style="font-size:10px;white-space:nowrap">${timeStr(l.time)}</span></div>`;
    });
    h+=`</div></div>`;
  }

  body.innerHTML = h;
}


/* ============================================================
   RENDER — SHOPKEEPER
   ============================================================ */
function renderShop(now, tables, logs, bal) {
  document.getElementById("s-nav").innerHTML = [
    ["main","📡 Live Monitor"], ["members","👥 Members"], ["reservations","🔖 Reservations"], ["reports","📊 Reports"], ["logs","📋 Log"], ["ctrl","⚙️ Controls"],
  ].map(([k,l])=>`<button class="nav-btn ${VIEW===k?"active-gold":""}" onclick="setView('${k}')">${l}</button>`).join("");

  const body   = document.getElementById("s-body");
  const occ    = tables.filter(t=>t.status==="occupied");
  const revenue= getEffectiveRevenue(logs);
  const runningTotal = occ.reduce((s,t)=>s+calcCost(t.start,t.rate,t.freeMs),0);
  const alerting=occ.filter(t=>t.start&&(now-t.start)>=ALERT_MS);

  const walkins = occ.filter(t=>t.walkin).length;

  const lastResetStr = revenueResetData?.lastResetTime ? `<div style="font-size:10px;color:var(--dm);margin-top:2px">Since ${new Date(revenueResetData.lastResetTime).toLocaleDateString("en-PH",{month:"short",day:"numeric"})}</div>` : "";

  let h=`<div class="stats-grid">
    <div class="stat-card"><div class="label">Tables In Use</div><div class="value green">${occ.length} <span class="dim" style="font-size:14px">/ ${tables.length}</span></div></div>
    <div class="stat-card"><div class="label">Walk-ins</div><div class="value" style="color:#64c8ff">${walkins}</div></div>
    <div class="stat-card stat-card-revenue">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div class="label">Total Revenue</div>
        <button class="btn-reset-rev" onclick="showRevenueResetConfirm()" title="Reset daily revenue">↺ Reset</button>
      </div>
      <div class="value green">${peso(revenue)}</div>
      ${lastResetStr}
    </div>
    <div class="stat-card"><div class="label">Running</div><div class="value gold">${peso(runningTotal)}</div></div>
  </div>`;

  if (VIEW==="main") {
    const resCount = tables.filter(t=>t.status==="reserved").length;
    h+=`<div class="section-header">
      <div class="section-title"><span class="gold">◉</span> Live Monitor <span class="pill pill-green"><span class="dot dot-on"></span> LIVE</span></div>
      ${occ.length?'<button class="btn btn-danger btn-sm" onclick="shopStopAll()">Stop All</button>':""}
    </div>`;
    if (alerting.length) h+=`<div class="alert-strip">🚨 ${alerting.length} table(s) reached the 3-minute alert.</div>`;
    h+=`<div class="table-grid">`;
    tables.forEach(t=>{
      const isOcc      = t.status==="occupied";
      const isReserved = t.status==="reserved";
      const isFree     = t.status==="available";
      const isAlert    = isOcc && t.start && (now-t.start)>=ALERT_MS;
      const queue      = reservations.filter(r=>r.table===t.id);

      let cardBorder = isOcc ? "occupied" : isReserved ? "table-card-reserved-shop" : "";
      let statusLabel = isFree?"AVAILABLE" : isReserved?"RESERVED" : "OCCUPIED";
      let statusColor = isFree?"var(--gr)" : isReserved?"#e67e22" : "var(--go)";

      h+=`<div class="table-card ${cardBorder}">
        <div class="table-card-head"><span class="table-card-name">${t.name}</span><span class="badge badge-std">Standard</span></div>
        <div class="table-card-status">
          <span class="dot" style="background:${statusColor};width:7px;height:7px;border-radius:50%;display:inline-block"></span>
          <span style="font-size:12px;color:${statusColor};font-weight:600;margin-left:4px">${statusLabel}</span>
          ${isAlert?'<span class="badge-alert">🚨 ALERT</span>':""}
        </div>`;

      if (isOcc) {
        const isWalkin = t.walkin;
        h+=`<div class="table-card-info">
          <div><span class="lbl">${isWalkin?"Guest:":"User:"}</span>
            ${isWalkin
              ? `<span style="color:#64c8ff;font-weight:700">${t.walkinName||"Walk-in Guest"}</span> <span style="font-size:10px;background:#1a3a4a;color:#64c8ff;border:1px solid #64c8ff;border-radius:4px;padding:1px 5px;margin-left:4px">WALK-IN</span>`
              : `@${t.user}`}
          </div>
          <div><span class="lbl">Time:</span> <span class="gold" style="font-weight:700">${ftime(now-t.start)}</span></div>
          <div><span class="lbl">Cost:</span> <span class="green" style="font-weight:700">${peso(calcCost(t.start,t.rate,t.freeMs))}</span></div>
        </div>`;
        if (isWalkin) {
          h+=`<button class="btn btn-full btn-sm" style="background:#1a3a4a;border:1.5px solid #64c8ff;color:#64c8ff;font-weight:700" onclick="shopStopWalkin(${t.id})">💵 Collect &amp; Stop</button>`;
        } else {
          h+=`<button class="btn btn-danger btn-full btn-sm" onclick="shopForceStop(${t.id})">Force Stop</button>`;
        }
      } else if (isReserved) {
        h+=`<div class="table-card-info">
          <div><span class="lbl">Reserved by:</span> @${t.reservedBy}</div>
          <div><span class="lbl">Downpayment:</span> <span class="gold" style="font-weight:700">${peso(t.downpayment||0)}</span></div>
        </div>
        <button class="btn btn-danger btn-full btn-sm" onclick="shopCancelAvailableReservation(${t.id})">Cancel Reservation</button>`;
      } else {
        h+=`<div class="table-card-empty">Waiting for player…</div>
        <button class="btn btn-full btn-sm" style="background:#0d1f2d;border:1.5px solid #64c8ff;color:#64c8ff;font-weight:600;margin-top:8px" onclick="showWalkinModal(${t.id})">🚶 Walk-In</button>`;
      }

      if (queue.length) {
        h+=`<div style="margin-top:8px;font-size:11px;color:var(--dm)">🔖 Reserved by @${queue.map(r=>"@"+r.user).join(", ")}</div>`;
      }
      h+=`</div>`;
    });
    h+=`</div>`;

  } else if (VIEW==="members") {
    const allMembers = [...membersList];
    if (!allMembers.find(m=>m.username==="member")) allMembers.unshift({ ...BUILTIN_ACCOUNTS.member });

    h+=`<div class="section-header">
      <div class="section-title">👥 Members <span class="dim" style="font-size:13px;font-weight:400">(${allMembers.length})</span></div>
    </div>`;

    if (!allMembers.length) {
      h+=`<div class="empty-state"><div class="icon">👥</div><div class="title">No members yet</div><div class="sub">Members will appear here after they register.</div></div>`;
    } else {
      h+=`<div class="mini-list">`;
      allMembers.forEach(m=>{
        const isOnline = (APP?.tables||[]).some(t=>t.user===m.username && t.status==="occupied");
        const isOpen   = SELECTED_MEMBER === m.username;
        h+=`<div class="member-card ${isOpen?"member-card-open":""}">
          <div class="member-card-row" onclick="selectMember('${m.username}')">
            <div class="member-avatar">${(m.username||"?")[0].toUpperCase()}</div>
            <div class="member-info">
              <div class="member-name">@${m.username} ${isOnline?'<span class="dot dot-on" style="display:inline-block;margin-left:4px"></span>':''}</div>
              <div class="member-bal">Balance: <span style="color:${(m.bal||0)>0?"var(--gr)":"var(--dn)"}; font-weight:700">${peso(m.bal||0)}</span></div>
            </div>
            <div class="member-chevron">${isOpen?"▲":"▼"}</div>
          </div>`;

        if (isOpen) {
          h+=`<div class="member-panel">
            <div class="member-panel-title">Manage Balance — @${m.username}</div>
            <div class="member-panel-current">Current Balance: <span style="color:var(--gr);font-weight:700">${peso(m.bal||0)}</span></div>

            <div class="member-panel-section">Add Balance</div>
            <div class="ctrl-card-btns" style="margin-bottom:12px">
              <button class="btn btn-primary btn-sm" onclick="memberAddBalance('${m.username}',50)">+₱50</button>
              <button class="btn btn-primary btn-sm" onclick="memberAddBalance('${m.username}',100)">+₱100</button>
              <button class="btn btn-primary btn-sm" onclick="memberAddBalance('${m.username}',500)">+₱500</button>
              <button class="btn btn-primary btn-sm" onclick="memberAddBalance('${m.username}',1000)">+₱1,000</button>
            </div>

            <div class="member-panel-section">Remove Balance</div>
            <div class="ctrl-card-btns" style="margin-bottom:12px">
              <button class="btn btn-danger btn-sm" onclick="memberRemoveBalance('${m.username}',50)">−₱50</button>
              <button class="btn btn-danger btn-sm" onclick="memberRemoveBalance('${m.username}',100)">−₱100</button>
              <button class="btn btn-danger btn-sm" onclick="memberRemoveBalance('${m.username}',500)">−₱500</button>
              <button class="btn btn-danger btn-sm" onclick="memberRemoveBalance('${m.username}',${m.bal||0})">Clear All</button>
            </div>

            <div style="border-top:1px solid rgba(255,255,255,.07);padding-top:14px;margin-top:4px">
              ${CONFIRM_REMOVE_MEMBER === m.username ? `
                <div style="background:rgba(231,76,60,.08);border:1px solid rgba(231,76,60,.25);border-radius:10px;padding:12px;text-align:center">
                  <div style="font-size:13px;font-weight:700;color:var(--dn);margin-bottom:4px">⚠️ Remove @${m.username}?</div>
                  <div style="font-size:12px;color:var(--dm);margin-bottom:12px">This will permanently delete their account and free any active sessions.</div>
                  <div style="display:flex;gap:8px">
                    <button class="btn btn-ghost btn-sm" style="flex:1" onclick="cancelRemoveMember()">Cancel</button>
                    <button class="btn btn-danger btn-sm" style="flex:1;font-weight:700" onclick="removeMember('${m.username}')">Yes, Remove</button>
                  </div>
                </div>` : `
                <button class="btn btn-danger btn-full btn-sm" style="opacity:.8" onclick="promptRemoveMember('${m.username}')">🗑 Remove Member</button>`}
            </div>
          </div>`;
        }
        h+=`</div>`;
      });
      h+=`</div>`;
    }

  } else if (VIEW==="reservations") {
    const reservedTables = tables.filter(t=>t.status==="reserved");
    h+=`<div class="section-header"><div class="section-title">🔖 Reservations</div><span class="dim" style="font-size:12px">${reservedTables.length} total</span></div>`;
    if (!reservedTables.length) {
      h+=`<div class="empty-state"><div class="icon">🔖</div><div class="title">No reservations</div><div class="sub">Members can reserve available tables with a downpayment.</div></div>`;
    } else {
      h+=`<div class="mini-list">`;
      reservedTables.forEach(t=>{
        h+=`<div class="mini-card" style="border-color:#e67e22">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
            <div>
              <div style="font-weight:700">${t.name} <span style="color:#e67e22;font-size:11px">RESERVED</span></div>
              <div style="font-size:12px;color:var(--dm)">By: @${t.reservedBy} · DP: <span style="color:var(--go);font-weight:700">${peso(t.downpayment||0)}</span></div>
            </div>
            <button class="btn btn-danger btn-sm" onclick="shopCancelAvailableReservation(${t.id})">Cancel &amp; Refund</button>
          </div>
        </div>`;
      });
      h+=`</div>`;
    }

  } else if (VIEW==="reports") {
    h += buildReportHTML();

  } else if (VIEW==="logs") {
    h+=`<div class="section-header"><div class="section-title"><span class="green">◉</span> Activity Log</div><span class="dim" style="font-size:12px">${logs.length} entries</span></div>`;
    h+=`<div class="log-wrap">`;
    if (!logs.length) h+=`<div class="log-empty">No activity yet</div>`;
    [...logs].reverse().forEach(l=>{
      const color=l.type==="start"?"var(--gr)":l.type==="stop"?"var(--go)":"#8be";
      h+=`<div class="log-item"><span style="color:${color}">${l.msg}</span><span class="dim" style="font-size:10px;white-space:nowrap">${timeStr(l.time)}</span></div>`;
    });
    h+=`</div>`;

  } else if (VIEW==="ctrl") {
    h+=`<div style="font-size:16px;font-weight:700;margin-bottom:14px">⚙️ Admin Controls</div>`;
    h+=`<div class="ctrl-grid">
      <div class="ctrl-card">
        <div class="ctrl-card-title">Member Balances</div>
        <div class="ctrl-card-sub">Add or remove balance per member</div>
        <button class="btn btn-primary btn-full" onclick="setView('members')">👥 Go to Members →</button>
      </div>
      <div class="ctrl-card">
        <div class="ctrl-card-title">Table Controls</div>
        <div class="ctrl-card-sub">${occ.length} table(s) currently occupied</div>
        <button class="btn btn-danger btn-full" ${occ.length?"":"disabled"} onclick="shopStopAll()">Force Stop All Tables</button>
      </div>
      <div class="ctrl-card">
        <div class="ctrl-card-title">Reset System</div>
        <div class="ctrl-card-sub">Clear all sessions, logs &amp; restore defaults</div>
        <button class="btn btn-danger btn-full" onclick="shopReset()">🔄 Reset All Data</button>
      </div>
    </div>`;
  }

  body.innerHTML = h;
}


/* ============================================================
   ACCOUNT EDIT FUNCTIONS
   ============================================================ */

// ── PROFILE PICTURE ─────────────────────────────────────────
// Binabasa ang napiling larawan bilang base64, ini-save sa Firebase
// sa ilalim ng accounts/{username}/avatarUrl
function handleAvatarUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  // Max 1MB check
  if (file.size > 1024 * 1024) {
    toast("Image too large. Please pick a photo under 1MB.","warn");
    event.target.value = "";
    return;
  }

  const reader = new FileReader();
  reader.onload = function(e) {
    const base64 = e.target.result; // "data:image/jpeg;base64,..."

    // Show preview instantly (optimistic UI)
    const display = document.getElementById("profile-avatar-display");
    if (display) {
      display.innerHTML = `<img src="${base64}" style="width:100%;height:100%;object-fit:cover;">`;
    }

    // Save to Firebase
    if (!isFirebase || !db) {
      USER.avatarUrl = base64;
      persistSession();
      toast("✅ Profile photo updated!","success");
      return;
    }

    db.ref(ACCOUNTS_REF+"/"+USER.username+"/avatarUrl").set(base64)
      .then(()=>{
        USER.avatarUrl = base64;
        persistSession();
        toast("✅ Profile photo updated!","success");
      })
      .catch(()=>toast("Failed to save photo. Try a smaller image.","warn"));
  };
  reader.readAsDataURL(file);
  event.target.value = ""; // reset so same file can be re-picked
}

function saveUsername() {
  const newUser = (document.getElementById("edit-user-inp")?.value||"").trim().toLowerCase();
  const pass    = (document.getElementById("edit-user-pass")?.value||"");
  setError("edit-user-err","");

  if (!newUser)               { setError("edit-user-err","Enter a new username."); return; }
  if (newUser.length < 3)     { setError("edit-user-err","Username must be at least 3 characters."); return; }
  if (!/^[a-z0-9_]+$/.test(newUser)) { setError("edit-user-err","Only letters, numbers, and underscores allowed."); return; }
  if (newUser === USER.username) { setError("edit-user-err","That's already your username."); return; }
  if (pass !== USER.password) { setError("edit-user-err","Incorrect password."); return; }
  if (BUILTIN_ACCOUNTS[newUser]) { setError("edit-user-err","That username is reserved."); return; }

  if (!isFirebase || !db) { setError("edit-user-err","Firebase required to change username."); return; }

  // Check if new username exists, then copy account, delete old
  db.ref(ACCOUNTS_REF+"/"+newUser).once("value").then(snap=>{
    if (snap.exists()) { setError("edit-user-err","Username already taken. Try another."); return; }
    const updatedAcc = { ...USER, username: newUser };
    // Write new key, delete old key
    return db.ref(ACCOUNTS_REF+"/"+newUser).set(updatedAcc)
      .then(()=> db.ref(ACCOUNTS_REF+"/"+USER.username).remove())
      .then(()=>{
        USER.username = newUser;
        persistSession();
        toast("✅ Username changed to @"+newUser+"!","success");
        document.getElementById("m-username").textContent = USER.name||newUser;
        render();
      });
  }).catch(()=>setError("edit-user-err","Failed to change username. Try again."));
}

function savePassword() {
  const oldPw  = (document.getElementById("edit-pw-old")?.value||"");
  const newPw  = (document.getElementById("edit-pw-new")?.value||"");
  const newPw2 = (document.getElementById("edit-pw-new2")?.value||"");
  setError("edit-pw-err","");

  if (!oldPw||!newPw||!newPw2) { setError("edit-pw-err","Please fill in all fields."); return; }
  if (oldPw !== USER.password)  { setError("edit-pw-err","Current password is incorrect."); return; }
  if (newPw.length < 6)         { setError("edit-pw-err","New password must be at least 6 characters."); return; }
  if (newPw !== newPw2)         { setError("edit-pw-err","Passwords do not match."); return; }
  if (newPw === oldPw)          { setError("edit-pw-err","New password must be different from current."); return; }

  if (!isFirebase || !db) {
    USER.password = newPw; persistSession();
    toast("✅ Password changed!","success");
    document.getElementById("edit-pw-old").value="";
    document.getElementById("edit-pw-new").value="";
    document.getElementById("edit-pw-new2").value="";
    return;
  }
  db.ref(ACCOUNTS_REF+"/"+USER.username+"/password").set(newPw).then(()=>{
    USER.password = newPw;
    persistSession();
    toast("✅ Password changed successfully!","success");
    document.getElementById("edit-pw-old").value="";
    document.getElementById("edit-pw-new").value="";
    document.getElementById("edit-pw-new2").value="";
    render();
  }).catch(()=>setError("edit-pw-err","Failed to change password. Try again."));
}


/* ============================================================
   RENDER DISPATCHER
   ============================================================ */
function render() {
  if (!APP||!USER) return;
  const now=Date.now(), tables=APP.tables||INIT_STATE().tables, logs=APP.logs||[], bal=APP.bal!=null?APP.bal:0;
  if (USER.role==="member")      renderMember(now,tables,logs,bal);
  else if(USER.role==="shopkeeper") renderShop(now,tables,logs,bal);
}

function setView(v) { VIEW=v; render(); }


/* ============================================================
   BOOT
   ============================================================ */
restoreSession();
if (USER) initDashboard();
else       showPage("login");
APP = INIT_STATE();
initApp();
/* ============================================================
   STARTUP LOADER
   ============================================================ */
function hideStartupLoader() {
  const loader = document.getElementById("startup-loader");
  if (!loader || loader.classList.contains("is-hidden")) return;
  loader.classList.add("is-hidden");
  setTimeout(() => {
    if (loader && loader.parentNode) loader.parentNode.removeChild(loader);
  }, 900);
}

function bootStartupLoader() {
  const loader = document.getElementById("startup-loader");
  if (!loader) return;
  setTimeout(hideStartupLoader, 3000);
}

bootStartupLoader();