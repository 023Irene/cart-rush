/* Экономика: сколько очков приносит забег и как это соотносится с ценами магазина.

   Спека (5.8) требует пересчитывать цены каждый раз, когда меняется баланс сдачи
   или длина забега. После правок физики кузов держит вдвое больше коробок, а счёт
   растёт как (сумма ценностей) × (количество) — то есть квадратично от размера
   сдачи. Значит замер надо повторить.

   Запуск: node tools/qa/scenarios/economy.js [метка] */

const { launch, saveReport } = require('../harness');

// Забег после правок физики стал длинным, а полный прогон на пяти сидах — долгим.
// Число сидов и потолок забега задаются аргументами: node economy.js метка 3 180
const ALL_SEEDS = [101, 202, 303, 404, 505];
const label = process.argv[2] || 'current';
const SEEDS = ALL_SEEDS.slice(0, Number(process.argv[3]) || ALL_SEEDS.length);
const RUN_TIMEOUT = (Number(process.argv[4]) || 300) * 1000;

// Три условия воспроизводимости — без любого из них один сид даёт разные забеги:
//   1. fixedStep    — шаг физики постоянный, а не тот, что дал браузер;
//   2. armSeed до startRun — генератор пересевается внутри create() сцены, то есть
//      в точке, одинаковой во всех прогонах;
//   3. бот на игровой сетке времени (в harness) — иначе он вступал в игру на
//      разной игровой миллисекунде, потому что команда идёт по CDP реальное время.
// Проверено: три прогона сида 101 дают ровно 3250 очков против разброса 33 % до правки
async function playOnce(seed, unloadAt) {
  const g = await launch({ seed });
  await g.fixedStep({ rate: 8 });
  await g.armSeed(seed);
  await g.startRun();
  const result = await g.playRun({ unloadAt, timeoutMs: RUN_TIMEOUT });
  const errors = g.errors.slice(0, 3);
  await g.close();
  return { seed, unloadAt, ...result, errors };
}

// Разброс в процентах от минимума: одно число вместо пары «мин-макс»
function spread(min, max) {
  if (!min || !isFinite(min) || !isFinite(max)) return 0;
  return Math.round((max / min - 1) * 100);
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

    // Монеты считаются от суммарной ценности груза, а счёт — от неё же, умноженной
    // на количество (этап 8.4). Разброс монет обязан быть заметно уже разброса
    // счёта: ради этого валюту и разводили с рекордом
    coins: Math.round(mean(nums('coins'))),
    coinsMin: Math.min(...nums('coins')),
    coinsMax: Math.max(...nums('coins')),
    seconds: +(mean(nums('elapsed')) / 1000).toFixed(1),

    // Часы бота против часов игры. tickMs = 50, значит ticksPerGameSec обязан
    // быть около 20; отклонение означает, что бот принимал не то число решений
    // на игровую секунду, и сравнивать такой прогон с другим нельзя
    wallSeconds: +(mean(nums('wallMs')) / 1000).toFixed(1),
    timeRatio: +mean(nums('timeRatio')).toFixed(3),
    ticksPerGameSec: +mean(nums('ticksPerGameSec')).toFixed(2),
    unloads: +mean(nums('unloads')).toFixed(1),
    avgUnloadSize: +mean(sizes).toFixed(1),
    maxUnloadSize: sizes.length ? Math.max(...sizes) : 0,
    dodges: +mean(nums('dodges')).toFixed(1),
    drops: +mean(nums('drops')).toFixed(1),
    misses: +mean(nums('misses')).toFixed(1),
    timedOut: rows.filter(r => r.timedOut).length
  };
}

