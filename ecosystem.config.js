module.exports = {
  apps: [{
    name: "calldaddy-prod",
    script: "./server.js",
    instances: "max",
    exec_mode: "cluster",
    env: {
      NODE_ENV: "production",
      PORT: 4000
    }
  }]
}