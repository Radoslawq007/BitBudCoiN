// Fraza odzyskiwania BitBudCoin - 12 słów zamiast surowego klucza.
//
// DWA rodzaje fraz (portfel rozpoznaje sam, nic nie trzeba wybierać):
//   1) STARA fraza: 12 słów z listy 256 (seed-wordlist.js), 96 bitów. Działa bez zmian,
//      dokładnie ten sam kod co wcześniej - istniejące portfele zostają nietknięte.
//   2) STANDARDOWA fraza BIP39: 12 angielskich słów z listy 2048 + suma kontrolna,
//      klucz z SLIP-0010 (Ed25519), ścieżka m/44'/28000000'/0'/0'/0'.
//      Taki format rozumieją inne portfele i narzędzia.
// Gdy wszystkie 12 słów jest na starej liście, zawsze obowiązuje STARA fraza (ochrona istniejących portfeli).
// Ta sama fraza ZAWSZE odtwarza dokładnie ten sam portfel - deterministycznie.

// true = NOWE frazy generowane są w standardzie BIP39. false = jak dotąd (stara lista 256).
const BBC_GENERATE_BIP39 = true;
// TYMCZASOWY numer monety (SLIP-44). Zostaje w kodzie na stałe jako ścieżka zgodności.
const BBC_COIN_TYPE = 28000000;

function seedBufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

// ---------------- STARA fraza (256 słów) - bez zmian ----------------

function seedPhraseToEntropy(words) {
    if (words.length !== 12) throw new Error("Fraza musi mieć dokładnie 12 słów");
    const bytes = new Uint8Array(12);
    for (let i = 0; i < 12; i++) {
        const idx = SEED_WORDLIST.indexOf(words[i].toLowerCase().trim());
        if (idx === -1) throw new Error(`Słowo "${words[i]}" nie jest na liście - sprawdź pisownię`);
        bytes[i] = idx;
    }
    return bytes;
}

function bbcIsOldPhrase(words) {
    return Array.isArray(words) && words.length === 12 &&
        words.every((w) => SEED_WORDLIST.indexOf(String(w).toLowerCase().trim()) !== -1);
}

function generateOldSeedPhrase() {
    const indices = new Uint8Array(12);
    crypto.getRandomValues(indices);
    // Uint8Array daje 0-255, lista ma dokładnie 256 słów - idealne dopasowanie
    return Array.from(indices).map((i) => SEED_WORDLIST[i]);
}

// Wspólna końcówka: 32 bajty -> para kluczy Ed25519 (PKCS8 -> publiczny -> PEM). Kod jak dotychczas.
async function bbcKeyPairFromSeed32(seed32) {
    // Standardowy, stały nagłówek PKCS8 dla Ed25519 - zmienia się tylko ostatnie 32 bajty (sam klucz)
    const pkcs8Prefix = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
    const pkcs8Bytes = new Uint8Array(pkcs8Prefix.length + seed32.length);
    pkcs8Bytes.set(pkcs8Prefix);
    pkcs8Bytes.set(seed32, pkcs8Prefix.length);

    const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8Bytes, { name: "Ed25519" }, true, ["sign"]);
    const publicKeyRaw = await crypto.subtle.exportKey("jwk", privateKey).then(async (jwk) => {
        const pubJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x, key_ops: ["verify"], ext: true };
        return crypto.subtle.importKey("jwk", pubJwk, { name: "Ed25519" }, true, ["verify"]);
    });

    const publicKeyPem = await crypto.subtle.exportKey("spki", publicKeyRaw).then((buf) =>
        `-----BEGIN PUBLIC KEY-----\n${seedBufferToBase64(buf)}\n-----END PUBLIC KEY-----`
    );
    const privateKeyPem = await crypto.subtle.exportKey("pkcs8", privateKey).then((buf) =>
        `-----BEGIN PRIVATE KEY-----\n${seedBufferToBase64(buf)}\n-----END PRIVATE KEY-----`
    );

    return { privateKey, publicKeyPem, privateKeyPem };
}

