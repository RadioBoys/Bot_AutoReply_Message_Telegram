import { Pool } from 'pg';
import { Telegraf, Context } from 'telegraf';
import dotenv from 'dotenv';
import fs from 'fs';
import express from 'express';

dotenv.config();

const bot = new Telegraf<NyanContext>(process.env.BOT_TOKEN as string);
const GROUP_NOTI_PAYMENT = process.env.GROUP_NOTI_PAYMENT ? Number(process.env.GROUP_NOTI_PAYMENT) : null;

interface NyanContext extends Context {
}

interface Album {
    id: number;
    title: string;
    linkAlbum?: string[];
    path: string;
    fileid?: string;
    type: 'photo' | 'video';
    tags: string[];
    price: string;
    description: string;
}

let albums: Album[] = [];

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function loadAllAlbumsData() {
    try {
        const result = await pool.query('SELECT * FROM albums ORDER BY id DESC');
        albums = result.rows.map(row => ({
            id: row.id,
            title: row.title,
            linkAlbum: row.link_album,
            path: row.path,
            fileid: row.fileid,
            type: row.type,
            tags: row.tags,
            price: row.price ? String(row.price).replace(/000$/, 'k') : "0",
            description: row.description
        }));
        console.log(`Loaded ${albums.length} albums successfully from PostgreSQL database!`);
    } catch (error) {
        console.error("Failed to load albums from PostgreSQL:", error);
    }
}

pool.connect()
    .then(() => {
        console.log("Connected to PostgreSQL database successfully!");
        loadAllAlbumsData();
    })
    .catch((err) => console.error("Failed to connect to PostgreSQL database:", err));

async function getUserBalance(userId: number): Promise<number> {
    try {
        const result = await pool.query('SELECT balance FROM users_data WHERE user_id = $1', [userId]);
        if (result.rows.length > 0) {
            return Number(result.rows[0].balance) || 0;
        }
        return 0;
    } catch (error) {
        console.error(error);
        return 0;
    }
}

async function updateUserBalance(userId: number, amount: number): Promise<number> {
    try {
        const query = `
            UPDATE users_data
            SET balance = COALESCE(balance, 0) + $1
            WHERE user_id = $2
            RETURNING balance;
        `;
        const result = await pool.query(query, [amount, userId]);
        if (result.rows.length > 0) {
            return Number(result.rows[0].balance);
        }
        return 0;
    } catch (error) {
        console.error(error);
        return 0;
    }
}

async function setPendingOrder(userId: number, orderCode: string, albumId: number, qrMessageId: number) {
    try {
        const query = `
            UPDATE users_data 
            SET order_code = $1, pending_album_id = $2, qr_message_id = $3, warn_message_ids = '{}'
            WHERE user_id = $4;
        `;
        await pool.query(query, [orderCode, albumId, qrMessageId, userId]);
    } catch (error) {
        console.error(error);
    }
}

async function clearPendingOrder(userId: number) {
    try {
        const query = `
            UPDATE users_data 
            SET order_code = NULL, pending_album_id = NULL, qr_message_id = NULL, warn_message_ids = '{}'
            WHERE user_id = $1;
        `;
        await pool.query(query, [userId]);
    } catch (error) {
        console.error(error);
    }
}

async function addWarnMessageId(userId: number, warnMsgId: number) {
    try {
        const query = `
            UPDATE users_data 
            SET warn_message_ids = array_append(COALESCE(warn_message_ids, '{}'), $1)
            WHERE user_id = $2;
        `;
        await pool.query(query, [warnMsgId, userId]);
    } catch (error) {
        console.error(error);
    }
}

async function isAdminOrPrivate(ctx: any): Promise<boolean> {
    if (ctx.chat?.type === 'private') return true;

    try {
        const member = await ctx.getChatMember(ctx.from?.id);
        if (member.status === 'administrator' || member.status === 'creator') {
            return true;
        }
    } catch (error) {
        console.error(error);
    }

    return false;
}

