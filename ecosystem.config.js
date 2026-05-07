// ══════════════════════════════════════════════
//   QB-STORE — PM2 ECOSYSTEM CONFIG
//   File: /root/qb-bot/ecosystem.config.js
// ══════════════════════════════════════════════

module.exports = {
    apps: [
        {
            // ─── Identitas ───────────────────────────
            name: 'qb-bot',
            script: 'index.js',
            cwd: '/root/qb-bot',

            // ─── Instance ────────────────────────────
            instances: 1,           // Discord bot harus single instance
            exec_mode: 'fork',      // Fork mode untuk single instance

            // ─── Auto Restart ────────────────────────
            autorestart: true,      // Restart otomatis jika crash
            max_restarts: 10,       // Maksimal 10 restart berturut-turut
            restart_delay: 5000,    // Tunggu 5 detik sebelum restart ulang
            min_uptime: '15s',      // Harus hidup minimal 15 detik agar dianggap stable
            // (mencegah restart loop jika crash cepat)

            // ─── Memory ──────────────────────────────
            max_memory_restart: '350M',  // Restart jika RAM > 350MB

            // ─── File Watch ──────────────────────────
            watch: false,           // JANGAN watch file di production (bisa restart loop)

            // ─── Environment ─────────────────────────
            env: {
                NODE_ENV: 'production'
            },

            // ─── Logging ─────────────────────────────
            error_file: '/root/qb-bot/logs/err.log',
            out_file: '/root/qb-bot/logs/out.log',
            log_file: '/root/qb-bot/logs/combined.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            time: true,             // Tambahkan timestamp ke setiap log line
            merge_logs: true        // Gabungkan semua instance logs (untuk cluster mode)
        }
    ]
};