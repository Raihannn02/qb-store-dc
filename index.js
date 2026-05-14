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
const supabase = require('./supabaseClient');

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

async function withRetry(fn, attempts = 3, delayMs = 2000) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (err) {
            const last = i === attempts - 1;
            console.warn(`[RETRY] Attempt ${i + 1}/${attempts} failed: ${err.message}${last ? ' — giving up.' : ' — retrying...'}`);
            if (!last) await new Promise(r => setTimeout(r, delayMs));
            else throw err;
        }
    }
}

// ─────────────────────────────────────────────────────────────
// PROCESS ERROR HANDLERS
// ─────────────────────────────────────────────────────────────

process.on('unhandledRejection', err => console.error('Unhandled Promise Rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));

// ─────────────────────────────────────────────────────────────
// DISCORD CLIENT
// ─────────────────────────────────────────────────────────────

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const configPath = path.join(__dirname, 'config.json');
let dashboardMessageId = null; // Memory cache, but primary id is in config.json

// ─────────────────────────────────────────────────────────────
// BOT VERSION INFO
// ─────────────────────────────────────────────────────────────

const BOT_VERSION = {
    version: '3.0.2',
    codename: 'Resilient Elite',
    date: 'May 14, 2026',
    changelog: [
        { type: 'FIX', desc: 'Auction: Fixed stock lookup bug (using actual product_id for fulfillment).' },
        { type: 'SYS', desc: 'Stability: Enhanced interaction handling for modals and deferrals.' },
        { type: 'UI', desc: 'Elite UI: Cleaned footers (timestamp only) for minimal look.' },
        { type: 'FIX', desc: 'Auction: Optimized zero-latency mod_open_bid trigger.' }
    ]
};

// ─────────────────────────────────────────────────────────────
// STATE CACHE
// ─────────────────────────────────────────────────────────────

let AUCTION_CACHE = { active: false, name: '' };

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
}

async function safeInsertProduct(payload) {
    const data = { ...payload };
    if (!SCHEMA_SUPPORT.system_type) delete data.system_type;
    return supabase.from('products').insert([data]);
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
// updateDatabaseEmbed
// ─────────────────────────────────────────────────────────────

async function updateDatabaseEmbed(productId) {
    console.log(`[DB EMBED] Updating embed for '${productId}'`);

    const { data: product, error: prodError } = await supabase.from('products').select('*').eq('id', productId).single();
    if (prodError || !product) {
        console.error(`[DB EMBED] Product '${productId}' not found: ${prodError?.message}`);
    }

    if (isAuctionProduct(product)) {
        console.log(`[DB EMBED] Skipping '${productId}' (Auction Product)`);

        // Clean up legacy DB embed if it exists from before it was an auction
        const config = loadConfig();
        const msgId = config.monitorMessages?.[productId] || config[`monitor_${productId}`];
        if (msgId) {
            const dbChannelId = process.env.DATABASE_CHANNEL_ID || config.dashboardChannelId;
            const channel = await client.channels.fetch(dbChannelId).catch(() => null);
            if (channel) {
                const msg = await channel.messages.fetch(msgId).catch(() => null);
                if (msg) {
                    await msg.delete().catch(() => { });
                    console.log(`[DB EMBED] Cleared legacy Live Stock monitor for '${productId}'`);
                }
            }
            if (config.monitorMessages) delete config.monitorMessages[productId];
            delete config[`monitor_${productId}`];
            saveConfig(config);
        }
        return;
    }

    const config = loadConfig();
    const isAuction = isAuctionProduct(product);
    // Removed STOCK_MANAGEMENT_CHANNEL_ID to prevent duplication with the Stock Management System embed.
    const dbChannelId = process.env.DATABASE_CHANNEL_ID || config.dashboardChannelId;

    if (!dbChannelId) { console.warn(`[DB EMBED] Channel ID not set for product: ${productId}`); return; }

    const channel = await client.channels.fetch(dbChannelId).catch(() => null);
    if (!channel) { console.error(`[DB EMBED] Channel '${dbChannelId}' not accessible.`); return; }

    const { data: productStock, error: stockError } = await supabase.from('stock').select('*').eq('product_id', productId).order('created_at', { ascending: false });
    if (stockError) { console.error(`[DB EMBED] Stock fetch error: ${stockError.message}`); return; }

    const stockList = productStock ?? [];
    let itemsValue;
    if (stockList.length === 0) {
        itemsValue = '*No stock items found in database.*';
    } else {
        const rows = stockList.slice(0, 15).map((s, i) => {
            try { return formatStockRow(s, i); } catch { return null; }
        }).filter(Boolean);
        itemsValue = rows.join('\n') || '*Could not render stock items.*';
        if (stockList.length > 15) itemsValue += `\n*... and ${stockList.length - 15} more*`;
    }

    const unixNow = Math.floor(Date.now() / 1000);
    const fields = [
        safeField('⏱️ Last Update', `<t:${unixNow}:R>`, false),
        safeField('📊 Summary', `> **Total Items:** \`${stockList.length}\``, false),
        safeField('📦 Available Items', itemsValue, false),
    ].filter(Boolean);

    if (fields.length === 0) { console.error(`[DB EMBED] No valid fields for '${productId}'.`); return; }

    const isMaint = config.maintenance?.[productId] || false;

    const embed = new EmbedBuilder()
        .setTitle(`🛡️ DATABASE MONITOR | ${safeStr(product.name, productId).toUpperCase()}${isMaint ? ' [MAINTENANCE]' : ''}`.slice(0, 256))
        .setDescription(`Monitoring stock entries for product ID: \`${productId}\`${isMaint ? '\n⚠️ **Status:** `MAINTENANCE MODE ACTIVE` - Purchases are blocked.' : ''}`)
        .setColor(isMaint ? '#e67e22' : '#C29C1D')
        .addFields(...fields)
        .setFooter({ text: `QUANTUMBLOX DATABASE SYSTEM • ${productId}`.slice(0, 2048) })
        .setTimestamp();

    if (config.embed?.thumbnail) { try { embed.setThumbnail(config.embed.thumbnail); } catch { /* skip */ } }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`btn_db_add_${productId}`).setLabel('Add Stock').setEmoji('➕').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`btn_db_edit_pick_${productId}`).setLabel('Edit Stock').setEmoji('📝').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`btn_db_del_pick_${productId}`).setLabel('Delete Stock').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
    );

    try {
        await withLock(`db_embed_${productId}`, async () => {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`btn_db_add_${productId}`).setLabel('Add Stock').setEmoji('➕').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`btn_db_edit_pick_${productId}`).setLabel('Edit Stock').setEmoji('📝').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`btn_db_del_pick_${productId}`).setLabel('Delete Stock').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
            );

            // Use standardized search (dynamic key for each product)
            const config = loadConfig();
            if (!config.monitorMessages) config.monitorMessages = {};

            const msg = await getOrCreateDashboardMessage(channel, `monitor_${productId}`, [productId], (m) => {
                const footer = m.embeds[0]?.footer?.text || '';
                return footer.includes(productId);
            });

            if (msg) {
                await withRetry(() => msg.edit({ embeds: [embed], components: [row] }), 3, 3000).catch(e => console.error(`[DB EMBED] Edit failed for ${productId}:`, e.message));
            } else {
                const nMsg = await withRetry(() => channel.send({ embeds: [embed], components: [row] }), 3, 3000).catch(e => console.error(`[DB EMBED] Send failed for ${productId}:`, e.message));
                const cfg = loadConfig();
                if (nMsg) {
                    if (!cfg.monitorMessages) cfg.monitorMessages = {};
                    cfg.monitorMessages[productId] = nMsg.id;
                    cfg[`monitor_${productId}`] = nMsg.id;
                    saveConfig(cfg);
                }
            }
        });
        console.log(`[DB EMBED] Embed updated for '${productId}'`);
    } catch (err) {
        console.error(`[DB EMBED] Embed update failed for '${productId}': ${err.message}`);
    }
}

// ─────────────────────────────────────────────────────────────
// registerCommands
// ─────────────────────────────────────────────────────────────

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try { await rest.put(Routes.applicationCommands(client.user.id), { body: [] }); }
    catch (e) { console.error(e); }
}

// ─────────────────────────────────────────────────────────────
// updateDashboard
// ─────────────────────────────────────────────────────────────

