// System wielojęzyczności BitBudCoin. Działa na KAŻDEJ stronie, która wczyta
// ten plik - sam dokłada przełącznik do menu i tłumaczy elementy oznaczone
// atrybutem data-i18n="klucz". Strony bez takich atrybutów po prostu nie mają
// jeszcze nic do przetłumaczenia (przełącznik i tak się pojawi, bezpiecznie).

const translations = {
    pl: {
        nav_dashboard: "Dashboard", nav_explorer: "Explorer", nav_mining: "Kopanie",
        nav_network: "Sieć", nav_peers: "Peery", nav_exchange: "Giełda",
        nav_address: "Adres", nav_docs: "Docs", nav_wallet: "Portfel",

        footer_text: "BitBudCoin (BbC) · sieć proof-of-work",
        footer_docs_link: "dokumentacja",
        common_blocks_suffix: "bloków",
        common_backend_error: "Nie można połączyć się z backendem",
        common_error_prefix: "błąd",
        common_known_miners: "Znani górnicy",
        common_only_you: "Na razie tylko Ty.",
        common_unavailable: "Niedostępne.",
        common_pool_unavailable: "Pula niedostępna",
        common_pool_label: "pula",
        common_solo_label: "solo",
        common_last_block: "ostatnio blok",
        time_now: "teraz",
        time_s_ago: "s temu",
        time_m_ago: "m temu",
        time_h_ago: "h temu",
        time_d_ago: "d temu",

        index_kicker: "proof-of-work · sieć BbC",
        index_sub: "bloków wykopanych od genesis",
        index_view_explorer_btn: "Zobacz explorer",
        index_stat_supply: "Podaż w obiegu",
        index_stat_reward: "Aktualna nagroda",
        index_stat_difficulty: "Trudność",
        index_about_heading: "Czym jest BitBudCoin?",
        index_about_text: "BbC to niezależna sieć blockchain z klasycznym proof-of-work (SHA-256), premine'em założycielskim, halvingiem nagrody co 210 000 bloków i twardym pułapem podaży. Kopać można solo albo w puli — u siebie liczysz hashe, a sieć weryfikuje i zapisuje wynik. Cały ruch (przelewy, blokowanie, salda) idzie przez podpisy Ed25519, więc nikt poza właścicielem klucza prywatnego nie rusza jego środków.",
        index_card_mining_desc: "Solo albo w puli, z realnym udziałem w nagrodzie proporcjonalnym do zgłoszonych shares.",
        index_card_mining_link: "Zobacz jak →",
        index_card_explorer_desc: "Każdy blok, każda transakcja, jawnie i do sprawdzenia w dowolnej chwili.",
        index_card_explorer_link: "Przeglądaj →",
        index_card_wallet_desc: "Sprawdź saldo dowolnego adresu i historię jego transakcji.",
        index_card_wallet_link: "Sprawdź adres →",

        dashboard_h1: "Dashboard sieci",
        dashboard_height: "Wysokość",
        dashboard_supply_cap: "Podaż / pułap",
        dashboard_block_reward: "Nagroda za blok",
        dashboard_next_halving: "Do następnego halvingu",
        dashboard_next_retarget: "Do przeliczenia trudności",
        dashboard_recent_blocks: "Ostatnie bloki",
        dashboard_th_when: "Kiedy",
        dashboard_th_hash: "Hash",
        dashboard_full_explorer_link: "Pełny explorer →",
        dashboard_pool_heading: "Pula kopania",
        dashboard_join_mining_link: "Dołącz do kopania →",
        dashboard_invalid_chain: "Węzeł zgłasza niepoprawny łańcuch lokalny — sprawdź logi serwera.",
        dashboard_no_blocks: "Brak bloków poza genesis",
        dashboard_share_diff: "Trudność share",
        dashboard_shares_round: "Shares w tej rundzie",
        dashboard_pool_fee: "Opłata puli",
        dashboard_addresses_heading: "Adresy w sieci",
        dashboard_total_addresses: "Łącznie znanych adresów",
        dashboard_whales_heading: "Wieloryby (najwięcej BbC)",
        dashboard_newest_heading: "Najnowsze adresy",
        dashboard_since_block: "od bloku",

        explorer_h1: "Dziennik łańcucha",
        explorer_intro: "Każdy wykopany blok to prawdziwa chwila czyjejś pracy. Kliknij wpis, żeby zobaczyć pełne transakcje.",
        explorer_load_more_btn: "Wczytaj starsze bloki",
        explorer_story_genesis: "Początek. Pierwszy blok tego łańcucha, zapisany na stałe — {amount} BbC rozdane na start.",
        explorer_unit_seconds: "s",
        explorer_unit_minutes: "min",
        explorer_story_worked: "Ktoś spędził {duration}, żeby to udowodnić",
        explorer_story_proved: "Ktoś udowodnił prawdziwą pracę",
        explorer_story_alongside: "przy okazji",
        explorer_story_tx_singular: "transakcja przeszła",
        explorer_story_tx_plural: "transakcje przeszły",
        explorer_block_label: "Blok",
        explorer_only_genesis: "Tylko genesis na razie — wykop pierwszy blok w",

        network_h1: "Parametry sieci",
        network_intro: "Zdrowie łańcucha i stałe protokołu — to, na czym zgadzają się wszystkie węzły.",
        network_chain_valid: "Łańcuch poprawny",
        network_chain_invalid: "Łańcuch NIEPOPRAWNY",
        network_row_network: "Sieć",
        network_row_version: "Wersja protokołu",
        network_row_current_difficulty: "Trudność bieżąca",
        network_row_blocks_to_retarget: "Bloków do przeliczenia trudności",
        network_row_blocks_to_halving: "Bloków do halvingu",
        network_row_supply_cap: "Pułap podaży",
        network_row_premine: "Premine",
        network_no_node_connection: "Brak połączenia z węzłem",

        peers_h1: "Peery P2P",
        peers_connect_heading: "Połącz z nowym peerem",
        peers_address_label: "Adres (host:port)",
        peers_connect_btn: "Połącz",
        peers_status_heading: "Status węzła",
        peers_connected_heading: "Połączeni",
        peers_configured_heading: "Skonfigurowani",
        peers_reconnecting_heading: "Łączą się ponownie",
        peers_none: "— brak —",
        peers_port_label: "Port P2P",
        peers_connected_count_label: "Połączeni peerzy",
        peers_need_address: "Podaj adres w formacie host:port",
        peers_connecting_to: "Łączenie z",

        exchange_h1: "Giełda jeszcze się nie pali",
        exchange_p1: "Handel BbC (order book, pary handlowe, dopasowywanie zleceń) nie jest jeszcze częścią sieci — na razie BitBudCoin to warstwa łańcucha i portfeli, bez modułu giełdowego.",
        exchange_p2: "Do tego czasu monety BbC można przesyłać bezpośrednio między adresami (podpisane transakcje Ed25519) — to już działa.",
        exchange_check_address_btn: "Sprawdź swój adres",
        exchange_docs_btn: "Dokumentacja API",

        address_h1: "Sprawdź adres",
        address_label: "Adres BbC",
        address_search_btn: "Szukaj",
        address_confirmed_balance: "Saldo potwierdzone",
        address_mempool_aware_balance: "Z uwzględnieniem mempoola",
        address_history_heading: "Historia",
        address_th_type: "Typ",
        address_th_direction: "Kierunek",
        address_th_amount: "Kwota",
        address_no_transactions: "Brak transakcji dla tego adresu",
        address_incoming: "przychodząca",
        address_outgoing: "wychodząca",

        docks_h1: "Dokumentacja",
        docks_intro: "Skrócona referencja API i parametrów sieci BitBudCoin.",
        docks_chain_heading: "Łańcuch",
        docks_wallets_heading: "Portfele i transakcje",
        docks_wallets_desc: "Transakcje podpisujesz lokalnie kluczem prywatnym (Ed25519) — wallet.js i send.js w repo backendu.",
        docks_params_heading: "Parametry protokołu (na żywo)",
        docks_how_heading: "Jak to działa w skrócie",
        docks_how_desc: "Proof-of-work SHA-256, trudność jako ciągła liczba (nie skoki x16), retarget co ~2028 bloków, halving nagrody co 210 000 bloków, twardy pułap podaży. Baza SQLite (node:sqlite), P2P po surowym TCP (linie JSON), pula ze share-based proof of work, transakcje podpisane Ed25519.",
        docks_node_heading: "Uruchomienie własnego węzła",
        docks_footer_home_link: "strona główna",
        docks_base_reward: "Nagroda bazowa",
        docks_node_offline: "węzeł offline",

        block_back_to_journal: "← Dziennik łańcucha",
        block_tx_heading: "Transakcje",
        block_th_from: "Od",
        block_th_to: "Do",
        block_no_height: "Brak wysokości bloku w adresie.",
        block_hash_label: "Hash",
        block_prev_hash_label: "Poprzedni hash",
        block_genesis_note: "— (genesis)",
        block_when_label: "Kiedy",
        block_nonce_label: "Nonce",
        block_no_transactions: "Brak transakcji w tym bloku",
        block_new_coins: "— (nowe monety)",
        block_fee_suffix: "opłaty",

        wallet_h1: "Portfel", wallet_tab_create: "Nowy portfel", wallet_tab_manage: "Mój portfel",
        wallet_phrase_heading: "12 słów zamiast klucza",
        wallet_phrase_subtitle: "Łatwiej przepisać ręcznie, łatwiej rozpoznać literówkę. Ta sama fraza zawsze odtwarza dokładnie ten sam portfel.",
        wallet_show_raw_keys: "Zaawansowane: surowe klucze zamiast frazy",
        wallet_hide_raw_keys: "Ukryj surowe klucze",
        wallet_phrase_generate_btn: "Wygeneruj nową frazę",
        wallet_phrase_confirm_saved: "Zapisałem te 12 słów w bezpiecznym miejscu.",
        wallet_phrase_use_btn: "Użyj tego portfela",
        wallet_remember_heading: "💾 Zapamiętać ten portfel na tym urządzeniu?",
        wallet_remember_desc_short: "Zaszyfrowany prawdziwym hasłem (AES-256) — następnym razem tylko hasło, bez wklejania kluczy.",
        wallet_set_password: "Ustaw hasło",
        wallet_remember_btn: "Zapamiętaj",
        wallet_unlock_heading: "🔒 Masz zapisany portfel na tym urządzeniu",
        wallet_password_label: "Hasło",
        wallet_unlock_btn: "Odblokuj",
        wallet_forget_btn: "Zapomnij ten portfel",
        wallet_login_heading: "Zaloguj się",
        wallet_login_hint: "Wklej swoje stare klucze albo wpisz 12 słów — rozpoznam samo, co to jest.",
        wallet_remember_heading2: "💾 Zapamiętać ten portfel tutaj?",
        wallet_remember_desc_long: "Zaszyfrowany prawdziwym hasłem (AES-256) — następnym razem tylko hasło, bez wklejania kluczy. Zgubione hasło = trzeba wczytać portfel od nowa wklejeniem (klucze nadal masz w swoim pliku).",
        wallet_intro: "Klucz prywatny powstaje tutaj, w tej przeglądarce, i nigdy nigdzie nie jest wysyłany.",
        wallet_warning: "Jeśli zgubisz klucz prywatny, tracisz dostęp do adresu na zawsze. Zapisz go, zanim zamkniesz tę kartę.",
        wallet_generate_btn: "Wygeneruj nowy portfel",
        wallet_step1: "Twój adres BbC", wallet_step2: "Klucz publiczny",
        wallet_step3: "Klucz PRYWATNY — nigdy nikomu nie pokazuj",
        wallet_step4: "Zapisz na dysk", wallet_download_bundle: "Pobierz oba klucze (1 plik)",
        wallet_bundle_hint: "Ten jeden plik wystarczy, żeby później wczytać ten portfel w zakładce \"Mój portfel\".",
        wallet_confirm_saved: "Zapisałem klucz prywatny w bezpiecznym miejscu.",
        wallet_import_title: "Wczytaj portfel",
        wallet_import_hint: "Wklej tutaj treść pliku, który pobrałeś przy tworzeniu portfela (oba klucze naraz — rozpoznam je same).",
        wallet_load_btn: "Wczytaj portfel",
        wallet_import_error: "Nie znalazłem obu kluczy w wklejonym tekście — upewnij się, że wkleiłeś zarówno klucz prywatny, jak i publiczny.",
        wallet_receive_title: "Odbierz", wallet_copy_addr: "Kopiuj adres", wallet_share: "Udostępnij",
        wallet_send_title: "Wyślij", wallet_send_to: "Adres odbiorcy", wallet_send_amount: "Kwota (BbC)",
        wallet_send_fee: "Opłata", wallet_send_btn: "Wyślij",
        wallet_footer: "BitBudCoin (BbC) · klucz prywatny nigdy nie opuszcza tej przeglądarki",
        wallet_generating: "Generuję...", wallet_generate_error: "Nie udało się wygenerować portfela: ",
        wallet_copied: "Skopiowano ✓", wallet_selected: "Zaznaczono - Ctrl+C",
        wallet_load_error: "Błąd wczytywania kluczy: ", wallet_balance_error: "błąd",
        wallet_share_fallback: "Adres skopiowany (udostępnianie niedostępne w tej przeglądarce)",
        wallet_need_recipient: "Podaj adres odbiorcy", wallet_need_amount: "Podaj poprawną kwotę",
        wallet_fee_negative: "Opłata nie może być ujemna", wallet_signing: "Podpisuję i wysyłam...",
        wallet_send_success: "✅ Wysłano, czeka na potwierdzenie w bloku",

        miner_h1: "Kopanie", miner_pool_status: "Status puli",
        miner_auto_title: "Kopanie automatyczne (w tej przeglądarce)",
        miner_auto_desc: "Liczy hashe tutaj, na Twoim urządzeniu, i samo zgłasza znalezione shares — bez klikania czegokolwiek co chwilę.",
        miner_your_address: "Twój adres BbC", miner_start_btn: "Zacznij kopać",
        miner_stop_btn: "Zatrzymaj kopanie",
        miner_auto_hint: "Kopie dopóki ta karta jest otwarta na ekranie — zamknięcie karty albo zgaszenie ekranu telefonu może to zatrzymać.",
        miner_solo_title: "⚡ Solo — cała nagroda dla Ciebie",
        miner_solo_desc: "Liczy w tej przeglądarce, tak jak kopanie przez pulę — ale bez dzielenia się. Znajdziesz blok, cała nagroda trafia prosto na Twój adres.",
        miner_solo_start: "Zacznij kopać solo",
        miner_models_title: "Modele sprzętu (referencyjne)",
        miner_blocks_label: "Bloki",
        miner_attempts_label: "Próby",
        miner_bench_title: "Ile realnie liczy Twoje urządzenie?",
        miner_bench_desc: "Prawdziwy pomiar wykonany teraz, na żywo — nie specyfikacja z ulotki.",
        miner_bench_btn: "Sprawdź szybkość", miner_bench_running: "Liczę przez 1,5 sekundy...",
        miner_bench_busy: "Zatrzymaj najpierw kopanie, żeby pomiar był miarodajny.",
        miner_bench_estimate: "Przy obecnej trudności sieci: średnio", miner_bench_sec: "s",
        miner_bench_min: "min", miner_bench_hr: "godz.",
        miner_footer: "BitBudCoin (BbC) · sieć proof-of-work"
    },
    en: {
        nav_dashboard: "Dashboard", nav_explorer: "Explorer", nav_mining: "Mining",
        nav_network: "Network", nav_peers: "Peers", nav_exchange: "Exchange",
        nav_address: "Address", nav_docs: "Docs", nav_wallet: "Wallet",

        footer_text: "BitBudCoin (BbC) · proof-of-work network",
        footer_docs_link: "documentation",
        common_blocks_suffix: "blocks",
        common_backend_error: "Couldn't connect to the backend",
        common_error_prefix: "error",
        common_known_miners: "Known Miners",
        common_only_you: "Just you, for now.",
        common_unavailable: "Unavailable.",
        common_pool_unavailable: "Pool unavailable",
        common_pool_label: "pool",
        common_solo_label: "solo",
        common_last_block: "last block",
        time_now: "now",
        time_s_ago: "s ago",
        time_m_ago: "m ago",
        time_h_ago: "h ago",
        time_d_ago: "d ago",

        index_kicker: "proof-of-work · BbC network",
        index_sub: "blocks mined since genesis",
        index_view_explorer_btn: "View explorer",
        index_stat_supply: "Circulating Supply",
        index_stat_reward: "Current Reward",
        index_stat_difficulty: "Difficulty",
        index_about_heading: "What is BitBudCoin?",
        index_about_text: "BbC is an independent blockchain network with classic proof-of-work (SHA-256), a founder's premine, a block reward halving every 210,000 blocks, and a hard supply cap. You can mine solo or through the pool — you count hashes locally, and the network verifies and records the result. All activity (transfers, locking, balances) goes through Ed25519 signatures, so no one but the private key owner can touch their funds.",
        index_card_mining_desc: "Solo or through the pool, with a real share of the reward proportional to submitted shares.",
        index_card_mining_link: "See how →",
        index_card_explorer_desc: "Every block, every transaction, transparent and checkable at any time.",
        index_card_explorer_link: "Browse →",
        index_card_wallet_desc: "Check the balance of any address and its transaction history.",
        index_card_wallet_link: "Check address →",

        dashboard_h1: "Network Dashboard",
        dashboard_height: "Height",
        dashboard_supply_cap: "Supply / cap",
        dashboard_block_reward: "Block Reward",
        dashboard_next_halving: "Until Next Halving",
        dashboard_next_retarget: "Until Difficulty Retarget",
        dashboard_recent_blocks: "Recent Blocks",
        dashboard_th_when: "When",
        dashboard_th_hash: "Hash",
        dashboard_full_explorer_link: "Full explorer →",
        dashboard_pool_heading: "Mining Pool",
        dashboard_join_mining_link: "Join mining →",
        dashboard_invalid_chain: "The node is reporting an invalid local chain — check the server logs.",
        dashboard_no_blocks: "No blocks besides genesis",
        dashboard_share_diff: "Share difficulty",
        dashboard_shares_round: "Shares this round",
        dashboard_pool_fee: "Pool fee",
        dashboard_addresses_heading: "Addresses on the Network",
        dashboard_total_addresses: "Total known addresses",
        dashboard_whales_heading: "Whales (most BbC)",
        dashboard_newest_heading: "Newest Addresses",
        dashboard_since_block: "since block",

        explorer_h1: "Chain Journal",
        explorer_intro: "Every mined block is a real moment of someone's work. Click an entry to see the full transactions.",
        explorer_load_more_btn: "Load older blocks",
        explorer_story_genesis: "The beginning. The first block of this chain, recorded forever — {amount} BbC given out at the start.",
        explorer_unit_seconds: "s",
        explorer_unit_minutes: "min",
        explorer_story_worked: "Someone spent {duration} proving it",
        explorer_story_proved: "Someone proved real work",
        explorer_story_alongside: "along the way",
        explorer_story_tx_singular: "transaction made it",
        explorer_story_tx_plural: "transactions made it",
        explorer_block_label: "Block",
        explorer_only_genesis: "Just genesis for now — mine the first block in",

        network_h1: "Network Parameters",
        network_intro: "Chain health and protocol constants — what every node agrees on.",
        network_chain_valid: "Chain valid",
        network_chain_invalid: "Chain INVALID",
        network_row_network: "Network",
        network_row_version: "Protocol version",
        network_row_current_difficulty: "Current difficulty",
        network_row_blocks_to_retarget: "Blocks until retarget",
        network_row_blocks_to_halving: "Blocks until halving",
        network_row_supply_cap: "Supply cap",
        network_row_premine: "Premine",
        network_no_node_connection: "No connection to the node",

        peers_h1: "P2P Peers",
        peers_connect_heading: "Connect to a New Peer",
        peers_address_label: "Address (host:port)",
        peers_connect_btn: "Connect",
        peers_status_heading: "Node Status",
        peers_connected_heading: "Connected",
        peers_configured_heading: "Configured",
        peers_reconnecting_heading: "Reconnecting",
        peers_none: "— none —",
        peers_port_label: "P2P port",
        peers_connected_count_label: "Connected peers",
        peers_need_address: "Enter an address in host:port format",
        peers_connecting_to: "Connecting to",

        exchange_h1: "The exchange hasn't lit up yet",
        exchange_p1: "Trading BbC (order book, trading pairs, order matching) isn't part of the network yet — for now BitBudCoin is just the chain and wallet layer, without an exchange module.",
        exchange_p2: "Until then, BbC coins can be sent directly between addresses (signed Ed25519 transactions) — that already works.",
        exchange_check_address_btn: "Check your address",
        exchange_docs_btn: "API Documentation",

        address_h1: "Check an Address",
        address_label: "BbC Address",
        address_search_btn: "Search",
        address_confirmed_balance: "Confirmed Balance",
        address_mempool_aware_balance: "Including Mempool",
        address_history_heading: "History",
        address_th_type: "Type",
        address_th_direction: "Direction",
        address_th_amount: "Amount",
        address_no_transactions: "No transactions for this address",
        address_incoming: "incoming",
        address_outgoing: "outgoing",

        docks_h1: "Documentation",
        docks_intro: "A quick reference for the BitBudCoin API and network parameters.",
        docks_chain_heading: "Chain",
        docks_wallets_heading: "Wallets & Transactions",
        docks_wallets_desc: "You sign transactions locally with your private key (Ed25519) — wallet.js and send.js in the backend repo.",
        docks_params_heading: "Protocol Parameters (live)",
        docks_how_heading: "How It Works, in Short",
        docks_how_desc: "SHA-256 proof-of-work, difficulty as a continuous number (not x16 jumps), retarget every ~2028 blocks, reward halving every 210,000 blocks, hard supply cap. SQLite database (node:sqlite), P2P over raw TCP (JSON lines), share-based proof-of-work pool, Ed25519-signed transactions.",
        docks_node_heading: "Running Your Own Node",
        docks_footer_home_link: "home page",
        docks_base_reward: "Base reward",
        docks_node_offline: "node offline",

        block_back_to_journal: "← Chain Journal",
        block_tx_heading: "Transactions",
        block_th_from: "From",
        block_th_to: "To",
        block_no_height: "No block height in the address.",
        block_hash_label: "Hash",
        block_prev_hash_label: "Previous hash",
        block_genesis_note: "— (genesis)",
        block_when_label: "When",
        block_nonce_label: "Nonce",
        block_no_transactions: "No transactions in this block",
        block_new_coins: "— (new coins)",
        block_fee_suffix: "fee",

        wallet_h1: "Wallet", wallet_tab_create: "New Wallet", wallet_tab_manage: "My Wallet",
        wallet_phrase_heading: "12 words instead of a key",
        wallet_phrase_subtitle: "Easier to copy by hand, easier to spot a typo. The same phrase always recreates exactly the same wallet.",
        wallet_show_raw_keys: "Advanced: raw keys instead of a phrase",
        wallet_hide_raw_keys: "Hide raw keys",
        wallet_phrase_generate_btn: "Generate new phrase",
        wallet_phrase_confirm_saved: "I've saved these 12 words somewhere safe.",
        wallet_phrase_use_btn: "Use this wallet",
        wallet_remember_heading: "💾 Remember this wallet on this device?",
        wallet_remember_desc_short: "Encrypted with a real password (AES-256) — next time just the password, no pasting keys.",
        wallet_set_password: "Set a password",
        wallet_remember_btn: "Remember",
        wallet_unlock_heading: "🔒 You have a saved wallet on this device",
        wallet_password_label: "Password",
        wallet_unlock_btn: "Unlock",
        wallet_forget_btn: "Forget this wallet",
        wallet_login_heading: "Log in",
        wallet_login_hint: "Paste your old keys or type the 12 words — I'll recognize which one it is.",
        wallet_remember_heading2: "💾 Remember this wallet here?",
        wallet_remember_desc_long: "Encrypted with a real password (AES-256) — next time just the password, no pasting keys. Lost password = you'll need to reload the wallet by pasting again (you still have the keys in your file).",
        wallet_intro: "Your private key is created right here, in this browser, and is never sent anywhere.",
        wallet_warning: "If you lose your private key, you lose access to this address forever. Save it before closing this tab.",
        wallet_generate_btn: "Generate New Wallet",
        wallet_step1: "Your BbC Address", wallet_step2: "Public Key",
        wallet_step3: "PRIVATE Key — never show this to anyone",
        wallet_step4: "Save to Disk", wallet_download_bundle: "Download Both Keys (1 file)",
        wallet_bundle_hint: "This one file is all you need to load this wallet later under \"My Wallet\".",
        wallet_confirm_saved: "I've saved my private key somewhere safe.",
        wallet_import_title: "Load Wallet",
        wallet_import_hint: "Paste the contents of the file you downloaded when creating your wallet (both keys at once — they'll be detected automatically).",
        wallet_load_btn: "Load Wallet",
        wallet_import_error: "Couldn't find both keys in the pasted text — make sure you pasted both the private and public key.",
        wallet_receive_title: "Receive", wallet_copy_addr: "Copy Address", wallet_share: "Share",
        wallet_send_title: "Send", wallet_send_to: "Recipient Address", wallet_send_amount: "Amount (BbC)",
        wallet_send_fee: "Fee", wallet_send_btn: "Send",
        wallet_footer: "BitBudCoin (BbC) · your private key never leaves this browser",
        wallet_generating: "Generating...", wallet_generate_error: "Failed to generate wallet: ",
        wallet_copied: "Copied ✓", wallet_selected: "Selected - Ctrl+C",
        wallet_load_error: "Error loading keys: ", wallet_balance_error: "error",
        wallet_share_fallback: "Address copied (sharing not available in this browser)",
        wallet_need_recipient: "Enter recipient address", wallet_need_amount: "Enter a valid amount",
        wallet_fee_negative: "Fee cannot be negative", wallet_signing: "Signing and sending...",
        wallet_send_success: "✅ Sent, waiting for block confirmation",

        miner_h1: "Mining", miner_pool_status: "Pool Status",
        miner_auto_title: "Automatic Mining (in this browser)",
        miner_auto_desc: "Computes hashes right here on your device and automatically reports shares found — no need to keep clicking anything.",
        miner_your_address: "Your BbC Address", miner_start_btn: "Start Mining",
        miner_stop_btn: "Stop Mining",
        miner_auto_hint: "Mines as long as this tab stays open — closing the tab or locking your phone screen may stop it.",
        miner_solo_title: "⚡ Solo — Keep the Whole Reward",
        miner_solo_desc: "Computes right here in this browser, just like pool mining — but without sharing. Find a block, and the full reward goes straight to your address.",
        miner_solo_start: "Start Solo Mining",
        miner_models_title: "Hardware Models (reference)",
        miner_blocks_label: "Blocks",
        miner_attempts_label: "Attempts",
        miner_bench_title: "How fast is your device, really?",
        miner_bench_desc: "A real measurement taken right now, live — not a spec sheet.",
        miner_bench_btn: "Check speed", miner_bench_running: "Measuring for 1.5 seconds...",
        miner_bench_busy: "Stop mining first for an accurate reading.",
        miner_bench_estimate: "At the current network difficulty: on average", miner_bench_sec: "s",
        miner_bench_min: "min", miner_bench_hr: "hr",
        miner_footer: "BitBudCoin (BbC) · proof-of-work network"
    }
};

