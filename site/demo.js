/* Smart Table — interactive demo (site/demo.html)
   Simulates the full guest journey, synced across three views:
   the STT-101 table device, the guest's phone, and the restaurant's live floor view.
   Translations for the phone UI are extracted verbatim from the real guest app. */
'use strict';

const I18N = {"en": {"tableWord": "Table", "secureNote": "🔒 Secure payment · No app needed · No account needed", "itemizedBill": "Itemized Bill", "totalBill": "Total Bill", "remainingDue": "Remaining Due", "splitPayment": "Split Payment", "splitFull": "Full", "splitEqual": "Equal", "splitItems": "Group Pay", "addTip": "Add Tip", "tipNone": "None", "payBtn": "Pay {amt}", "processing": "Processing payment...", "paySuccess": "Payment Successful!", "thanksDining": "Thank you for dining with us. Your payment has been processed.", "receiptOptions": "Receipt", "printReceipt": "🖨️ Print Receipt", "emailReceipt": "✉️ Email Receipt", "printAndEmail": "🖨️✉️ Print + Email", "noReceipt": "No receipt, thanks", "receiptPrintedOk": "Your receipt is printing at your table ✓", "receiptSentTo": "Receipt sent to {email} ✓", "noReceiptOk": "No receipt — you're all set ✓", "howWasIt": "How was it?", "sendFeedback": "Send Feedback", "commentPlaceholder": "What could be better? (optional)", "thanksFeedback": "Thanks for the feedback", "leaveGoogleReview": "⭐ Leave a Google Review", "yourShare": "Your share:", "splitAmong": "Split among {n} people", "cardNumber": "Card number", "fullBody": "Paying the full remaining balance of {amt}.", "sendReceipt": "Send Receipt", "receiptSummary": "Receipt Summary", "totalSettled": "Total Settled", "thanksExcl": "Thanks! 🎉", "validEmail": "Please enter a valid email address.", "myItemsHelp": "Tap the items you had — your claim shows on everyone's phone, so nothing gets paid twice. Everyone pays for their own claimed items.", "claimedProgress": "{n} of {total} items claimed", "paidSoFar": "Paid so far: {amt} of {total}", "splitCustom": "Custom", "customAmount": "Custom Amount"}, "fa": {"tableWord": "میز", "secureNote": "🔒 پرداخت امن · بدون نیاز به اپ · بدون نیاز به حساب", "itemizedBill": "صورت‌حساب جزئی", "totalBill": "جمع صورت‌حساب", "remainingDue": "مبلغ باقی‌مانده", "splitPayment": "تقسیم پرداخت", "splitFull": "کامل", "splitEqual": "مساوی", "splitItems": "پرداخت گروهی", "addTip": "افزودن انعام", "tipNone": "هیچ‌کدام", "payBtn": "پرداخت {amt}", "processing": "در حال پردازش پرداخت...", "paySuccess": "پرداخت موفق بود!", "thanksDining": "ممنون که پیش ما بودید. پرداخت شما انجام شد.", "receiptOptions": "رسید", "printReceipt": "🖨️ چاپ رسید", "emailReceipt": "✉️ ایمیل رسید", "printAndEmail": "🖨️✉️ چاپ + ایمیل", "noReceipt": "رسید نمی‌خواهم", "receiptPrintedOk": "رسیدتان سر میز در حال چاپ است ✓", "receiptSentTo": "رسید به {email} ارسال شد ✓", "noReceiptOk": "بدون رسید — همه‌چیز انجام شد ✓", "howWasIt": "چطور بود؟", "sendFeedback": "ارسال بازخورد", "commentPlaceholder": "چه چیزی می‌توانست بهتر باشد؟ (اختیاری)", "thanksFeedback": "ممنون از بازخوردتان", "leaveGoogleReview": "⭐ ثبت نظر در گوگل", "yourShare": "سهم شما:", "splitAmong": "تقسیم بین {n} نفر", "cardNumber": "شماره کارت", "fullBody": "پرداخت کامل مبلغ باقی‌مانده: {amt}", "sendReceipt": "ارسال رسید", "receiptSummary": "خلاصه رسید", "totalSettled": "جمع تسویه‌شده", "thanksExcl": "ممنون! 🎉", "validEmail": "لطفاً یک ایمیل معتبر وارد کنید.", "myItemsHelp": "آیتم‌هایی را که داشتید انتخاب کنید — انتخاب شما روی گوشی همه سر میز نشان داده می‌شود تا چیزی دوبار پرداخت نشود. هر نفر آیتم‌های خودش را پرداخت می‌کند.", "claimedProgress": "{n} از {total} آیتم انتخاب شده", "paidSoFar": "پرداخت‌شده تا حالا: {amt} از {total}", "splitCustom": "دلخواه", "customAmount": "مبلغ دلخواه"}, "zh": {"tableWord": "餐桌", "secureNote": "🔒 安全支付 · 无需应用 · 无需账户", "itemizedBill": "详细账单", "totalBill": "账单总额", "remainingDue": "待付金额", "splitPayment": "分开付款", "splitFull": "全额", "splitEqual": "均分", "splitItems": "分组付款", "addTip": "添加小费", "tipNone": "无", "payBtn": "支付 {amt}", "processing": "正在处理付款...", "paySuccess": "付款成功！", "thanksDining": "感谢您的光临。您的付款已处理。", "receiptOptions": "收据", "printReceipt": "🖨️ 打印收据", "emailReceipt": "✉️ 邮件发送收据", "printAndEmail": "🖨️✉️ 打印 + 邮件", "noReceipt": "不需要收据", "receiptPrintedOk": "您的收据正在餐桌旁打印 ✓", "receiptSentTo": "收据已发送至 {email} ✓", "noReceiptOk": "不需要收据——一切就绪 ✓", "howWasIt": "体验如何？", "sendFeedback": "发送反馈", "commentPlaceholder": "哪些方面可以改进？（可选）", "thanksFeedback": "感谢您的反馈", "leaveGoogleReview": "⭐ 在 Google 上评价", "yourShare": "您的份额：", "splitAmong": "由 {n} 人分摊", "cardNumber": "卡号", "fullBody": "支付全部剩余金额 {amt}。", "sendReceipt": "发送收据", "receiptSummary": "收据摘要", "totalSettled": "已结总额", "thanksExcl": "谢谢！🎉", "validEmail": "请输入有效的电子邮箱。", "myItemsHelp": "点击您点的菜品——您的选择会显示在桌上每个人的手机上，避免重复付款。每个人支付自己选的菜品。", "claimedProgress": "已选 {n} / {total} 件", "paidSoFar": "已支付：{total} 中的 {amt}", "splitCustom": "自定义", "customAmount": "自定义金额"}, "hi": {"tableWord": "टेबल", "secureNote": "🔒 सुरक्षित भुगतान · ऐप की ज़रूरत नहीं · खाते की ज़रूरत नहीं", "itemizedBill": "विस्तृत बिल", "totalBill": "कुल बिल", "remainingDue": "शेष राशि", "splitPayment": "भुगतान बाँटें", "splitFull": "पूरा", "splitEqual": "बराबर", "splitItems": "ग्रुप पेमेंट", "addTip": "टिप जोड़ें", "tipNone": "कोई नहीं", "payBtn": "{amt} का भुगतान करें", "processing": "भुगताना संसाधित हो रहा है...", "paySuccess": "भुगतान सफल!", "thanksDining": "हमारे यहाँ भोजन करने के लिए धन्यवाद। आपका भुगतान हो गया है।", "receiptOptions": "रसीद", "printReceipt": "🖨️ रसीद प्रिंट करें", "emailReceipt": "✉️ रसीद ईमेल करें", "printAndEmail": "🖨️✉️ प्रिंट + ईमेल", "noReceipt": "रसीद नहीं चाहिए", "receiptPrintedOk": "आपकी रसीद आपकी टेबल पर प्रिंट हो रही है ✓", "receiptSentTo": "रसीद {email} पर भेज दी गई ✓", "noReceiptOk": "रसीद नहीं — सब हो गया ✓", "howWasIt": "कैसा रहा?", "sendFeedback": "प्रतिक्रिया भेजें", "commentPlaceholder": "क्या बेहतर हो सकता था? (वैकल्पिक)", "thanksFeedback": "आपकी प्रतिक्रिया के लिए धन्यवाद", "leaveGoogleReview": "⭐ Google पर समीक्षा दें", "yourShare": "आपका हिस्सा:", "splitAmong": "{n} लोगों में बाँटें", "cardNumber": "कार्ड नंबर", "fullBody": "पूरी शेष राशि {amt} का भुगतान कर रहे हैं।", "sendReceipt": "रसीद भेजें", "receiptSummary": "रसीद सारांश", "totalSettled": "कुल निपटान", "thanksExcl": "धन्यवाद! 🎉", "validEmail": "कृपया मान्य ईमेल पता डालें।", "myItemsHelp": "आपने जो खाया, उसे चुनें — आपकी पसंद टेबल पर सबके फ़ोन पर दिखेगी, ताकि कोई चीज़ दो बार न चुकाई जाए। हर कोई अपने चुने आइटम का भुगतान करता है।", "claimedProgress": "{total} में से {n} आइटम चुने गए", "paidSoFar": "अब तक भुगतान: {total} में से {amt}", "splitCustom": "कस्टम", "customAmount": "कस्टम राशि"}, "pa": {"tableWord": "ਮੇਜ਼", "secureNote": "🔒 ਸੁਰੱਖਿਅਤ ਭੁਗਤਾਨ · ਐਪ ਦੀ ਲੋੜ ਨਹੀਂ · ਖਾਤੇ ਦੀ ਲੋੜ ਨਹੀਂ", "itemizedBill": "ਵਿਸਤ੍ਰਿਤ ਬਿੱਲ", "totalBill": "ਕੁੱਲ ਬਿੱਲ", "remainingDue": "ਬਾਕੀ ਰਕਮ", "splitPayment": "ਭੁਗਤਾਨ ਵੰਡੋ", "splitFull": "ਪੂਰਾ", "splitEqual": "ਬਰਾਬਰ", "splitItems": "ਗਰੁੱਪ ਭੁਗਤਾਨ", "addTip": "ਟਿੱਪ ਜੋੜੋ", "tipNone": "ਕੋਈ ਨਹੀਂ", "payBtn": "{amt} ਦਾ ਭੁਗਤਾਨ ਕਰੋ", "processing": "ਭੁਗਤਾਨ ਦੀ ਪ੍ਰਕਿਰਿਆ ਚੱਲ ਰਹੀ ਹੈ...", "paySuccess": "ਭੁਗਤਾਨ ਸਫਲ!", "thanksDining": "ਸਾਡੇ ਇੱਥੇ ਖਾਣਾ ਖਾਣ ਲਈ ਧੰਨਵਾਦ। ਤੁਹਾਡਾ ਭੁਗਤਾਨ ਹੋ ਗਿਆ ਹੈ।", "receiptOptions": "ਰਸੀਦ", "printReceipt": "🖨️ ਰਸੀਦ ਪ੍ਰਿੰਟ ਕਰੋ", "emailReceipt": "✉️ ਰਸੀਦ ਈਮੇਲ ਕਰੋ", "printAndEmail": "🖨️✉️ ਪ੍ਰਿੰਟ + ਈਮੇਲ", "noReceipt": "ਰਸੀਦ ਨਹੀਂ ਚਾਹੀਦੀ", "receiptPrintedOk": "ਤੁਹਾਡੀ ਰਸੀਦ ਤੁਹਾਡੀ ਮੇਜ਼ 'ਤੇ ਪ੍ਰਿੰਟ ਹੋ ਰਹੀ ਹੈ ✓", "receiptSentTo": "ਰਸੀਦ {email} 'ਤੇ ਭੇਜ ਦਿੱਤੀ ਗਈ ✓", "noReceiptOk": "ਰਸੀਦ ਨਹੀਂ — ਸਭ ਹੋ ਗਿਆ ✓", "howWasIt": "ਕਿਵੇਂ ਰਿਹਾ?", "sendFeedback": "ਪ੍ਰਤੀਕਿਰਿਆ ਭੇਜੋ", "commentPlaceholder": "ਕੀ ਬਿਹਤਰ ਹੋ ਸਕਦਾ ਸੀ? (ਵਿਕਲਪਿਕ)", "thanksFeedback": "ਤੁਹਾਡੀ ਪ੍ਰਤੀਕਿਰਿਆ ਲਈ ਧੰਨਵਾਦ", "leaveGoogleReview": "⭐ Google 'ਤੇ ਸਮੀਖਿਆ ਦਿਓ", "yourShare": "ਤੁਹਾਡਾ ਹਿੱਸਾ:", "splitAmong": "{n} ਲੋਕਾਂ ਵਿੱਚ ਵੰਡੋ", "cardNumber": "ਕਾਰਡ ਨੰਬਰ", "fullBody": "ਪੂਰੀ ਬਾਕੀ ਰਕਮ {amt} ਦਾ ਭੁਗਤਾਨ ਕਰ ਰਹੇ ਹੋ।", "sendReceipt": "ਰਸੀਦ ਭੇਜੋ", "receiptSummary": "ਰਸੀਦ ਸਾਰ", "totalSettled": "ਕੁੱਲ ਨਿਪਟਾਰਾ", "thanksExcl": "ਧੰਨਵਾਦ! 🎉", "validEmail": "ਕਿਰਪਾ ਕਰਕੇ ਸਹੀ ਈਮੇਲ ਪਤਾ ਦਰਜ ਕਰੋ।", "myItemsHelp": "ਜੋ ਤੁਸੀਂ ਖਾਧਾ, ਉਹ ਚੁਣੋ — ਤੁਹਾਡੀ ਚੋਣ ਮੇਜ਼ 'ਤੇ ਸਭ ਦੇ ਫ਼ੋਨ 'ਤੇ ਦਿਖੇਗੀ, ਤਾਂ ਜੋ ਕੁਝ ਵੀ ਦੋ ਵਾਰ ਨਾ ਚੁਕਾਇਆ ਜਾਵੇ। ਹਰ ਕੋਈ ਆਪਣੀਆਂ ਚੁਣੀਆਂ ਆਈਟਮਾਂ ਦਾ ਭੁਗਤਾਨ ਕਰਦਾ ਹੈ।", "claimedProgress": "{total} ਵਿੱਚੋਂ {n} ਆਈਟਮਾਂ ਚੁਣੀਆਂ ਗਈਆਂ", "paidSoFar": "ਹੁਣ ਤੱਕ ਭੁਗਤਾਨ: {total} ਵਿੱਚੋਂ {amt}", "splitCustom": "ਕਸਟਮ", "customAmount": "ਕਸਟਮ ਰਕਮ"}};
const LOCALES = { en: 'en-CA', fa: 'fa-IR', zh: 'zh-CN', hi: 'hi-IN', pa: 'pa-IN' };
const LANG_NAMES = { en: 'English', fa: 'فارسی', zh: '中文', hi: 'हिन्दी', pa: 'ਪੰਜਾਬੀ' };

