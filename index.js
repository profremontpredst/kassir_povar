import TelegramBot from "node-telegram-bot-api";
import express from "express";

console.log("BOT TOKEN:", process.env.BOT_TOKEN);

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

bot.on("message", (msg) => {
  console.log("MESSAGE:", msg.text);
  bot.sendMessage(msg.chat.id, "Бот работает");
});

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("OK"));
app.listen(PORT, () => console.log("Server running on port", PORT));
