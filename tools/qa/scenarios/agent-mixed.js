/* Смешанный штабель и реальный потолок вместимости.
   Дополняет stability.js: там все замеры на коробках ОДНОГО размера и максимум
   на 14 коробках. Здесь — разброс масс в одной стопке (самый тяжёлый случай для
   решателя) и потолок 16/20.

   ВАЖНО: rampDifficulty() каждые 15 с делает spawnTimer.reset() и снимает паузу
   спавна (см. anomaly-spawn-pause.json). Поэтому пауза давится в каждом ожидании,
   иначе в кузов сыплются посторонние коробки и замер врёт в плюс.

   Запуск: node tools/qa/scenarios/agent-mixed.js [метка] */

const { launch, saveReport } = require('../harness');

const SEEDS = [11, 22, 33];
const label = process.argv[2] || 'mixed';

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Смесь в пропорциях спавна игры (weight 50/35/15), порядок — случайный по сиду
function mixList(count, seed) {
  const list = [];
  const small = Math.round(count * 0.5);
  const medium = Math.round(count * 0.35);
  for (let i = 0; i < count; i++) {
    list.push(i < small ? 'small' : i < small + medium ? 'medium' : 'large');
  }
  const rand = rng(seed);
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
  }
  return list;
}

// Пауза спавна давится принудительно: reset() в rampDifficulty её снимает
async function hold(g, ms) {
  const step = 400;
  for (let left = ms; left > 0; left -= step) {
    await g.pauseSpawn(true);
    await g.clearFalling();
    await g.wait(Math.min(step, left));
  }
  await g.pauseSpawn(true);
  await g.clearFalling();
}

// Полочная укладка: коробка кладётся справа от предыдущей, ряд кончился —
// новый ряд поверх. Так же, как ложатся пойманные коробки разного размера
async function placeList(g, list) {
  const info = await g.eval(() => ({
    scale: window.__qa.scene().cart.scale,
    inner: CONFIG.cart.width - 2 * CONFIG.cart.wallThickness,
    sizes: {
      small: CONFIG.boxes.small.size,
      medium: CONFIG.boxes.medium.size,
      large: CONFIG.boxes.large.size
    }
  }));
  const inner = info.inner * info.scale;
  const left = -inner / 2;

  let cursor = 0;
  let rowTop = 2;
  let rowMax = 0;
  for (const size of list) {
    const side = info.sizes[size] * info.scale;
    if (cursor + side > inner + 0.1) { rowTop += rowMax + 1; cursor = 0; rowMax = 0; }
    await g.place(size, left + cursor + side / 2, -(rowTop + side / 2));
    cursor += side;
    rowMax = Math.max(rowMax, side);
  }
  return list.length;
}

// Один замер: собрать штабель, сделать действие, посчитать оставшееся.
// maxDepth берётся максимумом по выборке, а не одним снимком в конце
async function measure(g, { list, action, settleMs = 1200 }) {
  await g.ensureRun();
  await hold(g, 200);
  await g.clearCargo();
  await g.refillXp();
  await placeList(g, list);
  await hold(g, settleMs);

  const settled = await g.state();
  const depths = [settled.maxDepth];
  const steps = [settled.stepMs];

  const probe = async () => {
    const s = await g.state();
    depths.push(s.maxDepth);
    steps.push(s.stepMs);
  };

  await action(g, probe);
  await hold(g, 1800);

  const after = await g.state();
  depths.push(after.maxDepth);
  steps.push(after.stepMs);

  return {
    placed: list.length,
    settled: settled.cargo.length,
    left: after.cargo.length,
    lost: settled.cargo.length - after.cargo.length,
    settleDepth: settled.maxDepth,
    maxDepth: +Math.max.apply(null, depths).toFixed(3),
    maxStepMs: +Math.max.apply(null, steps).toFixed(2),
    stackTop: +Math.min.apply(null, [0].concat(settled.cargo.map(b => b.dy))).toFixed(1),
    sleeping: settled.cargo.filter(b => b.sleeping).length
  };
}

