require('dotenv').config();
const {
    Client, GatewayIntentBits, EmbedBuilder, REST, Routes,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, ModalBuilder, TextInputBuilder,
    TextInputStyle, ActivityType, MessageFlags
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const http = require('http');

// HTTP Keep-Alive Server for Free Web Services (Render / Koyeb)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot QUANTUMBLOX is online 24/7!\n');
}).listen(PORT, () => console.log(`[HTTP] Keep-Alive Web Server running on port ${PORT}`));

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function formatPrice(input) {
    if (!input || input === '0') return 'Rp. 0';
    const digits = input.toString().replace(/\D/g, '');
    if (digits === '') return input;
    return `Rp. ${new Intl.NumberFormat('id-ID').format(parseInt(digits))}`;
}

function safeStr(val, fallback = '—') {
    if (val === null || val === undefined) return fallback;
    const s = String(val).trim();
    return s.length > 0 ? s : fallback;
}

function safeTitle(prefix, text) {
    const combined = `${prefix} | ${text}`;
    return combined.length > 45 ? (combined.slice(0, 42) + '...') : combined;
}

function safeField(name, value, inline = false) {
    const n = safeStr(name);
    const v = safeStr(value);
    if (n === '—' || v === '—') return null;
    return { name: n.slice(0, 256), value: v.slice(0, 1024), inline: Boolean(inline) };
}

function safeUnix(createdAt) {
    try {
        if (!createdAt) return Math.floor(Date.now() / 1000);
        const ts = Math.floor(new Date(createdAt).getTime() / 1000);
        return (isFinite(ts) && ts > 0) ? ts : Math.floor(Date.now() / 1000);
    } catch { return Math.floor(Date.now() / 1000); }
}

function formatStockRow(s, index) {
    const content = safeStr(s?.content, '[empty]').replaceAll('|', ', ');
    const ts = safeUnix(s?.created_at);
    return `**${index + 1}.** \`${content}\` • <t:${ts}:R>`;
}

// ─────────────────────────────────────────────────────────────
// CUSTOM EMOJI SYSTEM
// ─────────────────────────────────────────────────────────────

const DEFAULT_EMOJI = {
    liveStock: {
        title: '', lastUpdate: '⏱️', product: '🛒', stock: '📦',
        price: '💰', format: '📋', info: '📝', id: '🆔'
    },
    auction: {
        title: '⚖️', statusActive: '🟢', statusInactive: '🛑',
        product: '📦', description: '📝', standing: '📊',
        endTime: '⏳', history: '📈', rules: '⚖️', lastUpdate: '🔄',
        highest: '🏆', bidder: '👤', remaining: '⏳'
    }
};

const EMOJI_LABELS = {
    liveStock: {
        title: 'Title Emoji', lastUpdate: 'Last Update', product: 'Product Name',
        stock: 'Stock', price: 'Price', format: 'Format', info: 'Info', id: 'ID'
    },
    auction: {
        title: 'Title Emoji', statusActive: 'Status Active', statusInactive: 'Status Inactive',
        product: 'Product Info', description: 'Description', standing: 'Current Standing',
        endTime: 'End Time', history: 'Bid History', rules: 'Rules', lastUpdate: 'Last Update',
        highest: 'Highest Bid', bidder: 'Bidder', remaining: 'Remaining'
    }
};

function getEmoji(system, key) {
    const config = loadConfig();
    const custom = config.customEmoji?.[system]?.[key];
    if (custom && custom.trim().length > 0) return custom.trim();
    return DEFAULT_EMOJI[system]?.[key] || '';
}

function isValidEmoji(str) {
    if (!str || str.trim().length === 0) return true; // empty = reset to default
    const s = str.trim();
    // Discord custom emoji: <:name:id> or <a:name:id>
    if (/^<a?:\w+:\d+>$/.test(s)) return true;
    // Unicode emoji (broad match: emoji-like chars, 1-8 codepoints)
    // Allow common emoji ranges including modifiers, ZWJ sequences
    const emojiRegex = /^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F|\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?|[\u200d\uFE0F])+$/u;
    if (emojiRegex.test(s) && s.length <= 20) return true;
    return false;
}

async function withRetry(fn, attempts = 3, delayMs = 1000) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (err) {
            const last = i === attempts - 1;
            if (!last) {
                const backoff = delayMs * (i + 1);
                console.warn(`[RETRY] Attempt ${i + 1}/${attempts} failed: ${err.message || err} — retrying in ${backoff}ms...`);
                await new Promise(r => setTimeout(r, backoff));
            } else {
                console.warn(`[RETRY] Attempt ${i + 1}/${attempts} failed: ${err.message || err} — giving up.`);
                throw err;
            }
        }
    }
}

let _lastPresenceRefresh = 0;
const PRESENCE_THROTTLE_MS = 300000; // 5 min minimum between refreshes

function refreshPresence(force = false) {
    const now = Date.now();
    if (!force && (now - _lastPresenceRefresh) < PRESENCE_THROTTLE_MS) return;
    try {
        client.user.setPresence({
            activities: [{ name: 'QUANTUMBLOX STORE', type: ActivityType.Watching }],
            status: 'online'
        });
        _lastPresenceRefresh = now;
    } catch (e) { console.warn('[PRESENCE] Refresh failed:', e.message); }
}

// ─────────────────────────────────────────────────────────────
// PROCESS ERROR HANDLERS (Resilient — no crash on timeout)
// ─────────────────────────────────────────────────────────────

process.on('unhandledRejection', err => {
    const msg = err?.message || String(err);
    if (msg.includes('Connect Timeout') || msg.includes('UND_ERR_CONNECT_TIMEOUT') || msg.includes('getaddrinfo')) {
        console.warn(`[NET] Transient connection error (suppressed): ${msg}`);
        return; // Don't crash on network blips
    }
    console.error('Unhandled Promise Rejection:', err);
});
process.on('uncaughtException', err => {
    const msg = err?.message || String(err);
    if (msg.includes('Connect Timeout') || msg.includes('UND_ERR_CONNECT_TIMEOUT') || msg.includes('getaddrinfo')) {
        console.warn(`[NET] Transient exception (suppressed): ${msg}`);
        return; // Don't crash on network blips
    }
    console.error('Uncaught Exception:', err);
});

// ─────────────────────────────────────────────────────────────
// DISCORD CLIENT
// ─────────────────────────────────────────────────────────────

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    rest: {
        timeout: 30000,    // 30s REST timeout (default 15s too aggressive for VPS)
        retries: 2         // Auto-retry failed REST requests
    }
});

const configPath = path.join(__dirname, 'config.json');
let dashboardMessageId = null; // Memory cache, but primary id is in config.json

// ─────────────────────────────────────────────────────────────
// BOT VERSION INFO
// ─────────────────────────────────────────────────────────────

const BOT_VERSION = {
    version: '5.0.0',
    codename: 'Grow A Garden Update',
    date: 'August 13, 2026',
    changelog: [
        { type: 'NEW', desc: 'Platform: Migrated from Pixel World to Grow A Garden 2 product catalog.' },
        { type: 'NEW', desc: 'Live Stock: Database monitor now displays Grow A Garden 2 products.' },
        { type: 'FIX', desc: 'Product PW renamed to Product Stock for clarity.' },
        { type: 'SYSTEM', desc: 'Removed: Auction zone features (bid blacklist, auction, win auction, bid delivery, bid transaction, product bid).' }
    ]
};

// ─────────────────────────────────────────────────────────────
// STATE CACHE
// ─────────────────────────────────────────────────────────────

// Auction system removed in v5.0.0

// ── Product Cache (30s TTL) ──
let _productCache = { data: null, ts: 0 };
const PRODUCT_CACHE_TTL = 30000;
async function getCachedProducts() {
    if (_productCache.data && (Date.now() - _productCache.ts) < PRODUCT_CACHE_TTL) return _productCache.data;
    const { data } = await supabase.from('products').select('*').order('name');
    if (data) { _productCache = { data, ts: Date.now() }; }
    return data || _productCache.data || [];
}
function invalidateProductCache() { _productCache.ts = 0; }

// ── Debounce Utility ──
const _debounceTimers = new Map();
function debounce(key, fn, delayMs = 2000) {
    if (_debounceTimers.has(key)) clearTimeout(_debounceTimers.get(key));
    _debounceTimers.set(key, setTimeout(() => { _debounceTimers.delete(key); fn().catch(() => {}); }, delayMs));
}

// ── Dashboard Change Detection ──
let _lastDashboardHash = '';
let _lastDashboardEditAt = 0;
let _lastAuctionHash = '';

// Ban cache removed — auction system removed in v5.0.0

// ─────────────────────────────────────────────────────────────
// DASHBOARD SYNC & LOCKS
// ─────────────────────────────────────────────────────────────

const UPDATE_LOCKS = new Map();

async function withLock(key, fn) {
    if (UPDATE_LOCKS.get(key)) return;
    UPDATE_LOCKS.set(key, true);
    try { return await fn(); }
    finally { UPDATE_LOCKS.set(key, false); }
}

async function getOrCreateDashboardMessage(channel, configKey, searchTitles = [], criteriaFn = null) {
    const config = loadConfig();
    const messageId = config[configKey];

    // 1. Try saved ID first
    if (messageId) {
        try {
            const m = await withRetry(() => channel.messages.fetch(messageId), 3, 3000);
            if (m && m.author.id === client.user.id) return m;
        } catch (e) {
            // Only clear config if it truly doesn't exist (404)
            if (e.code === 10008 || e.status === 404) {
                config[configKey] = null;
                saveConfig(config);
            }
        }
    }

    // 2. Deep Search (Limit 100)
    try {
        const msgs = await withRetry(() => channel.messages.fetch({ limit: 100 }), 3, 3000);
        const matches = msgs.filter(m => {
            if (m.author.id !== client.user.id) return false;
            if (criteriaFn) return criteriaFn(m);
            if (!m.embeds || m.embeds.length === 0) return false;

            const content = (m.embeds[0].title || '') + (m.embeds[0].description || '') + (m.embeds[0].footer?.text || '');
            const upperContent = content.toUpperCase();
            return searchTitles.some(t => upperContent.includes(t.toUpperCase()));
        });

        if (matches.size > 0) {
            const primary = matches.first();
            config[configKey] = primary.id;
            saveConfig(config);

            // Cleanup duplicates
            for (const [id, msg] of matches) {
                if (id !== primary.id) await msg.delete().catch(() => { });
            }
            return primary;
        }
    } catch (e) {
        console.error(`[SYNC] Search failed due to network/error for ${configKey}:`, e.message);
        throw e; // Propagate to caller to prevent 'send'
    }

    return null;
}

// ─────────────────────────────────────────────────────────────
// SCHEMA RESILIENCY
// ─────────────────────────────────────────────────────────────

let SCHEMA_SUPPORT = { system_type: false };

async function checkSchemaSupport() {
    try {
        const { error } = await supabase.from('products').select('system_type').limit(1);
        if (!error) {
            SCHEMA_SUPPORT.system_type = true;
            console.log('[SCHEMA] "system_type" column detected. Using primary separation.');
        } else {
            console.warn('[SCHEMA] "system_type" column missing. Using prefix-based fallback (AUC_).');
        }
    } catch {
        console.warn('[SCHEMA] Failed to verify system_type support. Using fallback.');
    }

    // Ensure sold_archive table exists (auto-create via RPC or test query)
    try {
        const { error } = await supabase.from('sold_archive').select('id').limit(1);
        if (error && error.code === '42P01') {
            console.warn('[SCHEMA] sold_archive table not found. Please create it in Supabase Dashboard.');
            console.warn('[SCHEMA] SQL: CREATE TABLE sold_archive (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, order_id text, product_id text, product_name text, buyer_id text, buyer_tag text, content text, qty int DEFAULT 1, amount numeric DEFAULT 0, sold_at timestamptz DEFAULT now());');
        } else {
            console.log('[SCHEMA] sold_archive table ready.');
        }
    } catch {
        console.warn('[SCHEMA] Could not verify sold_archive table.');
    }

    // Ensure orders table exists
    try {
        const { error } = await supabase.from('orders').select('id').limit(1);
        if (error && error.code === '42P01') {
            console.warn('[SCHEMA] orders table missing. Please run SQL to create orders table.');
            console.warn('[SCHEMA] SQL: CREATE TABLE orders (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, order_id text UNIQUE, product_id text, product_name text, buyer_id text, buyer_tag text, roblox_username text, qty int DEFAULT 1, amount numeric DEFAULT 0, status text DEFAULT \'Pending\', message_id text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());');
        } else {
            console.log('[SCHEMA] orders table ready.');
        }
    } catch {}
}

const ROBLOX_PAYMENTS_CACHE = new Map();
const ORDER_CHANNEL_ID = process.env.WAITING_LIST_CHANNEL_ID || process.env.ORDER_CHANNEL_ID || '1537397124445245562';

function isOrderAdmin(interaction) {
    if (!interaction) return false;
    const adminRoleId = process.env.ADMIN_ROLE_ID;
    if (!adminRoleId) return true;
    if (interaction.member?.roles) {
        if (Array.isArray(interaction.member.roles)) {
            return interaction.member.roles.includes(adminRoleId);
        }
        if (interaction.member.roles.cache) {
            return interaction.member.roles.cache.has(adminRoleId);
        }
    }
    if (interaction.memberPermissions?.has('Administrator') || interaction.member?.permissions?.has?.('Administrator')) {
        return true;
    }
    return false;
}

/**
 * Sends a Stock Alert notification to Channel ID 1537401300231266314 (📦 stock-alert)
 * @param {string} productName - Name of the product
 * @param {number} addedAmount - Amount of stock added
 */
async function sendStockAlertNotification(productName, addedAmount) {
    if (!productName || !addedAmount || addedAmount <= 0) return;

    const stockAlertChannelId = process.env.STOCK_ALERT_CHANNEL_ID || '1537401300231266314';
    try {
        const channel = await client.channels.fetch(stockAlertChannelId).catch(() => null);
        if (!channel) {
            console.warn(`[STOCK ALERT] Channel ${stockAlertChannelId} not found.`);
            return;
        }

        const embed = new EmbedBuilder()
            .setColor('#00b894')
            .setDescription(`${productName} has stocked ( + ${addedAmount} items )`);

        await channel.send({
            content: '@everyone',
            embeds: [embed],
            allowedMentions: { parse: ['everyone'] }
        }).catch(err => {
            console.error(`[STOCK ALERT FAIL] Could not send to ${stockAlertChannelId}:`, err.message);
        });

        console.log(`[STOCK ALERT] Alert sent: ${productName} (+${addedAmount} items)`);
    } catch (e) {
        console.error(`[STOCK ALERT ERROR]`, e.message);
    }
}

const ARCHIVED_ORDERS_SET = new Set();

async function safeDeferUpdate(interaction) {
    try {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferUpdate().catch(() => null);
        }
    } catch (e) {
        console.warn('[INTERACTION] deferUpdate warning:', e.message);
    }
}

async function safeUpdate(interaction, options) {
    try {
        if (interaction.deferred || interaction.replied) {
            return await interaction.editReply(options).catch(async () => {
                if (interaction.message && typeof interaction.message.edit === 'function') {
                    return await interaction.message.edit(options).catch(() => null);
                }
            });
        } else {
            return await interaction.update(options).catch(async () => {
                if (interaction.message && typeof interaction.message.edit === 'function') {
                    return await interaction.message.edit(options).catch(() => null);
                }
            });
        }
    } catch (e) {
        if (interaction.message && typeof interaction.message.edit === 'function') {
            return await interaction.message.edit(options).catch(() => null);
        }
    }
}

async function safeReply(interaction, options) {
    try {
        if (interaction.deferred || interaction.replied) {
            return await interaction.followUp(options).catch(() => null);
        } else {
            return await interaction.reply(options).catch(() => null);
        }
    } catch (e) {
        console.warn('[INTERACTION] safeReply warning:', e.message);
    }
}

