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
bot.command('broadcast', async (ctx) => {
    const adminId = ctx.from?.id;
    if (!adminId || !ADMIN_IDS.includes(adminId)) return;

    const text = (ctx.message as any)?.text || '';
    const rawTemplate = text.replace(/^\/broadcast(@\w+)?\s*/i, '').trim();

    if (!rawTemplate) {
        return ctx.reply(
            '⚠️ <b>Thiếu nội dung thông báo!</b>\n\n' +
            '👉 Cú pháp: <code>/broadcast [Nội dung thông báo]</code>\n' +
            '💡 Dùng <code>{name}</code> ở nơi muốn chèn tên khách.',
            { parse_mode: 'HTML' }
        );
    }

    try {
        // Lấy TOÀN BỘ user trong database
        const res = await pool.query('SELECT user_id, full_name FROM users_data');
        const users = res.rows;

        if (users.length === 0) {
            return ctx.reply('⚠️ Không tìm thấy người dùng nào trong database!');
        }

        const startMsg = await ctx.reply(`⏳ Đang chạy ngầm gửi thông báo cho <b>${users.length}</b> người dùng...`, { parse_mode: 'HTML' });

        // Tự động xóa thông báo bắt đầu sau 1 phút
        setTimeout(async () => {
            try {
                await ctx.telegram.deleteMessage(adminId, startMsg.message_id);
            } catch (err) { }
        }, 60000);

        // Chạy ngầm trong nền
        (async () => {
            let successCount = 0;
            let failCount = 0;
            let batchCounter = 0;
            let currentBatchNames: string[] = [];

            for (const user of users) {
                let rawName = (user.full_name || '').trim() || 'anh';
                
                // Escape HTML để tránh lỗi vỡ định dạng
                const safeName = rawName
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');

                try {
                    const broadcastText = rawTemplate.replace(/\{name\}/g, `<b>${safeName}</b>`);

                    const sentMsg = await ctx.telegram.sendMessage(user.user_id, broadcastText, {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Menu', url: 'https://t.me/NyxumeiBot?start=1' }]
                            ]
                        }
                    });

                    if (typeof addSystemMessageId === 'function') {
                        await addSystemMessageId(Number(user.user_id), sentMsg.message_id);
                    }

                    successCount++;
                    currentBatchNames.push(safeName);
                } catch (err: any) {
                    failCount++;
                    // Nếu Telegram trả mã lỗi 429 (Too Many Requests), dừng chờ theo yêu cầu của Telegram
                    if (err?.response?.error_code === 429) {
                        const retryAfter = err?.response?.parameters?.retry_after || 5;
                        await new Promise(r => setTimeout(r, retryAfter * 1000));
                    }
                }

                batchCounter++;

                // Mỗi đợt 25 người, gửi danh sách tên về cho Admin (tự hủy sau 60s)
                if (batchCounter >= 25) {
                    if (currentBatchNames.length > 0) {
                        const listNames = currentBatchNames.map((n, idx) => `${idx + 1}. ${n}`).join('\n');
                        const progressText = `📨 <b>Đã gửi thành công cho đợt (${successCount}/${users.length}):</b>\n\n${listNames}\n\n<i>(Tin nhắn này sẽ tự hủy sau 1 phút)</i>`;

                        try {
                            const sentLogMsg = await ctx.telegram.sendMessage(adminId, progressText, { parse_mode: 'HTML' });
                            
                            setTimeout(async () => {
                                try {
                                    await ctx.telegram.deleteMessage(adminId, sentLogMsg.message_id);
                                } catch (e) { }
                            }, 60000);
                        } catch (e) { }

                        currentBatchNames = [];
                    }

                    batchCounter = 0;
                    await new Promise(r => setTimeout(r, 1500)); // Nghỉ xả băng thông 1.5s
                } else {
                    await new Promise(r => setTimeout(r, 60)); // Giãn cách 60ms
                }
            }

            // Gửi nốt danh sách đợt cuối cùng nếu còn sót
            if (currentBatchNames.length > 0) {
                const listNames = currentBatchNames.map((n, idx) => `${idx + 1}. ${n}`).join('\n');
                const progressText = `📨 <b>Đã gửi thành công cho đợt cuối (${successCount}/${users.length}):</b>\n\n${listNames}\n\n<i>(Tin nhắn này sẽ tự hủy sau 1 phút)</i>`;
                try {
                    const sentLogMsg = await ctx.telegram.sendMessage(adminId, progressText, { parse_mode: 'HTML' });
                    setTimeout(async () => {
                        try {
                            await ctx.telegram.deleteMessage(adminId, sentLogMsg.message_id);
                        } catch (e) { }
                    }, 60000);
                } catch (e) { }
            }

            // Báo cáo tổng kết hoàn thành chiến dịch
            await ctx.telegram.sendMessage(
                adminId,
                `✅ <b>Hoàn tất toàn bộ chiến dịch broadcast!</b>\n\n` +
                `- Tổng số khách: ${users.length}\n` +
                `- Gửi thành công: ${successCount}\n` +
                `- Thất bại (đã chặn bot/lỗi): ${failCount}`,
                { parse_mode: 'HTML' }
            );

        })().catch(err => {
            console.error('Lỗi ngầm broadcast:', err);
        });

    } catch (error) {
        console.error('Lỗi khi truy xuất Database:', error);
        ctx.reply('❌ Có lỗi xảy ra khi đọc dữ liệu.');
    }
});

bot.on('message', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    try {
        await ctx.reply(replyMessage, replyKeyboard);
    } catch (error) { }
});



bot.launch({ dropPendingUpdates: true });
console.log("Bot NyanChan (thông báo ngưng hoạt động) đã lên sóng!");


process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));