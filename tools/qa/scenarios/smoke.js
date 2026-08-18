/* Дымовой прогон: игра запускается, ловит, сдаёт, консоль чистая.
   Гоняется после каждой правки — он ловит поломки раньше, чем замеры физики. */

const { launch, saveReport } = require('../harness');

async function main() {
  const g = await launch({ seed: 12345 });
  const checks = [];
  const ok = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  };

  await g.startRun();
  const start = await g.state();
  ok('забег стартовал', start.xp > 0 && !start.over, `XP ${start.xp}, счёт ${start.score}`);

  // Конфиг физики: важно не то, что мы написали в CONFIG, а что доехало до движка
  const engine = await g.qa('engineConfig');
  ok('конфиг доехал до Matter', engine.gravityY === 1,
    `итерации ${engine.positionIterations}/${engine.velocityIterations}, сон ${engine.enableSleeping}`);

  // Находка Н1: трение у частей составного тела, а не у родителя
  // До этапа 8.1 единицу тут ставил сам Matter: он перезаписывает friction у
  // статичного тела. Кузов стал динамическим, и значение теперь наше —
  // CONFIG.physics.inertia.cartFloorFriction
  const friction = await g.qa('cartFriction');
  const partsOk = friction.parts.every(f => f > 0.3);
  ok('трение кузова доходит до контактов', partsOk,
    `родитель ${friction.parent}, части [${friction.parts.join(', ')}], ` +
    `инерция ${friction.cargoInertia}`);

  // Ловля и сдача
  await g.pauseSpawn(true);
  await g.clearCargo();
  const placed = await g.stack('medium', 4);
  await g.wait(700);
  const loaded = await g.state();
  ok('коробки легли в кузов', loaded.cargo.length === 4, `поставлено ${placed}, лежит ${loaded.cargo.length}`);

  await g.unload();
  const unloaded = await g.state();
  const expected = 25 * 4 * 4;   // (сумма ценностей) × количество, спека 5.4
  ok('сдача начислила счёт', unloaded.score === expected,
    `счёт ${unloaded.score}, ожидалось ${expected}`);
  ok('кузов опустел', unloaded.cargo.length === 0);

  // Поток и падение
  await g.pauseSpawn(false);
  await g.wait(2500);
  const flowing = await g.state();
  ok('поток идёт', flowing.falling > 0, `в воздухе ${flowing.falling}`);

  // Езда и смена рельсы
  await g.drive('right', 500);
  const moved = await g.state();
  ok('тележка едет', moved.cartX > flowing.cartX, `${flowing.cartX} → ${moved.cartX}`);

  await g.switchRail('up');
  const railed = await g.state();
  ok('рельса переключилась', railed.rail === 0, `рельса ${railed.rail}`);

  ok('консоль чистая', g.errors.length === 0, g.errors.slice(0, 3).join(' | '));

  await g.close();

  const passed = checks.filter(c => c.pass).length;
  console.log(`\nИТОГ: ${passed}/${checks.length}`);
  saveReport('smoke.json', { date: new Date().toISOString(), passed, total: checks.length, checks });
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
