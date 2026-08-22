"use strict";

// =====================================================
// BitBudCoin — wspólna warstwa API
// vMax LIVE
// =====================================================
//
// Frontend:
//   GitHub Pages
//
// Backend:
//   BitBudCoin API
//
// WAŻNE:
// API_BASE jest jednym źródłem adresu backendu.
// SSE korzysta z tego samego backendu.
//
// Można nadpisać przed załadowaniem tego pliku:
//
//   window.BBC_API_BASE = "https://twoj-backend.example.com";
//
// =====================================================


/*
 * =====================================================
 * API BASE
 * =====================================================
 */

const BBC_DEFAULT_API_BASE =
    "https://141-147-98-57.sslip.io";


function normalizeApiBase(url) {

    if (!url || typeof url !== "string") {
        return BBC_DEFAULT_API_BASE;
    }

    return url
        .trim()
        .replace(/\/+$/, "");
}


const API_BASE = normalizeApiBase(
    window.BBC_API_BASE ||
    BBC_DEFAULT_API_BASE
);


/*
 * Udostępniamy adres globalnie.
 *
 * index.html / explorer.html / miner.html itd.
 * mogą korzystać z tego samego backendu.
 */

window.BBC_API_BASE = API_BASE;


/*
 * =====================================================
 * SSE BASE
 * =====================================================
 *
 * NIE używamy:
 *
 *     new EventSource("/events")
 *
 * ponieważ wtedy przeglądarka próbuje połączyć się
 * z GitHub Pages.
 *
 * Prawidłowo:
 *
 *     https://141-147-98-57.sslip.io/events
 *
 */

const BBC_EVENTS_URL =
    `${API_BASE}/events`;


window.BBC_EVENTS_URL = BBC_EVENTS_URL;


/*
 * =====================================================
 * FETCH OPTIONS
 * =====================================================
 */

const API_FETCH_OPTIONS = {
    credentials: "omit",
    cache: "no-store"
};


/*
 * =====================================================
 * API GET
 * =====================================================
 */

async function apiGet(path) {

    const url =
        API_BASE +
        String(path || "");


    const res =
        await fetch(
            url,
            {
                ...API_FETCH_OPTIONS,
                method: "GET"
            }
        );


    const data =
        await res
            .json()
            .catch(() => ({}));


    if (!res.ok) {

        throw new Error(
            data.error ||
            data.reason ||
            `Błąd serwera (${res.status})`
        );
    }


    return data;
}


/*
 * =====================================================
 * API POST
 * =====================================================
 */

async function apiPost(path, body) {

    const url =
        API_BASE +
        String(path || "");


    const res =
        await fetch(
            url,
            {
                ...API_FETCH_OPTIONS,

                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body:
                    JSON.stringify(body)
            }
        );


    const data =
        await res
            .json()
            .catch(() => ({}));


    if (!res.ok) {

        throw new Error(
            data.error ||
            data.reason ||
            `Błąd serwera (${res.status})`
        );
    }


    return data;
}


/*
 * =====================================================
 * SSE
 * =====================================================
 *
 * Pomocnicza funkcja do tworzenia połączenia LIVE.
 *
 * Użycie:
 *
 * const events = createBBCEventSource();
 *
 * events.addEventListener("state", ...);
 *
 */

function createBBCEventSource() {

    if (!window.EventSource) {

        throw new Error(
            "Ta przeglądarka nie obsługuje SSE."
        );
    }


    return new EventSource(
        BBC_EVENTS_URL
    );
}


/*
 * Udostępniamy również funkcję globalnie.
 */

window.createBBCEventSource =
    createBBCEventSource;


/*
 * =====================================================
 * FORMATOWANIE LICZB
 * =====================================================
 */

function fmtNumber(
    n,
    maxDecimals = 4
) {

    if (
        n === null ||
        n === undefined ||
        Number.isNaN(Number(n))
    ) {
        return "—";
    }


    const locale =
        (
            typeof currentLang !== "undefined" &&
            currentLang === "en"
        )
            ? "en-US"
            : "pl-PL";


    return Number(n).toLocaleString(
        locale,
        {
            maximumFractionDigits:
                maxDecimals
        }
    );
}


