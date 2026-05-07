const dotenv = require('dotenv');
dotenv.config({ debug: false });
const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActivityType, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const supabase = require('./supabaseClient');
const os = require('os');

const LOG_PREFIXES = {
  SYSTEM: '[SYSTEM]',
  VPS: '[VPS]',
  PAYMENT: '[PAYMENT]',
  STORAGE: '[STORAGE]',
  ERROR: '[ERROR]',
  UPDATE: '[UPDATE]',
  CACHE: '[CACHE]',
  PRODUCT: '[PRODUCT]'
};

function log(prefix, message, ...args) {
  const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${timestamp}] ${prefix} ${message}`, ...args);
}

function formatPrice(input) {
  if (!input || input === '0') return 'Rp. 0';
  const digits = input.toString().replace(/\D/g, '');
  if (digits === '') return input;
  const price = parseInt(digits);
  return `Rp. ${new Intl.NumberFormat('id-ID').format(price)}`;
}

process.on('unhandledRejection', err => log(LOG_PREFIXES.ERROR, 'Unhandled Promise Rejection:', err));
process.on('uncaughtException', err => log(LOG_PREFIXES.ERROR, 'Uncaught Exception:', err));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const configPath = path.join(__dirname, 'config.json');
const dbEmbedMessageCache = new Map();
let dashboardMessageId = null;
const botStartTime = Date.now();
let reconnectAttempts = 0;

function loadConfig() {
  try {
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, JSON.stringify({}, null, 2), 'utf8');
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    log(LOG_PREFIXES.ERROR, 'Error loading config:', err);
    return {};
  }
}

function saveConfig(data) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    log(LOG_PREFIXES.ERROR, 'Error saving config:', err);
    return false;
  }
}

async function sendVPSLog(embed) {
  const vpsLogChanId = process.env.VPS_LOG_CHANNEL_ID;
  if (!vpsLogChanId) return;
  try {
    const vpsLogChan = await client.channels.fetch(vpsLogChanId);
    if (vpsLogChan) {
      await vpsLogChan.send({ embeds: [embed] });
    }
  } catch (e) {
    log(LOG_PREFIXES.ERROR, 'Failed to send VPS log:', e.message);
  }
}

function getSystemStats() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = Math.round((usedMem / totalMem) * 100);
  const uptimeSeconds = Math.floor((Date.now() - botStartTime) / 1000);
  const uptime = formatUptime(uptimeSeconds);
  const cpuCount = os.cpus().length;
  const loadAvg = os.loadavg()[0];
  
  return {
    memory: {
      used: Math.round(usedMem / 1024 / 1024),
      total: Math.round(totalMem / 1024 / 1024),
      percent: memPercent
    },
    cpu: {
      count: cpuCount,
      loadAvg: loadAvg.toFixed(2)
    },
    uptime
  };
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${days}d ${hours}h ${minutes}m ${secs}s`;
}

async function validateStartup() {
  const errors = [];
  const warnings = [];
  log(LOG_PREFIXES.SYSTEM, 'Running startup validation...');

  const requiredEnvs = [
    'DISCORD_TOKEN',
    'DATABASE_CHANNEL_ID',
    'ADMIN_ROLE_ID',
    'PAKASIR_SLUG',
    'PAKASIR_API_KEY'
  ];

  requiredEnvs.forEach(env => {
    if (!process.env[env]) {
      errors.push(`Missing required environment variable: ${env}`);
    }
  });

  try {
    const { error } = await supabase.from('products').select('id').limit(1);
    if (error) {
      errors.push(`Database connection failed: ${error.message}`);
    } else {
      log(LOG_PREFIXES.SYSTEM, '✅ Database connection OK');
    }
  } catch (e) {
    errors.push(`Database connection error: ${e.message}`);
  }

  if (process.env.VPS_LOG_CHANNEL_ID) {
    try {
      await client.channels.fetch(process.env.VPS_LOG_CHANNEL_ID);
      log(LOG_PREFIXES.SYSTEM, '✅ VPS Log channel OK');
    } catch (e) {
      warnings.push(`VPS Log channel not found: ${e.message}`);
    }
  }

  if (errors.length > 0) {
    log(LOG_PREFIXES.ERROR, 'Startup validation failed with errors:');
    errors.forEach(err => log(LOG_PREFIXES.ERROR, `  - ${err}`));
  }

  if (warnings.length > 0) {
    log(LOG_PREFIXES.SYSTEM, 'Startup warnings:');
    warnings.forEach(warn => log(LOG_PREFIXES.SYSTEM, `  - ${warn}`));
  }

  return { errors, warnings };
}

