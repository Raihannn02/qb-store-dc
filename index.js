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
// CONFIG HELPERS
// ─────────────────────────────────────────────────────────────

function loadConfig() {
    try {
        if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify({}, null, 2), 'utf8');
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) { console.error('Error loading config:', err); return {}; }
}

function saveConfig(data) {
    try { fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf8'); return true; }
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

    const embed = new EmbedBuilder()
        .setTitle(`🛡️ DATABASE MONITOR | ${safeStr(product.name, productId).toUpperCase()}`.slice(0, 256))
        .setDescription(`Monitoring stock entries for product ID: \`${productId}\``)
        .setColor('#C29C1D')
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
        products.forEach(p => fields.push({
            name: `🛒 ${p.name.toUpperCase()}`,
            value: `>>> 📦 **Stock:** \`${p.stock}\`\n💰 **Price:** \`${p.price}\`\n📋 **Format:** \`${p.format}\`\n📝 **Info:** ${p.description}\n🆔 **ID:** ||${p.id}||`,
            inline: false
        }));
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

            // ── btn_buy ───────────────────────────────────────
            if (interaction.customId === 'btn_buy') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

                const { data: user } = await supabase.from('users').select('id').eq('id', interaction.user.id).single();
                if (!user) return interaction.editReply({ content: '❌ Please register first by clicking the **Register** button.' });

                const { data: products } = await supabase.from('products').select('*').order('name');
                if (!products || products.length === 0) return interaction.editReply({ content: '❌ No products available at the moment.' });

                const s = new StringSelectMenuBuilder()
                    .setCustomId('sel_buy')
                    .setPlaceholder('Choose a product to purchase...')
                    .addOptions(products.map(x => ({
                        label: x.name,
                        description: `Stock: ${x.stock} | Price: ${x.price}`,
                        value: x.id
                    })));

                return interaction.editReply({ components: [new ActionRowBuilder().addComponents(s)] });
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

                        // DM buyer with items
                        await interaction.user.send({
                            embeds: [new EmbedBuilder()
                                .setTitle('✅  Order Confirmed').setColor('#00b894')
                                .setDescription('Your order has been processed successfully. Please keep this receipt for your records.')
                                .addFields(
                                    { name: 'Order ID', value: `\`${orderId}\``, inline: false },
                                    { name: 'Product', value: pay.product_id, inline: true },
                                    { name: 'Quantity', value: `${pay.qty}x`, inline: true },
                                    { name: 'Total Paid', value: fmt, inline: true },
                                    { name: 'Delivered Items', value: deliver.map((d, i) => `**${i + 1}.** \`${d}\``).join('\n') || '—', inline: false }
                                )
                                .setFooter({ text: 'QUANTUMBLOX STORE — Thank you for your purchase.' }).setTimestamp()
                            ]
                        }).catch(() => { });

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
                // Show modal immediately — stock validation happens in mod_buy_ handler
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

            // Unhandled select menu
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
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

                const id = interaction.fields.getTextInputValue('id').trim().toUpperCase();
                const { data: existing } = await supabase.from('products').select('id').eq('id', id).single();
                if (existing) return interaction.editReply({ content: `❌ Product ID \`${id}\` already exists.` });

                const { error: insertErr } = await supabase.from('products').insert([{
                    id,
                    name: interaction.fields.getTextInputValue('name'),
                    stock: 0,
                    price: formatPrice(interaction.fields.getTextInputValue('price')),
                    format: interaction.fields.getTextInputValue('format'),
                    description: interaction.fields.getTextInputValue('desc') || '-'
                }]);

                if (insertErr) return interaction.editReply({ content: `❌ Failed to add product: ${insertErr.message}` });

                await interaction.editReply({ content: `✅ Product \`${id}\` added successfully!` });
                updateDashboard();
                updateDatabaseEmbed(id).catch(e => console.error(`[DB EMBED] Failed for '${id}': ${e.message}`));
                return;
            }

            // ── mod_p_edit_ ───────────────────────────────────
            if (interaction.customId.startsWith('mod_p_edit_')) {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const pid = interaction.customId.replace('mod_p_edit_', '');

                const { error: updateErr } = await supabase.from('products').update({
                    name: interaction.fields.getTextInputValue('name'),
                    price: formatPrice(interaction.fields.getTextInputValue('price')),
                    format: interaction.fields.getTextInputValue('format'),
                    description: interaction.fields.getTextInputValue('desc') || '-'
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
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const inv = interaction.fields.getTextInputValue('inv').trim();

                const { data: pay } = await supabase.from('pending_payments').select('*').eq('invoice_id', inv).single();
                if (!pay) return interaction.editReply({ content: `❌ Order ID \`${inv}\` not found.` });

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
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const pid = interaction.customId.replace('mod_buy_', '');
                const qty = parseInt(interaction.fields.getTextInputValue('q'));

                if (isNaN(qty) || qty <= 0)
                    return interaction.editReply({ content: '❌ Invalid quantity. Please enter a positive number.' });

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

            return; // end isModalSubmit()
        }

    } catch (e) {
        console.error('Interaction Error:', e);
        // Always respond so Discord does not show "This interaction failed"
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content: '❌ An unexpected error occurred. Please try again.' });
            } else {
                await interaction.reply({ content: '❌ An unexpected error occurred. Please try again.', flags: [MessageFlags.Ephemeral] });
            }
        } catch (_) { /* suppress double-reply errors */ }
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

    // Refresh database monitor embeds on startup
    const { data: products } = await supabase.from('products').select('id');
    if (products) {
        console.log(`[READY] Refreshing ${products.length} product embeds...`);
        for (const p of products) {
            updateDatabaseEmbed(p.id).catch(e => console.error(`[READY] Failed to update ${p.id}:`, e.message));
        }
    }

    const config = loadConfig();
    setInterval(updateDashboard, (config.updateInterval || 15000));
});

client.login(process.env.DISCORD_TOKEN);