'use strict';
require('dotenv').config();
const { ensureConnected, disconnect } = require('../src/config/db');
const User = require('../src/models/User');
const  dns = require('node:dns');

dns.setServers(['1.1.1.1', '1.0.0.1']); // Forces Cloudflare DNS
(async () => {
  try {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is missing from .env');
    if (!await ensureConnected(true)) throw new Error('Could not connect to MongoDB Atlas');
    for (const name of ['Saifullah', 'Hizbullah']) {
      const result = await User.updateOne(
        { name }, { $setOnInsert: { name, createdAt: new Date() } }, { upsert: true }
      );
      console.log(`${name}: ${result.upsertedCount ? 'created' : 'already existed'}`);
    }
  } catch (error) {
    console.error(`Seed failed: ${error.message}`);
    process.exitCode = 1;
  } finally { await disconnect(); }
})();
