/**
 * services/mongo/client.js
 * MongoDB connection lifecycle and collection initialization.
 */

import { MongoClient } from 'mongodb';
import { logger } from '../../utils/logger.js';
import { config } from '../../config/config.js';

let db = null;
let client = null;

async function initializeCollections() {
  try {
    const decisionsCollection = db.collection('decisions');
    await decisionsCollection.createIndex({ created_at: -1 });
    await decisionsCollection.createIndex({ symbol: 1 });
    await decisionsCollection.createIndex({ trigger: 1 });

    const ordersCollection = db.collection('orders');
    await ordersCollection.createIndex({ created_at: -1 });
    await ordersCollection.createIndex({ decision_id: 1 });
    await ordersCollection.createIndex({ symbol: 1 });
    await ordersCollection.createIndex({ status: 1 });

    const snapshotsCollection = db.collection('portfolio_snapshots');
    await snapshotsCollection.createIndex({ created_at: -1 });
  } catch (err) {
    logger.warn('Failed to initialize collections', err.message);
  }
}

export async function connectDB() {
  if (db) return db;

  const uri = config.mongodb.uri;
  const dbName = config.mongodb.dbName;

  try {
    client = new MongoClient(uri, {
      connectTimeoutMS: 5000,
      serverSelectionTimeoutMS: 5000,
    });

    await client.connect();
    db = client.db(dbName);
    await db.admin().ping();
    await initializeCollections();

    return db;
  } catch (err) {
    logger.error('MongoDB connection failed', err.message);
    throw new Error(`Database connection failed: ${err.message}`);
  }
}

export async function disconnectDB() {
  if (client) {
    await client.close();
    db = null;
    client = null;
    logger.info('Disconnected from MongoDB');
  }
}

export function getDB() {
  if (!db) {
    throw new Error('Database not connected. Call connectDB() first.');
  }
  return db;
}
