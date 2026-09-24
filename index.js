const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
require('dotenv').config();

// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const SMSTWINS_API_KEY = process.env.SMSTWINS_API_KEY;
const API_BASE = 'https://api.smstwins.com/v1';

const bot = new Telegraf(BOT_TOKEN);

// ================= DATABASE SEDERHANA =================
const DB_FILE = path.join(__dirname, 'database.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = { users: {}, orders: {}, saldo: {} };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ================= HELPER: API SMSTWINS =================
async function getBalance() {
  try {
    const res = await axios.get(`${API_BASE}/balance`, {
      headers: { Authorization: `Bearer ${SMSTWINS_API_KEY}` }
    });
    return res.data;
  } catch (e) {
    return { error: e.response?.data?.message || e.message };
  }
}

async function orderNumber(service, country) {
  try {
    const res = await axios.post(`${API_BASE}/orders/create`, {
      service,
      country
    }, {
      headers: { Authorization: `Bearer ${SMSTWINS_API_KEY}` }
    });
    return res.data;
  } catch (e) {
    return { error: e.response?.data?.message || e.message };
  }
}

async function checkOrder(orderId) {
  try {
    const res = await axios.get(`${API_BASE}/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${SMSTWINS_API_KEY}` }
    });
    return res.data;
  } catch (e) {
    return { error: e.response?.data?.message || e.message };
  }
}

async function cancelOrder(orderId) {
  try {
    const res = await axios.post(`${API_BASE}/orders/${orderId}/cancel`, {}, {
      headers: { Authorization: `Bearer ${SMSTWINS_API_KEY}` }
    });
    return res.data;
  } catch (e) {
    return { error: e.response?.data?.message || e.message };
  }
}

// ================= START MENU =================
bot.start((ctx) => {
  const userId = ctx.from.id;
  const db = loadDB();
  
  if (!db.users[userId]) {
    db.users[userId] = {
      id: userId,
      username: ctx.from.username || 'unknown',
      saldo: 0,
      joined: new Date().toISOString()
    };
    saveDB(db);
  }

  const saldoUser = db.users[userId].saldo || 0;

  ctx.replyWithMarkdown(`
*🤖 NOKOS AUTO ORDER BOT*

Selamat datang, *${ctx.from.first_name}*!

💰 Saldo lu: *Rp ${saldoUser}*
🆔 ID: \`${userId}\`

Silakan pilih menu di bawah:
  `, Markup.inlineKeyboard([
    [Markup.button.callback('📱 Beli Nokos', 'menu_beli')],
    [Markup.button.callback('💰 Isi Saldo', 'menu_isi')],
    [Markup.button.callback('📋 Cek Order', 'menu_cek')],
    [Markup.button.callback('👤 Profile', 'menu_profile')]
  ]));
});

// ================= MENU: BELI NOKOS =================
bot.action('menu_beli', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(`
*📱 PILIH LAYANAN*

Pilih layanan yang mau lu verifikasi:
  `, Markup.inlineKeyboard([
    [Markup.button.callback('💬 Telegram', 'beli_tg')],
    [Markup.button.callback('📸 Instagram', 'beli_ig')],
    [Markup.button.callback('🎵 TikTok', 'beli_tt')],
    [Markup.button.callback('🟢 WhatsApp', 'beli_wa')],
    [Markup.button.callback('🔙 Kembali', 'back_start')]
  ], { columns: 2 }));
});

