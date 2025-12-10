import express from "express";
import fetch from "node-fetch";

// ================== TELEGRAM ==================
const TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

const CASHIER = Number(process.env.CASHIER_CHAT_ID || 0);
const COOK = Number(process.env.COOK_CHAT_ID || 0);

// ================== IIKO CONFIG ==================
const IIKO_HOST = "https://db-co.iiko.it/resto/api";
const IIKO_CLOUD_HOST = "https://db-co.iiko.it/api";
const IIKO_LOGIN = "xxxppp";
const IIKO_PASS_SHA1 = "72c5a5ac08f9d59e333b74f41e4fced5c7b983f7";

let IIKO_SESSION = null;
let IIKO_AUTH_TOKEN = null;

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

// ---------- IIKO CLOUD AUTH ----------
async function iikoCloudAuth() {
  try {
    const url = `${IIKO_CLOUD_HOST}/auth/access_token`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        apiLogin: IIKO_LOGIN
      })
    });

    if (!res.ok) {
      console.error("CLOUD AUTH FAILED:", res.status, res.statusText);
      return null;
    }

    const data = await res.json();
    console.log("CLOUD AUTH RESPONSE:", data);
    
    if (data.token) {
      IIKO_AUTH_TOKEN = data.token;
      return data.token;
    }
    
    return null;
  } catch (e) {
    console.error("CLOUD AUTH ERROR:", e);
    return null;
  }
}

async function ensureIikoCloudAuth() {
  if (IIKO_AUTH_TOKEN) return true;
  const token = await iikoCloudAuth();
  return !!token;
}

// ---------- GET ORGANIZATIONS ----------
async function getOrganizations() {
  try {
    const ok = await ensureIikoCloudAuth();
    if (!ok) {
      console.error("No cloud auth token");
      return [];
    }

    const res = await fetch(`${IIKO_CLOUD_HOST}/1/organizations`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${IIKO_AUTH_TOKEN}`
      }
    });

    if (!res.ok) {
      console.error("ORGANIZATIONS ERROR:", res.status, res.statusText);
      return [];
    }

    const data = await res.json();
    console.log("ORGANIZATIONS DATA:", data);
    return data.organizations || data || [];

  } catch (e) {
    console.error("GET ORGANIZATIONS ERROR:", e);
    return [];
  }
}

// ---------- GET DEPARTMENTS ----------
async function getDepartments(organizationId) {
  try {
    const ok = await ensureIikoSession();
    if (!ok) return [];

    const res = await fetch(`${IIKO_HOST}/departments?organization=${organizationId}`, {
      headers: { Cookie: `key=${encodeURIComponent(IIKO_SESSION)}` }
    });

    const raw = await res.text();
    console.log("DEPARTMENTS RAW:", raw);

    try {
      return JSON.parse(raw);
    } catch {
      console.error("DEPARTMENTS PARSE ERROR");
      return [];
    }

  } catch (e) {
    console.error("GET DEPARTMENTS ERROR:", e);
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
      headers: { Cookie: `key=${encodeURIComponent(IIKO_SESSION)}` }
    });

    let raw = await res.text();

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

  // НОВАЯ КОМАНДА ДЛЯ ТОЧЕК
  if (text === "/debug_stores" && id === CASHIER) {
    await sendMessage(id, "Получаю организации и точки...");
    
    try {
      const organizations = await getOrganizations();
      
      if (!organizations || organizations.length === 0) {
        return sendMessage(id, "❌ Не удалось получить организации");
      }
      
      let message = "🏪 *Организации и точки:*\n\n";
      
      for (const org of organizations.slice(0, 10)) {
        message += `📋 *${org.name || 'Без названия'}*\n`;
        message += `ID: \`${org.id || 'нет'}\`\n`;
        
        if (org.address) message += `Адрес: ${org.address}\n`;
        if (org.phone) message += `Телефон: ${org.phone}\n`;
        
        // Получаем отделы для этой организации
        const departments = await getDepartments(org.id);
        if (departments && departments.length > 0) {
          message += `\n*Отделы:*\n`;
          departments.forEach(dept => {
            message += `• ${dept.name || 'Без названия'}`;
            if (dept.externalId) message += ` (ID: \`${dept.externalId}\`)`;
            message += `\n`;
          });
        }
        
        message += `\n`;
      }
      
      return sendMessage(id, message, { parse_mode: "Markdown" });
      
    } catch (error) {
      console.error("DEBUG_STORES ERROR:", error);
      return sendMessage(id, `❌ Ошибка: ${error.message}`);
    }
  }

  if (text === "/debug_iiko" && id === CASHIER) {
    await sendMessage(id, "Получаю данные из iiko...");

    const organizations = await getOrganizations();
    const products = await getProducts();

    if (!organizations.length && !products.length) {
      return sendMessage(
        id,
        "❌ Не удалось получить данные из iiko.\nСкорее всего, неверный логин/пароль или нет доступа к API."
      );
    }

    let out = "📍 *Организации:*\n";
    organizations.slice(0, 10).forEach((org) => {
      out += `• ${org.name || 'Без названия'} — \`${org.id || 'нет'}\`\n`;
      if (org.address) out += `  Адрес: ${org.address}\n`;
    });

    out += "\n🍞 *Продукты (первые 5):*\n";
    products.slice(0, 5).forEach((p) => {
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
