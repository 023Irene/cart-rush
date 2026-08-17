/* Механика потери груза в покое на СМЕШАННОМ штабеле.
   agent-mixed и agent-edge показали: стопка из одних medium в покое стоит
   намертво (дрейф 0), а смесь small+medium+large сама уезжает и теряет коробки.
   Здесь ищем, ЧТО именно уезжает: выдавленная решателем мелочь снизу или
   съехавшая верхушка.

   Запуск: node tools/qa/scenarios/agent-rest.js [метка] */

const { launch, saveReport } = require('../harness');

const SEEDS = [22, 33, 44];
const label = process.argv[2] || 'rest';

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
    const tmp = list[i]; list[i] = list[j]; list[j] = tmp;
  }
  return list;
}

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
  let cursor = 0, rowTop = 2, rowMax = 0;
  const plan = [];
  for (const size of list) {
    const side = info.sizes[size] * info.scale;
    if (cursor + side > inner + 0.1) { rowTop += rowMax + 1; cursor = 0; rowMax = 0; }
    const dx = left + cursor + side / 2;
    const dy = -(rowTop + side / 2);
    await g.place(size, dx, dy);
    plan.push({ size, dx: +dx.toFixed(1), dy: +dy.toFixed(1) });
    cursor += side;
    rowMax = Math.max(rowMax, side);
  }
  return plan;
}

// Кто уехал: сравниваем составы снимков по размеру и месту
function diff(before, after) {
  const gone = [];
  const pool = after.slice();
  for (const b of before) {
    const idx = pool.findIndex(a => a.size === b.size && Math.abs(a.dx - b.dx) < 30 && Math.abs(a.dy - b.dy) < 30);
    if (idx === -1) gone.push(b); else pool.splice(idx, 1);
  }
  return gone;
}

async function runSeed(seed) {
  const g = await launch({ seed });
  await g.startRun();
  await g.pauseSpawn(true);
  await g.freezeXp(true);
  await hold(g, 200);
  await g.clearCargo();
  await g.refillXp();

  const plan = await placeList(g, mixList(12, seed));

  // Снимки каждые 500 мс: видно, коробка уезжает рывком (выдавило) или ползёт
  const frames = [];
  for (let i = 0; i < 24; i++) {
    const s = await g.state();
    frames.push({
      t: i * 500,
      count: s.cargo.length,
      maxDepth: s.maxDepth,
      maxSpeed: +Math.max.apply(null, [0].concat(s.cargo.map(b => Math.hypot(b.vx, b.vy)))).toFixed(2),
      cargo: s.cargo.map(b => ({ size: b.size, dx: b.dx, dy: b.dy, vx: b.vx, vy: b.vy, sleeping: b.sleeping }))
    });
    await hold(g, 500);
  }
  await g.shot(`agent-rest-mix-${seed}.png`);

  const first = frames[0];
  const last = frames[frames.length - 1];
  const gone = diff(first.cargo, last.cargo);

  // Кто из выживших уполз дальше всех — по паре ближайших снимков
  const shifted = last.cargo.map(b => {
    const was = first.cargo.find(a => a.size === b.size && Math.abs(a.dx - b.dx) < 40 && Math.abs(a.dy - b.dy) < 40);
    return was ? { size: b.size, dist: +Math.hypot(b.dx - was.dx, b.dy - was.dy).toFixed(2) } : { size: b.size, dist: null };
  }).sort((a, b) => (b.dist || 0) - (a.dist || 0));

  const out = {
    seed,
    plan,
    placed: plan.length,
    first: first.count,
    last: last.count,
    lost: first.count - last.count,
    gone,
    topShift: shifted.slice(0, 3),
    maxDepth: +Math.max.apply(null, frames.map(f => f.maxDepth)).toFixed(3),
    maxSpeedAfterSettle: +Math.max.apply(null, frames.slice(6).map(f => f.maxSpeed)).toFixed(2),
    sleepingAtEnd: last.cargo.filter(b => b.sleeping).length,
    counts: frames.map(f => f.count),
    speeds: frames.map(f => f.maxSpeed),
    errors: g.errors.slice(0, 5)
  };
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

  console.log(`\n=== смесь в покое: ${label} ===`);
  for (const r of rows) {
    console.log(`сид ${r.seed}: поставлено ${r.placed}, через 0.5 с ${r.first}, через 12 с ${r.last}, ` +
      `уехало ${JSON.stringify(r.gone.map(b => b.size + '@' + b.dx + ',' + b.dy))}`);
    console.log(`   счёт по кадрам: ${r.counts.join(' ')}`);
    console.log(`   макс. скорость после оседания: ${r.maxSpeedAfterSettle} px/шаг, depth ${r.maxDepth}, спит ${r.sleepingAtEnd}`);
    console.log(`   самые уползшие: ${JSON.stringify(r.topShift)}`);
  }

  saveReport(`agent-rest-${label}.json`, { label, date: new Date().toISOString(), rows });
}

main().catch(e => { console.error(e); process.exit(1); });
