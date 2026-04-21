
import 'dotenv/config';

async function checkBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.error('No token found');
        return;
    }
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();
    console.log('Bot Info:', JSON.stringify(data, null, 2));
}

checkBot();