/*
 * =====================================================
 * FORMATOWANIE HASHY
 * =====================================================
 */

function fmtHash(
    h,
    len = 10
) {

    if (!h) {
        return "—";
    }


    if (
        h.length <=
        len * 2
    ) {
        return h;
    }


    return (
        h.slice(0, len) +
        "…" +
        h.slice(-4)
    );
}


/*
 * =====================================================
 * FORMATOWANIE ADRESU
 * =====================================================
 */

function fmtAddress(
    a,
    len = 8
) {

    if (!a) {
        return "—";
    }


    if (
        a.length <=
        len * 2
    ) {
        return a;
    }


    return (
        a.slice(0, len) +
        "…" +
        a.slice(-4)
    );
}


/*
 * =====================================================
 * FORMATOWANIE CZASU
 * =====================================================
 */

function fmtTime(ts) {

    if (!ts) {
        return "—";
    }


    const locale =
        (
            typeof currentLang !== "undefined" &&
            currentLang === "en"
        )
            ? "en-US"
            : "pl-PL";


    return new Date(ts)
        .toLocaleString(locale);
}


/*
 * =====================================================
 * TIME AGO
 * =====================================================
 */

function timeAgo(ts) {

    const s =
        Math.floor(
            (
                Date.now() -
                Number(ts)
            ) / 1000
        );


    const tr =
        typeof t === "function"
            ? t
            : (k) => k;


    if (s < 5) {

        return tr(
            "time_now"
        );
    }


    if (s < 60) {

        return (
            `${s}` +
            tr("time_s_ago")
        );
    }


    if (s < 3600) {

        return (
            `${Math.floor(s / 60)}` +
            tr("time_m_ago")
        );
    }


    if (s < 86400) {

        return (
            `${Math.floor(s / 3600)}` +
            tr("time_h_ago")
        );
    }


    return (
        `${Math.floor(s / 86400)}` +
        tr("time_d_ago")
    );
}


/*
 * =====================================================
 * HTML ESCAPE
 * =====================================================
 */

