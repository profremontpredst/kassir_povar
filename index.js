import express from "express";
import fetch from "node-fetch";

const TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;
const CASHIER = Number(process.env.CASHIER_CHAT_ID || 0);
const COOK = Number(process.env.COOK_CHAT_ID || 0);

const IIKO_HOST = "https://db-co.iiko.it/resto/api";
const IIKO_LOGIN = "xxxppp";
const IIKO_PASS_SHA1 = "72c5a5ac08f9d59e333b74f41e4fced5c7b983f7";

// === Привязка кассира к складу ===
const STORE_BY_CASHIER = {
  6928022952: "38a7adba-8855-4770-a1a8-f425354ff624" // Склад на Мира 45
};

// === Продукт ===
const PRODUCT_PYROJOK = "d9e9ed5c-c6a5-4b71-93b4-9d666cbbd4a0";

let IIKO_SESSION = null;

// ===== АВТОРИЗАЦИЯ =====
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
    console.log("STORES XML RAW:", raw.slice(0, 500));

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

// ===== Стейт =====
const store = {
  ready: 0,
  pending: 0,
  lastRequestQty: 0,
  awaitCustomQty: false,
  cookAwaitingCustomQty: false
};

// =======================================================
// ====================== EXPRESS ========================
// =======================================================

const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("OK"));

app.post("/webhook", async (req, res) => {
  const update = req.body;
  try {
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
  } catch (e) {
    console.error("UPDATE ERROR:", e);
  }
  res.sendStatus(200);
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

// =======================================================
// ====================== ОСНОВНАЯ ЛОГИКА ===============
// =======================================================

async function handleMessage(msg) {
  const id = msg.chat.id;
  const text = msg.text || "";

  if (text === "/start") {
    if (id === CASHIER) return sendMessage(id, "Готов к работе, кассир 👩‍💼", cashierMenu);
    if (id === COOK) return sendMessage(id, "Готов к работе, повар 👨‍🍳");
    return sendMessage(id, "Нет доступа.");
  }

  // === Дебаг команд
  if (text === "/debug_stores" && id === CASHIER) {
    const stores = await getStores();
    if (!stores.length) return sendMessage(id, "❌ Не получил список точек");
    let message = "🏪 *Точки/Склады:*\n\n";
    stores.forEach(s => {
      message += `• ${s.name}\n  ID: \`${s.id}\`\n\n`;
    });
    return sendMessage(id, message, { parse_mode: "Markdown" });
  }

  if (text === "/debug_iiko" && id === CASHIER) {
    await sendMessage(id, "Получаю данные из iiko...");
    const stores = await getStores();
    const products = await getProducts();
    let out = "📍 *Точки:*\n";
    stores.slice(0, 10).forEach(s => {
      out += `• ${s.name} — \`${s.id}\`\n`;
    });
    out += "\n🍞 *Продукты (первые 5):*\n";
    products.slice(0, 5).forEach(p => {
      out += `• ${p.name} — \`${p.id}\`\n`;
    });
    return sendMessage(id, out, { parse_mode: "Markdown" });
  }

  // === КАССИР ===
  if (id === CASHIER) {
    if (text === "🍳 Приготовить пирожки") {
      return sendMessage(id, "Выберите количество:", quantityMenu);
    }

    if (["5", "10", "15", "20"].includes(text)) {
      const qty = Number(text);
      store.pending = qty;
      store.lastRequestQty = qty;
      await sendMessage(id, `Заявка отправлена: *${qty} шт.*`, { parse_mode: "Markdown" });
      await sendMessage(COOK, `🔥 Новая заявка: *${qty} пирожков*`, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Готово", callback_data: "cook_done" }],
            [{ text: "Другое количество", callback_data: "cook_other" }]
          ]
        }
      });
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
      await sendMessage(id, `Заявка отправлена: *${qty} шт.*`);

      await sendMessage(COOK, `🔥 Новая заявка: *${qty} пирожков*`, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Готово", callback_data: "cook_done" }],
            [{ text: "Другое количество", callback_data: "cook_other" }]
          ]
        }
      });
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

  // === ПОВАР вводит своё количество ===
  if (id === COOK && store.cookAwaitingCustomQty && !isNaN(Number(text))) {
    const qty = Number(text);
    store.ready += qty;
    store.pending = 0;
    store.cookAwaitingCustomQty = false;

    const storeId = STORE_BY_CASHIER[CASHIER];
    const productId = PRODUCT_PYROJOK;

    const ok = await createIncomingInvoice(storeId, productId, qty);

    if (!ok) {
      await sendMessage(COOK, "❌ Ошибка записи в iiko");
      await sendMessage(CASHIER, "❌ Не удалось записать приход в iiko");
    } else {
      await sendMessage(COOK, `Принято: *${qty} шт.*\nЗаписано в iiko ✔`);
      await sendMessage(CASHIER, `Повар приготовил *${qty} шт.*\nОстатки в iiko обновлены ✔`);
    }

    antiShtrafCheck();
    return;
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
    console.log("INVOICE RAW:", raw);

    if (raw.includes("<error")) return false;

    return true;
  } catch (e) {
    console.error("CREATE INVOICE ERROR:", e);
    return false;
  }
}

// =======================================================
// ================== CALL BACK ==========================
// =======================================================

async function handleCallback(query) {
  const id = query.message.chat.id;
  const action = query.data;

  if (id !== COOK) return;

  if (action === "cook_done") {
    const qty = store.lastRequestQty;
    store.ready += qty;
    store.pending = 0;

    const storeId = STORE_BY_CASHIER[CASHIER];
    const productId = PRODUCT_PYROJOK;

    const ok = await createIncomingInvoice(storeId, productId, qty);

    if (!ok) {
      await sendMessage(COOK, "❌ Ошибка записи в iiko");
      await sendMessage(CASHIER, "❌ Не удалось записать приход в iiko");
    } else {
      await sendMessage(COOK, `Готово! *${qty} шт.*\nЗаписано в iiko ✔`);
      await sendMessage(CASHIER, `Повар приготовил *${qty} шт.*\nОстатки в iiko обновлены ✔`);
    }

    antiShtrafCheck();
  }

  if (action === "cook_other") {
    store.cookAwaitingCustomQty = true;
    await sendMessage(COOK, "Введите количество:");
  }

  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: query.id })
  });
}

// =======================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on", PORT));