bot.action(/^beli_(tg|ig|tt|wa)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const service = ctx.match[1];
  const country = 6; // Indonesia (sesuai katalog SMSTwins)
  
  await ctx.editMessageText(`⏳ Sedang order nomor *${service.toUpperCase()}*...`);
  
  const result = await orderNumber(service, country);
  
  if (result.error) {
    return ctx.editMessageText(`❌ Gagal order: ${result.error}`, 
      Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'menu_beli')]]));
  }

  // Simpan order ke database
  const db = loadDB();
  const orderId = result.id || result.activationId;
  db.orders[orderId] = {
    id: orderId,
    userId: ctx.from.id,
    service,
    phone: result.phone,
    status: 'PENDING',
    createdAt: new Date().toISOString()
  };
  saveDB(db);

  await ctx.editMessageText(`
✅ *ORDER BERHASIL*

📱 Layanan: *${service.toUpperCase()}*
📞 Nomor: \`${result.phone}\`
🆔 Order ID: \`${orderId}\`
📌 Status: *MENUNGGU OTP*

Silakan masukkan nomor di atas ke layanan yang mau diverifikasi.
Bot akan otomatis kasih tau kalo OTP udah masuk!
  `, Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Cek OTP', `cek_order_${orderId}`)],
    [Markup.button.callback('❌ Cancel Order', `cancel_order_${orderId}`)]
  ]));
});

// ================= CEK OTP =================
bot.action(/^cek_order_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const orderId = ctx.match[1];
  const db = loadDB();
  const order = db.orders[orderId];

  if (!order) return ctx.editMessageText('❌ Order gak ditemukan!');

  const result = await checkOrder(orderId);

  if (result.error) {
    return ctx.editMessageText(`⏳ OTP belum masuk. Coba lagi nanti.\n\nError: ${result.error}`);
  }

  if (result.code || result.otp) {
    const otp = result.code || result.otp;
    order.status = 'COMPLETED';
    order.otp = otp;
    saveDB(db);
    
    return ctx.editMessageText(`
✅ *OTP DITERIMA!*

📱 Layanan: *${order.service.toUpperCase()}*
📞 Nomor: \`${order.phone}\`
🔑 OTP: \`${otp}\`

_Gunakan OTP ini untuk verifikasi. Jangan sampai kadaluarsa!_
    `);
  }

  ctx.editMessageText(`
⏳ *OTP BELUM MASUK*

📱 Layanan: *${order.service.toUpperCase()}*
📞 Nomor: \`${order.phone}\`
🔄 Status: *PENDING*

Coba cek lagi dalam 10-20 detik.
  `, Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Cek Lagi', `cek_order_${orderId}`)],
    [Markup.button.callback('❌ Cancel Order', `cancel_order_${orderId}`)]
  ]));
});

// ================= CANCEL ORDER =================
bot.action(/^cancel_order_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const orderId = ctx.match[1];
  const db = loadDB();

  const result = await cancelOrder(orderId);
  
  if (db.orders[orderId]) {
    db.orders[orderId].status = 'CANCELLED';
    saveDB(db);
  }

  ctx.editMessageText(`❌ Order \`${orderId}\` dibatalkan. Refund otomatis.`);
});

// ================= MENU: ISI SALDO =================
bot.action('menu_isi', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(`
*💰 ISI SALDO*

Kirim nominal yang mau lu top up (minimal Rp 10.000):

Contoh: \`50000\`
  `, Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Kembali', 'back_start')]
  ]));
});

// ================= MENU: CEK ORDER =================
bot.action('menu_cek', async (ctx) => {
  await ctx.answerCbQuery();
  const db = loadDB();
  const userOrders = Object.values(db.orders).filter(o => o.userId === ctx.from.id);

  if (userOrders.length === 0) {
    return ctx.editMessageText('📋 Belum ada order.', 
      Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'back_start')]]));
  }

  let text = '*📋 RIWAYAT ORDER*\n\n';
  userOrders.slice(-5).forEach((o, i) => {
    const statusEmoji = o.status === 'COMPLETED' ? '✅' : o.status === 'CANCELLED' ? '❌' : '⏳';
    text += `${i + 1}. ${statusEmoji} ${o.service.toUpperCase()} - ${o.phone}\n`;
    text += `   Status: ${o.status}\n\n`;
  });

  ctx.editMessageText(text, Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Kembali', 'back_start')]
  ]));
});

