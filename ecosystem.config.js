module.exports = {
  apps: [
    {
      name: 'calldaddy',
      script: 'server.js',
      instances: 'max',
      exec_mode: 'cluster',
      watch: false,
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_file: './logs/combined.log',
      time: true,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
    },
  ],
};