async function updateDatabaseEmbed(productId) {
  const { data: product, error: prodError } = await supabase.from('products').select('*').eq('id', productId).single();
  if (prodError || !product) {
    log(LOG_PREFIXES.STORAGE, `❌ Product '${productId}' not found in database:`, prodError?.message || 'No data returned');
    return;
  }

  const config = loadConfig();
  const dbChannelId = process.env.DATABASE_CHANNEL_ID;
  if (!dbChannelId) {
    log(LOG_PREFIXES.STORAGE, `❌ DATABASE_CHANNEL_ID tidak diset di environment variables! Storage embed untuk '${productId}' tidak dapat dibuat.`);
    return;
  }

  try {
    const channel = await client.channels.fetch(dbChannelId);
    if (!channel) {
      log(LOG_PREFIXES.STORAGE, `❌ Channel DATABASE_CHANNEL_ID (${dbChannelId}) tidak ditemukan.`);
      return;
    }

    const { data: productStock, error: stockError } = await supabase.from('stock').select('*').eq('product_id', productId).order('created_at', { ascending: false });
    if (stockError) {
      log(LOG_PREFIXES.STORAGE, `❌ Gagal fetch stock untuk '${productId}':`, stockError.message);
      return;
    }

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
            ? productStock.slice(0, 15).map((s, i) => `**${i + 1}.** \`${s.content.replaceAll('|', ', ')}\` • <t:${Math.floor(new Date(s.created_at).getTime() / 1000)}:R>`).join('\n') + (productStock.length > 15 ? '\n*... and more*' : '')
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

    let existingMessageId = dbEmbedMessageCache.get(productId);
    let productMsg = null;

    if (existingMessageId) {
      try {
        productMsg = await channel.messages.fetch(existingMessageId);
      } catch (fetchErr) {
        log(LOG_PREFIXES.STORAGE, `⚠️ Cached messageId untuk '${productId}' tidak valid, melakukan scan ulang...`);
        dbEmbedMessageCache.delete(productId);
        existingMessageId = null;
      }
    }

    if (!productMsg) {
      log(LOG_PREFIXES.STORAGE, `🔍 Scanning channel untuk embed '${productId}'...`);
      let lastMessageId = null;
      let found = false;

      for (let i = 0; i < 4 && !found; i++) {
        const fetchOptions = { limit: 50 };
        if (lastMessageId) fetchOptions.before = lastMessageId;

        const messages = await channel.messages.fetch(fetchOptions);
        if (messages.size === 0) break;

        const match = messages.find(m =>
          m.author.id === client.user.id &&
          m.embeds.length > 0 &&
          m.embeds[0]?.footer?.text?.includes(productId)
        );

        if (match) {
          productMsg = match;
          dbEmbedMessageCache.set(productId, match.id);
          found = true;
          log(LOG_PREFIXES.STORAGE, `✅ Embed untuk '${productId}' ditemukan (messageId: ${match.id}), di-cache.`);
        } else {
          lastMessageId = messages.last()?.id;
        }
      }
    }

    if (productMsg) {
      await productMsg.edit({ embeds: [embed], components: [row] });
      log(LOG_PREFIXES.STORAGE, `✅ Embed untuk '${productId}' berhasil di-update.`);
    } else {
      const newMsg = await channel.send({ embeds: [embed], components: [row] });
      dbEmbedMessageCache.set(productId, newMsg.id);
      log(LOG_PREFIXES.STORAGE, `✅ Embed baru untuk '${productId}' berhasil dibuat (messageId: ${newMsg.id}).`);
    }
  } catch (e) {
    log(LOG_PREFIXES.STORAGE, `❌ Database Embed Update Error untuk '${productId}':`, e.message || e);
  }
}

async function registerCommands() {
  const commands = [];
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  } catch (e) { log(LOG_PREFIXES.ERROR, 'Command registration error:', e); }
}

async function updateDashboard() {
  const config = loadConfig();
  const { data: products, error } = await supabase.from('products').select('*').order('name');
  if (error || !config || !products) return;

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
      return;
    }
    log(LOG_PREFIXES.ERROR, 'Dashboard Update Error:', e);
  }
}

