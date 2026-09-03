import { Pool } from 'pg';
import { Telegraf, Context } from 'telegraf';
import dotenv from 'dotenv';
import fs from 'fs';
import express from 'express';

dotenv.config();

const bot = new Telegraf<NyanContext>(process.env.BOT_TOKEN as string);
const GROUP_NOTI_PAYMENT = process.env.GROUP_NOTI_PAYMENT ? Number(process.env.GROUP_NOTI_PAYMENT) : null;
const adminAddingAlbum = new Set<number>();
const adminEditingAlbum = new Set<number>();
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(Number) : [];

async function addNewAlbum(
    title: string,
    links: string[],
    fileId: string,
    type: string,
    tags: string[],
    price: string,
    description: string
): Promise<boolean> {
    try {
        const query = `
            INSERT INTO albums (id, title, link_album, path, fileid, type, tags, price, description)
            VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM albums), $1, $2, $3, $4, $5, $6, $7, $8)
        `;

        await pool.query(query, [
            title,
            JSON.stringify(links),
            '',
            fileId,
            type,
            tags,
            price,
            description
        ]);

        await loadAllAlbumsData();
        return true;
    } catch (error) {
        console.error("Lỗi khi thêm album vào DB:", error);
        return false;
    }
}

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

pool.query(`
    SELECT setval(
        'users_purchased_id_seq', 
        COALESCE((SELECT MAX(id) FROM users_purchased), 1)
    );
`).then(() => {
    console.log('🔄 Đã tự động đồng bộ bộ đếm ID cho bảng users_purchased!');
}).catch(err => {
    console.error('❌ Lỗi đồng bộ sequence:', err);
});


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

async function getMonthlyTransactionCount(): Promise<number> {
    try {
        const query = `
            SELECT COUNT(*) 
            FROM users_purchased 
            WHERE EXTRACT(MONTH FROM purchased_at) = EXTRACT(MONTH FROM CURRENT_DATE)
              AND EXTRACT(YEAR FROM purchased_at) = EXTRACT(YEAR FROM CURRENT_DATE)
              AND payment_method = 'sepay'
        `;
        const res = await pool.query(query);
        return parseInt(res.rows[0].count) || 0;
    } catch (error) {
        console.error("Lỗi đếm số giao dịch tháng:", error);
        return 0;
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

async function addAlbumLinkMessageId(userId: number, messageId: number) {
    try {
        const query = `
            UPDATE users_data 
            SET album_link_message_ids = array_append(COALESCE(album_link_message_ids, '{}'), $1)
            WHERE user_id = $2;
        `;
        await pool.query(query, [messageId, userId]);
    } catch (error) {
        console.error(error);
    }
}

async function cleanUserChatHistory(ctx: any, userId: number) {
    try {
        const result = await pool.query('SELECT system_message_ids FROM users_data WHERE user_id = $1', [userId]);
        if (result.rows.length > 0) {
            const systemMessageIds = result.rows[0].system_message_ids || [];
            for (const msgId of systemMessageIds) {
                try {
                    await ctx.telegram.deleteMessage(userId, msgId);
                } catch (err) { }
            }
            await pool.query(`UPDATE users_data SET system_message_ids = '{}' WHERE user_id = $1`, [userId]);
        }
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

        let purchasedAlbums: { id: any, title: string }[] = [];
        try {
            const query = `
                SELECT up.album_id as id, a.title 
                FROM users_purchased up
                LEFT JOIN albums a ON up.album_id::text = a.id::text
                WHERE up.user_id::text = $1::text 
                ORDER BY up.purchased_at ASC
            `;
            const res = await pool.query(query, [customerId]);
            purchasedAlbums = res.rows;
        } catch (e) {
            console.error("Lỗi khi truy vấn album:", e);
        }

        let albumListText = "";
        if (purchasedAlbums.length === 0) {
            albumListText = "Chưa sở hữu album nào.";
        } else {
            albumListText = purchasedAlbums.map(album => {
                const albumTitle = album.title || "Album không rõ";
                return `🎥 ${albumTitle} (ID: ${album.id})`;
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

async function getMainMenuKeyboard() {
    let vipButtonText = 'Event CLIP VIP FREE của pé';
    try {
        const eventRes = await pool.query('SELECT title FROM events WHERE is_active = true ORDER BY id DESC LIMIT 1');
        if (eventRes.rows.length > 0 && eventRes.rows[0].title) {
            vipButtonText = eventRes.rows[0].title;
        }
    } catch (e) {
        console.error("Lỗi lấy title event:", e);
    }

    return {
        inline_keyboard: [
            [{ text: '📸 Album của pé', callback_data: 'viewAlbum' }],
            [{ text: '👙 Qlot áo ngực đã mặc', callback_data: 'viewPantsu' }],
            [{ text: 'Nước tiểu, nước lồn của pé', callback_data: 'viewJuice' }],
            [{ text: 'Shop Sextoy', callback_data: 'viewSextoy' }],
            [{ text: '💳 Kiểm tra Số dư Ví', callback_data: 'check_balance' }],
            [{ text: '✨ TOP FAN TRONG THÁNG ✨', callback_data: 'view_top_fans' }],
            [{ text: vipButtonText, callback_data: 'view_vip_clip' }],
            [{ text: '💬 Chat riêng với Pé về các vấn đề khác ^^', url: 'https://t.me/nyansexdoll' }]
        ]
    };
}

bot.start(async (ctx) => {
    const hasPermission = await isAdminOrPrivate(ctx);
    if (!hasPermission) {
        return;
    }

    const userId = ctx.from.id;
    await cleanUserChatHistory(ctx, userId);

    const bannerFileId = 'AgACAgUAAyEFAAMBAAE_PMoAAx9qXyR5uOrNjEnNmj9bHDKbD8ur-QACTg9rG10v-VaO4GoYtXo8CAEAAwIAA3kAAz0E';
    const sendOptions = {
        caption: 'Hi anh. Anh mún chọn gì nè??',
        reply_markup: await getMainMenuKeyboard()
    };

    try {
        const msg = await ctx.replyWithPhoto(bannerFileId, sendOptions);
        await addSystemMessageId(userId, msg.message_id);
    } catch (error) {
        const msg = await ctx.replyWithPhoto({ source: './img/Banner.jpg' }, sendOptions);
        await addSystemMessageId(userId, msg.message_id);
    }
});

bot.action('view_top_fans', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) { }
    const userId = ctx.from?.id;
    if (!userId) return;

    await cleanUserChatHistory(ctx, userId);
    await ctx.replyWithChatAction('typing');

    try {
        const now = new Date();
        const lastMonthDate = new Date(now.getFullYear(), now.getMonth(), 0);
        const lastMonth = lastMonthDate.getMonth() + 1;
        const yearOfLastMonth = lastMonthDate.getFullYear();

        const topQuery = `
            SELECT 
                u.user_id,
                u.full_name,
                u.username,
                SUM(p.price) AS total_spent
            FROM users_data u
            JOIN users_purchased p ON u.user_id = p.user_id
            WHERE EXTRACT(MONTH FROM p.purchased_at) = $1 
              AND EXTRACT(YEAR FROM p.purchased_at) = $2
            GROUP BY u.user_id, u.full_name, u.username
            ORDER BY total_spent DESC
            LIMIT 3;
        `;

        const topRes = await pool.query(topQuery, [lastMonth, yearOfLastMonth]);
        const topUsers = topRes.rows;

        let topText = `<b>Top Fan Cứng Tháng ${lastMonth}:</b>\n\n`;

        if (topUsers.length === 0) {
            topText += `Chưa có dữ liệu Top Fan tháng ${lastMonth}\n`;
        } else {
            topUsers.forEach((u, index) => {
                let rawName = u.full_name || u.username || 'Khách';

                rawName = rawName
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');

                const maskedName = rawName.substring(0, 2) + '<ins>xxx</ins>';

                const spent = parseInt(u.total_spent) || 0;

                const formatted = spent.toLocaleString('vi-VN');

                let hasFirstDigit = false;
                const maskedPrice = formatted.split('').map(char => {
                    if (/\d/.test(char)) {
                        if (!hasFirstDigit) {
                            hasFirstDigit = true;
                            return char;
                        }
                        return 'x';
                    }
                    return char;
                }).join('');

                topText += `<Code>Top ${index + 1}: [  ${maskedName}  ] -- Donate: ${maskedPrice}\n\n</Code>`;
            });
        }

        topText += `\nTop Fan Cứng sẽ được cập nhật vào cuối tháng\n\n`;

        const msg = await ctx.reply(topText, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: '🔙 Quay lại menu chính', callback_data: 'view_services' }]]
            }
        });
        await addSystemMessageId(userId, msg.message_id);

    } catch (error) {
        console.error('Lỗi view_top_fans:', error);
        const msg = await ctx.reply('⚠️ Hệ thống đang bận... vui lòng thử lại sau ít phút.');
        await addSystemMessageId(userId, msg.message_id);
    }
});