const ITEMS = [
  { name: 'Truffle Arancini', qty: 1, cents: 1600 },
  { name: 'Ribeye 10oz', qty: 2, cents: 4200 },
  { name: 'Negroni', qty: 2, cents: 1500 },
];
const TOTAL_CENTS = ITEMS.reduce((s, i) => s + i.qty * i.cents, 0); // 13000

const state = {
  lang: 'en',
  phase: 'scan', // scan | bill | card | processing | success
  mode: 'full', // full | equal | items | custom
  people: 2,
  customDollars: '50.00',
  claims: new Set(),
  tipPct: 15,
  serviceActive: false,
  paid: false,
  receiptDone: false,
  rated: 0,
  scanAt: null,
};

const $ = (id) => document.getElementById(id);
const phoneApp = $('phoneApp');

function t(key, vars) {
  let s = (I18N[state.lang] && I18N[state.lang][key]) || I18N.en[key] || key;
  if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}
function fmt(cents) {
  return new Intl.NumberFormat(LOCALES[state.lang], { style: 'currency', currency: 'CAD' }).format(cents / 100);
}
function shareCents() {
  if (state.mode === 'equal') return Math.round(TOTAL_CENTS / state.people);
  if (state.mode === 'items') {
    let s = 0;
    state.claims.forEach((i) => { s += ITEMS[i].qty * ITEMS[i].cents; });
    return s;
  }
  if (state.mode === 'custom') {
    const v = Math.round(parseFloat(state.customDollars || '0') * 100);
    return Number.isFinite(v) ? Math.max(0, Math.min(TOTAL_CENTS, v)) : 0;
  }
  return TOTAL_CENTS;
}
function tipCents() { return Math.round(shareCents() * state.tipPct / 100); }
function dueCents() { return shareCents() + tipCents(); }

