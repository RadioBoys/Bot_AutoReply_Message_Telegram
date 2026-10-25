import { Telegraf, Context, Markup } from 'telegraf';
import dotenv from 'dotenv';
import { Pool } from 'pg';


dotenv.config();

const bot = new Telegraf<NyanContext>(process.env.BOT_TOKEN_NyanChan2k3 as string);
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(Number) : [];
const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

const replyMessage = "Pé NyanChan đã ngưng hoạt động. A iu qua @NyxumeiBot nhé ❤️ ~";
const replyKeyboard = Markup.inlineKeyboard([
    Markup.button.url('👉 Sang nhà mới @NyxumeiBot', 'https://t.me/nyxumeibot')
]);

interface NyanContext extends Context {
}

async function addSystemMessageId(userId: number, messageId: number) {
    try {
        const query = `
                UPDATE users_data 
                SET system_message_ids = array_append(COALESCE(system_message_ids, '{}'), $1)
                WHERE user_id = $2;
            `;
        await pool.query(query, [messageId, userId]);
    } catch (error) {
        console.error(error);
    }
}


// Phản hồi khi khách gõ lệnh /start
bot.start(async (ctx) => {
    try {
        await ctx.reply(replyMessage, replyKeyboard);
    } catch (error) { }
});

bot.on('message', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    try {
        await ctx.reply(replyMessage, replyKeyboard);
    } catch (error) { }
});

bot.command('broadcast', async (ctx) => {
    const ctxAny = ctx as any;
    const adminId = ctxAny.from?.id;

    // Giới hạn quyền chỉ Admin mới được dùng lệnh[cite: 5]
    if (!adminId || !ADMIN_IDS.includes(adminId)) return;

    // Lấy nội dung template phía sau lệnh /broadcast
    const rawTemplate = (ctxAny.payload || '').trim();
    if (!rawTemplate) {
        return ctx.reply(
            '⚠️ <b>Thiếu nội dung thông báo!</b>\n\n' +
            '👉 Nhập cú pháp: <code>/broadcast [Nội dung của ông]</code>\n' +
            '💡 Mẹo: Dùng <code>{name}</code> ở nơi ông muốn chèn tên khách.\n\n' +
            '<i>Ví dụ:</i>\n' +
            '<code>/broadcast Anh iu {name} ơi, Em có sản phẩm mới nè ❤️</code>',
            { parse_mode: 'HTML' }
        );
    }

    try {
        // Lấy danh sách user_id và full_name từ database[cite: 23, 37]
        const res = await pool.query('SELECT user_id, full_name FROM users_data');
        const users = res.rows;

        if (users.length === 0) {
            return ctx.reply('⚠️ Chưa có dữ liệu người dùng nào trong database!');
        }

        await ctx.reply(`⏳ Đang bắt đầu gửi thông báo cho ${users.length} người dùng...`);

        let successCount = 0;
        let failCount = 0;

        for (const user of users) {
            try {
                // Xử lý tên hiển thị
                let displayName = (user.full_name || '').trim() || 'anh';

                // Escape ký tự HTML để tránh lỗi format cú pháp nếu tên user có chứa ký tự đặc biệt
                displayName = displayName
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');

                // Thay thế thẻ {name} bằng tên của user (thay thế toàn bộ {name} nếu có nhiều chỗ)
                const broadcastText = rawTemplate.replace(/\{name\}/g, `<b>${displayName}</b>`);

                const sentMsg = await ctx.telegram.sendMessage(user.user_id, broadcastText, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Menu', url: 'https://t.me/NyxumeiBot?start=1' }]
                        ]
                    }
                });

                // Lưu message_id để tự dọn dẹp khi user bấm tương tác menu[cite: 37]
                if (typeof addSystemMessageId === 'function') {
                    await addSystemMessageId(Number(user.user_id), sentMsg.message_id);
                }

                successCount++;
            } catch (err) {
                // User đã chặn bot hoặc xóa tài khoản
                failCount++;
            }

            // Khoảng nghỉ 50ms giữa mỗi tin nhắn tránh Telegram chặn Rate Limit
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        await ctx.reply(`✅ <b>Đã gửi thông báo hoàn tất!</b>\n\n- Thành công: ${successCount}\n- Thất bại (đã chặn bot): ${failCount}`, { parse_mode: 'HTML' });

    } catch (error) {
        console.error('Lỗi khi broadcast thông báo:', error);
        ctx.reply('❌ Có lỗi xảy ra khi truy xuất Database.');
    }
});

bot.launch({ dropPendingUpdates: true });
console.log("Bot NyanChan (thông báo ngưng hoạt động) đã lên sóng!");


process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));