async function dispatchOrderTicket(pay, robloxUsername, buyerUser) {
    try {
        const orderId = pay.invoice_id;
        const { data: p } = await supabase.from('products').select('*').eq('id', pay.product_id).maybeSingle();
        const productName = p?.name || pay.product_id;
        const buyerTag = buyerUser?.tag || buyerUser?.username || 'Unknown';
        const buyerId = pay.user_id;
        const rUsername = robloxUsername || pay.roblox_username || ROBLOX_PAYMENTS_CACHE.get(orderId) || 'N/A';
        const unixNow = Math.floor(Date.now() / 1000);

        const orderRecord = {
            order_id: orderId,
            product_id: pay.product_id,
            product_name: productName,
            buyer_id: buyerId,
            buyer_tag: buyerTag,
            roblox_username: rUsername,
            qty: pay.qty,
            amount: pay.amount,
            status: 'Pending Send',
            created_at: new Date().toISOString()
        };

        const { error: upsertErr } = await supabase.from('orders').upsert([orderRecord], { onConflict: 'order_id' });
        if (upsertErr) {
            console.error('[ORDER DISPATCH] Supabase orders upsert error:', upsertErr.message);
        }

        const channel = await client.channels.fetch(ORDER_CHANNEL_ID).catch(err => {
            console.error(`[ORDER DISPATCH] Failed to fetch channel ${ORDER_CHANNEL_ID}:`, err.message);
            return null;
        });

        if (!channel) {
            console.error(`❌ [ORDER DISPATCH CRITICAL ERROR] Target Order Channel ID ${ORDER_CHANNEL_ID} not found or bot lacks View/Send permissions!`);
            return false;
        }

        const fmtAmount = `Rp. ${new Intl.NumberFormat('id-ID').format(pay.amount)}`;

        const embed = new EmbedBuilder()
            .setTitle(`🛒 NEW ORDER \u2014 ${orderId}`)
            .setColor('#f1c40f')
            .setDescription('Pembayaran berhasil! Silakan Owner/Admin mengirimkan item ke Username Roblox di bawah, lalu tekan tombol **Done / Complete** jika selesai.')
            .addFields(
                { name: '👤 Username Roblox', value: `\`\`\`${rUsername}\`\`\``, inline: false },
                { name: '📦 Detail Produk', value: `**${productName}** (\`${pay.product_id}\`)`, inline: true },
                { name: '🔢 Jumlah', value: `\`${pay.qty} Pcs\``, inline: true },
                { name: '💰 Total Transaksi', value: `\`${fmtAmount}\``, inline: true },
                { name: '💰 Payment Status', value: `🟢 **Paid (Automatic)**`, inline: true },
                { name: '🚚 Delivery Status', value: `🟡 **Pending Send**`, inline: true },
                { name: '👤 Pembeli', value: `<@${buyerId}> (\`${buyerTag}\`)`, inline: true },
                { name: '🆔 Order ID', value: `\`${orderId}\``, inline: true },
                { name: '🕐 Waktu Order', value: `<t:${unixNow}:F> (<t:${unixNow}:R>)`, inline: false }
            )
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`btn_ord_proc_${orderId}`).setLabel('⚙️ Processing').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`btn_ord_done_${orderId}`).setLabel('✅ Done / Complete').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`btn_ord_cancel_${orderId}`).setLabel('❌ Cancel').setStyle(ButtonStyle.Danger)
        );

        const msg = await channel.send({ embeds: [embed], components: [row] });
        console.log(`✅ [ORDER DISPATCH SUCCESS] Ticket for Order ${orderId} (Roblox: "${rUsername}") sent to channel ${channel.name} (${ORDER_CHANNEL_ID})`);

        if (msg) {
            try {
                await supabase.from('orders').update({ message_id: msg.id }).eq('order_id', orderId);
            } catch (e) { }
        }
        return true;
    } catch (err) {
        console.error(`❌ [ORDER DISPATCH CRITICAL ERROR] Failed to send order ticket for ${pay?.invoice_id}:`, err);
        return false;
    }
}

async function processOrderPaymentSuccess(pay, robloxUsername, buyerUser) {
    const orderId = pay.invoice_id;

    // Delete from pending_payments FIRST to guarantee single execution & prevent backlog spam
    await supabase.from('pending_payments').delete().eq('invoice_id', orderId);

    const { data: p } = await supabase.from('products').select('*').eq('id', pay.product_id).maybeSingle();
    const currentStock = parseInt(p?.stock) || 0;

    if (p && currentStock > 0) {
        const newStock = Math.max(0, currentStock - pay.qty);
        await supabase.from('products').update({ stock: newStock }).eq('id', pay.product_id);
        invalidateProductCache();
    }

    const deliver = [`${pay.qty}x ${p?.name || pay.product_id}`];
    archiveSoldData({
        orderId,
        productId: pay.product_id,
        productName: p?.name || pay.product_id,
        buyerId: pay.user_id,
        buyerTag: buyerUser?.tag || buyerUser?.username || 'Unknown',
        items: deliver,
        qty: pay.qty,
        amount: pay.amount
    });

    const rUsername = robloxUsername || pay.roblox_username || ROBLOX_PAYMENTS_CACHE.get(orderId) || 'N/A';

    // Dispatch ticket directly to Discord Waiting List Channel
    const dispatchOk = await dispatchOrderTicket(pay, rUsername, buyerUser);

    const fmt = `Rp. ${new Intl.NumberFormat('id-ID').format(pay.amount)}`;
    const isAuction = pay.invoice_id.startsWith('AUC');

    // ── 1. Send History Log (HISTORY_LOG_CHANNEL_ID) ──
    const histChannelId = process.env.HISTORY_LOG_CHANNEL_ID || '1499793970241474684';
    if (histChannelId) {
        const histChannel = await client.channels.fetch(histChannelId).catch(() => null);
        if (histChannel) {
            await histChannel.send({
                embeds: [new EmbedBuilder()
                    .setTitle('Order Completed')
                    .setColor('#2d3436')
                    .addFields(
                        { name: 'Order ID', value: `\`${orderId}\``, inline: false },
                        { name: 'Buyer', value: `<@${pay.user_id}>`, inline: true },
                        { name: 'Product', value: p?.name || pay.product_id, inline: true },
                        { name: 'Qty', value: `${pay.qty}x`, inline: true },
                        { name: 'Total', value: fmt, inline: true },
                        { name: 'Process', value: 'Automatic', inline: true }
                    )
                    .setTimestamp()]
            }).catch(() => null);
        }
    }

    // ── 2. Send Payment Log (PAYMENT_LOG_CHANNEL_ID) ──
    const payLogChannelId = process.env.PAYMENT_LOG_CHANNEL_ID || '1501040112065319054';
    if (payLogChannelId) {
        const payLogChannel = await client.channels.fetch(payLogChannelId).catch(() => null);
        if (payLogChannel) {
            await payLogChannel.send({
                embeds: [new EmbedBuilder()
                    .setTitle('Payment Received')
                    .setColor('#0099ff')
                    .addFields(
                        { name: 'Order ID', value: `\`${orderId}\``, inline: false },
                        { name: 'Buyer', value: `<@${pay.user_id}>`, inline: true },
                        { name: 'Qty', value: `${pay.qty}x`, inline: true },
                        { name: 'Total', value: fmt, inline: true },
                        { name: 'Status', value: 'Completed', inline: true }
                    )
                    .setTimestamp()]
            }).catch(() => null);
        }
    }

    // ── 3. Assign Customer Role ──
    const costumerRoleId = process.env.COSTUMER_ROLE_ID;
    if (costumerRoleId && pay.user_id) {
        client.guilds.cache.forEach(async guild => {
            const member = await guild.members.fetch(pay.user_id).catch(() => null);
            if (member) {
                await member.roles.add(costumerRoleId).catch(() => null);
            }
        });
    }

    // DM Buyer receipt
    if (buyerUser) {
        const buyerEmbed = new EmbedBuilder()
            .setTitle(isAuction ? '🏆  Auction Item Delivered' : '✅  Order Confirmed & Paid')
            .setColor(isAuction ? '#f1c40f' : '#00b894')
            .setDescription(isAuction
                ? `Congratulations! Your auction item for **${pay.product_id.replace('AUCTION: ', '')}** has been delivered.`
                : 'Pembayaran Anda telah berhasil! Pesanan Anda telah masuk ke daftar tunggu pengiriman. Admin/Owner akan segera memproses pengiriman ke Username Roblox Anda.')
            .addFields(
                { name: 'Order ID', value: `\`${orderId}\``, inline: false },
                { name: 'Product', value: p?.name || pay.product_id, inline: true },
                { name: 'Quantity', value: `${pay.qty}x`, inline: true },
                { name: 'Total Paid', value: fmt, inline: true },
                { name: 'Delivery Status', value: '🟡 **Pending Send**', inline: true }
            )
            .setTimestamp();

        await buyerUser.send({ embeds: [buyerEmbed] }).catch(() => { });
    }

    return { success: true, dispatchOk };
}

async function autoCheckPendingPayments() {
    try {
        const { data: pendings, error } = await supabase.from('pending_payments').select('*').limit(30);

        // 1. Process pending_payments
        if (pendings && pendings.length > 0) {
            const FIVE_MINUTES_MS = 5 * 60 * 1000;
            const now = Date.now();

            for (const pay of pendings) {
                try {
                    // Idempotency check: if order is already in orders table with status != 'Pending', remove from pending_payments and skip
                    const { data: existingOrder } = await supabase.from('orders').select('order_id, status').eq('order_id', pay.invoice_id).maybeSingle();
                    if (existingOrder && existingOrder.status !== 'Pending') {
                        await supabase.from('pending_payments').delete().eq('invoice_id', pay.invoice_id);
                        continue;
                    }

                    const res = await axios.get(`https://app.pakasir.com/api/transactiondetail`, {
                        params: {
                            project: process.env.PAKASIR_SLUG,
                            amount: pay.amount,
                            order_id: pay.invoice_id,
                            api_key: process.env.PAKASIR_API_KEY
                        },
                        timeout: 10000
                    }).catch(() => null);

                    if (res?.data?.transaction?.status === 'completed') {
                        console.log(`[AUTO PAYMENT CHECK] Payment ${pay.invoice_id} verified as completed! Auto-processing order...`);
                        const buyerUser = await client.users.fetch(pay.user_id).catch(() => null);
                        const rUsername = pay.roblox_username || ROBLOX_PAYMENTS_CACHE.get(pay.invoice_id) || 'N/A';
                        await processOrderPaymentSuccess(pay, rUsername, buyerUser);
                        continue;
                    }

                    // Check 5-minute expiration
                    const createdAt = new Date(pay.created_at || now).getTime();
                    if (now - createdAt > FIVE_MINUTES_MS) {
                        console.log(`[AUTO CANCEL] Order ${pay.invoice_id} expired (> 5 minutes unpaid). Auto-cancelling...`);
                        await supabase.from('pending_payments').delete().eq('invoice_id', pay.invoice_id);
                        await supabase.from('orders').update({ status: 'Cancelled' }).eq('order_id', pay.invoice_id).eq('status', 'Pending');
                    }
                } catch (err) {
                    console.error(`[AUTO PAYMENT CHECK ERROR] Order ${pay.invoice_id}:`, err.message);
                }
            }
        }

        // 2. Clean up orphaned 'Pending' orders in orders table older than 5 minutes
        const fiveMinsAgoISO = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        await supabase.from('orders').update({ status: 'Cancelled' }).eq('status', 'Pending').lt('created_at', fiveMinsAgoISO).catch(() => null);

    } catch (e) {
        // silent error handling
    }
}

async function renderOrderManager(filterStatus = 'ACTIVE', searchQuery = null) {
    let query = supabase.from('orders').select('*').order('created_at', { ascending: false });

    if (searchQuery) {
        query = query.or(`roblox_username.ilike.%${searchQuery}%,order_id.ilike.%${searchQuery}%`);
    } else if (filterStatus === 'Pending' || filterStatus === 'Pending Send') {
        query = query.in('status', ['Pending', 'Pending Send']);
    } else if (filterStatus === 'Processing') {
        query = query.eq('status', 'Processing');
    } else if (filterStatus === 'Done') {
        query = query.eq('status', 'Done');
    } else if (filterStatus === 'ACTIVE') {
        query = query.in('status', ['Pending', 'Pending Send', 'Processing']);
    }

    const { data: orders } = await query.limit(15);
    const orderList = orders || [];

    const statusCountsRes = await supabase.from('orders').select('status');
    const allSt = statusCountsRes.data || [];
    const countPending = allSt.filter(o => o.status === 'Pending' || o.status === 'Pending Send').length;
    const countProc = allSt.filter(o => o.status === 'Processing').length;
    const countDone = allSt.filter(o => o.status === 'Done').length;

    let desc = `### 📦 Grow A Garden 2 \u2014 Order Manager\n`;
    desc += `📊 **Summary:** 🟡 Pending Send: \`${countPending}\` | 🔵 Processing: \`${countProc}\` | 🟢 Done: \`${countDone}\`\n\n`;
    desc += filterStatus === 'ACTIVE' ? `🔍 **Viewing:** \`Active Queue (Pending Send + Processing)\`\n\n` : `🔍 **Filter Status:** \`${filterStatus}\`\n\n`;

    if (searchQuery) desc += `🔎 **Pencarian:** "${searchQuery}" (${orderList.length} hasil)\n\n`;

    if (orderList.length === 0) {
        desc += `*Tidak ada orderan ditemukan.*`;
    } else {
        orderList.forEach((o, i) => {
            const stEmoji = o.status === 'Processing' ? '🔵' : o.status === 'Done' ? '🟢' : o.status === 'Cancelled' ? '🔴' : '🟡';
            const fmtAmt = `Rp. ${new Intl.NumberFormat('id-ID').format(o.amount || 0)}`;
            desc += `**${i + 1}. \`${o.order_id}\`** • Roblox: \`${o.roblox_username || 'N/A'}\`\n`;
            desc += `└ Produk: **${o.product_name}** (${o.qty}x) • Total: \`${fmtAmt}\` • Status: ${stEmoji} \`${o.status}\`\n`;
        });
    }

    const embed = new EmbedBuilder()
        .setTitle('📦 Order Management System')
        .setColor('#2b2d31')
        .setDescription(desc)
        .setTimestamp();

    const menu = new StringSelectMenuBuilder()
        .setCustomId('sel_order_filter')
        .setPlaceholder('Filter berdasarkan Status Order...')
        .addOptions([
            { label: 'Active Queue (Pending Send + Processing)', description: 'Sembunyikan orderan yang sudah Done', value: 'filter_ACTIVE', emoji: '📋' },
            { label: 'Pending Send Only', description: `Orderan belum dikirim (${countPending})`, value: 'filter_Pending', emoji: '🟡' },
            { label: 'Processing Only', description: `Orderan sedang diproses (${countProc})`, value: 'filter_Processing', emoji: '🔵' },
            { label: 'Done Only (Archived)', description: `Arsip orderan selesai (${countDone})`, value: 'filter_Done', emoji: '🟢' },
            { label: 'All History', description: 'Semua riwayat transaksi', value: 'filter_ALL', emoji: '📂' }
        ]);

    const btnSearch = new ButtonBuilder()
        .setCustomId('btn_order_search')
        .setLabel('Search Roblox / Order ID')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🔎');

    const rowMenu = new ActionRowBuilder().addComponents(menu);
    const rowBtn = new ActionRowBuilder().addComponents(btnSearch);

    return { embeds: [embed], components: [rowMenu, rowBtn] };
}

// Archive sold stock items to sold_archive table
async function archiveSoldData({ orderId, productId, productName, buyerId, buyerTag, items, qty, amount }) {
    try {
        const rows = items.map(content => ({
            order_id: orderId,
            product_id: productId,
            product_name: productName || productId,
            buyer_id: buyerId,
            buyer_tag: buyerTag || 'Unknown',
            content: content,
            qty: 1,
            amount: Math.round(amount / qty),
            sold_at: new Date().toISOString()
        }));
        const { error } = await supabase.from('sold_archive').insert(rows);
        if (error) console.warn('[SOLD] Archive insert failed:', error.message);
        else console.log(`[SOLD] Archived ${rows.length} items for order ${orderId}`);
    } catch (e) {
        console.warn('[SOLD] Archive error:', e.message);
    }
}