const calm = async (g, probe) => {
  for (let i = 0; i < 8; i++) {
    await g.drive(i % 2 ? 'left' : 'right', 150);
    await g.wait(350);
    if (i % 3 === 0) await probe();
  }
};
const careful = async (g, probe) => {
  for (let i = 0; i < 8; i++) {
    await g.drive(i % 2 ? 'left' : 'right', 180);
    await g.wait(300);
    if (i % 3 === 0) await probe();
  }
};
const turn = async (g, probe) => {
  await g.drive('right', 700);
  await probe();
  await g.drive('left', 700);
};
const railSwitch = async (g, probe) => {
  await g.switchRail('up');
  await probe();
  await g.wait(400);
  await g.switchRail('down');
};
const rest = async (g, probe) => {
  await hold(g, 3000);
  await probe();
};

async function runSeed(seed) {
  const g = await launch({ seed });
  await g.startRun();
  await g.pauseSpawn(true);
  await g.freezeXp(true);

  const out = { seed };
  const mix12 = mixList(12, seed);
  const mix16 = mixList(16, seed);
  const mix20 = mixList(20, seed);
  out.mixList12 = mix12.join(',');

  // Смешанный штабель: покой, спокойная езда, разворот, смена рельсы
  out.mix12_rest = await measure(g, { list: mix12, action: rest });
  out.mix12_calm = await measure(g, { list: mix12, action: calm });
  out.mix12_turn = await measure(g, { list: mix12, action: turn });
  out.mix12_rail = await measure(g, { list: mix12, action: railSwitch });

  // Потолок вместимости: 16 и 20 при аккуратной езде
  out.med16 = await measure(g, { list: new Array(16).fill('medium'), action: careful });
  out.med20 = await measure(g, { list: new Array(20).fill('medium'), action: careful });
  out.mix16 = await measure(g, { list: mix16, action: careful });
  out.mix20 = await measure(g, { list: mix20, action: careful });

  // Тот же потолок, но с разворотом: держится ли высокая стопка в манёвре
  out.med20_turn = await measure(g, { list: new Array(20).fill('medium'), action: turn });
  out.mix20_turn = await measure(g, { list: mix20, action: turn });

  out.errors = g.errors.slice(0, 5);
  await g.close();
  return out;
}

function avg(rows, pick) {
  const v = rows.map(pick).filter(x => typeof x === 'number');
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null;
}
function maxOf(rows, pick) {
  return Math.max.apply(null, rows.map(pick).filter(x => typeof x === 'number'));
}

const KEYS = ['mix12_rest', 'mix12_calm', 'mix12_turn', 'mix12_rail',
  'med16', 'med20', 'mix16', 'mix20', 'med20_turn', 'mix20_turn'];

async function main() {
  const rows = [];
  for (const seed of SEEDS) {
    process.stdout.write(`сид ${seed}... `);
    rows.push(await runSeed(seed));
    console.log('готово');
  }

  const summary = { label, date: new Date().toISOString(), seeds: SEEDS, tests: {} };
  for (const k of KEYS) {
    summary.tests[k] = {
      settled: avg(rows, r => r[k].settled),
      left: avg(rows, r => r[k].left),
      lost: avg(rows, r => r[k].lost),
      lostRaw: rows.map(r => r[k].lost),
      settledRaw: rows.map(r => r[k].settled),
      settleDepth: avg(rows, r => r[k].settleDepth),
      maxDepth: maxOf(rows, r => r[k].maxDepth),
      maxStepMs: maxOf(rows, r => r[k].maxStepMs),
      stackTop: avg(rows, r => r[k].stackTop)
    };
  }
  summary.errors = rows.flatMap(r => r.errors);

  console.log(`\n=== смесь и потолок: ${label} ===`);
  for (const k of KEYS) {
    const t = summary.tests[k];
    console.log(`${k.padEnd(12)} осело ${String(t.settled).padStart(5)} [${t.settledRaw.join(' ')}] ` +
      `осталось ${String(t.left).padStart(5)} потеряно ${String(t.lost).padStart(5)} [${t.lostRaw.join(' ')}] ` +
      ` depth ${t.maxDepth}  step ${t.maxStepMs}  верх ${t.stackTop}`);
  }
  console.log(`ошибок в консоли: ${summary.errors.length}`);

  saveReport(`agent-mixed-${label}.json`, { summary, rows });
}

main().catch(e => { console.error(e); process.exit(1); });
