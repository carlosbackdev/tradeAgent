# 🤖 Cómo configurar tu cuenta en el Trading Agent

Has recibido una invitación al agente de trading autónomo. Esta guía te explica cómo obtener las tres credenciales que necesitas para activar tu cuenta.

El bot te las pedirá en orden, paso a paso. Solo tienes que tenerlas a mano antes de empezar.

---

## Lo que necesitas conseguir

1. **API Key de Revolut X** + tu clave privada Ed25519
2. **API Key de Anthropic** (la IA que toma las decisiones)
3. **Qué criptomonedas** quieres operar

---

## Paso 1 — Clave API de Revolut X

Revolut X es el exchange donde se ejecutarán tus órdenes. Necesitas darle al bot permiso para operar en tu nombre, y eso se hace con una clave API.

### 1.1 Generar el par de claves

Revolut X usa un sistema de firma criptográfica (Ed25519). Necesitas generar un par de claves: una pública (que entregas a Revolut) y una privada (que le das al bot).

**Opción A — Si tienes Node.js instalado en tu ordenador:**

```bash
# Descarga el script generador
curl -O https://raw.githubusercontent.com/carlosbackdev/tradeAgent/main/scripts/generate-keys.js

# Ejecuta
node generate-keys.js
```

Esto crea dos archivos: `keys/private.pem` y `keys/public.pem`.

**Opción B — Generador online (más sencillo):**

Usa un generador Ed25519 online como [cryptotools.net/ed25519](https://cryptotools.net/ed25519). Genera el par y guarda ambas claves en archivos de texto.

> ⚠️ **La clave privada es tuya y solo tuya.** Nadie debería pedírtela excepto este bot para configurar tu cuenta. Trátala como si fuera la contraseña de tu banco.

### 1.2 Registrar la clave pública en Revolut X

1. Entra en [trading.revolut.com](https://trading.revolut.com) con tu cuenta Revolut
2. Ve a tu **Perfil** (esquina superior derecha)
3. Navega a **Configuración → API Keys**
4. Pulsa **Crear clave API**
5. En el campo de texto, pega el contenido completo de tu `public.pem`, incluyendo las líneas de cabecera:

```
-----BEGIN PUBLIC KEY-----
MFAwEAYHKoZIzj0CAQYFK4EEAAoDQgAE...
-----END PUBLIC KEY-----
```

6. Confirma y guarda
7. Revolut X te mostrará una **API Key de 64 caracteres** — cópiala ahora. Solo aparece una vez.

---

## Paso 2 — API Key de Anthropic

El cerebro del agente es el modelo elegido de IA. Necesitas tu propia clave para que el agente pueda hacer análisis de mercado en tu nombre.
Ejemplo con claude:

1. Ve a [console.anthropic.com](https://console.anthropic.com)
2. Crea una cuenta si no tienes (tienen capa gratuita con crédito inicial)
3. En el menú lateral: **API Keys → Create Key**
4. Dale un nombre descriptivo, por ejemplo: `trading-agent`
5. Copia la clave — empieza por `sk-ant-...`

> 💡 **Coste aproximado:** Si el agente usa `claude-haiku-4-5`. Con ciclos cada hora el gasto es de unos **€1-3 al mes**. Con ciclos cada 15 minutos, unos **€5-8 al mes**. Necesitarás añadir crédito en Anthropic para cubrir este coste.

El coste varía según el modelo de IA que uses.

---

## Paso 3 — Elegir tus criptomonedas

El agente puede analizar y operar varios pares a la vez. Cuando el bot te lo pida, escribe los símbolos separados por coma.

Las opciones disponibles son:

| Símbolo | Nombre |
|---|---|
| `BTC-USD` | Bitcoin |
| `ETH-USD` | Ethereum |
| `SOL-USD` | Solana |
| `XRP-USD` | Ripple |

Ejemplo de respuesta: `BTC-USD,ETH-USD`

> Para empezar se recomienda **uno o dos pares**. Más pares implica más coste mensual en la API de Anthropic.

---

## Configuración en el bot (4 pasos)

Una vez tengas todo lo anterior, abre el bot en Telegram y pulsa **Comenzar configuración**. El asistente te irá guiando:

**Paso 1/4 — Revolut API Key**
Pega la clave de 64 caracteres que te dio Revolut X al crear la API Key.

**Paso 2/4 — Clave privada Ed25519**
Pega el contenido completo de tu `private.pem`, incluyendo las líneas de cabecera y pie:

```
-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEI...
-----END PRIVATE KEY-----
```

**Paso 3/4 — Anthropic API Key**
Pega tu clave de Anthropic (empieza por `sk-ant-`).

**Paso 4/4 — Pares de trading**
Escribe los símbolos que quieres operar: `BTC-USD,ETH-USD`

Al completar los 4 pasos, recibirás confirmación y tu agente quedará activo.

---

## ¿Qué pasa después?

Desde el menú principal del bot puedes:

- **⏰ CRON** → cambiar la frecuencia de análisis o pausar el agente
- **🤖 AGENT CONFIG** → ajustar la estrategia y comportamiento
- **📈 TRADING STATS** → ver tu rendimiento histórico
- **📊 STATUS** → ver tu configuración actual

Para ajustar la estrategia de trading, consulta la guía de uso.

---

## Preguntas frecuentes

**¿Puede el agente perder dinero?**
Sí. El agente toma decisiones basadas en indicadores técnicos y análisis de IA, pero los mercados son impredecibles. Empieza con cantidades pequeñas hasta que entiendas cómo se comporta.

**¿Es seguro darle mi clave privada al bot?**
La clave se almacena de forma segura y se usa únicamente para firmar las peticiones a Revolut X en tu nombre. Nunca se envía a terceros.

**¿Puedo pausar el agente cuando quiera?**
Sí. En cualquier momento: **⏰ CRON → Desactivar**. Puedes reactivarlo cuando quieras.

**¿Cómo sé qué está haciendo?**
Recibirás una notificación en Telegram después de cada ciclo con la decisión tomada (BUY / SELL / HOLD), el importe y el razonamiento del agente.

**¿Puedo cambiar las criptomonedas después?**
Sí, desde **🤖 AGENT CONFIG → TRADING_PAIRS** en cualquier momento.