/* ---------- narrator stepper ---------- */
function setStep(n) {
  for (let i = 1; i <= 4; i++) {
    const el = $('step-' + i);
    el.classList.toggle('active', i === n);
    el.classList.toggle('done', i < n);
  }
}

/* ---------- device + live view ---------- */
function setLed() {
  const ring = $('ledRing');
  ring.classList.remove('amber', 'green');
  if (state.serviceActive) ring.classList.add('amber');
  else if (state.paid) ring.classList.add('green');
}
function setDeviceStatus(txt) { $('deviceStatus').textContent = txt; }
function feed(html) {
  const li = document.createElement('li');
  li.innerHTML = '<span class="ft">now</span><span>' + html + '</span>';
  const list = $('liveFeed');
  list.prepend(li);
}
function toast(msg) {
  const el = $('phoneToast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => el.classList.remove('show'), 3200);
}

$('waiterBtn').addEventListener('click', () => {
  if (state.serviceActive) { feed('🔔 Table 5 pressed the service button again'); return; }
  state.serviceActive = true;
  setLed();
  setDeviceStatus('Service requested — help is on the way');
  feed('🔔 Table 5 requested service (device button)');
  toast('🔔 Your server has been notified');
  const zone = $('alertZone');
  zone.innerHTML = '<div class="alert-row amber" id="serviceAlert"><span>🔔 Table 5 — service requested</span><button type="button" id="servedBtn">Mark served</button></div>';
  $('servedBtn').addEventListener('click', () => {
    state.serviceActive = false;
    zone.innerHTML = '';
    setLed();
    setDeviceStatus(state.paid ? 'Payment received ✓' : 'Scan to view & pay your bill');
    feed('Table 5 served ✓');
  });
});

/* ---------- guest phone ---------- */
function headHtml() {
  const opts = Object.keys(LANG_NAMES).map((l) =>
    '<option value="' + l + '"' + (l === state.lang ? ' selected' : '') + '>' + LANG_NAMES[l] + '</option>').join('');
  return '<div class="g-head"><div><div class="rname">Sample Bistro</div><div class="rtable">' +
    t('tableWord') + ' 5</div></div><select id="langSel" aria-label="Language">' + opts + '</select></div>';
}
function wireHead() {
  const sel = $('langSel');
  if (sel) sel.addEventListener('change', () => {
    state.lang = sel.value;
    phoneApp.dir = state.lang === 'fa' ? 'rtl' : 'ltr';
    phoneApp.lang = state.lang;
    render();
  });
}

function render() {
  wireHeadCleanup();
  phoneApp.lang = state.lang;
  if (state.phase === 'scan') renderScan();
  else if (state.phase === 'bill') renderBill();
  else if (state.phase === 'card') renderCard();
  else if (state.phase === 'processing') renderProcessing();
  else if (state.phase === 'success') renderSuccess();
  wireHead();
}
function wireHeadCleanup() { /* head is rebuilt each render; nothing persistent to clean */ }

function renderScan() {
  phoneApp.innerHTML =
    '<div class="g-scan">' +
    '<div style="font-size:2rem;">📷</div>' +
    '<div class="frame"><img src="/media/demo-qr.png" alt="Table QR code"></div>' +
    '<p style="color:var(--text-muted);font-size:0.92rem;">Your guest points their phone camera at the device — no app, no account, no download.</p>' +
    '<button class="g-pay" id="scanBtn" style="max-width:240px;">Simulate the scan</button>' +
    '</div>';
  $('scanBtn').addEventListener('click', () => {
    state.scanAt = Date.now();
    state.phase = 'bill';
    setStep(2);
    feed('📱 Guest scanned the QR — bill opened on their phone');
    render();
  });
}

function splitAreaHtml() {
  if (state.mode === 'full') return '<p style="font-size:0.9rem;color:var(--text-muted);">' + t('fullBody', { amt: fmt(TOTAL_CENTS) }) + '</p>';
  if (state.mode === 'equal') {
    return '<div style="display:flex;justify-content:space-between;align-items:center;">' +
      '<span style="font-size:0.92rem;">' + t('splitAmong', { n: state.people }) + '</span>' +
      '<span class="g-stepper"><button type="button" id="pMinus" aria-label="Fewer people">−</button><strong>' + state.people + '</strong><button type="button" id="pPlus" aria-label="More people">+</button></span></div>';
  }
  if (state.mode === 'custom') {
    return '<label style="font-size:0.92rem;display:block;margin-bottom:6px;">' + t('customAmount') + ' (CA$)</label>' +
      '<input class="g-input" id="custAmt" type="number" min="0" max="130" step="0.50" value="' + state.customDollars + '" inputmode="decimal" style="margin-bottom:2px;">' +
      '<p style="font-size:0.82rem;color:var(--text-muted);">Pay any part of the bill — the rest stays open for the table.</p>';
  }
  const claims = ITEMS.map((it, i) => {
    const on = state.claims.has(i);
    return '<button type="button" class="g-claim' + (on ? ' on' : '') + '" data-claim="' + i + '"><span>' +
      (it.qty > 1 ? it.qty + ' × ' : '') + it.name + '</span><span>' + fmt(it.qty * it.cents) +
      (on ? ' <span class="tick">✓</span>' : '') + '</span></button>';
  }).join('');
  return '<p style="font-size:0.83rem;color:var(--text-muted);margin-bottom:8px;">' + t('myItemsHelp') + '</p>' + claims +
    '<p style="font-size:0.82rem;color:var(--text-muted);">' + t('claimedProgress', { n: state.claims.size, total: ITEMS.length }) + '</p>';
}

function renderBill() {
  const items = ITEMS.map((it) =>
    '<div class="g-item"><span>' + (it.qty > 1 ? it.qty + ' × ' : '') + it.name + '</span><span class="amt">' + fmt(it.qty * it.cents) + '</span></div>').join('');
  const tips = [0, 10, 15, 18, 20].map((p) =>
    '<button type="button" class="g-chip' + (state.tipPct === p ? ' on' : '') + '" data-tip="' + p + '">' +
    (p === 0 ? t('tipNone') : p + '%') + '</button>').join('');
  const share = shareCents();
  phoneApp.innerHTML =
    headHtml() +
    '<div class="g-body">' +
      '<div class="g-card"><h4>' + t('itemizedBill') + '</h4>' + items +
        '<div class="g-total"><span>' + t('totalBill') + '</span><span>' + fmt(TOTAL_CENTS) + '</span></div></div>' +
      '<div class="g-card"><h4>' + t('splitPayment') + '</h4>' +
        '<div class="g-seg">' +
          '<button type="button" data-mode="full" class="' + (state.mode === 'full' ? 'on' : '') + '">' + t('splitFull') + '</button>' +
          '<button type="button" data-mode="equal" class="' + (state.mode === 'equal' ? 'on' : '') + '">' + t('splitEqual') + '</button>' +
          '<button type="button" data-mode="items" class="' + (state.mode === 'items' ? 'on' : '') + '">' + t('splitItems') + '</button>' +
          '<button type="button" data-mode="custom" class="' + (state.mode === 'custom' ? 'on' : '') + '">' + t('splitCustom') + '</button>' +
        '</div><div id="splitArea">' + splitAreaHtml() + '</div>' +
        (state.mode !== 'full' ? '<div class="g-share"><span>' + t('yourShare') + '</span><span id="shareAmt">' + fmt(share) + '</span></div>' : '') +
      '</div>' +
      '<div class="g-card"><h4>' + t('addTip') + '</h4><div class="g-chips">' + tips + '</div></div>' +
    '</div>' +
    '<div class="g-paybar"><button class="g-pay" id="toCardBtn"' + (share <= 0 ? ' disabled' : '') + '>' +
      t('payBtn', { amt: fmt(dueCents()) }) + '</button>' +
      '<div class="g-secure">' + t('secureNote') + '</div></div>';

  phoneApp.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { state.mode = b.dataset.mode; renderBill(); wireHead(); }));
  phoneApp.querySelectorAll('[data-tip]').forEach((b) => b.addEventListener('click', () => { state.tipPct = Number(b.dataset.tip); renderBill(); wireHead(); }));
  phoneApp.querySelectorAll('[data-claim]').forEach((b) => b.addEventListener('click', () => {
    const i = Number(b.dataset.claim);
    state.claims.has(i) ? state.claims.delete(i) : state.claims.add(i);
    renderBill(); wireHead();
  }));
  const minus = $('pMinus'), plus = $('pPlus');
  if (minus) minus.addEventListener('click', () => { state.people = Math.max(2, state.people - 1); renderBill(); wireHead(); });
  if (plus) plus.addEventListener('click', () => { state.people = Math.min(8, state.people + 1); renderBill(); wireHead(); });
  const cust = $('custAmt');
  if (cust) cust.addEventListener('input', () => {
    state.customDollars = cust.value;
    const sa = $('shareAmt'); if (sa) sa.textContent = fmt(shareCents());
    const btn = $('toCardBtn');
    if (btn) { btn.textContent = t('payBtn', { amt: fmt(dueCents()) }); btn.disabled = shareCents() <= 0; }
  });
  $('toCardBtn').addEventListener('click', () => { state.phase = 'card'; setStep(3); render(); });
}

