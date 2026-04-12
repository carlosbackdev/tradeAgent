# 🐳 Docker Setup - Revolut Trading Agent

## Quick Start

### 1. Prepare Environment Variables

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```dotenv
# Telegram Bot (REQUIRED for trigger via Telegram)
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
TELEGRAM_CHAT_ID=your_chat_id

# Revolut X API (Required for real orders)
REVOLUT_API_KEY=your_64_char_api_key
REVOLUT_PRIVATE_KEY_PATH=./keys/private.pem
REVOLUT_BASE_URL=https://sandbox-trading.revolut.com/api/1.0

# Claude AI
ANTHROPIC_API_KEY=sk-ant-...

# Trading Configuration
TRADING_PAIRS=BTC/USD,ETH/USD,SOL/USD
MAX_TRADE_SIZE=0.10
MIN_ORDER=10
CRON_SCHEDULE=*/15 * * * *
DRY_RUN=false

# MongoDB
MONGO_ROOT_PASSWORD=your_secure_password
MONGODB_ENABLED=true
```

### 2. Start Everything

```bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f trading-agent
```

### 3. Telegram Control

Send these commands to your bot:

- `/trigger` - Execute one cycle (choose coin from menu)
- `/status` - Show current configuration
- `/help` - Show available commands

---

## Architecture

```
┌─────────────────────────────────────────┐
│   Your Telegram Bot                     │
│   (/trigger, /status, /help)            │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│   Docker Network: trading_network       │
└──────────┬────────────────────┬─────────┘
           │                    │
           ▼                    ▼
    ┌────────────────┐  ┌──────────────────┐
    │  trading-agent │  │     mongodb      │
    │  (Node.js)     │  │  (Database)      │
    └────┬──────┬────┘  └──────────────────┘
         │      │
         │      └─→ CoinGecko API (real data)
         │
         └─→ Revolut X API (orders)
```

---

## Services

### trading-agent

- **Image**: Local build from Dockerfile
- **Port**: 3000 (internal)
- **Environment**: All .env variables
- **Volumes**:
  - `./src` → `/app/src` (hot reload)
  - `./keys` → `/app/keys` (API keys)
  - `./logs` → `/app/logs` (persistent logs)

**Health Check**: Running Node.js process

### mongodb

- **Image**: mongo:7.0-alpine
- **Port**: 27017 (exposed for debugging)
- **Volumes**:
  - `mongodb_data` - persistent data
  - `mongodb_config` - configuration

**Health Check**: MongoDB ping with auth

---

## Commands

### Build

```bash
# Build image
docker build -t revolut-trading-agent:latest .

# Build with specific tag
docker build -t revolut-trading-agent:v1.0.0 .
```

### Run

```bash
# Start all services
docker-compose up -d

# Start with logs
docker-compose up

# Scale trading agent
docker-compose up -d --scale trading-agent=2
```

### Logs

```bash
# View all logs
docker-compose logs

# Follow trading agent logs
docker-compose logs -f trading-agent

# View MongoDB logs
docker-compose logs -f mongodb

# Last 100 lines
docker-compose logs --tail=100
```

### Stop

```bash
# Stop all services (keep volumes)
docker-compose stop

# Stop and remove containers (keep volumes)
docker-compose down

# Stop and remove everything (including volumes)
docker-compose down -v
```

### Debug

```bash
# Open shell in trading-agent
docker exec -it trading_agent /bin/sh

# Run commands inside container
docker exec trading_agent npm run verify

# View container filesystem
docker exec trading_agent ls -la /app
```

---

## Environment Variables

### Essential for Telegram Trigger

```dotenv
TELEGRAM_BOT_TOKEN=...       # From @BotFather
TELEGRAM_CHAT_ID=...         # Your Telegram user ID
```

### Essential for Real Orders

```dotenv
REVOLUT_API_KEY=...          # From Revolut X dashboard
REVOLUT_PRIVATE_KEY_PATH=./keys/private.pem
REVOLUT_BASE_URL=https://sandbox-trading.revolut.com/api/1.0
```

