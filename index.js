import express from "express";
import fetch from "node-fetch";

// ================== TELEGRAM ==================
const TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

const CASHIER = Number(process.env.CASHIER_CHAT_ID || 0);
const COOK = Number(process.env.COOK_CHAT_ID || 0);

// ================== IIKO ==================
const IIKO_HOST = "https://db-co.iiko.it/resto/api";
const IIKO_LOGIN = "xxxppp";
const IIKO_PASS_SHA1 = "72c5a5ac08f9d59e333b74f41e4fced5c7b983f7";

// === Привязка кассира к складу ===
const STORE_BY_CASHIER = {
  6928022952: "38a7adba-8855-4770-a1a8-f425354ff624" // Склад на Мира 45
};

// === Реальный продукт (ID из iiko) ===
const PRODUCT_PYROJOK = "d9e9ed5c-c6a5-4b71-93b4-9d666cbbd4a0";

let IIKO_SESSION = null;

// ===== АВТОРИЗАЦИЯ IIKO =====
async function iikoAuth() {
  try {
    const url = `${IIKO_HOST}/auth?login=${encodeURIComponent(
      IIKO_LOGIN
    )}&pass=${encodeURIComponent(IIKO_PASS_SHA1)}`;

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

// ===== XML парсер точек =====
function parseStoresXml(xml) {
  const result = [];
  if (!xml || typeof xml !== "string") return result;

  const parts = xml.split("<corporateItemDto>").slice(1);

  for (const part of parts) {
    const nameMatch = part.match(/<name>([^<]*)<\/name>/);
    const idMatch = part.match(/<id>([^<]*)<\/id>/);
    const addrMatch = part.match(/<address>([^<]*)<\/address>/);

    const id = idMatch ? idMatch[1].trim() : "";
    const name = nameMatch ? nameMatch[1].trim() : "";
    const address = addrMatch ? addrMatch[1].trim() : "";

    if (id) result.push({ id, name, address });
  }

  return result;
}

// ===== Загрузка точек =====
async function getStores() {
  const ok = await ensureIikoSession();
  if (!ok) return [];

  try {
    let res = await fetch(`${IIKO_HOST}/corporation/stores`, {
      headers: { Cookie: `key=${encodeURIComponent(IIKO_SESSION)}` }
    });

    let raw = await res.text();
    console.log("STORES XML RAW (first 300):", raw.slice(0, 300));

    if (/Token is expired/i.test(raw)) {
      IIKO_SESSION = null;
      const ok2 = await ensureIikoSession();
      if (!ok2) return [];
      res = await fetch(`${IIKO_HOST}/corporation/stores`, {
        headers: { Cookie: `key=${encodeURIComponent(IIKO_SESSION)}` }
      });
      raw = await res.text();
    }

    return parseStoresXml(raw);
  } catch (e) {
    console.error("GET STORES ERROR:", e);
    return [];
  }
}

// ===== Загрузка продуктов =====
async function getProducts() {
  const ok = await ensureIikoSession();
  if (!ok) return [];

  try {
    let res = await fetch(`${IIKO_HOST}/v2/entities/products/list`, {
      headers: { Cookie: `key=${encodeURIComponent(IIKO_SESSION)}` }
    });

    let raw = await res.text();

    if (/Token is expired/i.test(raw)) {
      IIKO_SESSION = null;
      await ensureIikoSession();
      res = await fetch(`${IIKO_HOST}/v2/entities/products/list`, {
        headers: { Cookie: `key=${encodeURIComponent(IIKO_SESSION)}` }
      });
      raw = await res.text();
    }

    return JSON.parse(raw);
  } catch (e) {
    console.error("getProducts ERROR:", e);
    return [];
  }
}

// ===== Стейт (виртуалка только для статуса “готовятся”) =====
const state = {
  pending: 0,
  lastRequestQty: 0,
  awaitCustomQty: false,
  cookAwaitingCustomQty: false,
  lastCashierId: CASHIER || 0
};

// =======================================================
// ====================== EXPRESS ========================
// =======================================================

const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("OK"));

// ВАЖНО: отвечаем Telegram сразу, чтобы он не ретраил вебхук и не слал дубли
app.post("/webhook", (req, res) => {
  const update = req.body;
  res.sendStatus(200);

  (async () => {
    try {
      if (update.message) await handleMessage(update.message);
      else if (update.callback_query) await handleCallback(update.callback_query);
    } catch (e) {
      console.error("HANDLE UPDATE ERROR:", e);
    }
  })();
});

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
    keyboard: [[{ text: "🍳 Приготовить пирожки" }], [{ text: "📦 Остатки пирожков" }]],
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

// =======================================================
// ============ РЕАЛЬНЫЙ ОСТАТОК ИЗ IIKO (ПРАВИЛЬНО) =====
// =======================================================

function pad2(n) {
  return String(n).padStart(2, "0");
}

// локальный timestamp yyyy-MM-dd'T'HH:mm:ss
function makeTimestampLocal() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const MM = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const HH = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${yyyy}-${MM}-${dd}T${HH}:${mm}:${ss}`;
}

// /v2/reports/balance/stores?key=...&timestamp=...&store=...&product=...
async function getRealStock(storeId, productId) {
  const ok = await ensureIikoSession();
  if (!ok) return null;

  const ts = makeTimestampLocal();

  const url =
    `${IIKO_HOST}/v2/reports/balance/stores` +
    `?key=${encodeURIComponent(IIKO_SESSION)}` +
    `&timestamp=${encodeURIComponent(ts)}` +
    `&store=${encodeURIComponent(storeId)}` +
    `&product=${encodeURIComponent(productId)}`;

  try {
    let res = await fetch(url);
    let raw = await res.text();
    console.log("BALANCE STATUS:", res.status);
    console.log("BALANCE RAW (first 300):", raw.slice(0, 300));

    // если токен протух — перелогин
    if (/Token is expired/i.test(raw) || res.status === 401 || res.status === 403) {
      IIKO_SESSION = null;
      const ok2 = await ensureIikoSession();
      if (!ok2) return null;

      const url2 =
        `${IIKO_HOST}/v2/reports/balance/stores` +
        `?key=${encodeURIComponent(IIKO_SESSION)}` +
        `&timestamp=${encodeURIComponent(ts)}` +
        `&store=${encodeURIComponent(storeId)}` +
        `&product=${encodeURIComponent(productId)}`;

      res = await fetch(url2);
      raw = await res.text();
      console.log("BALANCE RETRY STATUS:", res.status);
      console.log("BALANCE RETRY RAW (first 300):", raw.slice(0, 300));
    }

    // ожидаем JSON-массив
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }

    if (!Array.isArray(data) || !data.length) return 0;

    const amount = Number(data[0]?.amount ?? 0);
    return Number.isFinite(amount) ? amount : 0;
  } catch (e) {
    console.error("BALANCE ERROR:", e);
    return null;
  }
}

// =======================================================
// =============== СОЗДАНИЕ ПРИХОДА В IIKO ===============
// =======================================================

async function createIncomingInvoice(storeId, productId, amount) {
  const ok = await ensureIikoSession();
  if (!ok) return false;

  const xml = `
  <incomingDocument>
    <storeId>${storeId}</storeId>
    <items>
      <item>
        <productId>${productId}</productId>
        <amount>${amount}</amount>
      </item>
    </items>
  </incomingDocument>
  `.trim();

  try {
    const res = await fetch(`${IIKO_HOST}/storage/incomingInvoice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/xml",
        Cookie: `key=${encodeURIComponent(IIKO_SESSION)}`
      },
      body: xml
    });

    const raw = await res.text();
    console.log("INVOICE STATUS:", res.status);
    console.log("INVOICE RAW (first 300):", raw.slice(0, 300));

    if (!res.ok) return false;
    if (raw.includes("<error")) return false;

    return true;
  } catch (e) {
    console.error("CREATE INVOICE ERROR:", e);
    return false;
  }
}