async function updateDashboard() {
    await withLock('dashboard', async () => {
        const config = loadConfig();
        const { data: allProducts, error } = await supabase.from('products').select('*').order('name');
        if (error || !config || !allProducts) return;

        const products = allProducts.filter(p => !isAuctionProduct(p));
        const channel = await client.channels.fetch(config.channelId).catch(() => null);
        if (!channel) return;

        const embed = new EmbedBuilder()
            .setTitle(config.embed?.title || 'Shop Dashboard')
            .setDescription(config.embed?.description || 'Live stock updates.')
            .setColor(config.embed?.color || '#2b2d31')
            .setTimestamp();

        if (config.embed?.thumbnail) embed.setThumbnail(config.embed.thumbnail);
        const unixTime = Math.floor(Date.now() / 1000);
        const fields = [{ name: '⏱️ Last Update', value: `<t:${unixTime}:R>`, inline: false }];
        products.forEach(p => {
            const isMaint = config.maintenance?.[p.id] || false;
            fields.push({
                name: `🛒 ${p.name.toUpperCase()}${isMaint ? ' [MAINTENANCE]' : ''}`,
                value: `>>> 📦 **Stock:** \`${p.stock}\`\n💰 **Price:** \`${p.price}\`\n📋 **Format:** \`${p.format}\`\n📝 **Info:** ${p.description}\n🆔 **ID:** ||${p.id}||`,
                inline: false
            });
        });
        embed.addFields(fields);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_register').setLabel('Register').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('btn_buy').setLabel('Buy Product').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('btn_admin_settings').setLabel('Setting').setStyle(ButtonStyle.Secondary)
        );

        const targetTitle = config.embed?.title || 'Shop Dashboard';
        const msg = await getOrCreateDashboardMessage(channel, 'dashboardMessageId', [targetTitle]);
        if (msg) await withRetry(() => msg.edit({ embeds: [embed], components: [row] }), 3, 3000).catch(e => console.error('[DASHBOARD] Edit failed:', e.message));
        else {
            const nMsg = await withRetry(() => channel.send({ embeds: [embed], components: [row] }), 3, 3000).catch(e => console.error('[DASHBOARD] Send failed:', e.message));
            if (nMsg) {
                config.dashboardMessageId = nMsg.id;
                saveConfig(config);
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────
// updateAuctionDashboard
// ─────────────────────────────────────────────────────────────

async function updateAuctionDashboard() {
    await withLock('auction', async () => {
        const config = loadConfig();
        const auctionChannelId = process.env.AUCTION_CHANNEL_ID;
        if (!auctionChannelId) { console.warn('[AUCTION] AUCTION_CHANNEL_ID not set.'); return; }

        const channel = await client.channels.fetch(auctionChannelId).catch(() => null);
        if (!channel) return;

        const { data: auction } = await supabase.from('auctions').select('*').eq('status', 'active').single();

        // Update state cache for zero-latency interactions
        AUCTION_CACHE.active = !!auction;
        AUCTION_CACHE.name = auction ? auction.name : '';

        const embed = new EmbedBuilder()
            .setTitle('⚖️  AUCTION SYSTEM DASHBOARD')
            .setColor('#2b2d31')
            .setTimestamp();

        if (!auction) {
            embed.setDescription('>>> 🛑 **NO ACTIVE AUCTION**\nThere are no active auction sessions at the moment. Please wait for an administrator to initialize a new session.')
                .addFields({ name: 'Last Update', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: false });
        } else {
            const unixEnd = Math.floor(new Date(auction.end_time).getTime() / 1000);

            // Fetch bid history for Top 11
            const { data: bids } = await supabase.from('auction_bids')
                .select('user_id, amount, created_at')
                .eq('auction_id', auction.id)
                .order('amount', { ascending: false })
                .limit(11);

            let standingText = `🏆 **Highest Bid:** ${formatPrice(auction.current_bid)}\n👤 **Bidder:** ${auction.highest_bidder_id ? `<@${auction.highest_bidder_id}>` : '*None*'}\n⏳ **Remaining:** <t:${unixEnd}:R>`;

            let historyText = '*No previous bids recorded.*';
            if (bids && bids.length > 1) {
                historyText = bids.slice(1).map((b, i) => `**#${i + 2}** <@${b.user_id}> — **${formatPrice(b.amount)}**`).join('\n');
            }

            embed.setDescription(`>>> 🟢 **AUCTION ACTIVE**\nA new auction session is currently live. Place your bid before the timer expires!`)
                .setFields(
                    { name: '📦 Product Information', value: `**Name:** \`${auction.name}\`\n**Category:** \`${auction.category_name || 'Digital'}\`\n**Product ID:** \`${auction.product_id || '-'}\``, inline: false },
                    { name: '📝 Description', value: `${auction.description || 'No description provided.'}`, inline: false },
                    { name: '📊 Current Standing', value: standingText, inline: true },
                    { name: '⏳ End Time', value: `<t:${unixEnd}:F>`, inline: true },
                    { name: '📈 Bid History (Top 10)', value: historyText, inline: false },
                    { name: '⚖️ Auction Rules', value: `• Min. Increment: **${formatPrice(auction.bid_increment)}**\n• Anti-Fake Bid: Troll bids will result in an automatic BAN.\n• Settlement: Winner must finalize payment within 24 hours.`, inline: false },
                    { name: '🔄 Last Update', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
                );
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_auction_register').setLabel('Register').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('btn_open_bid').setLabel('Open Bid').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('btn_auction_settings').setLabel('Settings').setStyle(ButtonStyle.Secondary)
        );

        const msg = await getOrCreateDashboardMessage(channel, 'auctionMessageId', ['AUCTION SYSTEM DASHBOARD']);
        if (msg) await withRetry(() => msg.edit({ embeds: [embed], components: [row] }), 3, 3000).catch(e => console.error('[AUCTION] Edit failed:', e.message));
        else {
            const nMsg = await withRetry(() => channel.send({ embeds: [embed], components: [row] }), 3, 3000).catch(e => console.error('[AUCTION] Send failed:', e.message));
            if (nMsg) {
                config.auctionMessageId = nMsg.id;
                saveConfig(config);
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────
// checkAuctionDeadlines
// ─────────────────────────────────────────────────────────────

async function checkAuctionDeadlines() {
    try {
        // 1. Auto-End Auctions that have expired
        const { data: activeAuc } = await supabase.from('auctions').select('*').eq('status', 'active').lt('end_time', new Date().toISOString());
        if (activeAuc && activeAuc.length > 0) {
            for (const a of activeAuc) {
                console.log(`[DEADLINE] Automatically ending auction ${a.id} (${a.name})`);
                await endAuction(a.id);
            }
        }

        // 2. Cleanup expired pending payments (24h ban)
        const { data: expired } = await supabase.from('pending_payments')
            .select('*')
            .filter('invoice_id', 'ilike', 'AUC%')
            .lt('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

        if (!expired || expired.length === 0) return;

        for (const pay of expired) {
            console.log(`[DEADLINE] Banning user ${pay.user_id} for non-payment of auction ${pay.invoice_id}`);
            // ... (rest of ban logic remains same)
            try {
                const guild = client.guilds.cache.first();
                if (!guild) continue;
                const member = await guild.members.fetch(pay.user_id).catch(() => null);
                const reason = `Automatic Banned: Non-payment of auction winning (>24h). ID: ${pay.invoice_id}`;
                if (member) await member.ban({ reason }).catch(() => { });
                else await guild.bans.create(pay.user_id, { reason }).catch(() => { });

                const banLogChan = await client.channels.fetch(process.env.AUCTION_EXPIRED_BAN_LOG_ID).catch(() => null);
                if (banLogChan) {
                    const embed = new EmbedBuilder().setTitle('⛔ Winner Banned (Non-payment)').setColor('#ff4757')
                        .addFields(
                            { name: 'User', value: `<@${pay.user_id}>`, inline: true },
                            { name: 'Invoice', value: `\`${pay.invoice_id}\``, inline: true }
                        ).setTimestamp();
                    await banLogChan.send({ embeds: [embed] }).catch(() => { });
                }
                await supabase.from('pending_payments').delete().eq('invoice_id', pay.invoice_id);
            } catch (inner) { console.error('[DEADLINE] Ban Error:', inner.message); }
        }
    } catch (e) {
        console.error('[DEADLINE] Worker Error:', e);
    }
}

async function endAuction(aid) {
    const { data: auction } = await supabase.from('auctions').select('*').eq('id', aid).single();
    if (!auction || auction.status !== 'active') return;

    // Set ended IMMEDIATELY to prevent further bids
    await supabase.from('auctions').update({ status: 'ended' }).eq('id', aid);

    if (auction.highest_bidder_id) {
        const winnerId = auction.highest_bidder_id;
        const finalAmount = auction.current_bid;
        const orderId = `AUC${Date.now()}`;

        // Public Winner Notification
        const winChan = await client.channels.fetch(process.env.AUCTION_WIN_CHANNEL_ID).catch(() => null);
        if (winChan) {
            const winEmbed = new EmbedBuilder()
                .setTitle('🏆  AUCTION CONCLUDED')
                .setColor('#f1c40f')
                .setDescription(`>>> The auction for **${auction.name}** has officially closed.\n\n👑 **Winner:** <@${winnerId}>\n💰 **Final Bid:** **${formatPrice(finalAmount)}**\n\n*The winner has been notified via DM to finalize the transaction.*`)
                .setTimestamp();
            await winChan.send({ content: `<@${winnerId}>`, embeds: [winEmbed] }).catch(() => { });
        }

        // Create Pakasir transaction
        try {
            const res = await axios.post(`https://app.pakasir.com/api/transactioncreate/qris`, {
                project: process.env.PAKASIR_SLUG,
                order_id: orderId,
                amount: finalAmount,
                api_key: process.env.PAKASIR_API_KEY
            }, { timeout: 15000 }).catch(() => null);

            if (res?.data?.payment) {
                await supabase.from('pending_payments').insert([{
                    invoice_id: orderId,
                    user_id: winnerId,
                    product_id: auction.product_id, // Use actual ID for fulfillment lookup
                    qty: 1,
                    amount: finalAmount,
                    created_at: new Date().toISOString()
                }]);

                const winner = await client.users.fetch(winnerId).catch(() => null);
                if (winner) {
                    const embed = new EmbedBuilder()
                        .setTitle('🏆  AUCTION VICTORY!')
                        .setColor('#f1c40f')
                        .setDescription(`>>> Congratulations! You have secured the highest bid for **${auction.name}**.\n\nPlease scan the QRIS below within 24 hours to finalize your acquisition.`)
                        .addFields(
                            { name: '📦 Item', value: `\`${auction.name}\``, inline: true },
                            { name: '💰 Final Bid', value: `**${formatPrice(finalAmount)}**`, inline: true },
                            { name: '🆔 Order ID', value: `\`${orderId}\``, inline: false }
                        )
                        .setImage(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(res.data.payment.payment_number)}`)
                        .setTimestamp();

                    const btn = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`btn_check_pay_${orderId}`).setLabel('Check Payment').setStyle(ButtonStyle.Success)
                    );
                    await winner.send({ embeds: [embed], components: [btn] }).catch(() => { });
                }
            }
        } catch (e) {
            console.error('[AUCTION] Payment creation failed:', e.message);
        }
    }
    updateAuctionDashboard();
}

// ─────────────────────────────────────────────────────────────
// updateStockDashboard
// ─────────────────────────────────────────────────────────────

async function updateStockDashboard() {
    await withLock('stock', async () => {
        const config = loadConfig();
        const stockChannelId = process.env.STOCK_MANAGEMENT_CHANNEL_ID;
        if (!stockChannelId) { console.warn('[STOCK] STOCK_MANAGEMENT_CHANNEL_ID not set.'); return; }

        const channel = await client.channels.fetch(stockChannelId).catch(() => null);
        if (!channel) return;

        const { data: allProducts } = await supabase.from('products').select('*').order('name');
        const products = (allProducts || []).filter(p => isAuctionProduct(p));

        const embed = new EmbedBuilder()
            .setTitle('📦  STOCK MANAGEMENT SYSTEM')
            .setColor('#3498db')
            .setDescription('>>> Centralized management for categories and digital stock levels.')
            .setTimestamp();

        if (!products || products.length === 0) {
            embed.addFields({ name: 'Categories', value: '*None found. Add a category first.*' });
        } else {
            const list = products.map(p => `• **${p.name}**\n   ID: \`${p.id}\` | Stock: \`${p.stock}\``).join('\n\n');
            embed.setDescription(`>>> **Manage your product categories and stock levels below.**\n\n${list.slice(0, 3500)}`);
        }
        embed.addFields({ name: '⏱️ Last Update', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: false });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_stock_mgmt_add').setLabel('Add Stock').setStyle(ButtonStyle.Success).setEmoji('➕'),
            new ButtonBuilder().setCustomId('btn_stock_mgmt_edit').setLabel('Edit Stock').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
            new ButtonBuilder().setCustomId('btn_stock_mgmt_del').setLabel('Delete Stock').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
        );

        const msg = await getOrCreateDashboardMessage(channel, 'stockMessageId', ['STOCK MANAGEMENT SYSTEM']);
        if (msg) await withRetry(() => msg.edit({ embeds: [embed], components: [row] }), 3, 3000).catch(e => console.error('[STOCK] Edit failed:', e.message));
        else {
            const nMsg = await withRetry(() => channel.send({ embeds: [embed], components: [row] }), 3, 3000).catch(e => console.error('[STOCK] Send failed:', e.message));
            if (nMsg) {
                config.stockMessageId = nMsg.id;
                saveConfig(config);
            }
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
            .setTitle('QUANTUMBLOX STORE — Version Dashboard')
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
            .setFooter({ text: `QUANTUMBLOX STORE v${BOT_VERSION.version}` })
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
                    .setFooter({ text: `Total Members: ${member.guild.memberCount}` })
                    .setTimestamp();
                await channel.send({ embeds: [embed] }).catch(() => { });
            }
        }
    } catch (e) {
        console.error('[ENTRY] guildMemberAdd error:', e);
    }
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
                    .setFooter({ text: `Total Members: ${member.guild.memberCount}` })
                    .setTimestamp();
                await channel.send({ embeds: [embed] }).catch(() => { });
            }
        }
    } catch (e) {
        console.error('[LEAVE] guildMemberRemove error:', e);
    }
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
            .setFooter({ text: 'System Security Enforcement' })
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
// INTERACTION HANDLER
// ─────────────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
    try {
        console.log(`[INTERACTION] ${interaction.user.tag} (${interaction.user.id}) triggered ${interaction.type} (ID: ${interaction.customId || "N/A"})`);

        // ── SLASH COMMANDS (disabled) ─────────────────────────
        if (interaction.isChatInputCommand()) {
            return interaction.reply({ content: 'Slash commands are disabled. Please use buttons on the dashboard.', flags: [MessageFlags.Ephemeral] });
        }

        // ═════════════════════════════════════════════════════
        // BUTTONS
        // ═════════════════════════════════════════════════════
        if (interaction.isButton()) {
            // ── btn_buy ───────────────────────────────────────
            // Move to top for fastest execution to avoid Unknown Interaction (10062)
            if (interaction.customId === 'btn_buy') {
                try {
                    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                } catch (e) {
                    if (e.code === 10062) return;
                    throw e;
                }

                // Parallelize user check and products fetch
                const [userRes, productsRes] = await Promise.all([
                    supabase.from('users').select('id').eq('id', interaction.user.id).single(),
                    supabase.from('products').select('*').order('name')
                ]);

                if (!userRes.data) return interaction.editReply({ content: '❌ Please register first by clicking the **Register** button.' });

                const products = (productsRes.data || []).filter(p => !isAuctionProduct(p));
                const config = loadConfig();
                if (!products || products.length === 0) return interaction.editReply({ content: '❌ No products available at the moment.' });

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

                return interaction.editReply({ components: [new ActionRowBuilder().addComponents(s)] });
            }

            // ── btn_admin_settings ────────────────────────────
            if (interaction.customId === 'btn_admin_settings') {
                if (!interaction.member.roles.cache.has(process.env.ADMIN_ROLE_ID))
                    return interaction.reply({ content: '❌ Only admins can access settings.', flags: [MessageFlags.Ephemeral] });

                const menu = new StringSelectMenuBuilder()
                    .setCustomId('sel_admin_menu')
                    .setPlaceholder('Choose an administrative action...')
                    .addOptions([
                        { label: 'Add Product', description: 'Create a new product listing', value: 'opt_add_p', emoji: '➕' },
                        { label: 'Edit Product', description: 'Update price or name of a product', value: 'opt_edit_p', emoji: '📝' },
                        { label: 'Maintenance Status', description: 'Enable/disable maintenance for products', value: 'opt_maintenance', emoji: '🛠️' },
                        { label: 'Delete Product', description: 'Remove a product from the shop', value: 'opt_del_p', emoji: '🗑️' },
                        { label: 'Manual Confirm Pay', description: 'Force fulfill an order by ID', value: 'opt_manual_pay', emoji: '✅' },
                        { label: 'Config Dashboard', description: 'Change title, color, or description', value: 'opt_config', emoji: '⚙️' }
                    ]);

                return interaction.reply({
                    content: '🛠️ **Admin Settings Menu**\nChoose what you would like to manage below:',
                    components: [new ActionRowBuilder().addComponents(menu)],
                    flags: [MessageFlags.Ephemeral]
                });
            }

            // ── btn_register ──────────────────────────────────
            if (interaction.customId === 'btn_register') {
                try { await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); } catch (e) { if (e.code === 10062) return; }

                const { data: user } = await supabase.from('users').select('id').eq('id', interaction.user.id).single();
                if (user) return interaction.editReply({ content: '⚠️ You are already registered!' });

                const { error: insertErr } = await supabase.from('users').insert([{ id: interaction.user.id }]);
                if (insertErr) return interaction.editReply({ content: `❌ Registration failed: ${insertErr.message}` });

                return interaction.editReply({ content: '✅ Successfully registered! You can now buy products.' });
            }

            // ── btn_auction_register ──────────────────────────
            if (interaction.customId === 'btn_auction_register') {
                try { await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); } catch (e) { if (e.code === 10062) return; }
                const { data: user } = await supabase.from('users').select('id').eq('id', interaction.user.id).single();
                if (user) return interaction.editReply({ content: '⚠️ You are already registered!' });
                const { error: insertErr } = await supabase.from('users').insert([{ id: interaction.user.id }]);
                if (insertErr) return interaction.editReply({ content: `❌ Registration failed: ${insertErr.message}` });
                return interaction.editReply({ content: '✅ Successfully registered for the auction system!' });
            }

            // ── btn_open_bid ──────────────────────────────────
            if (interaction.customId === 'btn_open_bid') {
                // MUST BE ZERO-LATENCY: Use memory cache instead of DB lookup
                // This prevents the 3-second Discord interaction token from expiring.
                const auctionName = AUCTION_CACHE.name || 'Current Auction';
                const modal = new ModalBuilder().setCustomId('mod_open_bid').setTitle(safeTitle('💰 Place Bid', auctionName));
                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('amount').setLabel('Bid Amount (Rp)').setPlaceholder('e.g. 50000').setStyle(TextInputStyle.Short).setRequired(true)
                ));
                try {
                    return await interaction.showModal(modal);
                } catch (e) {
                    if (e.code === 10062) return; // Interaction already handled/expired
                    console.error('[MODAL] btn_open_bid showModal Error:', e.message);
                }
            }

            // ── btn_auction_settings ──────────────────────────
            if (interaction.customId === 'btn_auction_settings') {
                try {
                    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

                    if (!interaction.member.roles.cache.has(process.env.ADMIN_ROLE_ID))
                        return interaction.editReply({ content: '❌ Only admins can access settings.' });

                    const menu = new StringSelectMenuBuilder()
                        .setCustomId('sel_auction_admin')
                        .setPlaceholder('Auction Management...')
                        .addOptions([
                            { label: 'Add Auction Product', description: 'Start auction using product from database', value: 'opt_add_auction', emoji: '➕' },
                            { label: 'Add Product', description: 'Register new product to database', value: 'opt_add_category', emoji: '🏷️' },
                            { label: 'Edit Product', description: 'Modify existing product in database', value: 'opt_edit_category', emoji: '✏️' },
                            { label: 'Delete Product', description: 'Permanently remove product from database', value: 'opt_delete_category', emoji: '🗑️' },
                            { label: 'Start/Stop Auction', description: 'Toggle auction status', value: 'opt_toggle_auction', emoji: '⚙️' }
                        ]);

                    return interaction.editReply({
                        content: '🛠️ **Auction Admin Menu**\nChoose an option below:',
                        components: [new ActionRowBuilder().addComponents(menu)]
                    });
                } catch (err) {
                    if (err.code !== 10062) console.error('[ERROR] btn_auction_settings failed:', err.message);
                }
                return;
            }

            // ── btn_db_add_ ───────────────────────────────────
            // NOTE: showModal cannot be called after deferReply
            if (interaction.customId.startsWith('btn_db_add_')) {
                if (!interaction.member.roles.cache.has(process.env.ADMIN_ROLE_ID))
                    return interaction.reply({ content: '❌ Admins only.', flags: [MessageFlags.Ephemeral] });

                const pid = interaction.customId.replace('btn_db_add_', '');
                const modal = new ModalBuilder().setCustomId(`mod_db_add_${pid}`).setTitle(safeTitle('Add Stock', pid));
                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('data')
                        .setLabel('Stock Data (one entry per line)')
                        .setPlaceholder('UsernameSteam|PasswordSteam|EmailAcc|PasswordAcc')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                ));
                try { return await interaction.showModal(modal); }
                catch (e) { console.error('[MODAL] btn_db_add showModal failed:', e.message); return; }
            }

            // ── btn_db_edit_pick_ ─────────────────────────────
            if (interaction.customId.startsWith('btn_db_edit_pick_')) {
                if (!interaction.member.roles.cache.has(process.env.ADMIN_ROLE_ID))
                    return interaction.reply({ content: '❌ Admins only.', flags: [MessageFlags.Ephemeral] });

                const pid = interaction.customId.replace('btn_db_edit_pick_', '');
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

                const { data: stock } = await supabase.from('stock').select('*').eq('product_id', pid).order('created_at', { ascending: false });
                if (!stock || stock.length === 0) return interaction.editReply({ content: '❌ No stock entries to edit.' });

                const select = new StringSelectMenuBuilder()
                    .setCustomId(`sel_db_edit_${pid}`)
                    .setPlaceholder('Select an entry to edit...');
                stock.slice(0, 25).forEach((s, i) => select.addOptions({ label: `${i + 1}. ${s.content.slice(0, 40)}`, value: s.id }));

                return interaction.editReply({ content: '✏️ Select an entry to edit:', components: [new ActionRowBuilder().addComponents(select)] });
            }

            // ── btn_db_del_pick_ ──────────────────────────────
            if (interaction.customId.startsWith('btn_db_del_pick_')) {
                if (!interaction.member.roles.cache.has(process.env.ADMIN_ROLE_ID))
                    return interaction.reply({ content: '❌ Admins only.', flags: [MessageFlags.Ephemeral] });

                const pid = interaction.customId.replace('btn_db_del_pick_', '');
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

                const { data: stock } = await supabase.from('stock').select('*').eq('product_id', pid).order('created_at', { ascending: false });
                if (!stock || stock.length === 0) return interaction.editReply({ content: '❌ No stock entries to delete.' });

                const select = new StringSelectMenuBuilder()
                    .setCustomId(`sel_db_del_${pid}`)
                    .setPlaceholder('Select an entry to delete...');
                stock.slice(0, 25).forEach((s, i) => select.addOptions({ label: `${i + 1}. ${s.content.slice(0, 40)}`, value: s.id }));

                return interaction.editReply({ content: '🗑️ Select an entry to delete:', components: [new ActionRowBuilder().addComponents(select)] });
            }

            // ── btn_stock_mgmt_add ───────────────────────────
            if (interaction.customId === 'btn_stock_mgmt_add') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const { data: all } = await supabase.from('products').select('*').order('name');
                const products = (all || []).filter(p => isAuctionProduct(p));
                if (products.length === 0) return interaction.editReply({ content: '❌ No categories found. Please add a category first.' });

                const menu = new StringSelectMenuBuilder().setCustomId('sel_stock_add_pick').setPlaceholder('Select a category to add stock to...');
                products.forEach(p => menu.addOptions({ label: p.name, description: `ID: ${p.id} | Stock: ${p.stock}`, value: p.id }));

                return interaction.editReply({ content: '📦 **Add Stock**\nSelect the target category:', components: [new ActionRowBuilder().addComponents(menu)] });
            }

            // ── btn_stock_mgmt_edit ──────────────────────────
            if (interaction.customId === 'btn_stock_mgmt_edit') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const { data: all } = await supabase.from('products').select('*').order('name');
                const products = (all || []).filter(p => isAuctionProduct(p));
                if (products.length === 0) return interaction.editReply({ content: '❌ No categories found.' });

                const menu = new StringSelectMenuBuilder().setCustomId('sel_stock_edit_pick').setPlaceholder('Select a category to edit its stock...');
                products.forEach(p => menu.addOptions({ label: p.name, description: `ID: ${p.id} | Stock: ${p.stock}`, value: p.id }));

                return interaction.editReply({ content: '✏️ **Edit Stock**\nSelect the category whose stock you want to edit:', components: [new ActionRowBuilder().addComponents(menu)] });
            }

            // ── btn_stock_mgmt_del ───────────────────────────
            if (interaction.customId === 'btn_stock_mgmt_del') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const { data: all } = await supabase.from('products').select('*').order('name');
                const products = (all || []).filter(p => isAuctionProduct(p));
                if (products.length === 0) return interaction.editReply({ content: '❌ No categories found.' });

                const menu = new StringSelectMenuBuilder().setCustomId('sel_stock_del_pick').setPlaceholder('Select a category to delete its stock item...');
                products.forEach(p => menu.addOptions({ label: p.name, description: `ID: ${p.id} | Stock: ${p.stock}`, value: p.id }));

                return interaction.editReply({ content: '🗑️ **Delete Stock**\nSelect the category whose stock item you want to delete:', components: [new ActionRowBuilder().addComponents(menu)] });
            }

            // ── btn_check_pay_ ────────────────────────────────
            if (interaction.customId.startsWith('btn_check_pay_')) {
                try { await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); } catch (e) { if (e.code === 10062) return; }
                const orderId = interaction.customId.replace('btn_check_pay_', '');

                const { data: pay, error: fetchPayError } = await supabase.from('pending_payments').select('*').eq('invoice_id', orderId).single();
                if (fetchPayError || !pay)
                    return interaction.editReply({ content: '❌ Invalid or expired transaction.' });

                try {
                    const res = await axios.get(`https://app.pakasir.com/api/transactiondetail`, {
                        params: {
                            project: process.env.PAKASIR_SLUG,
                            amount: pay.amount,
                            order_id: orderId,
                            api_key: process.env.PAKASIR_API_KEY
                        },
                        timeout: 15000
                    });

                    if (res.data.transaction?.status === 'completed') {
                        const { data: pidStock } = await supabase.from('stock').select('*').eq('product_id', pay.product_id).limit(pay.qty);
                        if (!pidStock || pidStock.length < pay.qty)
                            return interaction.editReply({ content: '⚠️ Payment confirmed but stock was depleted. Please contact an admin.' });

                        const deliver = pidStock.map(s => s.content);
                        const stockIds = pidStock.map(s => s.id);

                        await supabase.from('stock').delete().in('id', stockIds);
                        const { data: remaining } = await supabase.from('stock').select('id', { count: 'exact' }).eq('product_id', pay.product_id);
                        await supabase.from('products').update({ stock: remaining.length }).eq('id', pay.product_id);
                        await supabase.from('pending_payments').delete().eq('invoice_id', orderId);

                        const fmt = `Rp. ${new Intl.NumberFormat('id-ID').format(pay.amount)}`;
                        const isAuction = pay.invoice_id.startsWith('AUC');

                        // 1. Delivery to Buyer's DMs
                        const buyerEmbed = new EmbedBuilder()
                            .setTitle(isAuction ? '🏆  Auction Item Delivered' : '✅  Order Confirmed')
                            .setColor(isAuction ? '#f1c40f' : '#00b894')
                            .setDescription(isAuction
                                ? `Congratulations! Your auction item for **${pay.product_id.replace('AUCTION: ', '')}** has been delivered.`
                                : 'Your order has been processed successfully. Please keep this receipt for your records.')
                            .addFields(
                                { name: 'Order ID', value: `\`${orderId}\``, inline: false },
                                { name: 'Product', value: pay.product_id, inline: true },
                                { name: 'Quantity', value: `${pay.qty}x`, inline: true },
                                { name: 'Total Paid', value: fmt, inline: true }
                            )
                            .setTimestamp();

                        if (isAuction) {
                            buyerEmbed.addFields({ name: 'Item Details', value: `\`\`\`${deliver.join('\n')}\`\`\``, inline: false });
                        } else {
                            buyerEmbed.addFields({ name: 'Delivered Items', value: deliver.map((d, i) => `**${i + 1}.** \`${d}\``).join('\n') || '—', inline: false });
                        }
                        buyerEmbed.setTimestamp();

                        await interaction.user.send({ embeds: [buyerEmbed] }).catch(() => { });

                        // 2. Ephemeral Response on Dashboard
                        const confirmEmbed = new EmbedBuilder()
                            .setTitle(isAuction ? '⚖️  AUCTION ORDER CONFIRMED' : '✅  ORDER CONFIRMED')
                            .setColor(isAuction ? '#f1c40f' : '#00b894')
                            .setDescription(`Your request has been successfully processed.${isAuction ? ' As the winner, your exclusive items have been delivered below.' : ' Your items are ready for pickup.'}`)
                            .addFields(
                                { name: '📦 Product', value: `\`${pay.product_id}\``, inline: true },
                                { name: '💰 Total Amount', value: `\`${fmt}\``, inline: true },
                                { name: '🆔 Order ID', value: `\`${orderId}\``, inline: false }
                            )
                            .setFooter({ text: `QUANTUMBLOX ${isAuction ? 'AUCTION' : 'STORE'} • Elite Fulfillment` })
                            .setTimestamp();
                        await interaction.editReply({ embeds: [confirmEmbed] });

                        // 3. Specialized Logging
                        if (isAuction) {
                            // Dedicated Auction Logs (Bypass Standard Store Logs)
                            const transChan = await client.channels.fetch(process.env.AUCTION_TRANSACTION_LOG_ID).catch(() => null);
                            if (transChan) {
                                const transEmbed = new EmbedBuilder()
                                    .setTitle('💰  AUCTION TRANSACTION LOG')
                                    .setColor('#f1c40f')
                                    .addFields(
                                        { name: 'Buyer / Winner', value: `<@${interaction.user.id}>`, inline: true },
                                        { name: 'Product ID', value: `\`${pay.product_id}\``, inline: true },
                                        { name: 'Final Amount', value: `**${fmt}**`, inline: true },
                                        { name: 'Order ID', value: `\`${orderId}\``, inline: true },
                                        { name: 'Status', value: '🟢 `COMPLETED`', inline: true }
                                    )
                                    .setTimestamp();
                                await transChan.send({ embeds: [transEmbed] }).catch(() => { });
                            }

                            const deliveryChan = await client.channels.fetch(process.env.AUCTION_DELIVERY_LOG_ID).catch(() => null);
                            if (deliveryChan) {
                                const deliveryEmbed = new EmbedBuilder()
                                    .setTitle('📦  AUCTION DELIVERY LOG')
                                    .setColor('#f1c40f')
                                    .addFields(
                                        { name: 'Winner', value: `<@${interaction.user.id}>`, inline: true },
                                        { name: 'Order ID', value: `\`${orderId}\``, inline: true },
                                        { name: 'Stock Delivered', value: `\`\`\`\n${deliver.join('\n')}\n\`\`\``, inline: false }
                                    )
                                    .setTimestamp();
                                await deliveryChan.send({ embeds: [deliveryEmbed] }).catch(() => { });
                            }
                        } else {
                            // Standard Store Logs
                            const histChan = await client.channels.fetch(process.env.HISTORY_LOG_CHANNEL_ID).catch(() => null);
                            if (histChan) {
                                const histEmbed = new EmbedBuilder().setTitle('Order Completed').addFields(
                                    { name: 'Order ID', value: `\`${orderId}\``, inline: false },
                                    { name: 'Buyer', value: `<@${interaction.user.id}>`, inline: true },
                                    { name: 'Product', value: pay.product_id, inline: true },
                                    { name: 'Total', value: fmt, inline: true },
                                    { name: 'Process', value: 'Automatic', inline: true }
                                ).setTimestamp();
                                await histChan.send({ embeds: [histEmbed] }).catch(() => { });
                            }

                            const payChan = await client.channels.fetch(process.env.PAYMENT_LOG_CHANNEL_ID).catch(() => null);
                            if (payChan) {
                                const payEmbed = new EmbedBuilder().setTitle('Payment Received').addFields(
                                    { name: 'Order ID', value: `\`${orderId}\``, inline: false },
                                    { name: 'Buyer', value: `<@${interaction.user.id}>`, inline: true },
                                    { name: 'Total', value: fmt, inline: true },
                                    { name: 'Status', value: 'Completed', inline: true }
                                ).setTimestamp();
                                await payChan.send({ embeds: [payEmbed] }).catch(() => { });
                            }
                        }

                        // 4. Post-Fulfillment (Role & Dashboard)
                        const customerRoleId = process.env.COSTUMER_ROLE_ID;
                        if (customerRoleId && interaction.member) {
                            try {
                                if (!interaction.member.roles.cache.has(customerRoleId)) {
                                    await interaction.member.roles.add(customerRoleId);
                                }
                            } catch (roleErr) { console.error('[ROLE] Failed to add role:', roleErr.message); }
                        }

                        updateDashboard();
                        if (!isAuction) updateDatabaseEmbed(pay.product_id);

                        return;
                    } else {
                        return interaction.editReply({ content: '⏳ Payment not confirmed yet. Please complete the payment and try again.' });
                    }
                } catch (e) {
                    const errMsg = e?.response?.data ? JSON.stringify(e.response.data) : e.message;
                    console.error('Payment Check Error:', errMsg);
                    return interaction.editReply({ content: `❌ Error checking payment: ${e.message}` });
                }
                return;
            }

            // Unhandled button
            console.warn(`[WARN] Unhandled button interaction: ${interaction.customId}`);
            if (!interaction.deferred && !interaction.replied) {
                await interaction.reply({ content: '❌ Button handler not found.', flags: [MessageFlags.Ephemeral] });
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

                if (choice === 'opt_add_p') {
                    const modal = new ModalBuilder().setCustomId('mod_p_add').setTitle('➕ Add New Product');
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('id').setLabel('Unique ID').setPlaceholder('e.g. NETFLIX_PREMIUM').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Product Name').setPlaceholder('e.g. Netflix 1 Bulan').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('price').setLabel('Price').setPlaceholder('e.g. Rp. 10.000').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('format').setLabel('Format').setPlaceholder('e.g. Email|Pass').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('desc').setLabel('Description').setValue('-').setStyle(TextInputStyle.Paragraph).setRequired(false))
                    );
                    try { return await interaction.showModal(modal); }
                    catch (e) { console.error('[MODAL] opt_add_p showModal failed:', e.message); return; }
                }

                if (choice === 'opt_edit_p') {
                    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                    const { data: all } = await supabase.from('products').select('*').order('name');
                    const products = (all || []).filter(p => !isAuctionProduct(p));
                    if (products.length === 0) return interaction.editReply({ content: '❌ No products to edit.' });
                    const menu = new StringSelectMenuBuilder().setCustomId('sel_p_edit_pick').setPlaceholder('Select a product to edit...');
                    products.forEach(p => menu.addOptions({ label: p.name, description: `ID: ${p.id} | Price: ${p.price}`, value: p.id }));
                    return interaction.editReply({ content: '✏️ Select a product to edit:', components: [new ActionRowBuilder().addComponents(menu)] });
                }

                if (choice === 'opt_del_p') {
                    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                    const { data: all } = await supabase.from('products').select('*').order('name');
                    const products = (all || []).filter(p => !isAuctionProduct(p));
                    if (products.length === 0) return interaction.editReply({ content: '❌ No products to delete.' });
                    const menu = new StringSelectMenuBuilder().setCustomId('sel_p_del_pick').setPlaceholder('Select a product to DELETE...');
                    products.forEach(p => menu.addOptions({ label: p.name, description: `ID: ${p.id} | Price: ${p.price}`, value: p.id }));
                    return interaction.editReply({ content: '🗑️ **CAUTION**: Select a product to permanently delete:', components: [new ActionRowBuilder().addComponents(menu)] });
                }

                if (choice === 'opt_manual_pay') {
                    const modal = new ModalBuilder().setCustomId('mod_manual_pay').setTitle('✅ Manual Confirm Payment');
                    modal.addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('inv').setLabel('Invoice / Order ID').setPlaceholder('e.g. INV123456789').setStyle(TextInputStyle.Short).setRequired(true)
                    ));
                    try { return await interaction.showModal(modal); }
                    catch (e) { console.error('[MODAL] opt_manual_pay showModal failed:', e.message); return; }
                }

                if (choice === 'opt_maintenance') {
                    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                    const { data: all } = await supabase.from('products').select('*').order('name');
                    const products = (all || []).filter(p => !isAuctionProduct(p));
                    if (products.length === 0) return interaction.editReply({ content: '❌ No products found.' });

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
                    return interaction.editReply({
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
                    try { return await interaction.showModal(modal); }
                    catch (e) { console.error('[MODAL] opt_config showModal failed:', e.message); return; }
                }

                return;
            }

            // ── sel_p_maintenance_pick ────────────────────────
            if (interaction.customId === 'sel_p_maintenance_pick') {
                await interaction.deferUpdate();
                const pid = interaction.values[0];
                const config = loadConfig();
                if (!config.maintenance) config.maintenance = {};

                const newState = !config.maintenance[pid];
                config.maintenance[pid] = newState;
                saveConfig(config);

                await interaction.editReply({
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
                if (!p) return interaction.update({ content: '❌ Product not found.', components: [] });
                const modal = new ModalBuilder().setCustomId(`mod_p_edit_${pid}`).setTitle(safeTitle('Edit Product', pid));
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('New Name').setValue(p.name).setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('price').setLabel('New Price').setValue(p.price).setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('format').setLabel('New Format').setValue(p.format).setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('desc').setLabel('New Description').setValue(p.description || '-').setStyle(TextInputStyle.Paragraph).setRequired(false))
                );
                try { return await interaction.showModal(modal); }
                catch (e) { console.error('[MODAL] sel_p_edit_pick showModal failed:', e.message); return; }
            }

            // ── sel_p_del_pick ────────────────────────────────
            if (interaction.customId === 'sel_p_del_pick') {
                const pid = interaction.values[0];
                await interaction.deferUpdate();

                // 1. Cleanup related pending payments first to avoid FK error
                await supabase.from('pending_payments').delete().eq('product_id', pid);

                // 2. Delete the product
                const { error } = await supabase.from('products').delete().eq('id', pid);
                if (error) return interaction.editReply({ content: `❌ Failed to delete product: ${error.message}`, components: [] });

                await interaction.editReply({ content: `✅ Product \`${pid}\` has been permanently deleted (including related pending orders).`, components: [] });

                // Small delay to ensure DB sync before dashboard update
                setTimeout(() => updateDashboard(), 1500);
                return;
            }

            // ── sel_buy ───────────────────────────────────────
            if (interaction.customId === 'sel_buy') {
                const pid = interaction.values[0];

                // Check maintenance status FAST from memory cache
                const config = loadConfig();
                if (config.maintenance?.[pid]) {
                    return interaction.reply({
                        embeds: [new EmbedBuilder()
                            .setTitle('🚧  Product Under Maintenance')
                            .setColor('#e67e22')
                            .setDescription(`We apologize, but **${pid}** is currently undergoing maintenance for system updates or stock replenishment.\n\n` +
                                "Please check back later or contact an administrator for more information.")
                            .setTimestamp()],
                        flags: [MessageFlags.Ephemeral]
                    });
                }

                // Show modal — can't defer before showModal
                const modal = new ModalBuilder().setCustomId(`mod_buy_${pid}`).setTitle('Buy Product');
                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('q').setLabel('Quantity').setPlaceholder('e.g. 1').setStyle(TextInputStyle.Short).setRequired(true)
                ));
                try { return await interaction.showModal(modal); }
                catch (e) { console.error('[MODAL] sel_buy showModal failed:', e.message); return; }
            }

            // ── sel_db_edit_ ──────────────────────────────────
            if (interaction.customId.startsWith('sel_db_edit_')) {
                const pid = interaction.customId.replace('sel_db_edit_', '');
                const sid = interaction.values[0];
                const { data: s } = await supabase.from('stock').select('*').eq('id', sid).single();
                if (!s) return interaction.update({ content: '❌ Stock entry not found.', components: [] });
                const modal = new ModalBuilder().setCustomId(`mod_db_edit_${pid}_${sid}`).setTitle('Edit Stock Entry');
                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('data').setLabel('New Content').setValue(s.content).setStyle(TextInputStyle.Short).setRequired(true)
                ));
                try { return await interaction.showModal(modal); }
                catch (e) { console.error('[MODAL] sel_db_edit showModal failed:', e.message); return; }
            }

            // ── sel_db_del_ ───────────────────────────────────
            if (interaction.customId.startsWith('sel_db_del_')) {
                const pid = interaction.customId.replace('sel_db_del_', '');
                const sid = interaction.values[0];
                await interaction.deferUpdate();

                const { error: delErr } = await supabase.from('stock').delete().eq('id', sid);
                if (delErr) return interaction.editReply({ content: `❌ Failed to delete: ${delErr.message}`, components: [] });

                const { data: stockCount } = await supabase.from('stock').select('id', { count: 'exact' }).eq('product_id', pid);
                await supabase.from('products').update({ stock: stockCount.length }).eq('id', pid);

                await interaction.editReply({ content: '✅ Stock entry deleted.', components: [] });
                updateDatabaseEmbed(pid);
                updateDashboard();
                return;
            }

            // ── sel_auction_admin ────────────────────────────
            if (interaction.customId === 'sel_auction_admin') {
                const choice = interaction.values[0];

                if (choice === 'opt_add_auction') {
                    const modal = new ModalBuilder().setCustomId('mod_auction_add').setTitle('⚖️ Create Auction');
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pid').setLabel('Product ID').setPlaceholder('e.g. PWACCLVL93').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('base_price').setLabel('Start Price (Rp)').setPlaceholder('e.g. 50000').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('increment').setLabel('Bid Increment (Rp)').setValue('5000').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('duration').setLabel('Duration (Minutes)').setPlaceholder('e.g. 60').setStyle(TextInputStyle.Short).setRequired(true))
                    );
                    try { return await interaction.showModal(modal); }
                    catch (e) {
                        console.error('[MODAL] opt_add_auction failed:', e.message);
                        return;
                    }
                }

                if (choice === 'opt_add_category') {
                    const modal = new ModalBuilder().setCustomId('mod_add_category').setTitle('🏷️ Create Product');
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pid').setLabel('Product ID (Manual)').setPlaceholder('e.g. PWACCLVL5').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Product Name').setPlaceholder('e.g. Pixel World Acc').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('category').setLabel('Category Name').setPlaceholder('e.g. Gaming').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('desc').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(true))
                    );
                    try { return await interaction.showModal(modal); }
                    catch (e) {
                        if (e.code === 10062 || String(e.message).includes('Unknown interaction')) {
                            console.warn('[MODAL] Token expired for opt_add_category (select menu dropped). User must reload the settings menu.');
                        } else {
                            console.error('[MODAL] opt_add_category failed:', e.message);
                        }
                        return;
                    }
                }

                if (choice === 'opt_toggle_auction') {
                    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                    const { data: auctions } = await supabase.from('auctions').select('*').in('status', ['pending', 'active']).order('created_at', { ascending: false });
                    if (!auctions || auctions.length === 0) return interaction.editReply({ content: '❌ No pending or active auctions found.' });

                    const menu = new StringSelectMenuBuilder().setCustomId('sel_auction_toggle_pick').setPlaceholder('Select an auction to toggle status...');
                    auctions.forEach(a => menu.addOptions({ label: `${a.name} (${a.status})`, description: `Base: ${a.base_price}`, value: a.id }));
                    return interaction.editReply({ content: '⚙️ **Auction Manager**\nSelect an auction to toggle its status:', components: [new ActionRowBuilder().addComponents(menu)] });
                }

                if (choice === 'opt_edit_category') {
                    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                    const { data: all } = await supabase.from('products').select('*').eq('system_type', 'auction').order('name');
                    if (!all || all.length === 0) return interaction.editReply({ content: '❌ No products found to edit.' });

                    const menu = new StringSelectMenuBuilder().setCustomId('sel_auction_edit_pick').setPlaceholder('Select a product to edit...');
                    all.forEach(p => menu.addOptions({ label: p.name, description: `ID: ${p.id} | Cat: ${p.category_name || '—'}`, value: p.id }));
                    return interaction.editReply({ content: '✏️ **Edit Product**\nSelect a product to modify:', components: [new ActionRowBuilder().addComponents(menu)] });
                }

                if (choice === 'opt_delete_category') {
                    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                    const { data: all } = await supabase.from('products').select('*').eq('system_type', 'auction').order('name');
                    if (!all || all.length === 0) return interaction.editReply({ content: '❌ No products found to delete.' });

                    const menu = new StringSelectMenuBuilder().setCustomId('sel_auction_delete_pick').setPlaceholder('Select a product to DELETE...');
                    all.forEach(p => menu.addOptions({ label: p.name, description: `ID: ${p.id} | Cat: ${p.category_name || '—'}`, value: p.id }));
                    return interaction.editReply({ content: '🗑️ **Delete Product**\nSelect a product to permanently remove:', components: [new ActionRowBuilder().addComponents(menu)] });
                }
                return;
            }

            // ── sel_stock_add_pick ───────────────────────────
            if (interaction.customId === 'sel_stock_add_pick') {
                const pid = interaction.values[0];
                const modal = new ModalBuilder().setCustomId(`mod_auction_add_stock`).setTitle(safeTitle('Add Stock', pid));
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pid').setLabel('Confirmed Product ID').setValue(pid).setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('content').setLabel('Stock Content (one per line)').setPlaceholder('item1\nitem2...').setStyle(TextInputStyle.Paragraph).setRequired(true))
                );
                try { return await interaction.showModal(modal); }
                catch (e) { console.error('[MODAL] sel_stock_add_pick failed:', e.message); }
                return;
            }

            // ── sel_stock_edit_pick ──────────────────────────
            if (interaction.customId === 'sel_stock_edit_pick') {
                const pid = interaction.values[0];
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const { data: stock } = await supabase.from('stock').select('*').eq('product_id', pid).order('created_at', { ascending: false });
                if (!stock || stock.length === 0) return interaction.editReply({ content: '❌ No stock entries to edit.' });

                const select = new StringSelectMenuBuilder().setCustomId(`sel_db_edit_${pid}`).setPlaceholder('Select an entry to edit...');
                stock.slice(0, 25).forEach((s, i) => select.addOptions({ label: `${i + 1}. ${s.content.slice(0, 40)}`, value: s.id }));
                return interaction.editReply({ content: '✏️ Select an entry to edit:', components: [new ActionRowBuilder().addComponents(select)] });
            }

            // ── sel_stock_del_pick ───────────────────────────
            if (interaction.customId === 'sel_stock_del_pick') {
                const pid = interaction.values[0];
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const { data: stock } = await supabase.from('stock').select('*').eq('product_id', pid).order('created_at', { ascending: false });
                if (!stock || stock.length === 0) return interaction.editReply({ content: '❌ No stock entries to delete.' });

                const select = new StringSelectMenuBuilder().setCustomId(`sel_db_del_${pid}`).setPlaceholder('Select an entry to delete...');
                stock.slice(0, 25).forEach((s, i) => select.addOptions({ label: `${i + 1}. ${s.content.slice(0, 40)}`, value: s.id }));
                return interaction.editReply({ content: '🗑️ Select an entry to delete:', components: [new ActionRowBuilder().addComponents(select)] });
            }

            // ── sel_auction_toggle_pick ──────────────────────
            if (interaction.customId === 'sel_auction_toggle_pick') {
                await interaction.deferUpdate();
                const aid = interaction.values[0];
                const { data: auction } = await supabase.from('auctions').select('status, name').eq('id', aid).single();
                if (!auction) return interaction.editReply({ content: '❌ Auction not found.', components: [] });

                if (auction.status === 'active') {
                    await endAuction(aid);
                    await interaction.editReply({ content: `✅ Auction \`${auction.name}\` has been **CLOSED**.`, components: [] });
                } else {
                    await supabase.from('auctions').update({ status: 'active' }).eq('id', aid);
                    await interaction.editReply({ content: `✅ Auction \`${auction.name}\` is now **ACTIVE**.`, components: [] });
                }
                updateAuctionDashboard();
                return;
            }

            // ── sel_auction_edit_pick ────────────────────────
            if (interaction.customId === 'sel_auction_edit_pick') {
                const pid = interaction.values[0];
                const { data: p } = await supabase.from('products').select('*').eq('id', pid).single();
                if (!p) return interaction.reply({ content: '❌ Product not found.', flags: [MessageFlags.Ephemeral] });

                const modal = new ModalBuilder().setCustomId(`mod_auction_edit_${pid}`).setTitle('✏️ Edit Product');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Product Name').setValue(p.name).setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('category').setLabel('Category Name').setValue(p.category_name || '').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('desc').setLabel('Description').setValue(p.description || '').setStyle(TextInputStyle.Paragraph).setRequired(true))
                );
                try { return await interaction.showModal(modal); }
                catch (e) { console.error('[MODAL] sel_auction_edit_pick failed:', e.message); return; }
            }

            // ── sel_auction_delete_pick ────────────────────────
            if (interaction.customId === 'sel_auction_delete_pick') {
                const pid = interaction.values[0];
                await interaction.deferUpdate();

                const { error: delErr } = await supabase.from('products').delete().eq('id', pid);
                if (delErr) return interaction.editReply({ content: `❌ Failed to delete category: ${delErr.message}`, components: [] });

                await interaction.editReply({ content: `✅ Category \`${pid}\` has been permanently deleted.`, components: [] });
                updateDashboard();
                updateStockDashboard();
                return;
            }
            console.warn(`[WARN] Unhandled select menu interaction: ${interaction.customId}`);
            if (!interaction.deferred && !interaction.replied) {
                await interaction.reply({ content: '❌ Select menu handler not found.', flags: [MessageFlags.Ephemeral] });
            }
            return; // end isStringSelectMenu()
        }

        // ═════════════════════════════════════════════════════
        // MODALS
        // ═════════════════════════════════════════════════════
        if (interaction.isModalSubmit()) {

            // ── mod_p_add ─────────────────────────────────────
            if (interaction.customId === 'mod_p_add') {
                const id = interaction.fields.getTextInputValue('id').trim().toUpperCase();
                const name = interaction.fields.getTextInputValue('name');
                const price = interaction.fields.getTextInputValue('price');
                const format = interaction.fields.getTextInputValue('format');
                const desc = interaction.fields.getTextInputValue('desc') || '-';

                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

                const { data: existing } = await supabase.from('products').select('id').eq('id', id).single();
                if (existing) return interaction.editReply({ content: `❌ Product ID \`${id}\` already exists.` });

                const { error: insertErr } = await safeInsertProduct({
                    id,
                    name,
                    stock: 0,
                    price: formatPrice(price),
                    format,
                    description: desc,
                    system_type: 'regular'
                });

                if (insertErr) return interaction.editReply({ content: `❌ Failed to add product: ${insertErr.message}` });

                await interaction.editReply({ content: `✅ Product \`${id}\` added successfully!` });
                updateDashboard();
                updateDatabaseEmbed(id).catch(e => console.error(`[DB EMBED] Failed for '${id}': ${e.message}`));
                return;
            }

            // ── mod_p_edit_ ───────────────────────────────────
            if (interaction.customId.startsWith('mod_p_edit_')) {
                const pid = interaction.customId.replace('mod_p_edit_', '');
                const name = interaction.fields.getTextInputValue('name');
                const price = interaction.fields.getTextInputValue('price');
                const format = interaction.fields.getTextInputValue('format');
                const desc = interaction.fields.getTextInputValue('desc') || '-';

                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

                const { error: updateErr } = await supabase.from('products').update({
                    name,
                    price: formatPrice(price),
                    format,
                    description: desc
                }).eq('id', pid);

                if (updateErr) return interaction.editReply({ content: `❌ Failed to update product: ${updateErr.message}` });

                await interaction.editReply({ content: `✅ Product \`${pid}\` updated!` });
                updateDashboard();
                return;
            }

            // ── mod_config ────────────────────────────────────
            if (interaction.customId === 'mod_config') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const config = loadConfig();
                if (!config.embed) config.embed = {};

                config.embed.title = interaction.fields.getTextInputValue('title');
                config.embed.description = interaction.fields.getTextInputValue('desc');
                config.embed.color = interaction.fields.getTextInputValue('color');
                config.embed.thumbnail = interaction.fields.getTextInputValue('thumb');

                const newIntv = parseInt(interaction.fields.getTextInputValue('intv'));
                if (!isNaN(newIntv)) config.updateInterval = Math.max(5000, newIntv);

                saveConfig(config);
                await interaction.editReply({ content: '✅ Dashboard configuration updated!' });
                updateDashboard();
                return;
            }

            // ── mod_manual_pay ────────────────────────────────
            if (interaction.customId === 'mod_manual_pay') {
                const inv = interaction.fields.getTextInputValue('inv').trim();
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

                const { data: pay } = await supabase.from('pending_payments').select('*').eq('invoice_id', inv).single();
                if (!pay) return interaction.editReply({ content: `❌ Order ID \`${inv}\` not found.` });

                // Parallelize stock check and remaining count (or join)
                const { data: prodStock } = await supabase.from('stock').select('*').eq('product_id', pay.product_id).limit(pay.qty);
                if (!prodStock || prodStock.length < pay.qty)
                    return interaction.editReply({ content: '❌ Insufficient stock to fulfill this order.' });

                const items = prodStock.map(s => s.content);
                const stockIds = prodStock.map(s => s.id);

                await supabase.from('stock').delete().in('id', stockIds);
                const { data: remaining } = await supabase.from('stock').select('id', { count: 'exact' }).eq('product_id', pay.product_id);
                await supabase.from('products').update({ stock: remaining.length }).eq('id', pay.product_id);
                await supabase.from('pending_payments').delete().eq('invoice_id', inv);

                const fmt = `Rp. ${new Intl.NumberFormat('id-ID').format(pay.amount)}`;

                const buyer = await client.users.fetch(pay.user_id).catch(() => null);
                if (buyer) {
                    await buyer.send({
                        embeds: [new EmbedBuilder()
                            .setTitle('✅  Order Confirmed').setColor('#00b894')
                            .setDescription('Your order has been processed successfully. Please keep this receipt for your records.')
                            .addFields(
                                { name: 'Order ID', value: `\`${inv}\``, inline: false },
                                { name: 'Product', value: pay.product_id, inline: true },
                                { name: 'Quantity', value: `${pay.qty}x`, inline: true },
                                { name: 'Total Paid', value: fmt, inline: true },
                                { name: 'Delivered Items', value: items.map((d, i) => `**${i + 1}.** \`${d}\``).join('\n') || '—', inline: false }
                            )
                            .setFooter({ text: 'QUANTUMBLOX STORE — Thank you for your purchase.' }).setTimestamp()
                        ]
                    }).catch(() => { });
                }

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
                            .setFooter({ text: `QUANTUMBLOX STORE • ${inv}` }).setTimestamp()
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
                            .setFooter({ text: `QUANTUMBLOX STORE • ${inv}` }).setTimestamp()
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

                await interaction.editReply({ content: `✅ Order \`${inv}\` fulfilled manually!` });
                updateDashboard();
                updateDatabaseEmbed(pay.product_id);
                return;
            }

            // ── mod_db_add_ ───────────────────────────────────
            if (interaction.customId.startsWith('mod_db_add_')) {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const pid = interaction.customId.replace('mod_db_add_', '');
                const lines = interaction.fields.getTextInputValue('data').split('\n').map(l => l.trim()).filter(Boolean);

                if (lines.length === 0) return interaction.editReply({ content: '❌ No valid stock data entered.' });

                const { error: insertErr } = await supabase.from('stock').insert(lines.map(line => ({ product_id: pid, content: line })));
                if (insertErr) return interaction.editReply({ content: `❌ Failed to add stock: ${insertErr.message}` });

                const { data: count } = await supabase.from('stock').select('id', { count: 'exact' }).eq('product_id', pid);
                await supabase.from('products').update({ stock: count.length }).eq('id', pid);

                await interaction.editReply({ content: `✅ Added ${lines.length} item(s). Total stock: ${count.length}` });
                updateDatabaseEmbed(pid);
                updateDashboard();
                return;
            }

            // ── mod_db_edit_ ──────────────────────────────────
            if (interaction.customId.startsWith('mod_db_edit_')) {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                // customId format: mod_db_edit_{pid}_{sid}
                const without = interaction.customId.replace('mod_db_edit_', '');
                const lastUnd = without.lastIndexOf('_');
                const pid = without.substring(0, lastUnd);
                const sid = without.substring(lastUnd + 1);
                const newContent = interaction.fields.getTextInputValue('data').trim();

                const { error: updateErr } = await supabase.from('stock').update({ content: newContent }).eq('id', sid);
                if (updateErr) return interaction.editReply({ content: `❌ Failed to update: ${updateErr.message}` });

                await interaction.editReply({ content: '✅ Stock entry updated.' });
                updateDatabaseEmbed(pid);
                return;
            }

            // ── mod_buy_ ──────────────────────────────────────
            if (interaction.customId.startsWith('mod_buy_')) {
                const pid = interaction.customId.replace('mod_buy_', '');
                const qtyText = interaction.fields.getTextInputValue('q');
                const qty = parseInt(qtyText);

                if (isNaN(qty) || qty <= 0)
                    return interaction.reply({ content: '❌ Invalid quantity. Please enter a positive number.', flags: [MessageFlags.Ephemeral] });

                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

                // Fetch product
                const { data: p } = await supabase.from('products').select('*').eq('id', pid).single();
                if (!p)
                    return interaction.editReply({ content: '❌ Product not found.' });
                if (p.stock < qty)
                    return interaction.editReply({ content: `❌ Not enough stock. Available: ${p.stock}` });

                const orderId = `INV${Date.now()}`;
                const originalAmount = parseInt(p.price.replace(/\D/g, '')) * qty;

                const res = await axios.post(`https://app.pakasir.com/api/transactioncreate/qris`, {
                    project: process.env.PAKASIR_SLUG,
                    order_id: orderId,
                    amount: originalAmount,
                    api_key: process.env.PAKASIR_API_KEY
                }, { timeout: 15000 }).catch(() => null);

                if (!res?.data?.payment)
                    return interaction.editReply({ content: '❌ Failed to create payment. Please try again later.' });

                await supabase.from('pending_payments').insert([{
                    invoice_id: orderId,
                    user_id: interaction.user.id,
                    product_id: pid,
                    qty,
                    amount: originalAmount,
                    created_at: new Date().toISOString()
                }]);

                await interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setTitle('💳  Payment Invoice').setColor('#0099ff')
                        .setDescription('Scan the QR code below using a QRIS-compatible app, then click **Check Payment** to verify your transfer.')
                        .addFields(
                            { name: 'Order ID', value: `\`${orderId}\``, inline: false },
                            { name: 'Product', value: p.name, inline: true },
                            { name: 'Quantity', value: `${qty}x`, inline: true },
                            { name: 'Amount', value: `Rp. ${new Intl.NumberFormat('id-ID').format(res.data.payment.total_payment)}`, inline: true },
                            { name: 'Method', value: 'QRIS', inline: true },
                            { name: 'Status', value: '`Awaiting Payment`', inline: true }
                        )
                        .setImage(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(res.data.payment.payment_number)}`)
                        .setFooter({ text: 'QUANTUMBLOX STORE' }).setTimestamp()
                    ],
                    components: [new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`btn_check_pay_${orderId}`).setLabel('Check Payment').setStyle(ButtonStyle.Success)
                    )]
                });

                return;
            }

            // ── mod_add_category ────────────────────────────
            if (interaction.customId === 'mod_add_category') {
                const manualPid = interaction.fields.getTextInputValue('pid')?.trim();
                const name = interaction.fields.getTextInputValue('name');
                const category = interaction.fields.getTextInputValue('category');
                const desc = interaction.fields.getTextInputValue('desc');

                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

                const { error: insErr } = await supabase.from('products').insert([{
                    id: manualPid,
                    name,
                    category_name: category,
                    description: desc,
                    system_type: 'auction'
                }]);

                if (insErr) return interaction.editReply({ content: `❌ Failed to create product: ${insErr.message}` });
                await interaction.editReply({ content: `✅ Product **${name}** (ID: \`${manualPid}\`) created successfully!` });
                updateStockDashboard();
                return;
            }

            // ── mod_auction_edit_ ─────────────────────────────
            if (interaction.customId.startsWith('mod_auction_edit_')) {
                const pid = interaction.customId.replace('mod_auction_edit_', '');
                const name = interaction.fields.getTextInputValue('name');
                const category = interaction.fields.getTextInputValue('category');
                const desc = interaction.fields.getTextInputValue('desc');

                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

                const { error: updErr } = await supabase.from('products').update({
                    name,
                    category_name: category,
                    description: desc
                }).eq('id', pid);

                if (updErr) return interaction.editReply({ content: `❌ Failed to update product: ${updErr.message}` });

                await interaction.editReply({ content: `✅ Product **${name}** (ID: \`${pid}\`) updated successfully!` });
                updateDashboard();
                updateStockDashboard();
                return;
            }

            // ── mod_auction_add ──────────────────────────────
            if (interaction.customId === 'mod_auction_add') {
                const pid = interaction.fields.getTextInputValue('pid');
                const basePriceStr = interaction.fields.getTextInputValue('base_price');
                const incStr = interaction.fields.getTextInputValue('increment');
                const duration = parseInt(interaction.fields.getTextInputValue('duration'));

                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

                // Fetch product details from database
                const { data: p, error: pErr } = await supabase.from('products').select('*').eq('id', pid).single();
                if (pErr || !p) return interaction.editReply({ content: `❌ Product ID \`${pid}\` not found in database. Please create it first via 'Add Product'.` });

                const basePrice = parseInt(basePriceStr.replace(/\D/g, ''));
                const increment = parseInt(incStr.replace(/\D/g, '')) || 5000;
                if (isNaN(basePrice) || isNaN(duration) || isNaN(increment)) return interaction.editReply({ content: '❌ Invalid price, increment, or duration format.' });

                const endTime = new Date(Date.now() + duration * 60000).toISOString();

                const { error: insertErr } = await supabase.from('auctions').insert([{
                    name: p.name,
                    category_name: p.category_name,
                    description: p.description,
                    base_price: basePrice,
                    current_bid: basePrice,
                    bid_increment: increment,
                    product_id: pid,
                    status: 'pending',
                    end_time: endTime
                }]);

                if (insertErr) return interaction.editReply({ content: `❌ Failed to create auction: ${insertErr.message}` });

                await interaction.editReply({ content: `✅ Auction for \`${p.name}\` created as PENDING. Start it via Settings.` });
                updateAuctionDashboard();
                return;
            }

            // ── mod_open_bid ──────────────────────────────────
            if (interaction.customId === 'mod_open_bid') {
                const bidStr = interaction.fields.getTextInputValue('amount');
                const bidAmt = parseInt(bidStr.replace(/\D/g, ''));

                if (isNaN(bidAmt)) {
                    // Anti-fake bid logic: Automated Ban for non-numeric troll bids
                    try {
                        const banReason = `Automatic Banned: Troll/Fake Bid in Auction System (Non-numeric input: ${bidStr})`;
                        await interaction.member.ban({ reason: banReason });
                        await interaction.reply({ content: '⛔ **BANNED**: Fake/Troll bids are not tolerated. Your attempt has been logged.', flags: [MessageFlags.Ephemeral] });

                        // Send log to restricted-users channel
                        const logChan = await client.channels.fetch('1503766353721430036').catch(() => null);
                        if (logChan) {
                            const embed = new EmbedBuilder()
                                .setTitle('⛔ Banned User: Fake Bid')
                                .setColor('#ff4757')
                                .addFields(
                                    { name: 'User', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                                    { name: 'ID', value: `\`${interaction.user.id}\``, inline: true },
                                    { name: 'Reason', value: 'Fake/Troll Bid (Invalid Input)', inline: false },
                                    { name: 'Input', value: `\`${bidStr}\``, inline: true }
                                )
                                .setTimestamp();
                            await logChan.send({ embeds: [embed] });
                        }
                    } catch (e) { console.error('[AUCTION] Failed to ban troll:', e.message); }
                    return;
                }

                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

                // Check registration here to ensure token stability at start
                const { data: user } = await supabase.from('users').select('id').eq('id', interaction.user.id).single();
                if (!user) return interaction.editReply({ content: '❌ You are not registered for the auction. Please click **Register** on the dashboard first.' });

                const { data: auction } = await supabase.from('auctions').select('*').eq('status', 'active').single();
                if (!auction) return interaction.editReply({ content: '❌ No active auction found.' });

                const minNextBid = auction.current_bid + (auction.bid_increment || 5000);
                if (bidAmt < minNextBid) {
                    return interaction.editReply({ content: `❌ Your bid must be at least **${formatPrice(minNextBid)}** (Min. Increment: ${formatPrice(auction.bid_increment)})` });
                }

                // Check if bid is a valid increment multiple
                const diff = bidAmt - auction.base_price;
                if (diff % (auction.bid_increment || 5000) !== 0) {
                    return interaction.editReply({ content: `❌ Bid must be a multiple of the increment: **${formatPrice(auction.bid_increment)}** starting from **${formatPrice(auction.base_price)}**.` });
                }

                // Update auction with new highest bid
                const { error: updateErr } = await supabase.from('auctions').update({
                    current_bid: bidAmt,
                    highest_bidder_id: interaction.user.id
                }).eq('id', auction.id);

                if (updateErr) return interaction.editReply({ content: `❌ Failed to place bid: ${updateErr.message}` });

                // Record in bid history
                await supabase.from('auction_bids').insert([{
                    auction_id: auction.id,
                    user_id: interaction.user.id,
                    amount: bidAmt
                }]);

                await interaction.editReply({ content: `✅ Your bid of **${formatPrice(bidAmt)}** has been placed!` });
                updateAuctionDashboard();
                return;
            }
            // ── mod_auction_add_stock ────────────────────────
            if (interaction.customId === 'mod_auction_add_stock') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

                const pid = interaction.fields.getTextInputValue('pid');
                const content = interaction.fields.getTextInputValue('content');

                const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                if (lines.length === 0) return interaction.editReply({ content: '❌ No valid content provided.' });

                const { data: prod } = await supabase.from('products').select('id, name').eq('id', pid).single();
                if (!prod) return interaction.editReply({ content: `❌ Product ID \`${pid}\` not found.` });

                const inserts = lines.map(line => ({ product_id: pid, content: line }));
                const { error: stockErr } = await supabase.from('stock').insert(inserts);

                if (stockErr) return interaction.editReply({ content: `❌ Failed to add stock: ${stockErr.message}` });

                const { count } = await supabase.from('stock').select('id', { count: 'exact', head: true }).eq('product_id', pid);
                await supabase.from('products').update({ stock: count }).eq('id', pid);

                await interaction.editReply({ content: `✅ Successfully added **${lines.length}** items to **${prod.name}** (\`${pid}\`).` });

                // Fire and forget updates to keep response fast
                updateDashboard().catch(() => { });
                updateStockDashboard().catch(() => { });
                updateDatabaseEmbed(pid).catch(() => { });
                return;
            }

        }

    } catch (e) {
        if (e.code === 10062) return; // Interaction expired/handled, skip reporting
        console.error('Interaction Error:', e);
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content: '❌ An unexpected error occurred. Please try again.' });
            } else {
                await interaction.reply({ content: '❌ An unexpected error occurred. Please try again.', flags: [MessageFlags.Ephemeral] });
            }
        } catch (_) { /* ignore errors during error reporting */ }
    }
});


