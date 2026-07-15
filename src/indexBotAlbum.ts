import { Telegraf, Context, Markup } from 'telegraf';
// import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import fs from 'fs';
import express from 'express'; // Nhớ cài đặt: npm install express @types/express

dotenv.config();

const bot = new Telegraf<NyanContext>(process.env.BOT_TOKEN as string);
const GROUP_NOTI_PAYMENT = process.env.GROUP_NOTI_PAYMENT ? Number(process.env.GROUP_NOTI_PAYMENT) : null;
// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);

// Define a custom context interface that extends the default Telegraf Context
interface NyanContext extends Context {
    // Add any custom properties or methods you want to include in your context
}

interface Album {
    id: number;
    title: string;
    linkAlbum?: string[]; // 
    path: string;
    type: 'photo' | 'video';
    tags: string[];
    price: string;
    description: string;
}

// Định nghĩa cấu trúc đơn hàng chờ xử lý trong User
interface PendingOrderInfo {
    orderCode: string;
    albumId: number;
    qrMessageId: number;
    warnMessageIds: number[];
}

// Định nghĩa cấu trúc dữ liệu lưu trữ tổng hợp của một User
interface UserProfile {
    balance: number;           // Số dư ví tích lũy
    purchasedAlbums: number[]; // Danh sách các ID album đã mua thành công
    pendingOrder: PendingOrderInfo | null; // Đơn hàng đang chờ thanh toán duy nhất
}

// 1. Set the relative path from your project root directory
const fileRelativePath = './img/listAlbum/allAlbum.json';
const usersFilePath = './users.json';

// 2. Read and parse the file using pure 'fs'
let albums: Album[] = [];

try {
    if (fs.existsSync(fileRelativePath)) {
        const fileContent = fs.readFileSync(fileRelativePath, 'utf-8');
        albums = JSON.parse(fileContent);

        // Lọc album từ id lớn xuống id nhỏ
        albums.sort((a, b) => b.id - a.id);

        console.log(`Loaded ${albums.length} albums successfully from storage!`);
    } else {
        console.error(`Error: Album data file not found at ${fileRelativePath}`);
    }
} catch (error) {
    console.error("Failed to parse album data file:", error);
}

// --- CÁC HÀM ĐỌC/GHI FILE JSON GỘP CỦA USER ---
function loadUsersData(): Record<string, UserProfile> {
    try {
        if (fs.existsSync(usersFilePath)) {
            const fileContent = fs.readFileSync(usersFilePath, 'utf-8').trim();
            if (fileContent) return JSON.parse(fileContent);
        }
    } catch (e) {
        console.error("Lỗi khi đọc file users.json:", e);
    }
    return {};
}

