/* Пограничные ситуации физики груза.
   Дополняет stability.js и blast.js: там всё мерилось на передней рельсе,
   в покое и без совпадения событий. Здесь — совпадения и дальняя рельса.

   Часть A: покой длинным окном (смесь против одного размера), взрыв в момент
            смены рельсы, бомба при пустом кузове, ловля в момент разворота.
   Часть B: полный кузов на ЗАДНЕЙ рельсе (масштаб 0.82), взрыв там же,
            ловля на потолке скорости падения.

   Пауза спавна давится в каждом ожидании: rampDifficulty() её снимает
   (см. anomaly-spawn-pause.json).

   Запуск: node tools/qa/scenarios/agent-edge.js <метка> <a|b> */

const { launch, saveReport } = require('../harness');

const SEEDS = [11, 22, 33];
const label = process.argv[2] || 'edge';
const part = (process.argv[3] || 'a').toLowerCase();

/* ---------- вспомогательное ---------- */

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

// Пауза без вычистки падающих: нужна там, где падающий объект и есть предмет замера
async function holdKeepFalling(g, ms) {
  const step = 400;
  for (let left = ms; left > 0; left -= step) {
    await g.pauseSpawn(true);
    await g.wait(Math.min(step, left));
  }
}

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
  for (const size of list) {
    const side = info.sizes[size] * info.scale;
    if (cursor + side > inner + 0.1) { rowTop += rowMax + 1; cursor = 0; rowMax = 0; }
    await g.place(size, left + cursor + side / 2, -(rowTop + side / 2));
    cursor += side;
    rowMax = Math.max(rowMax, side);
  }
  return list.length;
}

// Объект падает НА кузов штатным путём: spawnFaller + скорость падения, ловит его
// сама игра через onCollisionStart. Так проверяется именно ловля, а не телепорт
async function dropOnCart(g, kind, sizeName) {
  return g.eval((k, name) => {
    const s = window.__qa.scene();
    const rail = s.cart.rail;
    const color = CONFIG.rails[rail].color;
    let obj;
    if (k === 'bomb') {
      s.spawnBomb();
      obj = s.fallingBoxes[s.fallingBoxes.length - 1];
      // spawnBomb сам выбирает рельсу — переносим на рельсу тележки, иначе фильтр
      // столкновений не даст поймать
      obj.boxData.rail = rail;
      obj.setScale(CONFIG.rails[rail].scale);
      obj.setDepth(CONFIG.rails[rail].depthBox);
      s.applyFilter(obj.body, CAT.fall[rail], fallMask(rail));
    } else {
      const spec = CONFIG.boxes[name];
      obj = s.spawnFaller(`box-${name}-${color}`, spec.size, rail, {
        kind: 'box', sizeName: name, color, value: spec.value,
        penalty: spec.penalty, missPenalty: spec.missPenalty,
        densityFactor: spec.densityFactor
      });
    }
    const top = s.cargo.reduce((min, b) => Math.min(min, b.y), s.cart.y);
    s.matter.body.setPosition(obj.body, { x: s.cart.x, y: top - 70 * s.cart.scale });
    s.matter.body.setVelocity(obj.body, { x: 0, y: s.run.fallSpeed / 60 });
    return { fallSpeed: Math.round(s.run.fallSpeed), rail };
  }, kind, sizeName || 'medium');
}

async function setFallSpeed(g, value) {
  return g.eval(v => {
    const s = window.__qa.scene();
    s.run.fallSpeed = v;
    return s.run.fallSpeed;
  }, value);
}

async function prepare(g, list) {
  await g.ensureRun();
  await hold(g, 200);
  await g.clearCargo();
  await g.refillXp();
  await placeList(g, list);
  await hold(g, 1400);
}

function summarize(before, after, extra) {
  return Object.assign({
    settled: before.cargo.length,
    left: after.cargo.length,
    lost: before.cargo.length - after.cargo.length,
    maxDepth: Math.max(before.maxDepth, after.maxDepth),
    stepMs: Math.max(before.stepMs, after.stepMs)
  }, extra || {});
}

/* ---------- часть A ---------- */

