/* Инерция груза: отстаёт ли штабель от кузова и насколько (этап 8.1, ADR-0007).

   stability.js меряет ИТОГ — сколько коробок потеряно. Этот сценарий меряет
   ПРИЧИНУ: смещение груза относительно кузова покадрово. Без него «инерция есть»
   и «инерции нет» выглядят одинаково, пока потери случайно совпали.

   Запуск: node tools/qa/scenarios/inertia.js [метка]
   Отчёт: reports/inertia-<метка>.json */

const { launch, saveReport } = require('../harness');

const SEEDS = [11, 22, 33];
const label = process.argv[2] || 'baseline';

const STACK = 8;        // коробок в кузове на каждый замер
const ACCEL_MS = 600;   // полный разгон: CONFIG.cart.accelTime
const TURN_MS = 400;    // разгон до реверса, как в stability.js (S3)

/* Покадровый съём смещения груза относительно кузова.

   Меряем сдвиг КАЖДОЙ коробки от её собственного положения в покое, а не
   абсолютное расстояние до центра тележки: одна улетающая коробка иначе
   перекрывает собой весь штабель, и число перестаёт что-либо значить.
   Медиана отвечает за штабель целиком, максимум — за самую сорванную коробку. */
function sample(g, ms) {
  return g.eval(duration => new Promise(resolve => {
    const s = window.__game.scene.getScene('GameScene');
    const out = [];
    const t0 = performance.now();

    // Отсчёт: где коробка лежала до манёвра
    s.cargo.forEach(box => { box.__lagBase = box.x - s.cart.x; });

    const median = list => {
      if (!list.length) return 0;
      const v = list.slice().sort((a, b) => a - b);
      const i = v.length >> 1;
      return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2;
    };

    const tick = () => {
      const now = performance.now();
      const shift = s.cargo.map(box => (box.x - s.cart.x) - box.__lagBase);

      out.push({
        t: Math.round(now - t0),
        vx: Math.round(s.cart.vx),
        medShift: +median(shift).toFixed(2),
        maxShift: +(shift.length ? shift.reduce(
          (a, b) => Math.abs(b) > Math.abs(a) ? b : a, 0) : 0).toFixed(2),
        count: s.cargo.length
      });

      if (now - t0 < duration) requestAnimationFrame(tick);
      else resolve(out);
    };
    requestAnimationFrame(tick);
  }), ms);
}

// Подготовка одинакова для всех замеров: чистый кузов, штабель, покой
async function setup(g) {
  await g.ensureRun();
  await g.pauseSpawn(true);
  await g.clearCargo();
  await g.refillXp();
  await g.eval(() => {
    const s = window.__game.scene.getScene('GameScene');
    s.moveCartBy(CONFIG.screen.width / 2 - s.cart.x, 0);
    s.cart.vx = 0;
    s.holdTime = 0;
    s.holdDir = 0;
    s.matter.body.setVelocity(s.cartBody, { x: 0, y: 0 });
  });
  await g.wait(200);
  await g.stack('medium', STACK);
  await g.wait(900);
  await g.clearFalling();
}

// Свод по одной серии кадров. sign задаёт ожидаемую сторону сдвига:
// -1 на разгоне (груз отстаёт назад), +1 на торможении и развороте
function digest(frames, sign) {
  const med = frames.map(f => f.medShift * sign);
  const max = frames.map(f => f.maxShift * sign);
  const first = frames.length ? frames[0].count : 0;
  return {
    peakMedian: +Math.max(0, ...med).toFixed(2),
    peakMax: +Math.max(0, ...max).toFixed(2),
    frames: frames.length,
    started: first,
    left: frames.length ? frames[frames.length - 1].count : 0,
    lost: first - (frames.length ? frames[frames.length - 1].count : 0)
  };
}

