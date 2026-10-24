'use strict';
// ---------------------------------------------------------------------------
// Smart Table — guest app. API contract (backend v0.2):
//   GET  /api/t/:token                      -> { table:{id,name,state}, check:null|{square_order_id,total_cents,currency,remaining_cents,items[],tenders[]} }
//   POST /api/checks/:squareOrderId/pay     <- { mode, amount_cents, tip_cents, card_nonce, idempotency_key }
//                                           -> { paymentId, remainingCents, checkState, currency, replayed }
//   errors: { error:<message>, code?:<machine code> }   (read `code`, never match on `error`)
// ---------------------------------------------------------------------------

// TODO(card-pilot): serve these (public) identifiers from the backend; location = the Square location of this table.
const SQUARE_APP_ID = 'sandbox-sq0idp-PLACEHOLDER';
const SQUARE_LOCATION_ID = 'LOC-PLACEHOLDER';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
    return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
}

function formatMoney(cents, currency) {
    try { return new Intl.NumberFormat(LOCALES[lang] || 'en-CA', { style: 'currency', currency: currency || 'CAD' }).format(cents / 100); }
    catch { return (cents / 100).toFixed(2) + ' ' + esc(currency || ''); }
}

function getTableToken() {
    const parts = location.pathname.split('/').filter(Boolean);
    const i = parts.indexOf('t');
    if (i === -1 || !parts[i + 1]) return null;
    try { return decodeURIComponent(parts[i + 1]); } catch { return null; }
}
const tableToken = getTableToken();

