const { SerialPort }     = require("serialport");
const { ReadlineParser }  = require("@serialport/parser-readline");
const firebase           = require("firebase/compat/app").default;
require("firebase/compat/database");

const firebaseConfig = {
  apiKey:            "AIzaSyBRgoqBRvtTrKk0biDTfIpKKXJThU3FMtE",
  authDomain:        "bilyaranfirebase.firebaseapp.com",
  databaseURL:       "https://bilyaranfirebase-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "bilyaranfirebase",
  storageBucket:     "bilyaranfirebase.firebasestorage.app",
  messagingSenderId: "413732028699",
  appId:             "1:413732028699:web:55ace9a48c2c4825c753be",
};

const COM_PORT   = "COM3";
const BAUD_RATE  = 9600;
const BUZZER_REF = "billisync_buzzer";
const FB_REF     = "billisync_app_v2";

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const port   = new SerialPort({ path: COM_PORT, baudRate: BAUD_RATE });
const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));

let appState        = null;
let lastTriggeredAt = null;
let arduinoReady    = false;

db.ref(".info/connected").on("value", (snap) => {
  console.log(snap.val() ? "✅ Firebase: Connected!" : "⚠️  Firebase: Disconnected...");
});

port.on("error", (e) => console.error("❌ Serial error:", e.message));

port.on("open", () => {
  console.log("✅ Arduino: Connected on " + COM_PORT);
  setTimeout(() => {
    arduinoReady = true;
    console.log("🎱 Ready!");
    startListeners();
  }, 3000);
});

parser.on("data", (raw) => {
  const msg = raw.trim();
  if (msg) console.log("📥 Arduino: " + msg);
});

function sendToArduino(msg) {
  if (!arduinoReady) return;
  port.write(msg + "\n", (err) => {
    if (err) console.error("❌ Write error:", err.message);
  });
}

function pad(n) { return String(n).padStart(2, "0"); }

function updateLCD() {
  if (!appState || !appState.tables) { sendToArduino("IDLE"); return; }

  const now    = Date.now();
  const tables = appState.tables || [];

  // Debug — show all table statuses
  const summary = tables.map(t => t.name + "=" + t.status + "(start=" + t.start + ")").join(", ");
  console.log("Tables:", summary);

  // Relaxed filter — occupied only, start can be null
  const occupied = tables.filter(t => t.status === "occupied");

  if (!occupied.length) { sendToArduino("IDLE"); return; }

  const t         = occupied[0];
  const startTime = t.start || now; // fallback to now if start is null
  const elapsedMs = now - startTime;
  const totalSecs = Math.floor(elapsedMs / 1000);
  const hrs  = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  const timeStr = hrs > 0
    ? pad(hrs) + ":" + pad(mins) + ":" + pad(secs)
    : pad(mins) + ":" + pad(secs);

  console.log("Sending to LCD: TABLE:" + t.name + ":" + timeStr);
  sendToArduino("TABLE:" + t.name + ":" + timeStr);
}

function startListeners() {
  // Watch table states
  db.ref(FB_REF).on("value", (snap) => { appState = snap.val(); });

  // Update LCD every second
  setInterval(updateLCD, 1000);

  // Buzz trigger — skip first call to avoid old triggers
  let firstCall = true;
  db.ref(BUZZER_REF + "/triggeredAt").on("value", (snap) => {
    const ts = snap.val();
    if (firstCall) { firstCall = false; lastTriggeredAt = ts; return; }
    if (!ts || ts === lastTriggeredAt) return;
    lastTriggeredAt = ts;
    console.log("🔔 Session ended! Buzzing Arduino...");
    sendToArduino("BUZZ");
  });
}

console.log("🎱 BilliSync Arduino Bridge — Running");
console.log("   COM Port: " + COM_PORT);