// Кривая дохода берётся из ЗАМЕРА, а не из головы.
//
// tools/qa/scenarios/upgrades.js гоняет бота на пяти состояниях магазина — от пустого
// до полного — и меряет монеты за забег на каждом. Замер показал, что равномерный рост
// «на столько-то процентов с покупки» неверен НЕ ТОЛЬКО по величине, но и по форме:
// первые две покупки дают +62 %, последние четыре — +3 %. Доход выходит на плато после
// четвёртой покупки, дальше улучшения берут выживаемостью, а не заработком.
//
// Поэтому подставляем кривую целиком, интерполируя между замеренными точками, а не
// один усреднённый множитель. Если отчёта нет — откатываемся на прежнюю вилку и честно
// пишем об этом в выводе
function loadCurve() {
  try {
    const r = require('../reports/upgrades-base.json');
    const points = (r.summary ? r.summary.points : r.points) || [];
    if (points.length >= 2 && points[0].coins > 0) {
      return { points, measured: true, source: 'upgrades-base.json' };
    }
  } catch (e) { /* отчёта ещё нет */ }
  return { points: null, measured: false, source: null };
}

const CURVE = loadCurve();

// Доход после `bought` покупок, приведённый к доходу текущего замера.
// Замер улучшений и замер экономики гоняются на разных сидах и разной длине забега,
// поэтому от кривой берётся только ФОРМА: во сколько раз доход отличается от дохода
// на пустом магазине. Абсолютная величина — из текущего прогона
function incomeAt(baseIncome, bought) {
  if (!CURVE.measured) return baseIncome;
  const pts = CURVE.points;
  const base = pts[0].coins;

  let ratio;
  if (bought <= pts[0].bought) ratio = 1;
  else if (bought >= pts[pts.length - 1].bought) ratio = pts[pts.length - 1].coins / base;
  else {
    let i = 0;
    while (i < pts.length - 2 && pts[i + 1].bought < bought) i++;
    const a = pts[i];
    const b = pts[i + 1];
    const t = (bought - a.bought) / (b.bought - a.bought);
    ratio = (a.coins + (b.coins - a.coins) * t) / base;
  }
  return baseIncome * ratio;
}

// Сколько забегов нужно, чтобы скупить магазин при таком доходе.
//
// mode: 'flat' — доход постоянный, заведомо пессимистичная верхняя граница;
//       'curve' — доход растёт по замеренной кривой
function progression(baseIncome, prices, mode = 'flat') {
  const all = prices.flat().sort((a, b) => a - b);
  const total = all.reduce((a, b) => a + b, 0);
  let coins = 0;
  let runs = 0;
  const bought = [];
  while (bought.length < all.length && runs < 500) {
    runs++;
    coins += mode === 'curve' ? incomeAt(baseIncome, bought.length) : baseIncome;
    while (bought.length < all.length && coins >= all[bought.length]) {
      coins -= all[bought.length];
      bought.push(runs);
    }
  }
  return {
    mode,
    firstBuyAfterRun: bought[0] || null,
    allBoughtAfterRun: bought[bought.length - 1] || null,
    total
  };
}

// Вилка: доход постоянный (верхняя граница числа забегов) и доход по замеренной кривой
function progressionRange(baseIncome, prices) {
  return ['flat', 'curve'].map(m => progression(baseIncome, prices, m));
}

