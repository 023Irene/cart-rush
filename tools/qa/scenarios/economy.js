/* Экономика: сколько очков приносит забег и как это соотносится с ценами магазина.

   Спека (5.8) требует пересчитывать цены каждый раз, когда меняется баланс сдачи
   или длина забега. После правок физики кузов держит вдвое больше коробок, а счёт
   растёт как (сумма ценностей) × (количество) — то есть квадратично от размера
   сдачи. Значит замер надо повторить.

   Запуск: node tools/qa/scenarios/economy.js [метка] */

const { launch, saveReport } = require('../harness');

const SEEDS = [101, 202, 303, 404, 505];
const label = process.argv[2] || 'current';

async function playOnce(seed, unloadAt) {
  const g = await launch({ seed });
  await g.startRun();
  const result = await g.playRun({ unloadAt, timeoutMs: 300000 });
  const errors = g.errors.slice(0, 3);
  await g.close();
  return { seed, unloadAt, ...result, errors };
}

function stats(rows) {
  const nums = key => rows.map(r => r[key]).filter(v => typeof v === 'number');
  const mean = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const sizes = rows.flatMap(r => r.sizes || []);
  return {
    runs: rows.length,
    score: Math.round(mean(nums('score'))),
    scoreMin: Math.min(...nums('score')),
    scoreMax: Math.max(...nums('score')),
    seconds: +(mean(nums('elapsed')) / 1000).toFixed(1),
    unloads: +mean(nums('unloads')).toFixed(1),
    avgUnloadSize: +mean(sizes).toFixed(1),
    maxUnloadSize: sizes.length ? Math.max(...sizes) : 0,
    dodges: +mean(nums('dodges')).toFixed(1),
    drops: +mean(nums('drops')).toFixed(1),
    misses: +mean(nums('misses')).toFixed(1),
    timedOut: rows.filter(r => r.timedOut).length
  };
}

// Сколько забегов нужно, чтобы скупить магазин при таком доходе
function progression(scorePerRun, prices) {
  const all = prices.flat().sort((a, b) => a - b);
  const total = all.reduce((a, b) => a + b, 0);
  let coins = 0;
  let runs = 0;
  const bought = [];
  while (bought.length < all.length && runs < 500) {
    runs++;
    coins += scorePerRun;
    while (bought.length < all.length && coins >= all[bought.length]) {
      coins -= all[bought.length];
      bought.push(runs);
    }
  }
  return { firstBuyAfterRun: bought[0] || null, allBoughtAfterRun: bought[bought.length - 1] || null, total };
}

async function main() {
  const rows = [];
  for (const seed of SEEDS) {
    process.stdout.write(`забег, сид ${seed}... `);
    const r = await playOnce(seed, 8);
    rows.push(r);
    console.log(`счёт ${r.score}, ${Math.round(r.elapsed / 1000)} с, сдач ${r.unloads}`);
  }

  // Контрольная группа: игрок, который сдаёт по 5 коробок — так играли до правок физики
  const cautious = [];
  for (const seed of SEEDS.slice(0, 3)) {
    process.stdout.write(`осторожный забег, сид ${seed}... `);
    const r = await playOnce(seed, 5);
    cautious.push(r);
    console.log(`счёт ${r.score}`);
  }

  const main8 = stats(rows);
  const main5 = stats(cautious);

  // Цены из спеки: пропорции × множитель. Считаем, каким множитель должен стать
  const proportions = [[500, 1500, 4000], [800, 2000, 5000], [1000, 3000]];
  const current = [[3000, 9000, 24000], [4800, 12000, 30000], [6000, 18000]];

  const now = progression(main8.score, current);
  // Цель дизайна из спеки: первая покупка после первого забега, весь магазин ~к десятому
  const proportionSum = proportions.flat().reduce((a, b) => a + b, 0);
  const wantedMultiplier = Math.round((main8.score * 10) / proportionSum);
  const proposed = proportions.map(line => line.map(v => v * wantedMultiplier));
  const after = progression(main8.score, proposed);

  const summary = {
    label,
    date: new Date().toISOString(),
    bot8: main8,
    bot5: main5,
    currentPrices: current,
    currentProgression: now,
    proportionSum,
    wantedMultiplier,
    proposedPrices: proposed,
    proposedProgression: after,
    errors: rows.flatMap(r => r.errors)
  };

  console.log(`\n=== экономика: ${label} ===`);
  console.log(`Бот, сдача по 8:  счёт ${main8.score} (${main8.scoreMin}-${main8.scoreMax}), забег ${main8.seconds} с, сдач ${main8.unloads} по ${main8.avgUnloadSize} коробки`);
  console.log(`  потери груза за борт ${main8.drops}, промахов ${main8.misses} за забег`);
  console.log(`Бот, сдача по 5:  счёт ${main5.score}, забег ${main5.seconds} с, потерь ${main5.drops}, промахов ${main5.misses}`);
  console.log(`Замер спеки был:  10 500 очков за 150-170 с`);
  console.log(`\nЦены сейчас (сумма ${now.total}): первая покупка после забега ${now.firstBuyAfterRun}, весь магазин к ${now.allBoughtAfterRun}-му`);
  console.log(`Цель: первая покупка после 1-го, весь магазин примерно к 10-му`);
  console.log(`Множитель к пропорциям спеки: было 6, нужно ${summary.wantedMultiplier}`);
  console.log(`Предлагаемые цены: ${JSON.stringify(proposed)}`);
  console.log(`С ними: первая покупка после ${after.firstBuyAfterRun}, весь магазин к ${after.allBoughtAfterRun}-му (сумма ${after.total})`);
  console.log(`забегов, упёршихся в таймаут: ${main8.timedOut}`);

  saveReport(`economy-${label}.json`, { summary, rows, cautious });
}

main().catch(e => { console.error(e); process.exit(1); });
