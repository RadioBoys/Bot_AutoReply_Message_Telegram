# 🤖 NyanBot - Telegram Store Bot (TypeScript)

NyanBot là một bot Telegram bán sản phẩm số (Album ảnh/Video) tự động được viết bằng TypeScript sử dụng thư viện telegraf. Bot tích hợp hệ thống thanh toán tự động qua cổng SePay Webhook, quản lý số dư ví tích lũy của khách hàng và tự động trả link tải sản phẩm ngay khi thanh toán thành công.

## ✨ Tính năng nổi bật
- 🛒 Xem & Lọc Sản Phẩm Theo Tag: Phân trang sản phẩm mượt mà, hỗ trợ lọc album theo danh mục (Masturbation, BDSM, Squirt, Have Sex, v.v.).

- **💳 Ví Tích Lũy Người Dùng (Wallet System):** Tự động lưu trữ số dư ví của khách hàng qua file users.json.
    - Trừ tiền trực tiếp vào ví khi số dư khả dụng $\ge$ giá trị Album.
    - Lưu trữ lịch sử mua hàng để không bị mua trùng.

- 🔌 Tích hợp Thanh Toán Tự Động (SePay Webhook):
    - Tự động tạo mã QR VietQR kèm nội dung chuyển khoản động dạng định danh duy nhất (NYANXXXXXX).
    - Lắng nghe biến động số dư thông qua cổng Express Webhook.
    - Tự động xử lý cộng dồn số tiền nếu khách hàng chuyển khoản thiếu, nhắc nhở nạp thêm và trả link tức thì khi nạp đủ.

- 🛡️ Quản lý & Bảo mật (Admin Control):
    - Giới hạn quyền tương tác trong các Group (chỉ Admin/Creator mới có quyền kích hoạt Bot hoặc dùng lệnh).
    - Lệnh ẩn /c <nội dung> hỗ trợ Admin ẩn danh chat/reply trong nhóm cực kỳ tiện lợi.
    - Tự động gửi báo cáo mua hàng tích lũy chi tiết về cho Admin thông qua Group Notification riêng biệt.

- **⚙️ Cơ chế chống Crash**: Toàn bộ tiến trình gửi tin nhắn, xóa QR code cũ, hay xóa thông báo nhắc nhở đều được bọc trong các block an toàn, tránh tình trạng sập bot khi người dùng chặn (block) bot.

## 📁 Cấu trúc thư mục dự án
```
├── img
│   ├── Banner.jpg               # Ảnh bìa menu chính của Bot
│   ├── listAlbum/
│   │   └── allAlbum.json               # File database chứa thông tin toàn bộ Album
│   │   └── [các file media album khác]        # image / video từng bộ Album ID
│   └── [các file Banner media khác]    # Ảnh/Video demo cho từng album
├── users.json                   # Database lưu trữ thông tin ví và đơn hàng (tự động tạo)
├── indexBotAlbum.ts             # File mã nguồn chính của Bot
├── package.json
├── tsconfig.json
└── .env                         # File cấu hình môi trường (Không push lên Git)
```
## 🛠️ Yêu cầu hệ thống
- Node.js (Khuyến nghị bản LTS mới nhất)

- NPM hoặc Yarn

- TypeScript & TS-Node để chạy trực tiếp môi trường phát triển.

- Một tài khoản SePay để cấu hình Webhook ngân hàng.

## 🚀 Hướng dẫn cài đặt & Triển khai
### 1. Clone Source Code về máy
```
git clone https://github.com/RadioBoys/Bot_AutoReply_Message_Telegram.git
cd Bot_AutoReply_Message_Telegram
```

### 2. Cài đặt các thư viện phụ thuộc
```
npm install
```

### 3. Cấu hình File Môi Trường (.env)
Tạo một file .env nằm ở thư mục gốc của dự án và điền đầy đủ các thông tin sau:
```
BOT_TOKEN=<CHANGE_YOUR_BOT_TOKEN>       # Token Bot Telegram từ @BotFather
GROUP_NOTI_PAYMENT=-100xxxxxxxxxx                     # ID Group Telegram nhận thông báo hóa đơn mua hàng
# GEMINI_API_KEY=AIzaSy...                            # (Tùy chọn) API Key của Gemini nếu dùng AI sau này
SEPAY_WEBHOOK_API=<YOUR_SEPAY_WEBHOOK_API>
```

### 4. Cấu hình Database Album mẫu (img/listAlbum/allAlbum.json)
Cấu trúc mẫu của một sản phẩm trong database:
```
[
  {
    "id": 1,
    "title": "Album 1",
    "description": "Mô tả ngắn cực kỳ hấp dẫn về sản phẩm...",
    "price": "50k",
    "path": "./img/demo_album_1.jpg",
    "type": "photo",
    "tags": ["Masturbation", "Squirt"],
    "linkAlbum": [
      "Link 1: <ENTER_YOUR_LINK>",
      "Link 2: <ENTER_YOUR_LINK>"
    ]
  }
]
```

## 🛰️ Cấu hình Webhook SePay (Thanh toán tự động)

### 1. Khi khởi chạy, bot sẽ mở một cổng Express tại Port 3000 (mặc định) để lắng nghe Webhook.

### 2. Sử dụng công cụ như Ngrok để tạo một tunnel công khai nếu chạy ở Local:

```
npx ngrok http 3000
```

### 3. Copy đường dẫn https của Ngrok (ví dụ: https://abcd-123.ngrok-free.app) và cấu hình trên trang quản trị SePay:

- Webhook URL: https://abcd-123.ngrok-free.app/webhook/bank

- Phương thức (Method): POST

- Kiểu dữ liệu: JSON

## 🏃‍♂️ Chạy ứng dụng
### Chạy trong môi trường Development (Chạy trực tiếp file TS)
```
npm install -g ts-node
ts-node indexBotAlbum.ts
```
### Biên dịch và chạy Production
```
# Biên dịch TS sang JS
npm run build

# Chạy file JS đã biên dịch
node dist/indexBotAlbum.js
```

## 🕹️ Hướng dẫn sử dụng các Lệnh (Commands)
- /start: Khởi động Bot, hiển thị Banner kèm Menu lựa chọn chính (Chỉ khả dụng trong chat riêng tư hoặc do Admin/Creator gõ trong Group).

- /c <nội dung>: Lệnh gửi tin nhắn ẩn danh dưới danh nghĩa của Bot.
    - Nếu reply một tin nhắn khác: Bot sẽ trả lời (reply) tin nhắn đó.
    - Sau khi gửi thành công, Bot tự động xóa tin nhắn lệnh gốc của Admin để giữ Group sạch đẹp.

## 📝 Giấy phép (License)
**Dự án này được phát triển cho mục đích cá nhân và vận hành Store tự động. Vui lòng không chia sẻ công khai Token Bot và File users.json chứa thông tin nhạy cảm của khách hàng.**