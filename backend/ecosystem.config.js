// Konfiguracja PM2 - żeby server.js działał 24/7 i sam się podnosił po awarii
// albo restarcie maszyny.
//
// Instalacja i użycie:
//   npm install -g pm2
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2 startup        <- wykona się komenda, którą PM2 wypisze na ekranie,
//                          uruchom ją raz (żeby wstawało po restarcie serwera)
//
// Przydatne dalej:
//   pm2 status          - czy żyje
//   pm2 logs bitbudcoin  - logi na żywo
//   pm2 restart bitbudcoin
//   pm2 monit            - podgląd CPU/RAM

module.exports = {
    apps: [
        {
            name: "bitbudcoin",
            script: "server.js",
            cwd: __dirname,
            instances: 1,
            autorestart: true,
            restart_delay: 3000,
            max_restarts: 20,
            watch: false,
            max_memory_restart: "500M",
            env: {
                NODE_ENV: "production",
                PORT: 5000,
                HOST: "127.0.0.1"
            }
        }
    ]
};