### AI Analysis

```dotenv
ANTHROPIC_API_KEY=sk-ant-...
```

### Trading Config

```dotenv
TRADING_PAIRS=BTC/USD,ETH/USD,SOL/USD    # Comma-separated
MAX_TRADE_SIZE=0.10                       # 10% of portfolio
MIN_ORDER=10                          # Minimum order
CRON_SCHEDULE=*/15 * * * *               # Every 15 minutes
DRY_RUN=false                            # true = no real orders
```

### MongoDB

```dotenv
MONGO_ROOT_PASSWORD=changeme              # Change in production!
MONGODB_ENABLED=true
```

---

## Volumes

### mongodb_data

Persistent MongoDB data directory. Survives container restarts.

### mongodb_config

MongoDB configuration files.

### Source Code Mounts

- `./src` - Live application code
- `./keys` - API keys and certificates
- `./logs` - Application logs

---

## Networks

### trading_network

Bridge network connecting trading-agent and mongodb containers.

Services communicate via:

- `mongodb://admin:password@mongodb:27017` (internal URL)
- `http://trading-agent:3000` (internal URL)

---

## Production Checklist

- [ ] Set `DRY_RUN=false` only after testing
- [ ] Use strong `MONGO_ROOT_PASSWORD`
- [ ] Set `REVOLUT_BASE_URL` to production (not sandbox)
- [ ] Configure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
- [ ] Set `MAX_TRADE_SIZE` to your risk tolerance (0.10 = 10%)
- [ ] Test with `/trigger` first
- [ ] Monitor logs: `docker-compose logs -f`
- [ ] Set up log rotation in production

---

## Troubleshooting

### "Cannot connect to MongoDB"

```bash
# Restart MongoDB
docker-compose restart mongodb

# Check MongoDB health
docker-compose ps

# View MongoDB logs
docker-compose logs mongodb
```

### "Telegram bot not responding"

```bash
# Check token in .env
cat .env | grep TELEGRAM

# Restart agent
docker-compose restart trading-agent

# View agent logs
docker-compose logs -f trading-agent
```

### "CoinGecko API rate limit"

- Wait 1 minute before retrying
- CoinGecko free plan: ~50 requests per minute

### "Revolut X API authentication failed"

```bash
# Verify API key format
echo $REVOLUT_API_KEY

# Verify private key exists
docker exec trading_agent ls -la /app/keys/
```

### "Out of disk space"

```bash
# Check volume sizes
docker system df

# Clean up unused volumes
docker volume prune

# Remove old images
docker image prune -a
```

---

## Example Workflow

1. **Prepare credentials**

   ```bash
   cp .env.example .env
   # Edit .env with your values
   ```

2. **Generate API keys**

   ```bash
   docker-compose up -d
   docker exec trading_agent npm run gen-keys
   ```

3. **Start daemon**

   ```bash
   docker-compose up -d
   docker-compose logs -f trading-agent
   ```

4. **Trigger manually**
   - Send `/trigger` to your Telegram bot
   - Select a coin (BTC, ETH, SOL, etc.)
   - Agent analyzes REAL CoinGecko data
   - Claude AI makes decision
   - Order placed (dry-run or real)

5. **Monitor**
   ```bash
   docker-compose logs -f
   ```

---

## Performance Tips

1. **Increase MongoDB memory**

   ```yaml
   services:
     mongodb:
       cap_add:
         - SYS_RESOURCE
       deploy:
         resources:
           limits:
             memory: 1G
   ```

2. **Use multi-stage builds**

   ```bash
   docker build --target production -t agent:prod .
   ```

3. **Enable log rotation**
   ```bash
   docker-compose down -v && docker system prune -a
   ```

---

## Getting Help

- **Telegram Bot Issues**: Check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
- **API Issues**: Check logs for detailed error messages
- **Database Issues**: Run `docker-compose logs mongodb`
- **Performance Issues**: Monitor with `docker stats`

---

**🚀 Your trading agent is now containerized and ready for production!**