// ---- i18n (guest page): auto-detect from the phone language + manual switcher.
// Menu item names come from the restaurant's POS and are never translated; all
// Smart Table chrome (bill, split, tip, pay, review, loyalty) is.
const I18N = {
en: { tableWord: "Table", secureNote: "🔒 Secure payment · No app needed · No account needed", orPayWithCard: "or pay with card", payWord: "Pay", payBtn: "Pay {amt}", processing: "Processing payment...", retryPayment: "Retry payment · {amt}", askServer: "Ask your server", askServer2: "Please ask your server.", loadingBill: "Loading your bill...", connecting: "Connecting securely to the restaurant.", invalidLink: "Invalid link", invalidLinkBody: "Please scan the QR code on your table again.", couldNotLoad: "Could not load your bill", couldNotLoadBody: "Retrying… If this continues, please ask your server.", billSoon: "Your bill will appear here soon", billSoonBody: "Your bill will appear here as soon as your order is fired by your server.", hungry: "Hungry?", hungryBody: "Browse the menu and order from your table.", viewMenu: "🍽️ View Menu", menuTab: "🍽️ Menu", billTab: "💳 Pay Your Bill", menuLoading: "Loading menu...", waitMoment: "Please wait a moment.", noMenu: "No menu available", menuTitle: "Menu", menuSub: "Tap + to add items, then send your order directly to the kitchen.", itemsInCart: "{n} items in cart", itemsInCart_1: "1 item in cart", sending: "Sending...", sendOrder: "Send Order →", orderSent: "Order sent to the kitchen ✓", orderDup: "Order already placed ✓", splitPayment: "Split Payment", splitFull: "Full", splitEqual: "Equal", splitCustom: "Custom", splitItems: "Group Pay", addTip: "Add Tip", tipNone: "None", itemizedBill: "Itemized Bill", alreadyPaid: "ALREADY PAID", paymentWord: "Payment", cardWord: "Card", totalBill: "Total Bill", remainingDue: "Remaining Due", fullBody: "Paying the full remaining balance of {amt}.", splitAmong: "Split among {n} people", yourShare: "Your share:", customAmount: "Custom Amount", myItemsHelp: "Tap the items you had — your claim shows on everyone's phone, so nothing gets paid twice. Everyone pays for their own claimed items.", unconfirmedTitle: "Unconfirmed payment", attentionTitle: "Payment needs attention", blockedBody: "Please ask your server before paying again.", unconfirmedBody: "Your last attempt ({amt} + {tip} tip) was not confirmed. Retrying re-sends exactly that payment and cannot charge you twice.", paySuccess: "Payment Successful!", thanksDining: "Thank you for dining with us. Your payment has been processed.", receiptSummary: "Receipt Summary", totalSettled: "Total Settled", printReceipt: "🖨️ Print Receipt", emailReceipt: "✉️ Email Receipt", sendReceipt: "Send Receipt", receiptOptions: "Receipt", printAndEmail: "🖨️✉️ Print + Email", noReceipt: "No receipt, thanks", receiptPrinting: "Sending to the printer…", receiptPrintedOk: "Your receipt is printing at your table ✓", receiptPrintUnavailable: "Printing isn't available at this table right now — your server can print it for you.", receiptAlreadyPrinted: "Your receipt was already sent to this table's printer.", receiptPrintFailed: "Could not reach the printer. Please ask your server.", noReceiptOk: "No receipt — you're all set ✓", howWasIt: "How was it?", thanksExcl: "Thanks! 🎉", gladLoved: "Glad you loved it.", googleReviewHelp: "Glad you loved it — a quick Google review helps us a lot.", leaveGoogleReview: "⭐ Leave a Google Review", thanksFeedback: "Thanks for the feedback", wellWork: "We'll work on it.", commentPlaceholder: "What could be better? (optional)", sendFeedback: "Send Feedback", loyaltyTitle: "Loyalty", rewardUnlocked: "🎉 Reward Unlocked!", showServer: "Show this screen to your server.", moreVisits: "{n} more visits for {reward}", moreVisits_1: "1 more visit for {reward}", joinLoyalty: "Join Loyalty 🎁", loyaltyHelp: "Earn rewards — just your phone number, no account.", phonePlaceholder: "Phone number", countMyVisit: "Count My Visit", joining: "Joining...", validPhone: "Please enter a valid phone number.", validEmail: "Please enter a valid email address.", validAmount: "Please select a valid amount to pay.", paymentReceived: "Payment received ✓ Remaining balance: {amt}", receiptSentTo: "Receipt sent to {email} ✓", declined: "Card declined or could not be charged — you were not charged. Please try another card.", attemptFailed: "That attempt did not go through and you were not charged. Please try again or use another card.", unconfirmed: "We could not confirm whether your payment went through. Tap “Retry payment” — it is safe: the same request is re-sent and you will not be charged twice.", askStaff: "We could not confirm your payment. Please ask your server — do NOT pay again.", billChanged: "Your bill changed since your last payment attempt. If that payment went through you will see it under “Already paid”. Please review the balance before paying again.", cardNumber: "Card number", taken: "Taken", claimedProgress: "{n} of {total} items claimed", paidSoFar: "Paid so far: {amt} of {total}", justClaimed: "Someone at your table just claimed that item.", claimFailed: "Could not update your selection. Please try again." },
fa: { tableWord: "میز", secureNote: "🔒 پرداخت امن · بدون نیاز به اپ · بدون نیاز به حساب", orPayWithCard: "یا با کارت پرداخت کنید", payWord: "پرداخت", payBtn: "پرداخت {amt}", processing: "در حال پردازش پرداخت...", retryPayment: "تلاش دوباره · {amt}", askServer: "از گارسون خود بپرسید", askServer2: "لطفاً از گارسون خود بپرسید.", loadingBill: "در حال بارگذاری صورت‌حساب...", connecting: "در حال اتصال امن به رستوران.", invalidLink: "لینک نامعتبر است", invalidLinkBody: "لطفاً کد QR روی میز خود را دوباره اسکن کنید.", couldNotLoad: "صورت‌حساب بارگذاری نشد", couldNotLoadBody: "در حال تلاش دوباره… اگر ادامه داشت، از گارسون خود بپرسید.", billSoon: "صورت‌حساب شما به‌زودی اینجا نمایش داده می‌شود", billSoonBody: "به محض ثبت سفارش شما توسط گارسون، صورت‌حساب اینجا نمایش داده می‌شود.", hungry: "گرسنه‌اید؟", hungryBody: "منو را ببینید و از سر میز خود سفارش دهید.", viewMenu: "🍽️ مشاهده منو", menuTab: "🍽️ منو", billTab: "💳 پرداخت صورت‌حساب", menuLoading: "در حال بارگذاری منو...", waitMoment: "لطفاً چند لحظه صبر کنید.", noMenu: "منو در دسترس نیست", menuTitle: "منو", menuSub: "برای افزودن، + را بزنید و سفارش خود را مستقیم به آشپزخانه بفرستید.", itemsInCart: "{n} قلم در سبد", itemsInCart_1: "۱ قلم در سبد", sending: "در حال ارسال...", sendOrder: "ارسال سفارش", orderSent: "سفارش به آشپزخانه ارسال شد ✓", orderDup: "سفارش قبلاً ثبت شده ✓", splitPayment: "تقسیم پرداخت", splitFull: "کامل", splitEqual: "مساوی", splitCustom: "دلخواه", splitItems: "پرداخت گروهی", addTip: "افزودن انعام", tipNone: "هیچ‌کدام", itemizedBill: "صورت‌حساب جزئی", alreadyPaid: "پرداخت‌شده‌ها", paymentWord: "پرداخت", cardWord: "کارت", totalBill: "جمع صورت‌حساب", remainingDue: "مبلغ باقی‌مانده", fullBody: "پرداخت کامل مبلغ باقی‌مانده: {amt}", splitAmong: "تقسیم بین {n} نفر", yourShare: "سهم شما:", customAmount: "مبلغ دلخواه", myItemsHelp: "آیتم‌هایی را که داشتید انتخاب کنید — انتخاب شما روی گوشی همه سر میز نشان داده می‌شود تا چیزی دوبار پرداخت نشود. هر نفر آیتم‌های خودش را پرداخت می‌کند.", unconfirmedTitle: "پرداخت تأییدنشده", attentionTitle: "پرداخت نیاز به بررسی دارد", blockedBody: "قبل از پرداخت دوباره، از گارسون خود بپرسید.", unconfirmedBody: "تلاش قبلی شما ({amt} + {tip} انعام) تأیید نشد. تلاش دوباره دقیقاً همان پرداخت را می‌فرستد و دوبار از شما کم نمی‌شود.", paySuccess: "پرداخت موفق بود!", thanksDining: "ممنون که پیش ما بودید. پرداخت شما انجام شد.", receiptSummary: "خلاصه رسید", totalSettled: "جمع تسویه‌شده", printReceipt: "🖨️ چاپ رسید", emailReceipt: "✉️ ایمیل رسید", sendReceipt: "ارسال رسید", receiptOptions: "رسید", printAndEmail: "🖨️✉️ چاپ + ایمیل", noReceipt: "رسید نمی‌خواهم", receiptPrinting: "در حال ارسال به چاپگر…", receiptPrintedOk: "رسیدتان سر میز در حال چاپ است ✓", receiptPrintUnavailable: "الان چاپگر این میز در دسترس نیست — گارسون می‌تواند رسید را برایتان چاپ کند.", receiptAlreadyPrinted: "رسیدتان قبلاً به چاپگر این میز فرستاده شده است.", receiptPrintFailed: "نشد به چاپگر برسیم. لطفاً از گارسون بپرسید.", noReceiptOk: "بدون رسید — همه‌چیز انجام شد ✓", howWasIt: "چطور بود؟", thanksExcl: "ممنون! 🎉", gladLoved: "خوشحالیم که راضی بودید.", googleReviewHelp: "خوشحالیم که راضی بودید — یک نظر کوتاه در گوگل خیلی به ما کمک می‌کند.", leaveGoogleReview: "⭐ ثبت نظر در گوگل", thanksFeedback: "ممنون از بازخوردتان", wellWork: "حتماً بهترش می‌کنیم.", commentPlaceholder: "چه چیزی می‌توانست بهتر باشد؟ (اختیاری)", sendFeedback: "ارسال بازخورد", loyaltyTitle: "باشگاه مشتریان", rewardUnlocked: "🎉 جایزه‌تان فعال شد!", showServer: "این صفحه را به گارسون نشان دهید.", moreVisits: "{n} بازدید دیگر تا {reward}", moreVisits_1: "۱ بازدید دیگر تا {reward}", joinLoyalty: "عضویت در باشگاه مشتریان 🎁", loyaltyHelp: "جایزه بگیرید — فقط شماره تلفن، بدون ساخت حساب.", phonePlaceholder: "شماره تلفن", countMyVisit: "ثبت بازدید من", joining: "در حال عضویت...", validPhone: "لطفاً یک شماره تلفن معتبر وارد کنید.", validEmail: "لطفاً یک ایمیل معتبر وارد کنید.", validAmount: "لطفاً یک مبلغ معتبر برای پرداخت انتخاب کنید.", paymentReceived: "پرداخت دریافت شد ✓ مانده: {amt}", receiptSentTo: "رسید به {email} ارسال شد ✓", declined: "کارت رد شد یا نتوانستیم از آن برداشت کنیم — از شما کم نشده است. لطفاً کارت دیگری امتحان کنید.", attemptFailed: "آن تلاش انجام نشد و از شما کم نشده است. لطفاً دوباره تلاش کنید یا کارت دیگری استفاده کنید.", unconfirmed: "نتوانستیم تأیید کنیم پرداخت شما انجام شده یا نه. روی «تلاش دوباره» بزنید — امن است: همان درخواست دوباره فرستاده می‌شود و دوبار از شما کم نمی‌شود.", askStaff: "نتوانستیم پرداخت شما را تأیید کنیم. لطفاً از گارسون بپرسید — دوباره پرداخت نکنید.", billChanged: "صورت‌حساب شما از آخرین تلاش پرداخت‌تان تغییر کرده است. اگر آن پرداخت انجام شده باشد، زیر «پرداخت‌شده‌ها» می‌بینیدش. لطفاً قبل از پرداخت دوباره، مانده را بررسی کنید.", cardNumber: "شماره کارت", taken: "گرفته شده", claimedProgress: "{n} از {total} آیتم انتخاب شده", paidSoFar: "پرداخت‌شده تا حالا: {amt} از {total}", justClaimed: "یکی سر میزتان همین الان این آیتم را انتخاب کرد.", claimFailed: "انتخابتان به‌روز نشد. لطفاً دوباره تلاش کنید." },
zh: { tableWord: "餐桌", secureNote: "🔒 安全支付 · 无需应用 · 无需账户", orPayWithCard: "或使用银行卡支付", payWord: "支付", payBtn: "支付 {amt}", processing: "正在处理付款...", retryPayment: "重试付款 · {amt}", askServer: "请询问您的服务员", askServer2: "请询问您的服务员。", loadingBill: "正在加载您的账单...", connecting: "正在安全连接到餐厅。", invalidLink: "链接无效", invalidLinkBody: "请重新扫描您桌上的二维码。", couldNotLoad: "无法加载您的账单", couldNotLoadBody: "正在重试…如果持续出现，请询问您的服务员。", billSoon: "您的账单很快会显示在这里", billSoonBody: "服务员下单后，您的账单会立即显示在这里。", hungry: "饿了吗？", hungryBody: "浏览菜单，直接在餐桌旁点餐。", viewMenu: "🍽️ 查看菜单", menuTab: "🍽️ 菜单", billTab: "💳 支付账单", menuLoading: "正在加载菜单...", waitMoment: "请稍等片刻。", noMenu: "暂无菜单", menuTitle: "菜单", menuSub: "点击 + 添加菜品，然后将订单直接发送到厨房。", itemsInCart: "购物车中有 {n} 件", itemsInCart_1: "购物车中有 1 件", sending: "正在发送...", sendOrder: "发送订单", orderSent: "订单已发送到厨房 ✓", orderDup: "订单已下 ✓", splitPayment: "分开付款", splitFull: "全额", splitEqual: "均分", splitCustom: "自定义", splitItems: "分组付款", addTip: "添加小费", tipNone: "无", itemizedBill: "详细账单", alreadyPaid: "已支付", paymentWord: "付款", cardWord: "银行卡", totalBill: "账单总额", remainingDue: "待付金额", fullBody: "支付全部剩余金额 {amt}。", splitAmong: "由 {n} 人分摊", yourShare: "您的份额：", customAmount: "自定义金额", myItemsHelp: "点击您点的菜品——您的选择会显示在桌上每个人的手机上，避免重复付款。每个人支付自己选的菜品。", unconfirmedTitle: "未确认的付款", attentionTitle: "付款需要处理", blockedBody: "请在再次付款前询问您的服务员。", unconfirmedBody: "您上次的付款（{amt} + 小费 {tip}）未得到确认。重试将重新发送同一笔付款，不会重复收费。", paySuccess: "付款成功！", thanksDining: "感谢您的光临。您的付款已处理。", receiptSummary: "收据摘要", totalSettled: "已结总额", printReceipt: "🖨️ 打印收据", emailReceipt: "✉️ 邮件发送收据", sendReceipt: "发送收据", receiptOptions: "收据", printAndEmail: "🖨️✉️ 打印 + 邮件", noReceipt: "不需要收据", receiptPrinting: "正在发送到打印机…", receiptPrintedOk: "您的收据正在餐桌旁打印 ✓", receiptPrintUnavailable: "此桌目前无法打印——服务员可为您打印。", receiptAlreadyPrinted: "您的收据已发送到此桌的打印机。", receiptPrintFailed: "无法连接到打印机。请询问您的服务员。", noReceiptOk: "不需要收据——一切就绪 ✓", howWasIt: "体验如何？", thanksExcl: "谢谢！🎉", gladLoved: "很高兴您喜欢。", googleReviewHelp: "很高兴您喜欢——在 Google 上留下简短评价对我们帮助很大。", leaveGoogleReview: "⭐ 在 Google 上评价", thanksFeedback: "感谢您的反馈", wellWork: "我们会改进的。", commentPlaceholder: "哪些方面可以改进？（可选）", sendFeedback: "发送反馈", loyaltyTitle: "会员奖励", rewardUnlocked: "🎉 奖励已解锁！", showServer: "请将此屏幕展示给您的服务员。", moreVisits: "再来 {n} 次即可获得 {reward}", moreVisits_1: "再来 1 次即可获得 {reward}", joinLoyalty: "加入会员奖励 🎁", loyaltyHelp: "赢取奖励——只需手机号码，无需账户。", phonePlaceholder: "电话号码", countMyVisit: "记录我的到访", joining: "正在加入...", validPhone: "请输入有效的电话号码。", validEmail: "请输入有效的电子邮箱。", validAmount: "请选择有效的付款金额。", paymentReceived: "已收到付款 ✓ 剩余金额：{amt}", receiptSentTo: "收据已发送至 {email} ✓", declined: "银行卡被拒绝或无法扣款——您未被收费。请换一张卡重试。", attemptFailed: "该次尝试未成功，您未被收费。请重试或使用另一张卡。", unconfirmed: "我们无法确认您的付款是否成功。请点击“重试付款”——这是安全的：系统会重新发送同一请求，不会重复收费。", askStaff: "我们无法确认您的付款。请询问您的服务员——不要再次付款。", billChanged: "您的账单自上次付款尝试后已发生变化。如果那笔付款已成功，您会在“已支付”下看到它。请在再次付款前核对余额。", cardNumber: "卡号", taken: "已被选", claimedProgress: "已选 {n} / {total} 件", paidSoFar: "已支付：{total} 中的 {amt}", justClaimed: "您桌上的另一位刚刚选了这道菜。", claimFailed: "无法更新您的选择。请重试。" },
hi: { tableWord: "टेबल", secureNote: "🔒 सुरक्षित भुगतान · ऐप की ज़रूरत नहीं · खाते की ज़रूरत नहीं", orPayWithCard: "या कार्ड से भुगतान करें", payWord: "भुगतान करें", payBtn: "{amt} का भुगतान करें", processing: "भुगताना संसाधित हो रहा है...", retryPayment: "फिर से प्रयास करें · {amt}", askServer: "अपने सर्वर से पूछें", askServer2: "कृपया अपने सर्वर से पूछें।", loadingBill: "आपका बिल लोड हो रहा है...", connecting: "रेस्तरां से सुरक्षित रूप से जुड़ रहे हैं।", invalidLink: "अमान्य लिंक", invalidLinkBody: "कृपया अपनी टेबल पर लगा QR कोड फिर से स्कैन करें।", couldNotLoad: "आपका बिल लोड नहीं हो सका", couldNotLoadBody: "फिर से कोशिश कर रहे हैं… अगर यह जारी रहे तो अपने सर्वर से पूछें।", billSoon: "आपका बिल जल्द ही यहाँ दिखाई देगा", billSoonBody: "जैसे ही सर्वर आपका ऑर्डर भेजेगा, बिल यहाँ दिखेगा।", hungry: "भूख लगी है?", hungryBody: "मेनू देखें और अपनी टेबल से ही ऑर्डर करें।", viewMenu: "🍽️ मेनू देखें", menuTab: "🍽️ मेनू", billTab: "💳 बिल चुकाएं", menuLoading: "मेनू लोड हो रहा है...", waitMoment: "कृपया कुछ देर प्रतीक्षा करें।", noMenu: "मेनू उपलब्ध नहीं है", menuTitle: "मेनू", menuSub: "+ दबाकर आइटम जोड़ें, फिर ऑर्डर सीधे रसोई में भेजें।", itemsInCart: "कार्ट में {n} आइटम", itemsInCart_1: "कार्ट में 1 आइटम", sending: "भेज रहे हैं...", sendOrder: "ऑर्डर भेजें", orderSent: "ऑर्डर रसोई में भेज दिया गया ✓", orderDup: "ऑर्डर पहले से दिया गया है ✓", splitPayment: "भुगतान बाँटें", splitFull: "पूरा", splitEqual: "बराबर", splitCustom: "कस्टम", splitItems: "ग्रुप पेमेंट", addTip: "टिप जोड़ें", tipNone: "कोई नहीं", itemizedBill: "विस्तृत बिल", alreadyPaid: "पहले से भुगतान किया गया", paymentWord: "भुगतान", cardWord: "कार्ड", totalBill: "कुल बिल", remainingDue: "शेष राशि", fullBody: "पूरी शेष राशि {amt} का भुगतान कर रहे हैं।", splitAmong: "{n} लोगों में बाँटें", yourShare: "आपका हिस्सा:", customAmount: "कस्टम राशि", myItemsHelp: "आपने जो खाया, उसे चुनें — आपकी पसंद टेबल पर सबके फ़ोन पर दिखेगी, ताकि कोई चीज़ दो बार न चुकाई जाए। हर कोई अपने चुने आइटम का भुगतान करता है।", unconfirmedTitle: "अपुष्ट भुगतान", attentionTitle: "भुगतान पर ध्यान देना ज़रूरी है", blockedBody: "फिर से भुगतान करने से पहले अपने सर्वर से पूछें।", unconfirmedBody: "आपका पिछला प्रयास ({amt} + {tip} टिप) पक्का नहीं हुआ। फिर से प्रयास करने पर वही भुगतान दोबारा भेजा जाएगा और आपसे दो बार पैसे नहीं कटेंगे।", paySuccess: "भुगतान सफल!", thanksDining: "हमारे यहाँ भोजन करने के लिए धन्यवाद। आपका भुगतान हो गया है।", receiptSummary: "रसीद सारांश", totalSettled: "कुल निपटान", printReceipt: "🖨️ रसीद प्रिंट करें", emailReceipt: "✉️ रसीद ईमेल करें", sendReceipt: "रसीद भेजें", receiptOptions: "रसीद", printAndEmail: "🖨️✉️ प्रिंट + ईमेल", noReceipt: "रसीद नहीं चाहिए", receiptPrinting: "प्रिंटर को भेज रहे हैं…", receiptPrintedOk: "आपकी रसीद आपकी टेबल पर प्रिंट हो रही है ✓", receiptPrintUnavailable: "इस टेबल पर अभी प्रिंट उपलब्ध नहीं है — आपका सर्वर प्रिंट कर देगा।", receiptAlreadyPrinted: "आपकी रसीद पहले ही इस टेबल के प्रिंटर पर भेज दी गई है।", receiptPrintFailed: "प्रिंटर तक नहीं पहुँच सके। कृपया अपने सर्वर से पूछें।", noReceiptOk: "रसीद नहीं — सब हो गया ✓", howWasIt: "कैसा रहा?", thanksExcl: "धन्यवाद! 🎉", gladLoved: "खुशी है कि आपको पसंद आया।", googleReviewHelp: "खुशी है कि आपको पसंद आया — Google पर एक छोटी समीक्षा हमारी बहुत मदद करती है।", leaveGoogleReview: "⭐ Google पर समीक्षा दें", thanksFeedback: "आपकी प्रतिक्रिया के लिए धन्यवाद", wellWork: "हम इस पर काम करेंगे।", commentPlaceholder: "क्या बेहतर हो सकता था? (वैकल्पिक)", sendFeedback: "प्रतिक्रिया भेजें", loyaltyTitle: "लॉयल्टी", rewardUnlocked: "🎉 इनाम अनलॉक हो गया!", showServer: "यह स्क्रीन अपने सर्वर को दिखाएं।", moreVisits: "{reward} के लिए {n} और विज़िट", moreVisits_1: "{reward} के लिए 1 और विज़िट", joinLoyalty: "लॉयल्टी से जुड़ें 🎁", loyaltyHelp: "इनाम पाएं — सिर्फ़ आपका फ़ोन नंबर, कोई खाता नहीं।", phonePlaceholder: "फ़ोन नंबर", countMyVisit: "मेरी विज़िट गिनें", joining: "जुड़ रहे हैं...", validPhone: "कृपया मान्य फ़ोन नंबर डालें।", validEmail: "कृपया मान्य ईमेल पता डालें।", validAmount: "कृपया भुगतान के लिए मान्य राशि चुनें।", paymentReceived: "भुगतान मिल गया ✓ शेष राशि: {amt}", receiptSentTo: "रसीद {email} पर भेज दी गई ✓", declined: "कार्ड अस्वीकार हुआ या चार्ज नहीं हो सका — आपसे पैसे नहीं कटे। कृपया दूसरा कार्ड आज़माएं।", attemptFailed: "वह प्रयास सफल नहीं हुआ और आपसे पैसे नहीं कटे। कृपया फिर से प्रयास करें या दूसरा कार्ड उपयोग करें।", unconfirmed: "हम पुष्टि नहीं कर सके कि आपका भुगतान हुआ या नहीं। “फिर से प्रयास करें” दबाएं — यह सुरक्षित है: वही अनुरोध दोबारा भेजा जाएगा और आपसे दो बार पैसे नहीं कटेंगे।", askStaff: "हम आपके भुगतान की पुष्टि नहीं कर सके। कृपया अपने सर्वर से पूछें — दोबारा भुगतान न करें।", billChanged: "आपके पिछले भुगतान प्रयास के बाद बिल बदल गया है। अगर वह भुगतान हो गया होगा तो वह “पहले से भुगतान किया गया” के नीचे दिखेगा। दोबारा भुगतान से पहले शेष राशि जांच लें।", cardNumber: "कार्ड नंबर", taken: "लिया गया", claimedProgress: "{total} में से {n} आइटम चुने गए", paidSoFar: "अब तक भुगतान: {total} में से {amt}", justClaimed: "आपकी टेबल पर किसी ने अभी-अभी यह आइटम चुन लिया।", claimFailed: "आपकी पसंद अपडेट नहीं हो सकी। कृपया फिर से प्रयास करें।" },
pa: { tableWord: "ਮੇਜ਼", secureNote: "🔒 ਸੁਰੱਖਿਅਤ ਭੁਗਤਾਨ · ਐਪ ਦੀ ਲੋੜ ਨਹੀਂ · ਖਾਤੇ ਦੀ ਲੋੜ ਨਹੀਂ", orPayWithCard: "ਜਾਂ ਕਾਰਡ ਨਾਲ ਭੁਗਤਾਨ ਕਰੋ", payWord: "ਭੁਗਤਾਨ ਕਰੋ", payBtn: "{amt} ਦਾ ਭੁਗਤਾਨ ਕਰੋ", processing: "ਭੁਗਤਾਨ ਦੀ ਪ੍ਰਕਿਰਿਆ ਚੱਲ ਰਹੀ ਹੈ...", retryPayment: "ਮੁੜ ਕੋਸ਼ਿਸ਼ ਕਰੋ · {amt}", askServer: "ਆਪਣੇ ਸਰਵਰ ਨੂੰ ਪੁੱਛੋ", askServer2: "ਕਿਰਪਾ ਕਰਕੇ ਆਪਣੇ ਸਰਵਰ ਨੂੰ ਪੁੱਛੋ।", loadingBill: "ਤੁਹਾਡਾ ਬਿੱਲ ਲੋਡ ਹੋ ਰਿਹਾ ਹੈ...", connecting: "ਰੈਸਟੋਰੈਂਟ ਨਾਲ ਸੁਰੱਖਿਅਤ ਢੰਗ ਨਾਲ ਜੁੜ ਰਹੇ ਹਾਂ।", invalidLink: "ਅਵੈਧ ਲਿੰਕ", invalidLinkBody: "ਕਿਰਪਾ ਕਰਕੇ ਆਪਣੀ ਮੇਜ਼ 'ਤੇ ਲੱਗਾ QR ਕੋਡ ਮੁੜ ਸਕੈਨ ਕਰੋ।", couldNotLoad: "ਤੁਹਾਡਾ ਬਿੱਲ ਲੋਡ ਨਹੀਂ ਹੋ ਸਕਿਆ", couldNotLoadBody: "ਮੁੜ ਕੋਸ਼ਿਸ਼ ਕਰ ਰਹੇ ਹਾਂ… ਜੇ ਇਹ ਜਾਰੀ ਰਹੇ ਤਾਂ ਆਪਣੇ ਸਰਵਰ ਨੂੰ ਪੁੱਛੋ।", billSoon: "ਤੁਹਾਡਾ ਬਿੱਲ ਜਲਦੀ ਹੀ ਇੱਥੇ ਦਿਖਾਈ ਦੇਵੇਗਾ", billSoonBody: "ਜਿਵੇਂ ਹੀ ਸਰਵਰ ਤੁਹਾਡਾ ਆਰਡਰ ਭੇਜੇਗਾ, ਬਿੱਲ ਇੱਥੇ ਦਿਖੇਗਾ।", hungry: "ਭੁੱਖ ਲੱਗੀ ਹੈ?", hungryBody: "ਮੇਨੂ ਵੇਖੋ ਅਤੇ ਆਪਣੀ ਮੇਜ਼ ਤੋਂ ਹੀ ਆਰਡਰ ਕਰੋ।", viewMenu: "🍽️ ਮੇਨੂ ਵੇਖੋ", menuTab: "🍽️ ਮੇਨੂ", billTab: "💳 ਬਿੱਲ ਭਰੋ", menuLoading: "ਮੇਨੂ ਲੋਡ ਹੋ ਰਿਹਾ ਹੈ...", waitMoment: "ਕਿਰਪਾ ਕਰਕੇ ਥੋੜ੍ਹੀ ਦੇਰ ਉਡੀਕ ਕਰੋ।", noMenu: "ਮੇਨੂ ਉਪਲਬਧ ਨਹੀਂ ਹੈ", menuTitle: "ਮੇਨੂ", menuSub: "+ ਦਬਾ ਕੇ ਆਈਟਮਾਂ ਜੋੜੋ, ਫਿਰ ਆਰਡਰ ਸਿੱਧਾ ਰਸੋਈ ਵਿੱਚ ਭੇਜੋ।", itemsInCart: "ਕਾਰਟ ਵਿੱਚ {n} ਆਈਟਮਾਂ", itemsInCart_1: "ਕਾਰਟ ਵਿੱਚ 1 ਆਈਟਮ", sending: "ਭੇਜ ਰਹੇ ਹਾਂ...", sendOrder: "ਆਰਡਰ ਭੇਜੋ", orderSent: "ਆਰਡਰ ਰਸੋਈ ਵਿੱਚ ਭੇਜ ਦਿੱਤਾ ਗਿਆ ✓", orderDup: "ਆਰਡਰ ਪਹਿਲਾਂ ਹੀ ਦਿੱਤਾ ਗਿਆ ਹੈ ✓", splitPayment: "ਭੁਗਤਾਨ ਵੰਡੋ", splitFull: "ਪੂਰਾ", splitEqual: "ਬਰਾਬਰ", splitCustom: "ਕਸਟਮ", splitItems: "ਗਰੁੱਪ ਭੁਗਤਾਨ", addTip: "ਟਿੱਪ ਜੋੜੋ", tipNone: "ਕੋਈ ਨਹੀਂ", itemizedBill: "ਵਿਸਤ੍ਰਿਤ ਬਿੱਲ", alreadyPaid: "ਪਹਿਲਾਂ ਹੀ ਭੁਗਤਾਨ ਕੀਤਾ", paymentWord: "ਭੁਗਤਾਨ", cardWord: "ਕਾਰਡ", totalBill: "ਕੁੱਲ ਬਿੱਲ", remainingDue: "ਬਾਕੀ ਰਕਮ", fullBody: "ਪੂਰੀ ਬਾਕੀ ਰਕਮ {amt} ਦਾ ਭੁਗਤਾਨ ਕਰ ਰਹੇ ਹੋ।", splitAmong: "{n} ਲੋਕਾਂ ਵਿੱਚ ਵੰਡੋ", yourShare: "ਤੁਹਾਡਾ ਹਿੱਸਾ:", customAmount: "ਕਸਟਮ ਰਕਮ", myItemsHelp: "ਜੋ ਤੁਸੀਂ ਖਾਧਾ, ਉਹ ਚੁਣੋ — ਤੁਹਾਡੀ ਚੋਣ ਮੇਜ਼ 'ਤੇ ਸਭ ਦੇ ਫ਼ੋਨ 'ਤੇ ਦਿਖੇਗੀ, ਤਾਂ ਜੋ ਕੁਝ ਵੀ ਦੋ ਵਾਰ ਨਾ ਚੁਕਾਇਆ ਜਾਵੇ। ਹਰ ਕੋਈ ਆਪਣੀਆਂ ਚੁਣੀਆਂ ਆਈਟਮਾਂ ਦਾ ਭੁਗਤਾਨ ਕਰਦਾ ਹੈ।", unconfirmedTitle: "ਅਪੁਸ਼ਟ ਭੁਗਤਾਨ", attentionTitle: "ਭੁਗਤਾਨ 'ਤੇ ਧਿਆਨ ਦੇਣਾ ਜ਼ਰੂਰੀ ਹੈ", blockedBody: "ਮੁੜ ਭੁਗਤਾਨ ਕਰਨ ਤੋਂ ਪਹਿਲਾਂ ਆਪਣੇ ਸਰਵਰ ਨੂੰ ਪੁੱਛੋ।", unconfirmedBody: "ਤੁਹਾਡੀ ਪਿਛਲੀ ਕੋਸ਼ਿਸ਼ ({amt} + {tip} ਟਿੱਪ) ਪੱਕੀ ਨਹੀਂ ਹੋਈ। ਮੁੜ ਕੋਸ਼ਿਸ਼ ਕਰਨ 'ਤੇ ਉਹੀ ਭੁਗਤਾਨ ਮੁੜ ਭੇਜਿਆ ਜਾਵੇਗਾ ਅਤੇ ਤੁਹਾਡੇ ਤੋਂ ਦੋ ਵਾਰ ਪੈਸੇ ਨਹੀਂ ਕੱਟੇ ਜਾਣਗੇ।", paySuccess: "ਭੁਗਤਾਨ ਸਫਲ!", thanksDining: "ਸਾਡੇ ਇੱਥੇ ਖਾਣਾ ਖਾਣ ਲਈ ਧੰਨਵਾਦ। ਤੁਹਾਡਾ ਭੁਗਤਾਨ ਹੋ ਗਿਆ ਹੈ।", receiptSummary: "ਰਸੀਦ ਸਾਰ", totalSettled: "ਕੁੱਲ ਨਿਪਟਾਰਾ", printReceipt: "🖨️ ਰਸੀਦ ਪ੍ਰਿੰਟ ਕਰੋ", emailReceipt: "✉️ ਰਸੀਦ ਈਮੇਲ ਕਰੋ", sendReceipt: "ਰਸੀਦ ਭੇਜੋ", receiptOptions: "ਰਸੀਦ", printAndEmail: "🖨️✉️ ਪ੍ਰਿੰਟ + ਈਮੇਲ", noReceipt: "ਰਸੀਦ ਨਹੀਂ ਚਾਹੀਦੀ", receiptPrinting: "ਪ੍ਰਿੰਟਰ ਨੂੰ ਭੇਜ ਰਹੇ ਹਾਂ…", receiptPrintedOk: "ਤੁਹਾਡੀ ਰਸੀਦ ਤੁਹਾਡੀ ਮੇਜ਼ 'ਤੇ ਪ੍ਰਿੰਟ ਹੋ ਰਹੀ ਹੈ ✓", receiptPrintUnavailable: "ਇਸ ਮੇਜ਼ 'ਤੇ ਹੁਣ ਪ੍ਰਿੰਟ ਉਪਲਬਧ ਨਹੀਂ — ਤੁਹਾਡਾ ਸਰਵਰ ਪ੍ਰਿੰਟ ਕਰ ਦੇਵੇਗਾ।", receiptAlreadyPrinted: "ਤੁਹਾਡੀ ਰਸੀਦ ਪਹਿਲਾਂ ਹੀ ਇਸ ਮੇਜ਼ ਦੇ ਪ੍ਰਿੰਟਰ 'ਤੇ ਭੇਜੀ ਜਾ ਚੁੱਕੀ ਹੈ।", receiptPrintFailed: "ਪ੍ਰਿੰਟਰ ਤੱਕ ਨਹੀਂ ਪਹੁੰਚ ਸਕੇ। ਕਿਰਪਾ ਕਰਕੇ ਆਪਣੇ ਸਰਵਰ ਨੂੰ ਪੁੱਛੋ।", noReceiptOk: "ਰਸੀਦ ਨਹੀਂ — ਸਭ ਹੋ ਗਿਆ ✓", howWasIt: "ਕਿਵੇਂ ਰਿਹਾ?", thanksExcl: "ਧੰਨਵਾਦ! 🎉", gladLoved: "ਖੁਸ਼ੀ ਹੈ ਕਿ ਤੁਹਾਨੂੰ ਪਸੰਦ ਆਇਆ।", googleReviewHelp: "ਖੁਸ਼ੀ ਹੈ ਕਿ ਤੁਹਾਨੂੰ ਪਸੰਦ ਆਇਆ — Google 'ਤੇ ਛੋਟੀ ਸਮੀਖਿਆ ਸਾਡੀ ਬਹੁਤ ਮਦਦ ਕਰਦੀ ਹੈ।", leaveGoogleReview: "⭐ Google 'ਤੇ ਸਮੀਖਿਆ ਦਿਓ", thanksFeedback: "ਤੁਹਾਡੀ ਪ੍ਰਤੀਕਿਰਿਆ ਲਈ ਧੰਨਵਾਦ", wellWork: "ਅਸੀਂ ਇਸ 'ਤੇ ਕੰਮ ਕਰਾਂਗੇ।", commentPlaceholder: "ਕੀ ਬਿਹਤਰ ਹੋ ਸਕਦਾ ਸੀ? (ਵਿਕਲਪਿਕ)", sendFeedback: "ਪ੍ਰਤੀਕਿਰਿਆ ਭੇਜੋ", loyaltyTitle: "ਲਾਇਲਟੀ", rewardUnlocked: "🎉 ਇਨਾਮ ਅਨਲੌਕ ਹੋ ਗਿਆ!", showServer: "ਇਹ ਸਕਰੀਨ ਆਪਣੇ ਸਰਵਰ ਨੂੰ ਵਿਖਾਓ।", moreVisits: "{reward} ਲਈ ਹੋਰ {n} ਵਿਜ਼ਿਟ", moreVisits_1: "{reward} ਲਈ ਹੋਰ 1 ਵਿਜ਼ਿਟ", joinLoyalty: "ਲਾਇਲਟੀ ਵਿੱਚ ਸ਼ਾਮਲ ਹੋਵੋ 🎁", loyaltyHelp: "ਇਨਾਮ ਪਾਓ — ਸਿਰਫ਼ ਤੁਹਾਡਾ ਫ਼ੋਨ ਨੰਬਰ, ਕੋਈ ਖਾਤਾ ਨਹੀਂ।", phonePlaceholder: "ਫ਼ੋਨ ਨੰਬਰ", countMyVisit: "ਮੇਰੀ ਵਿਜ਼ਿਟ ਗਿਣੋ", joining: "ਸ਼ਾਮਲ ਹੋ ਰਹੇ ਹਾਂ...", validPhone: "ਕਿਰਪਾ ਕਰਕੇ ਸਹੀ ਫ਼ੋਨ ਨੰਬਰ ਦਰਜ ਕਰੋ।", validEmail: "ਕਿਰਪਾ ਕਰਕੇ ਸਹੀ ਈਮੇਲ ਪਤਾ ਦਰਜ ਕਰੋ।", validAmount: "ਕਿਰਪਾ ਕਰਕੇ ਭੁਗਤਾਨ ਲਈ ਸਹੀ ਰਕਮ ਚੁਣੋ।", paymentReceived: "ਭੁਗਤਾਨ ਮਿਲ ਗਿਆ ✓ ਬਾਕੀ ਰਕਮ: {amt}", receiptSentTo: "ਰਸੀਦ {email} 'ਤੇ ਭੇਜ ਦਿੱਤੀ ਗਈ ✓", declined: "ਕਾਰਡ ਅਸਵੀਕਾਰ ਹੋਇਆ ਜਾਂ ਚਾਰਜ ਨਹੀਂ ਹੋ ਸਕਿਆ — ਤੁਹਾਡੇ ਤੋਂ ਪੈਸੇ ਨਹੀਂ ਕੱਟੇ। ਕਿਰਪਾ ਕਰਕੇ ਹੋਰ ਕਾਰਡ ਅਜ਼ਮਾਓ।", attemptFailed: "ਉਹ ਕੋਸ਼ਿਸ਼ ਸਫਲ ਨਹੀਂ ਹੋਈ ਅਤੇ ਤੁਹਾਡੇ ਤੋਂ ਪੈਸੇ ਨਹੀਂ ਕੱਟੇ। ਕਿਰਪਾ ਕਰਕੇ ਮੁੜ ਕੋਸ਼ਿਸ਼ ਕਰੋ ਜਾਂ ਹੋਰ ਕਾਰਡ ਵਰਤੋ।", unconfirmed: "ਅਸੀਂ ਪੁਸ਼ਟੀ ਨਹੀਂ ਕਰ ਸਕੇ ਕਿ ਤੁਹਾਡਾ ਭੁਗਤਾਨ ਹੋਇਆ ਜਾਂ ਨਹੀਂ। “ਮੁੜ ਕੋਸ਼ਿਸ਼ ਕਰੋ” ਦਬਾਓ — ਇਹ ਸੁਰੱਖਿਅਤ ਹੈ: ਉਹੀ ਬੇਨਤੀ ਮੁੜ ਭੇਜੀ ਜਾਵੇਗੀ ਅਤੇ ਤੁਹਾਡੇ ਤੋਂ ਦੋ ਵਾਰ ਪੈਸੇ ਨਹੀਂ ਕੱਟੇ ਜਾਣਗੇ।", askStaff: "ਅਸੀਂ ਤੁਹਾਡੇ ਭੁਗਤਾਨ ਦੀ ਪੁਸ਼ਟੀ ਨਹੀਂ ਕਰ ਸਕੇ। ਕਿਰਪਾ ਕਰਕੇ ਆਪਣੇ ਸਰਵਰ ਨੂੰ ਪੁੱਛੋ — ਮੁੜ ਭੁਗਤਾਨ ਨਾ ਕਰੋ।", billChanged: "ਤੁਹਾਡੀ ਪਿਛਲੀ ਭੁਗਤਾਨ ਕੋਸ਼ਿਸ਼ ਤੋਂ ਬਾਅਦ ਬਿੱਲ ਬਦਲ ਗਿਆ ਹੈ। ਜੇ ਉਹ ਭੁਗਤਾਨ ਹੋ ਗਿਆ ਹੋਵੇਗਾ ਤਾਂ ਉਹ “ਪਹਿਲਾਂ ਹੀ ਭੁਗਤਾਨ ਕੀਤਾ” ਹੇਠ ਦਿਖੇਗਾ। ਮੁੜ ਭੁਗਤਾਨ ਤੋਂ ਪਹਿਲਾਂ ਬਾਕੀ ਰਕਮ ਵੇਖ ਲਓ।", cardNumber: "ਕਾਰਡ ਨੰਬਰ", taken: "ਲਿਆ ਗਿਆ", claimedProgress: "{total} ਵਿੱਚੋਂ {n} ਆਈਟਮਾਂ ਚੁਣੀਆਂ ਗਈਆਂ", paidSoFar: "ਹੁਣ ਤੱਕ ਭੁਗਤਾਨ: {total} ਵਿੱਚੋਂ {amt}", justClaimed: "ਤੁਹਾਡੀ ਮੇਜ਼ 'ਤੇ ਕਿਸੇ ਨੇ ਹੁਣੇ ਇਹ ਆਈਟਮ ਚੁਣ ਲਈ ਹੈ।", claimFailed: "ਤੁਹਾਡੀ ਚੋਣ ਅਪਡੇਟ ਨਹੀਂ ਹੋ ਸਕੀ। ਕਿਰਪਾ ਕਰਕੇ ਮੁੜ ਕੋਸ਼ਿਸ਼ ਕਰੋ।" }
};
const LOCALES = { en: 'en-CA', fa: 'fa-IR', zh: 'zh-CN', hi: 'hi-IN', pa: 'pa-IN' };
function detectLang() {
    try { const saved = localStorage.getItem('st_lang'); if (saved && I18N[saved]) return saved; } catch { /* ignore */ }
    const nav = (navigator.language || 'en').toLowerCase();
    for (const code of Object.keys(I18N)) if (nav === code || nav.startsWith(code + '-')) return code;
    return 'en';
}
let lang = detectLang();
function t(key, vars) {
    let k = key;
    if (vars && vars.n === 1 && ((I18N[lang] && I18N[lang][key + '_1']) || I18N.en[key + '_1'])) k = key + '_1';
    let s = (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k;
    if (vars) for (const [name, val] of Object.entries(vars)) s = s.split('{' + name + '}').join(String(val));
    return s;
}
function applyLang() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
    const sel = $('lang-select'); if (sel) sel.value = lang;
    const tb = document.querySelector('.trust-badge'); if (tb) tb.textContent = t('secureNote');
    const wd = document.querySelector('.wallet-divider span'); if (wd) wd.textContent = t('orPayWithCard');
}
applyLang();
const langSelEl = $('lang-select');
if (langSelEl) langSelEl.addEventListener('change', (e) => { lang = e.target.value; try { localStorage.setItem('st_lang', lang); } catch { /* ignore */ } applyLang(); render(true); });

