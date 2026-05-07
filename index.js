require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActivityType, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

function formatPrice(input) {
    if (!input || input === '0') return 'Rp. 0';
    const digits = input.toString().replace(/\D/g, '');
    if (digits === '') return input;
    const price = parseInt(digits);
    return `Rp. ${new Intl.NumberFormat('id-ID').format(price)}`;
}

process.on('unhandledRejection', err => console.error('Unhandled Promise Rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const configPath = path.join(__dirname, 'config.json');
const productsPath = path.join(__dirname, 'products.json');
const usersPath = path.join(__dirname, 'users.json');
const stockPath = path.join(__dirname, 'stock.json');
const pendingPaymentsPath = path.join(__dirname, 'pending_payments.json');

let dashboardMessageId = null;

function loadJSON(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            const defaultEmpty = filePath.endsWith('users.json') ? []
                : filePath.endsWith('pending_payments.json') ? {}
                    : filePath.endsWith('stock.json') ? {}
                        : {};
            fs.writeFileSync(filePath, JSON.stringify(defaultEmpty, null, 2), 'utf8');
        }
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error(`Error reading ${filePath}:`, err);
        return null;
    }
}

function saveJSON(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (err) {
        console.error(`Error writing ${filePath}:`, err);
        return false;
    }
}

async function updateDatabaseEmbed(productId) {
    const stock = loadJSON(stockPath);
    const products = loadJSON(productsPath);
    const product = products.find(p => p.id === productId);
    if (!product) return;

    const config = loadJSON(configPath);
    const dbChannelId = process.env.DATABASE_CHANNEL_ID || config.dashboardChannelId;
    if (!dbChannelId) return;

    try {
        const channel = await client.channels.fetch(dbChannelId);
        if (!channel) return;

        const productStock = stock[productId] || [];
        const unixTime = Math.floor(Date.now() / 1000);
        const embed = new EmbedBuilder()
            .setTitle(`🛡️ DATABASE MONITOR | ${product.name.toUpperCase()}`)
            .setDescription(`Monitoring stock entries for product ID: \`${productId}\``)
            .setColor('#C29C1D')
            .addFields(
                { name: '⏱️ Last Update', value: `<t:${unixTime}:R>`, inline: false },
                { name: '📊 Summary', value: `> **Total Items:** \`${productStock.length}\``, inline: false },
                {
                    name: '📦 Available Items',
                    value: productStock.length > 0
                        ? productStock.slice(0, 15).map((s, i) => `**${i + 1}.** \`${s.data.replaceAll('|', ', ')}\` • <t:${Math.floor(s.added_at / 1000)}:R>`).join('\n') + (productStock.length > 15 ? '\n*... and more*' : '')
                        : '*No stock items found in database.*'
                }
            )
            .setFooter({ text: `QUANTUMBLOX DATABASE SYSTEM • ${productId}` })
            .setTimestamp();

        if (config.embed?.thumbnail) embed.setThumbnail(config.embed.thumbnail);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`btn_db_add_${productId}`).setLabel('Add Stock').setEmoji('➕').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`btn_db_edit_pick_${productId}`).setLabel('Edit Stock').setEmoji('📝').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`btn_db_del_pick_${productId}`).setLabel('Delete Stock').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
        );

        const messages = await channel.messages.fetch({ limit: 50 });
        const productMsg = messages.find(m => m.embeds[0]?.footer?.text?.includes(productId));

        if (productMsg) {
            await productMsg.edit({ embeds: [embed], components: [row] });
        } else {
            await channel.send({ embeds: [embed], components: [row] });
        }
    } catch (e) {
        console.error('Database Embed Update Error:', e);
    }
}

async function registerCommands() {
    // Slash commands are no longer used for administration.
    // All features have been migrated to Button-Based interactions.
    const commands = [];
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    } catch (e) { console.error(e); }
}

