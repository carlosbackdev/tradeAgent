/**
 * revolut/client.js
 * Authenticated HTTP client for Revolut X REST API.
 * Uses Ed25519 signatures per the Revolut X auth spec.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

export class RevolutClient {
  constructor() {
    this.baseUrl = process.env.REVOLUT_BASE_URL;
    this.apiKey = process.env.REVOLUT_API_KEY;
    this.debugApi = process.env.DEBUG_API === 'true';

    const keyPath = path.resolve(process.env.REVOLUT_PRIVATE_KEY_PATH);
    if (!fs.existsSync(keyPath)) {
      throw new Error(`Private key not found at: ${keyPath}\nRun: npm run gen-keys`);
    }

    try {
      this.privateKeyPem = fs.readFileSync(keyPath, 'utf8');
    } catch (err) {
      throw new Error(`Failed to read private key: ${err.message}`);
    }

    if (!this.privateKeyPem.includes('PRIVATE KEY')) {
      throw new Error(`Invalid private key format at: ${keyPath}`);
    }

    logger.debug(`RevolutClient initialized with base URL: ${this.baseUrl}`);
  }

  /**
   * Sign the request message with Ed25519 private key.
   * Message format: {timestamp}{METHOD}{path}{queryString}{body}
   */
  _sign(timestamp, method, urlPath, query = '', body = '') {
    const message = `${timestamp}${method}${urlPath}${query}${body}`;
    
    try {
      const signature = crypto.sign(null, Buffer.from(message), this.privateKeyPem);
      return signature.toString('base64');
    } catch (err) {
      throw new Error(`Failed to sign request: ${err.message}`);
    }
  }

  /**
   * Core request method — builds auth headers, signs, fires.
   */
  async request(method, endpoint, { params = {}, body = null } = {}, retries = 3) {
    const timestamp = Date.now().toString();
    const urlPath = `/api/1.0${endpoint}`;

    const queryString = Object.keys(params).length
      ? new URLSearchParams(params).toString()
      : '';

    const bodyStr = body ? JSON.stringify(body) : '';
    
    try {
      const signature = this._sign(timestamp, method.toUpperCase(), urlPath, queryString, bodyStr);

      const url = `${this.baseUrl}${urlPath}${queryString ? `?${queryString}` : ''}`;

      const headers = {
        'Content-Type': 'application/json',
        'X-Revx-Api-Key': this.apiKey,
        'X-Revx-Timestamp': timestamp,
        'X-Revx-Signature': signature,
      };

      if (this.debugApi) {
        logger.debug(`[API Request]`, {
          method: method.toUpperCase(),
          endpoint,
          url,
          timestamp,
          signatureLen: signature.length,
          headers: {
            'Content-Type': 'application/json',
            'X-Revx-Api-Key': this.apiKey?.substring(0, 10) + '...',
            'X-Revx-Timestamp': timestamp,
            'X-Revx-Signature': signature.substring(0, 30) + '...',
          }
        });
      }

      const res = await fetch(url, {
        method: method.toUpperCase(),
        headers,
        body: bodyStr || undefined,
        timeout: 30000, // 30 second timeout
      });

      const text = await res.text();

      if (!res.ok) {
        // Retry on 5xx errors (server errors)
        if (res.status >= 500 && retries > 0) {
          logger.warn(`API ${res.status}, retrying... (${retries} left)`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          return this.request(method, endpoint, { params, body }, retries - 1);
        }

        const errorMsg = text ? `${res.status}: ${text}` : `HTTP ${res.status}`;
        throw new Error(`[${method}] ${endpoint} → ${errorMsg}`);
      }

      if (this.debugApi && text) {
        logger.debug(`[API Response] ${method.toUpperCase()} ${endpoint}`, text.substring(0, 500));
      }

      const parsed = text ? JSON.parse(text) : null;
      
      // Special logging for order responses
      if (method.toUpperCase() === 'POST' && endpoint.includes('/orders')) {
        logger.info(`✅ Order API Response: Status ${res.status}`, JSON.stringify(parsed).substring(0, 300));
      }

      return parsed;
    } catch (err) {
      logger.error(`Request failed: ${method} ${endpoint}`, err.message);
      throw err;
    }
  }

  get(endpoint, params) { return this.request('GET', endpoint, { params }); }
  post(endpoint, body)   { return this.request('POST', endpoint, { body }); }
  delete(endpoint)       { return this.request('DELETE', endpoint); }
}
