/* Физика взрыва: сценарии S6-S9 из плана QA.

   Проверяем не «красиво ли», а четыре измеримых свойства:
   сколько коробок теряется, зависит ли это от места взрыва, читается ли масса,
   и не пробивает ли разлёт дно кузова.

   Запуск: node tools/qa/scenarios/blast.js [метка] */

const { launch, saveReport } = require('../harness');

const SEEDS = [11, 22, 33, 44, 55];
const label = process.argv[2] || 'current';

// Один взрыв: собрать штабель, рвануть в заданной точке, посчитать оставшееся
async function boom(g, { size = 'medium', count = 5, dx = 0, dy = -60 } = {}) {
  await g.ensureRun();
  await g.pauseSpawn(true);
  await g.clearCargo();
  await g.refillXp();
  await g.stack(size, count);
  await g.wait(900);

  const before = await g.state();
  await g.blastAt(dx, dy);

  // Первые кадры после взрыва: ловим провал сквозь дно, если он есть
  await g.wait(90);
  const during = await g.state();
  const deepest = during.cargo.reduce((max, b) => Math.max(max, b.dy), -999);

  await g.wait(1800);
  const after = await g.state();

  return {
    settled: before.cargo.length,
    left: after.cargo.length,
    lost: before.cargo.length - after.cargo.length,
    deepest: +deepest.toFixed(1),
    before: before.cargo.map(b => ({ dx: b.dx, size: b.size })),
    after: after.cargo.map(b => ({ dx: b.dx, size: b.size }))
  };
}

// Куда сдвинулся груз после взрыва: средний сдвиг по X всех выживших коробок
async function push(g, epicenterDx) {
  await g.ensureRun();
  await g.pauseSpawn(true);
  await g.clearCargo();
  await g.refillXp();
  await g.stack('medium', 6);
  await g.wait(900);

  const before = await g.state();
  await g.blastAt(epicenterDx, -40);

  // Вектор снимается сразу после взрыва. Через полторы секунды коробки уже
  // упали обратно, трение их остановило, и сдвиг говорит скорее о трении,
  // чем о направлении взрыва
  await g.wait(50);
  const kick = await g.state();
  const avgVx = kick.cargo.reduce((sum, b) => sum + b.vx, 0) / (kick.cargo.length || 1);

  await g.wait(1500);
  const after = await g.state();
  return {
    epicenterDx,
    avgVx: +avgVx.toFixed(2),
    lost: before.cargo.length - after.cargo.length
  };
}

// Малая и большая коробка симметрично, взрыв ровно между ними
async function massPair(g) {
  await g.ensureRun();
  await g.pauseSpawn(true);
  await g.clearCargo();
  await g.refillXp();
  await g.place('small', -50, -18);
  await g.place('large', 50, -34);
  await g.wait(900);

  const before = await g.state();
  await g.blastAt(0, -70);
  await g.wait(1500);
  const after = await g.state();

  const find = (list, size) => list.find(b => b.size === size);
  const smallBefore = find(before.cargo, 'small');
  const largeBefore = find(before.cargo, 'large');
  const smallAfter = find(after.cargo, 'small');
  const largeAfter = find(after.cargo, 'large');

  return {
    smallShift: smallBefore && smallAfter ? +Math.abs(smallAfter.dx - smallBefore.dx).toFixed(2) : null,
    largeShift: largeBefore && largeAfter ? +Math.abs(largeAfter.dx - largeBefore.dx).toFixed(2) : null,
    smallLost: !!smallBefore && !smallAfter,
    largeLost: !!largeBefore && !largeAfter,
    smallMass: smallBefore ? smallBefore.mass : null,
    largeMass: largeBefore ? largeBefore.mass : null
  };
}

