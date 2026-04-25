# 📖 Guía de Uso — tradeAgent

Cómo sacarle partido al agente una vez está en marcha: configurar estrategias, ajustar el comportamiento del agente IA, interpretar las notificaciones y entender cuándo intervenir.

---

## El panel de control (Telegram)

Al enviar `/start` al bot aparece el menú principal con todos los accesos directos:

| Botón | Función |
|---|---|
| 🚀 START | Lanzar un ciclo manual sobre una moneda |
| ⏰ CRON | Gestionar el ciclo automático |
| 📊 STATUS | Ver configuración actual |
| 📈 TRADING STATS | Ver rendimiento y P&L histórico |
| 🤖 AGENT CONFIG | Ajustar el comportamiento del agente |
| ⚙️ API CONFIG | Credenciales de APIs |
| 💬 ASK AGENT | Hacer preguntas al agente sobre el mercado |
| ❓ HELP | Lista de comandos disponibles |

---

## Configuración del agente IA

El agente tiene dos parámetros clave que definen **cómo piensa**:

### Personalidad (`PERSONALITY_AGENT`)

Controla la agresividad en entradas, salidas y tamaño de posición:

| Valor | Comportamiento |
|---|---|
| `conservative` | Entra solo con señales muy claras (≥55% confianza). Posiciones pequeñas. Prefiere no operar antes que asumir riesgo. |
| `moderate` | Equilibrado. Entra con señales moderadas. Tamaño de posición proporcional a la confianza. |
| `aggressive` | Entra con menos confirmación. Posiciones más grandes. Mayor tolerancia al riesgo. |

### Visión (`VISION_AGENT`)

Orienta al agente hacia qué tipo de movimientos buscar:

| Valor | Qué busca | Indicadores que pondera más |
|---|---|---|
| `short` | Movimientos rápidos de horas | RSI, MACD en marcos cortos |
| `medium` | Tendencias de días/semanas | EMA, MACD, Bollinger |
| `long` | Tendencias estructurales de semanas/meses | SMA200, confluencia múltiple |

Cambiar estos valores desde Telegram: **🤖 AGENT CONFIG** → selecciona el parámetro.

---

## Configurar el intervalo de velas (`INDICATORS_CANDLES_INTERVAL`)

Este parámetro define el marco temporal de los datos con los que el agente calcula los indicadores técnicos (RSI, MACD, Bollinger Bands, EMAs).

| Valor | Timeframe | Para qué estrategia |
|---|---|---|
| `5` | Velas de 5 min | Scalping / day trading |
| `15` | Velas de 15 min | Intraday activo |
| `60` | Velas de 1 hora | Swing trading diario |
| `720` | Velas de 12 horas | Swing semanal / position |
| `1440` | Velas de 1 día | Position trading / largo plazo |

---

## El ciclo automático (`CRON`)

El cron ejecuta el agente automáticamente según el intervalo que configures. Gestión desde Telegram **⏰ CRON**:

| Preset | Expresión | Cuándo usarlo |
|---|---|---|
| 5 min | `*/5 * * * *` | Scalping agresivo (coste alto en API) |
| 15 min | `*/15 * * * *` | Day trading activo |
| 30 min | `*/30 * * * *` | Intraday moderado |
| 1 hora | `0 * * * *` | Swing diario |
| 4 horas | `0 */4 * * *` | Swing semanal |
| 8 horas | `0 */8 * * *` | Position trading |
| 12 horas | `0 */12 * * *` | Position conservador |
| 1 día | `0 0 * * *` | Largo plazo |

Para una expresión personalizada, escribe directamente al bot: `/cron 0 8,20 * * *` (ejecuta a las 8h y 20h cada día).

---

## Ejemplos de estrategia

### Estrategia A — Trading semanal / Position moderado

Buscas movimientos de varios días, no quieres estar pendiente del mercado a diario, y prefieres pocas operaciones de calidad.