// ─────────────────────────────────────────────────────────────
// CLIENT READY
// ─────────────────────────────────────────────────────────────

client.once('clientReady', async () => {
    try {
        console.log(`[READY] Bot is online as ${client.user.tag}`);
        console.log(`[INTENTS] Guilds, GuildMessages, MessageContent, GuildMembers are ACTIVE.`);
        client.user.setActivity('QUANTUMBLOX STORE ON', { type: ActivityType.Custom });

        await checkSchemaSupport();
        await registerCommands();

        // Sequential updates with error handling
        await updateDashboard().catch(e => console.error('[READY] Dashboard main failed:', e.message));
        await updateVersionDashboard().catch(e => console.error('[READY] Version dash failed:', e.message));
        await updateAuctionDashboard().catch(e => console.error('[READY] Auction dash failed:', e.message));
        await updateStockDashboard().catch(e => console.error('[READY] Stock dash failed:', e.message));
        checkAuctionDeadlines();
        await updateHoneypotWarning().catch(e => console.error('[READY] Honeypot failed:', e.message));

        // Refresh database monitor embeds on startup (Live Stock Only)
        const { data: allProducts } = await supabase.from('products').select('*');
        if (allProducts) {
            const liveDrops = allProducts.filter(p => !isAuctionProduct(p));
            console.log(`[READY] Refreshing ${liveDrops.length} Live Stock monitors...`);
            for (const p of liveDrops) {
                updateDatabaseEmbed(p.id).catch(e => console.warn(`[READY] Loop update failed for ${p.id}:`, e.message));
            }
        }

        const config = loadConfig();
        const interval = Math.max(30000, config.updateInterval || 45000); // 45s recommended for stability

        // Wait for initial syncs to settle before starting loop
        setTimeout(() => {
            console.log(`[LOOP] Starting background refresh every ${interval / 1000}s...`);
            setInterval(async () => {
                try {
                    await updateDashboard().catch(() => { });
                    await updateStockDashboard().catch(() => { });
                    await updateAuctionDashboard().catch(() => { });
                    await updateVersionDashboard().catch(() => { });
                    checkAuctionDeadlines();
                    updateHoneypotWarning();
                } catch (e) { console.error('[LOOP] Failure in refresh cycle:', e.message); }
            }, interval);
        }, 10000);
    } catch (e) {
        console.error('[FATAL] Readiness failed:', e);
    }
});

client.login(process.env.DISCORD_TOKEN);