async function sendPurchaseReportToAdmin(customerId: number, defaultName: string = "Không rõ", defaultUsername: string = "Không có") {
    if (!GROUP_NOTI_PAYMENT) {
        console.log("Chưa cấu hình GROUP_NOTI_PAYMENT trong file .env!");
        return;
    }

    try {
        let fullName = defaultName;
        let username = defaultUsername;
        try {
            const chatInfo = await bot.telegram.getChat(customerId) as any;
            const firstName = chatInfo.first_name || "";
            const lastName = chatInfo.last_name || "";
            fullName = `${firstName} ${lastName}`.trim() || defaultName;
            username = chatInfo.username ? `@${chatInfo.username}` : defaultUsername;
        } catch (e) {
        }

        let purchasedIds: number[] = [];
        try {
            const res = await pool.query('SELECT album_id FROM users_purchased WHERE user_id = $1 ORDER BY purchased_at ASC', [customerId]);
            purchasedIds = res.rows.map(row => row.album_id);
        } catch (e) { }

        let albumListText = "";
        if (purchasedIds.length === 0) {
            albumListText = "Chưa sở hữu album nào.";
        } else {
            albumListText = purchasedIds.map(id => {
                const album = albums.find(a => a.id === id);
                const albumTitle = album ? album.title : "Album không rõ";
                return `🎥 ${albumTitle} (ID: ${id})`;
            }).join("\n");
        }

        const message =
            `👤 Khách hàng: ${fullName}\n` +
            `🏷️ Username: ${username}\n` +
            `🆔 ID: ${customerId}\n` +
            `🎥 Album mua: \n${albumListText}`;

        await bot.telegram.sendMessage(GROUP_NOTI_PAYMENT, message);

    } catch (error) {
        console.error(error);
    }
}

async function addUserToDatabase(userId: number, fullName: string, username: string) {
    try {
        const query = `
        INSERT INTO users_data (user_id, full_name, username, balance)
        VALUES ($1, $2, $3, 0)
        ON CONFLICT (user_id) 
        DO UPDATE SET full_name = EXCLUDED.full_name, username = EXCLUDED.username;`;

        await pool.query(query, [userId, fullName, username]);
    } catch (error) {
        console.error(error);
    }
}

async function addUserPurchased(userId: number, albumId: number, price: number) {
    try {
        const query = `
        INSERT INTO users_purchased (user_id, album_id, price, purchased_at)
        VALUES ($1, $2, $3, NOW());`;
        
        await pool.query(query, [userId, albumId, price]);
    } catch (error) {
        console.error(error);
    }
}

bot.use(async (ctx, next) => {
    try {
        const userId = ctx.from?.id;
        if (!userId) {
            return await next();
        }

        const username = ctx.from?.username ? `@${ctx.from.username}` : "";
        const firstName = ctx.from?.first_name || "";
        const lastName = ctx.from?.last_name || "";
        const fullname = `${firstName} ${lastName}`.trim() || "Khách";

        await addUserToDatabase(userId, fullname, username);
    } catch (error) {
        console.error(error);
    }
    await next();
});

bot.start(async (ctx) => {
    const hasPermission = await isAdminOrPrivate(ctx);
    if (!hasPermission) {
        return;
    }

    const bannerFileId = 'AgACAgUAAyEFAAMBAAE_PMoAAx9qXyR5uOrNjEnNmj9bHDKbD8ur-QACTg9rG10v-VaO4GoYtXo8CAEAAwIAA3kAAz0E';
    const sendOptions = {
        caption: 'Hi anh. Anh mún chọn gì nè??',
        reply_markup: {
            inline_keyboard: [
                [{ text: '📸 Album của pé', callback_data: 'viewAlbum' }],
                [{ text: '👙Qlot áo ngực đã mặc', callback_data: 'viewPantsu' }],
                [{ text: 'Nước tiểu, nước lồn của pé', callback_data: 'viewJuice' }],
                [{ text: 'Shop Sextoy', callback_data: 'viewSextoy' }],
                [{ text: '💳 Kiểm tra Số dư Ví', callback_data: 'check_balance' }],
                [{ text: '💬 Chat riêng với Pé về các vấn đề khác ^^', url: 'https://t.me/nyansexdoll' }]
            ]
        }
    };

    try {
        return await ctx.replyWithPhoto(bannerFileId, sendOptions);
    } catch (error) {
        return await ctx.replyWithPhoto({ source: './img/Banner.jpg' }, sendOptions);
    }
});