async function runSeed(seed, save) {
  const g = await launch({ seed, save });
  await g.startRun();
  await g.pauseSpawn(true);
  await g.freezeXp(true);

  const out = { seed, walls: save ? save.upgrades.walls : 0 };

  // S6 — калибровка: пять средних коробок, взрыв над центром
  out.s6_center = await boom(g, { count: 5, dx: 0, dy: -70 });

  // S7 — направление. Взрыв слева обязан толкать груз ВПРАВО, справа — влево.
  // Считать «потери слева против потерь справа» бессмысленно: если эпицентр
  // левее всего штабеля, все коробки летят в одну сторону, и это правильно
  out.s7_left = await push(g, -80);
  out.s7_right = await push(g, 80);

  // S8 — масса. Меряется на паре одиночных коробок, поставленных симметрично:
  // пять малых лежат одним слоем, а пять больших — тремя, и сравнение стопок
  // мерило бы высоту штабеля, а не массу
  out.s8_mass = await massPair(g);

  out.errors = g.errors.slice(0, 5);
  await g.close();
  return out;
}

function avg(rows, pick) {
  const values = rows.map(pick).filter(v => typeof v === 'number');
  return values.length ? +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2) : null;
}

async function main() {
  const rows = [];
  for (const seed of SEEDS) {
    process.stdout.write(`сид ${seed}... `);
    rows.push(await runSeed(seed, null));
    console.log('готово');
  }

  // S6б — тот же взрыв при максимальных бортах: апгрейд обязан заметно помогать
  const walled = [];
  const save = { bestScore: 0, currency: 0, upgrades: { walls: 3, battery: 0, suspension: 0 }, volume: 0.6, muted: true };
  for (const seed of SEEDS.slice(0, 3)) {
    process.stdout.write(`сид ${seed} с бортами 58... `);
    walled.push(await runSeed(seed, save));
    console.log('готово');
  }

  const summary = {
    label,
    date: new Date().toISOString(),
    s6_lost: avg(rows, r => r.s6_center.lost),
    s6b_lost_walls3: avg(walled, r => r.s6_center.lost),
    s7_vx_fromLeft: avg(rows, r => r.s7_left.avgVx),
    s7_vx_fromRight: avg(rows, r => r.s7_right.avgVx),
    s8_shift_small: avg(rows, r => r.s8_mass.smallShift),
    s8_shift_large: avg(rows, r => r.s8_mass.largeShift),
    s8_lostSmall: rows.filter(r => r.s8_mass.smallLost).length,
    s8_lostLarge: rows.filter(r => r.s8_mass.largeLost).length,
    s9_deepest: Math.max(...rows.map(r => r.s6_center.deepest)),
    errors: rows.flatMap(r => r.errors)
  };
  // Направление читается, если взрыв слева толкает вправо, а справа — влево
  summary.s7_directional =
    summary.s7_vx_fromLeft > 1 && summary.s7_vx_fromRight < -1;
  summary.s8_ratio = summary.s8_shift_large
    ? +(summary.s8_shift_small / summary.s8_shift_large).toFixed(2) : null;

  console.log(`\n=== взрыв: ${label} ===`);
  console.log(`S6  потеряно из 5 (борта 34):      ${summary.s6_lost}   (цель 2.0-2.5, спека 2.1)`);
  console.log(`S6б потеряно из 5 (борта 58):      ${summary.s6b_lost_walls3}   (цель ~1.0)`);
  console.log(`S7  скорость груза: взрыв слева ${summary.s7_vx_fromLeft}, справа ${summary.s7_vx_fromRight}   (направление читается: ${summary.s7_directional ? 'да' : 'НЕТ'})`);
  const s8note = summary.s8_lostSmall > summary.s8_lostLarge
    ? `малую выбило из кузова в ${summary.s8_lostSmall} прогонах из ${SEEDS.length}, большую — в ${summary.s8_lostLarge}`
    : `сдвиг ${summary.s8_shift_small} / ${summary.s8_shift_large} = ${summary.s8_ratio}`;
  console.log(`S8  масса читается:                ${s8note}`);
  console.log(`S9  глубже пола ушло (px):         ${summary.s9_deepest}   (цель < 60, иначе пробой дна)`);
  console.log(`ошибок в консоли: ${summary.errors.length}`);

  saveReport(`blast-${label}.json`, { summary, rows, walled });
}

main().catch(e => { console.error(e); process.exit(1); });