// ---- Group Pay (idea 2): per-device identity + item claims ------------------
// Each phone gets a stable random device id. Claiming an item (in Group Pay
// mode) is stored server-side and shows as taken on every other phone at the
// table, so the same dish is never paid twice.
let deviceId = null;
try {
    deviceId = localStorage.getItem('st_device');
    if (!deviceId) { deviceId = uuid(); localStorage.setItem('st_device', deviceId); }
} catch { if (!deviceId) deviceId = uuid(); }
let claimsByIdx = {};        // item_index -> claim row (from the latest bill poll)
const itemFp = (it) => `${it.name}|${it.quantity}|${it.amount_cents}`;
const claimAt = (idx) => {
    const c = claimsByIdx[idx];
    if (!c || !check || !check.items[idx]) return null;
    return c.item_fingerprint === itemFp(check.items[idx]) ? c : null;
};

// ---- state ----------------------------------------------------------------
let table = null;
let check = null;
let receipt = null;          // sticky success snapshot
let receiptChoice = null;    // null | 'print' | 'email' | 'both' | 'none' — guest picks on the success screen
let receiptPrintState = null; // null | 'printing' | 'done' | 'unavailable' | 'already' | 'failed'
let receiptEmailDone = false;
let loadFailed = false;
let mode = 'full', people = 2, customCents = 0, items = {}, tipPct = 15;
let paying = false;
let notice = null;           // { text, kind: 'err' | 'ok' }
let lastRenderKey = '';
let renderDeferred = false;
// QR ordering state
let orderingEnabled = false;
let view = 'bill';           // 'bill' | 'menu'
let menuItems = [];
let menuLoaded = false;
let cart = {};               // menuItemId -> quantity
let ordering = false;
// Review + loyalty state
let loyaltyEnabled = false;
let rated = 0;               // 0 = not rated yet
let ratingDone = false;
let ratingResult = null;     // { google_review_url } after submit
let loyaltyPhone = '';
let loyaltyResult = null;    // progress after submit
let loyaltySubmitting = false;

