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
let dashboardMessageId = null;

// ─────────────────────────────────────────────────────────────
// BOT VERSION INFO
// ─────────────────────────────────────────────────────────────

const BOT_VERSION = {
    version: '2.7.5',
    codename: 'Auction Pro+',
    date: '2026-05-14',
    changelog: [
        { type: 'NEW', desc: 'Auction v2.7.5: Integrated Stock Management into Auction Settings' },
        { type: 'NEW', desc: 'Auction v2: Multi-channel Winner Notifications & Auto-Delivery' },
        { type: 'FIX', desc: 'Schema: Improved bid_increment handling & cache sync' },
        { type: 'FIX', desc: 'UI: Polished Auction Dashboard & ⚖️ icon' },
        { type: 'SYS', desc: 'Reliability: Embed character limit protection (Version Dashboard)' },
        { type: 'NEW', desc: 'Maintenance: Persistent disk storage & Auto-Sync' },
        { type: 'FIX', desc: 'Sync: Dashboard now displays maintenance labels' },
        { type: 'SYS', desc: 'Reliability: Removed cache for critical settings' },
        { type: 'FIX', desc: 'Optimization: Full-system interaction response speedup' },
        { type: 'NEW', desc: 'Caching: Memory-based config loading (Zero Disk I/O)' },
        { type: 'FIX', desc: 'Parallelism: Supabase queries now run concurrently' },
        { type: 'FIX', desc: 'Interaction: Optimized response & stability (10062)' },
        { type: 'FIX', desc: 'Maintenance: Fixed products ReferenceError in purchase' },
        { type: 'NEW', desc: 'Maintenance System: Toggle per-product status' },
        { type: 'NEW', desc: 'Honeypot: Auto-ban phishing/hacked accounts' },
        { type: 'FIX', desc: 'Honeypot: Optimized instant message auto-delete' },
        { type: 'FIX', desc: 'Resolved all "This interaction failed" errors' },
        { type: 'SYS', desc: 'Maintenance purchase block & admin toggle' },
        { type: 'SYS', desc: 'Honeypot real-time stats & ban tracking' },
    ]
};

// ─────────────────────────────────────────────────────────────
// CONFIG HELPERS
// ─────────────────────────────────────────────────────────────

function loadConfig() {
    try {
        if (!fs.existsSync(configPath)) return {};
        const data = fs.readFileSync(configPath, 'utf8');
        return JSON.parse(data);
    } catch (err) { console.error('Error loading config:', err); return {}; }
}

function saveConfig(data) {
    try {
        fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf8');
        console.log('[CONFIG] Successfully saved to disk.');
        return true;
    }
    catch (err) { console.error('Error saving config:', err); return false; }
}

// ─────────────────────────────────────────────────────────────
// updateDatabaseEmbed
// ─────────────────────────────────────────────────────────────

async function updateDatabaseEmbed(productId) {
    console.log(`[DB EMBED] Updating embed for '${productId}'`);

    const { data: product, error: prodError } = await supabase.from('products').select('*').eq('id', productId).single();
    if (prodError || !product) {
        console.error(`[DB EMBED] Product '${productId}' not found: ${prodError?.message}`);
        return;
    }

    const config = loadConfig();
    const dbChannelId = process.env.DATABASE_CHANNEL_ID || config.dashboardChannelId;
    if (!dbChannelId) { console.warn('[DB EMBED] DATABASE_CHANNEL_ID not set.'); return; }

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
        await withRetry(async () => {
            const messages = await channel.messages.fetch({ limit: 50 });
            const existing = messages.find(m => m.author.id === client.user.id && m.embeds[0]?.footer?.text?.includes(productId));
            if (existing) await existing.edit({ embeds: [embed], components: [row] });
            else await channel.send({ embeds: [embed], components: [row] });
        }, 3, 2000);
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
    const config = loadConfig();
    const { data: products, error } = await supabase.from('products').select('*').order('name');
    if (error || !config || !products) return;

    try {
        const channel = await client.channels.fetch(config.channelId);
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

        if (dashboardMessageId) {
            try {
                const msg = await channel.messages.fetch(dashboardMessageId);
                await msg.edit({ embeds: [embed], components: [row] });
                return;
            } catch { dashboardMessageId = null; }
        }

        const msgs = await channel.messages.fetch({ limit: 10 });
        const botMsg = msgs.find(m => m.author.id === client.user.id);
        if (botMsg) {
            await botMsg.edit({ embeds: [embed], components: [row] });
            dashboardMessageId = botMsg.id;
        } else {
            const nMsg = await channel.send({ embeds: [embed], components: [row] });
            dashboardMessageId = nMsg.id;
        }
    } catch (e) {
        if (e.code === 'ENOTFOUND' || e.code === 'ETIMEDOUT') return;
        console.error('Dashboard Update Error:', e);
    }
}

