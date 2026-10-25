import { Telegraf, Context, Markup} from 'telegraf';
import dotenv from 'dotenv';

dotenv.config();

const bot = new Telegraf<NyanContext>(process.env.BOT_TOKEN_NyanChan2k3 as string);

const replyMessage = "Pé NyanChan đã ngưng hoạt động. A iu qua @NyxumeiBot nhé ❤️ ~";
const replyKeyboard = Markup.inlineKeyboard([
    Markup.button.url('👉 Sang nhà mới @NyxumeiBot', 'https://t.me/nyxumeibot')
]);

interface NyanContext extends Context {
}

// Phản hồi khi khách gõ lệnh /start
bot.start(async (ctx) => {
    try {
        await ctx.reply(replyMessage, replyKeyboard);
    } catch (error) {}
});

// Phản hồi khi khách gửi tin nhắn, ảnh, sticker... bất kỳ
bot.on('message', async (ctx) => {
    try {
        await ctx.reply(replyMessage, replyKeyboard);
    } catch (error) {}
});

bot.launch({ dropPendingUpdates: true });
console.log("Bot NyanChan (thông báo ngưng hoạt động) đã lên sóng!");


process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));