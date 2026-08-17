/* Аномалия S2: в покое в кузове изредка становится БОЛЬШЕ коробок, чем поставили.
   Гипотеза: rampDifficulty() каждые 15 с делает spawnTimer.reset(), а Phaser в
   reset() перечитывает paused из конфига (по умолчанию false) — пауза спавна,
   поставленная harness'ом, снимается сама.

   Запуск: node tools/qa/scenarios/anomaly.js [метка] */

const { launch, saveReport } = require('../harness');

const SEEDS = [33, 44, 11];
const label = process.argv[2] || 'spawn-pause';

async function runSeed(seed) {
  const g = await launch({ seed });
  await g.startRun();
  await g.pauseSpawn(true);
  await g.freezeXp(true);
  await g.clearCargo();
  await g.stack('medium', 10);
  await g.wait(900);
  await g.clearFalling();

  const timeline = [];
  const probe = async () => {
    const s = await g.state();
    const t = await g.eval(() => {
      const sc = window.__qa.scene();
      return {
        spawnPaused: sc.spawnTimer.paused,
        boosterPaused: sc.boosterTimer.paused,
        lastRamp: Math.round(sc.run.lastRamp),
        interval: Math.round(sc.run.spawnInterval)
      };
    });
    timeline.push({ elapsed: s.elapsed, cargo: s.cargo.length, falling: s.falling, ...t });
  };

  await probe();
  for (let i = 0; i < 12; i++) { await g.wait(2000); await probe(); }

  const out = { seed, timeline, errors: g.errors.slice(0, 5) };
  await g.close();
  return out;
}

async function main() {
  const rows = [];
  for (const seed of SEEDS) {
    process.stdout.write(`сид ${seed}... `);
    rows.push(await runSeed(seed));
    console.log('готово');
  }

  console.log(`\n=== аномалия спавна: ${label} ===`);
  for (const r of rows) {
    const first = r.timeline[0];
    const last = r.timeline[r.timeline.length - 1];
    const unpaused = r.timeline.find(t => !t.spawnPaused);
    console.log(`сид ${r.seed}: груз ${first.cargo} -> ${last.cargo}, ` +
      `пауза спавна снялась на ${unpaused ? unpaused.elapsed + ' мс' : 'НЕТ'}`);
  }
  saveReport(`anomaly-${label}.json`, { label, date: new Date().toISOString(), rows });
}

main().catch(e => { console.error(e); process.exit(1); });