// ─────────────────────────────────────────────────────────────
// updateAuctionDashboard
// ─────────────────────────────────────────────────────────────

async function updateAuctionDashboard() {
    const config = loadConfig();
    const auctionChannelId = process.env.AUCTION_CHANNEL_ID;
    if (!auctionChannelId) { console.warn('[AUCTION] AUCTION_CHANNEL_ID not set.'); return; }

    try {
        const channel = await client.channels.fetch(auctionChannelId).catch(() => null);
        if (!channel) return;

        // Fetch active auction
        const { data: auction, error } = await supabase.from('auctions').select('*').eq('status', 'active').single();

        const embed = new EmbedBuilder()
            .setTitle('⚖️  AUCTION SYSTEM DASHBOARD')
            .setColor('#2b2d31')
            .setTimestamp();

        if (error || !auction) {
            embed.setDescription('>>> There is no active auction at the moment. Please wait for an admin to start a new auction session.')
                .addFields({ name: '⏱️ Last Update', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: false });
        } else {
            const unixEnd = Math.floor(new Date(auction.end_time).getTime() / 1000);
            embed.setDescription(
                `**Product:** \`${auction.name}\`\n` +
                `**Description:** ${auction.description || '-'}\n\n` +
                `🏆 **Highest Bid:** \`${formatPrice(auction.current_bid)}\`\n` +
                `👤 **Highest Bidder:** ${auction.highest_bidder_id ? `<@${auction.highest_bidder_id}>` : '`None`'}\n` +
                `⏳ **Ends:** <t:${unixEnd}:R>\n\n` +
                `📢 **Rules & Warnings:**\n` +
                `• Min. Increment: \`${formatPrice(auction.bid_increment)}\`\n` +
                `• **Anti-Fake Bid:** Troll bids will be automatically BANNED.\n` +
                `• **Payment:** Winner must pay within 24 hours or face permanent BAN.`
            )
                .addFields({ name: '⏱️ Last Update', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: false });
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_auction_register').setLabel('Register').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('btn_open_bid').setLabel('Open Bid').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('btn_auction_settings').setLabel('Settings').setStyle(ButtonStyle.Secondary)
        );

        if (config.auctionMessageId) {
            try {
                const msg = await channel.messages.fetch(config.auctionMessageId);
                await msg.edit({ embeds: [embed], components: [row] });
                return;
            } catch {
                config.auctionMessageId = null;
                saveConfig(config);
            }
        }

        const msgs = await channel.messages.fetch({ limit: 10 });
        const botMsg = msgs.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('AUCTION SYSTEM DASHBOARD'));
        if (botMsg) {
            await botMsg.edit({ embeds: [embed], components: [row] });
            config.auctionMessageId = botMsg.id;
            saveConfig(config);
        } else {
            const nMsg = await channel.send({ embeds: [embed], components: [row] });
            config.auctionMessageId = nMsg.id;
            saveConfig(config);
        }
    } catch (e) {
        console.error('Auction Dashboard Update Error:', e);
    }
}

// ─────────────────────────────────────────────────────────────
// checkAuctionDeadlines
// ─────────────────────────────────────────────────────────────

