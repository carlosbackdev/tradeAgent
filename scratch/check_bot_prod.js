
async function checkBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();
    console.log('Bot Info (PROD):', JSON.stringify(data, null, 2));
}
checkBot();