function detectLanguage() {
    const saved = localStorage.getItem("bbc_lang");
    if (saved && translations[saved]) return saved;
    const browserLang = (navigator.language || "pl").toLowerCase();
    return browserLang.startsWith("pl") ? "pl" : "en";
}

let currentLang = "pl";

function t(key) {
    return (translations[currentLang] && translations[currentLang][key]) || (translations.en[key]) || key;
}

function applyTranslations(lang) {
    currentLang = translations[lang] ? lang : "en";
    const dict = translations[currentLang];
    document.querySelectorAll("[data-i18n]").forEach((el) => {
        const key = el.getAttribute("data-i18n");
        if (dict[key]) el.textContent = dict[key];
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
        const key = el.getAttribute("data-i18n-placeholder");
        if (dict[key]) el.placeholder = dict[key];
    });
    document.documentElement.lang = lang;
    document.querySelectorAll(".lang-switch-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.lang === lang);
    });
    // Pozwala stronom, które budują treść dynamicznie przez t() (listy
    // górników, statusy, dziennik bloków), przerenderować się od razu przy
    // zmianie języka - bez tego zostawałyby zamrożone w starym języku aż do
    // następnego naturalnego odświeżenia.
    document.dispatchEvent(new CustomEvent("bbc:langchange"));
}

