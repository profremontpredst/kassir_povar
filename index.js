import TelegramBot from "node-telegram-bot-api";
import express from "express";
import fetch from "node-fetch";

// === IIKO CONFIG ===
const IIKO_HOST = "https://db-co.iiko.it/resto/api";
const IIKO_LOGIN = "xxxppp"; 
const IIKO_PASS_SHA1 = "C41B5A68CADA444E2CBDC4DA79548A18422F2518"; // ← твой SHA1 хеш

let IIKO_SESSION = null;

// === AUTH ===
async function iikoAuth() {
  try {
    const url = `${IIKO_HOST}/auth?login=${IIKO_LOGIN}&pass=${IIKO_PASS_SHA1}`;

    const res = await fetch(url, { method: "POST" });
    const token = await res.text();

    console.log("AUTH RAW:", token);

    if (!token || token.includes("Exception") || token.length < 10) {
      console.error("❌ AUTH FAILED:", token);
      return null;
    }

    IIKO_SESSION = token.trim();
    console.log("✅ AUTH OK — SESSION:", IIKO_SESSION);

    return IIKO_SESSION;

  } catch (err) {
    console.error("❌ AUTH ERROR:", err);
    return null;
  }
}

// === GET STORES ===
async function getStores() {
  if (!IIKO_SESSION) await iikoAuth();

  const res = await fetch(`${IIKO_HOST}/v2/entities/stores/list`, {
    headers: {
      Cookie: `key=${IIKO_SESSION};`
    }
  });

  const raw = await res.text();
  console.log("STORES RAW:", raw);

  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// === GET PRODUCTS ===
async function getProducts() {
  if (!IIKO_SESSION) await iikoAuth();

  const res = await fetch(`${IIKO_HOST}/v2/entities/products/list`, {
    headers: {
      Cookie: `key=${IIKO_SESSION};`
    }
  });

  const raw = await res.text();
  console.log("PRODUCTS RAW:", raw);

  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// === BOT ===
console.log("INDEX.JS LOADED");
console.log("BOT TOKEN:", process.env.BOT_TOKEN);

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const CASHIER = Number(process.env.CASHIER_CHAT_ID); 
const COOK = Number(process.env.COOK_CHAT_ID);

// === LOCAL STORE MOCK ===
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

// === ANTI-SHIT ===
function antiShtrafCheck() {
  if (store.ready + store.pending < 10) {
    bot.sendMessage(
      CASHIER,
      "⚠️ Мало пирожков, <10! Риск от Яндекса.",
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
  else bot.sendMessage(id, "Нет доступа.");
});

// === DEBUG: STORES + PRODUCTS ===
bot.onText(/\/debug_iiko/, async (msg) => {
  if (msg.chat.id !== CASHIER) return bot.sendMessage(msg.chat.id, "Нет доступа.");

  bot.sendMessage(msg.chat.id, "Получаю данные...");

  const stores = await getStores();
  const products = await getProducts();

  let text = "📍 *Точки:*\n";
  stores.forEach((s) => (text += `• ${s.name} — \`${s.id}\`\n`));

  text += "\n🍞 *Продукты:*\n";
  products.slice(0, 20).forEach((p) => (text += `• ${p.name} — \`${p.id}\`\n`));

  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// === MAIN LOGIC ===
bot.on("message", (msg) => {
  const id = msg.chat.id;
  const text = msg.text;

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
      store.awaitCustomQty = true;
      bot.sendMessage(id, "Введите число пирожков:");
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
  }

  // ПОВАР ВВОДИТ СВОЁ КОЛ-ВО
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

// === ПОВАР ЖМЕТ КНОПКИ ===
bot.on("callback_query", (query) => {
  if (query.message.chat.id !== COOK) return;

  const action = query.data;

  if (action === "cook_done") {
    const qty = store.lastRequestQty;

    store.ready += qty;
    store.pending = 0;

    bot.sendMessage(COOK, `Готово! *${qty} шт.*`, { parse_mode: "Markdown" });
    bot.sendMessage(CASHIER, `Повар приготовил *${qty} шт.*`, { parse_mode: "Markdown" });

    antiShtrafCheck();
  }

  if (action === "cook_other") {
    store.cookAwaitingCustomQty = true;
    bot.sendMessage(COOK, "Введите количество:");
  }

  bot.answerCallbackQuery(query.id);
});

// === EXPRESS KEEPALIVE ===
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("OK"));
app.listen(PORT, () => console.log("Server running on", PORT));
