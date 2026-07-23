// Wspólna warstwa komunikacji z backendem BitBudCoin + funkcje formatujące.
// Podmień API_BASE, jeśli backend stoi pod innym adresem.
const API_BASE = window.BBC_API_BASE || "https://141-147-98-57.sslip.io";

async function apiGet(path) {
    const res = await fetch(API_BASE + path);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.reason || `Błąd serwera (${res.status})`);
    return data;
}

async function apiPost(path, body) {
    const res = await fetch(API_BASE + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.reason || `Błąd serwera (${res.status})`);
    return data;
}

function fmtNumber(n, maxDecimals = 4) {
    if (n === null || n === undefined || Number.isNaN(n)) return "—";
    const locale = (typeof currentLang !== "undefined" && currentLang === "en") ? "en-US" : "pl-PL";
    return Number(n).toLocaleString(locale, { maximumFractionDigits: maxDecimals });
}

function fmtHash(h, len = 10) {
    if (!h) return "—";
    return h.length <= len * 2 ? h : h.slice(0, len) + "…" + h.slice(-4);
}

function fmtAddress(a, len = 8) {
    if (!a) return "—";
    return a.length <= len * 2 ? a : a.slice(0, len) + "…" + a.slice(-4);
}

function fmtTime(ts) {
    if (!ts) return "—";
    const locale = (typeof currentLang !== "undefined" && currentLang === "en") ? "en-US" : "pl-PL";
    return new Date(ts).toLocaleString(locale);
}

function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    const tr = typeof t === "function" ? t : (k) => k;
    if (s < 5) return tr("time_now");
    if (s < 60) return `${s}${tr("time_s_ago")}`;
    if (s < 3600) return `${Math.floor(s / 60)}${tr("time_m_ago")}`;
    if (s < 86400) return `${Math.floor(s / 3600)}${tr("time_h_ago")}`;
    return `${Math.floor(s / 86400)}${tr("time_d_ago")}`;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Wstawia pole dymu do tła strony - wołane raz na starcie każdej strony
function mountSmokeField() {
    const div = document.createElement("div");
    div.className = "smoke-field";
    div.innerHTML = "<span></span><span></span><span></span>";
    document.body.prepend(div);
}