function renderCard() {
  phoneApp.innerHTML =
    headHtml() +
    '<div class="g-body">' +
      '<div class="g-card"><div class="g-total" style="padding-top:0;"><span>' + t('totalBill') + '</span><span>' + fmt(dueCents()) + '</span></div>' +
      '<p style="font-size:0.83rem;color:var(--text-muted);">' + t('yourShare') + ' ' + fmt(shareCents()) + ' · ' + t('addTip') + ' ' + fmt(tipCents()) + '</p></div>' +
      '<button class="g-applepay" id="applePayBtn">Pay with Apple&nbsp;Pay</button>' +
      '<div class="g-or">' + t('orPayWithCard') + '</div>' +
      '<div class="g-card"><h4>' + t('cardWord') + '</h4>' +
      '<input class="g-input" id="ccNum" value="4242 4242 4242 4242" inputmode="numeric" aria-label="' + t('cardNumber') + '">' +
      '<div style="display:flex;gap:8px;"><input class="g-input" value="12/28" aria-label="Expiry"><input class="g-input" value="424" inputmode="numeric" aria-label="CVC"></div>' +
      '<p style="font-size:0.78rem;color:var(--text-muted);">Demo only — this card is Square&rsquo;s public test card. Nothing is charged.</p></div>' +
    '</div>' +
    '<div class="g-paybar"><button class="g-pay" id="payBtn">' + t('payBtn', { amt: fmt(dueCents()) }) + '</button>' +
    '<div class="g-secure">' + t('secureNote') + '</div></div>';
  $('payBtn').addEventListener('click', doPay);
  $('applePayBtn').addEventListener('click', doPay);
}