bot.action('view_vip_clip', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) { }
    const userId = ctx.from?.id;
    if (!userId) return;

    await cleanUserChatHistory(ctx, userId);
    await ctx.replyWithChatAction('upload_video').catch(() => { });

    try {
        // 1. Kiểm tra xem có event nào đang BẬT hay không
        const eventRes = await pool.query('SELECT * FROM events WHERE is_active = true ORDER BY id DESC LIMIT 1');

        if (eventRes.rows.length === 0) {
            const msg = await ctx.reply('Hiện tại pé Nyan chưa có event nào cả ❤️', {
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 Quay lại menu chính', callback_data: 'view_services' }]]
                }
            });
            await addSystemMessageId(userId, msg.message_id);
            return;
        }

        const currentEvent = eventRes.rows[0];
        const requiredSpent = parseInt(currentEvent.condition_spent) || 0;

        // 2. Tính tổng tiền chi tiêu của user
        const userSpendRes = await pool.query('SELECT SUM(price) as total_spent FROM users_purchased WHERE user_id = $1', [userId]);
        const totalSpent = parseInt(userSpendRes.rows[0].total_spent) || 0;

        let fileId = '';
        let captionText = '';

        // 3. So sánh với điều kiện của event
        if (totalSpent < requiredSpent) {
            fileId = currentEvent.fileid_demo;
            captionText = currentEvent.description_demo;
        } else {
            fileId = currentEvent.fileid_video;
            captionText = currentEvent.description_video;
        }

        const msg = await ctx.replyWithVideo(fileId, {
            caption: captionText,
            reply_markup: {
                inline_keyboard: [[{ text: '🔙 Quay lại menu chính', callback_data: 'view_services' }]]
            }
        });

        await addSystemMessageId(userId, msg.message_id);

    } catch (error) {
        console.error('Lỗi check VIP clip event:', error);
        const msg = await ctx.reply('⚠️ Hệ thống đang bận... vui lòng thử lại sau ít phút.');
        await addSystemMessageId(userId, msg.message_id);
    }
});