const getMainMenuKeyboard = () => ({
    inline_keyboard: [
        [{ text: '📸 Album của pé', callback_data: 'viewAlbum' }],
        [{ text: '👙 Qlot áo ngực đã mặc', callback_data: 'viewPantsu' }],
        [{ text: 'Nước tiểu, nước lồn của pé', callback_data: 'viewJuice' }],
        [{ text: 'Shop Sextoy', callback_data: 'viewSextoy' }],
        [{ text: '💳 Kiểm tra Số dư Ví', callback_data: 'check_balance' }],
        [{ text: '💬 Chat riêng với Pé về các vấn đề khác ^^', url: 'https://t.me/nyansexdoll' }]
    ]
});

bot.action('view_services', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) { }
    await ctx.replyWithChatAction('upload_photo').catch(() => { });

    const bannerFileId = 'AgACAgUAAyEFAAMBAAE_PMoAAx9qXyR5uOrNjEnNmj9bHDKbD8ur-QACTg9rG10v-VaO4GoYtXo8CAEAAwIAA3kAAz0E';

    try {
        await ctx.editMessageMedia({
            type: 'photo',
            media: bannerFileId
        });
    } catch (error) {
        await ctx.editMessageMedia({
            type: 'photo',
            media: { source: fs.createReadStream('./img/Banner.jpg') }
        });
    }

    try {
        await ctx.editMessageCaption('Hi anh. Anh mún chọn gì nè??', {
            reply_markup: getMainMenuKeyboard()
        });
    } catch (error) {
        console.error(error);
    }
});

bot.action('check_balance', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) { }
    await ctx.replyWithChatAction('typing').catch(() => { });

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const balance = await getUserBalance(chatId);
    let purchasedCount = 0;
    
    try {
        const countResult = await pool.query('SELECT COUNT(*) FROM users_purchased WHERE user_id = $1', [chatId]);
        purchasedCount = Number(countResult.rows[0].count);
    } catch(e) { }

    await ctx.reply(`💳 *VÍ TÍCH LŨY CỦA ANH* \n\nSố dư ví hiện tại: *${balance.toLocaleString()}đ*\n📦 Album đã mua thành công: *${purchasedCount}*\n\n_(Tiền thừa khi chuyển khoản sai cấu trúc hoặc dư sẽ tự động nạp thẳng vào ví này để trừ vào các đơn hàng sau!)_`, { parse_mode: 'Markdown' });
});

const userSessionMessages = new Map<number, number[]>();

