/* ============================================================
   BitBudCoin — NFT w portfelu (wallet.html)
   Dodaje kartę "Moje NFT": lista NFT na zalogowanym adresie BbC + wysyłanie.
   Odbieranie nie wymaga żadnej akcji: NFT wybite lub przekazane na Twój adres
   BbC pojawia się tu samo.
   Klucz prywatny NIE opuszcza przeglądarki — na serwer idzie tylko podpis.
   Zależności (są już na stronie portfela): currentWallet, API_BASE, bufferToBase64,
   opcjonalnie bbcCheckAddress / bbcToNetworkForm, t() z i18n.js.
   ============================================================ */
(function () {
    "use strict";

    var ADDR_RE = /^(NFT|BbC|tBbC)[0-9a-fA-F]{40}$/;

    var DICT = {
        pl: {
            wallet_nft_title: "Moje NFT",
            wallet_nft_hint: "NFT trafiają tu automatycznie na Twój adres BbC. Żeby jakieś dostać, podaj nadawcy adres z karty \"Odbierz\".",
            wallet_nft_none: "Brak NFT na tym adresie.",
            wallet_nft_loading: "Wczytuję…",
            wallet_nft_unavailable: "Lista NFT jest teraz niedostępna.",
            wallet_nft_refresh: "Odśwież",
            wallet_nft_gallery: "Galeria →",
            wallet_nft_send: "Wyślij",
            wallet_nft_to: "Adres odbiorcy (BbC… lub NFT…)",
            wallet_nft_review: "Dalej",
            wallet_nft_confirm: "Potwierdź i podpisz",
            wallet_nft_cancel: "Anuluj",
            wallet_nft_summary: "Wysyłasz „{name}” (#{id}) na adres:",
            wallet_nft_irreversible: "Tego nie da się cofnąć.",
            wallet_nft_bad_addr: "To nie jest poprawny adres.",
            wallet_nft_bad_checksum: "Suma kontrolna adresu nie pasuje — w adresie jest literówka.",
            wallet_nft_self: "To Twój własny adres.",
            wallet_nft_signing: "Podpisuję i wysyłam…",
            wallet_nft_sent: "✅ Wysłano „{name}”.",
            wallet_nft_err_sig: "Odrzucone. Odśwież listę i spróbuj jeszcze raz — to NFT mogło zmienić właściciela.",
            wallet_nft_err_rate: "Za dużo prób, spróbuj za chwilę.",
            wallet_nft_err_net: "Brak połączenia z serwerem."
        },
        en: {
            wallet_nft_title: "My NFTs",
            wallet_nft_hint: "NFTs arrive here automatically at your BbC address. To receive one, give the sender the address from the \"Receive\" card.",
            wallet_nft_none: "No NFTs on this address.",
            wallet_nft_loading: "Loading…",
            wallet_nft_unavailable: "The NFT list is unavailable right now.",
            wallet_nft_refresh: "Refresh",
            wallet_nft_gallery: "Gallery →",
            wallet_nft_send: "Send",
            wallet_nft_to: "Recipient address (BbC… or NFT…)",
            wallet_nft_review: "Next",
            wallet_nft_confirm: "Confirm and sign",
            wallet_nft_cancel: "Cancel",
            wallet_nft_summary: "You are sending “{name}” (#{id}) to:",
            wallet_nft_irreversible: "This cannot be undone.",
            wallet_nft_bad_addr: "That is not a valid address.",
            wallet_nft_bad_checksum: "The address checksum does not match — there is a typo.",
            wallet_nft_self: "That is your own address.",
            wallet_nft_signing: "Signing and sending…",
            wallet_nft_sent: "✅ Sent “{name}”.",
            wallet_nft_err_sig: "Rejected. Refresh the list and try again — this NFT may have changed owner.",
            wallet_nft_err_rate: "Too many attempts, try again shortly.",
            wallet_nft_err_net: "Can't reach the server."
        }
    };
    if (window.BbCI18n && BbCI18n.getTranslations) {
        var TR = BbCI18n.getTranslations();
        Object.assign(TR.pl, DICT.pl);
        Object.assign(TR.en, DICT.en);
    }
    function T(k, r) {
        if (typeof window.t === "function") return window.t(k, r || {});
        var v = DICT.pl[k] !== undefined ? DICT.pl[k] : k;
        Object.keys(r || {}).forEach(function (n) { v = v.split("{" + n + "}").join(String(r[n])); });
        return v;
    }

    var norm = function (a) { return a.replace(/^(NFT|tBbC|BbC)(.*)$/, function (m, p, h) { return p + h.toLowerCase(); }); };
    var wallet = function () { try { return typeof currentWallet !== "undefined" ? currentWallet : null; } catch (e) { return null; } };
    var apiRoot = function () { try { return typeof API_BASE !== "undefined" ? API_BASE : ""; } catch (e) { return ""; } };

    // fetch z limitem czasu: zawieszone połączenie nie może na zawsze zostawić karty na „Wczytuję…”
    function fetchT(url, opts, ms) {
        var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, ms || 12000);
        return fetch(url, Object.assign({}, opts || {}, { signal: ctl.signal })).finally(function () { clearTimeout(timer); });
    }

    // trasa API: /api/nft, a gdyby proxy jej nie przepuszczał — /nft
    var basePromise = null;
    function resolveBase() {
        if (!basePromise) {
            basePromise = (async function () {
                var tries = ["/api/nft", "/nft"];
                for (var i = 0; i < tries.length; i++) {
                    try { var r = await fetchT(apiRoot() + tries[i] + "/list?limit=1", { cache: "no-store" }, 5000); if (r.ok) return tries[i]; } catch (e) { /* następna */ }
                }
                basePromise = null; // spróbuj ponownie przy następnym odświeżeniu
                return null;
            })();
        }
        return basePromise;
    }
    async function api(path, opts) {
        var base = await resolveBase();
        if (!base) throw new Error("unavailable");
        return fetchT(apiRoot() + base + path, opts, 12000);
    }

    var S = { tokens: null, error: false, loading: false, sendId: null, step: "form", to: "", msg: null, lastAddr: null };

    function el(tag, props, kids) {
        var e = document.createElement(tag);
        Object.keys(props || {}).forEach(function (k) {
            if (k === "text") e.textContent = props[k];
            else if (k === "style") e.style.cssText = props[k];
            else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2), props[k]);
            else e.setAttribute(k, props[k]);
        });
        (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
        return e;
    }
    function rarityLabel(r) { var k = "nft_rarity_" + r, v = T(k); return v === k ? r : v; }

    function ensureCard() {
        var card = document.getElementById("nftCard");
        if (card) return card;
        var anchor = document.getElementById("sendCard");
        card = el("div", { "class": "card", id: "nftCard", style: "display:none" });
        if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(card, anchor.nextSibling);
        else (document.getElementById("tab-manage") || document.body).appendChild(card);
        return card;
    }

    function render() {
        var card = document.getElementById("nftCard");
        if (!card) return;
        var w = wallet();
        if (!w) { card.style.display = "none"; return; }
        card.style.display = "block";
        card.textContent = "";

        var head = el("div", { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap;" }, [
            el("h3", { text: "🖼️ " + T("wallet_nft_title"), style: "margin:0;flex:1;" }),
            el("a", { "class": "hint", href: "nft.html", text: T("wallet_nft_gallery"), style: "margin:0;color:var(--leaf);" }),
            el("button", { type: "button", "class": "btn secondary", text: "↻", "aria-label": T("wallet_nft_refresh"), style: "padding:6px 10px;font-size:.8rem;", onclick: function () { refresh(); } })
        ]);
        card.appendChild(head);
        card.appendChild(el("p", { "class": "hint", text: T("wallet_nft_hint") }));

        if (S.msg) card.appendChild(el("div", { text: S.msg.text, style: "margin:8px 0;font-family:var(--font-mono);font-size:.82rem;color:" + (S.msg.ok ? "var(--leaf)" : "var(--danger)") + ";" }));

        if (S.error) { card.appendChild(el("p", { "class": "hint", text: T("wallet_nft_unavailable") })); return; }
        if (S.tokens === null) { card.appendChild(el("p", { "class": "hint", text: T("wallet_nft_loading") })); return; }
        if (S.tokens.length === 0) { card.appendChild(el("p", { "class": "hint", text: T("wallet_nft_none") })); return; }

        S.tokens.forEach(function (tok) {
            var row = el("div", { style: "padding:10px 0;border-top:1px solid var(--border);" });
            row.appendChild(el("div", { style: "display:flex;align-items:center;gap:10px;" }, [
                el("div", { style: "flex:1;min-width:0;" }, [
                    el("div", { text: tok.name, style: "font-weight:600;overflow-wrap:anywhere;" }),
                    el("div", { text: "#" + tok.id + " · " + rarityLabel(tok.rarity), style: "font-family:var(--font-mono);font-size:.75rem;color:var(--text-dim);" })
                ]),
                S.sendId === tok.id ? null : el("button", { type: "button", "class": "btn secondary", text: T("wallet_nft_send"), style: "padding:8px 14px;", onclick: function () { S.sendId = tok.id; S.step = "form"; S.to = ""; S.msg = null; render(); } })
            ]));
            if (S.sendId === tok.id) row.appendChild(sendForm(tok));
            card.appendChild(row);
        });
    }

    function sendForm(tok) {
        var box = el("div", { style: "margin-top:10px;" });
        if (S.step === "form") {
            var input = el("input", { type: "text", id: "nftTo", placeholder: "BbC… / NFT…", "aria-label": T("wallet_nft_to"), autocomplete: "off", autocapitalize: "off", spellcheck: "false", style: "width:100%;box-sizing:border-box;font-family:var(--font-mono);font-size:.82rem;" });
            input.value = S.to;
            input.addEventListener("input", function () { S.to = input.value; });
            box.appendChild(el("label", { "for": "nftTo", text: T("wallet_nft_to"), style: "display:block;font-size:.8rem;color:var(--text-dim);margin-bottom:4px;" }));
            box.appendChild(input);
            box.appendChild(el("div", { "class": "btn-row", style: "display:flex;gap:8px;margin-top:10px;" }, [
                el("button", { type: "button", "class": "btn flame", text: T("wallet_nft_review"), onclick: function () { review(tok); } }),
                el("button", { type: "button", "class": "btn secondary", text: T("wallet_nft_cancel"), onclick: cancel })
            ]));
        } else {
            box.appendChild(el("p", { text: T("wallet_nft_summary", { name: tok.name, id: tok.id }), style: "margin:0 0 6px;font-size:.85rem;" }));
            box.appendChild(el("div", { text: S.to, style: "font-family:var(--font-mono);font-size:.8rem;word-break:break-all;color:var(--leaf);background:var(--surface-2);padding:10px 12px;border-radius:8px;" }));
            box.appendChild(el("p", { text: "⚠️ " + T("wallet_nft_irreversible"), style: "margin:8px 0;font-size:.8rem;color:#ffb3a8;" }));
            box.appendChild(el("div", { style: "display:flex;gap:8px;" }, [
                el("button", { type: "button", "class": "btn flame", id: "nftConfirm", text: T("wallet_nft_confirm"), onclick: function () { doSend(tok); } }),
                el("button", { type: "button", "class": "btn secondary", text: T("wallet_nft_cancel"), onclick: cancel })
            ]));
        }
        return box;
    }
    function cancel() { S.sendId = null; S.step = "form"; S.to = ""; render(); }

    async function review(tok) {
        var raw = (S.to || "").trim();
        var fail = function (k) { S.msg = { ok: false, text: T(k) }; render(); };
        if (!ADDR_RE.test(raw)) return fail("wallet_nft_bad_addr");
        if (!/^NFT/.test(raw) && typeof window.bbcCheckAddress === "function") {
            var st; try { st = await window.bbcCheckAddress(raw); } catch (e) { st = "legacy"; }
            if (st === "invalid") return fail("wallet_nft_bad_checksum");
            if (st === "malformed") return fail("wallet_nft_bad_addr");
        }
        var net = typeof window.bbcToNetworkForm === "function" && !/^NFT/.test(raw) ? window.bbcToNetworkForm(raw) : norm(raw);
        net = norm(net);
        if (net === norm(wallet().address)) return fail("wallet_nft_self");
        S.to = net; S.step = "confirm"; S.msg = null; render();
    }

    function b64(buf) {
        if (typeof window.bufferToBase64 === "function") return window.bufferToBase64(buf);
        var s = "", u = new Uint8Array(buf); for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s);
    }

    async function doSend(tok) {
        var w = wallet(); if (!w) return;
        var btn = document.getElementById("nftConfirm"); if (btn) btn.disabled = true;
        S.msg = { ok: true, text: T("wallet_nft_signing") }; render();
        try {
            var from = norm(w.address);
            var nr = await api("/nonce/" + encodeURIComponent(from), { cache: "no-store" });
            var nonce = (await nr.json()).nonce;
            // ta sama treść, którą weryfikuje serwer (nft.js: transferMessage)
            var msg = "BBCNFT1|transfer|" + tok.id + "|" + S.to + "|" + nonce;
            var sig = b64(await crypto.subtle.sign({ name: "Ed25519" }, w.privateKey, new TextEncoder().encode(msg)));
            var r = await api("/transfer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ publicKey: w.publicKeyPem, to: S.to, tokenId: tok.id, signature: sig }) });
            if (r.ok) {
                S.msg = { ok: true, text: T("wallet_nft_sent", { name: tok.name }) };
                S.sendId = null; S.step = "form"; S.to = "";
                await refresh(true);
                return;
            }
            var d = await r.json().catch(function () { return {}; });
            S.msg = { ok: false, text: r.status === 403 ? T("wallet_nft_err_sig") : r.status === 429 ? T("wallet_nft_err_rate") : (d.error || "HTTP " + r.status) };
            S.step = "form";
        } catch (e) {
            S.msg = { ok: false, text: T("wallet_nft_err_net") };
            S.step = "form";
        }
        render();
    }

    async function refresh(keepMsg) {
        var w = wallet(); if (!w || S.loading) return;
        S.loading = true;
        try {
            var r = await api("/list?limit=100&owner=" + encodeURIComponent(norm(w.address)), { cache: "no-store" });
            if (!r.ok) throw new Error("HTTP " + r.status);
            S.tokens = (await r.json()).tokens; S.error = false;
        } catch (e) { if (S.tokens === null) S.error = true; }
        S.loading = false;
        if (!keepMsg && S.sendId === null) S.msg = null;
        render();
    }

    // wykrywanie logowania/wylogowania portfela (nie zmieniamy kodu wallet.html)
    setInterval(function () {
        var w = wallet(), addr = w ? w.address : null;
        if (addr !== S.lastAddr) {
            S.lastAddr = addr; S.tokens = null; S.error = false; S.sendId = null; S.msg = null; S.step = "form"; S.to = "";
            if (addr) { ensureCard(); render(); refresh(); } else render();
        }
    }, 800);
    setInterval(function () { if (wallet() && S.sendId === null && !document.hidden) refresh(true); }, 30000);
    document.addEventListener("bbc:langchange", render);
})();