```dotenv
# Análisis con velas de 12 horas
INDICATORS_CANDLES_INTERVAL=720

# Ciclo cada 12 horas (análisis dos veces al día)
CRON_SCHEDULE=0 */12 * * *
CRON_ENABLED=true

# Agente conservador con visión media
PERSONALITY_AGENT=moderate
VISION_AGENT=medium

# Gestión de riesgo
MAX_TRADE_SIZE=15         # Máximo 15% del balance por operación
MIN_ORDER=50              # Mínimo $50 por orden
TAKE_PROFIT_PCT=5         # Cierra automáticamente con +5%
STOP_LOSS_PCT=3           # Cierra automáticamente con -3%

# Pares recomendados (los más líquidos)
TRADING_PAIRS=BTC-USD,ETH-USD
```

**Lógica:** Con velas de 12h el agente ve la estructura de días completos. El ciclo cada 12h significa que como máximo operará dos veces al día, y solo si hay señal clara. El TP/SL automático cierra posiciones sin que tengas que intervenir.

---

### Estrategia B — Swing semanal largo plazo

Quieres que el agente tome posiciones que dure de 1 a 4 semanas, con mínima intervención manual.

```dotenv
# Velas diarias para ver la tendencia macro
INDICATORS_CANDLES_INTERVAL=1440

# Una revisión al día, a las 8 de la mañana
CRON_SCHEDULE=0 8 * * *
CRON_ENABLED=true

# Personalidad moderada, visión larga
PERSONALITY_AGENT=moderate
VISION_AGENT=long

# Posiciones más grandes, ya que el movimiento esperado es mayor
MAX_TRADE_SIZE=20         # Hasta 20%
MIN_ORDER=100             # Mínimo $100 para evitar ruido
TAKE_PROFIT_PCT=10        # TP amplio para dejar correr tendencias
STOP_LOSS_PCT=5           # SL más holgado para aguantar volatilidad

TRADING_PAIRS=BTC-USD,ETH-USD,SOL-USD
```

---

### Estrategia C — Intraday activo (mayor atención requerida)

Buscas aprovechar movimientos intradía, estás disponible para revisar el bot varias veces al día.

```dotenv
# Velas de 15 min para señales intradía
INDICATORS_CANDLES_INTERVAL=15

# Ciclo cada 30 minutos en horario activo del mercado cripto
CRON_SCHEDULE=*/30 * * * *
CRON_ENABLED=true

# Moderado-agresivo, visión corta
PERSONALITY_AGENT=moderate
VISION_AGENT=short

# Posiciones pequeñas, muchas operaciones
MAX_TRADE_SIZE=10         # Máximo 10% por trade
MIN_ORDER=20              # Órdenes pequeñas
TAKE_PROFIT_PCT=2         # TP rápido
STOP_LOSS_PCT=1           # SL ajustado

TRADING_PAIRS=BTC-USD,ETH-USD
```

> **Nota sobre coste:** Cada ciclo hace una llamada al modelo de IA elegido (ejemplo claude-haiku-4-5). A 30 min de intervalo son ~48 llamadas/día. El coste estimado con Haiku es de ~€2-4/mes. Si bajas a 5 min el coste sube proporcionalmente (~€15-20/mes).

---

## Cómo interpretar las notificaciones de Telegram

Después de cada ciclo recibes un resumen como este:

```
📊 Trading Agent Cycle
⏱️ Elapsed: 4.2s | 🎯 Trigger: cron

🌍 Market Summary:
BTC muestra señales bajistas con RSI en zona de sobrecompra...

⚡ Decisions:

🔸 BTC-USD
  • Action: BUY
  • Confidence: 73%
  • Amount: $150
  📈 Rendimiento: +2.34%
  ✅ Status: EJECUTADO (0.00185 BTC)
  💡 Reasoning: RSI en zona neutral con MACD cruzando al alza...
```

**Qué significa cada campo:**

- **Confidence:** La certeza del agente. Por debajo de 55% no opera (HOLD automático).
- **Amount:** USD que el agente ha invertido en esa operación.
- **Rendimiento:** P&L no realizado de tu posición actual respecto al precio de entrada.
- **Status EJECUTADO:** La orden se envió a Revolut X. Si está en DRY_RUN verás `[DRY RUN]`.
- **Status SKIPPED:** El agente quiso operar pero algo lo impidió (confianza baja, balance insuficiente, orden mínima no alcanzada...).

