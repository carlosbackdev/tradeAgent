# 🚀 Proyecto Completamente Automatizado - Telegram Trigger + Docker

## ✨ Lo que se implementó

### 1️⃣ Bot de Telegram para Trigger

El agente ahora se controla 100% desde Telegram sin necesidad de CLI:

**Comandos disponibles:**

- `/trigger` - Ejecuta un ciclo manual (selector de moneda)
- `/status` - Muestra configuración actual y estado
- `/help` - Muestra ayuda

**Flujo de uso:**

```
Tu Telegram Bot
    ↓
/trigger
    ↓
Aparece menú: BTC, ETH, SOL, VENICE, XRP
    ↓
Seleccionas moneda (botón inline)
    ↓
Agent ejecuta ciclo REAL:
  • Fetch datos de CoinGecko
  • Claude AI analiza
  • Decide: BUY/SELL/HOLD
  • Ejecuta orden (dry-run o real)
    ↓
Recibes notificación en Telegram
```

**Archivos nuevos:**

- `src/telegram-bot.js` - Bot completo con polling

### 2️⃣ Docker + Docker Compose

**Dockerfile:**

- Node.js 20 Alpine (ligero y seguro)
- Copia código fuente
- Instala dependencias
- Expone puerto 3000

**docker-compose.yml:**

```yaml
services:
  trading-agent:
    - Aplicación Node.js
    - Volúmenes: src, keys, logs
    - Health check: Ping a Node
    - Red: trading_network
    - Conexión a MongoDB

  mongodb:
    - MongoDB 7.0 Alpine
    - Autenticación habilitada
    - Volúmenes persistentes
    - Health check: Ping con auth
    - Red: trading_network

Volúmenes:
  - mongodb_data (datos persistentes)
  - mongodb_config (configuración)

Red:
  - trading_network (comunicación interna)
```

**Scripts de inicio:**

- `docker-start.sh` (Linux/Mac)
- `docker-start.bat` (Windows)

### 3️⃣ Índice.js actualizado

El daemon principal ahora:

1. Inicia bot de Telegram si están configuradas las credenciales
2. Ejecuta cron schedule normalmente
3. Responde a comandos de Telegram

```javascript
// Nuevo en index.js
import { startTelegramBot } from "./telegram-bot.js";

// En modo daemon
await startTelegramBot(); // Inicia polling
```

---

## 📋 Cómo usar

### Preparación (Primera vez)

```bash
# 1. Crear .env desde el ejemplo
cp .env.example .env

# 2. Editar .env con tus credenciales:
#    - TELEGRAM_BOT_TOKEN (de @BotFather)
#    - TELEGRAM_CHAT_ID (tu ID de Telegram)
#    - REVOLUT_API_KEY
#    - ANTHROPIC_API_KEY
#    - MONGO_ROOT_PASSWORD (para Docker)

# 3. Generar claves de Revolut (primera vez)
npm run gen-keys
```

### Opción 1: Ejecutar localmente

````bash
# Terminal 1: Inicia MongoDB
docker run -d -p 27017:27017 \
  -e MONGO_INITDB_ROOT_USERNAME=admin \
  -e MONGO_INITDB_ROOT_PASSWORD=changeme \
  mongo:7.0-alpine

# Terminal 2: Ejecuta el agente
npm start


### Verificar que funciona

```bash
# Ver estado de servicios
docker-compose ps

# Ver logs del agente
docker-compose logs -f trading-agent

# Ver logs de MongoDB
docker-compose logs -f mongodb

# Entrar al contenedor
docker exec -it trading_agent /bin/sh
````

---

## 🎮 Uso en Producción

### 1. Telegram Bot

**Crear bot en Telegram:**

1. Abre @BotFather en Telegram
2. Envía `/newbot`
3. Sigue instrucciones
4. Copia el token → `TELEGRAM_BOT_TOKEN`

**Obtener tu CHAT_ID:**

1. Abre @userinfobot
2. Te muestra tu ID → `TELEGRAM_CHAT_ID`

### 2. Variables de Entorno

```bash
# Archivo: .env

# ✅ Requerido para Telegram Trigger
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz...
TELEGRAM_CHAT_ID=987654321

# ✅ Requerido para órdenes reales
REVOLUT_API_KEY=your_64_character_api_key_here
REVOLUT_BASE_URL=https://trading.revolut.com/api/1.0  # Cambiar a producción
REVOLUT_PRIVATE_KEY_PATH=./keys/private.pem

# ✅ Requerido para análisis
ANTHROPIC_API_KEY=sk-ant-...

# ✅ Configuración de trading
TRADING_PAIRS=BTC/USD,ETH/USD,SOL/USD
MAX_TRADE_SIZE=0.10    # 10% por trade
MIN_ORDER=10
DRY_RUN=false          # Cambiar a false para órdenes REALES

# ✅ MongoDB en Docker
MONGO_ROOT_PASSWORD=your_secure_password
MONGODB_ENABLED=true
```

### 3. Levantar en Producción

```bash
# Build
docker-compose build

# Iniciar en background
docker-compose up -d

# Ver logs
docker-compose logs -f

# Parar
docker-compose down

# Parar y borrar todo (incluyendo datos)
docker-compose down -v
```

---

## 📊 Arquitectura Final

```
┌────────────────────────────────────────────────────────┐
│                   TU TELEGRAM BOT                      │
│            /trigger  /status  /help                    │
└───────────────────────┬────────────────────────────────┘
                        │
                        ▼
        ┌───────────────────────────────┐
        │   DOCKER NETWORK              │
        │  (trading_network)            │
        └───────────┬───────────────────┘
                    │
        ┌───────────┴────────────┐
        ▼                        ▼