bot.action('view_services', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) { }
    const userId = ctx.from?.id;
    if (userId) await cleanUserChatHistory(ctx, userId);

    await ctx.replyWithChatAction('upload_photo').catch(() => { });

    const bannerFileId = 'AgACAgUAAyEFAAMBAAE_PMoAAx9qXyR5uOrNjEnNmj9bHDKbD8ur-QACTg9rG10v-VaO4GoYtXo8CAEAAwIAA3kAAz0E';
    const sendOptions = {
        caption: 'Hi anh. Anh mún chọn gì nè??',
        reply_markup: await getMainMenuKeyboard()
    };

    try {
        const msg = await ctx.replyWithPhoto(bannerFileId, sendOptions);
        if (userId) await addSystemMessageId(userId, msg.message_id);
    } catch (error) {
        const msg = await ctx.replyWithPhoto({ source: fs.createReadStream('./img/Banner.jpg') }, sendOptions);
        if (userId) await addSystemMessageId(userId, msg.message_id);
    }
});

bot.action('check_balance', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) { }
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    await cleanUserChatHistory(ctx, chatId);
    await ctx.replyWithChatAction('typing').catch(() => { });

    const balance = await getUserBalance(chatId);
    let purchasedCount = 0;

    try {
        const countResult = await pool.query('SELECT COUNT(*) FROM users_purchased WHERE user_id = $1', [chatId]);
        purchasedCount = Number(countResult.rows[0].count);
    } catch (e) { }

    const msg = await ctx.reply(`💳 *VÍ TÍCH LŨY CỦA ANH* \n\nSố dư ví hiện tại: *${balance.toLocaleString()}đ*\n📦 Album đã mua thành công: *${purchasedCount}*\n\n_(Tiền thừa khi chuyển khoản sai cấu trúc hoặc dư sẽ tự động nạp thẳng vào ví này để trừ vào các đơn hàng sau!)_`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: '🔙 Quay lại menu chính', callback_data: 'view_services' }]]
        }
    });
    await addSystemMessageId(chatId, msg.message_id);
});

const userSessionMessages = new Map<number, number[]>();

bot.action(/view(.+)/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) { }

    const userId = ctx.from?.id;
    if (userId) await cleanUserChatHistory(ctx, userId);

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

    const sendOptions = {
        caption: fileInfo.text,
        reply_markup: fileInfo.keyboard
    };

    try {
        let msg;
        if (fileInfo.type === 'video') {
            await ctx.replyWithChatAction('upload_video').catch(() => { });
            msg = await ctx.replyWithVideo(fileInfo.file_id, sendOptions);
        } else {
            await ctx.replyWithChatAction('upload_photo').catch(() => { });
            msg = await ctx.replyWithPhoto(fileInfo.file_id, sendOptions);
        }
        if (userId && msg) await addSystemMessageId(userId, msg.message_id);
    } catch (error) {
        if (!fs.existsSync(fileInfo.path)) {
            const msg = await ctx.reply("File không tồn tại trên cả Cloud lẫn ổ cứng!");
            if (userId) await addSystemMessageId(userId, msg.message_id);
            return;
        }

        let msg;
        if (fileInfo.type === 'video') {
            msg = await ctx.replyWithVideo({ source: fs.createReadStream(fileInfo.path) }, sendOptions);
        } else {
            msg = await ctx.replyWithPhoto({ source: fs.createReadStream(fileInfo.path) }, sendOptions);
        }
        if (userId && msg) await addSystemMessageId(userId, msg.message_id);
    }
});

