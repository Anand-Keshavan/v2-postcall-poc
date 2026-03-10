/**
 * OAuth 2.0 Helper Module
 * Handles authorization code flow for GitHub and Confluence
 */

const axios = require('axios');
const { config } = require('../config');

/**
 * Generate authorization URL for OAuth flow
 * @param {string} api - 'github' or 'confluence'
 * @param {string} state - CSRF protection state parameter
 * @returns {string} authorization URL
 */
function getAuthorizationUrl(api, state) {
  if (api === 'github') {
    const params = new URLSearchParams({
      client_id: config.github.clientId,
      redirect_uri: config.github.redirectUri,
      scope: config.github.scopes.join(' '),
      state: state,
    });
    return `${config.github.authUrl}?${params.toString()}`;
  }

  if (api === 'confluence') {
    const params = new URLSearchParams({
      audience: 'api.atlassian.com',
      client_id: config.confluence.clientId,
      scope: config.confluence.scopes.join(' '),
      redirect_uri: config.confluence.redirectUri,
      state: state,
      response_type: 'code',
      prompt: 'consent',
    });
    return `${config.confluence.authUrl}?${params.toString()}`;
  }

  throw new Error(`Unknown API: ${api}`);
}

/**
 * Exchange authorization code for access token
 * @param {string} api - 'github' or 'confluence'
 * @param {string} code - Authorization code from callback
 * @returns {Promise<Object>} token response
 */
async function exchangeCodeForToken(api, code) {
  if (api === 'github') {
    try {
      const response = await axios.post(
        config.github.tokenUrl,
        {
          client_id: config.github.clientId,
          client_secret: config.github.clientSecret,
          code: code,
          redirect_uri: config.github.redirectUri,
        },
        {
          headers: {
            Accept: 'application/json',
          },
        }
      );

      if (response.data.error) {
        throw new Error(`GitHub OAuth error: ${response.data.error_description || response.data.error}`);
      }

      return {
        access_token: response.data.access_token,
        token_type: response.data.token_type,
        scope: response.data.scope,
        // GitHub tokens don't expire by default, but can have expiration if configured
        expires_at: null,
        refresh_token: null, // GitHub doesn't provide refresh tokens in standard flow
      };
    } catch (error) {
      if (error.response) {
        throw new Error(`GitHub token exchange failed: ${error.response.data.error_description || error.message}`);
      }
      throw error;
    }
  }

  if (api === 'confluence') {
    try {
      const response = await axios.post(
        config.confluence.tokenUrl,
        {
          grant_type: 'authorization_code',
          client_id: config.confluence.clientId,
          client_secret: config.confluence.clientSecret,
          code: code,
          redirect_uri: config.confluence.redirectUri,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      // Calculate token expiration time
      const expiresIn = response.data.expires_in || 3600; // Default 1 hour
      const expiresAt = Date.now() + expiresIn * 1000;

      return {
        access_token: response.data.access_token,
        token_type: response.data.token_type,
        scope: response.data.scope,
        expires_at: expiresAt,
        expires_in: expiresIn,
        refresh_token: response.data.refresh_token,
      };
    } catch (error) {
      if (error.response) {
        throw new Error(`Confluence token exchange failed: ${error.response.data.error_description || error.message}`);
      }
      throw error;
    }
  }

  throw new Error(`Unknown API: ${api}`);
}

/**
 * Refresh an expired access token
 * @param {string} api - 'github' or 'confluence'
 * @param {string} refreshToken - Refresh token
 * @returns {Promise<Object>} new token response
 */
async function refreshAccessToken(api, refreshToken) {
  if (api === 'github') {
    // GitHub tokens don't expire in standard OAuth apps
    throw new Error('GitHub tokens do not support refresh');
  }

  if (api === 'confluence') {
    try {
      const response = await axios.post(
        config.confluence.tokenUrl,
        {
          grant_type: 'refresh_token',
          client_id: config.confluence.clientId,
          client_secret: config.confluence.clientSecret,
          refresh_token: refreshToken,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      const expiresIn = response.data.expires_in || 3600;
      const expiresAt = Date.now() + expiresIn * 1000;

      return {
        access_token: response.data.access_token,
        token_type: response.data.token_type,
        scope: response.data.scope,
        expires_at: expiresAt,
        expires_in: expiresIn,
        refresh_token: response.data.refresh_token || refreshToken, // Use new refresh token if provided
      };
    } catch (error) {
      if (error.response) {
        throw new Error(`Confluence token refresh failed: ${error.response.data.error_description || error.message}`);
      }
      throw error;
    }
  }

  throw new Error(`Unknown API: ${api}`);
}

/**
 * Get accessible Confluence resources (sites/cloud IDs)
 * @param {string} accessToken - Confluence access token
 * @returns {Promise<Array>} list of accessible resources
 */
async function getConfluenceResources(accessToken) {
  try {
    const response = await axios.get(config.confluence.resourcesUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    return response.data.map(resource => ({
      id: resource.id,
      name: resource.name,
      url: resource.url,
      scopes: resource.scopes,
      avatarUrl: resource.avatarUrl,
    }));
  } catch (error) {
    if (error.response) {
      throw new Error(`Failed to get Confluence resources: ${error.response.data.message || error.message}`);
    }
    throw error;
  }
}

/**
 * Check if token is expired
 * @param {Object} tokenData - Token data with expires_at
 * @returns {boolean} true if expired or about to expire
 */
function isTokenExpired(tokenData) {
  if (!tokenData || !tokenData.expires_at) {
    return false; // No expiration set (like GitHub)
  }

  // Consider token expired if it expires in less than 5 minutes
  const buffer = 5 * 60 * 1000; // 5 minutes in milliseconds
  return Date.now() >= (tokenData.expires_at - buffer);
}

/**
 * Get valid access token, refreshing if necessary
 * @param {string} api - 'github' or 'confluence'
 * @param {Object} tokenData - Current token data
 * @returns {Promise<Object>} valid token data
 */
async function getValidToken(api, tokenData) {
  if (!tokenData || !tokenData.access_token) {
    throw new Error('No token data available - authentication required');
  }

  // If token is not expired, return as-is
  if (!isTokenExpired(tokenData)) {
    return tokenData;
  }

  // Token is expired, try to refresh
  if (!tokenData.refresh_token) {
    throw new Error('Token expired and no refresh token available - re-authentication required');
  }

  console.log(`[OAuth] Token expired for ${api}, refreshing...`);
  const newToken = await refreshAccessToken(api, tokenData.refresh_token);
  console.log(`[OAuth] Token refreshed successfully for ${api}`);

  return newToken;
}

module.exports = {
  getAuthorizationUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  getConfluenceResources,
  isTokenExpired,
  getValidToken,
};
