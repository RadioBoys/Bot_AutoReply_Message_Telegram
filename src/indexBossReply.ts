import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/StringSession.js';
import { NewMessage } from 'telegram/events/index.js';
import input from 'input';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

dotenv.config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } 
});

pool.on('error', (err) => {});

const COMMAND_GROUP_ID = '-1004446324011';

const apiId = parseInt(process.env.API_ID as string);
const apiHash = process.env.API_HASH as string;

const savedSession = process.env.SESSION_STRING || '';
const stringSession = new StringSession(savedSession);

const USER_CHAT_FILE = path.join(process.cwd(), 'userChat.json');

function loadUserStates(): Record<string, any> {
    try {
        if (fs.existsSync(USER_CHAT_FILE)) {
            const rawData = fs.readFileSync(USER_CHAT_FILE, 'utf8');
            return JSON.parse(rawData);
        }
    } catch (error) {}
    return {};
}

function saveUserStates(data: Record<string, any>) {
    try {
        fs.writeFileSync(USER_CHAT_FILE, JSON.stringify(data, null, 4), 'utf8');
    } catch (error) {}
}

const userStates = loadUserStates();
const lastMessageTime: Record<string, number> = {};

function saveSession(newSessionString: string) {
    const envFilePath = '.env';
    let envContent = '';

    if (fs.existsSync(envFilePath)) {
        envContent = fs.readFileSync(envFilePath, 'utf8');
    }

    if (envContent.includes('SESSION_STRING=')) {
        envContent = envContent.replace(/SESSION_STRING=.*/g, `SESSION_STRING=${newSessionString}`);
    } else {
        envContent += `\nSESSION_STRING=${newSessionString}\n`;
    }

    fs.writeFileSync(envFilePath, envContent.trim() + '\n');
};

async function sendMainMenu(client: TelegramClient, senderId: string) {
    const menu = `🤖 ~(Bot Auto Reply)~ 🤖\n` +
                 `Chào bạn! Bạn cần tìm thông tin gì, hãy nhắn từ khóa tương ứng để được trả lời ngay lập tức nhé:\n\n` +
                 `1️⃣ Xem con vợ dâm đãng của tôi (Nhắn số 1 hoặc 'album')\n\n` +
                 `2️⃣ Muốn tìm liên hệ với NyanChan? (Nhắn số 2 hoặc 'liên hệ')\n\n` +
                 `3️⃣ Nhắn tin riêng trực tiếp với tôi (Nhắn số 3 hoặc 'chat riêng')`;
                 
    try {
        const savedMsgs = await client.getMessages('me', { limit: 15 }); 
        const videoMsg = savedMsgs.find(msg => msg.media);
        const videoMedia = videoMsg?.media;

        if (videoMedia) {
            await client.sendMessage(senderId, { 
                message: menu,
                file: videoMedia 
            });
        } else {
            await client.sendMessage(senderId, { message: menu });
        }
    } catch (err) {}
}

