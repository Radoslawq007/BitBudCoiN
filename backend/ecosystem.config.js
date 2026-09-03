// Konfiguracja PM2 - żeby server.js działał 24/7 i sam się podnosił po awarii
// albo restarcie maszyny.
//
// WYMAGANE od teraz: ADMIN_SECRET w środowisku PRZED startem (bridge-tags.js
// rzuca błąd przy starcie bez niego, celowo - patrz komentarz tam).
// Wygeneruj i ustaw RAZ na serwerze:
//   export ADMIN_SECRET="$(openssl rand -hex 32)"
// i dopisz DOKŁADNIE tę linię do ~/.bashrc (albo ~/.profile) - żeby
// przetrwała restart maszyny i nowe sesje SSH, bo "pm2 startup" odpala się
// przy boocie systemu, poza Twoją interaktywną sesją Termiusa.
//
// Ten plik CELOWO nie zawiera samej wartości sekretu - tylko
// "process.env.ADMIN_SECRET", czyli przepisanie tego co już jest w
// środowisku. Repo jest publiczne; realna wartość nigdy tu nie ląduje.
//
// Instalacja i użycie:
//   npm install -g pm2
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2 startup        <- wykona się komenda, którą PM2 wypisze na ekranie,
//                          uruchom ją raz (żeby wstawało po restarcie serwera)
//
// Po każdej zmianie ADMIN_SECRET w środowisku:
//   pm2 restart bitbudcoin --update-env    <- BEZ --update-env pm2 użyje
//                                              starej, zbuforowanej wartości
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
                HOST: "127.0.0.1",
                ADMIN_SECRET: process.env.ADMIN_SECRET
            }
        }
    ]
};
