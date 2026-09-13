/**
 * generate-qr.js  —  Admin script to generate a batch of QR codes in MongoDB
 *
 * Usage:
 *   node generate-qr.js [PREFIX] [COUNT]
 *
 * Examples:
 *   node generate-qr.js CD 500     → generates 500 codes like CD-A3XK-7P2M
 *   node generate-qr.js            → generates 100 codes with default prefix CD
 */

'use strict';

require('dotenv').config();
const mongoose    = require('mongoose');
const { QRCodeModel } = require('./models');

const PREFIX = (process.argv[2] || 'CD').toUpperCase();
const COUNT  = parseInt(process.argv[3] || '100', 10);

// No confusing characters (removed O, 0, I, 1)
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rand  = (n) => Array.from({ length: n }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');

async function main() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`✅ Connected. Generating ${COUNT} codes with prefix "${PREFIX}"...`);

  const batchId = Date.now().toString(36).toUpperCase();
  const codes   = new Set();

  while (codes.size < COUNT) {
    codes.add(`${PREFIX}-${rand(4)}-${rand(4)}`);
  }

  const docs = [...codes].map(code => ({ code, batchId, status: 'UNACTIVATED' }));

  try {
    const result = await QRCodeModel.insertMany(docs, { ordered: false });
    console.log(`\n✅ SUCCESS — Generated ${result.length} unique QR codes`);
    console.log(`   Batch ID   : ${batchId}`);
    console.log(`   Sample Code: ${docs[0].code}`);
    console.log(`   Scan URL   : ${process.env.DOMAIN}/scan/${docs[0].code}`);
    console.log(`\n💡 Print these codes on stickers. Users activate via the app.\n`);
  } catch (err) {
    console.error('❌ Error (duplicates skipped):', err.message);
  }

  await mongoose.disconnect();
  console.log('Disconnected. Done!');
}

main().catch(console.error);