// =======================================================
// ====================== ОСНОВНАЯ ЛОГИКА ===============
// =======================================================

async function handleMessage(msg) {
  const id = msg.chat.id;
  const text = msg.text || "";
  console.log("CHAT:", id, text);

  if (text === "/start") {
    if (id === CASHIER) return sendMessage(id, "Готов к работе, кассир", cashierMenu);
    if (id === COOK) return sendMessage(id, "Готов к работе, повар");
    return sendMessage(id, "Нет доступа.");
  }

  // === ДЕБАГ
  if (text === "/debug_stores" && id === CASHIER) {
    await sendMessage(id, "Получаю точки из iiko...");
    const stores = await getStores();
    if (!stores.length) return sendMessage(id, "Не получил список точек");

    let message = "Точки/Склады:\n\n";
    stores.forEach((s) => {
      message += `• ${s.name || "Без названия"}\n`;
      if (s.address) message += `  Адрес: ${s.address}\n`;
      message += `  ID: ${s.id}\n\n`;
    });

    return sendMessage(id, message);
  }

  if (text === "/debug_iiko" && id === CASHIER) {
    await sendMessage(id, "Получаю данные из iiko...");
    const stores = await getStores();
    const products = await getProducts();

    let out = "Точки:\n";
    stores.slice(0, 10).forEach((s) => {
      out += `• ${s.name} — ${s.id}\n`;
    });

    out += "\nПродукты (первые 5):\n";
    products.slice(0, 5).forEach((p) => {
      out += `• ${p.name} — ${p.id}\n`;
    });

    return sendMessage(id, out);
  }

  // === КАССИР
  if (id === CASHIER) {
    if (text === "🍳 Приготовить пирожки") {
      return sendMessage(id, "Выберите количество:", quantityMenu);
    }

    if (text === "⬅️ Назад") {
      return sendMessage(id, "Главное меню:", cashierMenu);
    }

    if (text === "📦 Остатки пирожков") {
      const storeId = STORE_BY_CASHIER[id];
      if (!storeId) return sendMessage(id, "Кассир не привязан к складу (STORE_BY_CASHIER).");

      const stock = await getRealStock(storeId, PRODUCT_PYROJOK);
      if (stock === null) return sendMessage(id, "Не удалось получить остатки из iiko (см. лог сервера).");

      return sendMessage(id, `Реальный остаток в iiko: ${stock}\nГотовятся (в работе): ${state.pending}`);
    }

    if (["5", "10", "15", "20"].includes(text)) {
      const qty = Number(text);
      state.pending = qty;
      state.lastRequestQty = qty;
      state.lastCashierId = id;

      await sendMessage(id, `Заявка отправлена: ${qty} шт.`, { parse_mode: "Markdown" });

      if (COOK) {
        await sendMessage(COOK, `🔥 Новая заявка: *${qty} шт.*\nПодтвердите:`, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "Готово", callback_data: "cook_done" }],
              [{ text: "Другое количество", callback_data: "cook_other" }]
            ]
          }
        });
      }
      return;
    }

    if (text === "Ввести своё количество") {
      state.awaitCustomQty = true;
      return sendMessage(id, "Введите число:");
    }

    if (state.awaitCustomQty) {
      const qty = Number(text);
      if (!Number.isFinite(qty) || qty <= 0) {
        return sendMessage(id, "Введите число (например 5).");
      }

      state.awaitCustomQty = false;
      state.pending = qty;
      state.lastRequestQty = qty;
      state.lastCashierId = id;

      await sendMessage(id, `Заявка отправлена: ${qty} шт.`);

      if (COOK) {
        await sendMessage(COOK, `🔥 Новая заявка: *${qty} шт.*\nПодтвердите:`, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "Готово", callback_data: "cook_done" }],
              [{ text: "Другое количество", callback_data: "cook_other" }]
            ]
          }
        });
      }
      return;
    }
  }

  // === ПОВАР вводит своё количество после “Другое количество”
  if (id === COOK && state.cookAwaitingCustomQty) {
    const qty = Number(text);
    if (!Number.isFinite(qty) || qty <= 0) {
      return sendMessage(COOK, "Введите число (например 5).");
    }

    state.cookAwaitingCustomQty = false;
    state.pending = 0;

    const cashierId = state.lastCashierId || CASHIER;
    const storeId = STORE_BY_CASHIER[cashierId];
    if (!storeId) {
      await sendMessage(COOK, "Ошибка: кассир не привязан к складу.");
      return;
    }

    const ok = await createIncomingInvoice(storeId, PRODUCT_PYROJOK, qty);

    if (!ok) {
      await sendMessage(COOK, "Ошибка записи в iiko (см. лог сервера).");
      if (cashierId) await sendMessage(cashierId, "Не удалось записать приход в iiko (см. лог сервера).");
      return;
    }

    await sendMessage(COOK, `Принято: ${qty} шт.\nЗаписано в iiko.`);
    if (cashierId) await sendMessage(cashierId, `Повар приготовил: ${qty} шт.\nЗаписано в iiko.`);
    return;
  }
}

// =======================================================
// ================== CALLBACK ОТ ПОВАРА =================
// =======================================================

async function handleCallback(query) {
  const id = query.message.chat.id;
  const action = query.data;

  if (id !== COOK) return;

  if (action === "cook_done") {
    const qty = Number(state.lastRequestQty || 0);
    state.pending = 0;

    const cashierId = state.lastCashierId || CASHIER;
    const storeId = STORE_BY_CASHIER[cashierId];
    if (!storeId) {
      await sendMessage(COOK, "Ошибка: кассир не привязан к складу.");
      return;
    }

    const ok = await createIncomingInvoice(storeId, PRODUCT_PYROJOK, qty);

    if (!ok) {
      await sendMessage(COOK, "Ошибка записи в iiko (см. лог сервера).");
      if (cashierId) await sendMessage(cashierId, "Не удалось записать приход в iiko (см. лог сервера).");
    } else {
      await sendMessage(COOK, `Готово: ${qty} шт.\nЗаписано в iiko.`);
      if (cashierId) await sendMessage(cashierId, `Повар приготовил: ${qty} шт.\nЗаписано в iiko.`);
    }
  }

  if (action === "cook_other") {
    state.cookAwaitingCustomQty = true;
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

// =======================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on", PORT));
