/* Стабильность штабеля: сколько коробок кузов реально держит и что их роняет.
   Сценарии S1-S5 и S10 из плана QA. Прогоняется до и после каждой правки физики —
   без замера «до» непонятно, что именно дала правка.

   Запуск: node tools/qa/scenarios/stability.js [метка]
   Метка попадает в имя отчёта: stability-<метка>.json */

const { launch, saveReport } = require('../harness');

const SEEDS = [11, 22, 33, 44, 55];
const label = process.argv[2] || 'baseline';

// Один замер: поставить штабель, сделать действие, посчитать, что осталось
async function measure(g, { size, count, action }) {
  await g.ensureRun();
  await g.pauseSpawn(true);
  await g.clearCargo();
  await g.refillXp();
  await g.stack(size, count);
  await g.wait(900);                 // штабель оседает

  const settled = await g.state();
  await action(g);
  await g.wait(1600);                // разлёт заканчивается

  const after = await g.state();
  return {
    settled: settled.cargo.length,
    left: after.cargo.length,
    lost: settled.cargo.length - after.cargo.length,
    maxDepth: after.maxDepth,
    stepMs: after.stepMs
  };
}

// Дрейф покоящегося штабеля: если коробки расползаются сами, это видно здесь
async function drift(g, size, count, ms) {
  await g.ensureRun();
  await g.pauseSpawn(true);
  await g.clearCargo();
  await g.refillXp();
  await g.stack(size, count);
  await g.wait(900);

  const before = await g.state();
  await g.wait(ms);
  const after = await g.state();

  const moved = after.cargo.map((box, i) => {
    const was = before.cargo[i];
    return was ? Math.hypot(box.dx - was.dx, box.dy - was.dy) : 0;
  });

  return {
    settled: before.cargo.length,
    left: after.cargo.length,
    maxDrift: +Math.max(0, ...moved).toFixed(2),
    avgDrift: +(moved.reduce((a, b) => a + b, 0) / (moved.length || 1)).toFixed(2),
    maxDepth: after.maxDepth,
    awake: after.cargo.filter(b => !b.sleeping).length
  };
}