async function preloadDatabaseEmbedCache() {
  const dbChannelId = process.env.DATABASE_CHANNEL_ID;
  if (!dbChannelId) {
    log(LOG_PREFIXES.CACHE, '⚠️ DATABASE_CHANNEL_ID tidak diset, skip preload cache.');
    return;
  }

  try {
    const channel = await client.channels.fetch(dbChannelId);
    if (!channel) return;

    log(LOG_PREFIXES.CACHE, '🔄 Memuat cache embed storage dari channel...');
    let lastMessageId = null;
    let totalCached = 0;

    for (let i = 0; i < 10; i++) {
      const fetchOptions = { limit: 50 };
      if (lastMessageId) fetchOptions.before = lastMessageId;

      const messages = await channel.messages.fetch(fetchOptions);
      if (messages.size === 0) break;

      messages.forEach(m => {
        if (m.author.id === client.user.id && m.embeds.length > 0) {
          const footerText = m.embeds[0]?.footer?.text || '';
          const match = footerText.match(/QUANTUMBLOX DATABASE SYSTEM • (.+)/);
          if (match && match[1]) {
            const pid = match[1].trim();
            if (!dbEmbedMessageCache.has(pid)) {
              dbEmbedMessageCache.set(pid, m.id);
              totalCached++;
            }
          }
        }
      });

      lastMessageId = messages.last()?.id;
    }

    log(LOG_PREFIXES.CACHE, `✅ Berhasil cache ${totalCached} embed storage.`);
    
    const cacheEmbed = new EmbedBuilder()
      .setTitle('💾 Cache Loaded')
      .setColor('#00b894')
      .setDescription('Storage embed cache has been successfully loaded into memory.')
      .addFields(
        { name: 'Total Cached', value: `${totalCached} embed(s)`, inline: true }
      )
      .setFooter({ text: 'QUANTUMBLOX STORE' })
      .setTimestamp();
    await sendVPSLog(cacheEmbed);
    
  } catch (e) {
    log(LOG_PREFIXES.CACHE, '❌ Gagal preload cache:', e.message);
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
            { label: 'Config Dashboard', description: 'Change title, color, or description', value: 'opt_config', emoji: '⚙️' },
            { label: 'System Status', description: 'View VPS and system stats', value: 'opt_system_status', emoji: '📊' }
          ]);

        await interaction.reply({
          content: '🛠️ **Admin Settings Menu**\nChoose what you would like to manage below:',
          components: [new ActionRowBuilder().addComponents(menu)],
          flags: [MessageFlags.Ephemeral]
        });
        return;
      }

      if (interaction.customId === 'btn_register') {
        const { data: user } = await supabase.from('users').select('id').eq('id', interaction.user.id).single();
        if (user) return interaction.reply({ content: 'Already registered!', flags: [MessageFlags.Ephemeral] });

        await supabase.from('users').insert([{ id: interaction.user.id }]);
        await interaction.reply({ content: 'Registered!', flags: [MessageFlags.Ephemeral] });
      }
      else if (interaction.customId === 'btn_buy') {
        const { data: user } = await supabase.from('users').select('id').eq('id', interaction.user.id).single();
        if (!user) return interaction.reply({ content: 'Register first!', flags: [MessageFlags.Ephemeral] });

        const { data: products } = await supabase.from('products').select('*').order('name');
        if (!products || products.length === 0) return interaction.reply({ content: 'No products.', flags: [MessageFlags.Ephemeral] });

        const s = new StringSelectMenuBuilder().setCustomId('sel_buy').setPlaceholder('Choose a product')
          .addOptions(products.map(x => ({ label: x.name, description: `Stock: ${x.stock} | Price: ${x.price}`, value: x.id })));
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
        const { data: stock } = await supabase.from('stock').select('*').eq('product_id', pid).order('created_at', { ascending: false });
        if (!stock || stock.length === 0) return interaction.reply({ content: 'No stock to edit.', flags: [MessageFlags.Ephemeral] });
        const select = new StringSelectMenuBuilder().setCustomId(`sel_db_edit_${pid}`).setPlaceholder('Select an entry');
        stock.slice(0, 25).forEach((s, i) => select.addOptions({ label: `${i + 1}. ${s.content.slice(0, 40)}`, value: s.id }));
        await interaction.reply({ content: 'Select entry:', components: [new ActionRowBuilder().addComponents(select)], flags: [MessageFlags.Ephemeral] });
      }
      else if (interaction.customId.startsWith('btn_db_del_pick_')) {
        if (!interaction.member.roles.cache.has(process.env.ADMIN_ROLE_ID)) return interaction.reply({ content: 'Admins only.', flags: [MessageFlags.Ephemeral] });
        const pid = interaction.customId.replace('btn_db_del_pick_', '');
        const { data: stock } = await supabase.from('stock').select('*').eq('product_id', pid).order('created_at', { ascending: false });
        if (!stock || stock.length === 0) return interaction.reply({ content: 'No stock to delete.', flags: [MessageFlags.Ephemeral] });
        const select = new StringSelectMenuBuilder().setCustomId(`sel_db_del_${pid}`).setPlaceholder('Select to delete');
        stock.slice(0, 25).forEach((s, i) => select.addOptions({ label: `${i + 1}. ${s.content.slice(0, 40)}`, value: s.id }));
        await interaction.reply({ content: 'Select entry:', components: [new ActionRowBuilder().addComponents(select)], flags: [MessageFlags.Ephemeral] });
      }
      else if (interaction.customId.startsWith('btn_check_pay_')) {
        const orderId = interaction.customId.replace('btn_check_pay_', '');
        const { data: pay, error: fetchPayError } = await supabase.from('pending_payments').select('*').eq('invoice_id', orderId).single();
        if (fetchPayError || !pay) return interaction.reply({ content: 'Invalid transaction.', flags: [MessageFlags.Ephemeral] });

        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        try {
          const res = await axios.get(`https://app.pakasir.com/api/transactiondetail`, {
            params: { project: process.env.PAKASIR_SLUG, amount: pay.amount, order_id: orderId, api_key: process.env.PAKASIR_API_KEY }
          });

          if (res.data.transaction?.status === 'completed') {
            const { data: pidStock } = await supabase.from('stock').select('*').eq('product_id', pay.product_id).limit(pay.qty);
            if (!pidStock || pidStock.length < pay.qty) {
              return interaction.editReply({ content: '⚠️ Error deliver: Stock suddenly depleted.' });
            }

            const deliver = pidStock.map(s => s.content);
            const stockIds = pidStock.map(s => s.id);

            await supabase.from('stock').delete().in('id', stockIds);

            const { data: remainingStock } = await supabase.from('stock').select('id', { count: 'exact' }).eq('product_id', pay.product_id);
            await supabase.from('products').update({ stock: remainingStock.length }).eq('id', pay.product_id);

            await supabase.from('pending_payments').delete().eq('invoice_id', orderId);

            const formattedAmount = `Rp. ${new Intl.NumberFormat('id-ID').format(pay.amount)}`;

            const dmEmbed = new EmbedBuilder()
              .setTitle('✅  Order Confirmed')
              .setColor('#00b894')
              .setDescription('Your order has been processed successfully. Please keep this receipt for your records.')
              .addFields(
                { name: 'Order ID', value: `\`${orderId}\``, inline: false },
                { name: 'Product', value: pay.product_id, inline: true },
                { name: 'Quantity', value: `${pay.qty}x`, inline: true },
                { name: 'Total Paid', value: formattedAmount, inline: true },
                { name: 'Delivered Items', value: deliver.map((d, i) => `**${i + 1}.** \`${d}\``).join('\n') || '—', inline: false }
              )
              .setFooter({ text: 'QUANTUMBLOX STORE — Thank you for your purchase.' })
              .setTimestamp();
            await interaction.user.send({ embeds: [dmEmbed] }).catch(() => { });

            const replyEmbed = new EmbedBuilder()
              .setTitle('✅  Order Confirmed')
              .setColor('#00b894')
              .setDescription('Your order has been processed. Your item(s) have been delivered to your DMs.')
              .addFields(
                { name: 'Order ID', value: `\`${orderId}\``, inline: false },
                { name: 'Product', value: pay.product_id, inline: true },
                { name: 'Quantity', value: `${pay.qty}x`, inline: true },
                { name: 'Total', value: formattedAmount, inline: true }
              )
              .setFooter({ text: 'QUANTUMBLOX STORE' })
              .setTimestamp();
            await interaction.editReply({ embeds: [replyEmbed] });

            const logChanId = process.env.HISTORY_LOG_CHANNEL_ID;
            if (logChanId) {
              const chan = await client.channels.fetch(logChanId).catch(() => null);
              if (chan) chan.send({
                embeds: [new EmbedBuilder()
                  .setTitle('Order Completed')
                  .setColor('#2d3436')
                  .addFields(
                    { name: 'Order ID', value: `\`${orderId}\``, inline: false },
                    { name: 'Buyer', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Product', value: pay.product_id, inline: true },
                    { name: 'Quantity', value: `${pay.qty}x`, inline: true },
                    { name: 'Total', value: formattedAmount, inline: true },
                    { name: 'Process', value: 'Automatic', inline: true }
                  )
                  .setFooter({ text: `QUANTUMBLOX STORE • ${orderId}` })
                  .setTimestamp()
                ]
              });
            }

            const payLogChanId = process.env.PAYMENT_LOG_CHANNEL_ID;
            if (payLogChanId) {
              const payLogChan = await client.channels.fetch(payLogChanId).catch(() => null);
              if (payLogChan) payLogChan.send({
                embeds: [new EmbedBuilder()
                  .setTitle('Payment Received')
                  .setColor('#0099ff')
                  .addFields(
                    { name: 'Order ID', value: `\`${orderId}\``, inline: false },
                    { name: 'Buyer', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Product', value: pay.product_id, inline: true },
                    { name: 'Quantity', value: `${pay.qty}x`, inline: true },
                    { name: 'Total', value: formattedAmount, inline: true },
                    { name: 'Status', value: 'Completed', inline: true }
                  )
                  .setFooter({ text: `QUANTUMBLOX STORE • ${orderId}` })
                  .setTimestamp()
                ]
              });
            }
            
            log(LOG_PREFIXES.PAYMENT, `✅ Payment completed for order ${orderId}`);
            
            updateDashboard();
            updateDatabaseEmbed(pay.product_id);
          } else {
            await interaction.editReply({ content: 'Not paid yet.' });
          }
        } catch (e) {
          const errMsg = e?.response?.data ? JSON.stringify(e.response.data) : e.message;
          log(LOG_PREFIXES.ERROR, 'Payment Check Error:', errMsg, '| Amount:', pay.amount, '| OrderId:', orderId);
          await interaction.editReply({ content: `❌ Error checking payment. (${e?.response?.status || 'network error'})` });
        }
      }
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'sel_admin_menu') {
        const choice = interaction.values[0];
        
        if (choice === 'opt_system_status') {
          const stats = getSystemStats();
          const statusEmbed = new EmbedBuilder()
            .setTitle('📊 System Status')
            .setColor('#0099ff')
            .setDescription('Current system and VPS resource usage')
            .addFields(
              { name: '💾 Memory Usage', value: `${stats.memory.used}MB / ${stats.memory.total}MB (${stats.memory.percent}%)`, inline: true },
              { name: '🖥️ CPU Load', value: `Load Avg: ${stats.cpu.loadAvg} (${stats.cpu.count} cores)`, inline: true },
              { name: '⏱️ Uptime', value: stats.uptime, inline: true },
              { name: '📦 Cache Count', value: `${dbEmbedMessageCache.size} embed(s)`, inline: true },
              { name: '🔄 Reconnect Attempts', value: `${reconnectAttempts}`, inline: true }
            )
            .setFooter({ text: 'QUANTUMBLOX STORE' })
            .setTimestamp();
          return interaction.reply({ embeds: [statusEmbed], flags: [MessageFlags.Ephemeral] });
        }
        
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
          const { data: products } = await supabase.from('products').select('*').order('name');
          if (!products || products.length === 0) return interaction.reply({ content: 'No products to edit.', flags: [MessageFlags.Ephemeral] });
          const menu = new StringSelectMenuBuilder().setCustomId('sel_p_edit_pick').setPlaceholder('Select a product to edit...');
          products.forEach(p => menu.addOptions({ label: p.name, description: `ID: ${p.id} | Price: ${p.price}`, value: p.id }));
          return await interaction.reply({ content: '✏️ Select a product to edit:', components: [new ActionRowBuilder().addComponents(menu)], flags: [MessageFlags.Ephemeral] });
        }
        else if (choice === 'opt_del_p') {
          const { data: products } = await supabase.from('products').select('*').order('name');
          if (!products || products.length === 0) return interaction.reply({ content: 'No products to delete.', flags: [MessageFlags.Ephemeral] });
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
          const config = loadConfig();
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
        const { data: p } = await supabase.from('products').select('*').eq('id', pid).single();
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
        dbEmbedMessageCache.delete(pid);
        await supabase.from('products').delete().eq('id', pid);
        await interaction.update({ content: `✅ Product \`${pid}\` has been permanently deleted.`, components: [] });
        updateDashboard();
        return;
      }
      if (interaction.customId === 'sel_buy') {
        const pid = interaction.values[0];
        const { data: p } = await supabase.from('products').select('*').eq('id', pid).single();
        if (!p || p.stock <= 0) return interaction.update({ content: 'Out of stock.', components: [], flags: [MessageFlags.Ephemeral] });
        const modal = new ModalBuilder().setCustomId(`mod_buy_${pid}`).setTitle(`Buy ${p.name}`);
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('q').setLabel('Quantity').setStyle(TextInputStyle.Short).setRequired(true)));
        await interaction.showModal(modal);
      }
      else if (interaction.customId.startsWith('sel_db_edit_')) {
        const pid = interaction.customId.replace('sel_db_edit_', '');
        const sid = interaction.values[0];
        const { data: s } = await supabase.from('stock').select('*').eq('id', sid).single();
        if (!s) return interaction.reply({ content: 'Stock entry not found.', flags: [MessageFlags.Ephemeral] });

        const modal = new ModalBuilder().setCustomId(`mod_db_edit||${pid}||${sid}`).setTitle('Edit Entry');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('data').setLabel('Data').setValue(s.content).setStyle(TextInputStyle.Short).setRequired(true)));
        await interaction.showModal(modal);
      }
      else if (interaction.customId.startsWith('sel_db_del_')) {
        const pid = interaction.customId.replace('sel_db_del_', '');
        const sid = interaction.values[0];

        await supabase.from('stock').delete().eq('id', sid);

        const { data: stockCount } = await supabase.from('stock').select('id', { count: 'exact' }).eq('product_id', pid);
        await supabase.from('products').update({ stock: stockCount.length }).eq('id', pid);

        await interaction.update({ content: '✅ Deleted.', components: [] });
        updateDatabaseEmbed(pid);
        updateDashboard();
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'mod_p_add') {
        const id = interaction.fields.getTextInputValue('id').trim();
        const { data: existing } = await supabase.from('products').select('id').eq('id', id).single();
        if (existing) return interaction.reply({ content: '❌ Product with this ID already exists.', flags: [MessageFlags.Ephemeral] });

        const { error: insertError } = await supabase.from('products').insert([{
          id,
          name: interaction.fields.getTextInputValue('name'),
          stock: 0,
          price: formatPrice(interaction.fields.getTextInputValue('price')),
          format: interaction.fields.getTextInputValue('format'),
          description: interaction.fields.getTextInputValue('desc') || '-'
        }]);

        if (insertError) {
          log(LOG_PREFIXES.PRODUCT, `❌ Failed to save product '${id}' to database:`, insertError.message);
          return interaction.reply({ content: `❌ Failed to save product to database: ${insertError.message}`, flags: [MessageFlags.Ephemeral] });
        }

        log(LOG_PREFIXES.PRODUCT, `✅ Product '${id}' saved to database. Registering storage embed...`);

        await interaction.reply({ content: `✅ Product \`${id}\` added successfully! Creating storage embed...`, flags: [MessageFlags.Ephemeral] });

        await Promise.allSettled([
          updateDashboard(),
          updateDatabaseEmbed(id).catch(e => log(LOG_PREFIXES.PRODUCT, `❌ Failed to create storage embed for '${id}':`, e.message))
        ]);

        log(LOG_PREFIXES.PRODUCT, `✅ Storage embed untuk '${id}' berhasil dibuat.`);
      }
      else if (interaction.customId.startsWith('mod_p_edit_')) {
        const pid = interaction.customId.replace('mod_p_edit_', '');

        await supabase.from('products').update({
          name: interaction.fields.getTextInputValue('name'),
          price: formatPrice(interaction.fields.getTextInputValue('price')),
          format: interaction.fields.getTextInputValue('format'),
          description: interaction.fields.getTextInputValue('desc')
        }).eq('id', pid);

        await interaction.reply({ content: `✅ Product \`${pid}\` updated!`, flags: [MessageFlags.Ephemeral] });
        updateDashboard();
      }
      else if (interaction.customId === 'mod_config') {
        const config = loadConfig();
        if (!config.embed) config.embed = {};

        config.embed.title = interaction.fields.getTextInputValue('title');
        config.embed.description = interaction.fields.getTextInputValue('desc');
        config.embed.color = interaction.fields.getTextInputValue('color');
        config.embed.thumbnail = interaction.fields.getTextInputValue('thumb');

        const newIntv = parseInt(interaction.fields.getTextInputValue('intv'));
        if (!isNaN(newIntv)) config.updateInterval = Math.max(5000, newIntv);

        saveConfig(config);
        await interaction.reply({ content: '✅ Dashboard configuration updated!', flags: [MessageFlags.Ephemeral] });
        updateDashboard();
      }
      else if (interaction.customId === 'mod_manual_pay') {
        const inv = interaction.fields.getTextInputValue('inv').trim();
        const { data: pay } = await supabase.from('pending_payments').select('*').eq('invoice_id', inv).single();
        if (!pay) return interaction.reply({ content: `❌ Order ID \`${inv}\` not found.`, flags: [MessageFlags.Ephemeral] });

        const { data: prodStock } = await supabase.from('stock').select('*').eq('product_id', pay.product_id).limit(pay.qty);

        if (!prodStock || prodStock.length < pay.qty) {
          return interaction.reply({ content: '❌ Product or sufficient stock not found.', flags: [MessageFlags.Ephemeral] });
        }

        const items = prodStock.map(s => s.content);
        const stockIds = prodStock.map(s => s.id);

        await supabase.from('stock').delete().in('id', stockIds);

        const { data: remainingStock } = await supabase.from('stock').select('id', { count: 'exact' }).eq('product_id', pay.product_id);
        await supabase.from('products').update({ stock: remainingStock.length }).eq('id', pay.product_id);

        await supabase.from('pending_payments').delete().eq('invoice_id', inv);

        const manualFormattedAmount = `Rp. ${new Intl.NumberFormat('id-ID').format(pay.amount)}`;

        const buyer = await client.users.fetch(pay.user_id).catch(() => null);
        if (buyer) {
          const dmEmbed = new EmbedBuilder()
            .setTitle('✅  Order Confirmed')
            .setColor('#00b894')
            .setDescription('Your order has been processed successfully. Please keep this receipt for your records.')
            .addFields(
              { name: 'Order ID', value: `\`${inv}\``, inline: false },
              { name: 'Product', value: pay.product_id, inline: true },
              { name: 'Quantity', value: `${pay.qty}x`, inline: true },
              { name: 'Total Paid', value: manualFormattedAmount, inline: true },
              { name: 'Delivered Items', value: items.map((d, i) => `**${i + 1}.** \`${d}\``).join('\n') || '—', inline: false }
            )
            .setFooter({ text: 'QUANTUMBLOX STORE — Thank you for your purchase.' })
            .setTimestamp();
          await buyer.send({ embeds: [dmEmbed] }).catch(() => { });
        }

        const logChannel = await client.channels.fetch(process.env.HISTORY_LOG_CHANNEL_ID).catch(() => null);
        if (logChannel) {
          await logChannel.send({
            embeds: [new EmbedBuilder()
              .setTitle('Order Completed')
              .setColor('#2d3436')
              .addFields(
                { name: 'Order ID', value: `\`${inv}\``, inline: false },
                { name: 'Buyer', value: `<@${pay.user_id}>`, inline: true },
                { name: 'Product', value: pay.product_id, inline: true },
                { name: 'Quantity', value: `${pay.qty}x`, inline: true },
                { name: 'Total', value: manualFormattedAmount, inline: true },
                { name: 'Process', value: 'Manual', inline: true }
              )
              .setFooter({ text: `QUANTUMBLOX STORE • ${inv}` })
              .setTimestamp()
            ]
          });
        }

        const manualPayLogChan = process.env.PAYMENT_LOG_CHANNEL_ID
          ? await client.channels.fetch(process.env.PAYMENT_LOG_CHANNEL_ID).catch(() => null)
          : null;
        if (manualPayLogChan) {
          await manualPayLogChan.send({
            embeds: [new EmbedBuilder()
              .setTitle('Payment Received')
              .setColor('#0099ff')
              .addFields(
                { name: 'Order ID', value: `\`${inv}\``, inline: false },
                { name: 'Buyer', value: `<@${pay.user_id}>`, inline: true },
                { name: 'Product', value: pay.product_id, inline: true },
                { name: 'Quantity', value: `${pay.qty}x`, inline: true },
                { name: 'Total', value: manualFormattedAmount, inline: true },
                { name: 'Status', value: 'Completed (Manual)', inline: true }
              )
              .setFooter({ text: `QUANTUMBLOX STORE • ${inv}` })
              .setTimestamp()
            ]
          });
        }

        log(LOG_PREFIXES.PAYMENT, `✅ Manual payment completed for order ${inv}`);

        await interaction.reply({ content: `✅ Order \`${inv}\` successfully fulfilled manually!`, flags: [MessageFlags.Ephemeral] });
        updateDashboard();
        updateDatabaseEmbed(pay.product_id);
      }
      else if (interaction.customId.startsWith('mod_db_add_')) {
        const pid = interaction.customId.replace('mod_db_add_', '');
        const lines = interaction.fields.getTextInputValue('data').split('\n').filter(l => l.trim());

        const stockToInsert = lines.map(line => ({ product_id: pid, content: line.trim() }));
        await supabase.from('stock').insert(stockToInsert);

        const { data: count } = await supabase.from('stock').select('id', { count: 'exact' }).eq('product_id', pid);
        await supabase.from('products').update({ stock: count.length }).eq('id', pid);

        await interaction.reply({ content: `Added ${lines.length} items.`, flags: [MessageFlags.Ephemeral] });
        updateDatabaseEmbed(pid);
        updateDashboard();
      }
      else if (interaction.customId.startsWith('mod_db_edit||')) {
        const parts = interaction.customId.replace('mod_db_edit||', '').split('||');
        const pid = parts[0];
        const sid = parts[1];

        if (!pid || !sid) {
          log(LOG_PREFIXES.ERROR, `Gagal parse customId: '${interaction.customId}'`);
          return interaction.reply({ content: '❌ Internal error: invalid edit reference.', flags: [MessageFlags.Ephemeral] });
        }

        await supabase.from('stock').update({ content: interaction.fields.getTextInputValue('data').trim() }).eq('id', sid);

        await interaction.reply({ content: '✅ Updated.', flags: [MessageFlags.Ephemeral] });
        updateDatabaseEmbed(pid);
      }
      else if (interaction.customId.startsWith('mod_buy_')) {
        const pid = interaction.customId.replace('mod_buy_', '');
        const qty = parseInt(interaction.fields.getTextInputValue('q'));
        if (isNaN(qty) || qty <= 0) return interaction.reply({ content: 'Invalid qty.', flags: [MessageFlags.Ephemeral] });

        const { data: p } = await supabase.from('products').select('*').eq('id', pid).single();
        if (p.stock < qty) return interaction.reply({ content: 'No stock.', flags: [MessageFlags.Ephemeral] });

        const orderId = `INV${Date.now()}`;
        const originalAmount = parseInt(p.price.replace(/\D/g, '')) * qty;
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const res = await axios.post(`https://app.pakasir.com/api/transactioncreate/qris`, {
          project: process.env.PAKASIR_SLUG, order_id: orderId, amount: originalAmount, api_key: process.env.PAKASIR_API_KEY
        }).catch(() => null);

        if (res?.data?.payment) {
          await supabase.from('pending_payments').insert([{
            invoice_id: orderId,
            user_id: interaction.user.id,
            product_id: pid,
            qty,
            amount: originalAmount,
            created_at: new Date().toISOString()
          }]);

          const embed = new EmbedBuilder()
            .setTitle('💳  Payment Invoice')
            .setColor('#0099ff')
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
            .setFooter({ text: 'QUANTUMBLOX STORE' })
            .setTimestamp();
          await interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`btn_check_pay_${orderId}`).setLabel('Check Payment').setStyle(ButtonStyle.Success))] });
        } else await interaction.editReply({ content: 'Payment error.' });
      }
      return;
    }
  } catch (e) {
    log(LOG_PREFIXES.ERROR, 'Interaction Error:', e);
    if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Error.', flags: [MessageFlags.Ephemeral] }).catch(() => { });
  }
});

