# Aura DCA — Mô tả Submission

*Một agent DCA tự trị, xây trên Arc Network.*

*Encode Club × Circle — Programmable Money Hackathon (build trên Arc)*

Repo: https://github.com/thanhphuc85/ArcDCA
Bằng chứng on-chain: https://testnet.arcscan.app/tx/0x83097f432db9c013b3f8d7748b58f18484c2a5fde4ce500c221ee38524250933

> 🇬🇧 English version: [`SUBMISSION.md`](SUBMISSION.md)

---

## Tagline

Một agent tự trị để Claude dẫn dắt chiến lược, còn **code nắm giữ mọi con số chạm vào tiền** — và gộp lịch của nhiều người dùng thành **một cú swap on-chain duy nhất, quyết toán theo tỉ lệ**. DCA vào cirBTC trên Arc Testnet là bản triển khai tham chiếu; kiến trúc bên dưới mới là đóng góp thật.

## Vấn đề

"Tài chính điều khiển bởi agent" là một trong những chủ đề chính của hackathon, nhưng nó ẩn chứa một mâu thuẫn thật sự: LLM rất giỏi phán đoán theo ngữ cảnh, nhưng bạn *không bao giờ* được để một mô hình ngôn ngữ làm người quyết định cuối cùng về việc chuyển bao nhiêu tiền. Trao toàn quyền cho nó thì chỉ một con số ảo giác cũng có thể vét sạch ví. Tước hết quyền tự chủ thì nó chỉ còn là một cron script rườm rà.

Mâu thuẫn đó gay gắt hơn hẳn khi **tiền không phải của bạn**. Một agent phục vụ **nhiều** người phải vừa an toàn vừa công bằng: lịch của từng người được tôn trọng chính xác, tiền của từng người tách bạch khỏi người khác, và mọi phân bổ đều tái dựng được sau đó — mà vẫn phải thực thi hiệu quả on-chain, chứ không phải mỗi người một giao dịch.

## Chúng tôi đã xây gì

Một agent giải quyết cả hai nửa của bài toán đó, với **DCA là trường hợp cụ thể**:

**1. Claude quyết định chiến lược — code nắm giữ tiền.** Mỗi lần chạy, agent đưa Claude số dư thật, nhịp chi tiêu, ngân sách và lịch sử giao dịch của chính nó, rồi hỏi — qua tool call bắt buộc, validate theo schema — nên làm gì và tại sao. Claude đọc lịch sử của mình, dàn đều chi tiêu, và **từ chối giao dịch** khi nhận ra ngân sách đã hết. Nhưng câu trả lời của nó chỉ là *đề xuất*: hàm thuần `clampDecision()` đã unit-test mới tự tính lại giới hạn thật từ các guardrail cứng (tối đa/ngày, dự trữ tối thiểu, ngưỡng bụi, ngân sách chiến dịch) và là **nơi duy nhất** quyết định con số thực sự được swap. Mỗi lần chạy đều ghi lại *ràng buộc nào* đã chặn kết quả.

> Logo của chúng tôi chính là sự phân tách đó, được vẽ ra: hai quỹ đạo không bao giờ chứa nhau, chỉ gặp nhau tại đúng nơi một quyết định được đưa ra.

**2. Nhiều người dùng, một cú swap, quyết toán công bằng.** Mỗi ví tự đặt tần suất, số tiền và giới hạn riêng. Mỗi lần chạy, agent tính phần đến hạn của từng người, thực thi **tổng dưới dạng một cú swap duy nhất**, rồi phân phối cirBTC nhận về **theo tỉ lệ đóng góp** — nếu guardrail cắt tổng thì mọi phần cùng co lại theo, và phần dư làm tròn được gán tất định để **sổ sách luôn khớp**. Một giao dịch phục vụ tất cả; không ai bù cho ai. ([`schedule.ts`](src/ledger/schedule.ts), đã unit-test.)