function saveUsersData(data: Record<string, UserProfile>) {
    try {
        fs.writeFileSync(usersFilePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
        console.error("Lỗi khi ghi file users.json:", e);
    }
}

// Hàm cập nhật số dư ví an toàn
function updateUserBalance(chatId: number, amount: number): number {
    const users = loadUsersData();
    const key = chatId.toString();
    if (!users[key]) {
        users[key] = { balance: 0, purchasedAlbums: [], pendingOrder: null };
    }
    users[key].balance = (users[key].balance || 0) + amount;
    saveUsersData(users);
    return users[key].balance;
}

// Hàm lưu trữ Album đã mua thành công vào lịch sử user
function addPurchasedAlbum(chatId: number, albumId: number) {
    const users = loadUsersData();
    const key = chatId.toString();
    if (!users[key]) {
        users[key] = { balance: 0, purchasedAlbums: [], pendingOrder: null };
    }
    if (!users[key].purchasedAlbums.includes(albumId)) {
        users[key].purchasedAlbums.push(albumId);
        saveUsersData(users);
    }
}

// Hàm kiểm tra xem người dùng có phải là Admin/Creator trong Group hoặc đang chat riêng tư không
async function isAdminOrPrivate(ctx: any): Promise<boolean> {
    // Nếu là chat riêng tư với Bot (Direct Message) thì luôn cho phép
    if (ctx.chat?.type === 'private') return true;

    try {
        const member = await ctx.getChatMember(ctx.from?.id);
        // Nếu là Admin hoặc Chủ Group (creator) thì trả về true
        if (member.status === 'administrator' || member.status === 'creator') {
            return true;
        }
    } catch (error) {
        console.error("Lỗi khi kiểm tra quyền admin:", error);
    }

    return false;
}

/**
 * Gửi báo cáo danh sách album mua cộng dồn của User về cho Admin
 */
async function sendPurchaseReportToAdmin(customerId: number, defaultName: string = "Không rõ", defaultUsername: string = "Không có") {
    if (!GROUP_NOTI_PAYMENT) {
        console.log("⚠️ Chưa cấu hình GROUP_NOTI_PAYMENT trong file .env!");
        return;
    }

    try {
        // 1. Lấy thông tin mới nhất của khách hàng từ Telegram API
        let fullName = defaultName;
        let username = defaultUsername;
        try {
            const chatInfo = await bot.telegram.getChat(customerId) as any;
            const firstName = chatInfo.first_name || "";
            const lastName = chatInfo.last_name || "";
            fullName = `${firstName} ${lastName}`.trim() || defaultName;
            username = chatInfo.username ? `@${chatInfo.username}` : defaultUsername;
        } catch (e) {
            // Lỗi hoặc không fetch được thì giữ nguyên tên mặc định truyền vào
        }

        // 2. Đọc dữ liệu user từ database để lấy danh sách album đã sở hữu
        const users = loadUsersData(); 
        const userProfile = users[customerId.toString()];
        const purchasedIds: number[] = userProfile?.purchasedAlbums || [];

        // 3. Sử dụng trực tiếp mảng `albums` toàn cục đã được load thành công ở trên đầu file
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

        // 4. Tạo tin nhắn văn bản thuần không parse_mode tránh lỗi ký tự đặc biệt
        const message = 
            `👤 Khách hàng: ${fullName}\n` +
            `🏷️ Username: ${username}\n` +
            `🆔 ID: ${customerId}\n` +
            `🎥 Album mua: \n${albumListText}`;

        // 5. Bắn thông tin trực tiếp về cho Admin chat
        await bot.telegram.sendMessage(GROUP_NOTI_PAYMENT, message);

    } catch (error) {
        console.error("🚨 Lỗi khi gửi báo cáo Admin:", error);
    }
}

// Slash /start
bot.start(async (ctx) => {
    // 🛡️ KIỂM TRA QUYỀN ADMIN
    const hasPermission = await isAdminOrPrivate(ctx);
    if (!hasPermission) {
        // Nếu không phải admin, bot im lặng hoàn toàn (hoặc dùng ctx.reply nếu muốn nhắc nhở)
        return;
    }

    // 🌟 THÊM TYPING
    await ctx.replyWithChatAction('upload_photo').catch(() => { });
    return ctx.replyWithPhoto(
        { source: './img/Banner.jpg' },
        {
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
        }
    );
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
    // 🌟 THÊM TYPING
    await ctx.replyWithChatAction('upload_photo').catch(() => { });

    try {
        await ctx.editMessageMedia({
            type: 'photo',
            media: { source: fs.createReadStream('./img/Banner.jpg') }
        });

        await ctx.editMessageCaption('Hi anh. Anh mún chọn gì nè??', {
            reply_markup: getMainMenuKeyboard()
        });
    } catch (error) {
        console.error("Lỗi khi quay lại menu:", error);
    }
});

bot.action('check_balance', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) { }
    // 🌟 THÊM TYPING
    await ctx.replyWithChatAction('typing').catch(() => { });

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const users = loadUsersData();
    const user = users[chatId.toString()] || { balance: 0, purchasedAlbums: [], pendingOrder: null };

    await ctx.reply(`💳 *VÍ TÍCH LŨY CỦA ANH* \n\nSố dư ví hiện tại: *${user.balance.toLocaleString()}đ*\n📦 Album đã mua thành công: *${user.purchasedAlbums.length}*\n\n_(Tiền thừa khi chuyển khoản sai cấu trúc hoặc dư sẽ tự động nạp thẳng vào ví này để trừ vào các đơn hàng sau!)_`, { parse_mode: 'Markdown' });
});