function renderProcessing() {
  phoneApp.innerHTML = headHtml() +
    '<div class="g-body" style="text-align:center;padding-top:40px;"><div class="spin"></div>' +
    '<p style="font-weight:600;">' + t('processing') + '</p></div>';
}

function doPay() {
  state.phase = 'processing';
  render();
  feed('💳 Guest is paying…');
  $('liveChip').textContent = 'PAYING';
  $('liveChip').className = 'chip paying';
  setTimeout(() => {
    state.paid = true;
    state.phase = 'success';
    setStep(4);
    setLed();
    setDeviceStatus('Payment received ✓');
    $('liveChip').textContent = 'PAID ✓';
    $('liveChip').className = 'chip paid';
    $('liveSub').textContent = '4 guests · settled ' + fmt(dueCents());
    const secs = Math.max(1, Math.round((Date.now() - state.scanAt) / 1000));
    $('settleTimer').textContent = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
    feed('✅ Payment received — ' + fmt(dueCents()) + ' · Table 5 is PAID');
    render();
  }, 1400);
}

function receiptText() {
  const line = (l, r) => {
    const s = l + r;
    return l + ' '.repeat(Math.max(1, 32 - s.length)) + r;
  };
  const rows = ['          SAMPLE BISTRO', '             Table 5', '--------------------------------'];
  ITEMS.forEach((it) => rows.push(line((it.qty > 1 ? it.qty + ' x ' : '') + it.name, moneyPlain(it.qty * it.cents))));
  rows.push('--------------------------------');
  rows.push(line('Paid', moneyPlain(shareCents())));
  rows.push(line('Tip', moneyPlain(tipCents())));
  rows.push(line('TOTAL', moneyPlain(dueCents())));
  rows.push('--------------------------------', '           Thank you!', '        smarttablepay.com');
  return rows.join('\n');
}
function moneyPlain(cents) { return '$' + (cents / 100).toFixed(2); }

