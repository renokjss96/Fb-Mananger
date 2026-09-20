# FB Manager

Tool desktop quản lý nhiều nick Facebook: import `uid|pass|2FA|cookie|email|passmail`, login Chrome bằng Selenium (gõ như người), xuất cookie, check live.

## Chạy

```bat
install.bat
start.bat
```

Cần Google Chrome. Chromedriver do Selenium Manager tự tải lần đầu.

## Import

Mỗi nick 1 dòng. Bảng luôn hiện UID | Pass | 2FA | Cookie | Email | Pass mail | Trạng thái.

```
uid|pass|2FA|cookie|email|passmail
```

## Login Chrome (Selenium)

1. Tích nick → **Login Chrome**. Mỗi nick 1 profile Chrome riêng.
2. Mở `/login/` → add cookie → đợi 3–5s → refresh.
3. Cookie fail → gõ uid/pass từng ký tự + delay random → click Login.
4. `login_attempt` → Dead (Sai Pass).
5. `two_factor` → TOTP, gõ mã, bấm tiếp.
6. Checkpoint: 049 dismiss, consent allow cookies; 956/282 ghi **Checkpoint** rồi dừng.

## Cài đặt

- Số luồng Chrome (1–20)
- Chạy ẩn trình duyệt (headless)

Data: `%APPDATA%/fb-manager/fb-manager-data.json`  
Profiles: `%APPDATA%/fb-manager/profiles/<id>`