async function runSeed(seed) {
  const g = await launch({ seed });
  await g.startRun();
  await g.pauseSpawn(true);
  await g.freezeXp(true);   // мерим физику, а не выживаемость: см. harness

  const out = { seed };

  // S0 — вместимость: набрать заведомо много и аккуратно поездить. Это и есть
  // ответ на главный вопрос QA — сколько коробок кузов держит на самом деле
  out.s0_capacity = await measure(g, {
    size: 'medium', count: 14,
    action: async h => {
      for (let i = 0; i < 10; i++) {
        await h.drive(i % 2 ? 'left' : 'right', 180);
        await h.wait(300);
      }
    }
  });

  // S1 — спокойная езда: короткие нажатия с паузами, как ездит аккуратный игрок
  out.s1_calm = await measure(g, {
    size: 'medium', count: 10,
    action: async h => {
      for (let i = 0; i < 8; i++) {
        await h.drive(i % 2 ? 'left' : 'right', 150);
        await h.wait(350);
      }
    }
  });

  // S2 — покой: ввода нет вообще
  out.s2_rest = await drift(g, 'medium', 10, 8000);

  // S3 — разворот на максимуме: разгон до потолка и сразу в обратную сторону
  out.s3_turn = await measure(g, {
    size: 'medium', count: 10,
    action: async h => { await h.drive('right', 700); await h.drive('left', 700); }
  });

  // S4 — смена рельсы с полным кузовом
  out.s4_rail = await measure(g, {
    size: 'medium', count: 8,
    action: async h => { await h.switchRail('up'); await h.wait(400); await h.switchRail('down'); }
  });

  // S5 — различимость размеров. Меряется ОДНА коробка на пустом дне: штабель из
  // шести large выше штабеля из шести small, и сравнение стопок мерило бы высоту,
  // а не массу
  const turn = async h => { await h.drive('right', 700); await h.drive('left', 700); };
  for (const size of ['small', 'large']) {
    await g.ensureRun();
    await g.pauseSpawn(true);
    await g.clearCargo();
    await g.refillXp();
    await g.stack(size, 1);   // stack сажает коробку ровно на дно, с учётом её размера
    await g.wait(900);
    const before = await g.state();
    await turn(g);
    await g.wait(1200);
    const after = await g.state();
    const box = after.cargo[0];
    const was = before.cargo[0];
    out[`s5_${size}`] = {
      left: after.cargo.length,
      avgShift: box && was ? +Math.abs(box.dx - was.dx).toFixed(2) : null,
      mass: box ? box.mass : (was ? was.mass : null)
    };
  }

  // S10 — накопительная погрешность масштабирования тела при смене рельсы
  await g.ensureRun();
  await g.pauseSpawn(true);
  await g.clearCargo();
  await g.refillXp();
  await g.stack('medium', 6);
  await g.wait(600);
  const areaBefore = (await g.state()).cargo.map(b => b.area);
  for (let i = 0; i < 10; i++) {
    await g.switchRail('up');
    await g.switchRail('down');
    await g.refillXp();
  }
  await g.wait(600);
  const areaAfter = (await g.state()).cargo.map(b => b.area);
  const errors = areaAfter.map((a, i) => (areaBefore[i] ? Math.abs(a - areaBefore[i]) / areaBefore[i] : 0));
  out.s10_scale = {
    boxes: areaAfter.length,
    maxRelError: errors.length ? +Math.max(...errors).toExponential(2) : 0
  };

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

  const summary = {
    label,
    date: new Date().toISOString(),
    seeds: SEEDS,
    s0_capacity_settled: avg(rows, r => r.s0_capacity.settled),
    s0_capacity_left: avg(rows, r => r.s0_capacity.left),
    s1_calm_lost: avg(rows, r => r.s1_calm.lost),
    s2_rest_maxDrift: avg(rows, r => r.s2_rest.maxDrift),
    s2_rest_lost: avg(rows, r => r.s2_rest.settled - r.s2_rest.left),
    s3_turn_lost: avg(rows, r => r.s3_turn.lost),
    s4_rail_lost: avg(rows, r => r.s4_rail.lost),
    s5_shift_small: avg(rows, r => r.s5_small.avgShift),
    s5_shift_large: avg(rows, r => r.s5_large.avgShift),
    s10_maxRelError: Math.max(...rows.map(r => Number(r.s10_scale.maxRelError))),
    stepMs: avg(rows, r => r.s3_turn.stepMs),
    maxDepth: avg(rows, r => r.s2_rest.maxDepth),
    errors: rows.flatMap(r => r.errors)
  };
  summary.s5_ratio = summary.s5_shift_large
    ? +(summary.s5_shift_small / summary.s5_shift_large).toFixed(2) : null;

  console.log(`\n=== ${label} ===`);
  console.log(`S0 вместимость: осталось из 14:         ${summary.s0_capacity_left}   (цель >= 8)`);
  console.log(`S1 спокойная езда, потеряно из 10:      ${summary.s1_calm_lost}   (цель 0)`);
  console.log(`S2 покой 8 с, макс. дрейф px:           ${summary.s2_rest_maxDrift}   (цель < 2)`);
  console.log(`S2 покой, потеряно само собой:          ${summary.s2_rest_lost}   (цель 0)`);
  console.log(`S3 разворот, потеряно из 10:            ${summary.s3_turn_lost}   (цель 1-3)`);
  console.log(`S4 смена рельсы, потеряно из 8:         ${summary.s4_rail_lost}   (цель 1-2)`);
  const s5ok = summary.s5_ratio && (summary.s5_ratio >= 1.5 || summary.s5_ratio <= 0.67);
  console.log(`S5 сдвиг small / large:                 ${summary.s5_shift_small} / ${summary.s5_shift_large} = ${summary.s5_ratio}   (различимо: ${s5ok ? 'да' : 'НЕТ'})`);
  console.log(`S10 ошибка площади тела:                ${summary.s10_maxRelError}   (цель < 1e-6)`);
  console.log(`шаг физики, мс:                         ${summary.stepMs}   (цель < 4)`);
  console.log(`макс. проникновение в контакте:         ${summary.maxDepth}`);
  console.log(`ошибок в консоли: ${summary.errors.length}`);

  saveReport(`stability-${label}.json`, { summary, rows });
}

main().catch(e => { console.error(e); process.exit(1); });
