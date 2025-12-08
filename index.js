import express from "express";
import fetch from "node-fetch";

// ================== TELEGRAM ==================
const TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

// chat id кассира и повара из переменных окружения
const CASHIER = Number(process.env.CASHIER_CHAT_ID || 0);
const COOK = Number(process.env.COOK_CHAT_ID || 0);

// ================== IIKO CONFIG ==================
const IIKO_HOST = "https://db-co.iiko.it/resto/api";
const IIKO_LOGIN = "xxxppp";
const IIKO_PASS_SHA1 = "C41B5A68CADA444E2CBDC4DA79548A18422F2518";

let IIKO_SESSION = null;

// --- авторизация в iiko ---
async function iikoAuth() {
  try {
    const url = `${IIKO_HOST}/auth?login=${IIKO_LOGIN}&pass=${IIKO_PASS_SHA1}`;
    const res = await fetch(url, { method: "POST" });
    const token = (await res.text()).trim();

    console.log("IIKO AUTH RAW:", token);

    if (!token || token.length < 10 || token.includes("Exception")) {
      console.error("IIKO AUTH FAIL");
      return null;
    }

    IIKO_SESSION = token;
    return token;
  } catch (e) {
    console.error("IIKO AUTH ERROR:", e);
    return null;
  }
}

async function getStores() {
  if (!IIKO_SESSION) await iikoAuth();
  if (!IIKO_SESSION) return [];

  const res = await fetch(`${IIKO_HOST}/v2/entities/stores/list`, {
    headers: { Cookie: `key=${IIKO_SESSION}` }
  });
  const raw = await res.text();
  console.log("STORES RAW:", raw);

  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function getProducts() {
  if (!IIKO_SESSION) await iikoAuth();
  if (!IIKO_SESSION) return [];

  const res = await fetch(`${IIKO_HOST}/v2/entities/products/list`, {
    headers: { Cookie: `key=${IIKO_SESSION}` }
  });
  const raw = await res.text();
  console.log("PRODUCTS RAW:", raw);

  try {
    return JSON.parse(raw);
  } catch {
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

// просто чтобы Render показывал "живой" сервис
app.get("/", (req, res) => res.send("OK"));

// сюда Telegram будет слать апдейты
app.post("/webhook", async (req, res) => {
  const update = req.body;
  console.log("UPDATE:", JSON.stringify(update));

  if (update.message) {
    await handleMessage(update.message);
  } else if (update.callback_query) {
    await handleCallback(update.callback_query);
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

async function handleMessage(msg) {
  const id = msg.chat.id;
  const text = msg.text || "";

  console.log("CHAT:", id, text);

  // --- команды ---
  if (text === "/start") {
    if (id === CASHIER) {
      return sendMessage(id, "Готов к работе, кассир 👩‍💼", cashierMenu);
    }
    if (id === COOK) {
      return sendMessage(id, "Готов к работе, повар 👨‍🍳");
    }
    return sendMessage(id, "Нет доступа.");
  }

  if (text === "/debug_iiko" && id === CASHIER) {
    await sendMessage(id, "Получаю данные из iiko...");

    const stores = await getStores();
    const products = await getProducts();

    let out = "📍 *Точки:*\n";
    stores.forEach((s) => {
      out += `• ${s.name} — \`${s.id}\`\n`;
    });

    out += "\n🍞 *Продукты:*\n";
    products.slice(0, 20).forEach((p) => {
      out += `• ${p.name} — \`${p.id}\`\n`;
    });

    return sendMessage(id, out || "Пусто", { parse_mode: "Markdown" });
  }

  // --- кассир ---
  if (id === CASHIER) {
    if (text === "🍳 Приготовить пирожки") {
      return sendMessage(id, "Выберите количество:", quantityMenu);
    }

    if (["5", "10", "15", "20"].includes(text)) {
      const qty = Number(text);
      store.pending = qty;
      store.lastRequestQty = qty;

      await sendMessage(
        id,
        `Заявка отправлена: *${qty} шт.*`,
        { parse_mode: "Markdown" }
      );

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

      await sendMessage(
        id,
        `Заявка отправлена: *${qty} шт.*`,
        { parse_mode: "Markdown" }
      );

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

  // --- повар вводит своё количество ---
  if (id === COOK && store.cookAwaitingCustomQty && !isNaN(Number(text))) {
    const qty = Number(text);

    store.ready += qty;
    store.pending = 0;
    store.cookAwaitingCustomQty = false;

    await sendMessage(COOK, `Принято: *${qty} шт.*`, { parse_mode: "Markdown" });
    await sendMessage(CASHIER, `Повар приготовил *${qty} шт.*`, { parse_mode: "Markdown" });

    antiShtrafCheck();
  }
}

async function handleCallback(query) {
  const id = query.message.chat.id;
  const action = query.data;

  if (id !== COOK) return;

  if (action === "cook_done") {
    const qty = store.lastRequestQty;
    store.ready += qty;
    store.pending = 0;

    await sendMessage(COOK, `Готово! *${qty} шт.*`, { parse_mode: "Markdown" });
    await sendMessage(CASHIER, `Повар приготовил *${qty} шт.*`, { parse_mode: "Markdown" });

    antiShtrafCheck();
  }

  if (action === "cook_other") {
    store.cookAwaitingCustomQty = true;
    await sendMessage(COOK, "Введите количество:");
  }

  // ответ Telegram, чтобы не висел "часик"
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: query.id })
  });
}

// ================== START SERVER ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});