bot.action(/tag_([^_]+)(?:_(\d+))?/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) { }
    await ctx.replyWithChatAction('typing').catch(() => { });

    const selectedTag = ctx.match[1];
    const currentPage = ctx.match[2] ? parseInt(ctx.match[2]) : 0;
    const chatId = ctx.chat?.id;

    if (!selectedTag || !chatId) return ctx.reply("An error occurred, session not found!");

    if (chatId) await cleanUserChatHistory(ctx, chatId);

    const oldMessageIds = userSessionMessages.get(chatId) || [];
    for (const msgId of oldMessageIds) {
        try {
            await ctx.telegram.deleteMessage(chatId, msgId);
        } catch (err) { }
    }
    userSessionMessages.set(chatId, []);

    const filteredAlbums = albums.filter(album => album.tags.includes(selectedTag));

    if (filteredAlbums.length === 0) {
        const msg = await ctx.reply(`Album thể loại ${selectedTag} em chưa có rùi a iu ơi ~`);
        await addSystemMessageId(chatId, msg.message_id);
        return;
    }

    const newSentMessageIds: number[] = [];
    const loadingMsg = await ctx.reply(`Anh iu đợi pé xíu nha. Pé đang gửi thể loại ${selectedTag} qua nè... ❤️❤️❤️ ~ ~`);
    newSentMessageIds.push(loadingMsg.message_id);
    await addSystemMessageId(chatId, loadingMsg.message_id);

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
                await addSystemMessageId(chatId, sentMsg.message_id);
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
    const chatId = ctx.chat?.id;
    if (!chatId) return ctx.reply("Không tìm thấy session chat của anh!");

    if (!albumIdStr) {
        const msg = await ctx.reply("Huhu, lỗi rồi anh ơi. Không tìm thấy ID album!");
        await addSystemMessageId(chatId, msg.message_id);
        return;
    }

    const albumId = parseInt(albumIdStr);
    const targetAlbum = albums.find(a => a.id === albumId);

    if (!targetAlbum) {
        const msg = await ctx.reply("Could not find this album's details anymore!");
        await addSystemMessageId(chatId, msg.message_id);
        return;
    }

    const cbQuery = ctx.callbackQuery as any;
    const clickedMessageId = cbQuery?.message?.message_id;

    if (clickedMessageId) {
        const sessionMsgIds = userSessionMessages.get(chatId) || [];
        for (const msgId of sessionMsgIds) {
            if (msgId !== clickedMessageId) {
                try { await ctx.telegram.deleteMessage(chatId, msgId); } catch (err) { }
            }
        }
        userSessionMessages.set(chatId, [clickedMessageId]);
    }

    let alreadyPurchased = false;
    try {
        const checkQuery = await pool.query('SELECT 1 FROM users_purchased WHERE user_id = $1 AND album_id = $2', [chatId, albumId]);
        if (checkQuery.rows.length > 0) alreadyPurchased = true;
    } catch (e) { }

    if (alreadyPurchased) {
        const msg = await ctx.reply(`🎉 Album *"${targetAlbum.title}"* này anh đã mua và sở hữu rồi ạ!`, { parse_mode: 'Markdown' });
        await addSystemMessageId(chatId, msg.message_id);
        return;
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

        const successMsg = await ctx.reply(
            `🎉 <b>MUA THÀNH CÔNG BẰNG VÍ SỐ DƯ!</b> \n\n` +
            `Số dư ví của anh đã tự động khấu trừ ${albumPriceNum.toLocaleString()}đ.\n` +
            `💳 Số dư hiện tại còn lại: <b>${remainingBalance.toLocaleString()}đ</b>.\n\n` +
            `🎁 <b>Link Album của anh đây ạ:</b>\n` +
            `💿 Album: <b>${targetAlbum.title}</b>\n` +
            `🔗 Link 1: ${link1Text}\n` +
            `🔗 Link 2: ${link2Text}\n\n` +
            `Cảm ơn anh iu đã ủng hộ pé nhé! ~ ❤️❤️`,
            { parse_mode: 'HTML' }
        );
        await addAlbumLinkMessageId(chatId, successMsg.message_id);

        const userFirstName = ctx.from?.first_name || "Không rõ";
        const userLastName = ctx.from?.last_name || "";
        const fullName = `${userFirstName} ${userLastName}`.trim();
        const username = ctx.from?.username ? `@${ctx.from.username}` : "Không có";

        await sendPurchaseReportToAdmin(chatId, fullName, username);

        return;
    }

    const finalPayAmount = albumPriceNum - currentBalance;

    // Đếm xem tháng này bán được bao nhiêu đơn rồi
    const currentTxCount = await getMonthlyTransactionCount();
    const LIMIT_SEPAY_1 = 50; // Ngưỡng an toàn (tránh vọt quá 50)
    const LIMIT_SEPAY_2 = 100;

    let bankName = "ACB";
    let accountNumber = "8288977";
    let accountHolder = "NGUYEN NGOC THAI";
    let bankDisplayName = "ACB";

    // Giai đoạn 3: > 96 giao dịch -> Quay lại ACB (dùng MacroDroid)
    if (currentTxCount > LIMIT_SEPAY_2) {
        bankName = "ACB";
        accountNumber = "8288977";
        accountHolder = "NGUYEN NGOC THAI";
        bankDisplayName = "ACB";
    }
    // Giai đoạn 2: Từ 48 - 95 đơn -> Dùng SePay 2 (MBBank)
    else if (currentTxCount > LIMIT_SEPAY_1) {
        bankName = "MB";
        accountNumber = "0327091202";
        accountHolder = "NGUYEN NGOC THAI";
        bankDisplayName = "MBBank";
    }
    // Giai đoạn 1: Dưới 48 đơn -> Dùng SePay 1 (ACB)
    else {
        bankName = "ACB";
        accountNumber = "8288977";
        accountHolder = "NGUYEN NGOC THAI";
        bankDisplayName = "ACB";
    }

    const qrUrl = `https://vietqr.app/img?bank=${bankName}&acc=${accountNumber}&template=compact&amount=${finalPayAmount}&des=${encodeURIComponent(orderCode)}&showinfo=true&holder=${encodeURIComponent(accountHolder)}`;

    const messageText = `🔥 *ĐẶT MUA ALBUM: ${targetAlbum.title}*
💰 *Giá gốc:* ${targetAlbum.price}
💳 *Số dư ví hiện có:* ${currentBalance.toLocaleString()}đ
💎 *Số tiền cần chuyển khoản:* *${finalPayAmount.toLocaleString()}đ*
--------------------------------------
💳 *Ngân hàng:* ${bankName === 'MB' ? 'MBBank' : 'ACB'}
👤 *Số tài khoản:* \`${accountNumber}\`
👤 *Chủ tài khoản:* ${accountHolder}
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
        await addSystemMessageId(chatId, sentQrMsg.message_id);

    } catch (error) {
        const sentTextMsg = await ctx.replyWithMarkdown(messageText);

        await setPendingOrder(chatId, orderCode, albumId, sentTextMsg.message_id);
        await addSystemMessageId(chatId, sentTextMsg.message_id);
    }
});

const app = express();
app.use(express.json());

app.post('/webhook/bank', async (req, res) => {
    res.status(200).json({ success: true });

    const currentTxCount = await getMonthlyTransactionCount();
    if (currentTxCount <= 100) {
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
                        const successMsg = await bot.telegram.sendMessage(customerChatId,
                            `🎉 <b>Thanh toán thành công!</b> Pé đã nhận được tiền rồi ạ. \n\n` +
                            `ℹ️ Mã hóa đơn: <code>${orderCode}</code>\n` +
                            `💰 Giá trị album: ${albumPrice.toLocaleString()}đ\n` +
                            `📥 Số tiền anh vừa nạp: ${actualPaid.toLocaleString()}đ\n` +
                            `💳 Số dư ví tích lũy còn lại: <b>${remainingBalance.toLocaleString()}đ</b> \n\n` +
                            `🎁 <b>Link Album của anh đây ạ:</b>\n` +
                            `💿 Album: <b>${targetAlbum.title}</b>\n` +
                            `🔗 Link 1: ${link1Text}\n` +
                            `🔗 Link 2: ${link2Text}\n\n` +
                            `Cảm ơn anh iu đã ủng hộ pé nhé! ~ ❤️❤️`,
                            { parse_mode: 'HTML' }
                        );
                        await addAlbumLinkMessageId(customerChatId, successMsg.message_id);
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
                        await addSystemMessageId(customerChatId, sentWarnMsg.message_id);
                    }
                }
            }
        } catch (error) {
            console.error(error);
        }
    } else {
        console.log("Đã đạt ngưỡng 100 giao dịch trong tháng, không xử lý thêm.\n");
        console.log('\n=== 📥 NHẬN WEBHOOK TỪ BANK / MACRODROID ===');
        console.log(req.body);
        console.log('===============================================\n');

        try {
            const content = (req.body.content || req.body.description || req.body.code || '').toString();
            let actualPaid = Number(req.body.transferAmount || req.body.amount || 0);

            if (!content) return;

            // Tự động bóc tách số tiền từ nội dung tin nhắn nếu webhook gửi từ MacroDroid
            if (!actualPaid || isNaN(actualPaid)) {
                // Bắt buộc phải có dấu + phía trước (VD: + 100,000) để tránh bắt nhầm số tài khoản
                const matchedAmount = content.replace(/[,.]/g, '').match(/\+\s*(\d{4,12})/);
                if (matchedAmount && matchedAmount[1]) {
                    actualPaid = Number(matchedAmount[1]);
                }
            }

            console.log(`[Webhook Check] Số tiền thực nhận: ${actualPaid}đ | Nội dung GD: ${content}`);

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

                // Đã xóa DANGEROUS FALLBACK (actualPaid = albumPrice) tại đây. 
                // Bảo vệ hệ thống khỏi việc tự động cho free nếu regex không bắt được tiền.

                console.log(`[Webhook Match] Mã HĐ: ${orderCode} | Cần thanh toán: ${albumPrice}đ | Nạp vào: ${actualPaid}đ`);

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
                        const successMsg = await bot.telegram.sendMessage(customerChatId,
                            `🎉 <b>Thanh toán thành công!</b> Pé đã nhận được tiền rồi ạ. \n\n` +
                            `ℹ️ Mã hóa đơn: <code>${orderCode}</code>\n` +
                            `💰 Giá trị album: ${albumPrice.toLocaleString()}đ\n` +
                            `📥 Số tiền anh vừa nạp: ${actualPaid.toLocaleString()}đ\n` +
                            `💳 Số dư ví tích lũy còn lại: <b>${remainingBalance.toLocaleString()}đ</b> \n\n` +
                            `🎁 <b>Link Album của anh đây ạ:</b>\n` +
                            `💿 Album: <b>${targetAlbum.title}</b>\n` +
                            `🔗 Link 1: ${link1Text}\n` +
                            `🔗 Link 2: ${link2Text}\n\n` +
                            `Cảm ơn anh iu đã ủng hộ pé nhé! ~ ❤️❤️`,
                            { parse_mode: 'HTML' }
                        );
                        await addAlbumLinkMessageId(customerChatId, successMsg.message_id);
                    } catch (err: any) {
                        console.error("Lỗi gửi link album webhook:", err);
                    }

                    await sendPurchaseReportToAdmin(customerChatId);
                    await clearPendingOrder(customerChatId);

                } else {
                    const shortAmount = albumPrice - newTotalBalance;

                    let sentWarnMsg = null;
                    try {
                        sentWarnMsg = await bot.telegram.sendMessage(customerChatId,
                            `⚠️ *CẢNH BÁO: CHUYỂN KHOẢN THIẾU TIỀN Hoặc SAI SỐ LƯỢNG* \n\n` +
                            `Hệ thống nhận được số tiền: *${actualPaid.toLocaleString()}đ* từ hóa đơn \`${orderCode}\`.\n` +
                            `💳 Tổng tiền trong ví hiện tại của anh: *${newTotalBalance.toLocaleString()}đ*.\n` +
                            `❌ Anh vẫn còn thiếu *${shortAmount.toLocaleString()}đ* nữa mới đủ mua album.\n\n` +
                            `👉 *Biện pháp:* Anh vui lòng chuyển khoản thêm đúng số tiền thiếu (*${shortAmount.toLocaleString()}đ*) và nhớ **giữ nguyên nội dung chuyển khoản là:** \`${orderCode}\` để hệ thống tự động cộng dồn đủ tiền nhe anh!`,
                            { parse_mode: 'Markdown' }
                        );
                    } catch (err: any) {
                        console.error("Lỗi gửi cảnh báo thiếu tiền webhook:", err);
                    }

                    if (sentWarnMsg) {
                        await addWarnMessageId(customerChatId, sentWarnMsg.message_id);
                        await addSystemMessageId(customerChatId, sentWarnMsg.message_id);
                    }
                }
            }
        } catch (error) {
            console.error("Lỗi khi xử lý webhook ngân hàng:", error);
        }
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