**3. Non-custodial ngay từ thiết kế.** Người dùng không bao giờ giao khoá. Mọi thay đổi trạng thái — đặt lịch, chạy ngay, rút tiền — đều được ủy quyền bằng **chữ ký EIP-191** do chính người dùng ký trong ví của mình và server verify trước khi chạm vào ledger. Agent có thể thực thi chiến lược; nó **không bao giờ có thể tự bịa ra sự đồng ý** của người dùng.

**4. Nó ghi nhớ.** Sau mỗi lần chạy Claude viết một reflection vào `data/reflections.json` và có thể truy xuất lại khi ra quyết định — đó chính là cách nó nhận ra outage cirBTC là *cấu trúc* và ngừng đốt phí vào đó.

Bản thân giao dịch swap đi qua SDK **Swap Kit** chính thức của Circle — con đường swap duy nhất được document chính thức và khả dụng ổn định trên Arc Testnet (USDC / EURC / cirBTC). Ví là **Developer-Controlled Wallet** của Circle, nên không có private key thô nào để rò rỉ.

Toàn bộ chạy trên **GitHub Actions cron** — không cần server. Mỗi lần chạy commit kết quả ngược lại `data/history.json` trong repo, tạo ra một nhật ký kiểm toán công khai, chống chỉnh sửa, lớn dần theo thời gian.

### Dashboard — từ bot thành sản phẩm