async function bbcDeriveOld(words) {
    const entropy = seedPhraseToEntropy(words);
    // Rozciągnięcie 12 bajtów entropii do pełnych 32 bajtów klucza Ed25519,
    // z etykietą domeny żeby uniknąć jakiejkolwiek przypadkowej kolizji z innym zastosowaniem.
    const domainLabel = new TextEncoder().encode("BitBudCoin-seed-v1:");
    const combined = new Uint8Array(domainLabel.length + entropy.length);
    combined.set(domainLabel);
    combined.set(entropy, domainLabel.length);
    const seed32 = new Uint8Array(await crypto.subtle.digest("SHA-256", combined));
    return bbcKeyPairFromSeed32(seed32);
}

// ---------------- STANDARD BIP39 + SLIP-0010 ----------------

// SHA-256 synchronicznie (potrzebny do sumy kontrolnej przy generowaniu frazy, która jest wołana bez await)
function bbcSha256Sync(input) {
    const K = new Uint32Array([
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ]);
    const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const len = input.length;
    const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(input);
    padded[len] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor((len * 8) / 0x100000000), false);
    dv.setUint32(padded.length - 4, (len * 8) >>> 0, false);
    const W = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4, false);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(W[i-15], 7) ^ rotr(W[i-15], 18) ^ (W[i-15] >>> 3);
            const s1 = rotr(W[i-2], 17) ^ rotr(W[i-2], 19) ^ (W[i-2] >>> 10);
            W[i] = (W[i-16] + s0 + W[i-7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = H;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i], false);
    return out;
}