// One-time migration: scan history log and import past orders into sold_archive
async function migrateSoldArchive() {
    const config = loadConfig();
    if (config.soldArchiveMigrated === 'v4.0') {
        console.log('[SOLD] Archive migration already completed — skipping.');
        return;
    }

    const historyChannelId = process.env.HISTORY_LOG_CHANNEL_ID;
    if (!historyChannelId) return;

    const channel = await client.channels.fetch(historyChannelId).catch(() => null);
    if (!channel) return;

    console.log('[SOLD] Starting archive migration from history log...');
    let lastId = null;
    let scanned = 0;
    let imported = 0;
    let skipped = 0;

    while (true) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;

        const messages = await channel.messages.fetch(options).catch(() => null);
        if (!messages || messages.size === 0) break;

        const batch = [];

        for (const [, msg] of messages) {
            if (msg.author.id !== client.user.id || !msg.embeds?.length) continue;
            const embed = msg.embeds[0];
            const title = embed.title || '';

            if (title === 'Order Completed') {
                const getField = (name) => embed.fields?.find(f => f.name === name)?.value || '';
                const orderId = getField('Order ID').replace(/`/g, '').trim();
                const productId = getField('Product').trim();
                const buyerRaw = getField('Buyer');
                const buyerId = buyerRaw.match(/<@(\d+)>/)?.[1] || '';
                const qtyRaw = getField('Qty').replace(/\D/g, '');
                const qty = parseInt(qtyRaw) || 1;
                const totalRaw = getField('Total').replace(/[^0-9]/g, '');
                const amount = parseInt(totalRaw) || 0;
                const soldAt = msg.createdAt.toISOString();

                if (!orderId) continue;

                for (let i = 0; i < qty; i++) {
                    batch.push({
                        order_id: orderId,
                        product_id: productId,
                        product_name: productId,
                        buyer_id: buyerId,
                        buyer_tag: 'Historical',
                        content: '(migrated from history log)',
                        qty: 1,
                        amount: qty > 0 ? Math.round(amount / qty) : amount,
                        sold_at: soldAt
                    });
                }
            }

            if (title === 'AUCTION DELIVERY LOG') {
                const getField = (name) => embed.fields?.find(f => f.name === name)?.value || '';
                const orderId = getField('Order ID').replace(/`/g, '').trim();
                const productId = getField('Product').replace(/`/g, '').trim();
                const winnerRaw = getField('Winner');
                const buyerId = winnerRaw.match(/<@(\d+)>/)?.[1] || '';
                const soldAt = msg.createdAt.toISOString();

                if (!orderId) continue;

                batch.push({
                    order_id: orderId,
                    product_id: productId,
                    product_name: productId,
                    buyer_id: buyerId,
                    buyer_tag: 'Historical (Auction)',
                    content: '(migrated from history log)',
                    qty: 1,
                    amount: 0,
                    sold_at: soldAt
                });
            }
        }

        // Insert batch with duplicate skip
        if (batch.length > 0) {
            for (const row of batch) {
                // Check if order already exists
                const { data: existing } = await supabase
                    .from('sold_archive')
                    .select('id')
                    .eq('order_id', row.order_id)
                    .eq('sold_at', row.sold_at)
                    .limit(1);

                if (existing && existing.length > 0) {
                    skipped++;
                    continue;
                }

                const { error } = await supabase.from('sold_archive').insert([row]);
                if (!error) imported++;
                else skipped++;
            }
        }

        scanned += messages.size;
        lastId = messages.last().id;

        if (scanned >= 1000) break;
    }

    console.log(`[SOLD] Migration complete: scanned ${scanned} messages, imported ${imported} records, skipped ${skipped} duplicates.`);
    config.soldArchiveMigrated = 'v4.0';
    saveConfig(config);
}

async function safeInsertProduct(payload) {
    const data = { ...payload };
    if (!SCHEMA_SUPPORT.system_type) delete data.system_type;

    try {
        let res = await withRetry(() => supabase.from('products').insert([data]), 3, 1000).catch(e => ({ error: e }));
        if (res?.error && (res.error.code === '42703' || res.error.message?.includes('min_buy'))) {
            console.warn('[SCHEMA] "min_buy" column missing in database table "products". Retrying insert without min_buy field.');
            console.warn('[SCHEMA] To store Min Buy in DB, run in Supabase SQL Editor: ALTER TABLE products ADD COLUMN min_buy int DEFAULT 1;');
            delete data.min_buy;
            res = await withRetry(() => supabase.from('products').insert([data]), 3, 1000).catch(e => ({ error: e }));
        }
        return res || { error: null };
    } catch (e) {
        // If error has code 42703 and data had min_buy, attempt fallback without min_buy
        if (data.min_buy !== undefined) {
            delete data.min_buy;
            return await withRetry(() => supabase.from('products').insert([data]), 3, 1000).catch(e2 => ({ error: e2 }));
        }
        return { error: e };
    }
}

function isAuctionProduct(p) {
    if (!p) return false;
    if (p.system_type === 'auction') return true;
    if (p.id && (p.id.startsWith('AUC_') || p.id.startsWith('AUC-'))) return true;
    return false;
}

// ─────────────────────────────────────────────────────────────
// CONFIG HELPERS (Memory Optimized)
// ─────────────────────────────────────────────────────────────

let CONFIG_CACHE = null;

function loadConfig() {
    if (CONFIG_CACHE) return CONFIG_CACHE;
    try {
        if (!fs.existsSync(configPath)) {
            CONFIG_CACHE = {};
            return CONFIG_CACHE;
        }
        const data = fs.readFileSync(configPath, 'utf8');
        CONFIG_CACHE = JSON.parse(data);
        return CONFIG_CACHE;
    } catch (err) {
        console.error('Error loading config:', err);
        return CONFIG_CACHE || {};
    }
}

function saveConfig(data) {
    try {
        CONFIG_CACHE = { ...data };
        fs.writeFileSync(configPath, JSON.stringify(CONFIG_CACHE, null, 2), 'utf8');
        return true;
    }
    catch (err) {
        console.error('Error saving config:', err);
        return false;
    }
}

// ─────────────────────────────────────────────────────────────
// UNIFIED DATABASE MONITOR (v3.8.0)
// All Live Stock products in one embed — replaces per-product embeds
// ─────────────────────────────────────────────────────────────

async function updateUnifiedMonitor() {
    await withLock('unified_monitor', async () => {
        const config = loadConfig();
        const dbChannelId = process.env.PRODUCT_CHANNEL_ID || process.env.PRODUCT_PW_CHANNEL_ID || config.dashboardChannelId;
        if (!dbChannelId) { console.warn('[UNIFIED] Channel ID not set.'); return; }

        const channel = await client.channels.fetch(dbChannelId).catch(() => null);
        if (!channel) { console.error('[UNIFIED] Channel not accessible.'); return; }

        const allProducts = await getCachedProducts();
        const products = (allProducts || []).filter(p => !isAuctionProduct(p));

        const unixNow = Math.floor(Date.now() / 1000);

        // Build embed
        const hasMaint = products.some(p => config.maintenance?.[p.id]);
        const embed = new EmbedBuilder()
            .setTitle('🌱 DATABASE MONITOR | GROW A GARDEN 2 PRODUCTS')
            .setColor(hasMaint ? '#e67e22' : '#27ae60')
            .setTimestamp();

        if (config.embed?.thumbnail) { try { embed.setThumbnail(config.embed.thumbnail); } catch { /* skip */ } }

        const eLS = (key) => getEmoji('liveStock', key);
        const lastUpEmoji = eLS('lastUpdate') || '⏱️';
        const prodEmoji = eLS('product') || '📦';
        const stockEmoji = eLS('stock') || '📦';

        let description = '> Centralized stock monitoring for all Grow A Garden 2 products.\n\n';
        description += `${lastUpEmoji} **Last Update:** <t:${unixNow}:R>\n`;

        if (products.length === 0) {
            description += '\n*No products found. Add a product via Settings.*';
        } else {
            for (const p of products) {
                const isMaint = config.maintenance?.[p.id] || false;
                const currentStock = parseInt(p.stock) || 0;
                const statusEmoji = isMaint ? '🟠' : '🟢';
                const statusText = isMaint ? 'MAINTENANCE' : 'ACTIVE';

                const minBuy = Math.max(1, parseInt(p.min_buy) || 1);
                const minBuyStr = minBuy > 1 ? ` | **Min. Buy:** \`${minBuy}\`` : '';
                description += `\n━━━ \`${p.id}\` ━━━\n`;
                description += `${prodEmoji} **${p.name.toUpperCase()}**${isMaint ? ' `[MAINTENANCE]`' : ''}\n`;
                description += `> ${stockEmoji} **Total Stock:** \`${currentStock}\`${minBuyStr} | **Status:** ${statusEmoji} \`${statusText}\`\n`;
            }
        }

        // Discord embed description limit is 4096 chars
        if (description.length > 4096) {
            description = description.slice(0, 4090) + '\n...';
        }

        embed.setDescription(description);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_unified_add').setLabel('Add Stock').setEmoji('➕').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('btn_unified_edit').setLabel('Edit Stock').setEmoji('📝').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('btn_unified_del').setLabel('Delete Stock').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
        );

        // 1. Try saved unified monitor message ID
        const savedId = config.unifiedMonitorId;
        if (savedId) {
            try {
                const msg = await channel.messages.fetch(savedId);
                if (msg && msg.author.id === client.user.id) {
                    await withRetry(() => msg.edit({ embeds: [embed], components: [row] }), 3, 3000);
                    return;
                }
            } catch (e) {
                if (e.code === 10008 || e.status === 404) {
                    config.unifiedMonitorId = null;
                    saveConfig(config);
                }
            }
        }

        // 2. Search for existing unified monitor
        try {
            const msgs = await channel.messages.fetch({ limit: 100 });
            const matches = msgs.filter(m => {
                if (m.author.id !== client.user.id || !m.embeds?.length) return false;
                const title = m.embeds[0].title || '';
                return title.includes('DATABASE MONITOR') && title.includes('GROW A GARDEN 2 PRODUCTS');
            });

            if (matches.size > 0) {
                const primary = matches.first();
                config.unifiedMonitorId = primary.id;
                saveConfig(config);
                for (const [id, m] of matches) {
                    if (id !== primary.id) await m.delete().catch(() => { });
                }
                await withRetry(() => primary.edit({ embeds: [embed], components: [row] }), 3, 3000);
                return;
            }
        } catch { /* search failed */ }

        // 3. Create new
        const nMsg = await withRetry(() => channel.send({ embeds: [embed], components: [row] }), 3, 3000)
            .catch(e => console.error('[UNIFIED] Send failed:', e.message));
        if (nMsg) {
            config.unifiedMonitorId = nMsg.id;
            saveConfig(config);
        }
    });
}

// Backward compatibility: legacy per-product calls route to unified monitor (debounced)
async function updateDatabaseEmbed(_productId) {
    debounce('unified_monitor', () => updateUnifiedMonitor(), 1500);
}

// Migration: clean up old per-product monitor messages (runs once, saved to config)
async function migrateToUnifiedMonitor() {
    const config = loadConfig();

    // Skip if migration already completed
    if (config.migrationCompleted === 'unified_v3.8') {
        console.log('[MIGRATION] Already completed — skipping.');
        return;
    }

    console.log('[MIGRATION] Migrating to unified monitor...');
    const dbChannelId = process.env.PRODUCT_CHANNEL_ID || process.env.PRODUCT_PW_CHANNEL_ID || config.dashboardChannelId;
    if (!dbChannelId) return;

    const channel = await client.channels.fetch(dbChannelId).catch(() => null);
    if (!channel) return;

    // Collect old message IDs
    const oldIds = new Set();
    if (config.monitorMessages) {
        for (const [, msgId] of Object.entries(config.monitorMessages)) {
            if (msgId) oldIds.add(msgId);
        }
    }
    for (const [key, val] of Object.entries(config)) {
        if (key.startsWith('monitor_') && val) oldIds.add(val);
    }

    // Delete old per-product messages
    for (const msgId of oldIds) {
        try {
            const msg = await channel.messages.fetch(msgId);
            if (msg && msg.author.id === client.user.id) {
                await msg.delete();
                console.log(`[MIGRATION] Deleted old monitor: ${msgId}`);
            }
        } catch { /* already gone */ }
    }

    // Scan for any remaining old-style DATABASE MONITOR embeds (not unified)
    try {
        const msgs = await channel.messages.fetch({ limit: 100 });
        for (const [id, msg] of msgs) {
            if (msg.author.id !== client.user.id || !msg.embeds?.length) continue;
            const title = msg.embeds[0].title || '';
            if (title.includes('DATABASE MONITOR') && !title.includes('GROW A GARDEN 2 PRODUCTS')) {
                await msg.delete().catch(() => { });
                console.log(`[MIGRATION] Deleted legacy monitor embed: ${id}`);
            }
        }
    } catch { /* scan failed */ }

    // Clear old config keys & mark migration complete
    delete config.monitorMessages;
    for (const key of Object.keys(config)) {
        if (key.startsWith('monitor_')) delete config[key];
    }
    config.migrationCompleted = 'unified_v5.0';
    saveConfig(config);
    console.log('[MIGRATION] Migration complete — flagged as done.');
}

// ─────────────────────────────────────────────────────────────
// registerCommands
// ─────────────────────────────────────────────────────────────

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const commands = [];
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('[CMD] Slash commands registered (none active).');
    } catch (e) {
        console.error('[CMD] Failed to register slash commands:', e);
    }
}

// ─────────────────────────────────────────────────────────────
// updateDashboard
// ─────────────────────────────────────────────────────────────

async function updateDashboard() {
    await withLock('dashboard', async () => {
        const config = loadConfig();
        const allProducts = await getCachedProducts();
        if (!config || !allProducts) return;

        const products = allProducts.filter(p => !isAuctionProduct(p));

        // Change detection: skip API call if data unchanged AND last edit was recent (<60s)
        const emojiHash = JSON.stringify(config.customEmoji?.liveStock || {});
        const configHash = `${config.embed?.title}|${config.embed?.description}|${config.embed?.color}|${emojiHash}`;
        const hash = configHash + '||' + products.map(p => `${p.id}:${p.stock}:${p.price}`).join('|');
        const timeSinceLastEdit = Date.now() - _lastDashboardEditAt;
        if (hash === _lastDashboardHash && timeSinceLastEdit < 60000) return;
        _lastDashboardHash = hash;
        _lastDashboardEditAt = Date.now();

        const channel = await client.channels.fetch(process.env.STOCK_CHANNEL_ID || process.env.PW_STOCK_CHANNEL_ID || config.channelId).catch(() => null);
        if (!channel) return;

        // Dynamic emoji from config with fallback
        const eLS = (key) => getEmoji('liveStock', key);

        const embed = new EmbedBuilder()
            .setTitle(config.embed?.title || 'Shop Dashboard')
            .setDescription(config.embed?.description || 'Live stock updates.')
            .setColor(config.embed?.color || '#2b2d31')
            .setTimestamp();

        if (config.embed?.thumbnail) embed.setThumbnail(config.embed.thumbnail);
        const unixTime = Math.floor(Date.now() / 1000);
        const fields = [{ name: `${eLS('lastUpdate')} Last Update`, value: `<t:${unixTime}:R>`, inline: false }];
        products.forEach(p => {
            const isMaint = config.maintenance?.[p.id] || false;
            const minBuy = Math.max(1, parseInt(p.min_buy) || 1);
            const minBuyStr = minBuy > 1 ? `\n🛒 **Min. Buy:** \`${minBuy} Pcs\`` : '';
            fields.push({
                name: `${eLS('product')} ${p.name.toUpperCase()}${isMaint ? ' [MAINTENANCE]' : ''}`,
                value: `>>> ${eLS('stock')} **Stock:** \`${p.stock}\`\n${eLS('price')} **Price:** \`${p.price}\`${minBuyStr}`,
                inline: false
            });
        });
        embed.addFields(fields);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_register').setLabel('Register').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('btn_buy').setLabel('Buy Product').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('btn_admin_settings').setLabel('Setting').setStyle(ButtonStyle.Secondary)
        );

        // 1. Try saved message ID first (fastest, most reliable)
        const savedId = config.dashboardMessageId;
        if (savedId) {
            try {
                const existingMsg = await channel.messages.fetch(savedId);
                if (existingMsg && existingMsg.author.id === client.user.id) {
                    await withRetry(() => existingMsg.edit({ embeds: [embed], components: [row] }), 3, 3000);
                    return;
                }
            } catch (e) {
                if (e.code === 10008 || e.status === 404) {
                    config.dashboardMessageId = null;
                    saveConfig(config);
                }
            }
        }

        // 2. Fallback: search for any bot message with buttons (Register/Buy/Setting)
        try {
            const msgs = await channel.messages.fetch({ limit: 50 });
            const found = msgs.find(m => {
                if (m.author.id !== client.user.id) return false;
                return m.components?.length > 0 && m.embeds?.length > 0;
            });
            if (found) {
                config.dashboardMessageId = found.id;
                saveConfig(config);
                await withRetry(() => found.edit({ embeds: [embed], components: [row] }), 3, 3000);
                return;
            }
        } catch { /* search failed */ }

        // 3. No existing message — create new
        const nMsg = await withRetry(() => channel.send({ embeds: [embed], components: [row] }), 3, 3000).catch(e => console.error('[DASHBOARD] Send failed:', e.message));
        if (nMsg) {
            config.dashboardMessageId = nMsg.id;
            saveConfig(config);
        }
    });
}

