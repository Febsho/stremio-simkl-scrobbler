import crypto from 'crypto';

const ALGORITHM = 'aes-192-cbc';

/**
 * Get the encryption key from environment variable.
 * AES-192 requires a 24-byte key.
 */
function getKey(): Buffer {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) {
        throw new Error('ENCRYPTION_KEY environment variable is required');
    }
    // Ensure key is exactly 24 bytes
    const keyBuffer = Buffer.alloc(24);
    Buffer.from(key).copy(keyBuffer);
    return keyBuffer;
}

/**
 * Encrypt a string using AES-192-CBC.
 * Returns a URL-safe base64 encoded string containing IV + ciphertext.
 */
export function encrypt(text: string): string {
    const key = getKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // Combine IV and encrypted data, encode as base64url
    const combined = iv.toString('hex') + ':' + encrypted;
    return Buffer.from(combined).toString('base64url');
}

/**
 * Decrypt a string that was encrypted with the encrypt function.
 */
export function decrypt(encryptedBase64: string): string {
    const key = getKey();

    // Decode base64url and split IV from ciphertext
    const combined = Buffer.from(encryptedBase64, 'base64url').toString('utf8');
    const [ivHex, encryptedHex] = combined.split(':');

    if (!ivHex || !encryptedHex) {
        throw new Error('Invalid encrypted data format');
    }

    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}
