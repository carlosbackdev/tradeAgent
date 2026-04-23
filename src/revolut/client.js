/**
 * revolut/client.js
 * Authenticated HTTP client for Revolut X REST API.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';

let clockOffsetMs = 0;

function getAdjustedTimestamp() {
  return (Date.now() + clockOffsetMs - 500).toString();
}

function updateClockOffset(serverTimestampMs) {
  const localNow = Date.now();
  clockOffsetMs = serverTimestampMs - localNow;
  logger.info(`🕐 Clock offset updated: ${clockOffsetMs > 0 ? '+' : ''}${clockOffsetMs}ms`);
}

export class RevolutClient {
  constructor(userConfig = null) {
    this.config = userConfig || config;
    const revConfig = this.config.revolut || config.revolut;
    const debugConfig = this.config.debug || config.debug;

    this.baseUrl = revConfig.baseUrl;
    this.apiKey = revConfig.apiKey || revConfig.REVOLUT_API_KEY;
    this.debugApi = debugConfig.debugApi;

    if (!this.apiKey) {
      throw new Error('Missing Revolut API Key');
    }

    // Support both file path (single user) and direct PEM string (multi user)
    const privateKey = (revConfig.privateKeyPem || revConfig.REVOLUT_PRIVATE_KEY_PEM);

    if (privateKey && privateKey.includes('PRIVATE KEY')) {
      this.privateKeyPem = privateKey;
    } else {
      const keyPath = path.resolve(revConfig.privateKeyPath || '');
      if (!fs.existsSync(keyPath)) {
        throw new Error(`Private key not found at: ${keyPath}`);
      }
      this.privateKeyPem = fs.readFileSync(keyPath, 'utf8');
    }

    if (!this.privateKeyPem.includes('PRIVATE KEY')) {
      throw new Error('Invalid private key format');
    }
  }

  _sign(timestamp, method, urlPath, query = '', body = '') {
    const message = `${timestamp}${method}${urlPath}${query}${body}`;
    const signature = crypto.sign(null, Buffer.from(message), this.privateKeyPem);
    return signature.toString('base64');
  }

  async request(method, endpoint, { params = {}, body = null } = {}, retries = 3) {
    const cleanedParams = Object.fromEntries(
      Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
    );

    const timestamp = getAdjustedTimestamp();
    const urlPath = `/api/1.0${endpoint}`;
    const queryString = Object.keys(cleanedParams).length
      ? new URLSearchParams(cleanedParams).toString()
      : '';

    const bodyStr = body ? JSON.stringify(body) : '';
    const signature = this._sign(timestamp, method.toUpperCase(), urlPath, queryString, bodyStr);
    const url = `${this.baseUrl}${urlPath}${queryString ? `?${queryString}` : ''}`;

    const headers = {
      'Content-Type': 'application/json',
      'X-Revx-Api-Key': this.apiKey,
      'X-Revx-Timestamp': timestamp,
      'X-Revx-Signature': signature,
    };

    if (this.debugApi) {
      logger.debug(`[API] ${method.toUpperCase()} ${endpoint}`, {
        timestamp,
        queryString,
        bodyPreview: bodyStr.slice(0, 300),
      });
    }

    let res;
    let text;

    try {
      res = await fetch(url, {
        method: method.toUpperCase(),
        headers,
        body: bodyStr || undefined,
      });
      text = await res.text();
    } catch (err) {
      throw new Error(`Network error: ${err.message}`);
    }

    if (res.status === 409) {
      let errBody = {};
      try { errBody = JSON.parse(text); } catch { }

      if (errBody.timestamp && String(errBody.message || '').toLowerCase().includes('timestamp')) {
        logger.warn(`⏰ Clock skew detected. Server timestamp: ${errBody.timestamp}. Retrying...`);
        updateClockOffset(errBody.timestamp);
        return this.request(method, endpoint, { params: cleanedParams, body }, 0);
      }
    }

    if (res.status >= 500 && retries > 0) {
      logger.warn(`API ${res.status}, retrying... (${retries} left)`);
      await new Promise(r => setTimeout(r, 1000));
      return this.request(method, endpoint, { params: cleanedParams, body }, retries - 1);
    }

    if (!res.ok) {
      throw new Error(`[${method.toUpperCase()}] ${endpoint} -> ${res.status}: ${text}`);
    }

    return text ? JSON.parse(text) : null;
  }

  get(endpoint, params) {
    return this.request('GET', endpoint, { params });
  }

  post(endpoint, body) {
    return this.request('POST', endpoint, { body });
  }

  delete(endpoint, params) {
    return this.request('DELETE', endpoint, { params });
  }
}