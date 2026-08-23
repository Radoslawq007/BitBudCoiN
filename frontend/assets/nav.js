// i18n tylko na kluczach, które NAPRAWDĘ istniały w Twoim kodzie (z miner.html).
// Start/Giełda/Adres nie miały odpowiednika nigdzie - bez wymyślonych kluczy,
// żeby nie wywalać i18n.js na nieznanym data-i18n.
const NAV_PAGES = [
    { href: "index.html",     label: "Start" },
    { href: "dashboard.html", label: "Dashboard", i18n: "nav_dashboard" },
    { href: "explorer.html",  label: "Explorer",  i18n: "nav_explorer" },
    { href: "miner.html",     label: "Kopanie",   i18n: "nav_mining" },
    { href: "network.html",   label: "Sieć",      i18n: "nav_network" },
    { href: "peers.html",     label: "Peery",     i18n: "nav_peers" },
    { href: "exchange.html",  label: "Giełda" },
    { href: "create-offer.html", label: "Kup BbC",   i18n: "nav_swap" },
    { href: "address.html",   label: "Adres" },
    { href: "wallet.html",    label: "Portfel",   i18n: "nav_wallet" },
    { href: "family.html",    label: "Rodzina BbC", i18n: "nav_family" },
    { href: "docks.html",     label: "Docs",      i18n: "nav_docs" }
];

function currentPageFile() {
    const path = location.pathname.split("/").pop();
    return path === "" ? "index.html" : path;
}

function injectNav() {
    if (document.querySelector(".nav")) return;

    const current = currentPageFile();
    const linksHtml = NAV_PAGES.map((p) => {
        const id = ' id="nav-' + p.href.replace(".html", "") + '"';
        const cls = p.href === current ? ' class="active"' : "";
        const i18n = p.i18n ? ` data-i18n="${p.i18n}"` : "";
        return `<a href="${p.href}"${id}${cls}${i18n}>${p.label}</a>`;
    }).join("\n    ");

    const navHtml = `<nav class="nav">
  <a class="brand" href="index.html"><img src="assets/logo.svg" alt="" style="width:30px;height:33px;vertical-align:middle;margin-right:8px;"> BitBudCoin</a>
  <div class="nav-links">
    ${linksHtml}
  </div>
  <div class="nav-status"><span class="flame-pill" id="navStatus"><span class="flame-dot"></span>łączenie…</span></div>
</nav>`;

    document.body.insertAdjacentHTML("afterbegin", navHtml);
}

injectNav();

function setActiveNav(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add("active");
}

// NAPRAWA (dzisiaj): ta funkcja pobierała dane RAZ, przy starcie strony,
// i nigdy wiecej - stad zamrozona odznaka "blok #" na gorze KAZDEJ z 16
// stron, dokladnie ten objaw z dzisiejszych zrzutow ekranu. Teraz korzysta
// z BBCLiveState (SSE + fallback), wiec aktualizuje sie na biezaco, tak
// jak reszta kazdej strony juz to robila osobno.
function mountNavStatus() {
    const combined = document.getElementById("navStatus");
    const splitPill = document.getElementById("nav-status");
    const splitText = document.getElementById("nav-status-text");
    const pill = combined || splitPill;
    if (!pill) return;

    const setText = (html) => {
        if (combined) pill.innerHTML = `<span class="flame-dot"></span>${html}`;
        else if (splitText) splitText.textContent = html;
    };

    if (typeof BBCLiveState === "undefined") {
        // Awaryjnie, gdyby ten skrypt kiedys zaladowal sie bez api.js -
        // stare zachowanie (jedno zapytanie), zeby odznaka nie zostala pusta.
        // NAPRAWA (dzisiaj): timeout, zeby nawet ta rzadka awaryjna sciezka
        // nie wisiala bez konca, spojnie z apiGet() w api.js.
        const navFetchController = new AbortController();
        const navFetchTimeout = setTimeout(() => navFetchController.abort(), 8000);
        fetch(API_BASE + "/info", { signal: navFetchController.signal })
            .then((res) => res.json())
            .then((info) => { pill.classList.add("lit"); setText(`blok #${fmtNumber(info.height, 0)}`); })
            .catch(() => { pill.classList.remove("lit"); setText("offline"); })
            .finally(() => clearTimeout(navFetchTimeout));
        return;
    }

    BBCLiveState.subscribe(({ state, live }) => {
        if (!state || typeof state.height === "undefined") {
            pill.classList.remove("lit");
            setText("łączenie…");
            return;
        }
        pill.classList.add("lit");
        setText(`blok #${fmtNumber(state.height, 0)}${live ? "" : " ⚠️"}`);
    });
    BBCLiveState.init();
}
if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", mountNavStatus); } else { mountNavStatus(); }