const setNotice = (text, kind = 'err') => { notice = text ? { text, kind } : null; };

// ---- payment attempts (idempotency) ----------------------------------------
// ONE attempt = one idempotency key + frozen {mode, amount, tip}. It is persisted (localStorage, with an in-memory
// fallback) so a reload — or closing and reopening the tab — cannot lose an unconfirmed attempt. The key is rotated ONLY after the server confirmed that
// nothing was charged (400, 402, 409 payment_failed|payment_cancelled) or after success. It is NEVER rotated on a
// network error, timeout, 5xx, 429, unparseable response, or 409 idempotency_key_reused / payment_state_unknown /
// payment_needs_reconciliation: those may have charged the card.
const memAttempts = new Map();
const attemptStoreKey = (orderId) => 'st_attempt_' + orderId;
// H-5: the attempt lives in localStorage (with a 2h TTL), not
// sessionStorage — closing the tab used to destroy the only copy of the
// idempotency key, so a guest whose first charge actually went through
// could reopen the page and pay again under a fresh key. Entries older
// than the TTL are dropped on read (a bill is never open that long
// without staff involvement, and staff can reconcile by hand past it).
const ATTEMPT_TTL_MS = 2 * 60 * 60 * 1000;
function loadAttempt(orderId) {
    let a = memAttempts.get(orderId) || null;
    if (!a) {
        try { a = JSON.parse(localStorage.getItem(attemptStoreKey(orderId)) || 'null'); } catch { a = null; }
    }
    if (!a) {
        // Legacy entries written by <= v0.6.9 live in sessionStorage.
        try { a = JSON.parse(sessionStorage.getItem(attemptStoreKey(orderId)) || 'null'); } catch { a = null; }
    }
    if (a && a.savedAt && Date.now() - a.savedAt > ATTEMPT_TTL_MS) { clearAttempt(orderId); return null; }
    return a && typeof a.key === 'string' ? a : null;
}
function saveAttempt(a) {
    a.savedAt = Date.now();
    memAttempts.set(a.orderId, a);
    try { localStorage.setItem(attemptStoreKey(a.orderId), JSON.stringify(a)); } catch { /* private mode: memory copy only */ }
}
function clearAttempt(orderId) {
    memAttempts.delete(orderId);
    try { localStorage.removeItem(attemptStoreKey(orderId)); } catch { /* ignore */ }
    try { sessionStorage.removeItem(attemptStoreKey(orderId)); } catch { /* ignore */ }
}
const currentAttempt = () => (check ? loadAttempt(check.square_order_id) : null);

