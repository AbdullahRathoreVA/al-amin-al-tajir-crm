/**
 * Backups from the command line.
 *
 *   npm run backup            take one now, and verify it
 *   npm run backup:list       what exists, and how old
 *   npm run backup:test       rehearse a restore without touching live data
 *   npm run backup:restore -- <file>   actually restore (asks first)
 */
import { connect } from '../db/index.ts';
import { migrateUp } from '../db/migrate.ts';
import { createBackup, listBackups, testRestore, restoreBackup, pruneBackups, newestBackup } from '../core/backup.ts';

const kb = (n: number) => `${Math.round(n / 1024)} kB`;

if (process.argv[1]?.endsWith('backup-cli.ts')) {
  await connect();
  migrateUp();
  const cmd = process.argv[2] ?? 'create';
  const arg = process.argv[3];

  try {
    if (cmd === 'list') {
      const all = listBackups();
      if (!all.length) {
        console.log('No backups yet. Take one with:  npm run backup');
      } else {
        console.log(`${all.length} backup(s):\n`);
        for (const b of all) {
          const age = b.ageHours < 24 ? `${b.ageHours}h ago` : `${Math.round(b.ageHours / 24)}d ago`;
          console.log(`  ${b.file}   ${kb(b.sizeBytes).padStart(9)}   ${age}`);
        }
      }
    } else if (cmd === 'create') {
      const r = createBackup();
      console.log(`Took ${r.path.split(/[\\/]/).pop()} (${kb(r.sizeBytes)})`);
      if (r.verify.ok) {
        console.log('Verified: integrity ok, row counts match live.');
        for (const [t, n] of Object.entries(r.verify.counts)) console.log(`  ${t.padEnd(14)} ${n}`);
      } else {
        console.error('VERIFICATION FAILED:');
        for (const p of r.verify.problems) console.error(`  ${p}`);
        process.exit(1);
      }
      const pruned = pruneBackups(14);
      if (pruned.length) console.log(`Pruned ${pruned.length} older than the last 14.`);
    } else if (cmd === 'test') {
      const file = arg ?? newestBackup()?.file;
      if (!file) { console.log('No backups to test.'); process.exit(1); }
      console.log(`Rehearsing a restore of ${file}. Nothing live is touched.\n`);
      const r = await testRestore(file);
      console.log(`  integrity: ${r.integrity}`);
      for (const [t, n] of Object.entries(r.counts)) {
        const live = r.liveCounts[t] ?? 0;
        console.log(`  ${t.padEnd(14)} backup ${String(n).padStart(6)}   live ${String(live).padStart(6)}`);
      }
      if (r.ok) {
        console.log('\nThis backup would restore. That is now a fact rather than an assumption.');
      } else {
        console.error('\nThis backup would NOT restore:');
        for (const p of r.problems) console.error(`  ${p}`);
        process.exit(1);
      }
    } else if (cmd === 'restore') {
      if (!arg) {
        console.log('Usage: npm run backup:restore -- <file>');
        console.log('Pick one from: npm run backup:list');
        process.exit(1);
      }
      if (!process.argv.includes('--yes')) {
        console.log(`This replaces the live database with ${arg}.`);
        console.log('The current database is copied aside first, automatically.');
        console.log('\nRe-run with --yes to go ahead:');
        console.log(`  npm run backup:restore -- ${arg} --yes`);
        process.exit(0);
      }
      const r = restoreBackup(arg);
      console.log(`Restored ${r.restored}.`);
      console.log(`The previous database was kept at:\n  ${r.safetyCopy}`);
      console.log('\nRestart the server now: it still holds the old file open.');
    } else {
      console.log('Commands: create | list | test | restore');
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  process.exit(0);
}