bot.action(/view(.+)/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) { }

    const service = ctx.match[1];

    let fileInfo = {
        type: 'photo' as 'photo' | 'video',
        path: './img/Banner.jpg',
        file_id: 'AgACAgUAAyEFAAMBAAE_PMoAAx9qXyR5uOrNjEnNmj9bHDKbD8ur-QACTg9rG10v-VaO4GoYtXo8CAEAAwIAA3kAAz0E',
        text: 'Hi anh. Anh mún chọn gì nè??',
        keyboard: {
            inline_keyboard: [[{ text: '🔙 Quay lại menu chính', callback_data: 'view_services' }]]
        }
    };

    switch (service) {
        case 'Album':
            fileInfo = {
                type: 'video', 
                path: './img/Album.MP4',
                file_id: 'BAACAgUAAyEFAAMBAAE_PMoAAy1qXyeHb6sz7PLRLnWDaq2Cm_rnPQACICIAAvLg-FYZKAZwW-jtoj0E',
                text: 'Anh muốn xem thể loại album nào của bé? 👉👈',
                keyboard: {
                    inline_keyboard: [
                        [
                            { text: '💦 Masturbation (Thủ Dâm)', callback_data: 'tag_Masturbation' },
                            { text: '⛓️ BDSM (Hành Hạ)', callback_data: 'tag_BDSM' }
                        ],
                        [
                            { text: '🌊 Squirt (Đái, Bắn Nước)', callback_data: 'tag_Squirt' },
                            { text: '🌳 Public (Công Cộng)', callback_data: 'tag_Public' }
                        ],
                        [
                            { text: '🕳️ Anal (Lỗ Đít)', callback_data: 'tag_Anal' },
                            { text: '✨ SCAT (Đi ẻ)', callback_data: 'tag_Scat' }
                        ],
                        [
                            { text: '🥵 Have Sex | BlowJob\n (Album Chịch, Bú cu)', callback_data: 'tag_HaveSex' }
                        ],
                        [
                            { text: '🦋 Lesbian (2 nữ | Đồng tính nữ)', callback_data: 'tag_Lesbian' }
                        ],
                        [{ text: '🔙 Quay lại menu chính', callback_data: 'view_services' }]
                    ]
                }
            };
            break;
        case 'Pantsu':
            fileInfo.type = 'video';
            fileInfo.path = './img/Pantsu.MP4';
            fileInfo.file_id = 'BAACAgUAAyEFAAMBAAE_PMoAAy9qXyeKMWJSDHBx4UEP1-vN8aKj6AACIiIAAvLg-FavrfbPpXrBpz0E';
            fileInfo.text = 'Tính năng này hiện chưa khả dụng anh iu ơi. \n\nAnh xem trong @nyanchanbikini rồi nhắn cho Nyan nhé!';
            break;
        case 'Juice':
            fileInfo.type = 'video';
            fileInfo.path = './img/Juice.MP4';
            fileInfo.file_id = 'BAACAgUAAyEFAAMBAAE_PMoAAy5qXyeHYAkB_EI-MSEfuwbYA7bbEQACISIAAvLg-FaSOLdvvwOVaj0E';
            fileInfo.text = 'Tính năng này hiện chưa khả dụng anh iu ơi.';
            break;
        case 'Sextoy':
            fileInfo.type = 'video';
            fileInfo.path = './img/Sextoy.MP4';
            fileInfo.file_id = 'BAACAgUAAyEFAAMBAAE_PMoAAzBqXyeM9pX5GN5Gw5NJwtBcETR_gwACIyIAAvLg-FYsGV88tpkxyT0E';
            fileInfo.text = 'Tính năng này hiện chưa khả dụng anh iu ơi. \n\nAnh xem trong @shopsextoy2 rồi nhắn cho Nyan nhé!';
            break;
    }

    if (fileInfo.type === 'video') {
        await ctx.replyWithChatAction('upload_video').catch(() => { });
    } else {
        await ctx.replyWithChatAction('upload_photo').catch(() => { });
    }

    try {
        await ctx.editMessageMedia({
            type: fileInfo.type,
            media: fileInfo.file_id
        });
    } catch (error) {
        if (!fs.existsSync(fileInfo.path)) return ctx.reply("File không tồn tại trên cả Cloud lẫn ổ cứng!");
        await ctx.editMessageMedia({
            type: fileInfo.type,
            media: { source: fs.createReadStream(fileInfo.path) }
        });
    }

    try {
        await ctx.editMessageCaption(fileInfo.text, {
            reply_markup: fileInfo.keyboard
        });
    } catch (error) {
        console.error(error);
    }
});