// Lista 2048 angielskich słów BIP39 (identyczna z oficjalnym english.txt)
const BIP39_EN = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult advance advice aerobic affair afford afraid again age agent agree ahead aim air airport aisle alarm album alcohol alert alien all alley allow almost alone alpha already also alter always amateur amazing among amount amused analyst anchor ancient anger angle angry animal ankle announce annual another answer antenna antique anxiety any apart apology appear apple approve april arch arctic area arena argue arm armed armor army around arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume asthma athlete atom attack attend attitude attract auction audit august aunt author auto autumn average avocado avoid awake aware away awesome awful awkward axis baby bachelor bacon badge bag balance balcony ball bamboo banana banner bar barely bargain barrel base basic basket battle beach bean beauty because become beef before begin behave behind believe below belt bench benefit best betray better between beyond bicycle bid bike bind biology bird birth bitter black blade blame blanket blast bleak bless blind blood blossom blouse blue blur blush board boat body boil bomb bone bonus book boost border boring borrow boss bottom bounce box boy bracket brain brand brass brave bread breeze brick bridge brief bright bring brisk broccoli broken bronze broom brother brown brush bubble buddy budget buffalo build bulb bulk bullet bundle bunker burden burger burst bus business busy butter buyer buzz cabbage cabin cable cactus cage cake call calm camera camp can canal cancel candy cannon canoe canvas canyon capable capital captain car carbon card cargo carpet carry cart case cash casino castle casual cat catalog catch category cattle caught cause caution cave ceiling celery cement census century cereal certain chair chalk champion change chaos chapter charge chase chat cheap check cheese chef cherry chest chicken chief child chimney choice choose chronic chuckle chunk churn cigar cinnamon circle citizen city civil claim clap clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog close cloth cloud clown club clump cluster clutch coach coast coconut code coffee coil coin collect color column combine come comfort comic common company concert conduct confirm congress connect consider control convince cook cool copper copy coral core corn correct cost cotton couch country couple course cousin cover coyote crack cradle craft cram crane crash crater crawl crazy cream credit creek crew cricket crime crisp critic crop cross crouch crowd crucial cruel cruise crumble crunch crush cry crystal cube culture cup cupboard curious current curtain curve cushion custom cute cycle dad damage damp dance danger daring dash daughter dawn day deal debate debris decade december decide decline decorate decrease deer defense define defy degree delay deliver demand demise denial dentist deny depart depend deposit depth deputy derive describe desert design desk despair destroy detail detect develop device devote diagram dial diamond diary dice diesel diet differ digital dignity dilemma dinner dinosaur direct dirt disagree discover disease dish dismiss disorder display distance divert divide divorce dizzy doctor document dog doll dolphin domain donate donkey donor door dose double dove draft dragon drama drastic draw dream dress drift drill drink drip drive drop drum dry duck dumb dune during dust dutch duty dwarf dynamic eager eagle early earn earth easily east easy echo ecology economy edge edit educate effort egg eight either elbow elder electric elegant element elephant elevator elite else embark embody embrace emerge emotion employ empower empty enable enact end endless endorse enemy energy enforce engage engine enhance enjoy enlist enough enrich enroll ensure enter entire entry envelope episode equal equip era erase erode erosion error erupt escape essay essence estate eternal ethics evidence evil evoke evolve exact example excess exchange excite exclude excuse execute exercise exhaust exhibit exile exist exit exotic expand expect expire explain expose express extend extra eye eyebrow fabric face faculty fade faint faith fall false fame family famous fan fancy fantasy farm fashion fat fatal father fatigue fault favorite feature february federal fee feed feel female fence festival fetch fever few fiber fiction field figure file film filter final find fine finger finish fire firm first fiscal fish fit fitness fix flag flame flash flat flavor flee flight flip float flock floor flower fluid flush fly foam focus fog foil fold follow food foot force forest forget fork fortune forum forward fossil foster found fox fragile frame frequent fresh friend fringe frog front frost frown frozen fruit fuel fun funny furnace fury future gadget gain galaxy gallery game gap garage garbage garden garlic garment gas gasp gate gather gauge gaze general genius genre gentle genuine gesture ghost giant gift giggle ginger giraffe girl give glad glance glare glass glide glimpse globe gloom glory glove glow glue goat goddess gold good goose gorilla gospel gossip govern gown grab grace grain grant grape grass gravity great green grid grief grit grocery group grow grunt guard guess guide guilt guitar gun gym habit hair half hammer hamster hand happy harbor hard harsh harvest hat have hawk hazard head health heart heavy hedgehog height hello helmet help hen hero hidden high hill hint hip hire history hobby hockey hold hole holiday hollow home honey hood hope horn horror horse hospital host hotel hour hover hub huge human humble humor hundred hungry hunt hurdle hurry hurt husband hybrid ice icon idea identify idle ignore ill illegal illness image imitate immense immune impact impose improve impulse inch include income increase index indicate indoor industry infant inflict inform inhale inherit initial inject injury inmate inner innocent input inquiry insane insect inside inspire install intact interest into invest invite involve iron island isolate issue item ivory jacket jaguar jar jazz jealous jeans jelly jewel job join joke journey joy judge juice jump jungle junior junk just kangaroo keen keep ketchup key kick kid kidney kind kingdom kiss kit kitchen kite kitten kiwi knee knife knock know lab label labor ladder lady lake lamp language laptop large later latin laugh laundry lava law lawn lawsuit layer lazy leader leaf learn leave lecture left leg legal legend leisure lemon lend length lens leopard lesson letter level liar liberty library license life lift light like limb limit link lion liquid list little live lizard load loan lobster local lock logic lonely long loop lottery loud lounge love loyal lucky luggage lumber lunar lunch luxury lyrics machine mad magic magnet maid mail main major make mammal man manage mandate mango mansion manual maple marble march margin marine market marriage mask mass master match material math matrix matter maximum maze meadow mean measure meat mechanic medal media melody melt member memory mention menu mercy merge merit merry mesh message metal method middle midnight milk million mimic mind minimum minor minute miracle mirror misery miss mistake mix mixed mixture mobile model modify mom moment monitor monkey monster month moon moral more morning mosquito mother motion motor mountain mouse move movie much muffin mule multiply muscle museum mushroom music must mutual myself mystery myth naive name napkin narrow nasty nation nature near neck need negative neglect neither nephew nerve nest net network neutral never news next nice night noble noise nominee noodle normal north nose notable note nothing notice novel now nuclear number nurse nut oak obey object oblige obscure observe obtain obvious occur ocean october odor off offer office often oil okay old olive olympic omit once one onion online only open opera opinion oppose option orange orbit orchard order ordinary organ orient original orphan ostrich other outdoor outer output outside oval oven over own owner oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther paper parade parent park parrot party pass patch path patient patrol pattern pause pave payment peace peanut pear peasant pelican pen penalty pencil people pepper perfect permit person pet phone photo phrase physical piano picnic picture piece pig pigeon pill pilot pink pioneer pipe pistol pitch pizza place planet plastic plate play please pledge pluck plug plunge poem poet point polar pole police pond pony pool popular portion position possible post potato pottery poverty powder power practice praise predict prefer prepare present pretty prevent price pride primary print priority prison private prize problem process produce profit program project promote proof property prosper protect proud provide public pudding pull pulp pulse pumpkin punch pupil puppy purchase purity purpose purse push put puzzle pyramid quality quantum quarter question quick quit quiz quote rabbit raccoon race rack radar radio rail rain raise rally ramp ranch random range rapid rare rate rather raven raw razor ready real reason rebel rebuild recall receive recipe record recycle reduce reflect reform refuse region regret regular reject relax release relief rely remain remember remind remove render renew rent reopen repair repeat replace report require rescue resemble resist resource response result retire retreat return reunion reveal review reward rhythm rib ribbon rice rich ride ridge rifle right rigid ring riot ripple risk ritual rival river road roast robot robust rocket romance roof rookie room rose rotate rough round route royal rubber rude rug rule run runway rural sad saddle sadness safe sail salad salmon salon salt salute same sample sand satisfy satoshi sauce sausage save say scale scan scare scatter scene scheme school science scissors scorpion scout scrap screen script scrub sea search season seat second secret section security seed seek segment select sell seminar senior sense sentence series service session settle setup seven shadow shaft shallow share shed shell sheriff shield shift shine ship shiver shock shoe shoot shop short shoulder shove shrimp shrug shuffle shy sibling sick side siege sight sign silent silk silly silver similar simple since sing siren sister situate six size skate sketch ski skill skin skirt skull slab slam sleep slender slice slide slight slim slogan slot slow slush small smart smile smoke smooth snack snake snap sniff snow soap soccer social sock soda soft solar soldier solid solution solve someone song soon sorry sort soul sound soup source south space spare spatial spawn speak special speed spell spend sphere spice spider spike spin spirit split spoil sponsor spoon sport spot spray spread spring spy square squeeze squirrel stable stadium staff stage stairs stamp stand start state stay steak steel stem step stereo stick still sting stock stomach stone stool story stove strategy street strike strong struggle student stuff stumble style subject submit subway success such sudden suffer sugar suggest suit summer sun sunny sunset super supply supreme sure surface surge surprise surround survey suspect sustain swallow swamp swap swarm swear sweet swift swim swing switch sword symbol symptom syrup system table tackle tag tail talent talk tank tape target task taste tattoo taxi teach team tell ten tenant tennis tent term test text thank that theme then theory there they thing this thought three thrive throw thumb thunder ticket tide tiger tilt timber time tiny tip tired tissue title toast tobacco today toddler toe together toilet token tomato tomorrow tone tongue tonight tool tooth top topic topple torch tornado tortoise toss total tourist toward tower town toy track trade traffic tragic train transfer trap trash travel tray treat tree trend trial tribe trick trigger trim trip trophy trouble truck true truly trumpet trust truth try tube tuition tumble tuna tunnel turkey turn turtle twelve twenty twice twin twist two type typical ugly umbrella unable unaware uncle uncover under undo unfair unfold unhappy uniform unique unit universe unknown unlock until unusual unveil update upgrade uphold upon upper upset urban urge usage use used useful useless usual utility vacant vacuum vague valid valley valve van vanish vapor various vast vault vehicle velvet vendor venture venue verb verify version very vessel veteran viable vibrant vicious victory video view village vintage violin virtual virus visa visit visual vital vivid vocal voice void volcano volume vote voyage wage wagon wait walk wall walnut want warfare warm warrior wash wasp waste water wave way wealth weapon wear weasel weather web wedding weekend weird welcome west wet whale what wheat wheel when where whip whisper wide width wife wild will win window wine wing wink winner winter wire wisdom wise wish witness wolf woman wonder wood wool word work world worry worth wrap wreck wrestle wrist write wrong yard year yellow you young youth zebra zero zone zoo".split(" ");