client.on('error', async (error) => {
  log(LOG_PREFIXES.ERROR, 'Client error:', error);
  reconnectAttempts++;
  
  const errorEmbed = new EmbedBuilder()
    .setTitle('⚠️ Client Error')
    .setColor('#e74c3c')
    .setDescription('The bot encountered an error.')
    .addFields(
      { name: 'Error', value: `\`${error.message}\``, inline: false },
      { name: 'Reconnect Attempts', value: `${reconnectAttempts}`, inline: true }
    )
    .setFooter({ text: 'QUANTUMBLOX STORE' })
    .setTimestamp();
  await sendVPSLog(errorEmbed);
});

client.on('warn', async (warning) => {
  log(LOG_PREFIXES.SYSTEM, 'Warning:', warning);
});

client.on('disconnect', async () => {
  log(LOG_PREFIXES.VPS, 'Bot disconnected from Discord');
  const disconnectEmbed = new EmbedBuilder()
    .setTitle('🔌 Bot Disconnected')
    .setColor('#e74c3c')
    .setDescription('The bot has disconnected from Discord. Attempting to reconnect...')
    .setFooter({ text: 'QUANTUMBLOX STORE' })
    .setTimestamp();
  await sendVPSLog(disconnectEmbed);
});

client.on('reconnecting', async () => {
  log(LOG_PREFIXES.VPS, 'Attempting to reconnect...');
  reconnectAttempts++;
});