// Покой длинным окном: штабель сначала оседает 3 с, и только потом начинается
// замер. Если груз уезжает в этом окне — он уезжает сам, без ввода
async function restLong(g, list) {
  await g.ensureRun();
  await hold(g, 200);
  await g.clearCargo();
  await g.refillXp();
  await placeList(g, list);
  await hold(g, 3000);

  const before = await g.state();
  await hold(g, 6000);
  const after = await g.state();

  const moved = after.cargo.map((box, i) => {
    const was = before.cargo[i];
    return was ? Math.hypot(box.dx - was.dx, box.dy - was.dy) : 0;
  });

  return summarize(before, after, {
    maxDrift: +Math.max.apply(null, [0].concat(moved)).toFixed(2),
    awake: after.cargo.filter(b => !b.sleeping).length,
    settleLost: list.length - before.cargo.length
  });
}

// Взрыв ровно в тот момент, когда тележка меняет рельсу: масштаб груза уже
// пересчитан, а твин по Y ещё идёт
async function blastDuringSwitch(g, delayMs) {
  await prepare(g, new Array(8).fill('medium'));
  const before = await g.state();

  await g.page.keyboard.press('ArrowUp');
  await g.wait(delayMs);
  await g.blastAt(0, -50);
  await hold(g, 2200);

  const after = await g.state();
  return summarize(before, after, { rail: after.rail });
}

async function blastPlain(g) {
  await prepare(g, new Array(8).fill('medium'));
  const before = await g.state();
  await g.blastAt(0, -50);
  await hold(g, 2200);
  const after = await g.state();
  return summarize(before, after, { rail: after.rail });
}

// Бомба при пустом кузове: терять нечего, но код разлёта всё равно бежит
async function bombEmpty(g) {
  await g.ensureRun();
  await hold(g, 200);
  await g.clearCargo();
  await g.refillXp();
  await hold(g, 400);

  const errorsBefore = g.errors.length;
  // XP размораживается: цена пойманной бомбы — часть проверки, что взрыв
  // на пустом кузове вообще состоялся, а не провалился мимо
  await g.freezeXp(false);
  const xpBefore = (await g.state()).xp;

  // Сначала прямой вызов разлёта на пустом кузове, затом настоящая бомба
  await g.blastAt(0, -40);
  await holdKeepFalling(g, 200);
  const drop = await dropOnCart(g, 'bomb');
  await holdKeepFalling(g, 1500);

  const after = await g.state();
  await g.freezeXp(true);
  return {
    settled: 0,
    left: after.cargo.length,
    lost: 0,
    alive: await g.eval(() => window.__qa.alive()),
    xpBefore, xpAfter: after.xp,
    fallingLeft: after.falling,
    newErrors: g.errors.slice(errorsBefore),
    fallSpeed: drop.fallSpeed
  };
}

// Ловля в момент разворота: коробка отпущена так, чтобы лечь ровно тогда,
// когда тележка меняет направление на полном ходу
async function catchInTurn(g, withTurn) {
  await prepare(g, new Array(6).fill('medium'));
  const before = await g.state();

  if (withTurn) {
    await g.drive('right', 700);
    await dropOnCart(g, 'box', 'medium');
    await g.wait(200);
    await g.drive('left', 700);
  } else {
    await dropOnCart(g, 'box', 'medium');
    await holdKeepFalling(g, 700);
  }
  await hold(g, 2000);

  const after = await g.state();
  return {
    settled: before.cargo.length,
    expected: before.cargo.length + 1,
    left: after.cargo.length,
    lost: before.cargo.length + 1 - after.cargo.length,
    maxDepth: after.maxDepth,
    stepMs: after.stepMs
  };
}

/* ---------- часть B ---------- */

// Полный кузов на дальней рельсе: масштаб 0.82, борта и радиус взрыва мельче
async function onRail(g, railDir, list, action) {
  await g.ensureRun();
  await hold(g, 200);
  await g.clearCargo();
  await g.refillXp();
  if (railDir) { await g.switchRail(railDir); await hold(g, 600); }
  const scale = await g.eval(() => window.__qa.scene().cart.scale);
  await g.clearCargo();
  await placeList(g, list);
  await hold(g, 1400);

  const before = await g.state();
  await action(g);
  await hold(g, 2000);
  const after = await g.state();

  return summarize(before, after, { scale, rail: before.rail });
}

const turn = async g => { await g.drive('right', 700); await g.drive('left', 700); };
const calm = async g => {
  for (let i = 0; i < 8; i++) { await g.drive(i % 2 ? 'left' : 'right', 150); await g.wait(300); }
};
const boom = async g => { await g.blastAt(0, -50); };

