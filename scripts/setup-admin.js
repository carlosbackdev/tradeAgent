#!/usr/bin/env node
/**
 * scripts/setup-admin.js
 * One-time setup: creates the admin user record in MongoDB.
 * Run this after setting ADMIN_TELEGRAM_ID in .env
 *
 * Usage: node scripts/setup-admin.js
 */

import 'dotenv/config';
import { MongoClient } from 'mongodb';

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB;

if (!ADMIN_ID) {
  console.error('❌ ADMIN_TELEGRAM_ID no está configurado en .env');
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI, { connectTimeoutMS: 5000 });

try {
  await client.connect();
  const db = client.db(MONGODB_DB);
  const col = db.collection('users');

  await col.createIndex({ telegram_id: 1 }, { unique: true });
  await col.createIndex({ telegram_username: 1 });

  const existing = await col.findOne({ telegram_id: String(ADMIN_ID) });
  if (existing) {
    console.log(`✅ Admin ya existe: @${existing.telegram_username || '(sin username)'} (${ADMIN_ID})`);
    console.log(`   Estado: ${existing.status}`);
  } else {
    await col.insertOne({
      telegram_id: String(ADMIN_ID),
      telegram_username: 'admin',
      status: 'active',
      invited_by: 'system',
      invited_at: new Date(),
      claimed_at: new Date(),
      config: {},
      onboarding_step: 6,
      is_admin: true,
      created_at: new Date(),
      updated_at: new Date(),
    });
    console.log(`✅ Admin creado con ID: ${ADMIN_ID}`);
  }

  console.log('\n📋 Próximos pasos:');
  console.log('   1. Asegúrate de que MULTI_USER_MODE=true en .env');
  console.log('   2. Inicia el bot: npm start');
  console.log('   3. En Telegram, envía /invite @username para invitar usuarios');
  console.log('   4. El usuario invitado verá el asistente de configuración al abrir el bot\n');

} catch (err) {
  console.error('❌ Error:', err.message);
  process.exit(1);
} finally {
  await client.close();
}