// ─────────────────────────────────────────────────────────────
// updateVersionDashboard
// ─────────────────────────────────────────────────────────────

async function updateVersionDashboard() {
    await withLock('version', async () => {
        const channelId = process.env.VERSION_CHANNEL_ID;
        if (!channelId) return;

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) return;

        const tagMap = { NEW: '`[NEW]`', FIX: '`[FIX]`', SYSTEM: '`[SYS]`' };
        let changelogLines = BOT_VERSION.changelog.map(c => `${tagMap[c.type] || '`[---]`'}  ${c.desc}`).join('\n');
        if (changelogLines.length > 1024) changelogLines = changelogLines.slice(0, 1021) + '...';

        const uptime = process.uptime();
        const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`;

        const embed = new EmbedBuilder()
            .setTitle('GROW A GARDEN 2 — Version Dashboard')
            .setColor('#2b2d31')
            .setDescription(`**v${BOT_VERSION.version}** — ${BOT_VERSION.codename}\nReleased: ${BOT_VERSION.date}`)
            .addFields(
                { name: 'Changelog', value: changelogLines || 'No changes recorded.', inline: false },
                { name: 'Bot', value: `\`${client.user.tag}\``, inline: true },
                { name: 'Status', value: '\`Online\`', inline: true },
                { name: 'Uptime', value: `\`${uptimeStr}\``, inline: true },
                { name: 'Node.js', value: `\`${process.version}\``, inline: true },
                { name: 'Platform', value: `\`${process.platform}\``, inline: true },
                { name: 'Memory', value: `\`${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB\``, inline: true }
            )
            .setTimestamp();

        const config = loadConfig();
        if (config.embed?.thumbnail) { try { embed.setThumbnail(config.embed.thumbnail); } catch { /* skip */ } }

        const msg = await getOrCreateDashboardMessage(channel, 'versionMessageId', ['Version Dashboard']);
        if (msg) await msg.edit({ embeds: [embed] });
        else {
            const oldEmbeds = (await channel.messages.fetch({ limit: 50 })).filter(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('Bot Online'));
            for (const [, m] of oldEmbeds) await m.delete().catch(() => { });
            const nMsg = await channel.send({ embeds: [embed] });
            config.versionMessageId = nMsg.id;
            saveConfig(config);
        }
    });
}

// ─────────────────────────────────────────────────────────────
// updateCountingTrack
// ─────────────────────────────────────────────────────────────

let _countingMembersFetched = false;
let _totalSoldSynced = false;

// Scan history log channel to calculate real Total Sold from completed orders
async function syncTotalSoldFromHistory() {
    const config = loadConfig();
    // Skip if already synced (totalSold > 0 means data was calculated before)
    if (config.totalSold > 0) {
        console.log(`[COUNTING] Total Sold already synced: ${config.totalSold}`);
        return config.totalSold;
    }

    const historyChannelId = process.env.HISTORY_LOG_CHANNEL_ID;
    if (!historyChannelId) return 0;

    const channel = await client.channels.fetch(historyChannelId).catch(() => null);
    if (!channel) return 0;

    console.log('[COUNTING] Scanning history log for Total Sold...');
    let totalQty = 0;
    let lastId = null;
    let scanned = 0;

    // Paginate through all messages in history log
    while (true) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;

        const messages = await channel.messages.fetch(options).catch(() => null);
        if (!messages || messages.size === 0) break;

        for (const [, msg] of messages) {
            if (msg.author.id !== client.user.id || !msg.embeds?.length) continue;
            const title = msg.embeds[0].title || '';

            // Count from "Order Completed" embeds (auto + manual payments)
            if (title === 'Order Completed') {
                const qtyField = msg.embeds[0].fields?.find(f => f.name === 'Qty' || f.name === 'Quantity');
                if (qtyField) {
                    const qty = parseInt(qtyField.value.replace(/\D/g, ''));
                    if (!isNaN(qty)) totalQty += qty;
                }
            }

            // Count from "AUCTION DELIVERY LOG" embeds (1 item per auction)
            if (title === 'AUCTION DELIVERY LOG') {
                totalQty += 1;
            }
        }

        scanned += messages.size;
        lastId = messages.last().id;

        // Safety: max 1000 messages to prevent excessive scanning
        if (scanned >= 1000) break;
    }

    console.log(`[COUNTING] Scanned ${scanned} messages, Total Sold: ${totalQty}`);

    // Save to config for persistence
    config.totalSold = totalQty;
    saveConfig(config);
    return totalQty;
}

async function updateCountingTrack() {
    await withLock('counting_track', async () => {
        const channelId = process.env.COUNT_TRACK_CHANNEL_ID;
        if (!channelId) return;

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) return;

        const guild = channel.guild;

        // Fetch guild members once on first run for accurate cache
        if (!_countingMembersFetched) {
            await guild.members.fetch().catch(() => { });
            _countingMembersFetched = true;
        }

        // Sync Total Sold from history log on first run
        if (!_totalSoldSynced) {
            await syncTotalSoldFromHistory();
            _totalSoldSynced = true;
        }

        // Read fresh config (after potential sync)
        const config = loadConfig();

        // Total Members (non-bot, from cache)
        const totalMembers = guild.members.cache.filter(m => !m.user.bot).size;

        // Total Customers (members with customer role)
        const customerRoleId = process.env.CUSTOMER_ROLE_ID || process.env.COSTUMER_ROLE_ID;
        let totalCustomers = 0;
        if (customerRoleId) {
            const role = guild.roles.cache.get(customerRoleId);
            totalCustomers = role ? role.members.filter(m => !m.user.bot).size : 0;
        }

        // Total Sold (from synced config)
        const totalSold = config.totalSold || 0;

        const unixNow = Math.floor(Date.now() / 1000);

        const embed = new EmbedBuilder()
            .setTitle('GROW A GARDEN 2 — Server Statistics')
            .setColor('#2b2d31')
            .setDescription(
                `Realtime server and sales tracking.\n\n` +
                `**Total Members**\n` +
                `\`\`\`${totalMembers.toLocaleString('id-ID')}\`\`\`\n` +
                `**Total Customers**\n` +
                `\`\`\`${totalCustomers.toLocaleString('id-ID')}\`\`\`\n` +
                `**Total Sold**\n` +
                `\`\`\`${totalSold.toLocaleString('id-ID')}\`\`\``
            )
            .addFields(
                { name: 'Last Update', value: `<t:${unixNow}:R>`, inline: true }
            )
            .setTimestamp();

        // 1. Try saved message ID
        const savedId = config.countingTrackMessageId;
        if (savedId) {
            try {
                const msg = await channel.messages.fetch(savedId);
                if (msg && msg.author.id === client.user.id) {
                    await withRetry(() => msg.edit({ embeds: [embed] }), 3, 3000);
                    return;
                }
            } catch (e) {
                if (e.code === 10008 || e.status === 404) {
                    config.countingTrackMessageId = null;
                    saveConfig(config);
                }
            }
        }

        // 2. Search for existing counting embed
        try {
            const msgs = await channel.messages.fetch({ limit: 50 });
            const found = msgs.find(m => {
                if (m.author.id !== client.user.id || !m.embeds?.length) return false;
                return m.embeds[0].title?.includes('Server Statistics');
            });
            if (found) {
                config.countingTrackMessageId = found.id;
                saveConfig(config);
                await withRetry(() => found.edit({ embeds: [embed] }), 3, 3000);
                return;
            }
        } catch { /* search failed */ }

        // 3. Create new
        const nMsg = await withRetry(() => channel.send({ embeds: [embed] }), 3, 3000)
            .catch(e => console.error('[COUNTING] Send failed:', e.message));
        if (nMsg) {
            config.countingTrackMessageId = nMsg.id;
            saveConfig(config);
        }
    });
}

// ─────────────────────────────────────────────────────────────
// updateSoldDataDashboard (Search Panel)
// ─────────────────────────────────────────────────────────────

async function updateSoldDataDashboard() {
    await withLock('sold_data', async () => {
        const channelId = process.env.SOLD_DATA_CHANNEL_ID;
        if (!channelId) return;

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) return;

        const config = loadConfig();

        // Get total archived count
        let archiveCount = 0;
        try {
            const { count, error } = await supabase.from('sold_archive').select('id', { count: 'exact', head: true });
            if (!error && count !== null) archiveCount = count;
        } catch { /* table may not exist yet */ }

        const unixNow = Math.floor(Date.now() / 1000);

        const embed = new EmbedBuilder()
            .setTitle('GROW A GARDEN 2 — Sold Data Archive')
            .setColor('#2b2d31')
            .setDescription(
                `Search and lookup all sold product data.\n` +
                `All completed transactions are permanently archived here.\n\n` +
                `**Total Archived Records**\n` +
                `\`\`\`${archiveCount.toLocaleString('id-ID')}\`\`\`\n` +
                `**Search Criteria**\n` +
                `\`\`\`\n` +
                `Order ID    \u2014 Search by invoice/order ID\n` +
                `Product ID  \u2014 Search by product identifier\n` +
                `Buyer       \u2014 Search by buyer username\n` +
                `Content     \u2014 Search by product data/content\n` +
                `\`\`\``
            )
            .addFields(
                { name: 'Last Update', value: `<t:${unixNow}:R>`, inline: true }
            )
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_search_sold').setLabel('Search Sold Data').setStyle(ButtonStyle.Primary)
        );

        // 1. Try saved message ID
        const savedId = config.soldDataMessageId;
        if (savedId) {
            try {
                const msg = await channel.messages.fetch(savedId);
                if (msg && msg.author.id === client.user.id) {
                    await withRetry(() => msg.edit({ embeds: [embed], components: [row] }), 3, 3000);
                    return;
                }
            } catch (e) {
                if (e.code === 10008 || e.status === 404) {
                    config.soldDataMessageId = null;
                    saveConfig(config);
                }
            }
        }

        // 2. Search for existing
        try {
            const msgs = await channel.messages.fetch({ limit: 50 });
            const found = msgs.find(m => {
                if (m.author.id !== client.user.id || !m.embeds?.length) return false;
                return m.embeds[0].title?.includes('Sold Data Archive');
            });
            if (found) {
                config.soldDataMessageId = found.id;
                saveConfig(config);
                await withRetry(() => found.edit({ embeds: [embed], components: [row] }), 3, 3000);
                return;
            }
        } catch { /* search failed */ }

        // 3. Create new
        const nMsg = await withRetry(() => channel.send({ embeds: [embed], components: [row] }), 3, 3000)
            .catch(e => console.error('[SOLD] Dashboard send failed:', e.message));
        if (nMsg) {
            config.soldDataMessageId = nMsg.id;
            saveConfig(config);
        }
    });
}

// ─────────────────────────────────────────────────────────────
// ENTRY & LEAVE ZONE
// ─────────────────────────────────────────────────────────────

client.on('guildMemberAdd', async member => {
    try {
        const roleId = process.env.ENTRY_ROLE_ID;
        const channelId = process.env.ENTRY_LOG_CHANNEL_ID;

        // Give Entry Role
        if (roleId) {
            await member.roles.add(roleId).catch(e => console.error(`[ENTRY] Failed to add role to ${member.user.tag}: ${e.message}`));
        }

        // Send Log
        if (channelId) {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (channel) {
                const embed = new EmbedBuilder()
                    .setTitle('Member Joined')
                    .setColor('#00b894')
                    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                    .setDescription(`Welcome to the server, ${member}!`)
                    .addFields(
                        { name: 'User', value: `${member.user.tag} (\`${member.user.id}\`)`, inline: true },
                        { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true }
                    )
                    .setTimestamp();
                await channel.send({ embeds: [embed] }).catch(() => { });
            }
        }
    } catch (e) {
        console.error('[ENTRY] guildMemberAdd error:', e);
    }
    // Sync counting track on member join
    debounce('counting_track', () => updateCountingTrack(), 5000);
});

client.on('guildMemberRemove', async member => {
    try {
        const channelId = process.env.ENTRY_LOG_CHANNEL_ID;
        if (channelId) {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (channel) {
                const embed = new EmbedBuilder()
                    .setTitle('Member Left')
                    .setColor('#d63031')
                    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                    .setDescription(`${member.user.tag} has left the server.`)
                    .addFields(
                        { name: 'User', value: `${member.user.tag} (\`${member.user.id}\`)`, inline: true },
                        { name: 'Joined Server', value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Unknown', inline: true }
                    )
                    .setTimestamp();
                await channel.send({ embeds: [embed] }).catch(() => { });
            }
        }
    } catch (e) {
        console.error('[LEAVE] guildMemberRemove error:', e);
    }
    // Sync counting track on member leave
    debounce('counting_track', () => updateCountingTrack(), 5000);
});

// ─────────────────────────────────────────────────────────────
// HONEYPOT PROTECTION
// ─────────────────────────────────────────────────────────────

async function updateHoneypotWarning() {
    await withLock('honeypot', async () => {
        const channelId = process.env.HONEYPOT_CHANNEL_ID;
        if (!channelId) return;

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) return;

        const config = loadConfig();
        const bannedCount = config.honeypotBans || 0;

        const embed = new EmbedBuilder()
            .setTitle('⛔ Honeypot Protection Active')
            .setColor('#d63031')
            .setDescription(
                "“Don't send any message here,\n" +
                "Unless you want to get banned ⛔”\n\n" +
                "**System Explanation:**\n" +
                "This channel is used as a security countermeasure (Honeypot) to automatically detect and ban users or automated scripts spreading phishing links, malware, or hacked Discord accounts.\n\n" +
                "By sending a message here, you are flagged as a malicious actor and will be **permanently banned** from this server immediately."
            )
            .addFields(
                { name: '⏱️ Last Update', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
                { name: '🛡️ Total User Banned', value: `\`${bannedCount}\``, inline: true }
            )
            .setTimestamp();

        const msg = await getOrCreateDashboardMessage(channel, 'honeypotMessageId', ['Honeypot Protection']);
        if (msg) {
            await msg.edit({ embeds: [embed] });
        } else {
            // Only search & delete ALL others if none recognized
            const messages = await channel.messages.fetch({ limit: 100 });
            for (const [, m] of messages) await m.delete().catch(() => { });
            const nMsg = await channel.send({ embeds: [embed] });
            config.honeypotMessageId = nMsg.id;
            saveConfig(config);
        }
    });
}

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const honeypotId = process.env.HONEYPOT_CHANNEL_ID;
    if (message.channelId === honeypotId) {
        // Exempt Admin role
        const adminRoleId = process.env.ADMIN_ROLE_ID;
        if (message.member?.roles.cache.has(adminRoleId)) return;

        const logChannelId = process.env.RESTRICTED_LOG_CHANNEL_ID;
        const banReason = `Automatic Banned User Type in Channel https://discord.com/channels/${message.guildId}/${honeypotId}`;

        try {
            // Instant delete for security
            await message.delete().catch(() => { });

            // Increment ban counter
            const config = loadConfig();
            config.honeypotBans = (config.honeypotBans || 0) + 1;
            saveConfig(config);

            // Log before ban
            if (logChannelId) {
                const logChannel = await client.channels.fetch(logChannelId).catch(() => null);
                if (logChannel) {
                    const embed = new EmbedBuilder()
                        .setTitle('🛡️ Security Enforcement: User Banned')
                        .setColor('#d63031')
                        .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
                        .setDescription(`A user has been automatically banned for typing in the restricted protection channel.`)
                        .addFields(
                            { name: 'User', value: `${message.author.tag} (\`${message.author.id}\`)`, inline: true },
                            { name: 'Channel', value: `<#${honeypotId}>`, inline: true },
                            { name: 'Reason', value: `\`Honeypot Triggered\``, inline: false },
                            { name: 'Message Content', value: `\`\`\`${message.content.substring(0, 500) || '(Empty)'}\`\`\`` }
                        )
                        .setTimestamp();
                    await logChannel.send({ embeds: [embed] }).catch(() => { });
                }
            }

            // Ban user (with 1 hour message deletion redundancy)
            await message.member.ban({ reason: banReason, deleteMessageSeconds: 3600 });
            console.log(`[HONEYPOT] Banned ${message.author.tag}. Total bans: ${config.honeypotBans}`);

            // Refresh warning embed to show new count and timestamp
            updateHoneypotWarning();
        } catch (err) {
            console.error(`[HONEYPOT] Failed to ban user: ${err.message}`);
        }
    }
});