---

## Preguntar al agente sobre el mercado

El agente no solo ejecuta — puedes consultarle directamente:

1. En Telegram: **💬 ASK AGENT**
2. Selecciona la moneda
3. Escribe tu pregunta en texto libre

Ejemplos de preguntas útiles:
- *"¿Crees que es buen momento para entrar en BTC a largo plazo?"*
- *"¿Qué señales técnicas ves ahora en ETH?"*
- *"Tengo una posición abierta en SOL con -8%, ¿qué harías?"*

El agente responde en contexto con los indicadores actuales y tu historial de operaciones.

---

## Ver estadísticas de trading

Desde **📈 TRADING STATS** (o `/stats`) verás:

```
📊 ESTADÍSTICAS TRADING AGENT

🤔 Total decisions: 124
📦 Total executed orders: 38
🛒 Total buys: 22
🤝 Total sells: 16
⚙️ Ratio de ejecución: 30.6%

💰 BENEFICIO / PÉRDIDA REALIZADO
💵 PnL realizado: +127.45 USD
📈 ROI realizado: +8.24%
💹 Total invertido: $1,547.00
🟢 Rendimiento acumulado: +6.73%

🏆 Winning trades: 12
📉 Losing trades: 4
📊 Closed trades: 16
🎯 Win rate: 75.0%

📂 POSICIONES ABIERTAS
  • BTC-USD: 0.00185 @ $81,250 (coste $150.31)
```

**Ratio de ejecución:** Qué % de análisis terminan en orden real. Si es muy bajo, el agente está siendo muy conservador — puede que la confianza raramente supere el umbral.

---

## Gestión de órdenes abiertas

Cuando el agente detecta una orden pendiente (limit order no ejecutada), Claude la analiza con contexto de mercado completo y decide:

- **Keep:** Esperar a que se ejecute — las condiciones siguen favorables.
- **Cancel:** Cancelarla — el mercado se ha movido en contra.
- **Buy more:** Añadir más posición — oportunidad de promediar a mejor precio.

Todo esto ocurre automáticamente cuando hay órdenes abiertas al inicio de cada ciclo.

---

## Take Profit y Stop Loss automáticos

Si configuras `TAKE_PROFIT_PCT` y `STOP_LOSS_PCT`, el agente **anula el análisis de Claude** y ejecuta una orden de mercado directamente cuando se alcanzan esos niveles.

Ejemplo con `TAKE_PROFIT_PCT=5` y `STOP_LOSS_PCT=3`:
- Compraste BTC a $80,000
- Precio sube a $84,000 (+5%) → SELL automático
- Precio cae a $77,600 (-3%) → SELL automático

Si los dejas a `0` (por defecto), el agente gestiona las salidas por criterio propio según los indicadores.

---

## Consejos prácticos

**Empieza siempre en DRY_RUN.** Observa las decisiones del agente durante al menos una semana antes de activar dinero real. Aprende cómo responde a diferentes condiciones de mercado.

**Ajusta `MIN_ORDER` según tu capital.** Si tienes $500, `MIN_ORDER=20` tiene sentido. Si tienes $5,000, sube a `MIN_ORDER=100` para evitar que el agente fragmente demasiado las posiciones.

**No cambies demasiados parámetros a la vez.** Si algo no funciona como esperas, cambia un parámetro, observa unos días, y luego evalúa. Es difícil aprender de múltiples cambios simultáneos.

**Para trading semanal, ignora el ruido diario.** Si usas velas de 12h o 1 día, es normal que un día el agente no haga nada — está esperando señal clara. No lo fuerces con ciclos más frecuentes porque degradarás la calidad de las señales.

**Revisa `/stats` semanalmente.** Si el win rate cae por debajo del 50% de forma sostenida, es señal de que el agente no está adaptado a las condiciones actuales del mercado — prueba a ajustar personalidad o visión.
