/* Доход по уровням улучшений: сколько монет приносит забег на каждом шаге покупок.

   Зачем. `progression()` в economy.js считает, за сколько забегов игрок скупит магазин,
   и до сих пор делал это на выдуманном допущении: доход либо постоянный, либо растёт
   на 15 % с покупки. На деле каждая покупка поднимает доход по-своему — высокие борта
   держат больше груза, аккумулятор удлиняет забег, подвеска бережёт штабель на переезде.
   Здесь эта кривая замеряется, а не угадывается.

   Порядок покупок берётся тот же, что у progression(): все цены по возрастанию. Внутри
   каждого улучшения уровни идут по порядку сами собой, потому что его цены растут.

   Запуск: node tools/qa/scenarios/upgrades.js [метка] [сидов] [секунд на забег]
   Отчёт: reports/upgrades-<метка>.json */

const { launch, saveReport } = require('../harness');

const label = process.argv[2] || 'current';
const ALL_SEEDS = [101, 202, 303];
const SEEDS = ALL_SEEDS.slice(0, Number(process.argv[3]) || 2);
const RUN_MS = (Number(process.argv[4]) || 150) * 1000;

// Замеряем не каждую из восьми покупок, а пять точек: пустой магазин, четверть,
// половина, три четверти и полный. Восемь точек стоили бы вдвое дороже по времени,
// а кривая между соседними шагами всё равно интерполируется
const CHECKPOINTS = [0, 2, 4, 6, 8];

const EMPTY_SAVE = {
  bestScore: 0,
  currency: 0,
  upgrades: { walls: 0, battery: 0, suspension: 0 },
  volume: 0.6,
  muted: true
};

// Порядок покупок по возрастанию цены — ровно так их считает progression()
function purchaseOrder(shop) {
  const rows = [];
  shop.order.forEach(key => {
    shop[key].prices.forEach((price, index) => rows.push({ key, price, level: index + 1 }));
  });
  return rows.sort((a, b) => a.price - b.price);
}

function upgradesAfter(order, bought) {
  const up = { walls: 0, battery: 0, suspension: 0 };
  for (let i = 0; i < bought; i++) up[order[i].key]++;
  return up;
}

// Один забег с заданными улучшениями. Условия воспроизводимости те же, что в
// economy.js: фиксированный шаг, пересев в create() сцены, бот на игровой сетке
async function playOnce(seed, upgrades) {
  const save = Object.assign({}, EMPTY_SAVE, { upgrades });
  const g = await launch({ seed, save });
  await g.fixedStep({ rate: 8 });
  await g.armSeed(seed);
  await g.startRun();
  const r = await g.playRun({ unloadAt: 8, timeoutMs: RUN_MS });
  const errors = g.errors.slice(0, 3);
  await g.close();
  return { seed, ...r, errors };
}

const mean = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

async function main() {
  // Цены читаем из игры, а не дублируем: иначе после правки CONFIG.shop сценарий
  // молча начнёт мерить не тот порядок покупок
  const probe = await launch({ seed: 1 });
  const shop = await probe.shopSpec();
  await probe.close();

  const order = purchaseOrder(shop);
  console.log('порядок покупок: ' + order.map(o => `${o.key}${o.level} (${o.price})`).join(' → '));

  const points = [];
  for (const bought of CHECKPOINTS) {
    const upgrades = upgradesAfter(order, bought);
    const rows = [];
    for (const seed of SEEDS) {
      process.stdout.write(`покупок ${bought} (борта ${upgrades.walls}, батарея ` +
        `${upgrades.battery}, подвеска ${upgrades.suspension}), сид ${seed}... `);
      const r = await playOnce(seed, upgrades);
      rows.push(r);
      console.log(`монет ${r.coins}, счёт ${r.score}, ${Math.round(r.elapsed / 1000)} с`);
    }
    const coins = Math.round(mean(rows.map(r => r.coins)));
    const seconds = +(mean(rows.map(r => r.elapsed)) / 1000).toFixed(1);

    points.push({
      bought,
      upgrades,
      coins,
      score: Math.round(mean(rows.map(r => r.score))),
      seconds,

      // Разложение роста на две части. Улучшения могут поднимать доход двумя
      // разными способами: удлинять забег (аккумулятор) или делать каждую его
      // секунду богаче (борта и подвеска берегут груз). Без этого числа обе
      // причины сливаются в одну и непонятно, что именно покупает игрок
      coinsPerSecond: seconds ? +(coins / seconds).toFixed(2) : 0,
      unloads: +mean(rows.map(r => r.unloads)).toFixed(1),
      drops: +mean(rows.map(r => r.drops)).toFixed(1),
      errors: rows.flatMap(r => r.errors)
    });
  }

  const base = points[0].coins || 1;
  const full = points[points.length - 1].coins;

  // Средний рост на одну покупку, выведенный из замера: во сколько раз доход
  // умножается за каждую из восьми покупок, если считать рост равномерным
  const perPurchase = base > 0 && full > 0
    ? Math.pow(full / base, 1 / CHECKPOINTS[CHECKPOINTS.length - 1])
    : 1;

  const summary = {
    label,
    date: new Date().toISOString(),
    seeds: SEEDS,
    runSeconds: RUN_MS / 1000,
    order: order.map(o => `${o.key}${o.level}`),
    points,
    baseCoins: base,
    fullCoins: full,
    totalGrowth: +(full / base).toFixed(3),
    growthPerPurchase: +perPurchase.toFixed(4),
    errors: points.flatMap(p => p.errors)
  };

  console.log(`\n=== доход по уровням улучшений: ${label} ===`);
  points.forEach(p => {
    const delta = p.coins - base;
    console.log(`покупок ${String(p.bought).padStart(2)}: ${String(p.coins).padStart(5)} монет ` +
      `(${delta >= 0 ? '+' : ''}${Math.round((p.coins / base - 1) * 100)} % к пустому), ` +
      `забег ${p.seconds} с, ${p.coinsPerSecond} монет/с, сдач ${p.unloads}, потерь ${p.drops}`);
  });
  console.log(`\nПолный магазин поднимает доход в ${summary.totalGrowth} раза`);
  console.log(`Это ${summary.growthPerPurchase} за покупку — его и надо подставлять` +
    ` в progression() вместо выдуманных 15 %`);
  console.log(`ошибок в консоли: ${summary.errors.length}`);

  saveReport(`upgrades-${label}.json`, summary);
}

main();