// If the bill moved since the unconfirmed attempt, the attempt may have gone through (or someone else paid):
// drop it and make the guest look at "Already paid" before paying again.
function reconcileAttempt() {
    const a = currentAttempt();
    if (a && check && check.remaining_cents !== a.remainingBefore) {
        clearAttempt(a.orderId);
        setNotice(t('billChanged'), 'err');
    }
}

// ---- amounts ----------------------------------------------------------------
function payCents() {
    if (!check) return 0;
    const r = check.remaining_cents;
    if (mode === 'full') return r;
    if (mode === 'equal') return Math.min(r, Math.ceil(r / people));
    if (mode === 'custom') return Math.min(r, Math.max(0, customCents));
    // My Items: sum of checked items (each phone = one person).
    let sum = 0;
    check.items.forEach((it, idx) => { if (items[idx]) sum += it.amount_cents; });
    return Math.min(r, sum);
}
const tipCentsFor = (pay) => (tipPct === 0 ? 0 : Math.round(pay * (tipPct / 100)));

// ---- card token (per-POS provider SDK) --------------------------------------
// The backend tells us which card provider this location uses:
//   GET /api/checks/:ref/card-config -> { provider, publishableKey, extra }
// Then we tokenize with that provider's browser flow. Card data never touches
// our server: Square/Clover tokenize directly with the processor, Helcim uses
// its hosted modal (HelcimPay.js).
let cardConfigCache = {};
async function getCardConfig(checkRef) {
    if (!cardConfigCache[checkRef]) {
        const res = await fetch(`/api/checks/${encodeURIComponent(checkRef)}/card-config?table_token=${encodeURIComponent(tableToken)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Card payments are not available at this location.');
        cardConfigCache[checkRef] = data;
    }
    return cardConfigCache[checkRef];
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) return resolve();
        const s = document.createElement('script');
        s.src = src; s.async = true;
        s.onload = resolve; s.onerror = () => reject(new Error('Could not load payment library.'));
        document.head.appendChild(s);
    });
}

// Square: Web Payments SDK. One payments instance is shared by the card
// iframe and the wallet buttons (Apple Pay / Google Pay).
let squarePayments = null;
let squarePaymentsKey = '';
async function getSquarePayments(cfg) {
    const env = cfg.extra?.environment === 'production' ? '' : 'sandbox.';
    await loadScript(`https://${env}web.squarecdn.com/v1/square.js`);
    if (!window.Square) throw new Error('Square payments library failed to load.');
    const key = `${cfg.publishableKey}|${cfg.extra?.locationId || ''}`;
    if (!squarePayments || squarePaymentsKey !== key) {
        squarePayments = window.Square.payments(cfg.publishableKey, cfg.extra.locationId);
        squarePaymentsKey = key;
        squareCard = null; // card iframe belongs to the previous instance
    }
    return squarePayments;
}

let squareCard = null;
async function squareTokenize(cfg) {
    const payments = await getSquarePayments(cfg);
    if (!squareCard) {
        squareCard = await payments.card();
        await squareCard.attach('#card-container');
    }
    const r = await squareCard.tokenize();
    if (r.status !== 'OK') throw new Error(r.errors?.[0]?.message || 'Please check your card details.');
    return r.token; // "cnon:..."
}

// ---- wallets (Apple Pay / Google Pay, Square locations only) -----------------
// The wallet sheet charges the SAME frozen amount as the card flow (current
// split + tip, or the stored attempt on a retry). Tokenize returns a Square
// cnon: token, which the pay endpoint already accepts; payment_method tells
// the backend (and staff) how the guest paid. Availability is decided by the
// SDK at attach() time: Apple Pay needs Safari + a Wallet card + the domain
// registered with Square; Google Pay needs a supported browser/device. When
// neither attaches, the area stays hidden and card payment is unaffected.
let walletState = { key: '', apple: null, google: null, busy: false };

function effectiveTotalCents() {
    const a = currentAttempt();
    if (a) return a.amount + a.tip;
    const p = payCents();
    return p + tipCentsFor(p);
}

async function setupWallets() {
    const area = $('wallet-area');
    if (!area) return;
    if (!check || receipt || check.remaining_cents <= 0) { area.style.display = 'none'; return; }
    const a = currentAttempt();
    if (a && a.blocked) { area.style.display = 'none'; return; }
    const total = effectiveTotalCents();
    const key = `${check.square_order_id}|${total}|${check.currency || 'CAD'}`;
    if (walletState.key === key || walletState.busy) return;
    walletState.busy = true;
    try {
        const cfg = await getCardConfig(check.square_order_id);
        if (cfg.provider !== 'square') { walletState.key = key; area.style.display = 'none'; return; }
        const payments = await getSquarePayments(cfg);
        for (const kind of ['apple', 'google']) {
            if (walletState[kind]) { try { await walletState[kind].destroy(); } catch { /* ignore */ } walletState[kind] = null; }
        }
        $('apple-pay-button').innerHTML = '';
        $('google-pay-button').innerHTML = '';
        const paymentRequest = payments.paymentRequest({
            countryCode: 'CA',
            currencyCode: check.currency || 'CAD',
            total: { amount: (total / 100).toFixed(2), label: 'Total' },
        });
        let shown = 0;
        try {
            walletState.apple = await payments.applePay(paymentRequest);
            await walletState.apple.attach('#apple-pay-button');
            shown++;
        } catch { walletState.apple = null; $('apple-pay-button').innerHTML = ''; }
        try {
            walletState.google = await payments.googlePay(paymentRequest);
            await walletState.google.attach('#google-pay-button');
            shown++;
        } catch { walletState.google = null; $('google-pay-button').innerHTML = ''; }
        area.style.display = shown > 0 ? 'flex' : 'none';
        walletState.key = key;
    } catch {
        // SDK failed to load etc.: stay on card-only; a total change retries.
        walletState.key = key;
        area.style.display = 'none';
    } finally {
        walletState.busy = false;
    }
}

async function walletTokenize(kind) {
    const w = kind === 'apple' ? walletState.apple : walletState.google;
    if (!w) throw new Error('That payment option is not available on this device.');
    const r = await w.tokenize();
    if (r.status !== 'OK') throw new Error(r.errors?.[0]?.message || 'Payment was not completed.');
    return r.token; // "cnon:..."
}

// Clover: card details go DIRECTLY from the browser to Clover's token endpoint
// (apikey = Ecommerce public token). Our server never sees the PAN.
function cloverCardForm() {
    return new Promise((resolve, reject) => {
        const c = $('card-container');
        c.innerHTML = `
            <div style="display:grid;gap:8px">
                <input id="cc-num" inputmode="numeric" placeholder="${t('cardNumber')}" autocomplete="cc-number"
                    style="padding:10px;border:1px solid var(--border);border-radius:8px;font-size:16px">
                <div style="display:flex;gap:8px">
                    <input id="cc-exp" placeholder="MM / YY" autocomplete="cc-exp"
                        style="flex:1;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:16px">
                    <input id="cc-cvv" inputmode="numeric" placeholder="CVV" autocomplete="cc-csc"
                        style="flex:1;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:16px">
                </div>
                <button id="cc-tokenize" class="btn-primary">${t('payWord')}</button>
            </div>`;
        $('cc-tokenize').onclick = () => {
            const num = $('cc-num').value.replace(/\D/g, '');
            const exp = $('cc-exp').value.replace(/\D/g, '');
            const cvv = $('cc-cvv').value.replace(/\D/g, '');
            if (num.length < 13 || exp.length !== 4 || cvv.length < 3) {
                reject(new Error('Please check your card details.')); return;
            }
            resolve({
                number: num,
                exp_month: exp.slice(0, 2),
                exp_year: '20' + exp.slice(2),
                cvv,
            });
        };
    });
}
async function cloverTokenize(cfg) {
    const card = await cloverCardForm();
    const res = await fetch(`${cfg.extra.tokenHost}/v1/tokens`, {
        method: 'POST',
        headers: { 'apikey': cfg.publishableKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ card }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.id) throw new Error(data.message || 'Card could not be tokenized. Please try again.');
    return data.id; // "clv_..."
}

// Helcim: hosted modal (HelcimPay.js). The checkoutToken comes from our backend
// (it initialized the session). The modal returns a cardToken.
async function helcimTokenize(cfg) {
    await loadScript(cfg.extra.helcimPayJs);
    return new Promise((resolve, reject) => {
        try {
            // H-6: only accept messages from the HelcimPay iframe's own
            // origin (derived from the script URL our server handed us).
            // Without this, any frame/window could post a forged SUCCESS
            // message carrying an attacker-chosen card token.
            let expectedOrigin = '';
            try { expectedOrigin = new URL(cfg.extra.helcimPayJs).origin; } catch { expectedOrigin = 'https://secure.helcim.app'; }
            const onMsg = (ev) => {
                if (ev.origin !== expectedOrigin) return;
                let msg = null;
                try { msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; } catch { return; }
                if (!msg || msg.eventName !== `helcim-pay-js-${cfg.publishableKey}`) return;
                window.removeEventListener('message', onMsg);
                if (msg.eventStatus === 'SUCCESS' && msg.eventMessage) {
                    try {
                        const payload = JSON.parse(msg.eventMessage);
                        // verify mode returns the cardToken in data.cardToken
                        const token = payload?.data?.cardToken || payload?.cardToken;
                        if (token) return resolve(token);
                    } catch { /* fall through */ }
                }
                reject(new Error(msg.eventStatus === 'ABORTED' ? 'Payment cancelled.' : 'Card could not be processed.'));
            };
            window.addEventListener('message', onMsg);
            window.appendHelcimPayIframe(cfg.publishableKey);
        } catch (e) { reject(new Error('Could not start the payment form.')); }
    });
}

async function getCardToken(checkRef) {
    const cfg = await getCardConfig(checkRef);
    if (cfg.provider === 'square') return squareTokenize(cfg);
    if (cfg.provider === 'clover') return cloverTokenize(cfg);
    if (cfg.provider === 'helcim') return helcimTokenize(cfg);
    throw new Error('Card payments are not available at this location.');
}

// ---- data -------------------------------------------------------------------
async function fetchBill() {
    if (receipt || !tableToken) return;
    try {
        const res = await fetch(`/api/t/${encodeURIComponent(tableToken)}?device_id=${encodeURIComponent(deviceId)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Failed to load table info');
        table = data.table; check = data.check; loadFailed = false;
        claimsByIdx = {};
        if (check && Array.isArray(check.item_claims)) {
            for (const c of check.item_claims) claimsByIdx[c.item_index] = c;
        }
        // My selection mirrors my server-side claims (Group Pay).
        items = {};
        if (check) check.items.forEach((it, idx) => { const c = claimAt(idx); if (c && c.mine) items[idx] = true; });
        orderingEnabled = !!data.ordering_enabled;
        loyaltyEnabled = !!data.loyalty_enabled;
        reconcileAttempt();
    } catch (err) {
        if (!table) loadFailed = true; // keep showing the last good bill on transient errors
    }
    render();
}

// ---- Review capture (one tap, no login) ---------------------------------------
async function submitRating(stars, comment = null) {
    rated = stars;
    try {
        const res = await fetch(`/api/t/${encodeURIComponent(tableToken)}/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rating: stars, comment }),
        });
        const data = await res.json().catch(() => ({}));
        ratingResult = { google_review_url: data.google_review_url || null };
    } catch { ratingResult = { google_review_url: null }; }
    ratingDone = true;
    render(true);
}