Trên nền cron tự động, chúng tôi xây thêm một **dashboard** hoàn chỉnh (chạy tại **[arc-dca.vercel.app](https://arc-dca.vercel.app)**), biến agent thành thứ người dùng thật sự dùng được:

![Dashboard Aura DCA](docs/dashboard.png)

- **DCA per-user, non-custodial.** Người dùng kết nối ví (EIP-6963 đa ví) hoặc đăng nhập bằng email, tự đặt **tỉ lệ DCA hàng ngày** của mình; agent gộp lịch của mọi người vào mỗi lần chạy. Mọi thay đổi trạng thái (`đặt rate`, `chạy DCA ngay`, `rút tiền`) đều được ủy quyền bằng **chữ ký ví EIP-191** và verify trong serverless function trên Vercel — người dùng giữ quyền kiểm soát khóa của mình.
- **Agent hội thoại.** Trợ lý Claude (tool calling) trả lời "ngân quỹ còn bao nhiêu?", "giải thích giao dịch gần nhất"… từ dữ liệu on-chain thật; với action nhạy cảm nó chỉ **đề xuất** — người dùng xác nhận và ký trong UI trước khi thực thi.
- **Bộ nhớ vector + reflection.** Sau mỗi lần chạy Claude ghi một reflection vào `data/reflections.json`; dashboard hiển thị "bộ nhớ agent" này cùng bảng **Agent intelligence** (rủi ro / market regime / độ tự tin / pattern alerts) suy ra từ lịch sử chạy.
- **Đa agent.** Một market-analyst chạy Claude Haiku tạo bản tóm tắt thị trường mà agent quyết định chính đưa vào cân nhắc phân bổ.

## Nó có chạy không? — sự thật trần trụi

Bạn sẽ mở [`data/history.json`](data/history.json) và thấy một dãy dài
`error_swap_failed`. Đây là sự thật đó, nói thẳng, trước khi bất cứ phần nào khác
của tài liệu này cố gây ấn tượng với bạn.

**Đường ống thì chạy.** Circle wallet → Swap Kit → Arc Testnet đã thực hiện một
swap thật hôm nay: [`0xe54ee0…e3a3`](https://testnet.arcscan.app/tx/0xe54ee0951bed8c7263075b393af40e78606b88e763ce9dd8b7498d6c6a89e3a3)
(`0.50 USDC → 0.402303 EURC`). Bạn tự tái lập bằng `npm run prove-swap`.

**Thị trường cirBTC thì không.** `USDC → cirBTC` trả về *"No route available"* ở cả
24 lần thử suốt 9 ngày liên tiếp. Đó là **outage thanh khoản của Arc Testnet, không
phải bug của agent** — và `npm run check-routes` cho thấy nó chỉ giới hạn ở cirBTC,
tài sản biến động duy nhất mà Arc có (chain này stablecoin-native tới mức native gas
token cũng là USDC).

**Và agent đã xử lý đúng như ta mong muốn.** Nó nhận ra các lỗi này mang tính *cấu
trúc chứ không thoáng qua*, ghi lại lập luận đó vào [reflections](data/reflections.json)
của chính mình, giảm tần suất thử để ngừng đốt phí, và **ngừng chi tiêu để bảo toàn
vốn** — suốt cả 9 ngày outage, không ai giám sát. Biết **khi nào KHÔNG hành động** mới là nửa
khó của một agent tài chính tự trị, và đây chính là đoạn lịch sử nó bị thử thách thật.

Chúng tôi đã có thể làm demo sáng đèn bằng cách trỏ `TOKEN_OUT` sang EURC. Chúng tôi
không: làm vậy biến một agent tích luỹ BTC thành một lệnh ngoại hối — một demo chạy
được của một sản phẩm khác. Phần [Những gì chúng tôi đã ĐO](#những-gì-chúng-tôi-đã-đo-và-thesis-chúng-tôi-tự-giết)
có toàn bộ dữ liệu, kể cả kết luận của chính chúng tôi đã bị dữ liệu lật ngược.

## Cách hoạt động (luồng)

```
GitHub Actions cron (mỗi giờ — lịch riêng của từng user quyết định giờ này có phải của họ)
  → đọc số dư USDC của ví Circle trên Arc Testnet
  → computeScheduledSpends(): ai đến hạn, mỗi người bao nhiêu, chặn bởi giới hạn riêng
  → Claude quyết định / tư vấn: { proceed, amountUsdc, reasoning }  (forced tool-use, validate zod)
  → clampDecision(): guardrail cứng áp số tiền thật sự
  → Circle Swap Kit: MỘT cú swap USDC → cirBTC cho tổng đã gộp (hoặc dry-run)
  → applyScheduledDistribution(): chia pro-rata lại cho từng user
  → ghi vào data/history.json  →  commit ngược lại repo
```

## Công nghệ

- **TypeScript / Node.js**, chạy trực tiếp bằng `tsx` (không cần build step)
- **Anthropic Claude** (`@anthropic-ai/sdk`) — bộ máy ra quyết định, qua forced tool-use + validate zod
- **Circle Swap Kit** (`@circle-fin/swap-kit`) + **Developer-Controlled Wallets** (`@circle-fin/developer-controlled-wallets`) + Circle Wallets adapter
- **Arc Testnet** (L1 EVM stablecoin-native của Circle; gas trả bằng USDC)
- **GitHub Actions** cho lịch chạy, secrets và nhật ký kiểm toán commit-back
- **Vitest** — 29 unit test cho các đường đi quan trọng về an toàn: guardrail `clampDecision()`, phần quyết toán pro-rata khi gộp lệnh, và phép tính số ngày mà agent dùng để lý luận
- **Vercel** serverless (`api/`) cho các action có ký của dashboard — set-rate, run-DCA, rút tiền, chat, email chào mừng
- **Dashboard một file** (`docs/index.html`) — phát hiện ví EIP-6963, ký EIP-191, song ngữ Anh/Việt, sáng/tối

## Những gì chúng tôi đã ĐO (và thesis chúng tôi tự giết)

Khi route cirBTC chết, nước đi hấp dẫn là xoay thesis sang thứ còn chạy được.
Chúng tôi suýt làm vậy — một agent rebalance ngân quỹ USDC/EURC: cùng engine lịch,
cùng guardrails, và EURC là cặp duy nhất còn quote được.

Nhưng chúng tôi **đo trước**, vì cú cirBTC đã dạy đúng bài học: **chúng tôi đã đặt
cược vào thứ mình chưa bao giờ kiểm chứng.** Nên trước khi đổ vào 2 tuần, chúng tôi
lấy mẫu tỉ giá EURC (`npm run sample-fx`, chỉ đọc).

Nửa giờ đầu trông như án tử — chín lần đọc giống hệt nhau, `1.1451554658` không sai
một lần. Chúng tôi suýt gạch bỏ pivot này là bất khả thi. Rồi chúng tôi **để sampler
chạy tiếp**:

```
03:04 → 03:48   1.1451554658   (đứng im 48 phút)
03:53           1.1426120287   ← −0.2226%
03:58           1.1426120287
```

**Tỉ giá không hề bị ghim — oracle chỉ cập nhật theo bước thô, khoảng mỗi giờ, và
cửa sổ lấy mẫu đầu tiên của chúng tôi rơi trọn vẹn vào bên trong một bước.** Chỉ với
nửa giờ dữ liệu, chúng tôi đã tự tin báo cáo một thị trường đóng băng. Phát hiện thật
không phải "EURC chết", mà là "chúng tôi chưa lấy mẫu đủ lâu để thấy nó thở".

Sự đính chính đó chỉ xảy ra vì chúng tôi **tiếp tục đo sau khi đã tưởng có câu trả
lời** — và đây là phần chúng tôi bảo vệ mạnh nhất. Ba công cụ đo
([`check-routes`](scripts/check-routes.mjs), [`prove-swap`](scripts/prove-swap.mjs),
[`sample-fx`](scripts/sample-fx.mjs)) đều nằm trong repo và tái lập được;
`data/fx-samples.json` là chuỗi dữ liệu thô đứng sau các con số trên.

Những gì các phép đo thật sự xác lập:

| Tài sản | Trạng thái đo được |
|---|---|
| cirBTC | Không thanh khoản — `No route available`, 24/24 lần thử suốt 9 ngày |
| EURC | Sống, và tỉ giá **có di chuyển** — theo bước ~mỗi giờ, biên độ ~0.22% |
| WBTC / WETH / USDT / DAI / … | Không hề được wire cho Arc Testnet |

Vậy là pivot **khả thi thật**. Chúng tôi vẫn không làm — nhưng vì một lý do sống sót
qua cả sự đính chính: **đổi `TOKEN_OUT` sang EURC sẽ biến một agent tích luỹ BTC
thành một lệnh ngoại hối.** Demo sẽ sáng đèn, và nó sẽ là một sản phẩm khác với thứ
người dùng cần. cirBTC là tài sản biến động duy nhất Arc Testnet có, và DCA vào nó
chính là thesis; một cặp stablecoin FX không phải thứ thay thế được, dù nó đang tiện
tay quote được.

Lập trường trung thực: **agent đúng, thị trường cirBTC thì rỗng** — và chúng tôi có
dữ liệu để chỉ ra bên nào là bên nào, kể cả dữ liệu chứng minh kết luận đầu tiên của
chính chúng tôi là sai.

## Điểm nổi bật

- **Thực thi thật, kiểm chứng được** — không phải video demo. Có giao dịch on-chain thật và các CI run xanh mà ai cũng kiểm tra được.
- **Kiến trúc an toàn** — sự phân tách "LLM đề xuất / code quyết định" chính là cốt lõi, được thực thi bằng một hàm thuần đã test cộng cơ chế hai công tắc cho giao dịch thật (`DRY_RUN` + `LIVE_TRADING_ENABLED`).
- **Tự chủ thật sự** — tự host trên CI miễn phí, tự lưu lịch sử qua commit, và biết lý luận dựa trên các lần chạy trước của chính nó.

## Khó khăn đã gặp

- **Cặp cirBTC rơi vào outage thanh khoản** — khó khăn lớn nhất, đã trình bày ở [Nó có chạy không?](#nó-có-chạy-không--sự-thật-trần-trụi) và [Những gì chúng tôi đã ĐO](#những-gì-chúng-tôi-đã-đo-và-thesis-chúng-tôi-tự-giết). Tóm lại: chúng tôi coi đó là bài toán **đo lường** chứ không phải cái cớ, và viết các công cụ để mọi khẳng định ở đây đều kiểm chứng được.
- **Arc Testnet không có "altcoin thật"** — các DEX cộng đồng (ArcSwap/Presto/…) không có địa chỉ contract được xác minh công khai, nên chúng tôi chủ động chuẩn hóa theo Swap Kit chính thức của Circle (USDC↔EURC↔cirBTC) để submission thật sự chạy được.
- **Chính chỉ số của chúng tôi đã nói dối agent.** `dayCount()` trả về `history.length + 1` — tức **số lần chạy** — nhưng nó đi thẳng vào decision context dưới tên `dayCount` và Claude dùng nó để lý luận về nhịp chi tiêu. Với 3 lần chạy/ngày, agent tưởng mình đang ở "ngày 21" sau một tuần, và reflections của nó **thổi phồng độ dài outage lên ~3 lần**; khi cron chuyển sang mỗi giờ thì nó sẽ trôi nhanh gấp 24 lần thời gian thật. Phát hiện khi fact-check chính tài liệu này với `history.json` — con số "20+ ngày" chúng tôi từng viết đến từ phép tính đã hỏng của chính agent. `dayCount` giờ đếm số ngày khác nhau và có test hồi quy. **Một agent lý luận từ con số bị dán nhãn sai thì sai một cách rất tự tin, và output nhìn không có gì hỏng cả** — đó chính là toàn bộ lý lẽ cho việc giữ quyền quyết định tiền trong code đã test, thay vì trong mô hình.
- **Đóng gói SDK của Circle** — yêu cầu Node ≥ 22 và có những đặc thù ESM named-export chỉ lộ ra trên một số phiên bản Node nhất định; đã ghim CI về Node 24 để khớp môi trường đã kiểm chứng.
- **Config chuỗi rỗng trong CI** — biến GitHub Actions chưa set sẽ đến dưới dạng `""`, mà `.default()` của zod không lấp `""`; đã sửa bằng bước tiền xử lý chuyển rỗng thành undefined.

## Hướng phát triển tiếp

- DCA đa tài sản (Claude quyết định tỷ lệ phân bổ) — cần **nhiều hơn một tài sản đáng để DCA vào**. cirBTC là tài sản biến động duy nhất Arc Testnet có và thanh khoản của nó đang mất; EURC thì sống và tỉ giá có di chuyển, nhưng một cặp stablecoin FX không phải đích DCA thứ hai. Mở khoá vào ngày thị trường cirBTC trở lại.
- Bảng P&L / giá vốn trực tiếp — markup dashboard đã sẵn, tự bật khi các swap cirBTC thành công (route USDC→cirBTC trên Arc Testnet đang gặp outage mà agent vẫn lý luận xoay quanh)
- Verify domain gửi email để email chào mừng tới được mọi user, không chỉ hộp thư người vận hành
- Rà soát sẵn sàng cho mainnet khi Arc mainnet ra mắt

> Kể từ submission đầu, chúng tôi phát triển từ một bot cron không giao diện thành sản phẩm dùng được: dashboard per-user non-custodial, trợ lý Claude hội thoại với action xác-nhận-rồi-ký, rút tiền thời gian thực và DCA theo yêu cầu, cùng bộ nhớ vector của chính agent — tất cả vẫn nằm dưới cùng một guardrail "code nắm giữ tiền".

## Thương hiệu & nhãn hiệu

**Aura DCA là dự án độc lập, xây trên Arc Network — không liên kết, không được Circle bảo trợ, và không phải sản phẩm của Circle.**

Đã đối chiếu với [Arc brand guidelines and partner toolkit](https://www.arc.io/brand-guidelines-and-partner-toolkit):
tên sản phẩm và logo là **của riêng Aura** ("Arc" không xuất hiện ở cả hai); Arc chỉ được nhắc
theo đúng nghĩa factual được phép (*built on Arc Network*, *on Arc Testnet*), không bao giờ như
một sự bảo trợ; dùng "Arc Network" ở lần nhắc đầu tiên; và chúng tôi **không** dùng bất kỳ brand
asset nào của Arc/Circle — cách đơn giản nhất để tôn trọng quy định về việc chỉnh sửa hay làm lấn
át mark của họ. Bảng đối chiếu từng điểm nằm ở [README](README.md#brand--trademark).

## Lưu ý an toàn

Chỉ testnet. Token là token faucet không có giá trị. Guardrail được thực thi bằng code, không phải bởi mô hình; giao dịch thật cần bật hai công tắc riêng biệt.
