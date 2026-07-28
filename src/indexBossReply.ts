import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/StringSession.js';
import { NewMessage } from 'telegram/events/index.js';
import input from 'input';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// ------------------------------------------------------
// Auto Reply Telegram 
// ------------------------------------------------------
const apiId = parseInt(process.env.API_ID as string);
const apiHash = process.env.API_HASH as string;

const savedSession = process.env.SESSION_STRING || '';
const stringSession = new StringSession(savedSession);

// Đường dẫn tới file JSON lưu trạng thái người dùng
const USER_CHAT_FILE = path.join(process.cwd(), 'userChat.json');

// --- HÀM XỬ LÝ DATABASE JSON ---
function loadUserStates(): Record<string, any> {
    try {
        if (fs.existsSync(USER_CHAT_FILE)) {
            const rawData = fs.readFileSync(USER_CHAT_FILE, 'utf8');
            return JSON.parse(rawData);
        }
    } catch (error) {
        console.error('⚠️ [Error] Lỗi khi đọc file userChat.json:', error);
    }
    return {}; // Trả về object rỗng nếu file chưa tồn tại hoặc lỗi
}

function saveUserStates(data: Record<string, any>) {
    try {
        fs.writeFileSync(USER_CHAT_FILE, JSON.stringify(data, null, 4), 'utf8');
    } catch (error) {
        console.error('⚠️ [Error] Lỗi khi ghi file userChat.json:', error);
    }
}

// Khởi tạo state từ file (chỉ chạy 1 lần khi start bot)
const userStates = loadUserStates();
// Biến này vẫn lưu trên RAM vì tính chất tạm thời, không cần lưu JSON
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
    console.log('✅ Đã lưu Session String mới vào file .env!');
};

async function sendMainMenu(client: TelegramClient, senderId: string) {
    const menu = `🤖 ~(Bot Auto Reply)~ 🤖\n` +
                 `Chào bạn! Bạn cần tìm thông tin gì, hãy nhắn từ khóa tương ứng để được trả lời ngay lập tức nhé:\n\n` +
                 `1️⃣ Xem con vợ dâm đãng của tôi (Nhắn số 1 hoặc 'album')\n\n` +
                 `2️⃣ Muốn tìm liên hệ với NyanChan? (Nhắn số 2 hoặc 'liên hệ')\n\n` +
                 `3️⃣ Nhắn tin riêng trực tiếp với tôi (Nhắn số 3 hoặc 'chat riêng')`;
                 
    try {
        // 1. Lấy 15 tin nhắn gần nhất trong mục Saved Messages ('me')
        const savedMsgs = await client.getMessages('me', { limit: 15 }); 
        
        // 2. Tìm tin nhắn đầu tiên có chứa media (chính là cái video ông vừa gửi)
        const videoMsg = savedMsgs.find(msg => msg.media);
        const videoMedia = videoMsg?.media;

        // 3. Gửi menu kèm video
        if (videoMedia) {
            await client.sendMessage(senderId, { 
                message: menu,
                file: videoMedia // Lấy đúng object media gán vào đây
            });
        } else {
            // Đề phòng trường hợp ông xóa mất video trong Saved Messages
            await client.sendMessage(senderId, { message: menu });
        }
    } catch (err) {
        console.error(`[Error] Không thể gửi Main Menu cho ${senderId}:`, err);
    }
}

(async () => {
    console.log("Connecting to Telegram...");
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });
    
    await client.start({
        phoneNumber: async () => await input.text('Nhập số điện thoại:'),
        password: async () => await input.text('Nhập mật khẩu 2 lớp (nếu có):'),
        phoneCode: async () => await input.text('Nhập code Telegram gửi về:'),
        onError: (err) => console.log(err),
    });
    console.log('✅ Đăng nhập thành công!');
    
    const currentSessionString = String(client.session.save());

    if (!savedSession && currentSessionString) {
        saveSession(currentSessionString);
    }

    client.addEventHandler(async (event) => {
        const message = event.message;
        
        if (message.out || !message.isPrivate) return;

        const sender = await message.getSender() as unknown as Api.User;
        if (sender && sender.bot) {
            return; // Bỏ qua bot
        }
        
        const senderId = sender?.id.toString() || '';
        if (!senderId) return;

        // --- CƠ CHẾ CHỐNG SPAM (RATE LIMITING) ---
        const now = Date.now();
        const userLastTime = lastMessageTime[senderId] || 0;
        if (now - userLastTime < 3000) { 
            console.log(`[Spam Guard] Chặn tin nhắn spam từ ${senderId}`);
            return;
        }
        lastMessageTime[senderId] = now;

        // Lấy thông tin user để lưu vào JSON
        const username = sender.username || '';
        const displayName = `${sender.firstName || ''} ${sender.lastName || ''}`.trim() || 'Người Lạ';
        const userText = (message.message || '').trim();
        const textLower = userText.toLowerCase();

        // Khởi tạo profile nếu user chưa có trong database
        if (!userStates[senderId]) {
            userStates[senderId] = {
                id: senderId,
                username: username,
                displayName: displayName,
                mode: 'AUTO'
            };
            saveUserStates(userStates); // Lưu ngay
        }

        // ========================================================
        // CASE 1: DIRECT CHAT MODE
        // ========================================================
        if (userStates[senderId].mode === 'CHAT_DIRECT') {
            if (textLower === 'bot' || textLower === '0') {
                userStates[senderId].mode = 'AUTO';
                saveUserStates(userStates); // Cập nhật lại file JSON
                
                await sendMainMenu(client, senderId);
                return;
            }
            return; // Đang ở CHAT_DIRECT, bot im lặng
        }

        // ========================================================
        // CASE 2: AUTOMATIC ASSISTANT MODE (AUTO)
        // ========================================================
        try {
            if (userText === '1' || /album|ảnh|vợ|dâm|alb|mua|xem|clip/i.test(textLower)) {
                await client.sendMessage(senderId, { 
                    message: "📸 **Thông tin Album:**\nĐây là bộ album ảnh/video cực dâm đãng của con vợ tôi. Bạn có thể xem tại đây: @albumsalekhachviet" 
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
                // Đổi trạng thái sang CHAT_DIRECT và lưu vào file
                userStates[senderId].mode = 'CHAT_DIRECT';
                saveUserStates(userStates);
                
                await client.sendMessage(senderId, { 
                    message: "Đợi xíu đang gạ con bồ đi chịch rồi. Xíu rep cho.\n\n*(Nhắn số '0' hoặc chữ 'bot' nếu muốn gọi lại trợ lý tự động nhé)*" 
                });
                
                return;
            }

            // Fallback gửi menu chính
            await sendMainMenu(client, senderId);

        } catch (err) {
            console.error(`[Error] Lỗi khi xử lý tin nhắn của ${senderId}:`, err);
        }

    }, new NewMessage({}));

    console.log('🤖 Bot is listening...');
})();

// Bắt các lỗi không được xử lý (Uncaught Exceptions)
process.on('uncaughtException', (err) => {
    console.error('🔥 [Fatal Error] Uncaught Exception:', err);
    // Lưu log ra file hoặc thông báo, nhưng không để tắt bot
});

// Bắt các lỗi Promise bị từ chối (Unhandled Rejections)
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [Warning] Unhandled Rejection at:', promise, 'reason:', reason);
    // Tương tự, log lại để fix sau chứ không sập app
});