module.exports = {
    apps: [{
        name: 'calldaddy-prod',
        script: 'server.js',
        instances: 'max',
        exec_mode: 'cluster',
        watch: false,
        max_memory_restart: '500M',
        env_production: {
            NODE_ENV: 'production',
            PORT: 4000
        },
        error_file: './logs/error.log',
        out_file: './logs/out.log',
        log_date_format: 'YYYY-MM-DD HH:mm:ss'
    }]
};