// Map to track sent message IDs for each chat session to clear them on pagination
const userSessionMessages = new Map<number, number[]>();

// Hàm xử lý chung cho mọi nút dịch vụ
bot.action(/view(.+)/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) { }

    const service = ctx.match[1];

    let fileInfo = {
        type: 'photo' as 'photo' | 'video',
        path: './img/Banner.jpg',
        text: 'Hi anh. Anh mún chọn gì nè??',
        keyboard: {
            inline_keyboard: [[{ text: '🔙 Quay lại menu chính', callback_data: 'view_services' }]]
        }
    };

    switch (service) {
        case 'Album':
            fileInfo = {
                type: 'photo',
                path: './img/Banner.jpg',
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
            fileInfo.text = 'Tính năng này hiện chưa khả dụng anh iu ơi. \n\nAnh xem trong @nyanchanbikini rồi nhắn cho Nyan nhé!';
            break;
        case 'Juice':
            fileInfo.type = 'video';
            fileInfo.path = './img/Juice.MP4';
            fileInfo.text = 'Tính năng này hiện chưa khả dụng anh iu ơi.';
            break;
        case 'Sextoy':
            fileInfo.type = 'video';
            fileInfo.path = './img/Sextoy.MP4';
            fileInfo.text = 'Tính năng này hiện chưa khả dụng anh iu ơi. \n\nAnh xem trong @shopsextoy2 rồi nhắn cho Nyan nhé!';
            break;
    }

    if (!fs.existsSync(fileInfo.path)) return ctx.reply("File không tồn tại!");

    // 🌟 THÊM TYPING DỰA TRÊN LOẠI FILE ĐỊNH GỬI
    if (fileInfo.type === 'video') {
        await ctx.replyWithChatAction('upload_video').catch(() => { });
    } else {
        await ctx.replyWithChatAction('upload_photo').catch(() => { });
    }

    try {
        await ctx.editMessageMedia({
            type: fileInfo.type,
            media: { source: fs.createReadStream(fileInfo.path) }
        });

        await ctx.editMessageCaption(fileInfo.text, {
            reply_markup: fileInfo.keyboard
        });
    } catch (error) {
        console.error("Lỗi edit message:", error);
    }
});

// Handle category selection (e.g., Masturbation, BDSM)
bot.action(/tag_([^_]+)(?:_(\d+))?/, async (ctx) => {
    try {
        await ctx.answerCbQuery();
    } catch (e) { }
    // 🌟 THÊM TYPING
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

        if (!fs.existsSync(album.path)) {
            const failMsg = await ctx.reply(`${album.title} is currently under maintenance...`);
            newSentMessageIds.push(failMsg.message_id);
            continue;
        }

        const captionText =
            `🎥 *${album.title}*\n\n` +
            `📝 *Description:* ${album.description}\n` +
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

        try {
            let sentMsg;
            if (album.type === 'video') {
                await ctx.replyWithChatAction('upload_video').catch(() => { });
                sentMsg = await ctx.replyWithVideo(
                    { source: fs.createReadStream(album.path) },
                    {
                        caption: captionText,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: inlineKeyboard }
                    }
                );
            } else {
                await ctx.replyWithChatAction('upload_photo').catch(() => { });
                sentMsg = await ctx.replyWithPhoto(
                    { source: fs.createReadStream(album.path) },
                    {
                        caption: captionText,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: inlineKeyboard }
                    }
                );
            }
            newSentMessageIds.push(sentMsg.message_id);
        } catch (error) {
            console.error(`Lỗi khi gửi album ID ${album.id}:`, error);
        }
    }

    userSessionMessages.set(chatId, newSentMessageIds);
});

