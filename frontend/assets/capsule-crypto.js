// Prawdziwe szyfrowanie AES-256-GCM dla "zapamiętanego" portfela w localStorage.
// PBKDF2 do wyprowadzenia klucza z hasła (100k iteracji, solone losowo za
// każdym razem), GCM daje integralność - złe hasło rzuca czytelny błąd przy
// odszyfrowaniu, nigdy nie zwraca po cichu śmieci zamiast kluczy.

async function deriveKeyFromPassword(password, saltBytes) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: saltBytes, iterations: 100000, hash: "SHA-256" },
        baseKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

function bytesToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}
function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function encryptCapsuleMessage(plaintext, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKeyFromPassword(password, salt);
    const enc = new TextEncoder();
    const cipherBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
    return {
        ciphertext: bytesToBase64(new Uint8Array(cipherBuffer)),
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv)
    };
}

async function decryptCapsuleMessage(ciphertext, salt, iv, password) {
    const saltBytes = base64ToBytes(salt);
    const ivBytes = base64ToBytes(iv);
    const key = await deriveKeyFromPassword(password, saltBytes);
    const cipherBytes = base64ToBytes(ciphertext);
    const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBytes }, key, cipherBytes);
    return new TextDecoder().decode(plainBuffer);
}