async function main() {
  // Один лишний запуск браузера ради цен окупается тем, что числа не разъезжаются
  const probe = await launch({ seed: 1 });
  const shop = await probe.shopSpec();
  await probe.close();

  const rows = [];
  for (const seed of SEEDS) {
    process.stdout.write(`забег, сид ${seed}... `);
    const r = await playOnce(seed, 8);
    rows.push(r);
    console.log(`счёт ${r.score}, ${Math.round(r.elapsed / 1000)} с, сдач ${r.unloads}`);
  }

  // Контрольная группа: игрок, который сдаёт по 5 коробок — так играли до правок физики
  const cautious = [];
  for (const seed of SEEDS.slice(0, 2)) {
    process.stdout.write(`осторожный забег, сид ${seed}... `);
    const r = await playOnce(seed, 5);
    cautious.push(r);
    console.log(`счёт ${r.score}`);
  }

  const main8 = stats(rows);
  const main5 = stats(cautious);

  // Цены из спеки: пропорции × множитель. Считаем, каким множитель должен стать
  const proportions = [[500, 1500, 4000], [800, 2000, 5000], [1000, 3000]];

  // Действующие цены читаем ИЗ ИГРЫ, а не дублируем здесь. Дубль уже подвёл: после
  // этапа 8.4 цены в CONFIG.shop упали вчетверо, а сценарий продолжал печатать
  // «цены сейчас» по числам, устаревшим ещё до того — и считал по ним прогрессию
  const current = shop.order.map(key => shop[key].prices);

  // Магазин покупается за МОНЕТЫ, поэтому и прогрессия считается по ним
  const now = progression(main8.coins, current);
  const nowRange = progressionRange(main8.coins, current);
  // Цель дизайна из спеки: первая покупка после первого забега, весь магазин ~к десятому
  const proportionSum = proportions.flat().reduce((a, b) => a + b, 0);
  const wantedMultiplier = Math.max(1, Math.round((main8.coins * 10) / proportionSum));
  const proposed = proportions.map(line => line.map(v => v * wantedMultiplier));
  const after = progression(main8.coins, proposed);
  const afterRange = progressionRange(main8.coins, proposed);

  const summary = {
    label,
    date: new Date().toISOString(),
    bot8: main8,
    bot5: main5,
    currentPrices: current,
    currentProgression: now,
    currentProgressionRange: nowRange,
    proportionSum,
    wantedMultiplier,
    proposedPrices: proposed,
    proposedProgression: after,
    proposedProgressionRange: afterRange,
    errors: rows.flatMap(r => r.errors)
  };

  console.log(`\n=== экономика: ${label} ===`);
  console.log(`Бот, сдача по 8:  счёт ${main8.score} (${main8.scoreMin}-${main8.scoreMax}), забег ${main8.seconds} с, сдач ${main8.unloads} по ${main8.avgUnloadSize} коробки`);
  console.log(`  потери груза за борт ${main8.drops}, промахов ${main8.misses} за забег`);
  console.log(`Бот, сдача по 5:  счёт ${main5.score}, забег ${main5.seconds} с, потерь ${main5.drops}, промахов ${main5.misses}`);
  console.log(`Монет за забег:   ${main8.coins} (${main8.coinsMin}-${main8.coinsMax}) `
    + `— именно они покупают магазин`);
  console.log(`  разброс: счёт ${spread(main8.scoreMin, main8.scoreMax)} %, монеты ${spread(main8.coinsMin, main8.coinsMax)} % ` +
    `(у монет обязан быть уже — этап 8.4)`);
  console.log(`\nЦены сейчас (сумма ${now.total}): первая покупка после забега ${now.firstBuyAfterRun}, весь магазин к ${nowRange[1].allBoughtAfterRun}-${nowRange[0].allBoughtAfterRun}-му`);
  console.log(`  (вилка: доход постоянный — ${nowRange[0].allBoughtAfterRun} забегов, ` +
    `доход по замеренной кривой — ${nowRange[1].allBoughtAfterRun})`);
  console.log(CURVE.measured
    ? `  кривая дохода ЗАМЕРЕНА (${CURVE.source}), а не взята из головы`
    : `  кривая дохода НЕ замерена — прогнать tools/qa/scenarios/upgrades.js base 3 150`);
  console.log(`Цель: первая покупка после 1-го, весь магазин примерно к 10-му`);
  console.log(`Множитель к пропорциям спеки: было 6, нужно ${summary.wantedMultiplier}`);
  console.log(`Предлагаемые цены: ${JSON.stringify(proposed)}`);
  console.log(`С ними: первая покупка после ${after.firstBuyAfterRun}, весь магазин к ${after.allBoughtAfterRun}-му (сумма ${after.total})`);
  console.log(`забегов, упёршихся в таймаут: ${main8.timedOut}`);

  saveReport(`economy-${label}.json`, { summary, rows, cautious });
}

main().catch(e => { console.error(e); process.exit(1); });