async function runSeed(seed) {
  const g = await launch({ seed });
  await g.startRun();
  await g.pauseSpawn(true);
  await g.freezeXp(true);

  const out = { seed };

  // I1 — старт с места. Тележка едет вправо, груз обязан отстать ВЛЕВО
  await setup(g);
  const i1 = (await Promise.all([
    g.drive('right', ACCEL_MS),
    sample(g, ACCEL_MS)
  ]))[1];
  out.i1_start = digest(i1, -1);

  // I2 — торможение. Разогнались и отпустили: груз должен навалиться ВПЕРЁД
  await setup(g);
  await g.drive('right', ACCEL_MS);
  const i2 = await sample(g, 500);
  out.i2_brake = digest(i2, 1);

  // I3 — разворот на ходу. Тот же манёвр, что S3 в stability.js
  await setup(g);
  const i3 = (await Promise.all([
    (async () => { await g.drive('right', TURN_MS); await g.drive('left', 600); })(),
    sample(g, TURN_MS + 600)
  ]))[1];
  out.i3_turn = digest(i3, 1);
  await g.wait(1200);
  out.i3_turn.lostAfter = STACK - (await g.state()).cargo.length;

  // I4 — смена рельсы. Кузов уезжает по Y, груз остаётся: меряем провал по Y
  await setup(g);
  const i4 = (await Promise.all([
    g.switchRail('up'),
    sample(g, 600)
  ]))[1];
  out.i4_rail = digest(i4, 1);
  await g.switchRail('down');

  out.errors = g.errors.slice(0, 5);
  await g.close();
  return out;
}

function avg(rows, pick) {
  const values = rows.map(pick).filter(v => typeof v === 'number');
  if (!values.length) return null;
  return +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2);
}

async function main() {
  const rows = [];
  for (const seed of SEEDS) {
    process.stdout.write(`сид ${seed}... `);
    rows.push(await runSeed(seed));
    console.log('готово');
  }

  // Порог вылета за борт: дальше этого груз уже не отстаёт, а теряется
  const limit = 124;   // (CONFIG.cart.width / 2 + CONFIG.bounds.cargoDropX) * 1.0

  const summary = {
    label,
    date: new Date().toISOString(),
    seeds: SEEDS,
    limitX: limit,
    i1_start_median: avg(rows, r => r.i1_start.peakMedian),
    i1_start_max: avg(rows, r => r.i1_start.peakMax),
    i1_start_lost: avg(rows, r => r.i1_start.lost),
    i2_brake_median: avg(rows, r => r.i2_brake.peakMedian),
    i2_brake_max: avg(rows, r => r.i2_brake.peakMax),
    i3_turn_median: avg(rows, r => r.i3_turn.peakMedian),
    i3_turn_max: avg(rows, r => r.i3_turn.peakMax),
    i3_turn_lost: avg(rows, r => r.i3_turn.lostAfter),
    i4_rail_max: avg(rows, r => r.i4_rail.peakMax),
    errors: rows.flatMap(r => r.errors)
  };

  console.log(`\n=== инерция: ${label} ===`);
  console.log(`I1 старт, отставание штабеля, px:     ${summary.i1_start_median}  (сорванная коробка ${summary.i1_start_max})`);
  console.log(`I1 старт, потеряно из ${STACK}:             ${summary.i1_start_lost}   (цель 0-1)`);
  console.log(`I2 торможение, навал вперёд, px:      ${summary.i2_brake_median}  (сорванная ${summary.i2_brake_max})`);
  console.log(`I3 разворот, снос вперёд, px:         ${summary.i3_turn_median}  (сорванная ${summary.i3_turn_max})`);
  console.log(`I3 разворот, потеряно из ${STACK}:          ${summary.i3_turn_lost}   (цель 2-4)`);
  console.log(`I4 смена рельсы, макс. сдвиг, px:     ${summary.i4_rail_max}`);
  console.log(`инерция читается: ${summary.i1_start_median > 3 ? 'да' : 'НЕТ — груз всё ещё приклеен'}`);
  console.log(`запас до вылета (${limit} px): ${summary.i1_start_median < limit / 2 ? 'есть' : 'МАЛ'}`);
  console.log(`ошибок в консоли: ${summary.errors.length}`);

  saveReport(`inertia-${label}.json`, { summary, rows });
}

main().catch(err => { console.error(err); process.exit(1); });
