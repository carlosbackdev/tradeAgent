/**
 * users/user-registry.js
 * Controls who can access the bot and stores per-user configuration.
 * Admin invites users → users go through onboarding → users get their own bot instance.
 */

import { MongoClient } from 'mongodb';
import crypto from 'crypto';
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
    await _db.collection('users').dropIndex('telegram_id_1').catch(() => { });
    await _db.collection('users').dropIndex('telegram_id_sparse').catch(() => { });
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
  await _db.collection('users').createIndex(
    { invite_code: 1 },
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

  const inviteCode = crypto.randomBytes(16).toString('hex');

  await col.insertOne({
    telegram_username: username,
    invite_code: inviteCode,
    // telegram_id omitted intentionally — assigned when the user first messages the bot
    status: 'pending_invite',
    invited_by: invitedBy,
    invited_at: new Date(),
    config: {},
    onboarding_step: 0,
    created_at: new Date(),
    updated_at: new Date(),
  });

  return { ok: true, username, inviteCode };
}

export async function findUserByTelegramId(telegramId) {
  const db = await getDb();
  const idStr = String(telegramId);
  const user = await db.collection('users').findOne({ telegram_id: idStr });
  if (user) {
    // logger.debug(`User found by ID ${idStr}: @${user.telegram_username}`);
  }
  return user;
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
  const idStr = String(telegramId);

  // 1. Check if this telegramId is ALREADY linked to a user
  let user = await col.findOne({ telegram_id: idStr });
  if (user) {
    logger.info(`User ${idStr} already claimed as @${user.telegram_username} (status: ${user.status})`);
    return user;
  }

  // 2. Fallback: Match pending invite by username
  if (username) {
    // We look for ANY user with this username. 
    // If they are 'pending_invite' or 'pending_setup', we link them.
    user = await col.findOne({ telegram_username: username });

    if (user) {
      if (user.status === 'suspended') {
        logger.warn(`Attempt to claim invite by suspended user @${username}`);
        return user;
      }

      if (!user.telegram_id || user.status === 'pending_invite') {
        logger.info(`Linking new telegram_id ${idStr} to invited user @${username}`);
        await col.updateOne(
          { _id: user._id },
          {
            $set: {
              telegram_id: idStr,
              status: 'pending_setup',
              claimed_at: new Date(),
              updated_at: new Date(),
            }
          }
        );
        return { ...user, telegram_id: idStr, status: 'pending_setup' };
      }
    }
  }

  logger.warn(`No pending invite found for @${username} (ID: ${idStr})`);
  return null; // Not invited
}

export async function claimInviteByCode(telegramId, inviteCode, telegramUsername) {
  const db = await getDb();
  const col = db.collection('users');

  const normalizedCode = (inviteCode || '').trim();
  const idStr = String(telegramId);
  if (!normalizedCode) return null;

  // Find user by code regardless of status (unless they are already active/suspended by another ID)
  const user = await col.findOne({ invite_code: normalizedCode });
  if (!user) {
    logger.warn(`Invite code ${normalizedCode} not found in database`);
    return null;
  }

  // If already restricted
  if (user.status === 'suspended') {
    logger.warn(`Attempt to use invite code ${normalizedCode} by suspended user`);
    return user;
  }

  // If already claimed by ANOTHER ID
  if (user.telegram_id && user.telegram_id !== idStr) {
    logger.warn(`Invite code ${normalizedCode} already claimed by different ID: ${user.telegram_id}`);
    return null;
  }

  const normalizedUsername = (telegramUsername || user.telegram_username || '').replace('@', '').toLowerCase();

  // Update only if not already fully set up
  if (!user.telegram_id || user.status === 'pending_invite') {
    logger.info(`Claiming invite code ${normalizedCode} for ID ${idStr} (@${normalizedUsername})`);
    await col.updateOne(
      { _id: user._id },
      {
        $set: {
          telegram_id: idStr,
          telegram_username: normalizedUsername,
          status: 'pending_setup',
          claimed_at: new Date(),
          updated_at: new Date(),
        }
      }
    );
    return { ...user, telegram_id: idStr, telegram_username: normalizedUsername, status: 'pending_setup' };
  }

  return user;
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