bot.command('addalbum', async (ctx) => {
    const userId = ctx.from.id;

    if (!ADMIN_IDS.includes(userId)) {
        return;
    }

    adminAddingAlbum.add(userId);

    const syntaxMsg = `
🔥 *Pé đang lắng nghe đây!*
Anh chạm vào khối chữ bên dưới để copy nhanh cú pháp mẫu nha:

\`\`\`
- Title: Nhập tên album
- Link: ["Link 1", "Link 2"]
- File ID: Nhập ID file
- Type: photo hoặc video
- Tags: ["Masturbation", "Lesbian", "HaveSex", "BDSM", "Squirt", "Public", "Anal", "Scat"]
- Price: 50000
- Description: Nhập mô tả...
\`\`\`

_(Gõ /cancel nếu anh muốn huỷ bỏ thao tác nha!)_
`;
    await ctx.reply(syntaxMsg, { parse_mode: 'Markdown' });
});

bot.command('editalbum', async (ctx) => {
    const userId = ctx.from.id;

    if (!ADMIN_IDS.includes(userId)) return;

    const text = ctx.message.text.trim();
    const args = text.split(/\s+/);

    if (args.length < 2) {
        return ctx.reply("⚠️ Anh gõ thiếu ID rồi nè. Cú pháp: `/editalbum [id]` nha!", { parse_mode: 'Markdown' });
    }

    const albumId = parseInt(args[1] as string);
    if (isNaN(albumId)) {
        return ctx.reply("⚠️ ID album phải là một con số nha anh iu!");
    }

    try {
        const res = await pool.query('SELECT * FROM albums WHERE id = $1', [albumId]);

        if (res.rows.length === 0) {
            return ctx.reply(`❌ Pé hông tìm thấy album nào có ID = ${albumId} trong Database cả!`);
        }

        const dbAlbum = res.rows[0];

        const linkStr = dbAlbum.link_album ? JSON.stringify(dbAlbum.link_album) : '[]';
        const tagsStr = dbAlbum.tags ? JSON.stringify(dbAlbum.tags) : '[]';

        const template =
            `id: ${dbAlbum.id}
title: ${dbAlbum.title}
link: ${linkStr}
fileID: ${dbAlbum.fileid}
type: ${dbAlbum.type}
tags: ${tagsStr}
price: ${dbAlbum.price}
description: ${dbAlbum.description}`;

        adminEditingAlbum.add(userId);

        await ctx.reply(`🔥 *Dữ liệu hiện tại của Album ID ${albumId}:*\nAnh copy khung dưới đây, sửa lại thông tin rồi gửi lại cho pé nha!\n_(Gõ /cancel nếu anh đổi ý hông muốn sửa nữa)_`, { parse_mode: 'Markdown' });

        await ctx.reply(`\`\`\`\n${template}\n\`\`\``, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error("Lỗi khi fetch album để edit:", error);
        return ctx.reply("Huhu có lỗi xảy ra khi pé lấy dữ liệu từ DB rồi anh ơi!");
    }
});

bot.command('searchalbum', async (ctx) => {
    const userId = ctx.from.id;

    if (!ADMIN_IDS.includes(userId)) return;

    const text = ctx.message.text.trim();
    const args = text.split(/\s+/);

    if (args.length < 2) {
        return ctx.reply("⚠️ Anh gõ thiếu từ khóa rồi nè. Cú pháp: `/searchalbum [từ khóa]` nha!", { parse_mode: 'Markdown' });
    }

    const searchTerm = text.substring(text.indexOf(' ') + 1).trim();

    try {
        const query = `
            SELECT id, title 
            FROM albums 
            WHERE title ILIKE $1
            ORDER BY id ASC
            LIMIT 30
        `;

        const res = await pool.query(query, [`%${searchTerm}%`]);

        if (res.rows.length === 0) {
            return ctx.reply(`❌ Pé hông tìm thấy album nào có chứa chữ *"${searchTerm}"* cả!`, { parse_mode: 'Markdown' });
        }

        let replyText = `🔍 *Pé tìm thấy ${res.rows.length} kết quả cho "${searchTerm}":*\n\n`;

        res.rows.forEach((album) => {
            replyText += `👉 *ID:* \`${album.id}\` — ${album.title}\n`;
        });

        replyText += `\n_(Gõ /editalbum [ID] để sửa hoặc /del [ID] để xóa nhé)_`;

        return ctx.reply(replyText, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error("Lỗi khi tìm kiếm album:", error);
        return ctx.reply("Huhu có lỗi xảy ra khi pé quét Database rồi anh ơi! Anh check log server xem sao nha.");
    }
});

bot.command('adduserbuy', async (ctx) => {
    const ctxAny = ctx as any;
    const adminId = ctxAny.from?.id;

    if (!adminId || !ADMIN_IDS.includes(adminId)) return;

    const payload = (ctxAny.payload || '').trim();
    if (!payload) {
        return ctx.reply('⚠️ Anh ơi, sai cú pháp rồi! Anh phải nhập User ID và các ID album nha.\n👉 Ví dụ: <code>/adduserbuy 12345678 42 12 55</code>', { parse_mode: 'HTML' });
    }

    const args = payload.split(/\s+/);
    let targetUserId: number;
    let albumIds: number[] = [];
    let targetName = 'Khách Hàng';
    let username = 'Không có';

    const messageAny = ctx.message as any;
    const replyTo = messageAny?.reply_to_message;

    const firstArg = parseInt(args[0] as string);

    if (firstArg > 100000) {
        targetUserId = firstArg;
        albumIds = args.slice(1).map((x: string) => parseInt(x)).filter((x: number) => !isNaN(x));

        if (replyTo && replyTo.forward_from) {
            const fUser = replyTo.forward_from;
            username = fUser.username ? `@${fUser.username}` : 'Không có';
            targetName = `${fUser.first_name || ''} ${fUser.last_name || ''}`.trim() || fUser.username || 'Khách Hàng';
        } else if (replyTo && replyTo.forward_sender_name) {
            targetName = replyTo.forward_sender_name;
        }
    } else {
        if (!replyTo) {
            return ctx.reply('⚠️ Anh ơi, anh phải Reply tin nhắn forward HOẶC nhập User ID ở đầu tiên nha!\n👉 Ví dụ: <code>/adduserbuy 12345678 42 12 55</code>', { parse_mode: 'HTML' });
        }

        const targetUser = replyTo.forward_from;

        if (!targetUser) {
            return ctx.reply('⚠️ User ẩn ID forward rồi, anh phải nhập trực tiếp User ID nha!\n👉 Ví dụ: <code>/adduserbuy 12345678 42 12 55</code>', { parse_mode: 'HTML' });
        }

        targetUserId = targetUser.id;
        const firstName = targetUser.first_name || '';
        const lastName = targetUser.last_name || '';
        const fullName = `${firstName} ${lastName}`.trim();

        username = targetUser.username ? `@${targetUser.username}` : 'Không có';
        targetName = fullName || targetUser.username || 'Khách Hàng';
        albumIds = args.map((x: string) => parseInt(x)).filter((x: number) => !isNaN(x));
    }

    if (albumIds.length === 0) {
        return ctx.reply('⚠️ Anh chưa nhập ID album nào để thêm cả!\n👉 Ví dụ: <code>/adduserbuy 12345678 42 12 55</code>', { parse_mode: 'HTML' });
    }

    try {
        await pool.query(
            `INSERT INTO users_data (user_id, full_name, username, balance) 
             VALUES ($1, $2, $3, 0) 
             ON CONFLICT (user_id) DO NOTHING`,
            [targetUserId, targetName, username]
        );

        let successAlbums: string[] = [];
        let failedAlbums: string[] = [];

        for (const albId of albumIds) {
            const albumRes = await pool.query('SELECT title, price FROM albums WHERE id = $1', [albId]);

            if (albumRes.rowCount === 0) {
                failedAlbums.push(`ID ${albId}: Không có trong kho`);
                continue;
            }

            const targetAlbum = albumRes.rows[0];

            const checkExist = await pool.query(
                'SELECT 1 FROM users_purchased WHERE user_id = $1 AND album_id = $2 LIMIT 1',
                [targetUserId, albId]
            );

            if (checkExist.rowCount && checkExist.rowCount > 0) {
                failedAlbums.push(`ID ${albId}: Đã sở hữu (${targetAlbum.title})`);
                continue;
            }

            const insertQuery = `INSERT INTO users_purchased (user_id, album_id, price, payment_method) VALUES ($1, $2, $3, $4)`;
            await pool.query(insertQuery, [targetUserId, albId, targetAlbum.price, 'manual']);

            successAlbums.push(`<b>${targetAlbum.title}</b> (ID: ${albId})`);
        }

        ctxAny.deleteMessage().catch(() => { });

        let replyMsg = `✅ <b>Đã xử lý cấp quyền sở hữu album:</b>\n\n`;
        replyMsg += `👤 Khách hàng: ${targetName}\n`;
        replyMsg += `🏷️ Username: ${username}\n`;
        replyMsg += `🆔 ID: ${targetUserId}\n\n`;

        if (successAlbums.length > 0) {
            replyMsg += `🎉 <b>Thêm THÀNH CÔNG:</b>\n- ` + successAlbums.join('\n- ') + `\n\n`;
        }

        if (failedAlbums.length > 0) {
            replyMsg += `⚠️ <b>Thêm THẤT BẠI:</b>\n- ` + failedAlbums.join('\n- ') + `\n`;
        }

        await ctx.reply(replyMsg, { parse_mode: 'HTML' });

    } catch (error) {
        console.error('Lỗi khi add user buy:', error);
        ctx.reply('❌ Có lỗi nghiêm trọng khi ghi vào Database, anh check lại Log terminal nha!');
    }
});

bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id;
    const text = (ctx.message as any).text;

    if (adminEditingAlbum.has(userId)) {
        if (text === '/cancel') {
            adminEditingAlbum.delete(userId);
            return ctx.reply("Đã huỷ thao tác sửa album nha anh iu! ❌");
        }

        if (text.startsWith('/') || text.trim().startsWith('@')) {
            adminEditingAlbum.delete(userId);
            return next();
        }

        if (!text.toLowerCase().includes('id:')) {
            return next();
        }

        try {
            const idMatch = text.match(/id:\s*(\d+)/i);
            const titleMatch = text.match(/title:\s*(.+)/i);
            const linkMatch = text.match(/link:\s*(\[.*?\])/is);
            const fileIdMatch = text.match(/fileID:\s*(.+)/i);
            const typeMatch = text.match(/type:\s*(photo|video)/i);
            const tagsMatch = text.match(/tags:\s*(\[.*?\])/is);
            const priceMatch = text.match(/price:\s*(.+)/i);
            const descMatch = text.match(/description:\s*([\s\S]+)/i);

            const missing = [];
            if (!idMatch) missing.push("id");
            if (!titleMatch) missing.push("title");
            if (!linkMatch) missing.push("link (Anh nhớ bao trong ngoặc vuông [...])");
            if (!fileIdMatch) missing.push("fileID");
            if (!typeMatch) missing.push("type (photo/video)");
            if (!tagsMatch) missing.push("tags (Anh nhớ bao trong ngoặc vuông [...])");
            if (!priceMatch) missing.push("price");
            if (!descMatch) missing.push("description");

            if (missing.length > 0) {
                return ctx.reply(`⚠️ **Pé bắt được lỗi sai rồi nha!**\nAnh đang nhập thiếu hoặc sai định dạng ở các dòng này nè:\n👉 *${missing.join(', ')}*\n\nAnh rà soát lại xíu nghen!`, { parse_mode: 'Markdown' });
            }

            const albumId = parseInt(idMatch![1]);
            const title = titleMatch![1].trim();
            const fileId = fileIdMatch![1].trim();
            const type = typeMatch![1].toLowerCase().trim();
            const price = priceMatch![1].trim();
            const description = descMatch![1].trim();

            const linkStr = linkMatch![1].replace(/[“”]/g, '"').trim();
            const tagsStr = tagsMatch![1].replace(/[“”]/g, '"').trim();

            const links = JSON.parse(linkStr);
            const tags = JSON.parse(tagsStr);

            const query = `
                UPDATE albums 
                SET title = $1, link_album = $2, fileid = $3, type = $4, tags = $5, price = $6, description = $7
                WHERE id = $8
            `;

            await pool.query(query, [
                title,
                JSON.stringify(links),
                fileId,
                type,
                tags,
                price,
                description,
                albumId
            ]);

            adminEditingAlbum.delete(userId);
            await loadAllAlbumsData();

            return ctx.reply(`🎉 Pé đã cập nhật xong toàn bộ thay đổi cho Album ID *${albumId}* rồi nha anh iu!`, { parse_mode: 'Markdown' });

        } catch (error) {
            console.error("Lỗi khi update album:", error);
            return ctx.reply("⚠️ Lỗi trích xuất dữ liệu mảng! Có thể anh gõ thiếu dấu phẩy `,` hoặc ngoặc kép `\" \"` ở phần Link/Tags rồi. Anh gõ /cancel để thoát hoặc gửi lại bản đã sửa nhé.");
        }
    }

    if (adminAddingAlbum.has(userId)) {
        if (text === '/cancel') {
            adminAddingAlbum.delete(userId);
            return ctx.reply("Đã huỷ thao tác thêm album nha anh iu! ❌");
        }

        if (text.startsWith('/') || text.trim().startsWith('@')) {
            adminAddingAlbum.delete(userId);
            return next();
        }

        if (!text.toLowerCase().includes('title:')) {
            return next();
        }

        try {
            const titleMatch = text.match(/Title:\s*(.+)/i);
            const linkMatch = text.match(/Link:\s*(\[.*?\])/is);
            const fileIdMatch = text.match(/File\s*ID:\s*(.+)/i);
            const typeMatch = text.match(/Type:\s*(photo|video)/i);
            const tagsMatch = text.match(/Tags:\s*(\[.*?\])/is);
            const priceMatch = text.match(/Price:\s*(.+)/i);
            const descMatch = text.match(/Description:\s*([\s\S]+)/i);

            const missing = [];
            if (!titleMatch) missing.push("Title");
            if (!linkMatch) missing.push("Link (Anh nhớ phải bao trong ngoặc vuông [...])");
            if (!fileIdMatch) missing.push("FileID");
            if (!typeMatch) missing.push("Type (Chỉ được ghi đúng chữ 'photo' hoặc 'video')");
            if (!tagsMatch) missing.push("Tags (Anh nhớ phải bao trong ngoặc vuông [...])");
            if (!priceMatch) missing.push("Price");
            if (!descMatch) missing.push("Description");

            if (missing.length > 0) {
                return ctx.reply(`⚠️ **Pé bắt được lỗi sai rồi nha!**\nAnh đang nhập thiếu hoặc sai định dạng ở các dòng này nè:\n👉 *${missing.join(', ')}*\n\nAnh rà soát lại xíu nghen!`, { parse_mode: 'Markdown' });
            }

            const title = titleMatch![1].trim();
            const fileId = fileIdMatch![1].trim();
            const type = typeMatch![1].toLowerCase().trim();
            const price = priceMatch![1].trim();
            const description = descMatch![1].trim();

            const linkStr = linkMatch![1].replace(/[“”]/g, '"').trim();
            const tagsStr = tagsMatch![1].replace(/[“”]/g, '"').trim();

            const links = JSON.parse(linkStr);
            const tags = JSON.parse(tagsStr);

            const isSuccess = await addNewAlbum(title, links, fileId, type, tags, price, description);

            if (isSuccess) {
                adminAddingAlbum.delete(userId);
                return ctx.reply(`🎉 Pé đã thêm album *" ${title} "* vào Database thành công rồi nha!`, { parse_mode: 'Markdown' });
            } else {
                return ctx.reply("Huhu, có lỗi khi lưu vào Database rồi anh ơi! Xem log trên server nha.");
            }
        } catch (error) {
            console.error(error);
            return ctx.reply("⚠️ Lỗi trích xuất dữ liệu mảng! Có thể anh gõ thiếu dấu phẩy `,` hoặc ngoặc kép `\" \"` ở phần Link/Tags rồi. Anh gõ /cancel để thoát hoặc gửi lại nhé.");
        }
    }
    return next();
});

bot.on('message', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    try {
        setTimeout(async () => {
            await ctx.deleteMessage();
        }, 5000);

        const warningMsg = await ctx.reply('⚠️ Anh chỉ cần thao thao tác qua NÚT BẤM bên trên thui ạ ❤️!');
        await addSystemMessageId(ctx.from.id, warningMsg.message_id);

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
                const warnMsg = await ctx.telegram.sendMessage(
                    ctx.chat.id,
                    "⚠️ Hệ thống đang bận..vui lòng chờ 2-5 phút"
                );
                await addSystemMessageId(ctx.chat.id, warnMsg.message_id);
            }
        } catch (sendErr) {
            console.error(sendErr);
        }
    }
});

bot.launch({ dropPendingUpdates: true });
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