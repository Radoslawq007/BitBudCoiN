// Jedna lista stron - jedyne miejsce, które trzeba zmienić, żeby dodać/
// usunąć/przemianować pozycję w menu na WSZYSTKICH stronach naraz.
const NAV_PAGES = [
    { href: "index.html",     label: "Start",     i18n: "nav_start" },
    { href: "dashboard.html", label: "Dashboard", i18n: "nav_dashboard" },
    { href: "explorer.html",  label: "Explorer",  i18n: "nav_explorer" },
    { href: "miner.html",     label: "Kopanie",   i18n: "nav_mining" },
    { href: "network.html",   label: "Sieć",      i18n: "nav_network" },
    { href: "peers.html",     label: "Peery",     i18n: "nav_peers" },
    { href: "exchange.html",  label: "Giełda",    i18n: "nav_exchange" },
    { href: "address.html",   label: "Adres",     i18n: "nav_address" },
    { href: "wallet.html",    label: "Portfel",   i18n: "nav_wallet" },
    { href: "docks.html",     label: "Docs",      i18n: "nav_docs" }
];

function currentPageFile() {
    const path = location.pathname.split("/").pop();
    return path === "" ? "index.html" : path;
}

// Wstrzykuje pasek nav jako pierwsze dziecko <body>. Wywoływane od razu,
// synchronicznie, zanim przeglądarka dojdzie do native-responsive.js -
// dzięki temu mountResponsiveNav() zawsze znajdzie już gotowe .nav/.nav-links,
// niezależnie od tego, na której stronie jesteśmy.
function injectNav() {
    if (document.querySelector(".nav")) return; // nav już istnieje - nie duplikuj

    const current = currentPageFile();
    const linksHtml = NAV_PAGES.map((p) => {
        const cls = p.href === current ? ' class="active"' : "";
        return `<a href="${p.href}"${cls} data-i18n="${p.i18n}">${p.label}</a>`;
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

// Zostaje dla zgodności wstecznej / ręcznego użycia gdzie indziej -
// injectNav() już ustawia "active" sam, ale nic się nie stanie jeśli
// jakaś strona nadal woła setActiveNav() ręcznie.
function setActiveNav(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add("active");
}

async function mountNavStatus() {
    const combined = document.getElementById("navStatus");
    const splitPill = document.getElementById("nav-status");
    const splitText = document.getElementById("nav-status-text");
    const pill = combined || splitPill;
    if (!pill) return;

    const setText = (html) => {
        if (combined) pill.innerHTML = `<span class="flame-dot"></span>${html}`;
        else if (splitText) splitText.textContent = html;
    };

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(API_BASE + "/info", { signal: controller.signal });
        clearTimeout(timeoutId);
        const info = await res.json();
        if (!res.ok) throw new Error("status " + res.status);
        pill.classList.add("lit");
        setText(`blok #${fmtNumber(info.height, 0)}`);
    } catch (e) {
        pill.classList.remove("lit");
        setText("offline");
    }
}
if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", mountNavStatus); } else { mountNavStatus(); }