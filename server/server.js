import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import fs from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3001;

// Файл хранилища заявок (на сервере, данные не покидают VPS)
const DATA_FILE = path.join(__dirname, "data", "applications.json");

// Telegram-уведомления
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = "249095317";

// Токен для доступа к списку заявок (задаётся на сервере через переменную окружения)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// Сервер работает за nginx — доверяем заголовку X-Forwarded-For,
// иначе rate-limit видел бы один IP nginx на всех клиентов.
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Глобальный мягкий лимит на все маршруты — базовая защита от перебора
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 100, // не более 100 запросов с одного IP за окно
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Слишком много запросов, попробуйте позже" },
});
app.use(globalLimiter);

// Строгий лимит на приём заявок — режет спам-ботов
const submitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 минут
  max: 5, // не более 5 заявок с одного IP за окно
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Слишком много заявок, попробуйте позже" },
});

// Авторизация по токену для приватных эндпоинтов.
// Токен принимается в заголовке Authorization: Bearer <token> или в ?token=...
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "Доступ закрыт" });
  }
  const header = req.headers["authorization"] || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  const token = bearer || req.query.token;
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "Неверный токен" });
  }
  next();
}

// Загрузить или создать хранилище
function loadApplications() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveApplications(apps) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(apps, null, 2));
}

// Отправить уведомление в Telegram
function sendTelegram(text) {
  if (!BOT_TOKEN) return;
  const body = JSON.stringify({ chat_id: OWNER_CHAT_ID, text, parse_mode: "HTML" });
  const req = https.request({
    hostname: "api.telegram.org",
    path: `/bot${BOT_TOKEN}/sendMessage`,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  });
  req.on("error", (e) => console.error("[telegram]", e.message));
  req.write(body);
  req.end();
}

// Форматировать заявку для Telegram
function formatApplication(data, id) {
  const ts = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
  return [
    `📋 <b>Новая заявка #${id}</b>`,
    `🕐 ${ts} МСК`,
    ``,
    `<b>Контакт</b>`,
    `👤 ${data.fio || "—"}`,
    `📞 ${data.phone || "—"}`,
    `📧 ${data.email || "—"}`,
    `📍 ${data.region || "—"}`,
    ``,
    `<b>Бизнес</b>`,
    `🏪 Ниша: ${data.niche || "—"}`,
    `💼 Опыт: ${data.experience || "—"}`,
    `📍 Место: ${data.work_place || "—"}`,
    `💰 Запрашиваемая сумма: ${data.amount || "—"} ₽`,
    ``,
    `<b>Личное</b>`,
    `👨‍👩‍👧 Семья: ${data.family || "—"}`,
    `💵 Доход семьи: ${data.family_income || "—"} ₽/мес`,
    `🎓 Образование: ${data.education || "—"}`,
  ].join("\n");
}

// POST /submit — приём заявки
app.post("/submit", submitLimiter, (req, res) => {
  try {
    const apps = loadApplications();
    const id = apps.length + 1;
    const entry = {
      id,
      created_at: new Date().toISOString(),
      ...req.body,
    };
    apps.push(entry);
    saveApplications(apps);

    sendTelegram(formatApplication(req.body, id));

    console.log(`[app] Заявка #${id} от ${req.body.fio || "?"} сохранена`);
    res.json({ ok: true, id });
  } catch (e) {
    console.error("[app]", e.message);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// GET /applications — список заявок (требует токен ADMIN_TOKEN)
app.get("/applications", requireAdmin, (req, res) => {
  const apps = loadApplications();
  res.json({ total: apps.length, applications: apps });
});

// GET /health — проверка работы
app.get("/health", (req, res) => res.json({ ok: true, service: "quiz-api" }));

app.listen(PORT, () => {
  console.log(`[quiz-api] Сервер запущен на порту ${PORT}`);
  console.log(`[quiz-api] Заявки сохраняются в: ${DATA_FILE}`);
});
