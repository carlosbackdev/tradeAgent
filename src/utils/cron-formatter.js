

export function cronExpressionToMinutes(expr) {
    if (!expr) return null;

    if (expr === '*/5 * * * *') return 5;
    if (expr === '*/15 * * * *') return 15;
    if (expr === '*/30 * * * *') return 30;
    if (expr === '0 * * * *') return 60;
    if (expr === '0 */2 * * *') return 120;
    if (expr === '0 */3 * * *') return 180;
    if (expr === '0 */4 * * *') return 240;
    if (expr === '0 */8 * * *') return 480;
    if (expr === '0 */12 * * *') return 720;
    if (expr === '0 0 * * *') return 1440;

    return null;
}

export function getCrossSymbolLookbackMinutes(cronExpr) {
    const cronMinutes = cronExpressionToMinutes(cronExpr);
    if (!cronMinutes) return 120;
    return cronMinutes * 2;
}