async function updateDashboard() {
    const config = loadJSON(configPath);
    const products = loadJSON(productsPath);
    if (!config || !products) return;

    try {
        const channel = await client.channels.fetch(config.channelId);
        if (!channel) return;

        const embed = new EmbedBuilder()
            .setTitle(config.embed?.title || "Shop Dashboard")
            .setDescription(config.embed?.description || "Live stock updates.")
            .setColor(config.embed?.color || "#2b2d31")
            .setTimestamp();

        if (config.embed?.thumbnail) embed.setThumbnail(config.embed.thumbnail);

        const unixTime = Math.floor(Date.now() / 1000);
        let fields = [{ name: "⏱️ Last Update", value: `<t:${unixTime}:R>`, inline: false }];

        products.forEach(p => {
            fields.push({
                name: `🛒 ${p.name.toUpperCase()}`,
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
            } catch (e) { dashboardMessageId = null; }
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
        if (e.code === 'ENOTFOUND' || e.code === 'ETIMEDOUT') {
            // Suppress noise for intermittent network issues
            return;
        }
        console.error('Dashboard Update Error:', e);
    }
}

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isChatInputCommand()) {
            return interaction.reply({ content: 'Slash commands are disabled. Please use buttons on the dashboard.', flags: [MessageFlags.Ephemeral] });
        }

        if (interaction.isButton()) {
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

                await interaction.reply({
                    content: '🛠️ **Admin Settings Menu**\nChoose what you would like to manage below:',
                    components: [new ActionRowBuilder().addComponents(menu)],
                    flags: [MessageFlags.Ephemeral]
                });
                return;
            }
            if (interaction.customId === 'btn_register') {
                const users = loadJSON(usersPath) || [];
                if (users.includes(interaction.user.id)) return interaction.reply({ content: 'Already registered!', flags: [MessageFlags.Ephemeral] });
                users.push(interaction.user.id);
                saveJSON(usersPath, users);
                await interaction.reply({ content: 'Registered!', flags: [MessageFlags.Ephemeral] });
            }
            else if (interaction.customId === 'btn_buy') {
                if (!(loadJSON(usersPath) || []).includes(interaction.user.id)) return interaction.reply({ content: 'Register first!', flags: [MessageFlags.Ephemeral] });
                const p = loadJSON(productsPath) || [];
                if (p.length === 0) return interaction.reply({ content: 'No products.', flags: [MessageFlags.Ephemeral] });
                const s = new StringSelectMenuBuilder().setCustomId('sel_buy').setPlaceholder('Choose a product')
                    .addOptions(p.map(x => ({ label: x.name, description: `Stock: ${x.stock} | Price: ${x.price}`, value: x.id })));
                await interaction.reply({ components: [new ActionRowBuilder().addComponents(s)], flags: [MessageFlags.Ephemeral] });
            }
            else if (interaction.customId.startsWith('btn_db_add_')) {
                if (!interaction.member.roles.cache.has(process.env.ADMIN_ROLE_ID)) return interaction.reply({ content: 'Admins only.', flags: [MessageFlags.Ephemeral] });
                const pid = interaction.customId.replace('btn_db_add_', '');
                const modal = new ModalBuilder().setCustomId(`mod_db_add_${pid}`).setTitle(`Add Stock | ${pid}`);
                modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('data').setLabel('Stock Data').setPlaceholder('Contoh: UsernameSteam|PasswordSteam|EmailAcc|PasswordAcc').setStyle(TextInputStyle.Paragraph).setRequired(true)));
                await interaction.showModal(modal);
            }
            else if (interaction.customId.startsWith('btn_db_edit_pick_')) {
                if (!interaction.member.roles.cache.has(process.env.ADMIN_ROLE_ID)) return interaction.reply({ content: 'Admins only.', flags: [MessageFlags.Ephemeral] });
                const pid = interaction.customId.replace('btn_db_edit_pick_', '');
                const stock = loadJSON(stockPath)[pid] || [];
                if (stock.length === 0) return interaction.reply({ content: 'No stock to edit.', flags: [MessageFlags.Ephemeral] });
                const select = new StringSelectMenuBuilder().setCustomId(`sel_db_edit_${pid}`).setPlaceholder('Select an entry');
                stock.slice(0, 25).forEach((s, i) => select.addOptions({ label: `${i + 1}. ${s.data.slice(0, 40)}`, value: i.toString() }));
                await interaction.reply({ content: 'Select entry:', components: [new ActionRowBuilder().addComponents(select)], flags: [MessageFlags.Ephemeral] });
            }
            else if (interaction.customId.startsWith('btn_db_del_pick_')) {
                if (!interaction.member.roles.cache.has(process.env.ADMIN_ROLE_ID)) return interaction.reply({ content: 'Admins only.', flags: [MessageFlags.Ephemeral] });
                const pid = interaction.customId.replace('btn_db_del_pick_', '');
                const stock = loadJSON(stockPath)[pid] || [];
                if (stock.length === 0) return interaction.reply({ content: 'No stock to delete.', flags: [MessageFlags.Ephemeral] });
                const select = new StringSelectMenuBuilder().setCustomId(`sel_db_del_${pid}`).setPlaceholder('Select to delete');
                stock.slice(0, 25).forEach((s, i) => select.addOptions({ label: `${i + 1}. ${s.data.slice(0, 40)}`, value: i.toString() }));
                await interaction.reply({ content: 'Select entry:', components: [new ActionRowBuilder().addComponents(select)], flags: [MessageFlags.Ephemeral] });
            }
            else if (interaction.customId.startsWith('btn_check_pay_')) {
                const orderId = interaction.customId.replace('btn_check_pay_', '');
                const pending = loadJSON(pendingPaymentsPath);
                const pay = pending[orderId];
                if (!pay) return interaction.reply({ content: 'Invalid transaction.', flags: [MessageFlags.Ephemeral] });
                if (pay.processing) return interaction.reply({ content: 'Processing. Wait...', flags: [MessageFlags.Ephemeral] });

                pay.processing = true;
                saveJSON(pendingPaymentsPath, pending);
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

                try {
                    const res = await axios.get(`https://app.pakasir.com/api/transactiondetail`, {
                        params: { project: process.env.PAKASIR_SLUG, amount: pay.amount, order_id: orderId, api_key: process.env.PAKASIR_API_KEY }
                    });

                    if (res.data.transaction?.status === 'completed') {
                        const products = loadJSON(productsPath);
                        const pid = pay.productId;
                        const pIdx = products.findIndex(x => x.id === pid);
                        const stock = loadJSON(stockPath);

                        const deliver = stock[pid].splice(0, pay.qty);
                        products[pIdx].stock = stock[pid].length;
                        saveJSON(stockPath, stock);
                        saveJSON(productsPath, products);
                        delete pending[orderId];
                        saveJSON(pendingPaymentsPath, pending);

                        const successEmbed = new EmbedBuilder()
                            .setTitle('🎉 PURCHASE SUCCESSFUL')
                            .setColor('#43B581')
                            .setDescription(`➡ Produk: \`${pIdx !== -1 ? products[pIdx].name : pid}\`\n➡ Qty: \`${pay.qty}\`\n➡ Total: \`Rp. ${new Intl.NumberFormat('id-ID').format(pay.amount)}\`\n\n📋 Details:\n${deliver.map(d => `\`${d.data}\``).join('\n')}`)
                            .setTimestamp();

                        await interaction.user.send({ embeds: [successEmbed] }).catch(() => { });
                        await interaction.editReply({ content: '✅ Success! Items sent to DMs.', embeds: [successEmbed] });

                        // Log
                        const logChanId = process.env.HISTORY_LOG_CHANNEL_ID;
                        if (logChanId) {
                            const chan = await client.channels.fetch(logChanId).catch(() => null);
                            if (chan) chan.send({ embeds: [new EmbedBuilder().setTitle('ORDER COMPLETED').setDescription(`User: <@${interaction.user.id}>\nProduk: ${pid}\nTotal: Rp. ${pay.amount}`).setTimestamp()] });
                        }
                        updateDashboard();
                        updateDatabaseEmbed(pid);
                    } else {
                        pay.processing = false;
                        saveJSON(pendingPaymentsPath, pending);
                        await interaction.editReply({ content: 'Not paid yet.' });
                    }
                } catch (e) {
                    pay.processing = false;
                    saveJSON(pendingPaymentsPath, pending);
                    await interaction.editReply({ content: 'Error checking payment.' });
                }
            }
            return;
        }

        if (interaction.isStringSelectMenu()) {
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
                    return await interaction.showModal(modal);
                }
                else if (choice === 'opt_edit_p') {
                    const products = loadJSON(productsPath) || [];
                    if (products.length === 0) return interaction.reply({ content: 'No products to edit.', flags: [MessageFlags.Ephemeral] });
                    const menu = new StringSelectMenuBuilder().setCustomId('sel_p_edit_pick').setPlaceholder('Select a product to edit...');
                    products.forEach(p => menu.addOptions({ label: p.name, description: `ID: ${p.id} | Price: ${p.price}`, value: p.id }));
                    return await interaction.reply({ content: '✏️ Select a product to edit:', components: [new ActionRowBuilder().addComponents(menu)], flags: [MessageFlags.Ephemeral] });
                }
                else if (choice === 'opt_del_p') {
                    const products = loadJSON(productsPath) || [];
                    if (products.length === 0) return interaction.reply({ content: 'No products to delete.', flags: [MessageFlags.Ephemeral] });
                    const menu = new StringSelectMenuBuilder().setCustomId('sel_p_del_pick').setPlaceholder('Select a product to DELETE...');
                    products.forEach(p => menu.addOptions({ label: p.name, description: `ID: ${p.id} | Price: ${p.price}`, value: p.id }));
                    return await interaction.reply({ content: '🗑️ **CAUTION**: Select a product to PERMANENTLY delete:', components: [new ActionRowBuilder().addComponents(menu)], flags: [MessageFlags.Ephemeral] });
                }
                else if (choice === 'opt_manual_pay') {
                    const modal = new ModalBuilder().setCustomId('mod_manual_pay').setTitle('✅ Manual Confirm Payment');
                    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('inv').setLabel('Invoice / Order ID').setPlaceholder('e.g. INV123456789').setStyle(TextInputStyle.Short).setRequired(true)));
                    return await interaction.showModal(modal);
                }
                else if (choice === 'opt_config') {
                    const config = loadJSON(configPath);
                    const modal = new ModalBuilder().setCustomId('mod_config').setTitle('⚙️ Configure Dashboard');
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Embed Title').setValue(config.embed?.title || '').setStyle(TextInputStyle.Short).setRequired(false)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('desc').setLabel('Embed Description').setValue(config.embed?.description || '').setStyle(TextInputStyle.Paragraph).setRequired(false)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('Embed Color (Hex)').setValue(config.embed?.color || '#2b2d31').setStyle(TextInputStyle.Short).setRequired(false)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('thumb').setLabel('Thumbnail URL').setValue(config.embed?.thumbnail || '').setStyle(TextInputStyle.Short).setRequired(false)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('intv').setLabel('Update Interval (ms)').setValue(config.updateInterval?.toString() || '15000').setStyle(TextInputStyle.Short).setRequired(false))
                    );
                    return await interaction.showModal(modal);
                }
            }
            else if (interaction.customId === 'sel_p_edit_pick') {
                const pid = interaction.values[0];
                const p = loadJSON(productsPath).find(x => x.id === pid);
                if (!p) return interaction.update({ content: 'Product not found.', components: [] });
                const modal = new ModalBuilder().setCustomId(`mod_p_edit_${pid}`).setTitle(`Edit Product | ${pid}`);
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('New Name').setValue(p.name).setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('price').setLabel('New Price').setValue(p.price).setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('format').setLabel('New Format').setValue(p.format).setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('desc').setLabel('New Description').setValue(p.description).setStyle(TextInputStyle.Paragraph).setRequired(false))
                );
                return await interaction.showModal(modal);
            }
            else if (interaction.customId === 'sel_p_del_pick') {
                const pid = interaction.values[0];
                const products = loadJSON(productsPath).filter(p => p.id !== pid);
                const stock = loadJSON(stockPath); delete stock[pid];
                saveJSON(productsPath, products); saveJSON(stockPath, stock);
                await interaction.update({ content: `✅ Product \`${pid}\` has been permanently deleted.`, components: [] });
                updateDashboard();
                return;
            }
            if (interaction.customId === 'sel_buy') {
                const pid = interaction.values[0];
                const p = loadJSON(productsPath).find(x => x.id === pid);
                if (!p || p.stock <= 0) return interaction.update({ content: 'Out of stock.', components: [], flags: [MessageFlags.Ephemeral] });
                const modal = new ModalBuilder().setCustomId(`mod_buy_${pid}`).setTitle(`Buy ${p.name}`);
                modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('q').setLabel('Quantity').setStyle(TextInputStyle.Short).setRequired(true)));
                await interaction.showModal(modal);
            }
            else if (interaction.customId.startsWith('sel_db_edit_')) {
                const pid = interaction.customId.replace('sel_db_edit_', '');
                const idx = parseInt(interaction.values[0]);
                const stock = loadJSON(stockPath)[pid] || [];
                const modal = new ModalBuilder().setCustomId(`mod_db_edit_${pid}_${idx}`).setTitle('Edit Entry');
                modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('data').setLabel('Data').setValue(stock[idx].data).setStyle(TextInputStyle.Short).setRequired(true)));
                await interaction.showModal(modal);
            }
            else if (interaction.customId.startsWith('sel_db_del_')) {
                const pid = interaction.customId.replace('sel_db_del_', '');
                const idx = parseInt(interaction.values[0]);
                const stock = loadJSON(stockPath);
                if (stock[pid] && stock[pid][idx]) {
                    stock[pid].splice(idx, 1);
                    saveJSON(stockPath, stock);
                    const products = loadJSON(productsPath);
                    const p = products.find(x => x.id === pid);
                    if (p) p.stock = stock[pid].length;
                    saveJSON(productsPath, products);
                    await interaction.update({ content: '✅ Deleted.', components: [] });
                    updateDatabaseEmbed(pid);
                    updateDashboard();
                }
            }
            return;
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'mod_p_add') {
                const id = interaction.fields.getTextInputValue('id');
                const products = loadJSON(productsPath) || [];
                if (products.some(p => p.id === id)) return interaction.reply({ content: '❌ Product with this ID already exists.', flags: [MessageFlags.Ephemeral] });

                products.push({
                    id,
                    name: interaction.fields.getTextInputValue('name'),
                    stock: 0,
                    price: formatPrice(interaction.fields.getTextInputValue('price')),
                    format: interaction.fields.getTextInputValue('format'),
                    description: interaction.fields.getTextInputValue('desc') || '-'
                });
                saveJSON(productsPath, products);
                await interaction.reply({ content: `✅ Product \`${id}\` added successfully!`, flags: [MessageFlags.Ephemeral] });
                updateDashboard();
            }
            else if (interaction.customId.startsWith('mod_p_edit_')) {
                const pid = interaction.customId.replace('mod_p_edit_', '');
                const products = loadJSON(productsPath);
                const p = products.find(x => x.id === pid);
                if (!p) return interaction.reply({ content: '❌ Product not found.', flags: [MessageFlags.Ephemeral] });

                p.name = interaction.fields.getTextInputValue('name');
                p.price = formatPrice(interaction.fields.getTextInputValue('price'));
                p.format = interaction.fields.getTextInputValue('format');
                p.description = interaction.fields.getTextInputValue('desc');

                saveJSON(productsPath, products);
                await interaction.reply({ content: `✅ Product \`${pid}\` updated!`, flags: [MessageFlags.Ephemeral] });
                updateDashboard();
            }
            else if (interaction.customId === 'mod_config') {
                const config = loadJSON(configPath);
                if (!config.embed) config.embed = {};

                config.embed.title = interaction.fields.getTextInputValue('title');
                config.embed.description = interaction.fields.getTextInputValue('desc');
                config.embed.color = interaction.fields.getTextInputValue('color');
                config.embed.thumbnail = interaction.fields.getTextInputValue('thumb');

                const newIntv = parseInt(interaction.fields.getTextInputValue('intv'));
                if (!isNaN(newIntv)) config.updateInterval = Math.max(5000, newIntv);

                saveJSON(configPath, config);
                await interaction.reply({ content: '✅ Dashboard configuration updated!', flags: [MessageFlags.Ephemeral] });
                updateDashboard();
            }
            else if (interaction.customId === 'mod_manual_pay') {
                const inv = interaction.fields.getTextInputValue('inv').trim();
                const pending = loadJSON(pendingPaymentsPath);
                const pay = pending[inv];
                if (!pay) return interaction.reply({ content: `❌ Order ID \`${inv}\` not found.`, flags: [MessageFlags.Ephemeral] });

                const products = loadJSON(productsPath);
                const stock = loadJSON(stockPath);
                const prod = products.find(p => p.id === pay.productId);

                if (!prod || !stock[pay.productId] || stock[pay.productId].length < pay.qty) {
                    return interaction.reply({ content: '❌ Product or sufficient stock not found.', flags: [MessageFlags.Ephemeral] });
                }

                const items = stock[pay.productId].splice(0, pay.qty).map(s => s.data);
                saveJSON(stockPath, stock);
                prod.stock = stock[pay.productId].length;
                saveJSON(productsPath, products);
                delete pending[inv];
                saveJSON(pendingPaymentsPath, pending);

                const user = await client.users.fetch(pay.userId).catch(() => null);
                if (user) {
                    const buyEmbed = new EmbedBuilder()
                        .setTitle('✅ ORDER COMPLETED')
                        .setColor('#00ff00')
                        .setDescription(`Terima kasih telah berbelanja!\n\n**Produk:** \`${prod.name}\`\n**Jumlah:** \`${pay.qty}\`\n\n**Data Produk:**\n\`\`\`${items.join('\n')}\`\`\``)
                        .setTimestamp();
                    await user.send({ embeds: [buyEmbed] }).catch(() => { });
                }

                const logChannel = client.channels.cache.get(process.env.HISTORY_LOG_CHANNEL_ID);
                if (logChannel) {
                    const logEmbed = new EmbedBuilder().setTitle('📦 ORDER COMPLETED (MANUAL)').setColor('#00ff00')
                        .addFields(
                            { name: 'Buyer', value: `<@${pay.userId}>`, inline: true },
                            { name: 'Product', value: prod.name, inline: true },
                            { name: 'Qty', value: pay.qty.toString(), inline: true }
                        )
                        .setFooter({ text: `Order ID: ${inv} (Manual Fulfill)` }).setTimestamp();
                    await logChannel.send({ embeds: [logEmbed] });
                }

                await interaction.reply({ content: `✅ Order \`${inv}\` successfully fulfilled manually!`, flags: [MessageFlags.Ephemeral] });
                updateDashboard();
                updateDatabaseEmbed(pay.productId);
            }
            if (interaction.customId.startsWith('mod_db_add_')) {
                const pid = interaction.customId.replace('mod_db_add_', '');
                const lines = interaction.fields.getTextInputValue('data').split('\n').filter(l => l.trim());
                const stock = loadJSON(stockPath);
                if (!stock[pid]) stock[pid] = [];
                lines.forEach(l => stock[pid].push({ data: l.trim(), added_at: Date.now() }));
                saveJSON(stockPath, stock);
                const products = loadJSON(productsPath);
                const p = products.find(x => x.id === pid);
                if (p) p.stock = stock[pid].length;
                saveJSON(productsPath, products);
                await interaction.reply({ content: `Added ${lines.length} items.`, flags: [MessageFlags.Ephemeral] });
                updateDatabaseEmbed(pid);
                updateDashboard();
            }
            else if (interaction.customId.startsWith('mod_db_edit_')) {
                const parts = interaction.customId.split('_');
                const pid = parts[3];
                const idx = parseInt(parts[4]);
                const stock = loadJSON(stockPath);
                if (stock[pid] && stock[pid][idx]) {
                    stock[pid][idx].data = interaction.fields.getTextInputValue('data').trim();
                    saveJSON(stockPath, stock);
                    await interaction.reply({ content: 'Updated.', flags: [MessageFlags.Ephemeral] });
                    updateDatabaseEmbed(pid);
                }
            }
            else if (interaction.customId.startsWith('mod_buy_')) {
                const pid = interaction.customId.replace('mod_buy_', '');
                const qty = parseInt(interaction.fields.getTextInputValue('q'));
                if (isNaN(qty) || qty <= 0) return interaction.reply({ content: 'Invalid qty.', flags: [MessageFlags.Ephemeral] });
                const p = loadJSON(productsPath).find(x => x.id === pid);
                if (p.stock < qty) return interaction.reply({ content: 'No stock.', flags: [MessageFlags.Ephemeral] });

                const orderId = `INV${Date.now()}`;
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const res = await axios.post(`https://app.pakasir.com/api/transactioncreate/qris`, {
                    project: process.env.PAKASIR_SLUG, order_id: orderId, amount: parseInt(p.price.replace(/\D/g, '')) * qty, api_key: process.env.PAKASIR_API_KEY
                }).catch(() => null);

                if (res?.data?.payment) {
                    const pending = loadJSON(pendingPaymentsPath);
                    pending[orderId] = { userId: interaction.user.id, productId: pid, qty, amount: res.data.payment.total_payment, createdAt: Date.now() };
                    saveJSON(pendingPaymentsPath, pending);
                    const embed = new EmbedBuilder().setTitle('💳 PAYMENT').setDescription(`Scan QRIS for **${qty}x ${p.name}**.\nTotal: \`Rp. ${res.data.payment.total_payment}\``)
                        .setImage(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(res.data.payment.payment_number)}`);
                    await interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`btn_check_pay_${orderId}`).setLabel('Check Payment').setStyle(ButtonStyle.Success))] });
                } else await interaction.editReply({ content: 'Payment error.' });
            }
            return;
        }
    } catch (e) {
        console.error('Interaction Error:', e);
        if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Error.', flags: [MessageFlags.Ephemeral] }).catch(() => { });
    }
});

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setActivity('QUANTUMBLOX STORE ON', { type: ActivityType.Custom });
    await registerCommands();
    updateDashboard();
    setInterval(updateDashboard, 15000);
});

client.login(process.env.DISCORD_TOKEN);