// ================= MENU: PROFILE =================
bot.action('menu_profile', async (ctx) => {
  await ctx.answerCbQuery();
  const db = loadDB();
  const user = db.users[ctx.from.id] || {};
  const orderCount = Object.values(db.orders).filter(o => o.userId === ctx.from.id).length;

  ctx.editMessageText(`
*👤 PROFILE*

🆔 ID: \`${ctx.from.id}\`
👤 Username: @${ctx.from.username || 'unknown'}
💰 Saldo: *Rp ${user.saldo || 0}*
📦 Total Order: *${orderCount}*
📅 Gabung: ${new Date(user.joined).toLocaleDateString('id-ID')}
  `, Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Kembali', 'back_start')]
  ]));
});

// ================= BACK TO START =================
bot.action('back_start', async (ctx) => {
  await ctx.answerCbQuery();
  const db = loadDB();
  const user = db.users[ctx.from.id] || {};
  
  await ctx.editMessageText(`
*🤖 NOKOS AUTO ORDER BOT*

💰 Saldo lu: *Rp ${user.saldo || 0}*
🆔 ID: \`${ctx.from.id}\`
  `, Markup.inlineKeyboard([
    [Markup.button.callback('📱 Beli Nokos', 'menu_beli')],
    [Markup.button.callback('💰 Isi Saldo', 'menu_isi')],
    [Markup.button.callback('📋 Cek Order', 'menu_cek')],
    [Markup.button.callback('👤 Profile', 'menu_profile')]
  ]));
});

// ================= HANDLE TOPUP =================
bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  
  // Skip command
  if (text.startsWith('/')) return;

  // Handle topup nominal
  if (/^\d+$/.test(text)) {
    const nominal = parseInt(text);
    const userId = ctx.from.id;
    
    if (nominal < 10000) {
      return ctx.reply('❌ Minimal topup Rp 10.000');
    }

    const db = loadDB();
    db.users[userId] = db.users[userId] || {};
    db.users[userId].pendingTopup = nominal;
    saveDB(db);

    ctx.replyWithMarkdown(`
*💰 TOPUP REQUEST*

Nominal: *Rp ${nominal.toLocaleString('id-ID')}*

Silakan transfer ke:
🏦 *BCA - 1234567890*
👤 *Nama Rekening*

Setelah transfer, kirim bukti transfer ke admin: @${ctx.from.username || 'admin'}

Admin akan konfirmasi dan saldo lu akan ditambah.
    `);
  }
});

// ================= ADMIN COMMANDS =================
bot.command('addsaldo', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Lu bukan admin!');
  
  const args = ctx.message.text.split(' ');
  const targetId = parseInt(args[1]);
  const nominal = parseInt(args[2]);

  if (!targetId || !nominal) {
    return ctx.reply('Format: /addsaldo <userId> <nominal>');
  }

  const db = loadDB();
  if (!db.users[targetId]) db.users[targetId] = { id: targetId, saldo: 0 };
  
  db.users[targetId].saldo = (db.users[targetId].saldo || 0) + nominal;
  saveDB(db);

  ctx.reply(`✅ Saldo ${targetId} ditambah Rp ${nominal.toLocaleString('id-ID')}`);
  
  // Notif ke user
  bot.telegram.sendMessage(targetId, `💰 Saldo lu ditambah *Rp ${nominal.toLocaleString('id-ID')}* oleh admin!`, { parse_mode: 'Markdown' })
    .catch(() => {});
});

bot.command('ceksaldo', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Lu bukan admin!');
  
  const saldo = await getBalance();
  ctx.reply(`💰 Saldo API SMSTwins: *${JSON.stringify(saldo)}*`, { parse_mode: 'Markdown' });
});

// ================= ERROR HANDLER =================
bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}:`, err);
  ctx.reply('❌ Terjadi error. Coba lagi nanti.').catch(() => {});
});

// ================= START BOT =================
console.log('🚀 Bot Nokos Auto Order started...');
bot.launch();

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