// Ловля на потолке скорости падения: к концу забега коробка бьёт по штабелю
// втрое быстрее. Строим штабель именно ловлей, а не постановкой
async function catchStack(g, fallSpeed, count) {
  await g.ensureRun();
  await hold(g, 200);
  await g.clearCargo();
  await g.refillXp();
  await setFallSpeed(g, fallSpeed);
  await hold(g, 300);

  const depths = [];
  for (let i = 0; i < count; i++) {
    await dropOnCart(g, 'box', 'medium');
    await holdKeepFalling(g, 500);
    const s = await g.state();
    depths.push(s.maxDepth);
  }
  await hold(g, 1800);
  const after = await g.state();

  return {
    fallSpeed,
    dropped: count,
    left: after.cargo.length,
    lost: count - after.cargo.length,
    maxDepth: +Math.max.apply(null, [0].concat(depths, [after.maxDepth])).toFixed(3),
    stepMs: after.stepMs,
    catchSpeedMax: +Math.max.apply(null, [0].concat(after.cargo.map(b => Math.abs(b.vy)))).toFixed(2)
  };
}

/* ---------- прогон ---------- */

async function runSeed(seed) {
  const g = await launch({ seed });
  await g.startRun();
  await g.pauseSpawn(true);
  await g.freezeXp(true);

  const out = { seed, part };

  if (part === 'a' || part === 'all') {
    out.rest_med12 = await restLong(g, new Array(12).fill('medium'));
    out.rest_mix12 = await restLong(g, mixList(12, seed));
    out.blast_switch = await blastDuringSwitch(g, 40);
    out.blast_plain = await blastPlain(g);
    out.bomb_empty = await bombEmpty(g);
    out.catch_turn = await catchInTurn(g, true);
    out.catch_calm = await catchInTurn(g, false);
  }

  if (part === 'b' || part === 'all') {
    const med12 = new Array(12).fill('medium');
    out.bomb_empty = await bombEmpty(g);
    out.front_calm12 = await onRail(g, 'down', med12, calm);
    out.front_turn12 = await onRail(g, 'down', med12, turn);
    out.back_calm12 = await onRail(g, 'up', med12, calm);
    out.back_turn12 = await onRail(g, 'up', med12, turn);
    out.front_blast5 = await onRail(g, 'down', new Array(5).fill('medium'), boom);
    out.back_blast5 = await onRail(g, 'up', new Array(5).fill('medium'), boom);
    out.catch_slow = await catchStack(g, 180, 10);
    out.catch_fast = await catchStack(g, 500, 10);
  }

  out.errors = g.errors.slice(0, 6);
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

  const keys = Object.keys(rows[0]).filter(k => rows[0][k] && typeof rows[0][k] === 'object' && !Array.isArray(rows[0][k]));
  const summary = { label, part, date: new Date().toISOString(), seeds: SEEDS, tests: {} };
  for (const k of keys) {
    summary.tests[k] = {
      lost: avg(rows, r => r[k].lost),
      lostRaw: rows.map(r => r[k].lost),
      left: avg(rows, r => r[k].left),
      leftRaw: rows.map(r => r[k].left),
      maxDepth: avg(rows, r => r[k].maxDepth),
      extra: rows.map(r => {
        const o = {};
        for (const f of ['maxDrift', 'awake', 'settleLost', 'scale', 'rail', 'alive', 'xpBefore', 'xpAfter', 'catchSpeedMax', 'fallSpeed', 'stepMs']) {
          if (r[k][f] !== undefined) o[f] = r[k][f];
        }
        return o;
      })
    };
  }
  summary.errors = rows.flatMap(r => r.errors);

  console.log(`\n=== пограничные, часть ${part}: ${label} ===`);
  for (const k of keys) {
    const t = summary.tests[k];
    console.log(`${k.padEnd(14)} потеряно ${String(t.lost).padStart(6)} [${t.lostRaw.join(' ')}]  осталось [${t.leftRaw.join(' ')}]  depth ${t.maxDepth}  ${JSON.stringify(t.extra)}`);
  }
  console.log(`ошибок в консоли: ${summary.errors.length}  ${JSON.stringify(summary.errors.slice(0, 3))}`);

  saveReport(`agent-edge-${part}-${label}.json`, { summary, rows });
}

main().catch(e => { console.error(e); process.exit(1); });