async function checkAuctionDeadlines() {
    try {
        const { data: expired } = await supabase.from('pending_payments')
            .select('*')
            .filter('invoice_id', 'ilike', 'AUC%')
            .lt('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

        if (!expired || expired.length === 0) return;

        for (const pay of expired) {
            console.log(`[DEADLINE] Banning user ${pay.user_id} for non-payment of auction ${pay.invoice_id}`);

            try {
                const guild = client.guilds.cache.first(); // Assuming single guild bot
                if (!guild) continue;

                const member = await guild.members.fetch(pay.user_id).catch(() => null);
                const reason = `Automatic Banned: Non-payment of auction winning (>24h). ID: ${pay.invoice_id}`;

                if (member) {
                    await member.ban({ reason }).catch(e => console.error(`[DEADLINE] Ban failed: ${e.message}`));
                } else {
                    await guild.bans.create(pay.user_id, { reason }).catch(e => console.error(`[DEADLINE] Global ban failed: ${e.message}`));
                }

                // Log to specific channel
                const banLogChan = await client.channels.fetch(process.env.AUCTION_EXPIRED_BAN_LOG_ID).catch(() => null);
                if (banLogChan) {
                    const embed = new EmbedBuilder()
                        .setTitle('⛔ Winner Banned (Non-payment)')
                        .setColor('#ff4757')
                        .addFields(
                            { name: 'User', value: `<@${pay.user_id}> (\`${pay.user_id}\`)`, inline: true },
                            { name: 'Invoice', value: `\`${pay.invoice_id}\``, inline: true },
                            { name: 'Wait Time', value: '24 Hours', inline: true }
                        )
                        .setTimestamp();
                    await banLogChan.send({ embeds: [embed] }).catch(() => { });
                }

                // Cleanup
                await supabase.from('pending_payments').delete().eq('invoice_id', pay.invoice_id);
            } catch (inner) {
                console.error(`[DEADLINE] Error processing penalty for ${pay.user_id}:`, inner.message);
            }
        }
    } catch (e) {
        console.error('[DEADLINE] Worker Error:', e);
    }
}

// ─────────────────────────────────────────────────────────────
// updateVersionDashboard
// ─────────────────────────────────────────────────────────────

async function updateVersionDashboard() {
    const channelId = process.env.VERSION_CHANNEL_ID;
    if (!channelId) { console.warn('[VERSION] VERSION_CHANNEL_ID not set.'); return; }

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) { console.error(`[VERSION] Channel '${channelId}' not accessible.`); return; }

    const tagMap = { NEW: '`[NEW]`', FIX: '`[FIX]`', SYSTEM: '`[SYS]`' };
    let changelogLines = BOT_VERSION.changelog.map(
        c => `${tagMap[c.type] || '`[---]`'}  ${c.desc}`
    ).join('\n');

    if (changelogLines.length > 1024) {
        changelogLines = changelogLines.slice(0, 1021) + '...';
    }

    const uptime = process.uptime();
    const hrs = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const secs = Math.floor(uptime % 60);
    const uptimeStr = `${hrs}h ${mins}m ${secs}s`;

    const embed = new EmbedBuilder()
        .setTitle('QUANTUMBLOX STORE — Version Dashboard')
        .setColor('#2b2d31')
        .setDescription(
            `**v${BOT_VERSION.version}** — ${BOT_VERSION.codename}\n` +
            `Released: ${BOT_VERSION.date}`
        )
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

    try {
        // Find existing version dashboard message and edit it
        const messages = await channel.messages.fetch({ limit: 20 });
        const existing = messages.find(m =>
            m.author.id === client.user.id &&
            m.embeds[0]?.title?.includes('Version Dashboard')
        );

        if (existing) {
            await existing.edit({ embeds: [embed] });
            console.log('[VERSION] Dashboard updated (edited existing).');
        } else {
            // Delete old "Bot Online" embeds if any
            const oldEmbeds = messages.filter(m =>
                m.author.id === client.user.id &&
                (m.embeds[0]?.title === 'Bot Online' || m.embeds[0]?.title?.includes('Bot Online'))
            );
            for (const [, msg] of oldEmbeds) {
                await msg.delete().catch(() => { });
                console.log('[VERSION] Deleted old Bot Online embed.');
            }

            await channel.send({ embeds: [embed] });
            console.log('[VERSION] Dashboard created (new message).');
        }
    } catch (err) {
        console.error(`[VERSION] Failed to update dashboard: ${err.message}`);
    }
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

    try {
        const messages = await channel.messages.fetch({ limit: 10 });
        const existing = messages.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('Honeypot Protection'));
        if (existing) {
            await existing.edit({ embeds: [embed] });
            console.log('[HONEYPOT] Warning embed edited.');
        } else {
            // Delete all other messages in honeypot channel to keep it clean
            for (const [, msg] of messages) {
                await msg.delete().catch(() => { });
            }
            await channel.send({ embeds: [embed] });
            console.log('[HONEYPOT] New warning embed sent.');
        }
    } catch (err) {
        console.error(`[HONEYPOT] Failed to update warning: ${err.message}`);
    }
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

                const products = productsRes.data;
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
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

                const { data: user } = await supabase.from('users').select('id').eq('id', interaction.user.id).single();
                if (user) return interaction.editReply({ content: '⚠️ You are already registered!' });

                const { error: insertErr } = await supabase.from('users').insert([{ id: interaction.user.id }]);
                if (insertErr) return interaction.editReply({ content: `❌ Registration failed: ${insertErr.message}` });

                return interaction.editReply({ content: '✅ Successfully registered! You can now buy products.' });
            }

            // ── btn_auction_register ──────────────────────────
            if (interaction.customId === 'btn_auction_register') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const { data: user } = await supabase.from('users').select('id').eq('id', interaction.user.id).single();
                if (user) return interaction.editReply({ content: '⚠️ You are already registered!' });
                const { error: insertErr } = await supabase.from('users').insert([{ id: interaction.user.id }]);
                if (insertErr) return interaction.editReply({ content: `❌ Registration failed: ${insertErr.message}` });
                return interaction.editReply({ content: '✅ Successfully registered for the auction system!' });
            }

            // ── btn_open_bid ──────────────────────────────────
            if (interaction.customId === 'btn_open_bid') {
                const { data: user } = await supabase.from('users').select('id').eq('id', interaction.user.id).single();
                if (!user) return interaction.reply({ content: '❌ Please register first by clicking the **Register** button.', flags: [MessageFlags.Ephemeral] });

                const { data: auction } = await supabase.from('auctions').select('*').eq('status', 'active').single();
                if (!auction) return interaction.reply({ content: '❌ There is no active auction.', flags: [MessageFlags.Ephemeral] });

                const modal = new ModalBuilder().setCustomId('mod_open_bid').setTitle(`💰 Place Bid | ${auction.name}`);
                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('amount').setLabel('Bid Amount (Rp)').setPlaceholder('e.g. 50000').setStyle(TextInputStyle.Short).setRequired(true)
                ));
                return interaction.showModal(modal);
            }

            // ── btn_auction_settings ──────────────────────────
            if (interaction.customId === 'btn_auction_settings') {
                if (!interaction.member.roles.cache.has(process.env.ADMIN_ROLE_ID))
                    return interaction.reply({ content: '❌ Only admins can access settings.', flags: [MessageFlags.Ephemeral] });

                const menu = new StringSelectMenuBuilder()
                    .setCustomId('sel_auction_admin')
                    .setPlaceholder('Auction Management...')
                    .addOptions([
                        { label: 'Add Auction Product', description: 'Create a new auction session', value: 'opt_add_auction', emoji: '➕' },
                        { label: 'Add Stock Data', description: 'Quickly add products to stock', value: 'opt_add_auction_stock', emoji: '📦' },
                        { label: 'Start/Stop Auction', description: 'Toggle auction status', value: 'opt_toggle_auction', emoji: '⚙️' }
                    ]);

                return interaction.reply({
                    content: '🛠️ **Auction Admin Menu**',
                    components: [new ActionRowBuilder().addComponents(menu)],
                    flags: [MessageFlags.Ephemeral]
                });
            }

            // ── btn_db_add_ ───────────────────────────────────
            // NOTE: showModal cannot be called after deferReply
            if (interaction.customId.startsWith('btn_db_add_')) {
                if (!interaction.member.roles.cache.has(process.env.ADMIN_ROLE_ID))
                    return interaction.reply({ content: '❌ Admins only.', flags: [MessageFlags.Ephemeral] });

                const pid = interaction.customId.replace('btn_db_add_', '');
                const modal = new ModalBuilder().setCustomId(`mod_db_add_${pid}`).setTitle(`Add Stock | ${pid}`);
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

            // ── btn_check_pay_ ────────────────────────────────
            if (interaction.customId.startsWith('btn_check_pay_')) {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
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

                        // specialized logging for auctions
                        const isAuction = pay.product_id.startsWith('AUCTION:');

                        // DM buyer with items
                        await interaction.user.send({
                            embeds: [new EmbedBuilder()
                                .setTitle(isAuction ? '🏆  Auction Item Delivered' : '✅  Order Confirmed').setColor('#00b894')
                                .setDescription(isAuction ? `Congratulations on winning the auction! Here is your item for **${pay.product_id.replace('AUCTION: ', '')}**.` : 'Your order has been processed successfully. Please keep this receipt for your records.')
                                .addFields(
                                    { name: 'Order ID', value: `\`${orderId}\``, inline: false },
                                    { name: 'Product', value: pay.product_id, inline: true },
                                    { name: 'Quantity', value: `${pay.qty}x`, inline: true },
                                    { name: 'Total Paid', value: fmt, inline: true },
                                    { name: 'Delivered Items', value: deliver.map((d, i) => `**${i + 1}.** \`${d}\``).join('\n') || '—', inline: false }
                                )
                                .setFooter({ text: `QUANTUMBLOX ${isAuction ? 'AUCTION' : 'STORE'} — Thank you!` }).setTimestamp()
                            ]
                        }).catch(() => { });

                        // Auction Specialized Logs
                        if (isAuction) {
                            // Transaction Log
                            const transLogChan = await client.channels.fetch(process.env.AUCTION_TRANSACTION_LOG_ID).catch(() => null);
                            if (transLogChan) {
                                const embed = new EmbedBuilder()
                                    .setTitle('💰 Auction Payment Received')
                                    .setColor('#00d2d3')
                                    .addFields(
                                        { name: 'Order ID', value: `\`${orderId}\``, inline: false },
                                        { name: 'Winner', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                                        { name: 'Auction', value: pay.product_id.replace('AUCTION: ', ''), inline: true },
                                        { name: 'Amount Paid', value: fmt, inline: true }
                                    )
                                    .setTimestamp();
                                await transLogChan.send({ embeds: [embed] }).catch(() => { });
                            }

                            // Delivery Log
                            const deliveryLogChan = await client.channels.fetch(process.env.AUCTION_DELIVERY_LOG_ID).catch(() => null);
                            if (deliveryLogChan) {
                                const embed = new EmbedBuilder()
                                    .setTitle('📦 Auction Item Delivered')
                                    .setColor('#54a0ff')
                                    .addFields(
                                        { name: 'Order ID', value: `\`${orderId}\``, inline: false },
                                        { name: 'Receiver', value: `<@${interaction.user.id}>`, inline: true },
                                        { name: 'Items', value: `\`${deliver.length} items delivered\``, inline: true }
                                    )
                                    .setTimestamp();
                                await deliveryLogChan.send({ embeds: [embed] }).catch(() => { });
                            }
                        }

                        // Ephemeral reply (no items)
                        await interaction.editReply({
                            embeds: [new EmbedBuilder()
                                .setTitle('✅  Order Confirmed').setColor('#00b894')
                                .setDescription('Your order has been processed. Your item(s) have been delivered to your DMs.')
                                .addFields(
                                    { name: 'Order ID', value: `\`${orderId}\``, inline: false },
                                    { name: 'Product', value: pay.product_id, inline: true },
                                    { name: 'Quantity', value: `${pay.qty}x`, inline: true },
                                    { name: 'Total', value: fmt, inline: true }
                                )
                                .setFooter({ text: 'QUANTUMBLOX STORE' }).setTimestamp()
                            ]
                        });

                        // History log
                        if (process.env.HISTORY_LOG_CHANNEL_ID) {
                            const logChan = await client.channels.fetch(process.env.HISTORY_LOG_CHANNEL_ID).catch(() => null);
                            if (logChan) logChan.send({
                                embeds: [new EmbedBuilder()
                                    .setTitle('Order Completed').setColor('#2d3436')
                                    .addFields(
                                        { name: 'Order ID', value: `\`${orderId}\``, inline: false },
                                        { name: 'Buyer', value: `<@${interaction.user.id}>`, inline: true },
                                        { name: 'Product', value: pay.product_id, inline: true },
                                        { name: 'Quantity', value: `${pay.qty}x`, inline: true },
                                        { name: 'Total', value: fmt, inline: true },
                                        { name: 'Process', value: 'Automatic', inline: true }
                                    )
                                    .setFooter({ text: `QUANTUMBLOX STORE • ${orderId}` }).setTimestamp()
                                ]
                            }).catch(() => { });
                        }

                        // Payment log
                        if (process.env.PAYMENT_LOG_CHANNEL_ID) {
                            const payLogChan = await client.channels.fetch(process.env.PAYMENT_LOG_CHANNEL_ID).catch(() => null);
                            if (payLogChan) payLogChan.send({
                                embeds: [new EmbedBuilder()
                                    .setTitle('Payment Received').setColor('#0099ff')
                                    .addFields(
                                        { name: 'Order ID', value: `\`${orderId}\``, inline: false },
                                        { name: 'Buyer', value: `<@${interaction.user.id}>`, inline: true },
                                        { name: 'Product', value: pay.product_id, inline: true },
                                        { name: 'Quantity', value: `${pay.qty}x`, inline: true },
                                        { name: 'Total', value: fmt, inline: true },
                                        { name: 'Status', value: 'Completed', inline: true }
                                    )
                                    .setFooter({ text: `QUANTUMBLOX STORE • ${orderId}` }).setTimestamp()
                                ]
                            }).catch(() => { });
                        }

                        // Give Costumer Role
                        const costumerRoleId = process.env.COSTUMER_ROLE_ID;
                        if (costumerRoleId && interaction.member) {
                            try {
                                if (!interaction.member.roles.cache.has(costumerRoleId)) {
                                    await interaction.member.roles.add(costumerRoleId);
                                    console.log(`[ROLE] Added Costumer role to ${interaction.user.tag}`);
                                }
                            } catch (roleErr) {
                                console.error(`[ROLE] Failed to add Costumer role: ${roleErr.message}`);
                            }
                        }

                        updateDashboard();
                        updateDatabaseEmbed(pay.product_id);

                    } else {
                        return interaction.editReply({ content: '⏳ Payment not confirmed yet. Please complete the payment and try again.' });
                    }
                } catch (e) {
                    const errMsg = e?.response?.data ? JSON.stringify(e.response.data) : e.message;
                    console.error('Payment Check Error:', errMsg);
                    return interaction.editReply({ content: `❌ Error checking payment. (${e?.response?.status || 'network error'})` });
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
                    const { data: products } = await supabase.from('products').select('*').order('name');
                    if (!products || products.length === 0) return interaction.editReply({ content: '❌ No products to edit.' });
                    const menu = new StringSelectMenuBuilder().setCustomId('sel_p_edit_pick').setPlaceholder('Select a product to edit...');
                    products.forEach(p => menu.addOptions({ label: p.name, description: `ID: ${p.id} | Price: ${p.price}`, value: p.id }));
                    return interaction.editReply({ content: '✏️ Select a product to edit:', components: [new ActionRowBuilder().addComponents(menu)] });
                }

                if (choice === 'opt_del_p') {
                    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                    const { data: products } = await supabase.from('products').select('*').order('name');
                    if (!products || products.length === 0) return interaction.editReply({ content: '❌ No products to delete.' });
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
                    const { data: products } = await supabase.from('products').select('*').order('name');
                    if (!products || products.length === 0) return interaction.editReply({ content: '❌ No products found.' });

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
                const modal = new ModalBuilder().setCustomId(`mod_p_edit_${pid}`).setTitle(`Edit Product | ${pid}`);
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
                await supabase.from('products').delete().eq('id', pid);
                await interaction.editReply({ content: `✅ Product \`${pid}\` has been permanently deleted.`, components: [] });
                updateDashboard();
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
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Product Name').setPlaceholder('e.g. Steam Account High Level').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('base_price').setLabel('Start Price (Rp)').setPlaceholder('e.g. 50000').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('increment').setLabel('Bid Increment (Rp)').setValue('5000').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('duration').setLabel('Duration (Minutes)').setPlaceholder('e.g. 60').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pid').setLabel('Stock Product ID (Optional)').setPlaceholder('e.g. 1499...').setStyle(TextInputStyle.Short).setRequired(false))
                    );
                    try { return await interaction.showModal(modal); }
                    catch (e) { console.error('[MODAL] opt_add_auction showModal failed:', e.message); return; }
                }

                if (choice === 'opt_add_auction_stock') {
                    const modal = new ModalBuilder().setCustomId('mod_auction_add_stock').setTitle('📦 Add Stock Data');
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pid').setLabel('Stock Product ID').setPlaceholder('Enter the ID of the product...').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('content').setLabel('Stock Content (one per line)').setPlaceholder('item1\nitem2\nitem3...').setStyle(TextInputStyle.Paragraph).setRequired(true))
                    );
                    try { return await interaction.showModal(modal); }
                    catch (e) { console.error('[MODAL] opt_add_auction_stock failed:', e.message); return; }
                }

                if (choice === 'opt_toggle_auction') {
                    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                    const { data: auctions } = await supabase.from('auctions').select('*').in('status', ['pending', 'active']).order('created_at', { ascending: false });
                    if (!auctions || auctions.length === 0) return interaction.editReply({ content: '❌ No pending or active auctions found.' });

                    const menu = new StringSelectMenuBuilder().setCustomId('sel_auction_toggle_pick').setPlaceholder('Select an auction to toggle status...');
                    auctions.forEach(a => menu.addOptions({ label: `${a.name} (${a.status})`, description: `Base: ${a.base_price}`, value: a.id }));
                    return interaction.editReply({ content: '⚙️ **Auction Manager**\nSelect an auction to toggle its status:', components: [new ActionRowBuilder().addComponents(menu)] });
                }
                return;
            }

            // ── sel_auction_toggle_pick ──────────────────────
            if (interaction.customId === 'sel_auction_toggle_pick') {
                await interaction.deferUpdate();
                const aid = interaction.values[0];
                const { data: auction } = await supabase.from('auctions').select('*').eq('id', aid).single();
                if (!auction) return interaction.editReply({ content: '❌ Auction not found.', components: [] });

                const newStatus = auction.status === 'active' ? 'ended' : 'active';
                const { error } = await supabase.from('auctions').update({ status: newStatus }).eq('id', aid);
                if (error) return interaction.editReply({ content: `❌ Failed to update status: ${error.message}`, components: [] });

                if (newStatus === 'ended' && auction.highest_bidder_id) {
                    const winnerId = auction.highest_bidder_id;
                    const finalAmount = auction.current_bid;
                    const orderId = `AUC${Date.now()}`;

                    // Public Winner Notification
                    const winChan = await client.channels.fetch(process.env.AUCTION_WIN_CHANNEL_ID).catch(() => null);
                    if (winChan) {
                        const winEmbed = new EmbedBuilder()
                            .setTitle('🏆 AUCTION WINNER!')
                            .setColor('#f1c40f')
                            .setDescription(`The auction for **${auction.name}** has ended!\n\n👑 **Winner:** <@${winnerId}>\n💰 **Winning Bid:** \`${formatPrice(finalAmount)}\`\n\n*Please check your DMs for payment instructions.*`)
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
                                product_id: auction.product_id || `AUCTION: ${auction.name}`,
                                qty: 1,
                                amount: finalAmount,
                                created_at: new Date().toISOString()
                            }]);

                            const winner = await client.users.fetch(winnerId).catch(() => null);
                            if (winner) {
                                const embed = new EmbedBuilder()
                                    .setTitle('🏆  Auction Won!')
                                    .setColor('#f1c40f')
                                    .setDescription(`Congratulations! You won the auction for **${auction.name}**.\n\nPlease complete the payment using the QRIS below to receive your item.`)
                                    .addFields(
                                        { name: 'Auction ID', value: `\`${auction.id}\``, inline: false },
                                        { name: 'Product', value: auction.name, inline: true },
                                        { name: 'Final Bid', value: formatPrice(finalAmount), inline: true },
                                        { name: 'Order ID', value: `\`${orderId}\``, inline: false }
                                    )
                                    .setImage(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(res.data.payment.payment_number)}`)
                                    .setFooter({ text: 'QUANTUMBLOX AUCTION SYSTEM' }).setTimestamp();

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

                await interaction.editReply({ content: `✅ Auction \`${auction.name}\` is now **${newStatus.toUpperCase()}**.`, components: [] });
                updateAuctionDashboard();
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

                const { error: insertErr } = await supabase.from('products').insert([{
                    id,
                    name,
                    stock: 0,
                    price: formatPrice(price),
                    format,
                    description: desc
                }]);

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

            // ── mod_auction_add ──────────────────────────────
            if (interaction.customId === 'mod_auction_add') {
                const name = interaction.fields.getTextInputValue('name');
                const basePriceStr = interaction.fields.getTextInputValue('base_price');
                const incStr = interaction.fields.getTextInputValue('increment');
                const duration = parseInt(interaction.fields.getTextInputValue('duration'));
                const linkedPid = interaction.fields.getTextInputValue('pid') || null;
                const desc = '-'; // Removed from modal to stay within 5-field limit

                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

                const basePrice = parseInt(basePriceStr.replace(/\D/g, ''));
                const increment = parseInt(incStr.replace(/\D/g, '')) || 5000;
                if (isNaN(basePrice) || isNaN(duration) || isNaN(increment)) return interaction.editReply({ content: '❌ Invalid price, increment, or duration format.' });

                const endTime = new Date(Date.now() + duration * 60000).toISOString();

                const { error: insertErr } = await supabase.from('auctions').insert([{
                    name,
                    description: desc,
                    base_price: basePrice,
                    current_bid: basePrice,
                    bid_increment: increment,
                    product_id: linkedPid,
                    status: 'pending',
                    end_time: endTime
                }]);

                if (insertErr) return interaction.editReply({ content: `❌ Failed to create auction: ${insertErr.message}` });

                await interaction.editReply({ content: `✅ Auction product \`${name}\` created as PENDING. Start it via Settings.` });
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
                        const config = loadConfig();
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
                const pid = interaction.fields.getTextInputValue('pid');
                const content = interaction.fields.getTextInputValue('content');

                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

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
                updateDashboard();
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
    console.log(`[READY] Bot is online as ${client.user.tag}`);
    console.log(`[INTENTS] Guilds, GuildMessages, MessageContent, GuildMembers are ACTIVE.`);
    client.user.setActivity('QUANTUMBLOX STORE ON', { type: ActivityType.Custom });

    await registerCommands();
    updateDashboard();
    updateVersionDashboard();
    updateAuctionDashboard();
    checkAuctionDeadlines();
    updateHoneypotWarning();

    // Refresh database monitor embeds on startup
    const { data: products } = await supabase.from('products').select('id');
    if (products) {
        console.log(`[READY] Refreshing ${products.length} product embeds...`);
        for (const p of products) {
            updateDatabaseEmbed(p.id).catch(e => console.error(`[READY] Failed to update ${p.id}:`, e.message));
        }
    }

    const config = loadConfig();
    const interval = Math.max(5000, config.updateInterval || 15000);
    setInterval(() => {
        updateDashboard();
        updateVersionDashboard();
        updateAuctionDashboard();
        checkAuctionDeadlines();
        updateHoneypotWarning();
    }, interval);
});

client.login(process.env.DISCORD_TOKEN);