# Инструкция по развёртыванию NetPulse Studio в Docker

Проект подготовлен к сборке и развёртыванию на тестовом или боевом сервере с использованием многоступенчатого (`multi-stage`) образа Docker (`Node.js 22 Alpine` → автотесты ядра `L1–L7` → `Vite Build` → `Nginx 1.27 Alpine`).

---

## Состав Docker-конфигурации в корне проекта

| Файл | Назначение |
| :--- | :--- |
| `Dockerfile` | Многоступенчатая сборка: установка зависимостей, прогон 39 модульных тестов (`simulator.test.ts`), сборка статики (`npm run build`) и упаковка в легковесный `nginx:1.27-alpine` |
| `docker-compose.yml` | Оркестрация контейнера `netpulse-studio`, проброс порта `3000:80` (или любого порта через переменную `PORT`), `restart: unless-stopped` и `healthcheck` |
| `nginx.conf` | Конфигурация веб-сервера Nginx: `gzip`-сжатие, кэширование `/assets/`, SPA-маршрутизация и эндпоинт проверки здоровья `/healthz` |
| `.dockerignore` | Исключение `node_modules`, `dist`, `.git` и временных файлов из контекста сборки |

---

## Предварительные требования на сервере

На сервере (Ubuntu / Debian / CentOS / RHEL) должны быть установлены:
- **Docker Engine** (`20.10+`)
- **Docker Compose plugin** (`docker compose version`)

Установка Docker на Ubuntu/Debian (если ещё не установлен):
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

---

## Вариант 1. Быстрый запуск через Docker Compose (Рекомендуется)

### 1. Скопируйте проект на сервер или клонируйте репозиторий
```bash
git clone <URL_ВАШЕГО_РЕПОЗИТОРИЯ> netpulse-studio
cd netpulse-studio
```
*(Если вы скачали архив с проектом из AI Studio — распакуйте его в папку `netpulse-studio` и перейдите в неё).*

### 2. Соберите и запустите контейнер в фоновом режиме
По умолчанию приложение будет доступно на порту **`3000`**:
```bash
docker compose up -d --build
```

Если вы хотите запустить симулятор на другом порту (например, на стандартном порту `80` или `8080`):
```bash
PORT=8080 docker compose up -d --build
```

### 3. Проверьте статус контейнера и Healthcheck
```bash
docker compose ps
curl http://localhost:3000/healthz
# Ожидаемый ответ: OK
```

Откройте в браузере:
```text
http://<IP_ВАШЕГО_СЕРВЕРА>:3000
```

---

## Вариант 2. Сборка и запуск без Docker Compose (чистый Docker CLI)

### 1. Сборка Docker-образа
Во время сборки автоматически выполнятся все **39 автотестов сетевого ядра (`L1–L7`)** и компиляция TypeScript/Vite:
```bash
docker build -t netpulse-studio:latest .
```

### 2. Запуск контейнера
```bash
docker run -d \
  --name netpulse-studio \
  --restart unless-stopped \
  -p 3000:80 \
  netpulse-studio:latest
```

---

## Полезные команды обслуживания на сервере

- **Просмотр логов веб-сервера Nginx в реальном времени:**
  ```bash
  docker compose logs -f
  ```
- **Перезапуск контейнера:**
  ```bash
  docker compose restart
  ```
- **Остановка и удаление контейнера:**
  ```bash
  docker compose down
  ```
- **Обновление версии после изменений в коде:**
  ```bash
  git pull
  docker compose up -d --build
  ```
- **Ручной запуск всех 39 модульных тестов внутри стадии сборки:**
  ```bash
  docker build --target builder -t netpulse-builder .
  docker run --rm netpulse-builder npx tsx --test src/network/simulator.test.ts
  ```
