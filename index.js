import TelegramBot from "node-telegram-bot-api";

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const CASHIER = Number(process.env.CASHIER_CHAT_ID);
const COOK = Number(process.env.COOK_CHAT_ID);

// === ХРАНИЛКА СОСТОЯНИЙ ===
const store = {
  ready: 0,               // готовые пирожки на складе
  pending: 0,             // готовятся (заявка)
  lastRequestQty: 0,      // заявка, которую отправил кассир
  cookAwaitingCustomQty: false
};

// === МЕНЮ КАССИРА ===
const cashierMenu = {
  reply_markup: {
    keyboard: [
      [{ text: "🍳 Приготовить пирожки" }],
      [{ text: "📦 Остатки пирожков" }]
    ],
    resize_keyboard: true
  }
};

// === ВЫБОР КОЛИЧЕСТВА ===
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

// === ФУНКЦИЯ АНТИШТРАФА ===
function antiShtrafCheck() {
  if (store.ready + store.pending < 10) {
    bot.sendMessage(
      CASHIER,
      "⚠️ *Критически мало пирожков!* (<10)\n" +
      "Риск отключения Яндекс. Срочно создайте новую заявку!",
      { parse_mode: "Markdown" }
    );
  }
}

// === СТАРТ ===
bot.onText(/\/start/, (msg) => {
  const id = msg.chat.id;

  if (id === CASHIER) {
    bot.sendMessage(id, "Готов к работе, кассир 👩‍💼", cashierMenu);
  } else if (id === COOK) {
    bot.sendMessage(id, "Готов к работе, повар 👨‍🍳");
  } else {
    bot.sendMessage(id, "У вас нет прав доступа.");
  }
});

// === ОБРАБОТЧИК СООБЩЕНИЙ ===
bot.on("message", (msg) => {
  const id = msg.chat.id;
  const text = msg.text;

  // ==== КАССИР ====
  if (id === CASHIER) {
    if (text === "🍳 Приготовить пирожки") {
      bot.sendMessage(id, "Выберите количество:", quantityMenu);
      return;
    }

    if (["5", "10", "15", "20"].includes(text)) {
      const qty = Number(text);
      store.pending = qty;
      store.lastRequestQty = qty;

      bot.sendMessage(id, `Заявка отправлена повару: *${qty} шт.*`, { parse_mode: "Markdown" });

      bot.sendMessage(
        COOK,
        `🔥 Новая заявка!\nКассир просит приготовить *${qty} пирожков*.\n\n` +
        "Подтвердите:",
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

      bot.sendMessage(id, `Заявка отправлена: *${qty} пирожков.*`, { parse_mode: "Markdown" });

      bot.sendMessage(
        COOK,
        `🔥 Новая заявка!\nКассир просит приготовить *${qty} пирожков*.\n\nПодтвердите:`,
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
        `📦 *Остатки пирожков:*\nГотово: *${store.ready}*\nГотовятся: *${store.pending}*`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (text === "⬅️ Назад") {
      bot.sendMessage(id, "Меню кассира:", cashierMenu);
      return;
    }
  }

  // ==== ПОВАР, вводит другое количество ====
  if (id === COOK && store.cookAwaitingCustomQty && !isNaN(Number(text))) {
    const qty = Number(text);

    store.ready += qty;
    store.pending = 0;
    store.cookAwaitingCustomQty = false;

    bot.sendMessage(COOK, `Принято! Добавлено *${qty} шт.*`, { parse_mode: "Markdown" });
    bot.sendMessage(CASHIER, `Повар приготовил *${qty} пирожков*.`, { parse_mode: "Markdown" });

    antiShtrafCheck();
    return;
  }
});

// === ИНЛАЙН-КНОПКИ ПОВАРА ====
bot.on("callback_query", (query) => {
  const id = query.message.chat.id;
  const action = query.data;

  if (id !== COOK) return;

  if (action === "cook_done") {
    const qty = store.lastRequestQty;

    store.ready += qty;
    store.pending = 0;

    bot.sendMessage(id, `Готово! Добавлено *${qty} пирожков.*`, { parse_mode: "Markdown" });
    bot.sendMessage(CASHIER, `Повар приготовил *${qty} пирожков.*`, { parse_mode: "Markdown" });

    antiShtrafCheck();
  }

  if (action === "cook_other") {
    store.cookAwaitingCustomQty = true;
    bot.sendMessage(id, "Введите реальное количество:");
  }

  bot.answerCallbackQuery(query.id);
});