┌──────────────────┐    ┌──────────────────┐
│ trading-agent    │    │    mongodb       │
│ (Node.js)        │◄──►│  (Database)      │
│                  │    │                  │
│ • Telegram Bot   │    │ • Persistent     │
│ • CoinGecko API  │    │ • Authenticated  │
│ • Revolut X API  │    │ • Volumes        │
│ • Claude AI      │    │                  │
└──────────────────┘    └──────────────────┘
        │
        ├────► CoinGecko (REAL market data)
        ├────► Revolut X (REAL orders)
        └────► Telegram (Notificaciones)
```

---

## 🔍 Archivos Importantes

**Nuevo:**

- `src/telegram-bot.js` - Bot de Telegram (polling)
- `Dockerfile` - Configuración para imagen Docker
- `docker-compose.yml` - Orquestación de servicios
- `docker-start.sh` - Script inicio (Linux/Mac)
- `docker-start.bat` - Script inicio (Windows)
- `DOCKER_SETUP.md` - Documentación completa

**Modificado:**

- `src/index.js` - Inicia bot de Telegram
- `.env.example` - Variables actualizadas

**Existente (sin cambios):**

- `src/revolut/market.js` - Datos REALES de CoinGecko
- `src/agent/executor.js` - Orquestador
- `src/agent/analyzer.js` - Claude AI
- `src/revolut/orders.js` - Ejecución de órdenes (limpio)

---

## ⚙️ Configuración de Cron

El agente también ejecuta automáticamente según:

```dotenv
CRON_SCHEDULE=*/15 * * * *
```

Ejemplos:

- `*/5 * * * *` - Cada 5 minutos
- `0 * * * *` - Cada hora
- `0 9-17 * * 1-5` - 9am-5pm lunes-viernes
- `0 0 * * *` - Diariamente a las 00:00

---

## 🛡️ Seguridad

**En Docker:**

- MongoDB con autenticación
- Variables de entorno en .env (no en código)
- No expone puertos sensibles
- Health checks automáticos
- Reinicio automático en caso de fallo

**Para Producción:**

1. Cambiar `MONGO_ROOT_PASSWORD` a algo fuerte
2. Usar valores reales en todas las variables
3. Activar `DRY_RUN=false` SOLO después de test
4. Usar HTTPS para Revolut X
5. Monitorear logs: `docker-compose logs -f`

---

## 📝 Flujo Completo

### 1. Startup

```bash
docker-compose up -d
```

El agente:

- ✅ Conecta a MongoDB
- ✅ Valida credenciales
- ✅ Inicia bot de Telegram
- ✅ Inicia cron schedule
- ✅ Espera comandos

### 2. Trigger Manual (Telegram)

```
Tu: /trigger
Bot: Menú de monedas
Tu: Selecciona BTC
Bot: ⏳ Analizando...
Agent:
  1. Fetch BTC/USD de CoinGecko
  2. Claude AI analiza precios
  3. Calcula indicadores técnicos
  4. Toma decisión
  5. Coloca orden (dry-run o real)
Bot: ✅ Completado
```

### 3. Ejecución Automática (Cron)

```
Cada 15 minutos (según CRON_SCHEDULE):
1. Ejecuta ciclo para TRADING_PAIRS
2. CoinGecko → Datos reales
3. Claude → Análisis
4. Revolut X → Ordenes
5. MongoDB → Registro
6. Telegram → Notificación
```

---

## 🎯 Resumen de Cambios

| Aspecto       | Antes          | Ahora               |
| ------------- | -------------- | ------------------- |
| **Trigger**   | CLI manual     | Telegram `/trigger` |
| **Deploy**    | Local Node.js  | Docker + Compose    |
| **BD**        | Local MongoDB  | Docker container    |
| **Control**   | Terminal       | Telegram bot        |
| **Datos**     | Solo reales ✅ | Solo reales ✅      |
| **Órdenes**   | Dry-run/Real   | Dry-run/Real ✅     |
| **Monitoreo** | Logs CLI       | Docker logs         |

---

## 🚀 Quick Start (30 segundos)

```bash
# 1. Clonar/Editar .env
cp .env.example .env
# (Editar .env con tus credenciales de Telegram, Revolut, etc.)

# 2. Iniciar
./docker-start.sh  # Linux/Mac
docker-start.bat   # Windows

# 3. Usar
# Enviar /trigger a tu bot de Telegram
# ¡Listo!
```

---

## 📞 Soporte

**MongoDB no conecta:**

```bash
docker-compose logs mongodb
docker-compose restart mongodb
```

**Bot de Telegram no responde:**

```bash
# Verificar token
cat .env | grep TELEGRAM_BOT_TOKEN

# Reiniciar
docker-compose restart trading-agent

# Ver logs
docker-compose logs -f trading-agent
```

**CoinGecko rate limit:**

- Esperar 1 minuto
- Límite: ~50 requests/min

**Revolut X API error:**

```bash
# Verificar credenciales
docker exec trading_agent ls -la /app/keys/

# Ver logs
docker-compose logs -f trading-agent
```

---

✨ **¡Tu agente de trading está listo!**

Envía `/trigger` a tu bot y comienza a operar.
