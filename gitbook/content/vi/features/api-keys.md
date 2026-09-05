# API Key & Budget

API key kiểm soát quyền truy cập endpoint 9Router khi bật **Require API key**. Key được băm khi lưu trữ, và mỗi key có thể gắn budget chi tiêu riêng với chế độ chặn cứng tùy chọn.

---

## Bảo mật API Key

- **Băm khi lưu trữ** — key được lưu dạng HMAC-SHA256 dưới một secret riêng theo-install (file `0600` trên máy bạn), không bao giờ plaintext. Key plaintext cũ vẫn dùng được và tự chuyển đổi ngay lần sử dụng đầu tiên.
- **Che mọi nơi** — danh sách và UI chỉ hiển thị `sk-{keyId}-••••{last4}`. Export/backup chứa hash, không bao giờ key gốc.
- **Secret riêng theo-install** — secret dùng để băm key và khóa sudo MITM là ngẫu nhiên cho từng install; không có khóa fallback suy ra từ máy hay hardcode.

> 📦 **Nâng cấp từ phiên bản cũ?** Backup DB trước khi nâng lên bản có băm key (`v0.6.36+`), và nhập lại mật khẩu sudo MITM một lần sau nâng cấp — ciphertext cũ cố tình không giải mã được dưới khóa mới.

---

## Budget từng Key

Mỗi key có thể đặt budget để một agent "điên" hay đồng đội dùng chung không đốt sạch hạn mức của bạn.

```
Dashboard → Endpoint & Key → ✏️ Sửa key → Budget

Loại budget:    USD  |  Token  |  Tắt
Giới hạn:       ví dụ 5 (USD) hoặc 50.000.000 (token)
Cửa sổ:         Hằng ngày  |  Hằng tháng   (giờ máy chủ)
Ngưỡng mềm:     80%   → bắn cảnh báo budget-threshold một lần mỗi cửa sổ
Chặn cứng:      BẬT/TẮT → 429 kèm Retry-After khi chạm giới hạn
```

### Hành vi

| Thời điểm | Điều gì xảy ra |
|---|---|
| Chi < 80% giới hạn | Không có gì — traffic bình thường |
| Chi ≥ ngưỡng mềm (mặc định 80%) | Một cảnh báo `budget-threshold` mỗi cửa sổ (edge-triggered, không spam); header thông tin xuất hiện từ 80% kể cả khi không bật chặn cứng |
| Chi ≥ giới hạn **khi BẬT chặn cứng** | Request bị từ chối với `429`, header `Retry-After` trỏ tới cuối cửa sổ, và `X-9Router-Budget: limit-exceeded` |
| Cửa sổ mới | Budget reset, cảnh báo re-arm |

Chi tiêu được đọc **mới trực tiếp từ lịch sử usage lúc enforce** (query có index) — không dùng cache cũ. Key không có budget cộng thêm đúng 0 query trên hot path.

### Chọn USD hay Token

- **Budget token là chính xác tuyệt đối** — đếm prompt + completion token.
- **Budget USD là ước tính** — tổng cost đã ghi nhận, vốn cần pricing được cấu hình cho model. Model không có pricing góp $0, nên budget USD có thể đếm thiếu; editor sẽ cảnh báo khi chi tiêu của key phần lớn từ model chưa gán giá.

### Điều kiện & lưu ý

- Budget chỉ có hiệu lực khi **Require API key** đang bật (enforce nằm trong đường xác thực key).
- Cửa sổ tính theo **giờ máy chủ**: daily = nửa đêm địa phương, monthly = mùng 1.
- Cảnh báo đi qua hệ thống [Cảnh báo](./alerts.md) — cấu hình kênh để nhận.

---

## Tạo & quản lý Key

```
Dashboard → Endpoint & Key

+ Tạo key   →  sk-... hiển thị MỘT LẦN (copy ngay)
✏️ Sửa      →  đổi tên, budget, bật/tắt
🗑 Xóa      →  thu hồi ngay lập tức
```

Nên một key cho mỗi tool/mỗi người (vd `cursor-laptop`, `cline-desktop`, `dongminh-anh`) để dòng usage và budget phân rõ trách nhiệm.

---

## Liên quan

- [Cảnh báo](./alerts.md) - sự kiện `budget-threshold`
- [Theo dõi hạn mức](./quota-tracking.md) - phân tích usage theo key
