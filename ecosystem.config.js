module.exports = {
  apps: [
    {
      name: 'qb-bot',
      script: 'index.js',
      cwd: '/root/qb-bot',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      min_uptime: '15s',
      max_memory_restart: '350M',
      watch: false,
      env: {
        NODE_ENV: 'production'
      },
      error_file: '/root/qb-bot/logs/err.log',
      out_file: '/root/qb-bot/logs/out.log',
      log_file: '/root/qb-bot/logs/combined.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      time: true,
      merge_logs: true
    }
  ]
};
