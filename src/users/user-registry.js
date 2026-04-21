/**
 * users/user-registry.js
 * Controls who can access the bot and stores per-user configuration.
 * Admin invites users → users go through onboarding → users get their own bot instance.
 */

import { MongoClient } from 'mongodb';
import { logger } from '../utils/logger.js';

let _db = null;

async function getDb() {
  if (_db) return _db;
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
  const client = new MongoClient(uri, { connectTimeoutMS: 5000, serverSelectionTimeoutMS: 5000 });
  await client.connect();
  _db = client.db(process.env.MONGODB_DB || 'revolut-trading-agent');

  // telegram_id: partial index — only indexes documents where telegram_id is a real string.
  // Pending-invite users have no telegram_id field, so they are excluded from the index
  // entirely, allowing unlimited pending invitations without key conflicts.
  try {
    await _db.collection('users').dropIndex('telegram_id_1').catch(() => {});
    await _db.collection('users').dropIndex('telegram_id_sparse').catch(() => {});
  } catch { /* ignore */ }

  await _db.collection('users').createIndex(
    { telegram_id: 1 },
    {
      unique: true,
      partialFilterExpression: { telegram_id: { $type: 'string' } },
      name: 'telegram_id_unique'
    }
  );
  await _db.collection('users').createIndex(
    { telegram_username: 1 },
    { unique: true, sparse: true }
  );
  await _db.collection('users').createIndex({ status: 1 });

  return _db;
}

/**
 * User statuses:
 *   'pending_invite'  - Admin invited by username, user hasn't messaged yet
 *   'pending_setup'   - User messaged, needs to complete onboarding
 *   'active'          - Fully configured and operational
 *   'suspended'       - Admin suspended access
 */

export async function inviteUser({ telegramUsername, invitedBy }) {
  const db = await getDb();
  const col = db.collection('users');

  const username = telegramUsername.replace('@', '').toLowerCase();
  const existing = await col.findOne({ telegram_username: username });
  if (existing) {
    return { ok: false, reason: `@${username} already exists (status: ${existing.status})` };
  }

  await col.insertOne({
    telegram_username: username,
    // telegram_id omitted intentionally — assigned when the user first messages the bot
    status: 'pending_invite',
    invited_by: invitedBy,
    invited_at: new Date(),
    config: {},
    onboarding_step: 0,
    created_at: new Date(),
    updated_at: new Date(),
  });

  return { ok: true, username };
}

export async function findUserByTelegramId(telegramId) {
  const db = await getDb();
  return db.collection('users').findOne({ telegram_id: String(telegramId) });
}

export async function findUserByUsername(username) {
  const db = await getDb();
  const u = username.replace('@', '').toLowerCase();
  return db.collection('users').findOne({ telegram_username: u });
}

export async function claimInvite(telegramId, telegramUsername) {
  const db = await getDb();
  const col = db.collection('users');

  const username = (telegramUsername || '').replace('@', '').toLowerCase();

  // Check by telegram_id first (returning user)
  let user = await col.findOne({ telegram_id: String(telegramId) });
  if (user) return user;

  // Match pending invite by username
  if (username) {
    user = await col.findOne({ telegram_username: username, status: 'pending_invite' });
    if (user) {
      await col.updateOne(
        { _id: user._id },
        {
          $set: {
            telegram_id: String(telegramId),
            status: 'pending_setup',
            claimed_at: new Date(),
            updated_at: new Date(),
          }
        }
      );
      return { ...user, telegram_id: String(telegramId), status: 'pending_setup' };
    }
  }

  return null; // Not invited
}

export async function updateUserConfig(telegramId, configPatch) {
  const db = await getDb();
  const updateFields = {};
  for (const [k, v] of Object.entries(configPatch)) {
    updateFields[`config.${k}`] = v;
  }
  updateFields.updated_at = new Date();

  await db.collection('users').updateOne(
    { telegram_id: String(telegramId) },
    { $set: updateFields }
  );
}

export async function setUserStatus(telegramId, status) {
  const db = await getDb();
  await db.collection('users').updateOne(
    { telegram_id: String(telegramId) },
    { $set: { status, updated_at: new Date() } }
  );
}

export async function setOnboardingStep(telegramId, step) {
  const db = await getDb();
  await db.collection('users').updateOne(
    { telegram_id: String(telegramId) },
    { $set: { onboarding_step: step, updated_at: new Date() } }
  );
}

export async function listUsers() {
  const db = await getDb();
  return db.collection('users')
    .find({})
    .sort({ created_at: -1 })
    .project({ telegram_id: 1, telegram_username: 1, status: 1, invited_at: 1, 'config.TRADING_PAIRS': 1 })
    .toArray();
}

export async function revokeUser(telegramIdOrUsername) {
  const db = await getDb();
  const col = db.collection('users');

  let user;
  if (/^\d+$/.test(String(telegramIdOrUsername))) {
    user = await col.findOne({ telegram_id: String(telegramIdOrUsername) });
  } else {
    const u = telegramIdOrUsername.replace('@', '').toLowerCase();
    user = await col.findOne({ telegram_username: u });
  }

  if (!user) return { ok: false, reason: 'User not found' };

  await col.updateOne({ _id: user._id }, { $set: { status: 'suspended', updated_at: new Date() } });
  return { ok: true, username: user.telegram_username };
}
