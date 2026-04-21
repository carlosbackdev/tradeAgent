
import crypto from 'crypto';

function testRegex() {
    const text = "/start invite_791888ceed92ed622f1fc5722aa61a0e";
    const startMatch = text.trim().match(/^\/start(?:\s+(.+))?$/i);
    console.log('Match result:', startMatch);
    if (startMatch) {
        const startPayload = startMatch[1] || null;
        console.log('Payload:', startPayload);
        if (startPayload && startPayload.startsWith('invite_')) {
            const inviteCode = startPayload.replace('invite_', '').trim();
            console.log('Invite code:', inviteCode);
        }
    }
}

testRegex();