// --- XỬ LÝ HÀNH ĐỘNG TẠO ĐƠN HÀNG KHI KHÁCH ẤN MUA ---
bot.action(/buy_album_(.+)/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) { }
    // 🌟 THÊM TYPING
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

    // Xóa các tin nhắn album không được chọn để tránh tràn khung chat
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

    const users = loadUsersData();
    const key = chatId.toString();
    if (!users[key]) {
        users[key] = { balance: 0, purchasedAlbums: [], pendingOrder: null };
    }
    const user = users[key];

    if (user.purchasedAlbums.includes(albumId)) {
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

    if (user.balance >= albumPriceNum) {
        const remainingBalance = updateUserBalance(chatId, -albumPriceNum);
        addPurchasedAlbum(chatId, albumId);

        // 🌟 TÍNH NĂNG MỚI: Trả link trực tiếp khi mua bằng số dư ví
        const link1Raw = targetAlbum.linkAlbum?.[0]?.replace('Link 1:', '').trim();
        const link2Raw = targetAlbum.linkAlbum?.[1]?.replace('Link 2:', '').trim();
        const link1Text = link1Raw ? link1Raw : "Link này pé chưa cập nhật";
        const link2Text = link2Raw ? link2Raw : "Link này pé chưa cập nhật";

        await ctx.reply(
            `🎉 *MUA THÀNH CÔNG BẰNG VÍ SỐ DƯ!* \n\n` +
            `Số dư ví của anh đã tự động khấu trừ ${albumPriceNum.toLocaleString()}đ.\n` +
            `💳 Số dư hiện tại còn lại: *${remainingBalance.toLocaleString()}đ*.\n\n` +
            `🎁 *Link Album của anh đây ạ:*\n` +
            `🔗 Link 1: ${link1Text}\n` +
            `🔗 Link 2: ${link2Text}\n\n` +
            `Cảm ơn anh iu đã ủng hộ pé nhé! ~ ❤️❤️`,
            { parse_mode: 'Markdown' }
        );

        // 🔔 GỬI BÁO CÁO CỘNG DỒN CHO ADMIN
        const userFirstName = ctx.from?.first_name || "Không rõ";
        const userLastName = ctx.from?.last_name || "";
        const fullName = `${userFirstName} ${userLastName}`.trim();
        const username = ctx.from?.username ? `@${ctx.from.username}` : "Không có";
        
        // Gọi hàm gửi báo cáo (sẽ tự động đọc dữ liệu cộng dồn từ file JSON vừa lưu)
        await sendPurchaseReportToAdmin(chatId, fullName, username);

        return;
    }

    const finalPayAmount = albumPriceNum - user.balance;
    const accountNumber = "8288977";
    const qrUrl = `https://vietqr.app/img?bank=ACB&acc=8288977&template=compact&amount=${finalPayAmount}&des=${encodeURIComponent(orderCode)}&showinfo=true&holder=NGUYEN%20NGOC%20THAI`;

    const messageText = `🔥 *ĐẶT MUA ALBUM: ${targetAlbum.title}*
💰 *Giá gốc:* ${targetAlbum.price}
💳 *Số dư ví hiện có:* ${user.balance.toLocaleString()}đ
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

        users[key].pendingOrder = {
            orderCode: orderCode,
            albumId: albumId,
            qrMessageId: sentQrMsg.message_id,
            warnMessageIds: []
        };
        saveUsersData(users);

    } catch (error) {
        console.error("Lỗi khi render hoặc gửi mã VietQR:", error);

        const sentTextMsg = await ctx.replyWithMarkdown(messageText);

        users[key].pendingOrder = {
            orderCode: orderCode,
            albumId: albumId,
            qrMessageId: sentTextMsg.message_id,
            warnMessageIds: []
        };
        saveUsersData(users);
    }
});

// --- SERVER EXPRESS NHẬN WEBHOOK TỪ SEPAY ---
const app = express();
app.use(express.json());

app.post('/webhook/bank', async (req, res) => {
    // Trả phản hồi ngay lập tức cho SePay để tránh SePay gửi lại nhiều lần (gây trùng đơn)
    res.status(200).json({ success: true });

    try {
        const { content, transferAmount } = req.body;
        const actualPaid = Number(transferAmount);
        console.log(`[SePay] Nhận giao dịch: ${actualPaid}đ - Nội dung: "${content}"`);

        if (!content) return;

        // Quét trong danh sách Users tìm người giữ mã đơn khớp
        const users = loadUsersData();
        let matchedChatId: string | null = null;
        let matchedOrder: PendingOrderInfo | null = null;

        for (const [chatIdKey, userProfile] of Object.entries(users)) {
            if (userProfile.pendingOrder && content.toUpperCase().includes(userProfile.pendingOrder.orderCode.toUpperCase())) {
                matchedChatId = chatIdKey;
                matchedOrder = userProfile.pendingOrder;
                break;
            }
        }

        if (matchedChatId && matchedOrder) {
            const customerChatId = Number(matchedChatId);
            const qrMessageId = matchedOrder.qrMessageId;
            const targetAlbumId = matchedOrder.albumId;
            const warnMessageIds = matchedOrder.warnMessageIds || [];

            const targetAlbum = albums.find(a => a.id === targetAlbumId);
            if (!targetAlbum) return;

            let rP = targetAlbum.price.toLowerCase().trim();
            let albumPrice = rP.includes('k') ? Number(rP.replace(/[^0-9]/g, '')) * 1000 : Number(rP.replace(/[^0-9]/g, ''));

            // Bước 1: Nạp toàn bộ số tiền vào ví trước
            const newTotalBalance = updateUserBalance(customerChatId, actualPaid);

            if (newTotalBalance >= albumPrice) {
                // ========================================================
                // TRƯỜNG HỢP 1: ĐỦ/THỪA TIỀN (XỬ LÝ THÀNH CÔNG VÀ TRẢ LINK)
                // ========================================================
                const remainingBalance = updateUserBalance(customerChatId, -albumPrice);
                addPurchasedAlbum(customerChatId, targetAlbumId);

                // 🛡️ CHỐNG CRASH: Xóa tin nhắn QR code cũ (Bọc try...catch riêng)
                if (qrMessageId) {
                    try {
                        await bot.telegram.deleteMessage(customerChatId, qrMessageId);
                    } catch (err) {
                        console.error(`[Webhook Error] Không thể xóa QR code của khách ${customerChatId} (Có thể khách đã tự xóa):`, err);
                    }
                }

                // 🛡️ CHỐNG CRASH: Vòng lặp xóa sạch các tin nhắn cảnh báo thiếu tiền trước đó
                for (const warnMsgId of warnMessageIds) {
                    try {
                        await bot.telegram.deleteMessage(customerChatId, warnMsgId);
                        console.log(`[Xóa Cảnh Báo] Đã xóa tin nhắn thiếu tiền ID: ${warnMsgId}`);
                    } catch (err) {
                        console.error(`[Webhook Error] Không thể xóa tin nhắn cảnh báo ${warnMsgId} của khách ${customerChatId}:`, err);
                    }
                }

                // Lấy thông tin link album
                const link1Raw = targetAlbum.linkAlbum?.[0]?.replace('Link 1:', '').trim();
                const link2Raw = targetAlbum.linkAlbum?.[1]?.replace('Link 2:', '').trim();
                const link1Text = link1Raw ? link1Raw : "Link này pé chưa cập nhật";
                const link2Text = link2Raw ? link2Raw : "Link này pé chưa cập nhật";

                // 🛡️ CHỐNG CRASH CHÍ MẠNG: Gửi tin nhắn chứa link cho khách (Nếu khách block bot, bot vẫn không sập)
                try {
                    await bot.telegram.sendMessage(customerChatId,
                        `🎉 *Thanh toán thành công!* Pé đã nhận được tiền rồi ạ. \n\n` +
                        `ℹ️ Mã hóa đơn: \`${matchedOrder.orderCode}\`\n` +
                        `💰 Giá trị album: ${albumPrice.toLocaleString()}đ\n` +
                        `📥 Số tiền anh vừa nạp: ${actualPaid.toLocaleString()}đ\n` +
                        `💳 Số dư ví tích lũy còn lại: *${remainingBalance.toLocaleString()}đ* \n\n` +
                        `🎁 *Link Album của anh đây ạ:*\n` +
                        `🔗 Link 1: ${link1Text}\n` +
                        `🔗 Link 2: ${link2Text}\n\n` +
                        `Cảm ơn anh iu đã ủng hộ pé nhé! ~ ❤️❤️`,
                        { parse_mode: 'Markdown' }
                    );
                } catch (err: any) {
                    console.error(`🚨 [CRITICAL] Không thể gửi LINK ALBUM cho khách ${customerChatId}. Lý do: ${err?.message || err}`);
                }

                // 🔔 GỬI BÁO CÁO CỘNG DỒN CHO ADMIN KHI THANH TOÁN QUA BANK THÀNH CÔNG
                await sendPurchaseReportToAdmin(customerChatId);

                // Xoá sạch đơn chờ thanh toán bằng cách set về null
                const freshUsers = loadUsersData();
                if (matchedChatId) {
                    const userKey = matchedChatId;
                    if (freshUsers[userKey]) {
                        freshUsers[userKey].pendingOrder = null;
                        saveUsersData(freshUsers);
                    }
                }

                console.log(`[Thành Công] Đã xử lý đơn thành công: ${matchedOrder.orderCode}. Ví dư còn: ${remainingBalance}đ`);
            } else {
                // ========================================================
                // TRƯỜNG HỢP 2: THIẾU TIỀN
                // ========================================================
                const shortAmount = albumPrice - newTotalBalance;

                let sentWarnMsg = null;
                // 🛡️ CHỐNG CRASH: Gửi cảnh báo thiếu tiền (Bọc try...catch riêng)
                try {
                    sentWarnMsg = await bot.telegram.sendMessage(customerChatId,
                        `⚠️ *CẢNH BÁO: CHUYỂN KHOẢN THIẾU TIỀN* \n\n` +
                        `Hệ thống nhận được số tiền: *${actualPaid.toLocaleString()}đ* từ hóa đơn \`${matchedOrder.orderCode}\`.\n` +
                        `💳 Tổng tiền trong ví hiện tại của anh: *${newTotalBalance.toLocaleString()}đ*.\n` +
                        `❌ Anh vẫn còn thiếu *${shortAmount.toLocaleString()}đ* nữa mới đủ mua album.\n\n` +
                        `👉 *Biện pháp:* Anh vui lòng chuyển khoản thêm đúng số tiền thiếu (*${shortAmount.toLocaleString()}đ*) và nhớ **giữ nguyên nội dung chuyển khoản là:** \`${matchedOrder.orderCode}\` để hệ thống tự động cộng dồn đủ tiền nhe anh!`,
                        { parse_mode: 'Markdown' }
                    );
                } catch (err: any) {
                    console.error(`[Webhook Error] Không thể gửi tin nhắn cảnh báo thiếu tiền cho khách ${customerChatId}:`, err?.message || err);
                }

                // LƯU ID TIN NHẮN CẢNH BÁO VÀO MẢNG ĐỂ LẦN SAU XÓA (Chỉ lưu nếu gửi tin nhắn thành công)
                if (sentWarnMsg) {
                    const freshUsers = loadUsersData();
                    if (matchedChatId) {
                        const userKey = matchedChatId;
                        if (freshUsers[userKey] && freshUsers[userKey].pendingOrder) {
                            if (!freshUsers[userKey].pendingOrder.warnMessageIds) {
                                freshUsers[userKey].pendingOrder.warnMessageIds = [];
                            }
                            freshUsers[userKey].pendingOrder.warnMessageIds.push(sentWarnMsg.message_id);
                            saveUsersData(freshUsers);
                        }
                    }
                }

                console.log(`[Thiếu Tiền] Đơn ${matchedOrder.orderCode} tổng có ${newTotalBalance}đ, thiếu ${shortAmount}đ`);
            }
        }
    } catch (error) {
        console.error("Lỗi hệ thống nghiêm trọng khi xử lý logic webhook từ SePay:", error);
    }
});