bot.action(/tag_([^_]+)(?:_(\d+))?/, async (ctx) => {
    try {
        await ctx.answerCbQuery();
    } catch (e) { }
    await ctx.replyWithChatAction('typing').catch(() => { });

    const selectedTag = ctx.match[1];
    const currentPage = ctx.match[2] ? parseInt(ctx.match[2]) : 0;
    const chatId = ctx.chat?.id;

    if (!selectedTag || !chatId) return ctx.reply("An error occurred, session not found!");

    const oldMessageIds = userSessionMessages.get(chatId) || [];
    for (const msgId of oldMessageIds) {
        try {
            await ctx.telegram.deleteMessage(chatId, msgId);
        } catch (err) { }
    }
    userSessionMessages.set(chatId, []);

    const filteredAlbums = albums.filter(album => album.tags.includes(selectedTag));

    if (filteredAlbums.length === 0) {
        return ctx.reply(`Album thể loại ${selectedTag} em chưa có rùi a iu ơi ~`);
    }

    const newSentMessageIds: number[] = [];
    const loadingMsg = await ctx.reply(`Anh iu đợi pé xíu nha. Pé đang gửi thể loại ${selectedTag} qua nè... ❤️❤️❤️ ~ ~`);
    newSentMessageIds.push(loadingMsg.message_id);

    setTimeout(async () => {
        try {
            await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id);
        } catch (err) { }
    }, 50000);

    const ITEMS_PER_PAGE = 3;
    const startIndex = currentPage * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const pageAlbums = filteredAlbums.slice(startIndex, endIndex);

    let currentIndex = 0;
    for (const album of pageAlbums) {
        const isLastItemOnPage = currentIndex === pageAlbums.length - 1;
        currentIndex++;

        const captionText =
            `🎥 *${album.title}*\n\n` +
            `📝 *Description:* ${album.description}\n\n` +
            `💰 *Price:* ${album.price}`;

        const inlineKeyboard: any[][] = [
            [{ text: `🛒 Mua album này , Giá: ${album.price} ❤️`, callback_data: `buy_album_${album.id}` }]
        ];

        if (isLastItemOnPage) {
            const navigationRow = [];

            if (currentPage > 0) {
                navigationRow.push({ text: '⬅️ Trở lại', callback_data: `tag_${selectedTag}_${currentPage - 1}` });
            }
            if (endIndex < filteredAlbums.length) {
                navigationRow.push({ text: '➡️ Tiếp theo', callback_data: `tag_${selectedTag}_${currentPage + 1}` });
            }

            if (navigationRow.length > 0) {
                inlineKeyboard.push(navigationRow);
            }

            inlineKeyboard.push([{ text: '🔙 Trở lại mục album !', callback_data: 'viewAlbum' }]);
        }

        const sendOptions: any = {
            caption: captionText,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: inlineKeyboard }
        };

        try {
            let sentMsg;
            const actionType = album.type === 'video' ? 'upload_video' : 'upload_photo';
            await ctx.replyWithChatAction(actionType).catch(() => { });

            try {
                if (!album.fileid) throw new Error("Chưa có mã fileid");

                if (album.type === 'video') {
                    sentMsg = await ctx.replyWithVideo(album.fileid, sendOptions);
                } else {
                    sentMsg = await ctx.replyWithPhoto(album.fileid, sendOptions);
                }
            } catch (fallbackError) {
                if (!fs.existsSync(album.path)) {
                    sentMsg = await ctx.reply(`${album.title} is currently under maintenance...`);
                } else {
                    if (album.type === 'video') {
                        sentMsg = await ctx.replyWithVideo({ source: fs.createReadStream(album.path) }, sendOptions);
                    } else {
                        sentMsg = await ctx.replyWithPhoto({ source: fs.createReadStream(album.path) }, sendOptions);
                    }
                }
            }

            if (sentMsg) {
                newSentMessageIds.push(sentMsg.message_id);
            }
        } catch (error) {
            console.error(error);
        }
    }

    userSessionMessages.set(chatId, newSentMessageIds);
});

