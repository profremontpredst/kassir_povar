import TelegramBot from "node-telegram-bot-api";
import express from "express";
import fetch from "node-fetch";

const TOKEN = process.env.BOT_TOKEN;
const URL = "https://kassir-povar.onrender.com"; // ← твой домен Render
const WEBHOOK_URL = `${URL}/bot${TOKEN}`;

// === IIKO CONFIG ===
const IIKO_HOST = "https://db-co.iiko.it/resto/api";
const IIKO_LOGIN = "xxxppp";
const IIKO_PASS_SHA1 = "C41B5A68CADA444E2CBDC4DA79548A18422F2518";

let IIKO_SESSION = null;

// === IIKO AUTH ===
async function iikoAuth() {
  try {
    const res = await fetch(
      `${IIKO_HOST}/auth?login=${IIKO_LOGIN}&pass=${IIKO_PASS_SHA1}`,
      { method: "POST" }
    );

    const token = (await res.text()).trim();
    console.log("AUTH:", token);

    if (token.length < 15) return null;

    IIKO_SESSION = token;
    return token;
  } catch (e) {
    console.error("AUTH ERROR:", e);
    return null;
  }
}

// === Express ===
const app = express();
app.use(express.json());

// === Telegram bot (WEBHOOK MODE) ===
const bot = new TelegramBot(TOKEN, { webHook: true });

// Устанавливаем вебхук
bot.setWebHook(WEBHOOK_URL)
  .then(() => console.log("✅ ВЕБХУК УСТАНОВЛЕН:", WEBHOOK_URL))
  .catch(err => console.error("❌ ВЕБХУК ОШИБКА:", err));

// Точка входа Telegram → Render
app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// === КОНСТАНТЫ РОЛЕЙ ===
const CASHIER = Number(process.env.CASHIER_CHAT_ID);
const COOK = Number(process.env.COOK_CHAT_ID);

// === ЛОКАЛЬНЫЙ СТЕЙТ ===
const store = {
  ready: 0,
  pending: 0,
  lastRequestQty: 0,
  awaitCustomQty: false,
  cookAwaitingCustomQty: false
};

// === МЕНЮ ===
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

// === КОМАНДЫ ===
bot.onText(/\/start/, (msg) => {
  const id = msg.chat.id;

  if (id === CASHIER) bot.sendMessage(id, "Готов к работе, кассир 👩‍💼", cashierMenu);
  else if (id === COOK) bot.sendMessage(id, "Готов к работе, повар 👨‍🍳");
  else bot.sendMessage(id, "Нет доступа.");
});

bot.onText(/\/debug_iiko/, async (msg) => {
  if (msg.chat.id !== CASHIER) return bot.sendMessage(msg.chat.id, "Нет доступа.");

  await iikoAuth();

  const stores = await fetch(`${IIKO_HOST}/v2/entities/stores/list`, {
    headers: { Cookie: `key=${IIKO_SESSION}` }
  }).then(r => r.text());

  const products = await fetch(`${IIKO_HOST}/v2/entities/products/list`, {
    headers: { Cookie: `key=${IIKO_SESSION}` }
  }).then(r => r.text());

  bot.sendMessage(msg.chat.id, `📍 Точки:\n${stores}\n\n📦 Продукты:\n${products}`);
});

// === ОСНОВНОЙ ХЭНДЛЕР ===
bot.on("message", (msg) => {
  const id = msg.chat.id;
  const text = msg.text;

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

// CALLBACK — кнопки
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

// === SERVER START ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on", PORT));