client.on('resume', async (replayed) => {
  log(LOG_PREFIXES.VPS, `Reconnected! Replayed ${replayed} events.`);
  const resumeEmbed = new EmbedBuilder()
    .setTitle('✅ Reconnected')
    .setColor('#00b894')
    .setDescription('The bot has successfully reconnected to Discord.')
    .addFields(
      { name: 'Replayed Events', value: `${replayed}`, inline: true },
      { name: 'Reconnect Attempts', value: `${reconnectAttempts}`, inline: true }
    )
    .setFooter({ text: 'QUANTUMBLOX STORE' })
    .setTimestamp();
  await sendVPSLog(resumeEmbed);
});

client.once('ready', async () => {
  log(LOG_PREFIXES.SYSTEM, `Logged in as ${client.user.tag}`);
  client.user.setActivity('QUANTUMBLOX STORE ON', { type: ActivityType.Custom });
  
  await registerCommands();

  const validation = await validateStartup();

  const onlineEmbed = new EmbedBuilder()
    .setTitle('🚀 Bot Online')
    .setColor(validation.errors.length > 0 ? '#e74c3c' : '#00b894')
    .setDescription('The bot has successfully connected to Discord and is ready to process requests.')
    .addFields(
      { name: 'Tag', value: client.user.tag, inline: true },
      { name: 'Status', value: validation.errors.length > 0 ? 'Online with Errors' : 'Online', inline: true },
      { name: 'VPS Status', value: 'Running', inline: true }
    )
    .setFooter({ text: 'QUANTUMBLOX STORE' })
    .setTimestamp();

  if (validation.errors.length > 0) {
    onlineEmbed.addFields({
      name: '⚠️ Errors',
      value: validation.errors.map(e => `- ${e}`).join('\n'),
      inline: false
    });
  }

  if (validation.warnings.length > 0) {
    onlineEmbed.addFields({
      name: '⚠️ Warnings',
      value: validation.warnings.map(w => `- ${w}`).join('\n'),
      inline: false
    });
  }

  await sendVPSLog(onlineEmbed);

  await preloadDatabaseEmbedCache();

  updateDashboard();
  setInterval(updateDashboard, 15000);

  log(LOG_PREFIXES.SYSTEM, 'Bot initialization complete!');
});

client.login(process.env.DISCORD_TOKEN);
