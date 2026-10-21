# LCMS Flashcards

## Mở ứng dụng

1. Đảm bảo Apache đang chạy trong XAMPP.
2. Mở Edge và vào `http://localhost/CDRRRRRRR/flashcards.html`.
3. Ứng dụng tự nạp bộ dữ liệu trong thư mục `lcms-flashcards-2026-10-21T07-39-10Z` (200 câu mỗi đề). Nếu chuyển bộ dữ liệu sang thư mục khác, bấm **Đổi bộ dữ liệu** và chọn thư mục kết quả có `exam-01` cùng `exam-02`.

## Tính năng

- Lọc theo đề, phần thi, trạng thái; tìm theo số câu hoặc từ khóa.
- Giao diện nền tối; lật thẻ bằng nút **Lật thẻ** hoặc phím `Space`; chuyển trước/sau, trộn thứ tự và chế độ tập trung.
- Đánh dấu **Chưa nhớ** hoặc **Đã nhớ**; trạng thái, ghi chú và câu đang ôn được lưu trong bộ nhớ cục bộ. Mở lại hoặc refresh sẽ tiếp tục từ câu đang ôn trên bộ dữ liệu đó.
- Nút **Reset trạng thái** đưa toàn bộ thẻ của bộ dữ liệu hiện tại về **Chưa học**, xóa màu Chưa nhớ/Đã nhớ và giữ lại ghi chú cùng đáp án đã sửa.
- Khi đi tiếp sau thẻ cuối của cả hai đề, hoặc sau câu 200 của đề đang lọc riêng, ứng dụng hiện bảng tổng kết **Đã nhớ / Chưa nhớ / Chưa học** cho phạm vi vừa hoàn thành kèm hiệu ứng pháo hoa.
- Đáp án bạn sửa cũng chỉ lưu trong bộ nhớ cục bộ trên trình duyệt hiện tại; chúng không tự ghi vào `questions.json` hay theo cùng khi deploy sang máy/trình duyệt khác.
- Bấm nút **Play** ở thanh audio phía trên để nghe; thao tác phát/dừng không lật thẻ. Với câu có ảnh, ảnh nằm bên trái và nội dung/đáp án bên phải.
- Với câu nghe Part 1–4, bấm **Show trans** cạnh thanh audio để mở script tiếng Anh và bản dịch tiếng Việt. Cả hai cũng được đưa vào CSV xuất từ các thẻ đang lọc.
- Nhấn đúp vào ảnh để bật hoặc tắt toàn màn hình; nhấn `Esc` để thoát.
- Tải các thẻ đang lọc về CSV.
- Nút **Test IQ** cho chọn phạm vi trước khi làm: cả hai đề (400 câu), riêng đề 1 hoặc riêng đề 2; sau đó rút ngẫu nhiên 15 câu. Câu Part 1 chỉ hiện A/B/C/D, câu Part 2 chỉ hiện A/B/C; cả hai phần đều ẩn nội dung chữ của lựa chọn. Có thể nghe audio/xem hình và chọn đáp án; ảnh phóng to/thu nhỏ bằng cách nhấn đúp. Sau khi nộp, bảng kết quả ghi đáp án từng câu. **Ôn lại** mở đúng 15 thẻ đó, còn **Test lại** rút lượt mới trong cùng phạm vi đề.
- Phím tắt: `Space` / `↑` / `↓` chỉ lật thẻ; `←` đánh dấu **Chưa nhớ** rồi sang thẻ kế tiếp; `→` đánh dấu **Đã nhớ** rồi sang thẻ kế tiếp; `F` bật/tắt chế độ tập trung. Số câu chuyển vàng khi Chưa nhớ và xanh khi Đã nhớ.

Part 5 luôn lưu câu hỏi với chỗ trống `__________` tại vị trí cần điền. Part 6 lưu riêng đoạn văn có chỗ trống (`passageText`) và đáp án đúng (`correctAnswerText`); trình ghi nhận màu xanh trên đáp án của trang gốc để phân biệt đáp án đúng với lựa chọn sai màu đỏ. Mặt trước flashcard hiện đoạn văn có chỗ trống, tô vàng nhạt ô của câu đang ôn, mặt sau hiện đáp án.

Part 1–2 lưu nguyên văn lựa chọn đúng vào `correctAnswerText`; mặt sau hiện cả chữ cái lẫn nội dung lựa chọn.

Để có các trường Part 6 này, chạy lại `node .\extract-lcms-exams.mjs` để tạo thư mục kết quả mới. Không dùng `--resume` cho bộ dữ liệu cũ vì chế độ tiếp tục giữ lại câu đã ghi trước đó, vốn chưa có thông tin màu đáp án. Sau khi trích xuất xong, bấm **Đổi bộ dữ liệu** trong flashcard và chọn thư mục mới có `exam-01` cùng `exam-02`. File `flashcards.csv` mới cũng có các cột đáp án đúng, prompt và passage riêng.

Script tiếng Anh và bản dịch tiếng Việt của câu 1–100 nằm trong `transcript.en` và `transcript.vi` ở `questions.json`, đồng thời có hai cột riêng trong `flashcards.csv`. Bộ trích xuất `node .\extract-lcms-exams.mjs --transcripts .\lcms-flashcards-2026-10-21T07-39-10Z` bổ sung script tiếng Anh mà vẫn giữ bản dịch đã có.

Nguồn bản dịch là `listening-translations-vi.json`. Sau khi thay dữ liệu đề trong thư mục mặc định, chạy `node .\apply-listening-translations.mjs` để gắn lại bản dịch, điền nội dung đáp án Part 1–2 và tạo lại CSV.
