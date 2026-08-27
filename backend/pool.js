sudo curl -o ~/backend/pool.js https://raw.githubusercontent.com/radoslawq007/BitBudCoiN/main/backend/pool.js
node -c ~/backend/pool.js && echo OK
pm2 restart bitbudcoin