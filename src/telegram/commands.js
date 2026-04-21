export class TelegramCommands {
    constructor(handlers, sendMessage) {
        this.handlers = handlers;
        this.sendMessage = sendMessage;
    }

    async processTextMessage(message) {
        if (!message?.text) return;

        const full = message.text.trim();
        const [cmd, ...argParts] = full.split(' ');
        const args = argParts.join(' ');
        const command = cmd.toLowerCase();

        const isAdmin = this.handlers.ctx?.isAdmin;

        // ── Si el bot está esperando una respuesta del usuario (config, invitación, pregunta) ──
        const state = this.handlers.configState;
        if (state?.isInviting || state?.isConfiguring || state?.mode) {
            await this.handlers.handleConfigInput(full);
            return;
        }

        switch (command) {
            case '/start': await this.handlers.handleStart(); break;
            case '/help': await this.handlers.handleHelp(); break;
            case '/status': await this.handlers.handleStatus(); break;
            case '/trigger': await this.handlers.handleHelp(); break; // Note: Original bot uses trigger via menu but this allows cmd
            case '/configuration': await this.handlers.handleConfiguration(); break;
            case '/cron': await this.handlers.handleCron(args); break;
            case '/cron_on': await this.handlers.handleCron('on'); break;
            case '/cron_off': await this.handlers.handleCron('off'); break;
            case '/cron_5m': await this.handlers.handleCron('*/5 * * * *'); break;
            case '/cron_15m': await this.handlers.handleCron('*/15 * * * *'); break;
            case '/cron_30m': await this.handlers.handleCron('*/30 * * * *'); break;
            case '/cron_1h': await this.handlers.handleCron('0 * * * *'); break;
            case '/cron_2h': await this.handlers.handleCron('0 */2 * * *'); break;
            case '/cron_3h': await this.handlers.handleCron('0 */3 * * *'); break;
            case '/cron_4h': await this.handlers.handleCron('0 */4 * * *'); break;
            case '/cron_8h': await this.handlers.handleCron('0 */8 * * *'); break;
            case '/cron_12h': await this.handlers.handleCron('0 */12 * * *'); break;
            case '/cron_1d': await this.handlers.handleCron('0 0 * * *'); break;
            case '/btc': await this.handlers.handleCoinCommand('BTC'); break;
            case '/eth': await this.handlers.handleCoinCommand('ETH'); break;
            case '/sol': await this.handlers.handleCoinCommand('SOL'); break;
            case '/venice': await this.handlers.handleCoinCommand('VENICE'); break;
            case '/xrp': await this.handlers.handleCoinCommand('XRP'); break;
            case '/stats': await this.handlers.handleTradingStats(); break;
            
            // Admin commands
            case '/admin':
                if (isAdmin) await this.handlers.handleAdminMenu();
                else await this.sendMessage('❓ Comando reservado para el administrador.');
                break;
            case '/invite': 
                if (isAdmin) await this.handlers.handleInvite(args); 
                else await this.sendMessage('❓ Comando reservado para el administrador.');
                break;
            case '/users':
                if (isAdmin) await this.handlers.handleListUsers();
                else await this.sendMessage('❓ Comando reservado para el administrador.');
                break;
            case '/revoke':
                if (isAdmin) await this.handlers.handleRevokeUser(args);
                else await this.sendMessage('❓ Comando reservado para el administrador.');
                break;
            case '/admin_status':
                if (isAdmin) await this.handlers.handleAdminStatus();
                else await this.sendMessage('❓ Comando reservado para el administrador.');
                break;

            default:
                await this.sendMessage('❓ Comando no reconocido. Usa /help');
        }
    }
}
