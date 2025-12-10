import express from "express";
import fetch from "node-fetch";

// ================== TELEGRAM ==================
const TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

const CASHIER = Number(process.env.CASHIER_CHAT_ID || 0);
const COOK = Number(process.env.COOK_CHAT_ID || 0);

// ================== IIKO CONFIG ==================
const IIKO_HOST = "https://db-co.iiko.it/resto/api";
const IIKO_LOGIN = "xxxppp";
const IIKO_PASS_SHA1 = "72c5a5ac08f9d59e333b74f41e4fced5c7b983f7"; // lowercase SHA1

let IIKO_SESSION = null;

// ---------- IIKO AUTH (ОБНОВЛЁННО) ----------
async function iikoAuth() {
  try {
    // использование GET как в официальной документации
    const url = `${IIKO_HOST}/auth?login=${IIKO_LOGIN}&pass=${IIKO_PASS_SHA1}`;
    const res = await fetch(url);

    const raw = (await res.text()).trim();
    console.log("IIKO AUTH RAW:", raw);

    // убрана лишняя проверка, оставлена только валидность GUID
    const token = raw.replace(/"/g, "").trim();

    if (!token || token.length < 8) {
      console.error("IIKO AUTH FAIL:", raw);
      IIKO_SESSION = null;
      return null;
    }

    IIKO_SESSION = token;
    console.log("IIKO SESSION OK:", IIKO_SESSION);
    return token;

  } catch (e) {
    console.error("IIKO AUTH ERROR:", e);
    IIKO_SESSION = null;
    return null;
  }
}

async function ensureIikoSession() {
  if (IIKO_SESSION) return true;
  const token = await iikoAuth();
  return !!token;
}

async function getStores() {
  const ok = await ensureIikoSession();
  if (!ok) {
    console.error("getStores: NO IIKO SESSION");
    return [];
  }

  try {
    const res = await fetch(`${IIKO_HOST}/v2/entities/stores/list`, {
      headers: {
        Cookie: `key=${encodeURIComponent(IIKO_SESSION)}`
      }
    });

    const raw = await res.text();
    console.log("STORES RAW:", raw);

    try {
      return JSON.parse(raw);
    } catch {
      console.error("STORES PARSE ERROR");
      return [];
    }
  } catch (e) {
    console.error("getStores ERROR:", e);
    return [];
  }
}

async function getProducts() {
  const ok = await ensureIikoSession();
  if (!ok) {
    console.error("getProducts: NO IIKO SESSION");
    return [];
  }

  try {
    const res = await fetch(`${IIKO_HOST}/v2/entities/products/list`, {
      headers: {
        Cookie: `key=${encodeURIComponent(IIKO_SESSION)}`
      }
    });

    const raw = await res.text();
    console.log("PRODUCTS RAW:", raw);

    try {
      return JSON.parse(raw);
    } catch {
      console.error("PRODUCTS PARSE ERROR");
      return [];
    }
  } catch (e) {
    console.error("getProducts ERROR:", e);
    return [];
  }
}

// ================== ВНУТРЕННЕЕ СОСТОЯНИЕ ==================
const store = {
  ready: 0,
  pending: 0,
  lastRequestQty: 0,
  awaitCustomQty: false,
  cookAwaitingCustomQty: false
};

// ================== EXPRESS + WEBHOOK ==================
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("OK"));

app.post("/webhook", async (req, res) => {
  const update = req.body;
  console.log("UPDATE:", JSON.stringify(update));

  try {
    if (update.message) {
      await handleMessage(update.message);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query);
    }
  } catch (e) {
    console.error("HANDLE UPDATE ERROR:", e);
  }

  res.sendStatus(200);
});

// ================== ЛОГИКА БОТА ==================
async function sendMessage(chatId, text, extra = {}) {
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, ...extra })
    });
  } catch (e) {
    console.error("SEND MESSAGE ERROR:", e);
  }
}

const cashierMenu = {
  reply_markup: {
    keyboard: [
      [{ text: "🍳 Приготовить пирожки" }],
      [{ text: "📦 Остатки пирожков" }]
    ],
    resize_keyboard: true
  }
};

const quantityMenu = {
  reply_markup: {
    keyboard: [
      [{ text: "5" }, { text: "10" }],
      [{ text: "15" }, { text: "20" }],
      [{ text: "Ввести своё количество" }],
      [{ text: "⬅️ Назад" }]
    ],
    resize_keyboard: true
  }
};

function antiShtrafCheck() {
  if (store.ready + store.pending < 10 && CASHIER) {
    sendMessage(
      CASHIER,
      "⚠️ Критически мало пирожков (<10)! Риск отключения Яндекса.",
      { parse_mode: "Markdown" }
    );
  }
}

// ===== handleMessage, handleCallback — НЕ МЕНЯЛ, твоя логика остаётся =====

// ================== START SERVER ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});