bot.action(/buy_album_(.+)/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) { }
    await ctx.replyWithChatAction('typing').catch(() => { });

    const albumIdStr = ctx.match[1];

    if (!albumIdStr) {
        return ctx.reply("Huhu, lỗi rồi anh ơi. Không tìm thấy ID album!");
    }

    const albumId = parseInt(albumIdStr);
    const targetAlbum = albums.find(a => a.id === albumId);

    if (!targetAlbum) {
        return ctx.reply("Could not find this album's details anymore!");
    }

    const chatId = ctx.chat?.id;
    if (!chatId) return ctx.reply("Không tìm thấy session chat của anh!");

    const cbQuery = ctx.callbackQuery as any;
    const clickedMessageId = cbQuery?.message?.message_id;

    if (clickedMessageId) {
        const sessionMsgIds = userSessionMessages.get(chatId) || [];

        for (const msgId of sessionMsgIds) {
            if (msgId !== clickedMessageId) {
                try {
                    await ctx.telegram.deleteMessage(chatId, msgId);
                } catch (err) { }
            }
        }

        userSessionMessages.set(chatId, [clickedMessageId]);
    }

    let alreadyPurchased = false;
    try {
        const checkQuery = await pool.query('SELECT 1 FROM users_purchased WHERE user_id = $1 AND album_id = $2', [chatId, albumId]);
        if (checkQuery.rows.length > 0) alreadyPurchased = true;
    } catch(e) {}

    if (alreadyPurchased) {
        return ctx.reply(`🎉 Album *"${targetAlbum.title}"* này anh đã mua và sở hữu rồi ạ!`, { parse_mode: 'Markdown' });
    }

    const orderCode = `NYAN${Date.now().toString().slice(-6)}`;

    let rawPrice = targetAlbum.price.toLowerCase().trim();
    let cleanPrice = "";

    if (rawPrice.includes('k')) {
        const numberPart = rawPrice.replace(/[^0-9]/g, '');
        cleanPrice = (Number(numberPart) * 1000).toString();
    } else {
        cleanPrice = rawPrice.replace(/[^0-9]/g, '');
    }

    const albumPriceNum = Number(cleanPrice);
    const currentBalance = await getUserBalance(chatId);

    if (currentBalance >= albumPriceNum) {
        const remainingBalance = await updateUserBalance(chatId, -albumPriceNum);
        
        await addUserPurchased(chatId, albumId, albumPriceNum);

        const link1Raw = targetAlbum.linkAlbum?.[0]?.replace('Link 1:', '').trim();
        const link2Raw = targetAlbum.linkAlbum?.[1]?.replace('Link 2:', '').trim();
        const link1Text = link1Raw ? link1Raw : "Link này pé chưa cập nhật";
        const link2Text = link2Raw ? link2Raw : "Link này pé chưa cập nhật";

        await ctx.reply(
            `🎉 <b>MUA THÀNH CÔNG BẰNG VÍ SỐ DƯ!</b> \n\n` +
            `Số dư ví của anh đã tự động khấu trừ ${albumPriceNum.toLocaleString()}đ.\n` +
            `💳 Số dư hiện tại còn lại: <b>${remainingBalance.toLocaleString()}đ</b>.\n\n` +
            `🎁 <b>Link Album của anh đây ạ:</b>\n` +
            `🔗 Link 1: ${link1Text}\n` +
            `🔗 Link 2: ${link2Text}\n\n` +
            `Cảm ơn anh iu đã ủng hộ pé nhé! ~ ❤️❤️`,
            { parse_mode: 'HTML' } 
        );

        const userFirstName = ctx.from?.first_name || "Không rõ";
        const userLastName = ctx.from?.last_name || "";
        const fullName = `${userFirstName} ${userLastName}`.trim();
        const username = ctx.from?.username ? `@${ctx.from.username}` : "Không có";

        await sendPurchaseReportToAdmin(chatId, fullName, username);

        return;
    }

    const finalPayAmount = albumPriceNum - currentBalance;
    const accountNumber = "8288977";
    const qrUrl = `https://vietqr.app/img?bank=ACB&acc=8288977&template=compact&amount=${finalPayAmount}&des=${encodeURIComponent(orderCode)}&showinfo=true&holder=NGUYEN%20NGOC%20THAI`;

    const messageText = `🔥 *ĐẶT MUA ALBUM: ${targetAlbum.title}*
💰 *Giá gốc:* ${targetAlbum.price}
💳 *Số dư ví hiện có:* ${currentBalance.toLocaleString()}đ
💎 *Số tiền cần chuyển khoản:* *${finalPayAmount.toLocaleString()}đ*
--------------------------------------
💳 *Ngân hàng:* ACB
👤 *Số tài khoản:* \`${accountNumber}\`
👤 *Chủ tài khoản:* NGUYEN NGOC THAI
📝 *Nội dung CK đúng 100%:* \`${orderCode}\`
--------------------------------------
Stk của quản lý em nên anh không cần lo nè ❤️
⚠️ *Lưu ý*: Ghi đúng nội dung chuyển khoản nha anh ~`;

    try {
        await ctx.replyWithChatAction('upload_photo').catch(() => { });
        const sentQrMsg = await ctx.replyWithPhoto(
            { url: qrUrl },
            {
                caption: messageText,
                parse_mode: 'Markdown'
            }
        );

        await setPendingOrder(chatId, orderCode, albumId, sentQrMsg.message_id);

    } catch (error) {
        const sentTextMsg = await ctx.replyWithMarkdown(messageText);

        await setPendingOrder(chatId, orderCode, albumId, sentTextMsg.message_id);
    }
});