function renderRating() {
    if (ratingDone) {
        if (rated >= 4 && ratingResult?.google_review_url) {
            return `<div class="card" style="text-align:center;">
                <h2>${t('thanksExcl')}</h2>
                <p style="font-size:0.9rem;color:var(--text-muted);margin-bottom:12px;">${t('googleReviewHelp')}</p>
                <a href="${esc(ratingResult.google_review_url)}" target="_blank" rel="noopener" class="btn-primary" style="text-decoration:none;">${t('leaveGoogleReview')}</a>
            </div>`;
        }
        if (rated >= 4) {
            return `<div class="card" style="text-align:center;"><h2>${t('thanksExcl')}</h2><p style="font-size:0.9rem;color:var(--text-muted);">${t('gladLoved')}</p></div>`;
        }
        return `<div class="card" style="text-align:center;"><h2>${t('thanksFeedback')}</h2><p style="font-size:0.9rem;color:var(--text-muted);">${t('wellWork')}</p></div>`;
    }
    return `<div class="card" style="text-align:center;">
        <h2>${t('howWasIt')}</h2>
        <div class="star-rating" style="font-size:2.2rem;">
            ${[1, 2, 3, 4, 5].map((s) => `<span data-action="rate" data-v="${s}" style="cursor:pointer;${s <= rated ? '' : 'opacity:0.35;'}">⭐</span>`).join('')}
        </div>
        ${rated > 0 && rated < 4 ? `<textarea id="rating-comment" placeholder="${t('commentPlaceholder')}" style="margin-top:8px;"></textarea>
        <button class="btn-primary" data-action="rate-submit" style="margin-top:8px;">${t('sendFeedback')}</button>` : ''}
    </div>`;
}

// ---- Loyalty (phone only, no login) --------------------------------------------
async function submitLoyalty() {
    const phone = loyaltyPhone.replace(/\D/g, '');
    if (phone.length < 7 || phone.length > 15) { setNotice(t('validPhone')); render(true); return; }
    loyaltySubmitting = true; setNotice(null); render(true);
    try {
        const res = await fetch(`/api/t/${encodeURIComponent(tableToken)}/loyalty`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not join.');
        loyaltyResult = data;
    } catch (err) {
        setNotice(err.message || 'Could not join. Please try again.');
    } finally {
        loyaltySubmitting = false; render(true);
    }
}

function renderLoyalty() {
    if (!loyaltyEnabled) return '';
    if (loyaltyResult) {
        const r = loyaltyResult;
        if (r.reward_earned) {
            return `<div class="card" style="text-align:center;border:2px solid var(--gold);">
                <h2>${t('rewardUnlocked')}</h2>
                <p style="font-size:1.1rem;font-weight:700;">${esc(r.reward_text)}</p>
                <p style="font-size:0.85rem;color:var(--text-muted);">${t('showServer')}</p>
            </div>`;
        }
        return `<div class="card" style="text-align:center;">
            <h2>${t('loyaltyTitle')}</h2>
            <p style="font-size:0.9rem;color:var(--text-muted);">${t('moreVisits', { n: r.visits_remaining, reward: esc(r.reward_text) })}</p>
            <div style="background:var(--border);border-radius:8px;height:8px;margin-top:8px;overflow:hidden;">
                <div style="background:var(--gold);height:100%;width:${Math.round((r.visits / r.visits_required) * 100)}%;"></div>
            </div>
        </div>`;
    }
    return `<div class="card" style="text-align:center;">
        <h2>${t('joinLoyalty')}</h2>
        <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:10px;">${t('loyaltyHelp')}</p>
        <input id="loyalty-phone" type="tel" inputmode="tel" placeholder="${t('phonePlaceholder')}"
            value="${esc(loyaltyPhone)}"
            style="width:100%;padding:12px;border:1px solid var(--border);border-radius:10px;font-size:1rem;margin-bottom:10px;">
        <button class="btn-primary" data-action="loyalty" ${loyaltySubmitting ? 'disabled' : ''}>${loyaltySubmitting ? t('joining') : t('countMyVisit')}</button>
    </div>`;
}

// ---- QR ordering ------------------------------------------------------------
async function loadMenu() {
    if (menuLoaded || !tableToken) return;
    try {
        const res = await fetch(`/api/t/${encodeURIComponent(tableToken)}/menu`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not load menu');
        menuItems = data.items || [];
        menuLoaded = true;
    } catch (err) {
        setNotice(err.message || 'Could not load menu.');
    }
    render(true);
}

function cartCount() { return Object.values(cart).reduce((a, b) => a + b, 0); }
function cartTotal() {
    const byId = Object.fromEntries(menuItems.map((m) => [m.id, m]));
    return Object.entries(cart).reduce((sum, [id, qty]) => sum + (byId[id]?.priceCents || 0) * qty, 0);
}
function menuCurrency() { return menuItems[0]?.currency || check?.currency || 'CAD'; }

async function submitOrder() {
    if (ordering || cartCount() === 0) return;
    ordering = true; setNotice(null); render(true);
    // H3 fix: keep one idempotency key per cart in sessionStorage until the
    // server confirms. A retry after a timeout reuses the key, so the kitchen
    // never gets a duplicate order.
    const cartKey = 'st_order_key_' + tableToken;
    let orderKey = sessionStorage.getItem(cartKey);
    if (!orderKey) {
        orderKey = uuid();
        sessionStorage.setItem(cartKey, orderKey);
    }
    try {
        const res = await fetch(`/api/t/${encodeURIComponent(tableToken)}/order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: Object.entries(cart).map(([id, quantity]) => ({ menu_item_id: id, quantity })),
                idempotency_key: orderKey,
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            // 409 "already being processed": keep the key, let the guest retry.
            // Any other error: drop the key so a fresh attempt gets a new one.
            if (res.status !== 409) sessionStorage.removeItem(cartKey);
            throw new Error(data.error || 'Order could not be placed.');
        }
        sessionStorage.removeItem(cartKey);
        cart = {}; menuLoaded = false;
        check = data.check;
        view = 'bill';
        setNotice(data.duplicate ? t('orderDup') : t('orderSent'), 'ok');
    } catch (err) {
        setNotice(err.message || 'Order could not be placed. Please try again.');
    } finally {
        ordering = false; render(true);
    }
}

function renderMenu() {
    if (!menuLoaded) {
        return `<div class="empty-state"><h3>${t('menuLoading')}</h3><p>${t('waitMoment')}</p></div>`;
    }
    if (!menuItems.length) {
        return `<div class="empty-state"><h3>${t('noMenu')}</h3><p>${t('askServer2')}</p></div>`;
    }
    const itemsHtml = menuItems.map((m) => {
        const qty = cart[m.id] || 0;
        return `<div class="menu-item-card">
            <div class="menu-item-info">
                <div class="menu-item-title">${esc(m.name)}</div>
                ${m.description ? `<div class="menu-item-desc">${esc(m.description)}</div>` : ''}
                <div class="menu-item-price tabular">${formatMoney(m.priceCents, m.currency)}</div>
            </div>
            <div class="menu-stepper">
                <button data-action="cart" data-v="${esc(m.id)}|-1" aria-label="Decrease quantity">−</button>
                <span class="tabular">${qty}</span>
                <button data-action="cart" data-v="${esc(m.id)}|1" aria-label="Increase quantity">+</button>
            </div>
        </div>`;
    }).join('');
    const total = cartTotal();
    const count = cartCount();
    return `
        ${noticeHtml()}
        <div class="menu-header">
            <h2>${t('menuTitle')}</h2>
            <p>${t('menuSub')}</p>
        </div>
        ${itemsHtml}
        ${count > 0 ? `
            <div class="cart-sticky-bar">
                <div class="cart-sticky-info">
                    <span class="cart-sticky-count">${t('itemsInCart', { n: count })}</span>
                    <span class="cart-sticky-total tabular">${formatMoney(total, menuCurrency())}</span>
                </div>
                <button class="cart-sticky-btn" data-action="order" ${ordering ? 'disabled' : ''}>
                    ${ordering ? t('sending') : t('sendOrder')}
                </button>
            </div>
        ` : ''}`;
}

function renderViewTabs() {
    if (!orderingEnabled) return '';
    return `<div class="split-tabs" style="margin-bottom:12px;">
        <button class="split-tab ${view === 'menu' ? 'active' : ''}" data-action="view" data-v="menu">${t('menuTab')}</button>
        <button class="split-tab ${view === 'bill' ? 'active' : ''}" data-action="view" data-v="bill">${t('billTab')}</button>
    </div>`;
}


// ---- pay ---------------------------------------------------------------------
const UNCONFIRMED = () => t('unconfirmed');
const ASK_STAFF = () => t('askStaff');

async function processPayment(tokenGetter, methodLabel) {
    if (paying || !check || receipt) return;
    const orderId = check.square_order_id;
    let a = loadAttempt(orderId);
    if (a && a.blocked) return;

    const base = a ? { mode: a.mode, amount: a.amount, tip: a.tip } : (() => { const p = payCents(); return { mode, amount: p, tip: tipCentsFor(p) }; })();
    if (!Number.isInteger(base.amount) || base.amount <= 0 || !Number.isInteger(base.tip) || base.tip < 0 || base.tip > base.amount) {
        setNotice(t('validAmount')); render(true); return;
    }

    paying = true; setNotice(null); render(true);
    try {
        let nonce;
        try { nonce = tokenGetter ? await tokenGetter() : await getCardToken(orderId); }
        catch (e) { setNotice(e.message || 'Card entry failed — please try again.'); return; } // no attempt exists yet: nothing to resolve

        if (!a) {
            a = { orderId, key: uuid(), mode: base.mode, amount: base.amount, tip: base.tip, remainingBefore: check.remaining_cents, blocked: false, ts: Date.now() };
            saveAttempt(a); // persisted BEFORE the request: a reload / lost response keeps the key
        }

        let res;
        try {
            res = await fetch(`/api/checks/${encodeURIComponent(orderId)}/pay?table_token=${encodeURIComponent(tableToken)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: a.mode, amount_cents: a.amount, tip_cents: a.tip, card_nonce: nonce, idempotency_key: a.key, device_id: deviceId, payment_method: methodLabel || 'card' }),
            });
        } catch { setNotice(UNCONFIRMED()); return; } // network error: outcome unknown -> keep the attempt

        const data = await res.json().catch(() => ({}));
        const code = data.code;

        if (res.ok) {
            clearAttempt(orderId);
            if (data.checkState === 'COMPLETED') {
                // Receipt shows what THIS person paid: their items in My Items
                // mode, otherwise the full check.
                const paidItems = a.mode === 'items'
                    ? check.items.filter((_, idx) => items[idx])
                    : check.items;
                receiptChoice = null; receiptPrintState = null; receiptEmailDone = false;
                receipt = {
                    items: paidItems.length ? paidItems : check.items,
                    total_cents: a.amount + a.tip,
                    currency: check.currency,
                    // C-6: the receipt email binds to THIS payment.
                    payment_id: data.paymentId ?? null,
                };
            } else {
                setNotice(t('paymentReceived', { amt: formatMoney(data.remainingCents ?? 0, check.currency) }), 'ok');
            }
            return;
        }
        if (res.status === 400) { clearAttempt(orderId); setNotice(data.error || 'Payment could not be processed.'); return; }
        if (res.status === 402) { clearAttempt(orderId); setNotice(t('declined')); return; }
        if (res.status === 409 && (code === 'payment_failed' || code === 'payment_cancelled')) {
            clearAttempt(orderId); setNotice(t('attemptFailed')); return;
        }
        if (res.status === 409) { // payment_state_unknown | payment_needs_reconciliation | idempotency_key_reused | anything else
            a.blocked = true; saveAttempt(a); setNotice(ASK_STAFF()); return;
        }
        setNotice(UNCONFIRMED()); // 5xx / 429 / unexpected: unknown outcome -> keep the attempt
    } finally {
        paying = false;
        render(true);
        if (!receipt) fetchBill();
    }
}