(async () => {
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });
    
    await client.start({
        phoneNumber: async () => await input.text('Phone:'),
        password: async () => await input.text('Password:'),
        phoneCode: async () => await input.text('Code:'),
        onError: (err) => console.log(err),
    });
    
    const currentSessionString = String(client.session.save());

    if (!savedSession && currentSessionString) {
        saveSession(currentSessionString);
    }

    client.addEventHandler(async (event) => {
        const message = event.message;
        
        const chatId = message.chatId?.toString() || '';
        const isCommandGroup = chatId === COMMAND_GROUP_ID;

        if (message.out && !isCommandGroup) return;
        if (!message.isPrivate && !isCommandGroup) return;

        const sender = await message.getSender() as unknown as Api.User;
        if (sender && sender.bot) return;
        
        const senderId = sender?.id.toString() || '';
        if (!senderId && message.out) {
        } else if (!senderId) {
             return;
        }

        const userText = (message.message || '').trim();
        const textLower = userText.toLowerCase();

        if (isCommandGroup) {
            if (userText.startsWith('/list')) {
                try {
                    const res = await pool.query('SELECT id, name, link FROM url_telegram WHERE is_active = true ORDER BY id ASC');
                    let msg = '📋 Danh sách link active:\n';
                    res.rows.forEach(r => msg += `- ID: ${r.id} | ${r.name} | ${r.link}\n`);
                    await client.sendMessage(chatId, { message: msg || 'Trống' });
                } catch (err) {}
                return;
            }

            if (userText.startsWith('/searchlink')) {
                const keyword = userText.replace('/searchlink', '').trim();
                try {
                    const res = await pool.query('SELECT id, name, link, is_active FROM url_telegram WHERE name ILIKE $1', [`%${keyword}%`]);
                    let msg = `🔍 Kết quả tìm kiếm cho '${keyword}':\n`;
                    res.rows.forEach(r => msg += `- ID: ${r.id} | ${r.name} | ${r.link} | Active: ${r.is_active}\n`);
                    await client.sendMessage(chatId, { message: msg || 'Không tìm thấy' });
                } catch (err) {}
                return;
            }

            if (userText.startsWith('/editlink')) {
                const parts = userText.replace('/editlink', '').split('|').map(s => s.trim());
                if (parts.length >= 4) {
                    const id = parseInt(parts[0] ?? '', 10);
                    const newName = parts[1];
                    const newLink = parts[2];
                    const isActive = parts[3]?.toLowerCase() === 'true';
                    try {
                        await pool.query('UPDATE url_telegram SET name = $1, link = $2, is_active = $3, update_time = NOW() WHERE id = $4', [newName, newLink, isActive, id]);
                        await client.sendMessage(chatId, { message: `✅ Cập nhật ID ${id} thành công!` });
                    } catch(err) {}
                } else {
                    await client.sendMessage(chatId, { message: `❌ Cú pháp: /editlink id | name | link | true/false` });
                }
                return;
            }

            const linkRegex = /(?:https?:\/\/)?t\.me\/(joinchat\/|\+)?([\w-]+)/i;
            const match = userText.match(linkRegex);

            if (match) {
                const fullLink = match[0].startsWith('http') ? match[0] : `https://${match[0]}`;
                const isPrivateLink = !!match[1];
                const hashOrUsername = match[2]!;
                
                let groupName = "Unknown";
                let groupType = "Unknown";
                let isActive = true;

                try {
                    if (isPrivateLink) {
                        const inviteInfo = await client.invoke(new Api.messages.CheckChatInvite({ hash: hashOrUsername }));
                        
                        if (inviteInfo.className === 'ChatInviteAlready') {
                            const chat = inviteInfo.chat as any;
                            groupName = chat.title;
                            if (chat.className === 'Channel') {
                                groupType = chat.broadcast ? 'Channel Private' : 'Group Private';
                            } else {
                                groupType = 'Group Private';
                            }
                        } else if (inviteInfo.className === 'ChatInvite') {
                            groupName = inviteInfo.title;
                            groupType = (inviteInfo as any).broadcast ? 'Channel Private' : 'Group Private';
                        }
                    } else {
                        const entity = await client.getEntity(hashOrUsername) as any;
                        groupName = entity.title || entity.firstName || "Unknown";
                        
                        if (entity.className === 'Channel') {
                            groupType = entity.broadcast ? 'Channel Public' : 'Group Public';
                        } else if (entity.className === 'Chat') {
                            groupType = 'Group Public';
                        }
                    }

                    const query = `
                        INSERT INTO url_telegram (name, link, type, update_time, is_active)
                        VALUES ($1, $2, $3, NOW(), $4)
                        ON CONFLICT (link) DO UPDATE 
                        SET update_time = NOW(), name = EXCLUDED.name, type = EXCLUDED.type, is_active = EXCLUDED.is_active;
                    `;
                    await pool.query(query, [groupName, fullLink, groupType, isActive]);

                    await client.sendMessage(chatId, { 
                        message: `✅ LƯU THÀNH CÔNG!\n- Tên: ${groupName}\n- Type: ${groupType}\n- Link: ${fullLink}` 
                    });
                    
                    await client.deleteMessages(chatId, [message.id], { revoke: true });

                } catch (err: any) {
                    await client.sendMessage(chatId, { 
                        message: `❌ LỖI LINK: ${err.message}` 
                    });
                    
                    if (err.message.includes("INVITE_HASH_EXPIRED") || err.message.includes("USERNAME_INVALID")) {
                        await pool.query(
                            `INSERT INTO url_telegram (name, link, type, update_time, is_active)
                             VALUES ('N/A', $1, 'Unknown', NOW(), false)
                             ON CONFLICT (link) DO UPDATE SET update_time = NOW(), is_active = false;`,
                            [fullLink]
                        );
                    }
                    
                    await client.deleteMessages(chatId, [message.id], { revoke: true });
                }
            }
            return; 
        }

        const now = Date.now();
        const userLastTime = lastMessageTime[senderId] || 0;
        if (now - userLastTime < 3000) { 
            return;
        }
        lastMessageTime[senderId] = now;

        const username = sender.username || '';
        const displayName = `${sender.firstName || ''} ${sender.lastName || ''}`.trim() || 'Người Lạ';

        if (!userStates[senderId]) {
            userStates[senderId] = {
                id: senderId,
                username: username,
                displayName: displayName,
                mode: 'AUTO'
            };
            saveUserStates(userStates); 
        }

        if (userStates[senderId].mode === 'CHAT_DIRECT') {
            if (textLower === 'bot' || textLower === '0') {
                userStates[senderId].mode = 'AUTO';
                saveUserStates(userStates); 
                
                await sendMainMenu(client, senderId);
                return;
            }
            return;
        }

        try {
            if (userText === '1' || /album|ảnh|vợ|dâm|alb|mua|xem|clip/i.test(textLower)) {
                await client.sendMessage(senderId, { 
                    message: "📸 **Thông tin Album:**\nĐây là bộ album ảnh/video cực dâm đãng của con vợ tôi. Bạn có thể xem tại đây: @NyanAutoReplyBot" 
                });
                return;
            } 
            
            if (userText === '2' || /liên hệ|contact|info|nyanchan|nyan/i.test(textLower)) {
                await client.sendMessage(senderId, { 
                    message: "ℹ️ **Thông tin liên hệ NyanChan:**\nBạn có thể kết nối qua các kênh sau:\n- Telegram: @NyanSexDoll\n- Link tổng hợp: Getmysocial.com/nyanchan2k3" 
                });
                return;
            } 
            
            if (userText === '3' || /chat riêng|nhắn tin|gặp trực tiếp|rep đi/i.test(textLower)) {
                userStates[senderId].mode = 'CHAT_DIRECT';
                saveUserStates(userStates);
                
                await client.sendMessage(senderId, { 
                    message: "Đợi xíu đang gạ con bồ đi chịch rồi. Xíu rep cho.\n\n*(Nhắn số '0' hoặc chữ 'bot' nếu muốn gọi lại trợ lý tự động nhé)*" 
                });
                
                return;
            }

            await sendMainMenu(client, senderId);

        } catch (err) {}

    }, new NewMessage({}));

})();

process.on('uncaughtException', (err) => {});
process.on('unhandledRejection', (reason, promise) => {});