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
const IIKO_PASS_SHA1 = "72c5a5ac08f9d59e333b74f41e4fced5c7b983f7";

let IIKO_SESSION = null;

// ---------- IIKO AUTH ----------
async function iikoAuth() {
  try {
    const url = `${IIKO_HOST}/auth?login=${IIKO_LOGIN}&pass=${IIKO_PASS_SHA1}`;
    const res = await fetch(url);
    const raw = (await res.text()).trim();

    console.log("IIKO AUTH RAW:", raw);

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
  if (!ok) return [];

  try {
    const res = await fetch(`${IIKO_HOST}/1/organizations`, {
      headers: { Cookie: `key=${encodeURIComponent(IIKO_SESSION)}` }
    });

    const raw = await res.text();
    console.log("ORGANIZATIONS RAW:", raw);

    try {
      return JSON.parse(raw);
    } catch {
      console.error("ORGANIZATIONS PARSE ERROR");
      return [];
    }

  } catch (e) {
    console.error("getStores ERROR:", e);
    return [];
  }
}

async function getProducts() {
  // всегда пытаемся убедиться, что есть свежая сессия
  const ok = await ensureIikoSession();
  if (!ok) {
    console.error("getProducts: NO IIKO SESSION");
    return [];
  }

  try {
    const res = await fetch(`${IIKO_HOST}/v2/entities/products/list`, {
      headers: { Cookie: `key=${encodeURIComponent(IIKO_SESSION)}` }
    });

    let raw = await res.text();
    console.log("PRODUCTS RAW:", raw);

    // токен протух → пробуем один раз перелогиниться и повторить запрос
    if (/Token is expired or invalid/i.test(raw)) {
      console.error("PRODUCTS: token expired, reauth...");
      IIKO_SESSION = null;

      const ok2 = await ensureIikoSession();
      if (!ok2) {
        console.error("PRODUCTS: reauth failed");
        return [];
      }

      const res2 = await fetch(`${IIKO_HOST}/v2/entities/products/list`, {
        headers: { Cookie: `key=${encodeURIComponent(IIKO_SESSION)}` }
      });

      raw = await res2.text();
      console.log("PRODUCTS RAW RETRY:", raw);
    }

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

// healthcheck
app.get("/", (req, res) => res.send("OK"));

// webhook от Telegram
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

// ================== ЛОГИКА handleMessage ==================
async function handleMessage(msg) {
  const id = msg.chat.id;
  const text = msg.text || "";

  console.log("CHAT:", id, text);

  if (text === "/start") {
    if (id === CASHIER) {
      return sendMessage(id, "Готов к работе, кассир 👩‍💼", cashierMenu);
    }
    if (id === COOK) {
      return sendMessage(id, "Готов к работе, повар 👨‍🍳");
    }
    return sendMessage(id, "Нет доступа.");
  }

  // ===== TEST ORGANIZATIONS (CLOUD API) =====
if (text === "/debug_orgs" && id === CASHIER) {
  await sendMessage(id, "Проверяю организации /api/1/organizations/list...");

  const res = await fetch(${IIKO_HOST.replace("/resto/api","")}/api/1/organizations/list, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: key=${encodeURIComponent(IIKO_SESSION)}
    },
    body: JSON.stringify({ includeDisabled: false })
  });

  const raw = await res.text();
  console.log("ORGS RAW:", raw);

  try {
    const orgs = JSON.parse(raw);
    let out = "🏪 *Организации / точки:*\n\n";
    orgs.organizations.forEach(o => {
      out += • ${o.name} — \${o.id}\\n;
    });
    return sendMessage(id, out, { parse_mode: "Markdown" });
  } catch {
    return sendMessage(id, "❌ Не смог распарсить ответ:\n" + raw);
  }
}
  if (text === "/debug_iiko" && id === CASHIER) {
    await sendMessage(id, "Получаю данные из iiko...");

    const stores = await getStores();
    const products = await getProducts();

    if (!stores.length && !products.length) {
      return sendMessage(
        id,
        "❌ Не удалось получить данные из iiko.\nСкорее всего, неверный логин/пароль или нет доступа к API."
      );
    }

    let out = "📍 *Точки:*\n";
    stores.forEach((s) => {
      out += `• ${s.name} — \`${s.id}\`\n`;
    });

    out += "\n🍞 *Продукты:*\n";
    products.slice(0, 20).forEach((p) => {
      out += `• ${p.name} — \`${p.id}\`\n`;
    });

    return sendMessage(id, out, { parse_mode: "Markdown" });
  }

  if (id === CASHIER) {
    if (text === "🍳 Приготовить пирожки") {
      return sendMessage(id, "Выберите количество:", quantityMenu);
    }

    if (["5", "10", "15", "20"].includes(text)) {
      const qty = Number(text);
      store.pending = qty;
      store.lastRequestQty = qty;

      await sendMessage(id, `Заявка отправлена: *${qty} шт.*`, {
        parse_mode: "Markdown"
      });

      if (COOK) {
        await sendMessage(
          COOK,
          `🔥 Новая заявка: *${qty} пирожков*\nПодтвердите:`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "Готово", callback_data: "cook_done" }],
                [{ text: "Другое количество", callback_data: "cook_other" }]
              ]
            }
          }
        );
      }

      antiShtrafCheck();
      return;
    }

    if (text === "Ввести своё количество") {
      store.awaitCustomQty = true;
      return sendMessage(id, "Введите число пирожков:");
    }

    if (store.awaitCustomQty && !isNaN(Number(text))) {
      const qty = Number(text);
      store.awaitCustomQty = false;
      store.pending = qty;
      store.lastRequestQty = qty;

      await sendMessage(id, `Заявка отправлена: *${qty} шт.*`, {
        parse_mode: "Markdown"
      });

      if (COOK) {
        await sendMessage(
          COOK,
          `🔥 Новая заявка: *${qty} пирожков*`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "Готово", callback_data: "cook_done" }],
                [{ text: "Другое количество", callback_data: "cook_other" }]
              ]
            }
          }
        );
      }

      antiShtrafCheck();
      return;
    }

    if (text === "📦 Остатки пирожков") {
      return sendMessage(
        id,
        `📦 Остатки:\nГотово: *${store.ready}*\nГотовятся: *${store.pending}*`,
        { parse_mode: "Markdown" }
      );
    }
  }

  if (id === COOK && store.cookAwaitingCustomQty && !isNaN(Number(text))) {
    const qty = Number(text);

    store.ready += qty;
    store.pending = 0;
    store.cookAwaitingCustomQty = false;

    await sendMessage(COOK, `Принято: *${qty} шт.*`, {
      parse_mode: "Markdown"
    });
    await sendMessage(CASHIER, `Повар приготовил *${qty} шт.*`, {
      parse_mode: "Markdown"
    });

    antiShtrafCheck();
  }
}

// ================== ЛОГИКА handleCallback ==================
async function handleCallback(query) {
  const id = query.message.chat.id;
  const action = query.data;

  if (id !== COOK) return;

  if (action === "cook_done") {
    const qty = store.lastRequestQty;
    store.ready += qty;
    store.pending = 0;

    await sendMessage(COOK, `Готово! *${qty} шт.*`, {
      parse_mode: "Markdown"
    });
    await sendMessage(CASHIER, `Повар приготовил *${qty} шт.*`, {
      parse_mode: "Markdown"
    });

    antiShtrafCheck();
  }

  if (action === "cook_other") {
    store.cookAwaitingCustomQty = true;
    await sendMessage(COOK, "Введите количество:");
  }

  try {
    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: query.id })
    });
  } catch (e) {
    console.error("ANSWER CALLBACK ERROR:", e);
  }
}

// ================== START SERVER ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});