// BẮT TOÀN BỘ LỖI TIMEOUT ĐỂ BÁO CHO NGƯỜI DÙNG
bot.catch(async (err: any, ctx: Context) => {
    console.error(`[Global Error] Lỗi khi xử lý update ${ctx.updateType}:`, err);
    const errMsg = err?.message || err?.toString() || '';

    // Nếu gặp lỗi Timeout
    if (errMsg.includes('Timeout') || errMsg.includes('timed out')) {
        try {
            if (ctx.chat) {
                await ctx.telegram.sendMessage(
                    ctx.chat.id,
                    "⚠️ Hệ thống đang bận..vui lòng chờ 2-5 phút"
                );
            }
        } catch (sendErr) {
            console.error("Không thể gửi tin nhắn báo lỗi timeout:", sendErr);
        }
    }
});


// 🌟 TÍNH NĂNG MỚI: NHẬN LỆNH /c TRONG GROUP ĐỂ CHAT LẠI NỘI DUNG
bot.command('c', async (ctx) => {
    try {
        // 🛡️ KIỂM TRA QUYỀN ADMIN
        const hasPermission = await isAdminOrPrivate(ctx);
        if (!hasPermission) {
            if (ctx.chat?.type !== 'private') {
                try { await ctx.deleteMessage(); } catch (e) { }
            }
            return;
        }

        const messageText = ctx.message.text;

        // 1. Lấy nội dung cần chat phía sau lệnh /c
        const content = messageText.replace(/^\/c(@\w+)?\s*/, '').trim();
        if (!content) {
            try { await ctx.deleteMessage(); } catch (e) { } // Xóa lệnh gõ sai

            const alertMsg = await ctx.reply("/c <Nội dung cần chat> nha ^^");
            setTimeout(async () => {
                try { await ctx.telegram.deleteMessage(ctx.chat.id, alertMsg.message_id); } catch (e) { }
            }, 3000);
            return;
        }

        // 2. Kiểm tra xem người dùng có đang bấm "Reply" ai đó không
        const replyToMessage = ctx.message.reply_to_message;

        // 3. Tiến hành xóa tin nhắn chứa lệnh /c của người dùng trước để group luôn sạch đẹp
        try {
            await ctx.deleteMessage();
        } catch (e) {
            console.log("[Group Error] Bot thiếu quyền Admin (Delete Message) trong nhóm.");
        }

        // 4. Phân luồng xử lý:
        if (replyToMessage) {
            await ctx.reply(content, {
                reply_parameters: { message_id: replyToMessage.message_id }
            });
        } else {
            await ctx.reply(content);
        }

    } catch (error) {
        console.error("Lỗi khi xử lý lệnh /c đa năng bảo mật:", error);
    }
});


bot.launch();
console.log('NyanBot (TypeScript) đang chạy...');

// Mở cổng 3000 để Express lắng nghe Webhook
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Webhook server của SePay đang lắng nghe tại port ${PORT}...`);
});

// Xử lý thoát
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));