const app = express();
app.use(express.json());

app.post('/webhook/bank', async (req, res) => {
    res.status(200).json({ success: true });

    try {
        const { content, transferAmount } = req.body;
        const actualPaid = Number(transferAmount);

        if (!content) return;

        const result = await pool.query(
            `SELECT user_id, order_code, pending_album_id, qr_message_id, warn_message_ids 
             FROM users_data 
             WHERE order_code IS NOT NULL AND $1 ILIKE '%' || order_code || '%'`,
            [content]
        );

        if (result.rows.length > 0) {
            const userRow = result.rows[0];
            const customerChatId = Number(userRow.user_id);
            const qrMessageId = userRow.qr_message_id ? Number(userRow.qr_message_id) : null;
            const targetAlbumId = Number(userRow.pending_album_id);
            const warnMessageIds: number[] = userRow.warn_message_ids ? userRow.warn_message_ids.map(Number) : [];
            const orderCode = userRow.order_code;

            const targetAlbum = albums.find(a => a.id === targetAlbumId);
            if (!targetAlbum) return;

            let rP = targetAlbum.price.toLowerCase().trim();
            let albumPrice = rP.includes('k') ? Number(rP.replace(/[^0-9]/g, '')) * 1000 : Number(rP.replace(/[^0-9]/g, ''));

            const newTotalBalance = await updateUserBalance(customerChatId, actualPaid);

            if (newTotalBalance >= albumPrice) {
                const remainingBalance = await updateUserBalance(customerChatId, -albumPrice);
                
                await addUserPurchased(customerChatId, targetAlbumId, albumPrice);

                if (qrMessageId) {
                    try {
                        await bot.telegram.deleteMessage(customerChatId, qrMessageId);
                    } catch (err) {
                    }
                }

                for (const warnMsgId of warnMessageIds) {
                    try {
                        await bot.telegram.deleteMessage(customerChatId, warnMsgId);
                    } catch (err) {
                    }
                }

                const link1Raw = targetAlbum.linkAlbum?.[0]?.replace('Link 1:', '').trim();
                const link2Raw = targetAlbum.linkAlbum?.[1]?.replace('Link 2:', '').trim();
                const link1Text = link1Raw ? link1Raw : "Link này pé chưa cập nhật";
                const link2Text = link2Raw ? link2Raw : "Link này pé chưa cập nhật";

                try {
                    await bot.telegram.sendMessage(customerChatId,
                        `🎉 <b>Thanh toán thành công!</b> Pé đã nhận được tiền rồi ạ. \n\n` +
                        `ℹ️ Mã hóa đơn: <code>${orderCode}</code>\n` +
                        `💰 Giá trị album: ${albumPrice.toLocaleString()}đ\n` +
                        `📥 Số tiền anh vừa nạp: ${actualPaid.toLocaleString()}đ\n` +
                        `💳 Số dư ví tích lũy còn lại: <b>${remainingBalance.toLocaleString()}đ</b> \n\n` +
                        `🎁 <b>Link Album của anh đây ạ:</b>\n` +
                        `🔗 Link 1: ${link1Text}\n` +
                        `🔗 Link 2: ${link2Text}\n\n` +
                        `Cảm ơn anh iu đã ủng hộ pé nhé! ~ ❤️❤️`,
                        { parse_mode: 'HTML' } 
                    );
                } catch (err: any) {
                    console.error(err);
                }

                await sendPurchaseReportToAdmin(customerChatId);
                await clearPendingOrder(customerChatId);

            } else {
                const shortAmount = albumPrice - newTotalBalance;

                let sentWarnMsg = null;
                try {
                    sentWarnMsg = await bot.telegram.sendMessage(customerChatId,
                        `⚠️ *CẢNH BÁO: CHUYỂN KHOẢN THIẾU TIỀN* \n\n` +
                        `Hệ thống nhận được số tiền: *${actualPaid.toLocaleString()}đ* từ hóa đơn \`${orderCode}\`.\n` +
                        `💳 Tổng tiền trong ví hiện tại của anh: *${newTotalBalance.toLocaleString()}đ*.\n` +
                        `❌ Anh vẫn còn thiếu *${shortAmount.toLocaleString()}đ* nữa mới đủ mua album.\n\n` +
                        `👉 *Biện pháp:* Anh vui lòng chuyển khoản thêm đúng số tiền thiếu (*${shortAmount.toLocaleString()}đ*) và nhớ **giữ nguyên nội dung chuyển khoản là:** \`${orderCode}\` để hệ thống tự động cộng dồn đủ tiền nhe anh!`,
                        { parse_mode: 'Markdown' }
                    );
                } catch (err: any) {
                    console.error(err);
                }

                if (sentWarnMsg) {
                    await addWarnMessageId(customerChatId, sentWarnMsg.message_id);
                }
            }
        }
    } catch (error) {
        console.error(error);
    }
});

