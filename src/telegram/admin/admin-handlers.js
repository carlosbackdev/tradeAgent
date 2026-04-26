/**
 * telegram/admin/admin-handlers.js
 * Admin-only command handlers extracted from TelegramHandlers.
 * Requires a botContext with: sendMessage, chatId, isAdmin.
 */

export class AdminHandlers {
    constructor(botContext) {
        this.ctx = botContext;
    }

    async handleInvite(username) {
        if (!username) {
            await this.ctx.sendMessage('❌ Uso: `/invite @username`');
            return;
        }
        const { inviteUser } = await import('../../users/user-registry.js');
        const result = await inviteUser({
            telegramUsername: username.replace('@', ''),
            invitedBy: String(this.ctx.chatId)
        });

        if (result.ok) {
            const botUsername = process.env.TELEGRAM_BOT_USERNAME;
            if (!botUsername) {
                await this.ctx.sendMessage(`✅ @${result.username} ha sido invitado. Configura TELEGRAM_BOT_USERNAME para generar el enlace de invitación.`);
                return;
            }

            const inviteLink = `https://t.me/${botUsername}?start=invite_${result.inviteCode}`;
            await this.ctx.sendMessage(
                `✅ @${result.username} ha sido invitado.\n\n` +
                `Pásale este enlace para activar su acceso:\n${inviteLink}`
            );
        } else {
            await this.ctx.sendMessage(`⚠️ ${result.reason}`);
        }
    }

    async handleListUsers() {
        const { listUsers } = await import('../../users/user-registry.js');
        const users = await listUsers();
        if (!users.length) {
            await this.ctx.sendMessage('No hay usuarios registrados.');
            return;
        }

        const statusEmoji = { pending_invite: '⏳', pending_setup: '🔧', active: '✅', suspended: '🚫' };
        let msg = `👥 <b>Usuarios registrados</b> (${users.length})\n\n`;
        for (const u of users) {
            const emoji = statusEmoji[u.status] || '❓';
            msg += `${emoji} @${u.telegram_username || '?'} — ${u.status}\n`;
            msg += `   ID: <code>${u.telegram_id || 'pte'}</code> | Pares: ${u.config?.TRADING_PAIRS || '—'}\n`;
        }
        await this.ctx.sendMessage(msg, { parse_mode: 'HTML' });
    }

    async handleRevokeUser(username) {
        if (!username) {
            await this.ctx.sendMessage('❌ Uso: `/revoke @username`');
            return;
        }
        const { revokeUser } = await import('../../users/user-registry.js');
        const result = await revokeUser(username.replace('@', ''));

        if (result.ok) {
            await this.ctx.sendMessage(`🚫 @${result.username} ha sido suspendido.`);
            // Note: Session destruction is handled by the multi-user-bot router reactively if needed
        } else {
            await this.ctx.sendMessage(`⚠️ ${result.reason}`);
        }
    }

    async handleAdminStatus() {
        const { listUsers } = await import('../../users/user-registry.js');
        const users = await listUsers();
        const active = users.filter(u => u.status === 'active').length;
        const pending = users.filter(u => u.status === 'pending_setup' || u.status === 'pending_invite').length;

        await this.ctx.sendMessage(
            `🤖 <b>Admin Status</b>\n\n` +
            `👥 Total usuarios: ${users.length}\n` +
            `✅ Activos: ${active}\n` +
            `🔧 Pendientes: ${pending}\n` +
            `🖥 Node: ${process.version}`,
            { parse_mode: 'HTML' }
        );
    }
}
