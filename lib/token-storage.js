/**
 * Local Token Storage System
 * Stores API tokens locally in a JSON file (NOT in .env)
 *
 * This demonstrates PostCall's auth discovery flow:
 * 1. User makes request without token
 * 2. Proxy returns provisioning URL from OAS++ spec
 * 3. User gets token and submits it
 * 4. Proxy stores token locally
 * 5. Future requests use stored token
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKENS_FILE = path.join(__dirname, '../.tokens.json');

/**
 * Encrypt a token (simple symmetric encryption for POC)
 * In production, use proper key management and encryption
 */
function encrypt(text, secret = process.env.SESSION_SECRET || 'dev-secret') {
  // Create a key from the secret (32 bytes for aes-256)
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  // Create a random IV (16 bytes for AES)
  const iv = crypto.randomBytes(16);

  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  // Prepend IV to encrypted data (IV doesn't need to be secret)
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt a token
 */
function decrypt(encrypted, secret = process.env.SESSION_SECRET || 'dev-secret') {
  // Create a key from the secret (32 bytes for aes-256)
  const key = crypto.createHash('sha256').update(String(secret)).digest();

  // Split IV and encrypted data
  const parts = encrypted.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = parts[1];

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Load tokens from file
 * @returns {Object} tokens object
 */
function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      const data = fs.readFileSync(TOKENS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('[TokenStorage] Error loading tokens:', error.message);
  }
  return {};
}

/**
 * Save tokens to file
 * @param {Object} tokens - tokens object
 */
function saveTokens(tokens) {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
  } catch (error) {
    console.error('[TokenStorage] Error saving tokens:', error.message);
    throw error;
  }
}

/**
 * Get token for an API
 * @param {string} api - 'github' or 'confluence'
 * @returns {Object|null} token data or null if not found
 */
function getToken(api) {
  const tokens = loadTokens();
  if (tokens[api]) {
    try {
      // Decrypt stored token
      const decrypted = JSON.parse(JSON.stringify(tokens[api]));
      if (decrypted.token) {
        decrypted.token = decrypt(decrypted.token);
      }
      if (decrypted.apiToken) {
        decrypted.apiToken = decrypt(decrypted.apiToken);
      }
      if (decrypted.api_token) {
        decrypted.api_token = decrypt(decrypted.api_token);
      }
      if (decrypted.access_token) {
        decrypted.access_token = decrypt(decrypted.access_token);
      }
      if (decrypted.refresh_token) {
        decrypted.refresh_token = decrypt(decrypted.refresh_token);
      }
      return decrypted;
    } catch (error) {
      console.error(`[TokenStorage] Stored credentials for ${api} are in an old/incompatible format.`);
      console.error(`[TokenStorage] Auto-clearing corrupted token — you will be prompted to re-authenticate.`);
      // Auto-delete the bad token so the agent prompts for fresh credentials
      deleteToken(api);
      return null;
    }
  }
  return null;
}

/**
 * Store token for an API
 * @param {string} api - 'github' or 'confluence'
 * @param {Object} tokenData - token data to store
 */
function storeToken(api, tokenData) {
  const tokens = loadTokens();

  // Encrypt sensitive data
  const encrypted = JSON.parse(JSON.stringify(tokenData));
  if (encrypted.token) {
    encrypted.token = encrypt(encrypted.token);
  }
  if (encrypted.apiToken) {
    encrypted.apiToken = encrypt(encrypted.apiToken);
  }
  if (encrypted.api_token) {
    encrypted.api_token = encrypt(encrypted.api_token);
  }
  if (encrypted.access_token) {
    encrypted.access_token = encrypt(encrypted.access_token);
  }
  if (encrypted.refresh_token) {
    encrypted.refresh_token = encrypt(encrypted.refresh_token);
  }

  // Add metadata
  encrypted.stored_at = new Date().toISOString();

  tokens[api] = encrypted;
  saveTokens(tokens);

  console.log(`[TokenStorage] Token stored for ${api}`);
}

/**
 * Delete token for an API
 * @param {string} api - 'github' or 'confluence'
 */
function deleteToken(api) {
  const tokens = loadTokens();
  if (tokens[api]) {
    delete tokens[api];
    saveTokens(tokens);
    console.log(`[TokenStorage] Token deleted for ${api}`);
    return true;
  }
  return false;
}

/**
 * Check if token exists for an API
 * @param {string} api - 'github' or 'confluence'
 * @returns {boolean}
 */
function hasToken(api) {
  const tokens = loadTokens();
  return !!tokens[api];
}

/**
 * List all stored tokens (without exposing values)
 * @returns {Array} list of APIs with tokens
 */
function listTokens() {
  const tokens = loadTokens();
  return Object.keys(tokens).map(api => ({
    api,
    stored_at: tokens[api].stored_at,
    type: tokens[api].type || 'unknown',
  }));
}

module.exports = {
  getToken,
  storeToken,
  deleteToken,
  hasToken,
  listTokens,
};