// ---- render -------------------------------------------------------------------
function noticeHtml() {
    if (!notice) return '';
    if (notice.kind === 'ok') return `<div class="alert-box" style="background:#DCFCE7;color:#166534;border-color:#86EFAC;">${esc(notice.text)}</div>`;
    return `<div class="alert-box">${esc(notice.text)}</div>`;
}

function updatePayButton() {
    const btn = $('btn-pay-main');
    const footer = $('pay-footer');
    if (!check || receipt || check.remaining_cents <= 0) { footer.style.display = 'none'; return; }
    footer.style.display = 'flex';
    setupWallets(); // no-op unless the payable total changed; hides itself when blocked/unavailable
    const a = currentAttempt();
    if (a && a.blocked) { btn.disabled = true; btn.textContent = t('askServer'); return; }
    if (a) { btn.disabled = paying; btn.textContent = paying ? t('processing') : t('retryPayment', { amt: formatMoney(a.amount + a.tip, check.currency) }); return; }
    const p = payCents();
    btn.disabled = paying;
    btn.textContent = paying ? t('processing') : t('payBtn', { amt: formatMoney(p + tipCentsFor(p), check.currency) });
}

function render(force = false) {
    // Guard (Claude H-1): a throw mid-render must never freeze the guest on a
    // stale bill — log it, clear the render key so the next poll retries, and
    // show the safe fallback if nothing has rendered yet.
    try { renderInner(force); } catch (err) {
        console.error('render failed', err);
        lastRenderKey = null;
        const container = $('main-content');
        if (container && !container.innerHTML) container.innerHTML = '<div class="empty-state"><h3>' + t('couldNotLoad') + '</h3><p>' + t('couldNotLoadBody') + '</p></div>';
    }
}

function renderInner(force = false) {
    const active = document.activeElement;
    const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
    const key = JSON.stringify([lang, table, check, claimsByIdx, loadFailed, !!receipt, receiptChoice, receiptPrintState, receiptEmailDone, notice, paying, mode, people, items, tipPct, currentAttempt(), view, cart, menuLoaded, orderingEnabled, loyaltyEnabled, rated, ratingDone, ratingResult, loyaltyResult, loyaltySubmitting]);
    if (!force && key === lastRenderKey) return;            // poll with no change: leave the DOM (and focus) alone
    if (!force && typing) { renderDeferred = true; return; } // never rebuild the DOM under a focused input
    lastRenderKey = key; renderDeferred = false;

    $('table-badge-label').textContent = table ? `${t('tableWord')} ${table.name}` : t('tableWord');
    const container = $('main-content');

    if (!tableToken) { $('pay-footer').style.display = 'none'; container.innerHTML = '<div class="empty-state"><h3>' + t('invalidLink') + '</h3><p>' + t('invalidLinkBody') + '</p></div>'; return; }
    if (loadFailed) { $('pay-footer').style.display = 'none'; container.innerHTML = '<div class="empty-state"><h3>' + t('couldNotLoad') + '</h3><p>' + t('couldNotLoadBody') + '</p></div>'; return; }
    if (receipt) { $('pay-footer').style.display = 'none'; container.innerHTML = noticeHtml() + renderSuccessState(); return; }

    // QR ordering: menu view (guest can browse + order even without a check yet).
    if (orderingEnabled && view === 'menu') {
        $('pay-footer').style.display = 'none';
        container.innerHTML = renderViewTabs() + renderMenu();
        return;
    }

    if (!check) {
        $('pay-footer').style.display = 'none';
        const menuCta = orderingEnabled
            ? `<div class="card" style="text-align:center;"><h2>${t('hungry')}</h2><p style="font-size:0.9rem;color:var(--text-muted);">${t('hungryBody')}</p><button class="btn-primary" data-action="view" data-v="menu">${t('viewMenu')}</button></div>`
            : '';
        container.innerHTML = `${noticeHtml()}${renderViewTabs()}<div class="empty-state"><h3>${table ? t('billSoon') : t('loadingBill')}</h3><p>${table ? t('billSoonBody') : t('connecting')}</p></div>${menuCta}`;
        return;
    }
    if (check.state === 'COMPLETED' || check.remaining_cents <= 0) { $('pay-footer').style.display = 'none'; container.innerHTML = renderSuccessState(); return; }

    const a = currentAttempt();
    updatePayButton();

    const itemsHtml = check.items.map((i) => `
        <div class="item-row"><span>${esc(i.quantity)} × ${esc(i.name)}</span><span class="tabular">${formatMoney(i.amount_cents, check.currency)}</span></div>`).join('');
    const tendersHtml = check.tenders && check.tenders.length ? `
        <div style="margin-top:12px;padding-top:12px;border-top:1px dashed var(--border);">
            <div style="font-size:0.8rem;font-weight:600;color:var(--text-muted);margin-bottom:6px;">${t('alreadyPaid')}</div>
            ${check.tenders.map((td) => `<div class="item-row" style="color:var(--green);"><span>${t('paymentWord')} (${esc(td.type || t('cardWord'))})</span><span class="tabular">-${formatMoney(td.amount_cents, check.currency)}</span></div>`).join('')}
        </div>` : '';

    let controls = '';
    if (a) {
        controls = `<div class="card"><h2>${a.blocked ? t('attentionTitle') : t('unconfirmedTitle')}</h2>
            <p style="font-size:0.9rem;color:var(--text-muted);">${a.blocked ? t('blockedBody') : t('unconfirmedBody', { amt: formatMoney(a.amount, check.currency), tip: formatMoney(a.tip, check.currency) })}</p></div>`;
    } else {
        controls = `
            <div class="card"><h2>${t('splitPayment')}</h2>
                <div class="split-tabs">
                    ${[['full', t('splitFull')], ['equal', t('splitEqual')], ['custom', t('splitCustom')], ['items', t('splitItems')]].map(([m, label]) => `<button class="split-tab ${mode === m ? 'active' : ''}" data-action="mode" data-v="${m}">${label}</button>`).join('')}
                </div>
                ${renderSplitUI()}
            </div>
            <div class="card"><h2>${t('addTip')}</h2>
                <div class="tip-chips">
                    ${[15, 18, 20, 25, 0].map((p) => `<div class="tip-chip ${tipPct === p ? 'active' : ''}" data-action="tip" data-v="${p}">${p === 0 ? t('tipNone') : p + '%'}</div>`).join('')}
                </div>
            </div>`;
    }

    container.innerHTML = `
        ${noticeHtml()}
        ${renderViewTabs()}
        <div class="card"><h2>${t('itemizedBill')}</h2>
            <div id="items-list">${itemsHtml}</div>
            ${tendersHtml}
            <div class="totals-box">
                <div class="total-line"><span>${t('totalBill')}</span><span class="tabular">${formatMoney(check.total_cents, check.currency)}</span></div>
                <div class="hero-total-line"><span>${t('remainingDue')}</span><span class="tabular">${formatMoney(check.remaining_cents, check.currency)}</span></div>
            </div>
        </div>
        ${controls}`;
}

