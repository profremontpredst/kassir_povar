import TelegramBot from "node-telegram-bot-api";
import express from "express";

// Лог для проверки, что файл реально запустился
console.log("INDEX.JS LOADED");

// Проверяем токен
console.log("BOT TOKEN:", process.env.BOT_TOKEN);

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const CASHIER = Number(process.env.CASHIER_CHAT_ID);
const COOK = Number(process.env.COOK_CHAT_ID);

// === ХРАНИЛКА СОСТОЯНИЙ ===
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

// === /start ===
bot.onText(/\/start/, (msg) => {
  const id = msg.chat.id;

  console.log("CHAT INFO:", msg.chat);

  if (id === CASHIER) bot.sendMessage(id, "Готов к работе, кассир 👩‍💼", cashierMenu);
  else if (id === COOK) bot.sendMessage(id, "Готов к работе, повар 👨‍🍳");
  else bot.sendMessage(id, "У вас нет доступа.");
});

// === ОСНОВНАЯ ЛОГИКА ===
bot.on("message", (msg) => {
  const id = msg.chat.id;
  const text = msg.text;

  console.log("CHAT ID:", msg.chat.id);

  // ----- КАССИР -----
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

  // ----- ПОВАР ВВОДИТ СВОЁ КОЛ-ВО -----
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

// === КНОПКИ ПОВАРА ===
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

// === EXPRESS KEEPALIVE ===
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("OK"));
app.listen(PORT, () => console.log("Server running on", PORT));