function escapeHtml(s) {

    return String(s)
        .replace(
            /[&<>"']/g,
            (c) => ({
                "&":
                    "&amp;",

                "<":
                    "&lt;",

                ">":
                    "&gt;",

                '"':
                    "&quot;",

                "'":
                    "&#39;"
            }[c])
        );
}


/*
 * =====================================================
 * SMOKE FIELD
 * =====================================================
 *
 * Wstawia pole dymu do tła strony.
 *
 * Wołane raz na starcie strony.
 */

function mountSmokeField() {

    if (
        document.querySelector(
            ".smoke-field"
        )
    ) {
        return;
    }


    const div =
        document.createElement(
            "div"
        );


    div.className =
        "smoke-field";


    div.innerHTML =
        "<span></span>" +
        "<span></span>" +
        "<span></span>";


    document.body.prepend(
        div
    );
}


/*
 * =====================================================
 * GLOBAL EXPORTS
 * =====================================================
 *
 * Starsze strony mogą korzystać
 * z funkcji bez żadnych zmian.
 */

window.apiGet =
    apiGet;

window.apiPost =
    apiPost;

window.fmtNumber =
    fmtNumber;

window.fmtHash =
    fmtHash;

window.fmtAddress =
    fmtAddress;

window.fmtTime =
    fmtTime;

window.timeAgo =
    timeAgo;

window.escapeHtml =
    escapeHtml;

window.mountSmokeField =
    mountSmokeField;


/*
 * =====================================================
 * DEBUG
 * =====================================================
 */

console.log(
    "BitBudCoin API:",
    API_BASE
);

console.log(
    "BitBudCoin SSE:",
    BBC_EVENTS_URL
);


// =====================================================
// BitBudCoin — odporny klient stanu na żywo (BBCLiveState)
// =====================================================
//
// Jeden, wspólny mechanizm dla WSZYSTKICH 16 stron (już ładują
// api.js). Cel: strona nigdy nie pokazuje pustego ekranu ani
// "Failed to fetch" — zawsze ostatni znany dobry stan, plus jasna
// informacja czy dane są żywe czy z awaryjnego cache.
//
// Kolejność źródeł:
//   1. SSE (/events)   - główne źródło, push w czasie rzeczywistym
//   2. REST (/state)   - fallback co 10s, gdy SSE nie działa
//   3. Ostatni znany dobry stan w pamięci - gdy oba wyżej zawiodą
//
// Zero peerów, zero górników to POPRAWNY stan danych (puste tablice,
// zera), NIE błąd — nie jest tu w żaden sposób traktowany inaczej niż
// każdy inny stan.
//
// Użycie na stronie:
//
//   BBCLiveState.init();
//   BBCLiveState.subscribe(({ state, live, lastGoodAt }) => {
//       document.querySelector("#height").textContent = state.height;
//       document.querySelector("#status").textContent =
//           live ? "🟢 na żywo" : "⚠️ ostatnia synchronizacja: " + new Date(lastGoodAt).toLocaleTimeString();
//   });
//
// =====================================================

const BBCLiveState = (() => {
    let currentState = null;
    let lastGoodAt = null;
    let live = false;
    const listeners = new Set();

    let eventSource = null;
    let pollTimer = null;
    let reconnectTimer = null;
    let pollIntervalMs = 10000;
    let started = false;

    function notify() {
        const snapshot = { state: currentState, lastGoodAt, live };
        for (const fn of listeners) {
            try {
                fn(snapshot);
            } catch (err) {
                // błąd w jednym subskrybencie nie może zepsuć reszty
                console.error("BBCLiveState: błąd w subskrybencie:", err);
            }
        }
    }

    function applyGoodState(newState, isLive) {
        currentState = newState;
        lastGoodAt = Date.now();
        live = isLive;
        notify();
    }

    // Dostępne, nawet gdy nic świeżego nie przyszło - UI może pokazać
    // baner "połączenie chwilowo niedostępne", nie czyścić ekranu.
    function markDegraded() {
        live = false;
        notify();
    }

    async function pollOnce() {
        try {
            const data = await apiGet("/state");
            applyGoodState(data, false); // false = to fallback REST, nie SSE push
        } catch (err) {
            markDegraded();
        }
    }

    function startPolling() {
        if (pollTimer) return;
        pollOnce();
        pollTimer = setInterval(pollOnce, pollIntervalMs);
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectSSE();
        }, 5000);
    }

    function connectSSE() {
        if (!window.EventSource) {
            startPolling();
            return;
        }

        try {
            eventSource = createBBCEventSource();
        } catch (err) {
            startPolling();
            return;
        }

        eventSource.addEventListener("state", (e) => {
            try {
                const data = JSON.parse(e.data);
                stopPolling(); // SSE żyje - fallback nie jest już potrzebny
                applyGoodState(data, true);
            } catch (err) {
                // pojedyncza zła ramka SSE - ignoruj, czekaj na następną
            }
        });

        eventSource.onopen = () => {
            stopPolling();
        };

        eventSource.onerror = () => {
            // SSE padło - awaryjnie REST, ale połączenie samo próbuje
            // się odbudować (natywne zachowanie EventSource), więc nie
            // tworzymy tu duplikatu przez ręczne reconnect w kółko.
            markDegraded();
            startPolling();
        };
    }

    function init(options = {}) {
        if (started) return; // bezpieczne przy wielokrotnym wywołaniu z tej samej strony
        started = true;
        if (options.pollIntervalMs) pollIntervalMs = options.pollIntervalMs;

        // Natychmiastowy pierwszy odczyt przez REST - nie czekamy na
        // pierwszy event SSE, żeby strona miała dane od razu przy starcie.
        pollOnce().then(() => connectSSE());
    }

    function subscribe(fn) {
        listeners.add(fn);
        if (currentState) {
            try {
                fn({ state: currentState, lastGoodAt, live });
            } catch (err) {}
        }
        return () => listeners.delete(fn);
    }

    return {
        init,
        subscribe,
        getState: () => currentState,
        getLastGoodAt: () => lastGoodAt,
        isLive: () => live,
    };
})();

window.BBCLiveState = BBCLiveState;
