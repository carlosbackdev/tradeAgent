/**
 * telegram/entities/cronPresets.js
 * Cron scheduling presets for Telegram bot
 */

export const CRON_PRESETS = [
    { label: '5 min', expr: '*/5 * * * *' },
    { label: '15 min', expr: '*/15 * * * *' },
    { label: '30 min', expr: '*/30 * * * *' },
    { label: '1 hora', expr: '0 * * * *' },
    { label: '2 horas', expr: '0 */2 * * *' },
    { label: '3 horas', expr: '0 */3 * * *' },
    { label: '4 horas', expr: '0 */4 * * *' },
    { label: '8 horas', expr: '0 */8 * * *' },
    { label: '12 horas', expr: '0 */12 * * *' },
    { label: '1 día', expr: '0 0 * * *' },
];