function bbc39Bits(bytes) {
    return Array.from(bytes).map((b) => b.toString(2).padStart(8, "0")).join("");
}

function bbc39EntropyToWords(entropy16) {
    const bits = bbc39Bits(entropy16) + bbc39Bits(bbcSha256Sync(entropy16)).slice(0, 4);
    const out = [];
    for (let i = 0; i < 12; i++) out.push(BIP39_EN[parseInt(bits.slice(i * 11, i * 11 + 11), 2)]);
    return out;
}

// Zwraca 16 bajtów entropii albo null gdy fraza nie jest poprawną frazą BIP39
function bbc39WordsToEntropy(words) {
    if (!Array.isArray(words) || words.length !== 12) return null;
    let bits = "";
    for (const w of words) {
        const i = BIP39_EN.indexOf(String(w).toLowerCase().trim());
        if (i === -1) return null;
        bits += i.toString(2).padStart(11, "0");
    }
    const entropy = new Uint8Array(bits.slice(0, 128).match(/.{8}/g).map((b) => parseInt(b, 2)));
    return bbc39Bits(bbcSha256Sync(entropy)).slice(0, 4) === bits.slice(128) ? entropy : null;
}

async function bbc39Hmac(keyBytes, dataBytes) {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes));
}

// fraza -> seed (PBKDF2-HMAC-SHA512, 2048 rund) -> SLIP-0010 Ed25519 m/44'/coin'/0'/0'/0' -> 32 bajty klucza
async function bbc39DeriveSeed32(words) {
    const enc = new TextEncoder();
    const mnemonic = words.map((w) => String(w).toLowerCase().trim()).join(" ").normalize("NFKD");
    const pw = await crypto.subtle.importKey("raw", enc.encode(mnemonic), "PBKDF2", false, ["deriveBits"]);
    const seed = new Uint8Array(await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: enc.encode("mnemonic"), iterations: 2048, hash: "SHA-512" }, pw, 512));
    let I = await bbc39Hmac(enc.encode("ed25519 seed"), seed);
    let key = I.slice(0, 32), chain = I.slice(32);
    for (const idx of [44, BBC_COIN_TYPE, 0, 0, 0]) {
        const data = new Uint8Array(37);
        data.set(key, 1);
        new DataView(data.buffer).setUint32(33, (idx | 0x80000000) >>> 0, false);
        I = await bbc39Hmac(chain, data);
        key = I.slice(0, 32); chain = I.slice(32);
    }
    return key;
}

// ---------------- Interfejs używany przez wallet.html ----------------

function generateSeedPhrase() {
    if (!BBC_GENERATE_BIP39) return generateOldSeedPhrase();
    for (;;) {
        const entropy = new Uint8Array(16);
        crypto.getRandomValues(entropy);
        const words = bbc39EntropyToWords(entropy);
        if (!bbcIsOldPhrase(words)) return words; // (praktycznie zawsze) - unika dwuznaczności ze starą listą
    }
}

async function deriveKeyPairFromSeedPhrase(words) {
    if (bbcIsOldPhrase(words)) return bbcDeriveOld(words);
    if (bbc39WordsToEntropy(words)) return bbcKeyPairFromSeed32(await bbc39DeriveSeed32(words));

    if (!Array.isArray(words) || words.length !== 12) throw new Error("Fraza musi mieć dokładnie 12 słów");
    for (const w of words) {
        const x = String(w).toLowerCase().trim();
        if (SEED_WORDLIST.indexOf(x) === -1 && BIP39_EN.indexOf(x) === -1) {
            throw new Error(`Słowo "${w}" nie jest na liście - sprawdź pisownię`);
        }
    }
    throw new Error("Fraza ma złą sumę kontrolną - sprawdź kolejność i pisownię słów");
}