// ─────────────────────────────────────────────────────────────
// INTERACTION SAFETY ENGINE
// ─────────────────────────────────────────────────────────────

/**
 * Ensures a response is sent even if the interaction has already been deferred/replied.
 * Gracefully handles DiscordAPIError[10062]: Unknown interaction.
 */
async function safeReply(interaction, options) {
    try {
        if (!interaction.isRepliable()) return;
        if (interaction.deferred || interaction.replied) {
            return await interaction.editReply(options);
        }
        return await interaction.reply(options);
    } catch (e) {
        if (e.code === 10062) return;
        if (e.code === 'UND_ERR_CONNECT_TIMEOUT' || e.message?.includes('Connect Timeout')) return;
        // Fallback: try followUp if reply/editReply both failed
        try { return await interaction.followUp({ ...options, flags: [MessageFlags.Ephemeral] }); } catch { /* exhausted */ }
    }
}

async function safeDefer(interaction, ephemeral = true) {
    try {
        if (interaction.deferred || interaction.replied) return;
        await interaction.deferReply({ flags: ephemeral ? [MessageFlags.Ephemeral] : [] });
    } catch (e) {
        if (e.code === 10062 || e.message?.includes('Connect Timeout')) return;
    }
}

async function safeModal(interaction, modal) {
    try {
        if (interaction.deferred || interaction.replied) return;
        await interaction.showModal(modal);
    } catch (e) {
        if (e.code === 10062 || e.message?.includes('Connect Timeout')) return;
    }
}

async function safeUpdate(interaction, options) {
    try {
        if (!interaction.isRepliable()) return;
        if (interaction.deferred || interaction.replied) {
            return await interaction.editReply(options);
        }
        return await interaction.update(options);
    } catch (e) {
        if (e.code === 10062 || e.message?.includes('Connect Timeout')) return;
    }
}

async function safeDeferUpdate(interaction) {
    try {
        if (!interaction.isRepliable()) return;
        if (interaction.deferred || interaction.replied) return;
        return await interaction.deferUpdate();
    } catch (e) {
        if (e.code === 10062 || e.message?.includes('Connect Timeout')) return;
    }
}