function renderSplitUI() {
    const cur = check.currency;
    if (mode === 'full') return `<p style="font-size:0.9rem;color:var(--text-muted);">${t('fullBody', { amt: formatMoney(check.remaining_cents, cur) })}</p>`;
    if (mode === 'equal') {
        const share = Math.min(check.remaining_cents, Math.ceil(check.remaining_cents / people));
        return `<div class="stepper"><button data-action="equal" data-v="-1">-</button><span>${t('splitAmong', { n: people })}</span><button data-action="equal" data-v="1">+</button></div>
            <p style="font-size:0.9rem;color:var(--text-muted);text-align:center;">${t('yourShare')} <strong class="tabular">${formatMoney(share, cur)}</strong></p>`;
    }
    if (mode === 'custom') {
        return `<div class="input-group"><label>${t('customAmount')}</label>
            <input type="number" inputmode="decimal" step="0.01" min="0" max="${check.remaining_cents / 100}" value="${customCents ? (customCents / 100).toFixed(2) : ''}" data-input="custom" placeholder="0.00"></div>`;
    }
    // Group Pay: tap the items YOU had — your claim shows on everyone's phone
    // so nothing is paid twice. Items claimed by another phone are locked.
    const myTotal = check.items.reduce((sum, it, idx) => sum + (items[idx] ? it.amount_cents : 0), 0);
    const claimedCount = check.items.reduce((n, it, idx) => n + (claimAt(idx) ? 1 : 0), 0);
    const paidSoFar = (check.tenders || []).reduce((s, td) => s + td.amount_cents, 0);
    return `
        <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:10px;">${t('myItemsHelp')}</p>
        <div class="items-select-list">
            ${check.items.map((it, idx) => {
                const c = claimAt(idx);
                const mine = !!items[idx];
                const taken = !!c && !mine;
                return `<label class="item-checkbox" style="${mine ? 'border-color:var(--navy);border-width:2px;' : ''}${taken ? 'opacity:0.55;' : ''}"><input type="checkbox" ${mine ? 'checked' : ''} ${taken ? 'disabled' : ''} data-item="${idx}">
                <div style="flex:1;display:flex;justify-content:space-between;"><span>${esc(it.quantity)} × ${esc(it.name)}${taken ? ` · 🔒 ${t('taken')}` : ''}</span><span class="tabular">${formatMoney(it.amount_cents, cur)}</span></div></label>`;
            }).join('')}
        </div>
        <p style="font-size:0.85rem;color:var(--text-muted);text-align:center;">${t('claimedProgress', { n: claimedCount, total: check.items.length })} · ${t('paidSoFar', { amt: formatMoney(paidSoFar, cur), total: formatMoney(check.total_cents, cur) })}</p>
        ${myTotal > 0 ? `<p style="font-size:0.95rem;text-align:center;margin-top:8px;">${t('yourShare')} <strong class="tabular">${formatMoney(Math.min(check.remaining_cents, myTotal), cur)}</strong></p>` : ''}`;
}

function renderSuccessState() {
    const src = receipt || check;
    return `<div class="success-box"><div class="success-icon">✓</div>
        <h2>${t('paySuccess')}</h2>
        <p style="color:var(--text-muted);font-size:0.9rem;margin-bottom:20px;">${t('thanksDining')}</p>
        <div class="card" style="text-align:left;"><h2>${t('receiptSummary')}</h2>
            ${src.items.map((i) => `<div class="item-row"><span>${esc(i.quantity)} × ${esc(i.name)}</span><span class="tabular">${formatMoney(i.amount_cents, src.currency)}</span></div>`).join('')}
            <div class="totals-box"><div class="total-line"><span>${t('totalSettled')}</span><span class="tabular">${formatMoney(src.total_cents, src.currency)}</span></div></div>
        </div>
        ${renderReceiptOptions()}
        </div>
        ${renderRating()}
        ${renderLoyalty()}`;
}

// Receipt delivery is chosen on the guest's PHONE (this page). "Print"
// sends the receipt to the table's own STT-101 device — the device has
// no receipt UI of its own, it just polls and prints queued jobs.
function renderReceiptOptions() {
    const printStatus = receiptPrintState === 'printing' ? `<p style="font-size:0.9rem;color:var(--text-muted);text-align:center;">${t('receiptPrinting')}</p>`
        : receiptPrintState === 'done' ? `<p style="font-size:0.9rem;text-align:center;">${t('receiptPrintedOk')}</p>`
        : receiptPrintState === 'already' ? `<p style="font-size:0.9rem;text-align:center;">${t('receiptAlreadyPrinted')}</p>`
        : receiptPrintState === 'unavailable' ? `<p style="font-size:0.9rem;text-align:center;">${t('receiptPrintUnavailable')}</p>`
        : receiptPrintState === 'failed' ? `<p style="font-size:0.9rem;text-align:center;">${t('receiptPrintFailed')}</p>` : '';
    if (!receiptChoice) {
        return `<div class="card" style="text-align:left;"><h2>${t('receiptOptions')}</h2>
        <div style="display:flex;flex-direction:column;gap:10px;">
            <button class="btn-primary" data-action="rc-print">${t('printReceipt')}</button>
            <button class="btn-primary" data-action="rc-email" style="background:var(--blue);">${t('emailReceipt')}</button>
            <button class="btn-primary" data-action="rc-both" style="background:var(--blue);">${t('printAndEmail')}</button>
            <button class="btn-primary" data-action="rc-none" style="background:var(--text-muted);">${t('noReceipt')}</button>
        </div></div>`;
    }
    if (receiptChoice === 'none') {
        return `<div class="card"><p style="text-align:center;">${t('noReceiptOk')}</p></div>`;
    }
    const emailPart = receiptChoice === 'email' || receiptChoice === 'both'
        ? (receiptEmailDone
            ? ''
            : `<div id="email-receipt-box" class="card" style="text-align:left;">
            <input id="receipt-email" type="email" placeholder="your@email.com"
                style="width:100%;padding:12px;border:1px solid var(--border);border-radius:10px;font-size:1rem;margin-bottom:10px;">
            <button class="btn-primary" data-action="email-send">${t('sendReceipt')}</button>
        </div>`)
        : '';
    return printStatus + emailPart;
}

async function requestReceiptPrint() {
    if (receiptPrintState === 'printing' || receiptPrintState === 'done') return;
    receiptPrintState = 'printing';
    render(true);
    try {
        const res = await fetch(`/api/t/${encodeURIComponent(tableToken)}/receipt-print`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payment_id: receipt?.payment_id ?? undefined }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'print failed');
        receiptPrintState = data.printed ? 'done' : (data.reason === 'already_printed' ? 'already' : 'unavailable');
    } catch {
        receiptPrintState = 'failed';
    }
    render(true);
}

async function sendReceiptEmail() {
    const input = document.getElementById('receipt-email');
    const email = input ? input.value.trim() : '';
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setNotice(t('validEmail'));
        render(true);
        return;
    }
    setNotice(null);
    try {
        const res = await fetch(`/api/t/${encodeURIComponent(tableToken)}/receipt-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, payment_id: receipt?.payment_id ?? undefined }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not send receipt.');
        receiptEmailDone = true;
        setNotice(t('receiptSentTo', { email }), 'ok');
    } catch (err) {
        setNotice(err.message || 'Could not send receipt. Please try again.');
    }
    render(true);
}

// ---- events (no inline handlers: CSP-friendly) ---------------------------------
// Wallet buttons: the Square SDK renders its own button inside these mounts;
// a click anywhere on the mount starts the wallet sheet for the frozen total.
$('apple-pay-button').addEventListener('click', () => {
    if (walletState.apple) processPayment(() => walletTokenize('apple'), 'apple_pay');
});
$('google-pay-button').addEventListener('click', () => {
    if (walletState.google) processPayment(() => walletTokenize('google'), 'google_pay');
});
document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    switch (el.dataset.action) {
        case 'mode': mode = el.dataset.v; setNotice(null); render(true); break;
        case 'equal': people = Math.min(12, Math.max(2, people + Number(el.dataset.v))); render(true); break;
        case 'tip': tipPct = Number(el.dataset.v); render(true); break;
        case 'pay': processPayment(); break;
        case 'view':
            view = el.dataset.v;
            if (view === 'menu') loadMenu();
            else render(true);
            break;
        case 'cart': {
            const [id, d] = el.dataset.v.split('|');
            const q = Math.max(0, Math.min(20, (cart[id] || 0) + Number(d)));
            if (q === 0) delete cart[id]; else cart[id] = q;
            render(true);
            break;
        }
        case 'order': submitOrder(); break;
        case 'rate': {
            const s = Number(el.dataset.v);
            if (s >= 4) submitRating(s);
            else { rated = s; render(true); }
            break;
        }
        case 'rate-submit': {
            const ta = document.getElementById('rating-comment');
            submitRating(rated, ta ? ta.value : null);
            break;
        }
        case 'loyalty': submitLoyalty(); break;
        case 'rc-print': receiptChoice = 'print'; requestReceiptPrint(); render(true); break;
        case 'rc-email': receiptChoice = 'email'; render(true); break;
        case 'rc-both': receiptChoice = 'both'; requestReceiptPrint(); render(true); break;
        case 'rc-none': receiptChoice = 'none'; render(true); break;
        case 'email-send': sendReceiptEmail(); break;
    }
});
document.addEventListener('input', (e) => {
    if (e.target.matches && e.target.matches('[data-input="custom"]')) {
        const v = parseFloat(e.target.value);
        customCents = Number.isFinite(v) && v > 0 ? Math.round(v * 100) : 0;
        updatePayButton(); // label only: do not rebuild the DOM while typing
    }
    if (e.target.matches && e.target.id === 'loyalty-phone') {
        loyaltyPhone = e.target.value;
    }
    if (e.target.matches && e.target.id === 'rating-comment') {
        // don't re-render while typing the comment
    }
});
document.addEventListener('change', (e) => {
    if (e.target.matches && e.target.matches('[data-item]')) { toggleClaim(Number(e.target.dataset.item), e.target.checked); }
});

// Group Pay: claim/unclaim an item on the server; the bill poll then shows
// the new state on every phone at the table.
async function toggleClaim(idx, want) {
    if (!check) return;
    const it = check.items[idx];
    if (!it) return;
    if (want) items[idx] = true; else delete items[idx]; // optimistic; the poll confirms
    render(true);
    try {
        const res = await fetch(`/api/checks/${encodeURIComponent(check.square_order_id)}/claims?table_token=${encodeURIComponent(tableToken)}`, {
            method: want ? 'POST' : 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item_index: idx, fingerprint: itemFp(it), device_id: deviceId }),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            setNotice(res.status === 409 ? t('justClaimed') : (data.error || t('claimFailed')));
        }
    } catch { setNotice(t('claimFailed')); }
    fetchBill();
}
document.addEventListener('focusout', () => { if (renderDeferred) setTimeout(() => render(true), 0); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollDelayMs = POLL_MIN_MS; fetchBill(); } });

// H-3/G-5: adaptive poll backoff. A fixed 5s poll from every phone at a
// table (16+ phones on one venue IP) saturated the shared rate bucket and
// cost a live POS call per poll per check. The delay now doubles while
// the bill is unchanged (5s -> 10s -> 20s -> 30s cap) and snaps back to
// 5s the moment anything changes, so a fresh tender still appears fast.
const POLL_MIN_MS = 5000;
const POLL_MAX_MS = 30000;
let pollDelayMs = POLL_MIN_MS;
let lastBillSig = null;
function billSig() {
    if (!check) return table ? 'table-only' : 'none';
    return [check.square_order_id, check.state, check.remaining_cents, check.total_cents, JSON.stringify(claimsByIdx)].join('|');
}
async function pollTick() {
    if (!document.hidden && !paying) {
        await fetchBill();
        const sig = billSig();
        if (sig === lastBillSig) pollDelayMs = Math.min(POLL_MAX_MS, pollDelayMs * 2);
        else { lastBillSig = sig; pollDelayMs = POLL_MIN_MS; }
    }
    setTimeout(pollTick, pollDelayMs);
}
setTimeout(pollTick, POLL_MIN_MS);
render(true);
fetchBill();

    