function setLanguage(lang) {
    localStorage.setItem("bbc_lang", lang);
    applyTranslations(lang);
}

function mountLangSwitcher() {
    const nav = document.querySelector(".nav");
    if (!nav || document.querySelector(".lang-switcher")) return;
    const wrap = document.createElement("div");
    wrap.className = "lang-switcher";
    wrap.style.cssText = "display:flex;gap:2px;margin-left:12px;";
    wrap.innerHTML = `
        <button class="lang-switch-btn" data-lang="pl" style="padding:5px 9px;font-size:.72rem;font-family:var(--font-mono);border:1px solid var(--border);background:var(--surface-2);color:var(--text-dim);border-radius:6px 0 0 6px;cursor:pointer;">PL</button>
        <button class="lang-switch-btn" data-lang="en" style="padding:5px 9px;font-size:.72rem;font-family:var(--font-mono);border:1px solid var(--border);border-left:none;background:var(--surface-2);color:var(--text-dim);border-radius:0 6px 6px 0;cursor:pointer;">EN</button>
    `;
    wrap.querySelectorAll(".lang-switch-btn").forEach((btn) => {
        btn.addEventListener("click", () => setLanguage(btn.dataset.lang));
    });
    nav.appendChild(wrap);

    const style = document.createElement("style");
    style.textContent = ".lang-switch-btn.active { background:var(--leaf) !important; color:#0b0f0d !important; }";
    document.head.appendChild(style);
}

function initI18n() {
    mountLangSwitcher();
    applyTranslations(detectLanguage());
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initI18n);
} else {
    initI18n();
}
