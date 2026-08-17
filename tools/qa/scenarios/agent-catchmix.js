/* Смешанный штабель, набранный ЛОВЛЕЙ, а не расстановкой.
   Проверка на артефакт: в agent-mixed и agent-rest смесь ставилась полочной
   укладкой, и потери в покое могли быть свойством укладки, а не физики.
   Здесь коробки падают на кузов по одной штатным путём, как их ловит игрок.

   Запуск: node tools/qa/scenarios/agent-catchmix.js [метка] */

const { launch, saveReport } = require('../harness');

const SEEDS = [11, 22, 33];
const label = process.argv[2] || 'catchmix';

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

async function hold(g, ms, keepFalling) {
  const step = 300;
  for (let left = ms; left > 0; left -= step) {
    await g.pauseSpawn(true);
    if (!keepFalling) await g.clearFalling();
    await g.wait(Math.min(step, left));
  }
  await g.pauseSpawn(true);
}

// Коробка падает на кузов сама, со случайным смещением по X: игрок не ловит
// всё точно в центр. Ловит её игра, через onCollisionStart
async function dropOnCart(g, sizeName, offset) {
  return g.eval((name, off) => {
    const s = window.__qa.scene();
    const rail = s.cart.rail;
    const spec = CONFIG.boxes[name];
    const color = CONFIG.rails[rail].color;
    const obj = s.spawnFaller(`box-${name}-${color}`, spec.size, rail, {
      kind: 'box', sizeName: name, color, value: spec.value,
      penalty: spec.penalty, missPenalty: spec.missPenalty,
      densityFactor: spec.densityFactor
    });
    const top = s.cargo.reduce((min, b) => Math.min(min, b.y - b.displayHeight / 2), s.cart.y);
    s.matter.body.setPosition(obj.body, {
      x: s.cart.x + off * s.cart.scale,
      y: top - 50 * s.cart.scale
    });
    s.matter.body.setVelocity(obj.body, { x: 0, y: s.run.fallSpeed / 60 });
    return true;
  }, sizeName, offset);
}

async function build(g, list, seed) {
  await g.ensureRun();
  await hold(g, 300);
  await g.clearCargo();
  await g.refillXp();

  const rand = rng(seed ^ 0x5f);
  for (const size of list) {
    const offset = Math.round((rand() - 0.5) * 90);   // ±45 px от центра кузова
    await dropOnCart(g, size, offset);
    await hold(g, 600, true);
  }
  await hold(g, 1500);
  return g.state();
}

const turn = async g => { await g.drive('right', 700); await g.drive('left', 700); };
const calm = async g => {
  for (let i = 0; i < 8; i++) { await g.drive(i % 2 ? 'left' : 'right', 150); await g.wait(300); }
};

async function trial(g, count, seed, uniform) {
  const list = uniform ? new Array(count).fill('medium') : mixList(count, seed);
  const built = await build(g, list, seed);

  // Покой 5 с: сколько теряется вообще без ввода
  await hold(g, 5000);
  const rested = await g.state();

  await calm(g);
  await hold(g, 1500);
  const afterCalm = await g.state();

  await turn(g);
  await hold(g, 2000);
  const afterTurn = await g.state();

  return {
    dropped: count,
    caught: built.cargo.length,
    missedWhileBuilding: count - built.cargo.length,
    afterRest: rested.cargo.length,
    lostAtRest: built.cargo.length - rested.cargo.length,
    afterCalm: afterCalm.cargo.length,
    lostCalm: rested.cargo.length - afterCalm.cargo.length,
    afterTurn: afterTurn.cargo.length,
    lostTurn: afterCalm.cargo.length - afterTurn.cargo.length,
    maxDepth: +Math.max(built.maxDepth, rested.maxDepth, afterCalm.maxDepth, afterTurn.maxDepth).toFixed(3),
    stackTop: +Math.min.apply(null, [0].concat(rested.cargo.map(b => b.dy))).toFixed(1)
  };
}

async function runSeed(seed) {
  const g = await launch({ seed });
  await g.startRun();
  await g.pauseSpawn(true);
  await g.freezeXp(true);

  const out = { seed };
  out.mix12 = await trial(g, 12, seed, false);
  out.med12 = await trial(g, 12, seed, true);
  out.mix16 = await trial(g, 16, seed, false);
  out.errors = g.errors.slice(0, 5);
  await g.shot(`agent-catchmix-${seed}.png`);
  await g.close();
  return out;
}

function avg(rows, pick) {
  const v = rows.map(pick).filter(x => typeof x === 'number');
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null;
}

async function main() {
  const rows = [];
  for (const seed of SEEDS) {
    process.stdout.write(`сид ${seed}... `);
    rows.push(await runSeed(seed));
    console.log('готово');
  }

  const keys = ['mix12', 'med12', 'mix16'];
  const summary = { label, date: new Date().toISOString(), seeds: SEEDS, tests: {} };
  for (const k of keys) {
    summary.tests[k] = {
      caught: avg(rows, r => r[k].caught),
      caughtRaw: rows.map(r => r[k].caught),
      lostAtRest: avg(rows, r => r[k].lostAtRest),
      lostAtRestRaw: rows.map(r => r[k].lostAtRest),
      lostCalm: avg(rows, r => r[k].lostCalm),
      lostCalmRaw: rows.map(r => r[k].lostCalm),
      lostTurn: avg(rows, r => r[k].lostTurn),
      lostTurnRaw: rows.map(r => r[k].lostTurn),
      afterTurn: rows.map(r => r[k].afterTurn),
      maxDepth: Math.max.apply(null, rows.map(r => r[k].maxDepth)),
      stackTop: avg(rows, r => r[k].stackTop)
    };
  }
  summary.errors = rows.flatMap(r => r.errors);

  console.log(`\n=== набор ловлей: ${label} ===`);
  for (const k of keys) {
    const t = summary.tests[k];
    console.log(`${k}: поймано ${t.caught} [${t.caughtRaw.join(' ')}]  ` +
      `потеряно в покое ${t.lostAtRest} [${t.lostAtRestRaw.join(' ')}]  ` +
      `в езде ${t.lostCalm} [${t.lostCalmRaw.join(' ')}]  ` +
      `в развороте ${t.lostTurn} [${t.lostTurnRaw.join(' ')}]  ` +
      `осталось [${t.afterTurn.join(' ')}]  depth ${t.maxDepth}  верх ${t.stackTop}`);
  }
  console.log(`ошибок в консоли: ${summary.errors.length}`);

  saveReport(`agent-catchmix-${label}.json`, { summary, rows });
}

main().catch(e => { console.error(e); process.exit(1); });
