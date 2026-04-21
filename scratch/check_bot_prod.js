
async function checkBot() {
    const token = "8710323951:AAE_BZFUBAVOQshQOPXyS8kHl6fHnnJpwcM";
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();
    console.log('Bot Info (PROD):', JSON.stringify(data, null, 2));
}
checkBot();