function doPrint() {
  $('receiptPaper').textContent = receiptText();
  $('receiptClip').classList.add('open');
  feed('🖨️ Receipt printed at Table 5&rsquo;s device');
}
function emailBlockHtml() {
  return '<div id="emailBlock" style="margin-top:6px;"><input class="g-input" id="rcEmail" type="email" placeholder="you@example.com" aria-label="Email">' +
    '<button class="g-opt" id="rcSend" style="text-align:center;background:var(--navy);color:#fff;border-color:var(--navy);">' + t('sendReceipt') + '</button></div>';
}

function renderSuccess() {
  const stars = [1, 2, 3, 4, 5].map((n) =>
    '<button type="button" data-star="' + n + '" class="' + (state.rated >= n ? 'lit' : '') + '" aria-label="' + n + ' stars">★</button>').join('');
  phoneApp.innerHTML =
    headHtml() +
    '<div class="g-body">' +
      '<div class="g-success"><div class="g-check">✓</div>' +
      '<h3 style="font-size:1.15rem;">' + t('paySuccess') + '</h3>' +
      '<p style="color:var(--text-muted);font-size:0.9rem;">' + t('thanksDining') + '</p></div>' +
      '<div class="g-card"><h4>' + t('receiptSummary') + '</h4>' +
        '<div class="g-item"><span>' + t('yourShare') + '</span><span class="amt">' + fmt(shareCents()) + '</span></div>' +
        '<div class="g-item"><span>' + t('addTip') + '</span><span class="amt">' + fmt(tipCents()) + '</span></div>' +
        '<div class="g-total"><span>' + t('totalSettled') + '</span><span>' + fmt(dueCents()) + '</span></div></div>' +
      '<div class="g-card"><h4>' + t('receiptOptions') + '</h4>' +
        '<div class="g-status" id="rcStatus"></div>' +
        '<button class="g-opt" data-rc="print">' + t('printReceipt') + '</button>' +
        '<button class="g-opt" data-rc="email">' + t('emailReceipt') + '</button>' +
        '<button class="g-opt" data-rc="both">' + t('printAndEmail') + '</button>' +
        '<button class="g-opt" data-rc="none">' + t('noReceipt') + '</button>' +
        '<div id="emailZone"></div></div>' +
      '<div class="g-card" style="text-align:center;"><h4>' + t('howWasIt') + '</h4>' +
        '<div class="g-stars" id="starRow">' + stars + '</div><div id="rateZone"></div></div>' +
    '</div>';

  phoneApp.querySelectorAll('[data-rc]').forEach((b) => b.addEventListener('click', () => {
    if (state.receiptDone) return;
    const kind = b.dataset.rc;
    const status = $('rcStatus');
    if (kind === 'print') {
      state.receiptDone = true;
      doPrint();
      status.textContent = t('receiptPrintedOk');
      lockReceiptButtons();
    } else if (kind === 'none') {
      state.receiptDone = true;
      status.textContent = t('noReceiptOk');
      lockReceiptButtons();
    } else {
      if (kind === 'both') {
        // Print fires IMMEDIATELY (same as the real product) — it is not
        // gated behind the email step. The email form opens in parallel.
        state.receiptDone = true;
        doPrint();
        status.textContent = t('receiptPrintedOk');
        lockReceiptButtons();
      }
      $('emailZone').innerHTML = emailBlockHtml();
      $('rcSend').addEventListener('click', () => {
        const v = $('rcEmail').value.trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { toast(t('validEmail')); return; }
        state.receiptDone = true;
        status.textContent = (kind === 'both' ? t('receiptPrintedOk') + ' · ' : '') + t('receiptSentTo', { email: v });
        feed('✉️ Receipt emailed to the guest');
        $('emailZone').innerHTML = '';
        lockReceiptButtons();
      });
    }
  }));

  phoneApp.querySelectorAll('[data-star]').forEach((b) => b.addEventListener('click', () => {
    state.rated = Number(b.dataset.star);
    const zone = $('rateZone');
    phoneApp.querySelectorAll('[data-star]').forEach((s) => s.classList.toggle('lit', Number(s.dataset.star) <= state.rated));
    if (state.rated >= 4) {
      zone.innerHTML = '<p style="font-size:0.88rem;color:var(--text-muted);">' + t('googleReviewHelp') + '</p>' +
        '<button class="g-opt" style="text-align:center;" id="gReviewBtn">' + t('leaveGoogleReview') + '</button>';
      $('gReviewBtn').addEventListener('click', () => toast('Demo — this would open the Google review page'));
      feed('⭐ Table 5 rated the visit ' + state.rated + '★');
    } else {
      zone.innerHTML = '<textarea class="g-input" rows="2" placeholder="' + t('commentPlaceholder') + '"></textarea>' +
        '<button class="g-opt" style="text-align:center;background:var(--navy);color:#fff;border-color:var(--navy);" id="fbBtn">' + t('sendFeedback') + '</button>';
      $('fbBtn').addEventListener('click', () => {
        zone.innerHTML = '<p style="font-size:0.88rem;color:var(--green);font-weight:600;">' + t('thanksFeedback') + ' — ' + t('wellWork') + '</p>';
        $('alertZone').innerHTML = '<div class="alert-row red"><span>🚨 Service Recovery — Table 5 rated ' + state.rated + '★. A manager can still turn this visit around.</span></div>';
        feed('🚨 Service Recovery alert — Table 5 rated ' + state.rated + '★ (private, not a public review)');
      });
      feed('⭐ Table 5 rated the visit ' + state.rated + '★');
    }
  }));
}
function lockReceiptButtons() {
  phoneApp.querySelectorAll('[data-rc]').forEach((b) => { b.disabled = true; });
}

/* ---------- replay ---------- */
$('replayBtn').addEventListener('click', () => {
  Object.assign(state, {
    phase: 'scan', mode: 'full', people: 2, customDollars: '50.00', tipPct: 15,
    serviceActive: false, paid: false, receiptDone: false, rated: 0, scanAt: null,
  });
  state.claims = new Set();
  setLed();
  setDeviceStatus('Scan to view & pay your bill');
  $('receiptClip').classList.remove('open');
  $('alertZone').innerHTML = '';
  $('liveChip').textContent = 'SEATED';
  $('liveChip').className = 'chip';
  $('liveSub').textContent = '4 guests · bill $130.00';
  $('settleTimer').textContent = '—';
  $('liveFeed').innerHTML = '<li><span class="ft">now</span><span>Table 5 seated — bill opened at $130.00</span></li>';
  setStep(1);
  render();
});

setStep(1);
render();