bot.command('c', async (ctx) => {
    try {
        const hasPermission = await isAdminOrPrivate(ctx);
        if (!hasPermission) {
            if (ctx.chat?.type !== 'private') {
                try { await ctx.deleteMessage(); } catch (e) { }
            }
            return;
        }

        const messageText = ctx.message.text;
        const content = messageText.replace(/^\/c(@\w+)?\s*/, '').trim();
        if (!content) {
            try { await ctx.deleteMessage(); } catch (e) { }

            const alertMsg = await ctx.reply("/c <Nội dung cần chat> nha ^^");
            setTimeout(async () => {
                try { await ctx.telegram.deleteMessage(ctx.chat.id, alertMsg.message_id); } catch (e) { }
            }, 3000);
            return;
        }

        const replyToMessage = ctx.message.reply_to_message;

        try {
            await ctx.deleteMessage();
        } catch (e) {
        }

        if (replyToMessage) {
            await ctx.reply(content, {
                reply_parameters: { message_id: replyToMessage.message_id }
            });
        } else {
            await ctx.reply(content);
        }

    } catch (error) {
        console.error(error);
    }
});

bot.command('getid', (ctx) => {
    const ADMIN_IDS = [8054465558, 8973528593];

    const userId = ctx.from.id;

    if (!ADMIN_IDS.includes(userId)) {
        return;
    }

    const repliedMsg = (ctx.message as any).reply_to_message;
    if (!repliedMsg) return ctx.reply("Bấy bì phải Reply (trả lời) một bức ảnh hoặc video nha!");

    if (repliedMsg.photo) {
        const photo = repliedMsg.photo[repliedMsg.photo.length - 1];
        return ctx.reply(`📸 ID Ảnh:\n\n<code>${photo.file_id}</code>`, { parse_mode: 'HTML' });
    } else if (repliedMsg.video) {
        return ctx.reply(`🎥 ID Video:\n\n<code>${repliedMsg.video.file_id}</code>`, { parse_mode: 'HTML' });
    } else {
        return ctx.reply("Đây hông phải ảnh hay video ba ơi!");
    }
});

bot.on('message', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    try {
        setTimeout(async () => {
            await ctx.deleteMessage();
        }, 5000);

        const warningMsg = await ctx.reply('⚠️ Anh chỉ cần thao thao tác qua NÚT BẤM bên trên thui ạ ❤️!');

        setTimeout(() => {
            ctx.telegram.deleteMessage(ctx.chat.id, warningMsg.message_id).catch(() => { });
        }, 5000);

    } catch (error) {
        console.error(error);
    }
});

bot.catch(async (err: any, ctx: Context) => {
    console.error(err);
    const errMsg = err?.message || err?.toString() || '';

    if (errMsg.includes('Timeout') || errMsg.includes('timed out')) {
        try {
            if (ctx.chat) {
                await ctx.telegram.sendMessage(
                    ctx.chat.id,
                    "⚠️ Hệ thống đang bận..vui lòng chờ 2-5 phút"
                );
            }
        } catch (sendErr) {
            console.error(sendErr);
        }
    }
});

bot.launch();
console.log('NyanBot (TypeScript) đang chạy...');

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Webhook server của SePay đang lắng nghe tại port ${PORT}...`);
});

process.on('uncaughtException', (err) => {
    console.error(err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(reason, promise);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));