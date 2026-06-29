# Деплой на VPS

Инструкция по развёртыванию квиз-воронки на сервере: статический сайт (`site/`) +
backend приёма заявок (`server/`) за nginx с HTTPS.

Архитектура на проде:

```
Браузер ──HTTPS──> nginx ──┬── /            → отдаёт статику из site/
                           └── /api/submit  → проксирует на localhost:3001/submit
```

Backend слушает только `localhost:3001` и наружу напрямую не доступен — снаружи к нему
можно обратиться лишь через nginx (`/api/...`), а приватный `/applications` защищён токеном.

---

## 0. Предварительно

- VPS с Ubuntu/Debian, root или sudo
- Доменное имя, A-запись которого указывает на IP сервера (для HTTPS)
- Установлены: `node` (v18+), `npm`, `nginx`, `git`, `pm2`

```bash
# Node.js LTS (если ещё не стоит)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs nginx git
sudo npm install -g pm2
```

---

## 1. Получить код на сервер

```bash
cd /var/www
sudo git clone https://github.com/IntelSerg2/quiz-social-contract.git
sudo chown -R $USER:$USER quiz-social-contract
cd quiz-social-contract
```

---

## 2. Запустить backend (приём заявок)

```bash
cd /var/www/quiz-social-contract/server
npm install --omit=dev
```

Задать секреты через переменные окружения и запустить под pm2:

```bash
# сгенерировать админ-токен для доступа к заявкам
openssl rand -hex 16        # запиши вывод — это ADMIN_TOKEN

ADMIN_TOKEN="вставь_сгенерированный_токен" \
BOT_TOKEN="токен_telegram_бота" \
pm2 start server.js --name quiz-api --update-env

pm2 save
pm2 startup        # выполни команду, которую он выведет — автозапуск после ребута
```

Проверка, что backend жив:

```bash
curl http://localhost:3001/health
# {"ok":true,"service":"quiz-api"}
```

> **Важно про переменные окружения.** `ADMIN_TOKEN` и `BOT_TOKEN` НЕ хранятся в репозитории.
> Если `ADMIN_TOKEN` не задан — `/applications` отдаёт `401` всем (безопасное «закрыто по умолчанию»).
> При смене токена перезапускай с `--update-env`:
> `ADMIN_TOKEN="..." BOT_TOKEN="..." pm2 restart quiz-api --update-env`

---

## 3. Настроить nginx

Создай конфиг `/etc/nginx/sites-available/quiz`:

```nginx
server {
    listen 80;
    server_name ВАШ_ДОМЕН.ru www.ВАШ_ДОМЕН.ru;

    root /var/www/quiz-social-contract/site;
    index index.html;

    # Статика воронки
    location / {
        try_files $uri $uri/ =404;
    }

    # Проксирование заявок на backend.
    # Фронтенд (interview.html) в проде шлёт POST на /api/submit,
    # здесь /api/ срезается и уходит на бэкенд как /submit.
    location /api/ {
        proxy_pass http://127.0.0.1:3001/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> Backend читает `X-Forwarded-For` (в коде стоит `trust proxy=1`), поэтому rate-limit
> видит реальный IP клиента, а не IP nginx. Заголовки выше обязательны.

> Приватный `/applications` НЕ проброшен в `location /api/`? — Проброшен: `/api/applications`
> уйдёт на бэкенд как `/applications` и потребует токен. Если хочешь, чтобы список заявок
> был доступен только с самого сервера, просто не обращайся к нему снаружи — смотри его
> локально через `curl http://localhost:3001/applications` (см. п. 6).

Активировать и проверить конфиг:

```bash
sudo ln -s /etc/nginx/sites-available/quiz /etc/nginx/sites-enabled/quiz
sudo nginx -t            # проверка синтаксиса
sudo systemctl reload nginx
```

---

## 4. HTTPS (Let's Encrypt)

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ВАШ_ДОМЕН.ru -d www.ВАШ_ДОМЕН.ru
```

Certbot сам пропишет SSL в конфиг и настроит автопродление.

---

## 5. Финальный тест воронки

1. Открой `https://ВАШ_ДОМЕН.ru` — загрузился лендинг.
2. Пройди квиз до конца (вариант «Подходите»).
3. Заполни форму интервью и отправь — должно появиться «Спасибо».
4. В Telegram владельца (`chat_id 249095317`) пришло уведомление о заявке.
5. Проверь страницу оффера с демо-планом.

Проверка rate-limit: отправь 6 заявок подряд — 6-я вернёт ошибку «Слишком много заявок»
(лимит 5 за 10 минут с одного IP).

---

## 6. Как смотреть заявки

С самого сервера (без токена тоже сработает, если обращаться к localhost напрямую —
но защита от токена всё равно есть, поэтому передай его):

```bash
curl -H "Authorization: Bearer ВАШ_ADMIN_TOKEN" http://localhost:3001/applications
```

Снаружи через nginx (если пробрасываешь `/api/`):

```bash
curl -H "Authorization: Bearer ВАШ_ADMIN_TOKEN" https://ВАШ_ДОМЕН.ru/api/applications
```

Заявки также лежат в файле `server/data/applications.json` (этот каталог в `.gitignore`,
в репозиторий не попадает).

---

## Обновление кода на сервере

```bash
cd /var/www/quiz-social-contract
git pull
cd server && npm install --omit=dev
pm2 restart quiz-api --update-env
sudo systemctl reload nginx   # если менялась статика/конфиг
```

---

## Шпаргалка по безопасности (уже реализовано в коде)

- `GET /applications` требует `ADMIN_TOKEN` → персональные данные не утекают.
- Rate-limit: 5 заявок/10 мин на `/submit`, 100 запросов/15 мин глобально.
- `trust proxy=1` → корректный IP клиента за nginx.
- Секреты (`ADMIN_TOKEN`, `BOT_TOKEN`) только в окружении, не в репозитории.
- Каталог `data/` с заявками — в `.gitignore`.
