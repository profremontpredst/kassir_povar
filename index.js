import TelegramBot from "node-telegram-bot-api";
import express from "express";
import fetch from "node-fetch";

// === IIKO CONFIG ===
const IIKO_HOST = "https://db-co.iiko.it/resto/api";
const IIKO_LOGIN = "xxxppp"; 
const IIKO_PASSWORD = "96321";

let IIKO_SESSION = null;

// === IIKO AUTH (правильная!) ===
async function iikoAuth() {
  try {
    const params = new URLSearchParams();
    params.append("login", IIKO_LOGIN);
    params.append("password", IIKO_PASSWORD);

    const res = await fetch(`${IIKO_HOST}/auth`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });

    const sessionKey = await res.text();

    console.log("AUTH RAW RESPONSE:", sessionKey);

    if (!sessionKey || sessionKey.length < 5 || sessionKey.includes("Exception")) {
      console.error("❌ AUTH FAILED:", sessionKey);
      return null;
    }

    IIKO_SESSION = sessionKey.trim();
    console.log("✅ IIKO SESSION OK:", IIKO_SESSION);
    return IIKO_SESSION;

  } catch (err) {
    console.error("❌ AUTH ERROR:", err);
    return null;
  }
}

// === GET STORES ===
async function getStores() {
  if (!IIKO_SESSION) {
    console.log("⚠️ Нет SESSION — пробую авторизацию...");
    await iikoAuth();
    console.log("SESSION после авторизации:", IIKO_SESSION);
  }

  const res = await fetch(`${IIKO_HOST}/v2/entities/stores/list`, {
    headers: { Cookie: `iiko_session=${IIKO_SESSION};` }
  });

  console.log("STORES STATUS:", res.status);
  const raw = await res.text();
  console.log("STORES RAW:", raw);

  return []; // временно
}

// === GET PRODUCTS ===
async function getProducts() {
  if (!IIKO_SESSION) {
    console.log("⚠️ Нет SESSION — пробую авторизацию...");
    await iikoAuth();
    console.log("SESSION после авторизации:", IIKO_SESSION);
  }

  const res = await fetch(`${IIKO_HOST}/v2/entities/products/list`, {
    headers: { Cookie: `iiko_session=${IIKO_SESSION};` }
  });

  console.log("PRODUCTS STATUS:", res.status);
  const raw = await res.text();
  console.log("PRODUCTS RAW:", raw);

  return []; // временно
}

// === BOT INIT ===
console.log("INDEX.JS LOADED");
console.log("BOT TOKEN:", process.env.BOT_TOKEN);

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const CASHIER = Number(process.env.CASHIER_CHAT_ID);
const COOK = Number(process.env.COOK_CHAT_ID);

// === LOCAL STORE (мок) ===
const store = {
  ready: 0,
  pending: 0,
  lastRequestQty: 0,
  awaitCustomQty: false,
  cookAwaitingCustomQty: false
};

// === MENUS ===
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

// === АНТИШТРАФ ===
function antiShtrafCheck() {
  if (store.ready + store.pending < 10) {
    bot.sendMessage(
      CASHIER,
      "⚠️ Критически мало пирожков (<10)! Риск отключения Яндекса.",
      { parse_mode: "Markdown" }
    );
  }
}

// === /start ===
bot.onText(/\/start/, (msg) => {
  const id = msg.chat.id;

  console.log("CHAT INFO:", msg.chat);

  if (id === CASHIER) bot.sendMessage(id, "Готов к работе, кассир 👩‍💼", cashierMenu);
  else if (id === COOK) bot.sendMessage(id, "Готов к работе, повар 👨‍🍳");
  else bot.sendMessage(id, "У вас нет доступа.");
});

// === /debug_iiko ===
bot.onText(/\/debug_iiko/, async (msg) => {
  const id = msg.chat.id;
  if (id !== CASHIER) return bot.sendMessage(id, "Нет доступа.");

  bot.sendMessage(id, "Получаю данные из iiko...");

  const stores = await getStores();
  const products = await getProducts();

  let storeList = "📍 *Точки / Stores:*\n";
  stores.forEach((s) => {
    storeList += `• ${s.name} — \`${s.id}\`\n`;
  });

  let prodList = "\n🍞 *Продукты:*\n";
  products.slice(0, 20).forEach((p) => {
    prodList += `• ${p.name} — \`${p.id}\`\n`;
  });

  bot.sendMessage(id, storeList + prodList, { parse_mode: "Markdown" });
});

// === MAIN LOGIC ===
bot.on("message", (msg) => {
  const id = msg.chat.id;
  const text = msg.text;

  console.log("CHAT ID:", id);

  // КАССИР
  if (id === CASHIER) {
    if (text === "🍳 Приготовить пирожки") {
      bot.sendMessage(id, "Выберите количество:", quantityMenu);
      return;
    }

    if (["5", "10", "15", "20"].includes(text)) {
      const qty = Number(text);
      store.pending = qty;
      store.lastRequestQty = qty;

      bot.sendMessage(id, `Заявка отправлена: *${qty} шт.*`, { parse_mode: "Markdown" });

      bot.sendMessage(
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

      antiShtrafCheck();
      return;
    }

    if (text === "Ввести своё количество") {
      bot.sendMessage(id, "Введите число пирожков:");
      store.awaitCustomQty = true;
      return;
    }

    if (store.awaitCustomQty && !isNaN(Number(text))) {
      const qty = Number(text);
      store.awaitCustomQty = false;

      store.pending = qty;
      store.lastRequestQty = qty;

      bot.sendMessage(id, `Заявка отправлена: *${qty} шт.*`, { parse_mode: "Markdown" });

      bot.sendMessage(
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

      antiShtrafCheck();
      return;
    }

    if (text === "📦 Остатки пирожков") {
      bot.sendMessage(
        id,
        `📦 Остатки:\nГотово: *${store.ready}*\nГотовятся: *${store.pending}*`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (text === "⬅️ Назад") {
      bot.sendMessage(id, "Меню кассира:", cashierMenu);
      return;
    }
  }

  // ПОВАР
  if (id === COOK && store.cookAwaitingCustomQty && !isNaN(Number(text))) {
    const qty = Number(text);

    store.ready += qty;
    store.pending = 0;
    store.cookAwaitingCustomQty = false;

    bot.sendMessage(COOK, `Принято: *${qty} шт.*`, { parse_mode: "Markdown" });
    bot.sendMessage(CASHIER, `Повар приготовил *${qty} шт.*`, { parse_mode: "Markdown" });

    antiShtrafCheck();
  }
});

// === CALLBACKS ===
bot.on("callback_query", (query) => {
  const id = query.message.chat.id;
  const action = query.data;

  if (id !== COOK) return;

  if (action === "cook_done") {
    const qty = store.lastRequestQty;

    store.ready += qty;
    store.pending = 0;

    bot.sendMessage(id, `Готово! *${qty} шт.*`, { parse_mode: "Markdown" });
    bot.sendMessage(CASHIER, `Повар приготовил *${qty} шт.*`, { parse_mode: "Markdown" });

    antiShtrafCheck();
  }

  if (action === "cook_other") {
    store.cookAwaitingCustomQty = true;
    bot.sendMessage(id, "Введите количество:");
  }

  bot.answerCallbackQuery(query.id);
});

// === KEEPALIVE ===
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("OK"));
app.listen(PORT, () => console.log("Server running on", PORT));