// ─────────────────────────────────────────────────────────────
// INTERACTION HANDLER
// ─────────────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
    try {
        // ── 1. INSTANT ACKNOWLEDGEMENT (Priority #1) ──
        // Determine if we should defer (Buttons/Menus) or skip (Modals)
        const modalIDPrefixes = ['btn_ord_proc_', 'btn_ord_done_', 'btn_ord_cancel_', 'btn_db_add_', 'btn_db_edit_pick_', 'btn_db_del_pick_', 'btn_search_sold', 'sel_db_edit_', 'sel_p_edit_pick', 'sel_buy', 'sel_emoji_ls_pick', 'sel_unified_add_pick', 'sel_unified_edit_pick', 'sel_unified_del_pick'];
        const selectModalOptions = ['opt_add_p', 'opt_manual_pay', 'opt_config'];

        const isModalTrigger = modalIDPrefixes.some(pre => interaction.customId?.startsWith(pre)) ||
            (interaction.isStringSelectMenu() && selectModalOptions.includes(interaction.values[0]));

        // Secure the 3-second window IMMEDIATELY — always use deferReply (ephemeral)
        // deferUpdate would ONLY edit the original message and break new replies
        if (interaction.isRepliable() && !isModalTrigger && !interaction.isModalSubmit()) {
            await safeDefer(interaction);
        }

        // ── 2. LOGGING & SECURITY (Priority #2 - Occurs after acknowledgement) ──
        console.log(`[INTERACTION] ${interaction.user.tag} -> ${interaction.customId || 'N/A'}`);

        // Check admin role to enforce bypass

        // ── SLASH COMMANDS ────────────────────────────────────
        // No slash commands active in v5.0.0 (Auction system removed)
        if (interaction.isChatInputCommand()) {
            return safeReply(interaction, { content: 'No commands available. Please use dashboard buttons.', flags: [MessageFlags.Ephemeral] });
        }

        // ═════════════════════════════════════════════════════
        // BUTTONS
        // ═════════════════════════════════════════════════════
        if (interaction.isButton()) {
            // ── btn_buy ───────────────────────────────────────
            if (interaction.customId === 'btn_buy') {
                // Parallelize user check and cached products fetch
                const [userRes, allProducts] = await Promise.all([
                    supabase.from('users').select('id').eq('id', interaction.user.id).single(),
                    getCachedProducts()
                ]);

                if (!userRes.data) return safeReply(interaction, { content: '❌ Please register first by clicking the **Register** button.' });

                const products = (allProducts || []).filter(p => !isAuctionProduct(p));
                const config = loadConfig();
                if (!products || products.length === 0) return safeReply(interaction, { content: '❌ No products available at the moment.' });

                const s = new StringSelectMenuBuilder()
                    .setCustomId('sel_buy')
                    .setPlaceholder('Choose a product to purchase...')
                    .addOptions(products.map(x => {
                        const isMaint = config.maintenance?.[x.id] || false;
                        return {
                            label: `${x.name}${isMaint ? ' [MAINTENANCE]' : ''}`,
                            description: isMaint ? '🛑 Product is currently under maintenance.' : `Stock: ${x.stock} | Price: ${x.price}`,
                            value: x.id
                        };
                    }));

                return safeReply(interaction, { components: [new ActionRowBuilder().addComponents(s)] });
            }

            // ── btn_search_sold ──────────────────────────────
            if (interaction.customId === 'btn_search_sold') {
                if (!interaction.member.roles.cache.has(process.env.ADMIN_ROLE_ID))
                    return safeReply(interaction, { content: '❌ Only admins can search sold data.', flags: [MessageFlags.Ephemeral] });

                const modal = new ModalBuilder().setCustomId('mod_search_sold').setTitle('Search Sold Data');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('search_query').setLabel('Search Query').setStyle(TextInputStyle.Short).setPlaceholder('Order ID, Product ID, username, or content').setRequired(true).setMaxLength(200)
                    )
                );
                return interaction.showModal(modal);
            }

            // ── btn_admin_settings ────────────────────────────
            if (interaction.customId === 'btn_admin_settings') {
                if (!interaction.member.roles.cache.has(process.env.ADMIN_ROLE_ID))
                    return safeReply(interaction, { content: '❌ Only admins can access settings.', flags: [MessageFlags.Ephemeral] });

                const menu = new StringSelectMenuBuilder()
                    .setCustomId('sel_admin_menu')
                    .setPlaceholder('Choose an administrative action...')
                    .addOptions([
                        { label: 'Order Manager', description: 'Filter & kelola antrean order pembeli', value: 'opt_manage_orders', emoji: '📦' },
                        { label: 'Add Product', description: 'Create a new product listing', value: 'opt_add_p', emoji: '➕' },
                        { label: 'Edit Product', description: 'Update price or name of a product', value: 'opt_edit_p', emoji: '📝' },
                        { label: 'Maintenance Status', description: 'Enable/disable maintenance for products', value: 'opt_maintenance', emoji: '🛠️' },
                        { label: 'Delete Product', description: 'Remove a product from the shop', value: 'opt_del_p', emoji: '🗑️' },
                        { label: 'Manual Confirm Pay', description: 'Force fulfill an order by ID', value: 'opt_manual_pay', emoji: '✅' },
                        { label: 'Config Dashboard', description: 'Change title, color, or description', value: 'opt_config', emoji: '⚙️' },
                        { label: 'Set Custom Emoji', description: 'Change dashboard emoji/icons', value: 'opt_custom_emoji', emoji: '🎨' }
                    ]);

                return safeReply(interaction, {
                    content: '🛠️ **Admin Settings Menu**\nChoose what you would like to manage below:',
                    components: [new ActionRowBuilder().addComponents(menu)],
                    flags: [MessageFlags.Ephemeral]
                });
            }

            // ── btn_register ──────────────────────────────────
            if (interaction.customId === 'btn_register') {
                const { data: user } = await supabase.from('users').select('id').eq('id', interaction.user.id).single();
                if (user) return safeReply(interaction, { content: '⚠️ You are already registered!' });

                const { error: insertErr } = await supabase.from('users').insert([{ id: interaction.user.id }]);
                if (insertErr) return safeReply(interaction, { content: `❌ Registration failed: ${insertErr.message}` });

                return safeReply(interaction, { content: '✅ Successfully registered! You can now buy products.' });
            }

            // ── btn_unified_add ────────────────────────────────
            if (interaction.customId === 'btn_unified_add') {
                if (!isOrderAdmin(interaction))
                    return safeReply(interaction, { content: '❌ Hanya Owner/Admin yang memiliki akses.', flags: [MessageFlags.Ephemeral] });

                const allProducts = await getCachedProducts();
                const products = (allProducts || []).filter(p => !isAuctionProduct(p));
                if (products.length === 0) return safeReply(interaction, { content: '❌ No Live Stock products found.', flags: [MessageFlags.Ephemeral] });

                const menu = new StringSelectMenuBuilder().setCustomId('sel_unified_add_pick').setPlaceholder('Select a product to add stock to...');
                products.forEach(p => menu.addOptions({ label: p.name, description: `ID: ${p.id} | Stock: ${p.stock}`, value: p.id }));

                return safeReply(interaction, { content: '📦 **Add Stock**\nSelect the target product:', components: [new ActionRowBuilder().addComponents(menu)], flags: [MessageFlags.Ephemeral] });
            }

            // ── btn_unified_edit ───────────────────────────────
            if (interaction.customId === 'btn_unified_edit') {
                if (!isOrderAdmin(interaction))
                    return safeReply(interaction, { content: '❌ Hanya Owner/Admin yang memiliki akses.', flags: [MessageFlags.Ephemeral] });

                const allProducts = await getCachedProducts();
                const products = (allProducts || []).filter(p => !isAuctionProduct(p));
                if (products.length === 0) return safeReply(interaction, { content: '❌ No Live Stock products found.', flags: [MessageFlags.Ephemeral] });

                const menu = new StringSelectMenuBuilder().setCustomId('sel_unified_edit_pick').setPlaceholder('Select a product to edit stock...');
                products.forEach(p => menu.addOptions({ label: p.name, description: `ID: ${p.id} | Stock: ${p.stock}`, value: p.id }));

                return safeReply(interaction, { content: '📝 **Edit Stock**\nSelect the target product:', components: [new ActionRowBuilder().addComponents(menu)], flags: [MessageFlags.Ephemeral] });
            }

            // ── btn_unified_del ────────────────────────────────
            if (interaction.customId === 'btn_unified_del') {
                if (!isOrderAdmin(interaction))
                    return safeReply(interaction, { content: '❌ Hanya Owner/Admin yang memiliki akses.', flags: [MessageFlags.Ephemeral] });

                const allProducts = await getCachedProducts();
                const products = (allProducts || []).filter(p => !isAuctionProduct(p));
                if (products.length === 0) return safeReply(interaction, { content: '❌ No Live Stock products found.', flags: [MessageFlags.Ephemeral] });

                const menu = new StringSelectMenuBuilder().setCustomId('sel_unified_del_pick').setPlaceholder('Select a product to reduce stock...');
                products.forEach(p => menu.addOptions({ label: p.name, description: `ID: ${p.id} | Stock: ${p.stock}`, value: p.id }));

                return safeReply(interaction, { content: '🗑️ **Delete / Reduce Stock**\nSelect the target product:', components: [new ActionRowBuilder().addComponents(menu)], flags: [MessageFlags.Ephemeral] });
            }
            if (interaction.customId.startsWith('btn_ord_proc_')) {
                if (!isOrderAdmin(interaction)) {
                    return safeReply(interaction, { content: '❌ Hanya Owner/Admin yang memiliki akses untuk memproses orderan.', flags: [MessageFlags.Ephemeral] });
                }

                const orderId = interaction.customId.replace('btn_ord_proc_', '');
                await safeDeferUpdate(interaction);

                const { data: order } = await supabase.from('orders').select('*').eq('order_id', orderId).maybeSingle();
                if (order?.status === 'Processing') {
                    return interaction.followUp({ content: `⚠️ Order \`${orderId}\` sudah dalam status **Processing**.`, flags: [MessageFlags.Ephemeral] }).catch(() => null);
                }

                const rUsername = order?.roblox_username || 'N/A';
                const prodName = order?.product_name || 'Quantumblox Store Product';
                const qty = order?.qty || 1;
                const amount = order?.amount ? `Rp. ${new Intl.NumberFormat('id-ID').format(order.amount)}` : 'N/A';
                const buyerId = order?.buyer_id;
                const buyerTag = order?.buyer_tag || 'Unknown';

                // Update Database Status
                await supabase.from('orders').update({ status: 'Processing', processed_by: interaction.user.id, processed_at: new Date().toISOString() }).eq('order_id', orderId);

                // Build Updated Embed (Same Message in Waiting-List)
                const embed = new EmbedBuilder()
                    .setTitle(`⚙️ ORDER PROCESSING \u2014 ${orderId}`)
                    .setColor('#3498db')
                    .addFields(
                        { name: '👤 Username Roblox', value: `\`\`\`${rUsername}\`\`\``, inline: false },
                        { name: '📦 Detail Produk', value: `**${prodName}**`, inline: true },
                        { name: '🔢 Jumlah', value: `\`${qty} Pcs\``, inline: true },
                        { name: '💰 Total Transaksi', value: `\`${amount}\``, inline: true },
                        { name: '💰 Payment Status', value: `🟢 **Paid (Automatic)**`, inline: true },
                        { name: '🚚 Delivery Status', value: `🔵 **Processing**`, inline: true },
                        { name: '👤 Pembeli', value: buyerId ? `<@${buyerId}> (\`${buyerTag}\`)` : 'Unknown', inline: true },
                        { name: '🆔 Order ID', value: `\`${orderId}\``, inline: true },
                        { name: '⚙️ Diproses Oleh', value: `<@${interaction.user.id}> (<t:${Math.floor(Date.now() / 1000)}:R>)`, inline: false }
                    )
                    .setTimestamp();

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`btn_ord_proc_${orderId}`).setLabel('⚙️ Processing').setStyle(ButtonStyle.Primary).setDisabled(true),
                    new ButtonBuilder().setCustomId(`btn_ord_done_${orderId}`).setLabel('✅ Done / Complete').setStyle(ButtonStyle.Success).setDisabled(false),
                    new ButtonBuilder().setCustomId(`btn_ord_cancel_${orderId}`).setLabel('❌ Cancel').setStyle(ButtonStyle.Danger).setDisabled(false)
                );

                // Edit existing message in-place
                await safeUpdate(interaction, { embeds: [embed], components: [row] });
                await interaction.followUp({ content: `🔵 Order \`${orderId}\` diubah ke status **Processing**.`, flags: [MessageFlags.Ephemeral] }).catch(() => null);

                if (buyerId) {
                    const buyerUser = await client.users.fetch(buyerId).catch(() => null);
                    if (buyerUser) {
                        buyerUser.send({
                            embeds: [new EmbedBuilder()
                                .setTitle('🔵 Order Status Update')
                                .setColor('#3498db')
                                .setDescription(`Orderan Anda **${orderId}** (${prodName}) untuk Username Roblox **${rUsername}** sedang diproses oleh admin!`)
                                .setTimestamp()]
                        }).catch(() => null);
                    }
                }
                return;
            }

            // ── btn_ord_done_ ──────────────────────────────────
            if (interaction.customId.startsWith('btn_ord_done_')) {
                if (!isOrderAdmin(interaction)) {
                    return safeReply(interaction, { content: '❌ Hanya Owner/Admin yang memiliki akses untuk menyelesaikan pengiriman order.', flags: [MessageFlags.Ephemeral] });
                }

                const orderId = interaction.customId.replace('btn_ord_done_', '');

                // Prevent double archiving
                if (ARCHIVED_ORDERS_SET.has(orderId)) {
                    return safeReply(interaction, { content: `⚠️ Order \`${orderId}\` sudah diselesaikan/diarsip.`, flags: [MessageFlags.Ephemeral] });
                }

                const { data: order } = await supabase.from('orders').select('*').eq('order_id', orderId).maybeSingle();
                if (order?.status === 'Done') {
                    ARCHIVED_ORDERS_SET.add(orderId);
                    if (interaction.message) await interaction.message.delete().catch(() => null);
                    return safeReply(interaction, { content: `⚠️ Order \`${orderId}\` sudah berstatus Done.`, flags: [MessageFlags.Ephemeral] });
                }

                ARCHIVED_ORDERS_SET.add(orderId);
                await safeDeferUpdate(interaction);

                const rUsername = order?.roblox_username || 'N/A';
                const prodName = order?.product_name || 'Quantumblox Store Product';
                const qty = order?.qty || 1;
                const amount = order?.amount ? `Rp. ${new Intl.NumberFormat('id-ID').format(order.amount)}` : 'N/A';
                const buyerId = order?.buyer_id;
                const buyerTag = order?.buyer_tag || 'Unknown';

                // 1. Save Completed Status to DB
                await supabase.from('orders').update({ status: 'Done', processed_by: interaction.user.id, processed_at: new Date().toISOString() }).eq('order_id', orderId);

                // 2. Build Completed Archive Embed
                const archiveEmbed = new EmbedBuilder()
                    .setTitle(`✅ ORDER COMPLETED \u2014 ${orderId}`)
                    .setColor('#2ecc71')
                    .addFields(
                        { name: '👤 Username Roblox', value: `\`\`\`${rUsername}\`\`\``, inline: false },
                        { name: '📦 Detail Produk', value: `**${prodName}**`, inline: true },
                        { name: '🔢 Jumlah', value: `\`${qty} Pcs\``, inline: true },
                        { name: '💰 Total Transaksi', value: `\`${amount}\``, inline: true },
                        { name: '💰 Payment Status', value: `🟢 **Paid (Automatic)**`, inline: true },
                        { name: '🚚 Delivery Status', value: `🟢 **Done**`, inline: true },
                        { name: '👤 Pembeli', value: buyerId ? `<@${buyerId}> (\`${buyerTag}\`)` : 'Unknown', inline: true },
                        { name: '🆔 Order ID', value: `\`${orderId}\``, inline: true },
                        { name: '✅ Diselesaikan Oleh', value: `<@${interaction.user.id}> (<t:${Math.floor(Date.now() / 1000)}:R>)`, inline: false }
                    )
                    .setTimestamp();

                // 3. Send EXACTLY ONCE to Archive Channel (1537424696646303826)
                const archiveChannelId = process.env.ARCHIVE_LIST_CHANNEL_ID || process.env.ORDER_ARCHIVE_CHANNEL_ID || '1537424696646303826';
                if (archiveChannelId) {
                    const archiveChannel = await client.channels.fetch(archiveChannelId).catch(() => null);
                    if (archiveChannel) {
                        await archiveChannel.send({ embeds: [archiveEmbed] }).catch(() => null);
                    }
                }

                // 4. Delete original active order ticket from waiting-list channel so waiting-list stays 100% clean
                if (interaction.message) {
                    await interaction.message.delete().catch(() => null);
                }

                // 5. Send Ephemeral Confirmation
                await interaction.followUp({ content: `🟢 Order \`${orderId}\` telah berhasil diselesaikan dan dipindahkan ke Archive!`, flags: [MessageFlags.Ephemeral] }).catch(() => null);

                // 6. DM Buyer receipt with Quantumblox Store branding
                if (buyerId) {
                    const buyerUser = await client.users.fetch(buyerId).catch(() => null);
                    if (buyerUser) {
                        buyerUser.send({
                            embeds: [new EmbedBuilder()
                                .setTitle('🟢 Order Completed!')
                                .setColor('#2ecc71')
                                .setDescription(`Orderan Anda **${orderId}** (${prodName}) untuk Username Roblox **${rUsername}** telah selesai dikirim!\n\nTerima kasih telah berbelanja di **Quantumblox Store**!`)
                                .setTimestamp()]
                        }).catch(() => null);
                    }
                }
                return;
            }

            // ── btn_ord_cancel_ ────────────────────────────────
            if (interaction.customId.startsWith('btn_ord_cancel_')) {
                if (!isOrderAdmin(interaction)) {
                    return safeReply(interaction, { content: '❌ Hanya Owner/Admin yang memiliki akses untuk membatalkan order.', flags: [MessageFlags.Ephemeral] });
                }

                const orderId = interaction.customId.replace('btn_ord_cancel_', '');

                if (ARCHIVED_ORDERS_SET.has(orderId)) {
                    return safeReply(interaction, { content: `⚠️ Order \`${orderId}\` sudah dibatalkan/diarsip.`, flags: [MessageFlags.Ephemeral] });
                }

                const { data: order } = await supabase.from('orders').select('*').eq('order_id', orderId).maybeSingle();
                if (order?.status === 'Cancelled') {
                    ARCHIVED_ORDERS_SET.add(orderId);
                    if (interaction.message) await interaction.message.delete().catch(() => null);
                    return safeReply(interaction, { content: `⚠️ Order \`${orderId}\` sudah berstatus Cancelled.`, flags: [MessageFlags.Ephemeral] });
                }

                ARCHIVED_ORDERS_SET.add(orderId);
                await safeDeferUpdate(interaction);

                const rUsername = order?.roblox_username || 'N/A';
                const prodName = order?.product_name || 'Quantumblox Store Product';
                const qty = order?.qty || 1;
                const amount = order?.amount ? `Rp. ${new Intl.NumberFormat('id-ID').format(order.amount)}` : 'N/A';
                const buyerId = order?.buyer_id;
                const buyerTag = order?.buyer_tag || 'Unknown';

                // 1. Save Cancelled Status to DB
                await supabase.from('orders').update({ status: 'Cancelled', processed_by: interaction.user.id, processed_at: new Date().toISOString() }).eq('order_id', orderId);

                // 2. Build Cancelled Archive Embed
                const cancelEmbed = new EmbedBuilder()
                    .setTitle(`❌ ORDER CANCELLED \u2014 ${orderId}`)
                    .setColor('#e74c3c')
                    .addFields(
                        { name: '👤 Username Roblox', value: `\`\`\`${rUsername}\`\`\``, inline: false },
                        { name: '📦 Detail Produk', value: `**${prodName}**`, inline: true },
                        { name: '🔢 Jumlah', value: `\`${qty} Pcs\``, inline: true },
                        { name: '💰 Total Transaksi', value: `\`${amount}\``, inline: true },
                        { name: '💰 Payment Status', value: `🟢 **Paid (Automatic)**`, inline: true },
                        { name: '🚚 Delivery Status', value: `🔴 **Cancelled**`, inline: true },
                        { name: '👤 Pembeli', value: buyerId ? `<@${buyerId}> (\`${buyerTag}\`)` : 'Unknown', inline: true },
                        { name: '🆔 Order ID', value: `\`${orderId}\``, inline: true },
                        { name: '❌ Dibatalkan Oleh', value: `<@${interaction.user.id}> (<t:${Math.floor(Date.now() / 1000)}:R>)`, inline: false }
                    )
                    .setTimestamp();

                // 3. Send to Archive Channel
                const archiveChannelId = process.env.ARCHIVE_LIST_CHANNEL_ID || process.env.ORDER_ARCHIVE_CHANNEL_ID || '1537424696646303826';
                if (archiveChannelId) {
                    const archiveChannel = await client.channels.fetch(archiveChannelId).catch(() => null);
                    if (archiveChannel) {
                        await archiveChannel.send({ embeds: [cancelEmbed] }).catch(() => null);
                    }
                }

                // 4. Remove active order ticket from waiting-list channel
                if (interaction.message) {
                    await interaction.message.delete().catch(() => null);
                }

                // 5. Send Ephemeral Confirmation
                await interaction.followUp({ content: `🔴 Order \`${orderId}\` telah dibatalkan dan dipindahkan ke Archive.`, flags: [MessageFlags.Ephemeral] }).catch(() => null);

                // 6. DM Buyer
                if (buyerId) {
                    const buyerUser = await client.users.fetch(buyerId).catch(() => null);
                    if (buyerUser) {
                        buyerUser.send({
                            embeds: [new EmbedBuilder()
                                .setTitle('🔴 Order Cancelled')
                                .setColor('#e74c3c')
                                .setDescription(`Orderan Anda **${orderId}** (${prodName}) telah dibatalkan. Silakan hubungi admin **Quantumblox Store** jika ada pertanyaan.`)
                                .setTimestamp()]
                        }).catch(() => null);
                    }
                }
            }



            // ── btn_order_search ───────────────────────────────
            if (interaction.customId === 'btn_order_search') {
                const modal = new ModalBuilder().setCustomId('mod_order_search').setTitle('Cari Order / Roblox Username');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('query').setLabel('Username Roblox / Order ID').setPlaceholder('e.g. UsernameRoblox123 atau INV173...').setStyle(TextInputStyle.Short).setRequired(true)
                    )
                );
                return interaction.showModal(modal);
            }

            // Unhandled button
            console.warn(`[WARN] Unhandled button interaction: ${interaction.customId}`);
            if (!interaction.deferred && !interaction.replied) {
                await safeReply(interaction, { content: '❌ Button handler not found.', flags: [MessageFlags.Ephemeral] });
            }
            return; // end isButton()
        }

        // ═════════════════════════════════════════════════════
        // SELECT MENUS
        // ═════════════════════════════════════════════════════
        if (interaction.isStringSelectMenu()) {

            // ── sel_admin_menu ────────────────────────────────
            if (interaction.customId === 'sel_admin_menu') {
                const choice = interaction.values[0];

                if (choice === 'opt_manage_orders') {
                    const payload = await renderOrderManager('ACTIVE');
                    return safeReply(interaction, { ...payload, flags: [MessageFlags.Ephemeral] });
                }

                if (choice === 'opt_add_p') {
                    const modal = new ModalBuilder().setCustomId('mod_p_add').setTitle('➕ Add New Product');
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('id').setLabel('Unique ID').setPlaceholder('e.g. NETFLIX_PREMIUM').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Product Name').setPlaceholder('e.g. Netflix 1 Bulan').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('price').setLabel('Price').setPlaceholder('e.g. Rp. 10.000').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('min_buy').setLabel('Minimal Buy (Min. Purchase)').setValue('1').setPlaceholder('e.g. 1 or 5').setStyle(TextInputStyle.Short).setRequired(true))
                    );
                    return safeModal(interaction, modal);
                }

                if (choice === 'opt_edit_p') {
                    // Already deferred at top
                    const { data: all } = await supabase.from('products').select('*').order('name');
                    const products = (all || []).filter(p => !isAuctionProduct(p));
                    if (products.length === 0) return safeReply(interaction, { content: '❌ No products to edit.' });
                    const menu = new StringSelectMenuBuilder().setCustomId('sel_p_edit_pick').setPlaceholder('Select a product to edit...');
                    products.forEach(p => menu.addOptions({ label: p.name, description: `ID: ${p.id} | Price: ${p.price}`, value: p.id }));
                    return safeReply(interaction, { content: '✏️ Select a product to edit:', components: [new ActionRowBuilder().addComponents(menu)] });
                }

                if (choice === 'opt_del_p') {
                    // Already deferred at top
                    const { data: all } = await supabase.from('products').select('*').order('name');
                    const products = (all || []).filter(p => !isAuctionProduct(p));
                    if (products.length === 0) return safeReply(interaction, { content: '❌ No products to delete.' });
                    const menu = new StringSelectMenuBuilder().setCustomId('sel_p_del_pick').setPlaceholder('Select a product to DELETE...');
                    products.forEach(p => menu.addOptions({ label: p.name, description: `ID: ${p.id} | Price: ${p.price}`, value: p.id }));
                    return safeReply(interaction, { content: '🗑️ **CAUTION**: Select a product to permanently delete:', components: [new ActionRowBuilder().addComponents(menu)] });
                }

                if (choice === 'opt_manual_pay') {
                    const modal = new ModalBuilder().setCustomId('mod_manual_pay').setTitle('✅ Manual Confirm Payment');
                    modal.addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('inv').setLabel('Invoice / Order ID').setPlaceholder('e.g. INV123456789').setStyle(TextInputStyle.Short).setRequired(true)
                    ));
                    return safeModal(interaction, modal);
                }

                if (choice === 'opt_maintenance') {
                    // Already deferred at top
                    const { data: all } = await supabase.from('products').select('*').order('name');
                    const products = (all || []).filter(p => !isAuctionProduct(p));
                    if (products.length === 0) return safeReply(interaction, { content: '❌ No products found.' });

                    const config = loadConfig();
                    const menu = new StringSelectMenuBuilder().setCustomId('sel_p_maintenance_pick').setPlaceholder('Select a product to toggle maintenance...');
                    products.forEach(p => {
                        const isMaint = config.maintenance?.[p.id] || false;
                        menu.addOptions({
                            label: p.name,
                            description: `ID: ${p.id} | Status: ${isMaint ? 'MAINTENANCE 🟠' : 'ACTIVE 🟢'}`,
                            value: p.id
                        });
                    });
                    return safeReply(interaction, {
                        content: '🛠️ **Maintenance Manager**\nSelect a product to switch its maintenance status:',
                        components: [new ActionRowBuilder().addComponents(menu)]
                    });
                }

                if (choice === 'opt_config') {
                    const config = loadConfig();
                    const modal = new ModalBuilder().setCustomId('mod_config').setTitle('⚙️ Configure Dashboard');
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Embed Title').setValue(config.embed?.title || '').setStyle(TextInputStyle.Short).setRequired(false)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('desc').setLabel('Embed Description').setValue(config.embed?.description || '').setStyle(TextInputStyle.Paragraph).setRequired(false)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('Embed Color (Hex)').setValue(config.embed?.color || '#2b2d31').setStyle(TextInputStyle.Short).setRequired(false)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('thumb').setLabel('Thumbnail URL').setValue(config.embed?.thumbnail || '').setStyle(TextInputStyle.Short).setRequired(false)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('intv').setLabel('Update Interval (ms)').setValue(config.updateInterval?.toString() || '15000').setStyle(TextInputStyle.Short).setRequired(false))
                    );
                    return safeModal(interaction, modal);
                }

                if (choice === 'opt_custom_emoji') {
                    // Already deferred at top
                    const keys = Object.keys(DEFAULT_EMOJI.liveStock);
                    const config = loadConfig();
                    const menu = new StringSelectMenuBuilder()
                        .setCustomId('sel_emoji_ls_pick')
                        .setPlaceholder('Select emoji to customize...')
                        .addOptions(keys.map(k => {
                            const current = config.customEmoji?.liveStock?.[k] || DEFAULT_EMOJI.liveStock[k] || '(none)';
                            return {
                                label: EMOJI_LABELS.liveStock[k] || k,
                                description: `Current: ${current}`,
                                value: k
                            };
                        }));
                    return safeReply(interaction, {
                        content: '🎨 **Set Custom Emoji — Live Stock Dashboard**\nSelect which emoji you want to change:',
                        components: [new ActionRowBuilder().addComponents(menu)]
                    });
                }

                return;
            }

            // ── sel_emoji_ls_pick ─────────────────────────────
            if (interaction.customId === 'sel_emoji_ls_pick') {
                const key = interaction.values[0];
                const config = loadConfig();
                const current = config.customEmoji?.liveStock?.[key] || DEFAULT_EMOJI.liveStock[key] || '';
                const modal = new ModalBuilder().setCustomId(`mod_emoji_ls_${key}`).setTitle('Set Custom Emoji');
                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('emoji')
                        .setLabel(`Emoji untuk ${EMOJI_LABELS.liveStock[key] || key}`)
                        .setValue(current)
                        .setPlaceholder('Paste emoji (e.g. 📦, 🛒, 🌱) or Discord custom emoji (<:name:id>)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                ));
                return await safeModal(interaction, modal);
            }

            // ── sel_p_maintenance_pick ────────────────────────
            if (interaction.customId === 'sel_p_maintenance_pick') {
                await safeDeferUpdate(interaction);
                const pid = interaction.values[0];
                const config = loadConfig();
                if (!config.maintenance) config.maintenance = {};

                const newState = !config.maintenance[pid];
                config.maintenance[pid] = newState;
                saveConfig(config);

                await safeReply(interaction, {
                    content: `✅ Product \`${pid}\` is now **${newState ? 'UNDER MAINTENANCE' : 'ACTIVE'}**.`,
                    components: []
                });

                updateDashboard();
                updateDatabaseEmbed(pid);
                return;
            }

            // ── sel_p_edit_pick ───────────────────────────────
            if (interaction.customId === 'sel_p_edit_pick') {
                const pid = interaction.values[0];
                const { data: p } = await supabase.from('products').select('*').eq('id', pid).single();
                if (!p) return safeUpdate(interaction, { content: '❌ Product not found.', components: [] });
                const modal = new ModalBuilder().setCustomId(`mod_p_edit_${pid}`).setTitle(safeTitle('Edit Product', pid));
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('New Name').setValue(p.name).setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('price').setLabel('New Price').setValue(p.price).setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('min_buy').setLabel('Minimal Buy (Min. Purchase)').setValue(String(p.min_buy || 1)).setStyle(TextInputStyle.Short).setRequired(true))
                );
                return await safeModal(interaction, modal);
            }

            // ── sel_p_del_pick ────────────────────────────────
            if (interaction.customId === 'sel_p_del_pick') {
                const pid = interaction.values[0];
                await safeDeferUpdate(interaction);

                // 1. Cleanup related pending payments first to avoid FK error
                await supabase.from('pending_payments').delete().eq('product_id', pid);

                // 2. Delete the product
                const { error } = await supabase.from('products').delete().eq('id', pid);
                if (error) return safeReply(interaction, { content: `❌ Failed to delete product: ${error.message}`, components: [] });

                await safeReply(interaction, { content: `✅ Product \`${pid}\` has been permanently deleted (including related pending orders).`, components: [] });

                invalidateProductCache();
                debounce('dashboard', () => updateDashboard());
                return;
            }

            // ── sel_unified_add_pick ─────────────────────────────
            if (interaction.customId === 'sel_unified_add_pick') {
                const pid = interaction.values[0];
                const modal = new ModalBuilder().setCustomId(`mod_db_add_${pid}`).setTitle(safeTitle('Tambah Stock', pid));
                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('amount')
                        .setLabel('Jumlah Stock (Amount)')
                        .setPlaceholder('Masukkan jumlah stock yang ingin ditambahkan (e.g. 10)...')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ));
                return await safeModal(interaction, modal);
            }

            // ── sel_unified_edit_pick ────────────────────────────
            if (interaction.customId === 'sel_unified_edit_pick') {
                const pid = interaction.values[0];
                const { data: p } = await supabase.from('products').select('*').eq('id', pid).single();
                const modal = new ModalBuilder().setCustomId(`mod_db_edit_${pid}`).setTitle(safeTitle('Edit Stock', pid));
                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('amount')
                        .setLabel('Total Stock Baru (Amount)')
                        .setValue(String(p?.stock || 0))
                        .setPlaceholder('Masukkan total stock baru (e.g. 50)...')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ));
                return await safeModal(interaction, modal);
            }

            // ── sel_unified_del_pick ─────────────────────────────
            if (interaction.customId === 'sel_unified_del_pick') {
                const pid = interaction.values[0];
                const modal = new ModalBuilder().setCustomId(`mod_db_del_${pid}`).setTitle(safeTitle('Kurangi Stock', pid));
                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('amount')
                        .setLabel('Jumlah Stock yang Ingin Dikurangi')
                        .setPlaceholder('Masukkan jumlah yang ingin dikurangi (e.g. 5)...')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ));
                return await safeModal(interaction, modal);
            }

            // ── sel_buy ───────────────────────────────────────
            if (interaction.customId === 'sel_buy') {
                const pid = interaction.values[0];

                // Check maintenance status FAST from memory cache
                const config = loadConfig();
                if (config.maintenance?.[pid]) {
                    return safeReply(interaction, {
                        embeds: [new EmbedBuilder()
                            .setTitle('🚧  Product Under Maintenance')
                            .setColor('#e67e22')
                            .setDescription(`We apologize, but **${pid}** is currently undergoing maintenance for system updates or stock replenishment.\n\n` +
                                "Please check back later or contact an administrator for more information.")
                            .setTimestamp()],
                        flags: [MessageFlags.Ephemeral]
                    });
                }

                const { data: p } = await supabase.from('products').select('*').eq('id', pid).single();
                const minBuy = Math.max(1, parseInt(p?.min_buy) || 1);

                // Show modal — can't defer before showModal
                const modal = new ModalBuilder().setCustomId(`mod_buy_${pid}`).setTitle('Buy Product');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('q')
                            .setLabel(`Jumlah / Quantity (Minimal Buy: ${minBuy})`)
                            .setPlaceholder(`e.g. ${minBuy}`)
                            .setValue(String(minBuy))
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('roblox')
                            .setLabel('Username Roblox (Wajib)')
                            .setPlaceholder('Masukkan Username Roblox Anda...')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                    )
                );
                return await safeModal(interaction, modal);
            }

            // ── sel_db_edit_ ──────────────────────────────────
            if (interaction.customId.startsWith('sel_db_edit_')) {
                const pid = interaction.customId.replace('sel_db_edit_', '');
                const sid = interaction.values[0];
                const { data: s } = await supabase.from('stock').select('*').eq('id', sid).single();
                if (!s) return safeUpdate(interaction, { content: '❌ Stock entry not found.', components: [] });
                const modal = new ModalBuilder().setCustomId(`mod_db_edit_${pid}_${sid}`).setTitle('Edit Stock Entry');
                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('data').setLabel('New Content').setValue(s.content).setStyle(TextInputStyle.Short).setRequired(true)
                ));
                return await safeModal(interaction, modal);
            }

            // ── sel_db_del_ ───────────────────────────────────
            if (interaction.customId.startsWith('sel_db_del_')) {
                const pid = interaction.customId.replace('sel_db_del_', '');
                const sid = interaction.values[0];
                await safeDeferUpdate(interaction);

                const { error: delErr } = await supabase.from('stock').delete().eq('id', sid);
                if (delErr) return safeReply(interaction, { content: `❌ Failed to delete: ${delErr.message}`, components: [] });

                const { data: stockCount } = await supabase.from('stock').select('id', { count: 'exact' }).eq('product_id', pid);
                await supabase.from('products').update({ stock: stockCount.length }).eq('id', pid);

                await safeReply(interaction, { content: '✅ Stock entry deleted.', components: [] });
                updateDatabaseEmbed(pid);
                updateDashboard();
                return;
            }

            // ── sel_order_filter ──────────────────────────────
            if (interaction.customId === 'sel_order_filter') {
                const val = interaction.values[0];
                const filterStatus = val.replace('filter_', '');
                const payload = await renderOrderManager(filterStatus);
                return safeUpdate(interaction, payload);
            }

            console.warn(`[WARN] Unhandled select menu interaction: ${interaction.customId}`);


            if (!interaction.deferred && !interaction.replied) {
                await safeReply(interaction, { content: '❌ Select menu handler not found.', flags: [MessageFlags.Ephemeral] });
            }
            return; // end isStringSelectMenu()
        }

        // ═════════════════════════════════════════════════════
        // MODALS
        // ═════════════════════════════════════════════════════
        if (interaction.isModalSubmit()) {

            // ── mod_search_sold ────────────────────────────────
            if (interaction.customId === 'mod_search_sold') {
                await safeDefer(interaction);
                const query = interaction.fields.getTextInputValue('search_query').trim();
                if (!query) return safeReply(interaction, { content: '❌ Search query cannot be empty.' });

                // Search across all relevant columns
                const searchPattern = `%${query}%`;
                const { data: results, error } = await supabase
                    .from('sold_archive')
                    .select('*')
                    .or(`order_id.ilike.${searchPattern},product_id.ilike.${searchPattern},product_name.ilike.${searchPattern},buyer_tag.ilike.${searchPattern},buyer_id.ilike.${searchPattern},content.ilike.${searchPattern}`)
                    .order('sold_at', { ascending: false })
                    .limit(25);

                if (error) return safeReply(interaction, { content: `❌ Search failed: ${error.message}` });
                if (!results || results.length === 0) return safeReply(interaction, { content: `No results found for \`${query}\`.` });

                // Build paginated results (max 10 per embed)
                const pageSize = 10;
                const pages = [];
                for (let i = 0; i < results.length; i += pageSize) {
                    const slice = results.slice(i, i + pageSize);
                    const lines = slice.map((r, idx) => {
                        const num = i + idx + 1;
                        const date = r.sold_at ? new Date(r.sold_at).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
                        const contentPreview = r.content?.length > 40 ? r.content.substring(0, 40) + '...' : (r.content || '-');
                        return `**${num}.** \`${r.order_id || '-'}\`\n` +
                            `    Product: \`${r.product_id || '-'}\` | Buyer: \`${r.buyer_tag || '-'}\`\n` +
                            `    Content: \`${contentPreview}\`\n` +
                            `    Amount: \`Rp. ${(r.amount || 0).toLocaleString('id-ID')}\` | Date: \`${date}\``;
                    }).join('\n\n');
                    pages.push(lines);
                }

                const embed = new EmbedBuilder()
                    .setTitle(`Search Results \u2014 "${query}"`)
                    .setColor('#2b2d31')
                    .setDescription(pages[0])
                    .setFooter({ text: `Showing ${Math.min(results.length, pageSize)} of ${results.length} results` })
                    .setTimestamp();

                return safeReply(interaction, { embeds: [embed] });
            }

            // ── mod_p_add ─────────────────────────────────────
            if (interaction.customId === 'mod_p_add') {
                const id = interaction.fields.getTextInputValue('id').trim().toUpperCase();
                const name = interaction.fields.getTextInputValue('name');
                const price = interaction.fields.getTextInputValue('price');
                const minBuyRaw = interaction.fields.getTextInputValue('min_buy');
                const minBuy = Math.max(1, parseInt(minBuyRaw) || 1);
                const format = 'Roblox';
                const desc = '-';

                await safeDefer(interaction);

                const existingRes = await withRetry(() => supabase.from('products').select('id').eq('id', id).single(), 3, 1000).catch(() => null);
                if (existingRes?.data) return safeReply(interaction, { content: `❌ Product ID \`${id}\` already exists.` });

                const { error: insertErr } = await safeInsertProduct({
                    id,
                    name,
                    stock: 0,
                    price: formatPrice(price),
                    min_buy: minBuy,
                    format,
                    description: desc,
                    system_type: 'regular'
                });

                if (insertErr) return safeReply(interaction, { content: `❌ Failed to add product: ${insertErr.message}` });

                await safeReply(interaction, { content: `✅ Product \`${id}\` added successfully! (Min. Buy: ${minBuy})` });
                updateDashboard();
                updateDatabaseEmbed(id).catch(e => console.error(`[DB EMBED] Failed for '${id}': ${e.message}`));
                return;
            }

            // ── mod_p_edit_ ───────────────────────────────────
            if (interaction.customId.startsWith('mod_p_edit_')) {
                const pid = interaction.customId.replace('mod_p_edit_', '');
                const name = interaction.fields.getTextInputValue('name');
                const price = interaction.fields.getTextInputValue('price');
                const minBuyRaw = interaction.fields.getTextInputValue('min_buy');
                const minBuy = Math.max(1, parseInt(minBuyRaw) || 1);
                const format = 'Roblox';
                const desc = '-';

                await safeDefer(interaction);

                let { error: updateErr } = await supabase.from('products').update({
                    name,
                    price: formatPrice(price),
                    min_buy: minBuy,
                    format,
                    description: desc
                }).eq('id', pid);

                if (updateErr && updateErr.code === '42703') {
                    const res = await supabase.from('products').update({
                        name,
                        price: formatPrice(price),
                        format,
                        description: desc
                    }).eq('id', pid);
                    updateErr = res.error;
                }

                if (updateErr) return safeReply(interaction, { content: `❌ Failed to update product: ${updateErr.message}` });

                await safeReply(interaction, { content: `✅ Product \`${pid}\` updated! (Min. Buy: ${minBuy})` });
                invalidateProductCache();
                debounce('dashboard', () => updateDashboard());
                return;
            }

            // ── mod_config ────────────────────────────────────
            if (interaction.customId === 'mod_config') {
                await safeDefer(interaction);
                const config = loadConfig();
                if (!config.embed) config.embed = {};

                config.embed.title = interaction.fields.getTextInputValue('title');
                config.embed.description = interaction.fields.getTextInputValue('desc');
                config.embed.color = interaction.fields.getTextInputValue('color');
                config.embed.thumbnail = interaction.fields.getTextInputValue('thumb');

                const newIntv = parseInt(interaction.fields.getTextInputValue('intv'));
                if (!isNaN(newIntv)) config.updateInterval = Math.max(5000, newIntv);

                saveConfig(config);
                _lastDashboardHash = ''; // Force refresh on next updateDashboard
                await safeReply(interaction, { content: '✅ Dashboard configuration updated!' });
                await updateDashboard();
                return;
            }

            // ── mod_emoji_ls_ ─────────────────────────────────
            if (interaction.customId.startsWith('mod_emoji_ls_')) {
                await safeDefer(interaction);
                const key = interaction.customId.replace('mod_emoji_ls_', '');
                const emojiInput = interaction.fields.getTextInputValue('emoji')?.trim() || '';

                // Validate
                if (emojiInput.length > 0 && !isValidEmoji(emojiInput)) {
                    return safeReply(interaction, {
                        content: `❌ **Invalid emoji:** \`${emojiInput}\`\n\nSupported formats:\n• Unicode emoji (e.g. 🎮 ⭐ 🛒)\n• Discord custom emoji (e.g. \`<:name:id>\`)\n• Animated emoji (e.g. \`<a:name:id>\`)\n• Leave empty to reset to default.`
                    });
                }

                const config = loadConfig();
                if (!config.customEmoji) config.customEmoji = {};
                if (!config.customEmoji.liveStock) config.customEmoji.liveStock = {};

                if (emojiInput.length === 0) {
                    delete config.customEmoji.liveStock[key];
                } else {
                    config.customEmoji.liveStock[key] = emojiInput;
                }

                saveConfig(config);
                _lastDashboardHash = ''; // Force refresh

                const displayEmoji = emojiInput || DEFAULT_EMOJI.liveStock[key] || '(default)';
                await safeReply(interaction, {
                    content: `✅ Emoji for **${EMOJI_LABELS.liveStock[key] || key}** updated to: ${displayEmoji}`
                });

                // Fire-and-forget dashboard update
                updateDashboard().catch(() => {});
                updateUnifiedMonitor().catch(() => {});
                return;
            }
            // ── mod_manual_pay ────────────────────────────────
            if (interaction.customId === 'mod_manual_pay') {
                const inv = interaction.fields.getTextInputValue('inv').trim();
                await safeDefer(interaction);

                const { data: pay } = await supabase.from('pending_payments').select('*').eq('invoice_id', inv).single();
                if (!pay) return safeReply(interaction, { content: `❌ Order ID \`${inv}\` not found.` });

                const buyer = await client.users.fetch(pay.user_id).catch(() => null);
                const rUsername = pay.roblox_username || ROBLOX_PAYMENTS_CACHE.get(inv) || 'N/A';
                const result = await processOrderPaymentSuccess(pay, rUsername, buyer);

                if (result.reason === 'stock_depleted') {
                    return safeReply(interaction, { content: '❌ Insufficient stock to fulfill this order.' });
                }

                await safeReply(interaction, { content: `✅ Order \`${inv}\` successfully processed and dispatched to waiting-list channel!` });

                if (process.env.HISTORY_LOG_CHANNEL_ID) {
                    const logChan = await client.channels.fetch(process.env.HISTORY_LOG_CHANNEL_ID).catch(() => null);
                    if (logChan) logChan.send({
                        embeds: [new EmbedBuilder()
                            .setTitle('Order Completed').setColor('#2d3436')
                            .addFields(
                                { name: 'Order ID', value: `\`${inv}\``, inline: false },
                                { name: 'Buyer', value: `<@${pay.user_id}>`, inline: true },
                                { name: 'Product', value: pay.product_id, inline: true },
                                { name: 'Quantity', value: `${pay.qty}x`, inline: true },
                                { name: 'Total', value: fmt, inline: true },
                                { name: 'Process', value: 'Manual', inline: true }
                            )
                            .setTimestamp()
                        ]
                    }).catch(() => { });
                }

                if (process.env.PAYMENT_LOG_CHANNEL_ID) {
                    const payLogChan = await client.channels.fetch(process.env.PAYMENT_LOG_CHANNEL_ID).catch(() => null);
                    if (payLogChan) payLogChan.send({
                        embeds: [new EmbedBuilder()
                            .setTitle('Payment Received').setColor('#0099ff')
                            .addFields(
                                { name: 'Order ID', value: `\`${inv}\``, inline: false },
                                { name: 'Buyer', value: `<@${pay.user_id}>`, inline: true },
                                { name: 'Product', value: pay.product_id, inline: true },
                                { name: 'Quantity', value: `${pay.qty}x`, inline: true },
                                { name: 'Total', value: fmt, inline: true },
                                { name: 'Status', value: 'Completed (Manual)', inline: true }
                            )
                            .setTimestamp()
                        ]
                    }).catch(() => { });
                }

                // Give Costumer Role
                const costumerRoleId = process.env.COSTUMER_ROLE_ID;
                if (costumerRoleId) {
                    try {
                        const guild = interaction.guild;
                        if (guild) {
                            const member = await guild.members.fetch(pay.user_id).catch(() => null);
                            if (member && !member.roles.cache.has(costumerRoleId)) {
                                await member.roles.add(costumerRoleId);
                                console.log(`[ROLE] Added Costumer role to ${member.user.tag} (Manual)`);
                            }
                        }
                    } catch (roleErr) {
                        console.error(`[ROLE] Failed to add Costumer role manually: ${roleErr.message}`);
                    }
                }

                // Increment sold counter
                const cfgSold = loadConfig();
                cfgSold.totalSold = (cfgSold.totalSold || 0) + pay.qty;
                saveConfig(cfgSold);

                await safeReply(interaction, { content: `✅ Order \`${inv}\` fulfilled manually!` });
                updateDashboard();
                updateDatabaseEmbed(pay.product_id);
                debounce('counting_track', () => updateCountingTrack(), 3000);
                return;
            }

            // ── mod_db_add_ ───────────────────────────────────
            if (interaction.customId.startsWith('mod_db_add_')) {
                await safeDefer(interaction);
                const pid = interaction.customId.replace('mod_db_add_', '');
                const amountText = interaction.fields.getTextInputValue('amount').trim();
                const amount = parseInt(amountText);

                if (isNaN(amount) || amount <= 0) {
                    return safeReply(interaction, { content: '❌ Jumlah stock yang ditambahkan harus berupa angka positif (lebih dari 0).' });
                }

                const { data: p } = await supabase.from('products').select('*').eq('id', pid).single();
                if (!p) return safeReply(interaction, { content: '❌ Produk tidak ditemukan.' });

                const currentStock = parseInt(p.stock) || 0;
                const newStock = currentStock + amount;

                const { error: updateErr } = await supabase.from('products').update({ stock: newStock }).eq('id', pid);
                if (updateErr) return safeReply(interaction, { content: `❌ Gagal menambahkan stock: ${updateErr.message}` });

                invalidateProductCache();

                // Send Stock Alert Notification (1537401300231266314)
                await sendStockAlertNotification(p.name, amount).catch(() => null);

                await safeReply(interaction, {
                    content: `✅ **Stock Berhasil Ditambahkan**\n📦 Produk: **${p.name}**\n➕ Jumlah Ditambahkan: **+${amount}**\n📊 Total Stock Sekarang: **${newStock}**`
                });
                updateDatabaseEmbed(pid);
                debounce('dashboard', () => updateDashboard());
                updateUnifiedMonitor().catch(() => {});
                return;
            }

            // ── mod_db_edit_ ──────────────────────────────────
            if (interaction.customId.startsWith('mod_db_edit_')) {
                await safeDefer(interaction);
                const pid = interaction.customId.replace('mod_db_edit_', '');
                const amountText = interaction.fields.getTextInputValue('amount').trim();
                const newStock = parseInt(amountText);

                if (isNaN(newStock) || newStock < 0) {
                    return safeReply(interaction, { content: '❌ Jumlah stock tidak valid. Masukkan angka 0 atau lebih.' });
                }

                const { data: p } = await supabase.from('products').select('*').eq('id', pid).single();
                if (!p) return safeReply(interaction, { content: '❌ Produk tidak ditemukan.' });

                const currentStock = parseInt(p.stock) || 0;
                const addedAmount = newStock - currentStock;

                const { error: updateErr } = await supabase.from('products').update({ stock: newStock }).eq('id', pid);
                if (updateErr) return safeReply(interaction, { content: `❌ Gagal mengedit stock: ${updateErr.message}` });

                invalidateProductCache();

                // Send Stock Alert ONLY if stock increased (addedAmount > 0)
                if (addedAmount > 0) {
                    await sendStockAlertNotification(p.name, addedAmount).catch(() => null);
                }

                await safeReply(interaction, {
                    content: `✅ **Stock Berhasil Diubah**\n📦 Produk: **${p.name}**\n📊 Total Stock Baru: **${newStock}**`
                });
                updateDatabaseEmbed(pid);
                debounce('dashboard', () => updateDashboard());
                updateUnifiedMonitor().catch(() => {});
                return;
            }

            // ── mod_db_del_ ───────────────────────────────────
            if (interaction.customId.startsWith('mod_db_del_')) {
                await safeDefer(interaction);
                const pid = interaction.customId.replace('mod_db_del_', '');
                const amountText = interaction.fields.getTextInputValue('amount').trim();
                const amount = parseInt(amountText);

                if (isNaN(amount) || amount <= 0) {
                    return safeReply(interaction, { content: '❌ Jumlah stock yang ingin dikurangi harus berupa angka positif (lebih dari 0).' });
                }

                const { data: p } = await supabase.from('products').select('*').eq('id', pid).single();
                if (!p) return safeReply(interaction, { content: '❌ Produk tidak ditemukan.' });

                const currentStock = parseInt(p.stock) || 0;
                const newStock = Math.max(0, currentStock - amount);

                const { error: updateErr } = await supabase.from('products').update({ stock: newStock }).eq('id', pid);
                if (updateErr) return safeReply(interaction, { content: `❌ Gagal mengurangi stock: ${updateErr.message}` });

                invalidateProductCache();
                await safeReply(interaction, {
                    content: `✅ **Stock Berhasil Dikurangi**\n📦 Produk: **${p.name}**\n➖ Jumlah Dikurangi: **-${amount}**\n📊 Total Stock Sekarang: **${newStock}**`
                });
                updateDatabaseEmbed(pid);
                debounce('dashboard', () => updateDashboard());
                updateUnifiedMonitor().catch(() => {});
                return;
            }

            // ── mod_buy_ ──────────────────────────────────────
            if (interaction.customId.startsWith('mod_buy_')) {
                const pid = interaction.customId.replace('mod_buy_', '');
                const qtyText = interaction.fields.getTextInputValue('q');
                const robloxUsername = interaction.fields.getTextInputValue('roblox').trim();
                const qty = parseInt(qtyText);

                if (isNaN(qty) || qty <= 0)
                    return safeReply(interaction, { content: '❌ Invalid quantity. Please enter a positive number.', flags: [MessageFlags.Ephemeral] });

                if (!robloxUsername)
                    return safeReply(interaction, { content: '❌ Username Roblox wajib diisi.', flags: [MessageFlags.Ephemeral] });

                await safeDefer(interaction);

                // Fetch product
                const { data: p } = await supabase.from('products').select('*').eq('id', pid).single();
                if (!p)
                    return safeReply(interaction, { content: '❌ Product not found.' });

                const minBuy = Math.max(1, parseInt(p.min_buy) || 1);
                if (qty < minBuy)
                    return safeReply(interaction, { content: `❌ **Minimal Pembelian Gagal**\nMinimal pembelian untuk **${p.name}** adalah **${minBuy} pcs**. (Jumlah yang dimasukkan: ${qty})`, flags: [MessageFlags.Ephemeral] });

                if (p.stock < qty)
                    return safeReply(interaction, { content: `❌ Not enough stock. Available: ${p.stock}` });

                const unitPrice = parseInt(p.price.replace(/\D/g, '')) || 0;
                const originalAmount = unitPrice * qty;

                // Pakasir minimum transaction check (Min Rp 1.000)
                const PAKASIR_MIN_AMOUNT = 1000;
                if (originalAmount < PAKASIR_MIN_AMOUNT) {
                    const recQty = Math.ceil(PAKASIR_MIN_AMOUNT / (unitPrice || 1));
                    return safeReply(interaction, {
                        content: `❌ **Minimal Transaksi Pakasir (Rp 1.000)**\nTotal transaksi saat ini adalah **Rp ${originalAmount.toLocaleString('id-ID')}** (${qty}x @ Rp ${unitPrice.toLocaleString('id-ID')}).\n\nPakasir membutuhkan minimal transaksi **Rp 1.000**.\nSilakan naikkan jumlah pembelian minimal **${recQty} pcs** (Total: Rp ${(recQty * unitPrice).toLocaleString('id-ID')}).`,
                        flags: [MessageFlags.Ephemeral]
                    });
                }

                const orderId = `INV${Date.now()}`;
                ROBLOX_PAYMENTS_CACHE.set(orderId, robloxUsername);

                const res = await axios.post(`https://app.pakasir.com/api/transactioncreate/qris`, {
                    project: process.env.PAKASIR_SLUG,
                    order_id: orderId,
                    amount: originalAmount,
                    api_key: process.env.PAKASIR_API_KEY
                }, { timeout: 15000 }).catch(() => null);

                if (!res?.data?.payment)
                    return safeReply(interaction, { content: '❌ Failed to create payment. Please try again later.' });

                const { error: insErr } = await supabase.from('pending_payments').insert([{
                    invoice_id: orderId,
                    user_id: interaction.user.id,
                    product_id: pid,
                    qty,
                    amount: originalAmount,
                    roblox_username: robloxUsername,
                    created_at: new Date().toISOString()
                }]);

                if (insErr) {
                    await supabase.from('pending_payments').insert([{
                        invoice_id: orderId,
                        user_id: interaction.user.id,
                        product_id: pid,
                        qty,
                        amount: originalAmount,
                        created_at: new Date().toISOString()
                    }]);
                }

                await safeReply(interaction, {
                    embeds: [new EmbedBuilder()
                        .setTitle('💳  Payment Invoice').setColor('#0099ff')
                        .setDescription('Scan QR code di bawah menggunakan aplikasi QRIS e-wallet/bank Anda. Pembayaran Anda akan **terdeteksi dan diproses secara otomatis** oleh sistem.\n\n⚠️ **Batas Waktu Pembayaran: 5 Menit** (Order otomatis dibatalkan jika belum dibayar).')
                        .addFields(
                            { name: 'Order ID', value: `\`${orderId}\``, inline: false },
                            { name: 'Product', value: p.name, inline: true },
                            { name: 'Quantity', value: `${qty}x`, inline: true },
                            { name: 'Amount', value: `Rp. ${new Intl.NumberFormat('id-ID').format(res.data.payment.total_payment)}`, inline: true },
                            { name: 'Method', value: 'QRIS', inline: true },
                            { name: 'Status', value: '`🟢 Automatic Payment Detection Active`', inline: true },
                            { name: '⏱️ Payment Expiration', value: '`⏳ 5 Minutes (Auto-Cancel)`', inline: true }
                        )
                        .setImage(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(res.data.payment.payment_number)}`)
                        .setTimestamp()
                    ]
                });

                return;
            }

            // ── mod_order_search ──────────────────────────────
            if (interaction.customId === 'mod_order_search') {
                const searchQuery = interaction.fields.getTextInputValue('query').trim();
                await safeDefer(interaction);
                const payload = await renderOrderManager('ALL', searchQuery);
                return safeReply(interaction, payload);
            }

        } // end isModalSubmit()
    } catch (e) {

        if (e.code === 10062) return; // Interaction expired/handled, skip reporting
        console.error('Interaction Error:', e);
        await safeReply(interaction, { content: '❌ An unexpected error occurred. Please try again.', flags: [MessageFlags.Ephemeral] });
    }
});



// ─────────────────────────────────────────────────────────────
// CLIENT READY
// ─────────────────────────────────────────────────────────────

client.once('clientReady', async () => {
    try {
        console.log(`[READY] Bot is online as ${client.user.tag}`);
        console.log(`[INTENTS] Guilds, GuildMessages, MessageContent, GuildMembers are ACTIVE.`);
        refreshPresence(true); // Force on startup

        // Auto-refresh presence after gateway reconnect/resume (throttled)
        client.on('shardResume', () => {
            console.log('[PRESENCE] Gateway resumed — refreshing presence...');
            refreshPresence(true);
        });

        await checkSchemaSupport();
        await registerCommands();

        // Sequential updates with error handling
        _lastDashboardHash = '';
        await updateDashboard().catch(e => console.error('[READY] Dashboard main failed:', e.message));
        await updateVersionDashboard().catch(e => console.error('[READY] Version dash failed:', e.message));
        await updateHoneypotWarning().catch(e => console.error('[READY] Honeypot failed:', e.message));

        // Migrate old per-product monitors to unified monitor (one-time, saved to config)
        await migrateToUnifiedMonitor().catch(e => console.warn('[READY] Migration failed:', e.message));
        // Create/update unified database monitor
        await updateUnifiedMonitor().catch(e => console.warn('[READY] Unified monitor failed:', e.message));
        console.log('[READY] Unified monitor synced.');

        // Initialize counting track
        await updateCountingTrack().catch(e => console.warn('[READY] Counting track failed:', e.message));
        console.log('[READY] Counting track synced.');

        // Migrate historical orders into sold_archive (one-time)

        // Initialize sold data search panel
        await updateSoldDataDashboard().catch(e => console.warn('[READY] Sold data dashboard failed:', e.message));
        console.log('[READY] Sold data dashboard synced.');

        const config = loadConfig();
        const interval = Math.max(90000, config.updateInterval || 90000); // 90s for VPS stability
        const CYCLE_TIMEOUT_MS = 120000; // 120s max per cycle — force-unlock if stuck

        // Overlap guard with timeout protection
        let _loopRunning = false;
        let _loopStartedAt = 0;

        // Wait for initial syncs to settle before starting loop
        setTimeout(() => {
            console.log(`[LOOP] Starting background refresh every ${interval / 1000}s (timeout: ${CYCLE_TIMEOUT_MS / 1000}s)...`);
            setInterval(async () => {
                // Auto-recovery: force-unlock if previous cycle exceeded timeout
                if (_loopRunning) {
                    const elapsed = Date.now() - _loopStartedAt;
                    if (elapsed > CYCLE_TIMEOUT_MS) {
                        console.warn(`[LOOP] Previous cycle stuck for ${Math.round(elapsed / 1000)}s — force unlocking.`);
                        _loopRunning = false;
                    } else {
                        return; // Still within timeout, skip silently
                    }
                }
                _loopRunning = true;
                _loopStartedAt = Date.now();
                try {
                    // Invalidate cache to get fresh data from Supabase
                    invalidateProductCache();

                    // Staggered 1s delays between API calls (reduced from 5s)
                    await updateDashboard().catch(() => { });
                    await new Promise(r => setTimeout(r, 1000));
                    await updateUnifiedMonitor().catch(() => { });
                    await new Promise(r => setTimeout(r, 1000));
                    await new Promise(r => setTimeout(r, 1000));
                    await new Promise(r => setTimeout(r, 1000));
                    await updateVersionDashboard().catch(() => { });
                    await new Promise(r => setTimeout(r, 1000));
                    await updateHoneypotWarning().catch(() => { });
                    await updateCountingTrack().catch(() => { });
                    await updateSoldDataDashboard().catch(() => { });
                    await autoCheckPendingPayments().catch(() => { });
                    refreshPresence();
                } catch (e) {
                    if (!e.message?.includes('Connect Timeout')) console.error('[LOOP] Failure in refresh cycle:', e.message);
                } finally {
                    _loopRunning = false;
                    const duration = Date.now() - _loopStartedAt;
                    if (duration > 30000) console.log(`[LOOP] Cycle completed in ${Math.round(duration / 1000)}s`);
                }
            }, interval);

            // Dedicated Fast Payment Polling (Every 10 seconds)
            setInterval(() => {
                autoCheckPendingPayments().catch(() => { });
            }, 10000);

        }, 20000);
    } catch (e) {
        console.error('[FATAL] Readiness failed:', e);
    }
});

client.login(process.env.DISCORD_TOKEN);