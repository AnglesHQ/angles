/**
 * Backfills `executionType` on existing builds and executions.
 *
 * The field defaults to 'automated' in the schema, so documents written before it existed
 * already *read back* correctly without this script. What they lack is the field on disk,
 * which means the { team, executionType, start } index cannot cover them and a query
 * filtering on executionType has to fall back to a broader index and discard most of what
 * it reads.
 *
 * Safe to run repeatedly: it only touches documents where the field is genuinely absent.
 *
 *   MONGO_URL=... node scripts/backfill-execution-type.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Build = require('../app/models/build.js');
const TestExecution = require('../app/models/execution.js');
const dbConfig = require('../config/database.config.js');

const mongoURL = process.env.MONGO_URL || dbConfig.url;

mongoose.set('strictQuery', false);
mongoose.connect(mongoURL, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(async () => {
  console.log('Connected to database.');

  const buildResult = await Build.updateMany(
    { executionType: { $exists: false } },
    { $set: { executionType: 'automated' } },
  ).exec();
  // modifiedCount on the modern driver, nModified on older ones.
  const modified = (result) => (result.modifiedCount === undefined
    ? result.nModified || 0
    : result.modifiedCount);
  console.log(`Builds updated: ${modified(buildResult)}`);

  const executionResult = await TestExecution.updateMany(
    { executionType: { $exists: false } },
    { $set: { executionType: 'automated' } },
  ).exec();
  console.log(`Executions updated: ${modified(executionResult)}`);

  await mongoose.disconnect();
  console.log('Done.');
  process.exit(0);
}).catch((error) => {
  console.error('Backfill failed:', error.message);
  process.exit(1);
});
