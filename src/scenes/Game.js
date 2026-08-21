import Phaser from 'phaser';
import { CONFIG, CAT, fallMask, cartMask } from '../config.js';
import { SaveManager } from '../save.js';
import { hex, textStyle } from '../ui.js';
import { playSfx, toggleMuteSetting } from '../audio.js';

/* ============================================================================
   GameScene — сам забег
   ========================================================================= */
export class GameScene extends Phaser.Scene {
  constructor() { super('GameScene'); }

  create() {
    this.cameras.main.setBackgroundColor(CONFIG.colors.bg);

    // Улучшения читаются один раз на забег и складываются в снимок
    this.applyUpgrades();

    // --- состояние забега ---
    this.run = {
      xp: this.upgrades.startXp,
      maxXp: this.upgrades.startXp,
      score: 0,
      coins: 0,
      elapsed: 0,
      fallSpeed: CONFIG.fall.speedStart,
      spawnInterval: CONFIG.fall.intervalStart,
      lastRamp: 0
    };

    this.fallingBoxes = [];   // коробки в воздухе
    this.cargo = [];          // коробки в кузове
    this.switching = false;
    this.over = false;        // забег окончен, ждём перехода на экран Game Over
    this.xpFlashUntil = 0;    // до какого времени полоса вспыхивает белым
    this.lastCatchSound = 0;
    this.lastErrorSound = 0;
    this.holdTime = 0;        // сколько мс держится текущее направление — из этого разгон
    this.holdDir = 0;
    this.swayDebt = 0;        // накопленный перепад скорости за разгон, см. swayCargo()
    this.hintTimer = null;    // таймер затухания подсказки, перезапускается по H
    this.hintFade = null;

    // Бустеры. effects — до какого времени игры действует каждый эффект;
    // lastBoosterAt и lastTypeAt — когда бустер падал в прошлый раз, из них
    // планировщик считает свои два правила (см. trySpawnPickup)
    this.effects = { shield: 0, slow: 0, rush: 0, brake: 0 };
    this.lastBoosterAt = -Infinity;
    this.lastTypeAt = {};
    Object.keys(CONFIG.pickups.types).forEach(key => { this.lastTypeAt[key] = -Infinity; });

    // На старте страницы аудиоконтекст ещё заблокирован браузером, и выставленный
    // в BootScene mute мог не примениться. Забег начинается после нажатия клавиши,
    // то есть контекст уже разблокирован — повторяем установку здесь
    const saved = SaveManager.load();
    this.sound.mute = saved.muted;
    this.sound.volume = saved.volume;
    this.bestScore = saved.bestScore;

    // Положение тележки — источник истины сцены.
    // У составного тела Matter position — это центр масс, а не пол кузова,
    // поэтому графику и границы считаем отсюда, а не из cartBody.position.
    this.cart = {
      x: CONFIG.screen.width / 2,
      y: this.railBedY(1),     // верх пола кузова
      rail: 1,                 // стартуем на передней рельсе
      scale: CONFIG.rails[1].scale,
      vx: 0,

      // Куда кузов держится по Y. При инерции тело кузова динамическое, и без
      // явной цели его продавил бы вниз собственный груз; во время смены рельсы
      // цель ведёт твин
      targetY: this.railBedY(1)
    };

    this.drawBackground();
    this.createShadows();
    this.createCart();
    this.createInput();
    this.createHud();

    // Спавн по таймеру; интервал пересоздаётся при росте темпа
    this.spawnTimer = this.time.addEvent({
      delay: this.run.spawnInterval,
      loop: true,
      callback: () => this.spawnNext()
    });

    // Бустеры идут своим ровным ритмом и от темпа не зависят: иначе на разгоне они
    // сыпались бы чаще и обесценили бы утечку XP. Таймер один на все четыре типа —
    // почему именно так, написано над trySpawnPickup().
    // Поле pickupTimer читает оснастка (harness.js, anomaly.js) — переименовывать
    // его в одиночку нельзя, только вместе с ними
    this.pickupTimer = this.time.addEvent({
      delay: CONFIG.pickups.tickMs,
      loop: true,
      callback: () => this.trySpawnPickup()
    });

    // Ловля: коробка становится грузом при первом касании тележки или груза
    this.matter.world.on('collisionstart', this.onCollisionStart, this);
  }

  /* ---------- купленные улучшения ---------- */

  // Снимок улучшений на этот забег (GAME_SPEC.md, 5.8).
  // CONFIG при этом НЕ трогаем: прибавь мы уровень прямо в CONFIG.cart.wallHeight,
  // борта росли бы с каждым перезапуском забега внутри одной вкладки
  applyUpgrades() {
    const shop = CONFIG.shop;
    const level = SaveManager.load().upgrades;

    this.upgrades = {
      wallHeight: CONFIG.cart.wallHeight + level.walls * shop.walls.step,
      startXp: CONFIG.xp.start + level.battery * shop.battery.step,
      railImpulse: CONFIG.cart.railImpulse *
        Math.pow(shop.suspension.factor, level.suspension)
    };
  }

  /* ---------- геометрия рельс ---------- */

  // Верх пола кузова на рельсе — от него считается всё остальное
  railBedY(index) {
    return Math.round(CONFIG.rails[index].yFactor * CONFIG.screen.height);
  }

  // Линия самой рельсы: колёса тележки стоят ровно на ней
  railLineY(index) {
    return this.railBedY(index) + 30 * CONFIG.rails[index].scale;
  }

  rail() { return CONFIG.rails[this.cart.rail]; }

  /* ---------- фон: полотно, пол цеха и две рельсы ---------- */
  drawBackground() {
    const { width, height } = CONFIG.screen;
    const g = this.add.graphics().setDepth(-9);

    // Полотно между рельсами: без него даже сведённые вплотную рельсы читаются
    // как две отдельные линии, а не как один путь, уходящий вглубь
    const bedTop = this.railLineY(0) - 6;
    const bedBottom = this.railLineY(1) + 20;
    g.fillStyle(CONFIG.colors.bed, 1);
    g.fillRect(0, bedTop, width, bedBottom - bedTop);

    // Пол цеха ниже передней рельсы — отделяет игровое поле от края экрана
    g.fillStyle(CONFIG.colors.ground, 1);
    g.fillRect(0, this.railLineY(1) + 26, width, height);

    CONFIG.rails.forEach((rail, index) => this.drawRail(rail, index));

  }

  // Рельса рисуется своей графикой: у задней всё тоньше, темнее и бледнее —
  // вместе с масштабом тележки это и читается как «сзади / спереди»
  drawRail(rail, index) {
    const width = CONFIG.screen.width;
    const y = this.railLineY(index);
    const s = rail.scale;
    const far = index === 0;               // задняя рельса приглушена
    const glow = CONFIG.colors[rail.glow];
    const g = this.add.graphics().setDepth(rail.depthRail);

    // Мягкое освещение: три полосы цвета рельсы с растущей плотностью.
    // Ближняя рельса заметно ярче дальней — иначе синий, который на тёмно-сером
    // контрастнее жёлтого, вытягивает дальнюю рельсу вперёд и ломает перспективу
    const dim = far ? 0.55 : 1.35;
    const layers = [
      { h: 44 * s, a: 0.05 },
      { h: 26 * s, a: 0.09 },
      { h: 11 * s, a: 0.17 }
    ];
    layers.forEach(layer => {
      g.fillStyle(glow, layer.a * dim);
      g.fillRect(0, y - layer.h / 2 + 3 * s, width, layer.h);
    });

    // Шпалы под рельсой
    const step = 60 * s;
    g.fillStyle(CONFIG.colors.sleeper, far ? 0.5 : 0.8);
    for (let x = 10; x < width; x += step) {
      g.fillRect(x, y + 6 * s, 26 * s, 10 * s);
    }

    // Сама рельса
    g.fillStyle(CONFIG.colors.rail, far ? 0.75 : 1);
    g.fillRect(0, y, width, 6 * s);

    // Тонкий блик цвета рельсы поверх — подсказка «какой цвет сюда падает»
    g.fillStyle(glow, far ? 0.35 : 0.75);
    g.fillRect(0, y, width, 2 * s);
  }

  /* ---------- тени падающих коробок ---------- */

  // По слою на рельсу: тень лежит НА своей рельсе, но ПОД коробками, а у одной
  // Graphics глубина всего одна — двумя рельсами в один слой не уложиться
  createShadows() {
    this.shadowLayers = CONFIG.rails.map(
      rail => this.add.graphics().setDepth(rail.depthRail + 0.5));
  }

  drawShadows() {
    const s = CONFIG.shadows;
    this.shadowLayers.forEach(layer => layer.clear());

    this.fallingBoxes.forEach(box => {
      const railIndex = box.boxData.rail;
      const railY = this.railLineY(railIndex);

      // Колонка начинается у нижней грани коробки и упирается в линию рельсы.
      // Верх обрезается краем экрана: коробка спавнится выше него
      let top = Math.max(0, box.y + box.displayHeight / 2);
      if (s.maxLength > 0) top = Math.max(top, railY - s.maxLength);
      if (top >= railY) return;              // коробка уже на рельсе — колонка не нужна

      const width = box.displayWidth * s.width;
      const x = box.x - width / 2;
      const layer = this.shadowLayers[railIndex];

      // У Graphics нет градиентной заливки, поэтому колонка режется на сегменты
      // с растущей плотностью. Границы округляются: внахлёст два полупрозрачных
      // прямоугольника дали бы тёмную полосу на стыке, а с зазором — светлый шов
      for (let i = 0; i < s.steps; i++) {
        const y0 = Math.round(top + (railY - top) * i / s.steps);
        const y1 = Math.round(top + (railY - top) * (i + 1) / s.steps);
        const t = (i + 1) / s.steps;         // 0 у коробки, 1 у рельсы
        layer.fillStyle(0x000000, s.alphaTop + (s.alphaBase - s.alphaTop) * t);
        layer.fillRect(x, y0, width, y1 - y0);
      }

      // Пятка на самой рельсе: точка посадки читается, даже когда колонка короткая
      const base = s.baseHeight * CONFIG.rails[railIndex].scale;
      layer.fillStyle(0x000000, s.alphaBase);
      layer.fillRect(x, railY - base / 2, width, base);
    });
  }

  /* ---------- тележка ---------- */
  createCart() {
    this.cartGraphics = this.add.graphics();
    this.buildCartBody();
    this.drawCart();
  }

  // Тело пересобирается при смене рельсы: масштаб другой, а Body.scale на
  // статичном составном теле копит погрешность — проще собрать заново
  buildCartBody() {
    if (this.cartBody) this.matter.world.remove(this.cartBody);

    const c = CONFIG.cart;
    const s = this.cart.scale;
    const x = this.cart.x;
    const bedY = this.cart.y;
    const w = c.width * s;
    const ft = c.floorThickness * s;
    const wh = this.upgrades.wallHeight * s;   // высота бортов растёт от улучшения
    const wt = c.wallThickness * s;

    // Дно и два борта. Перегородки в середине нет: кузов единый.
    //
    // Материал задаётся КАЖДОЙ части: столкновения составного тела Matter считает
    // по частям, и свойство на родителе до контакта не доходит.
    //
    // Кузов статичен: груз переносится вместе с ним, а крен на манёврах даёт
    // swayCargo(). У статичного тела friction задавать бесполезно — Body.setStatic
    // всё равно перезапишет его на 1 (и restitution на 0), поэтому трение контакта
    // «коробка-дно» живёт в CONFIG.physics.boxFriction
    const surface = {
      frictionStatic: CONFIG.physics.boxFrictionStatic,
      slop: CONFIG.physics.contactSlop
    };
    const floor = this.matter.bodies.rectangle(x, bedY + ft / 2, w, ft, surface);
    const leftWall = this.matter.bodies.rectangle(x - w / 2 + wt / 2, bedY - wh / 2, wt, wh, surface);
    const rightWall = this.matter.bodies.rectangle(x + w / 2 - wt / 2, bedY - wh / 2, wt, wh, surface);

    this.cartBody = this.matter.body.create({
      parts: [floor, leftWall, rightWall],
      isStatic: true,
      label: 'cart'
    });

    this.applyFilter(this.cartBody, CAT.cart[this.cart.rail], cartMask(this.cart.rail));
    this.matter.world.add(this.cartBody);
  }

  // Фильтр столкновений нужно проставить каждой части составного тела
  applyFilter(body, category, mask) {
    const parts = body.parts && body.parts.length > 1 ? body.parts : [body];
    parts.forEach(part => {
      part.collisionFilter.category = category;
      part.collisionFilter.mask = mask;
    });
    body.collisionFilter.category = category;
    body.collisionFilter.mask = mask;
  }

  drawCart() {
    const c = CONFIG.cart;
    const s = this.cart.scale;
    const g = this.cartGraphics;
    const x = this.cart.x;
    const bedY = this.cart.y;
    const w = c.width * s;
    const half = w / 2;
    const ft = c.floorThickness * s;
    const wh = this.upgrades.wallHeight * s;   // высота бортов растёт от улучшения
    const wt = c.wallThickness * s;

    g.clear();
    g.setDepth(this.rail().depthCart);

    // Тень: у дальней тележки слабее — это тоже подсказка глубины
    g.fillStyle(0x000000, 0.28 * s);
    g.fillEllipse(x, bedY + ft + 16 * s, w * 0.95, 12 * s);

    // Дно
    g.fillStyle(CONFIG.colors.cart, 1);
    g.fillRect(x - half, bedY, w, ft);

    // Борта — оба серые, деления кузова на секции больше нет
    g.fillStyle(CONFIG.colors.cartDark, 1);
    g.fillRect(x - half, bedY - wh, wt, wh);
    g.fillRect(x + half - wt, bedY - wh, wt, wh);

    // Колёса стоят на линии рельсы
    g.fillStyle(0x24272b, 1);
    g.fillCircle(x - half * 0.55, bedY + ft + 9 * s, 9 * s);
    g.fillCircle(x + half * 0.55, bedY + ft + 9 * s, 9 * s);
  }

  /* ---------- ввод ---------- */
  createInput() {
    const kb = this.input.keyboard;

    // Горизонтальный ход — по удержанию клавиши, опрашивается в update()
    this.keys = kb.addKeys({
      left: Phaser.Input.Keyboard.KeyCodes.LEFT,
      right: Phaser.Input.Keyboard.KeyCodes.RIGHT,
      a: Phaser.Input.Keyboard.KeyCodes.A,
      d: Phaser.Input.Keyboard.KeyCodes.D
    });

    // Смена рельсы — разовое событие
    kb.on('keydown-UP', () => this.switchRail(-1));
    kb.on('keydown-W', () => this.switchRail(-1));
    kb.on('keydown-DOWN', () => this.switchRail(1));
    kb.on('keydown-S', () => this.switchRail(1));

    // Сдача груза появится на этапе 2; сейчас пробел просто чистит кузов,
    // чтобы можно было проверить физику накопления
    kb.on('keydown-SPACE', () => this.unloadCargo());

    kb.on('keydown-ESC', () => this.pauseGame());
    kb.on('keydown-P', () => this.pauseGame());

    kb.on('keydown-M', () => this.toggleMute());
    kb.on('keydown-H', () => this.showHint());
  }

  // Отдельного экрана громкости в проекте не будет (anti-scope 16.9),
  // но выключить звук игрок должен мочь: клавишей M на десктопе и кнопкой
  // на экране паузы с телефона, где клавиатуры нет
  toggleMute() {
    const muted = toggleMuteSetting(this);
    this.showPopup(muted ? 'звук выкл' : 'звук вкл', CONFIG.colors.textDim);
  }

  /* ---------- тележка как физическое тело ---------- */

  /* ---------- горизонтальный ход ---------- */
  driveCart(delta) {
    const c = CONFIG.cart;
    const left = this.keys.left.isDown || this.keys.a.isDown;
    const right = this.keys.right.isDown || this.keys.d.isDown;
    let dir = (left ? -1 : 0) + (right ? 1 : 0);

    // Разгон при удержании: чем дольше держишь одну стрелку, тем быстрее едет тележка.
    // Отпустил или развернулся — счётчик обнуляется, разгон начинается заново.
    // Плата за скорость честная: разогнанная тележка на торможении сильнее бьёт по штабелю
    if (dir === 0 || dir !== this.holdDir) this.holdTime = 0;
    this.holdDir = dir;
    if (dir !== 0) this.holdTime += delta;

    // Ускорение множит и базовую, и максимальную скорость: пропорция сохраняется,
    // а значит рывок по грузу считается ровно так же — см. maxCartSpeed()
    const boost = this.cartSpeedScale();
    const speed = Phaser.Math.Linear(
      c.speedBase, c.speedMax, Math.min(1, this.holdTime / c.accelTime)) * boost;

    // Упор в края экрана
    const half = (c.width * this.cart.scale) / 2;
    const minX = half;
    const maxX = CONFIG.screen.width - half;

    let vx = dir * speed;
    if ((this.cart.x <= minX && vx < 0) || (this.cart.x >= maxX && vx > 0)) vx = 0;

    // Рывок — разница скоростей: старт, торможение или разворот
    const dvx = vx - this.cart.vx;
    if (dvx !== 0) this.swayCargo(dvx);
    this.cart.vx = vx;

    if (vx === 0) return;

    const nextX = Phaser.Math.Clamp(this.cart.x + vx * delta / 1000, minX, maxX);
    this.moveCartBy(nextX - this.cart.x, 0);
  }

  /* Множитель скорости тележки. Ускорение и тормоз ПЕРЕМНОЖАЮТСЯ (1.35 × 0.6 = 0.81),
     а не перебивают друг друга. Отдельная ветка «кто главнее» не нужна и была бы
     вредна: maxCartSpeed() берёт мерку рывка отсюда же, и любое ветвление здесь
     разъехалось бы с физикой груза. */
  cartSpeedScale() {
    const t = CONFIG.pickups.types;
    return (this.hasEffect('rush') ? t.rush.factor : 1)
      * (this.hasEffect('brake') ? t.brake.factor : 1);
  }

  /* Максимальная скорость тележки ПРЯМО СЕЙЧАС — мерка для силы рывка.
     Нормировать по константе CONFIG.cart.speedMax нельзя: под ускорением разворот
     давал бы k = 2.7 вместо 2, а кривая swayPower = 2.8 превращает это в силу 15.6
     против 6.96 — вдвое злее обычного разворота. Бустер задуман двойственным
     (разогнанной тележкой легче промахнуться мимо коробки), а не самоубийственным. */
  maxCartSpeed() {
    return CONFIG.cart.speedMax * this.cartSpeedScale();
  }

  // Груз кренится в сторону, обратную рывку: высокий штабель может развалиться.
  // Это и есть ограничитель забега — физика вместо лимита вместимости.
  //
  // Рывки бывают двух разных сортов, и мерить их одной меркой нельзя.
  //
  // 1. РАЗОВЫЕ — старт с места, резкий стоп, разворот. Перепад скорости приходит
  //    одним кадром, k доходит до 2. Порог swayMinK их пропускает, кривая swayPower
  //    делает разворот заметно злее старта. Это работало и работает.
  // 2. РАЗГОН при удержании стрелки. Скорость ползёт с speedBase до speedMax за
  //    accelTime — около 10 px/с за кадр, то есть k ≈ 0.013 при пороге 0.08. Каждый
  //    кадр разгона порог отбрасывал, и до груза не доходило НИЧЕГО: плейтест
  //    20.08.2026 так и сказал — «взял ускорение, а физика не работает».
  //
  // Отброшенное копим в swayDebt и отпускаем одним толчком по swayAccelK. Кривая для
  // него ЛИНЕЙНАЯ, а не swayPower, и усилена swayAccelGain. Обе меры нужны из-за
  // порога срыва покоя boxFrictionStatic = 1.0: слабый импульс до груза доходит, но
  // не сдвигает его ни на пиксель. В степени 2.8 накопленные 0.25 дали бы 0.022,
  // линейно — 0.25, и оба варианта плейтест назвал «стоят как камень». С множителем
  // выходит 1.5 — пятая часть разворота, и верхняя коробка едет на 20 px вместо 4.5.
  // Ронять груз по-прежнему должен манёвр: разгон качает штабель, но сам по себе
  // забег не убивает
  swayCargo(dvx) {
    if (this.cargo.length === 0) { this.swayDebt = 0; return; }
    const c = CONFIG.cart;
    const k = Math.abs(dvx) / this.maxCartSpeed();   // 1 — старт или стоп, 2 — разворот

    // Разовый рывок перебивает накопленное: после старта, стопа или разворота
    // штабель уже качнуло сильнее, чем на всё, что успело скопиться
    if (k >= c.swayMinK) {
      this.swayDebt = 0;
      this.pushCargo(-Math.sign(dvx), Math.pow(k, c.swayPower));
      return;
    }

    // Смена знака сбрасывает буфер: разгон вправо не должен доплачивать
    // за недобранное торможение влево
    if (this.swayDebt * dvx < 0) this.swayDebt = 0;
    this.swayDebt += dvx;

    const debtK = Math.abs(this.swayDebt) / this.maxCartSpeed();
    if (debtK < c.swayAccelK) return;

    const dir = -Math.sign(this.swayDebt);
    this.swayDebt = 0;
    this.pushCargo(dir, debtK * c.swayAccelGain);
  }

  // Общий толчок штабелю. dir — куда кренить (−1 или 1), force — уже посчитанная
  // сила: разовый рывок приносит её по кривой swayPower, разгон — линейно
  pushCargo(dir, force) {
    const c = CONFIG.cart;
    const push = dir * c.swayImpulse * force * this.impulseScale();
    const ref = this.refMass();

    this.cargo.forEach(box => {
      const gain = this.topFactor(box) * this.massFactor(box, ref);
      this.matter.body.setVelocity(box.body, {
        x: box.body.velocity.x + push * gain,
        y: box.body.velocity.y
      });
      this.matter.body.setAngularVelocity(box.body, box.body.angularVelocity +
        Phaser.Math.FloatBetween(-c.swaySpin, c.swaySpin) * force * gain);
    });
  }

  // Опорная масса — средняя коробка на текущей рельсе: импульсы в CONFIG заданы
  // для неё. Масштаб рельсы входит в квадрате, иначе на дальней рельсе всё было
  // бы легче и любой толчок сильнее
  refMass() {
    const p = CONFIG.physics;
    const spec = CONFIG.boxes[p.massRefSize];
    const s = this.cart.scale;
    return spec.size * spec.size * s * s * p.boxDensity * spec.densityFactor;
  }

  // Лёгкую коробку сносит сильнее, тяжёлую качает. massInfluence — рубильник:
  // 0 возвращает прежнее поведение, 1 даёт честное dv = J / m
  massFactor(box, ref) {
    const p = CONFIG.physics;
    return Phaser.Math.Clamp(
      Math.pow(ref / box.body.mass, p.massInfluence), p.massFactorMin, p.massFactorMax);
  }

  // Чем выше коробка лежит в кузове, тем сильнее её сносит: низ прижат весом
  // штабеля, верх держится одним трением. Именно поэтому резкий манёвр срывает
  // верхушку, а не разваливает груз целиком — и поэтому высокий штабель рискован
  topFactor(box) {
    const height = Math.max(0, this.cart.y - box.y);
    return 1 + CONFIG.cart.swayTopFactor * height / (100 * this.cart.scale);
  }

  // Импульсы груза заданы для передней рельсы. На задней и борта, и порог вылета
  // за борт уменьшены в 0.82 — значит и толчок обязан уменьшиться так же. Без
  // этого один и тот же разворот сзади выносил полкузова, а спереди почти ничего
  impulseScale() {
    // Квадрат, а не сам масштаб. Импульс задаётся как скорость, и дальность
    // разлёта идёт как её квадрат, а вот борт и порог вылета уменьшаются линейно.
    // Замер подтвердил: при линейном гашении разворот сзади терял 3.6 коробки
    // против 0.4 спереди
    return Math.pow(this.cart.scale, CONFIG.cart.railScalePower);
  }

  // Телепорт тележки вместе с грузом на одну и ту же дельту. При инерции обычный
  // ход через него больше не идёт — остаётся расстановка перед замером
  // (tools/qa/scenarios/stability.js) и смена рельсы у старой модели
  moveCartBy(dx, dy) {
    if (dx === 0 && dy === 0) return;

    this.cart.x += dx;
    this.cart.y += dy;
    this.cart.targetY = this.cart.y;

    this.matter.body.translate(this.cartBody, { x: dx, y: dy });
    this.cargo.forEach(box => this.matter.body.translate(box.body, { x: dx, y: dy }));
  }

  /* ---------- смена рельсы ---------- */
  switchRail(direction) {
    if (this.switching) return;

    const next = Phaser.Math.Clamp(this.cart.rail + direction, 0, CONFIG.rails.length - 1);
    if (next === this.cart.rail) return;

    const ratio = CONFIG.rails[next].scale / this.cart.scale;
    this.cart.rail = next;
    this.cart.scale = CONFIG.rails[next].scale;
    this.switching = true;

    // Груз получает толчок: резкий манёвр всегда рискует штабелем.
    // Мягкая подвеска из магазина этот толчок гасит
    // Масса и масштаб рельсы — те же множители, что у рывка и у взрыва: один
    // набор правил на все три воздействия, иначе они разъедутся при первой правке
    const impulse = this.upgrades.railImpulse * this.impulseScale();
    const ref = this.refMass();

    this.cargo.forEach(box => {
      const m = this.massFactor(box, ref);
      this.matter.body.setVelocity(box.body, {
        x: Phaser.Math.FloatBetween(-impulse, impulse) * m,
        y: box.body.velocity.y - impulse * 0.4 * m
      });
      this.matter.body.setAngularVelocity(box.body, Phaser.Math.FloatBetween(-0.08, 0.08) * m);
    });

    // Груз меняет масштаб вместе с тележкой. Равномерное масштабирование
    // относительно центра сохраняет взаимное расположение — штабель не слипается
    this.cargo.forEach(box => {
      box.setScale(this.cart.scale);
      this.matter.body.setPosition(box.body, {
        x: this.cart.x + (box.x - this.cart.x) * ratio,
        y: this.cart.y + (box.y - this.cart.y) * ratio
      });
      box.setDepth(CONFIG.rails[next].depthBox);
      this.applyFilter(box.body, CAT.cart[next], cartMask(next));
    });

    this.buildCartBody();

    // Тележка едет твином, груз переносится тем же смещением по Y
    const state = { y: this.cart.y };
    const target = this.railBedY(next);

    this.tweens.add({
      targets: state,
      y: target,
      duration: CONFIG.cart.switchDuration,
      ease: 'Quad.easeOut',
      // Груз едет с кузовом и здесь — даже при инерции. Расстояние между рельсами
      // это ПЕРСПЕКТИВА, а не настоящая высота: тележка не подпрыгивает на метр,
      // она отъезжает вглубь цеха. Уронить груз на неё физикой значит наказать за
      // переезд, которого в мире игры не было. Замер это подтвердил числом: когда
      // кузов уезжал по Y один, смена рельсы выносила 6 коробок из 8 при цели 1-3.
      // За тряску на переезде отвечает railImpulse, а не мнимое падение
      onUpdate: () => this.moveCartBy(0, state.y - this.cart.y),
      onComplete: () => { this.switching = false; }
    });
  }

  /* ---------- спавн падающих объектов ---------- */

  // Что прилетит следующим. С 30-й секунды часть спавнов занимают бомбы:
  // первые полминуты игрок осваивается с одним только потоком коробок
  spawnNext() {
    // Поток не сыплет больше, чем игрок физически способен разобрать
    if (this.fallingBoxes.length >= CONFIG.fall.maxInAir) return;

    const b = CONFIG.bombs;
    if (this.run.elapsed >= b.afterMs && Math.random() < b.chance) {
      this.spawnBomb();
      return;
    }
    this.spawnBox();
  }

  // Рельса выбирается 50/50 для всего, что падает
  randomRail() {
    return Math.random() < 0.5 ? 0 : 1;
  }

  // Общая часть всех падающих объектов: тело, масштаб рельсы, фильтр столкновений,
  // отсутствие гравитации в полёте и постоянная скорость.
  // missPenalty по умолчанию 0 — пропустить бомбу или бустер ничего не стоит
  spawnFaller(texture, sizePx, railIndex, data) {
    const rail = CONFIG.rails[railIndex];

    // Объект может появиться в любой точке по ширине — тележка его догоняет
    const margin = sizePx * rail.scale / 2 + 8;
    const x = Phaser.Math.Between(margin, CONFIG.screen.width - margin);

    const p = CONFIG.physics;
    const obj = this.matter.add.image(x, -sizePx, texture, null, {
      friction: p.boxFriction,
      frictionStatic: p.boxFrictionStatic,
      frictionAir: p.boxFrictionAir,
      restitution: p.boxRestitution,
      slop: p.contactSlop,
      density: p.boxDensity * (data.densityFactor || 1)
    });

    // setScale у Matter-объекта Phaser масштабирует и картинку, и тело
    obj.setScale(rail.scale);
    obj.setDepth(rail.depthBox);
    this.applyFilter(obj.body, CAT.fall[railIndex], fallMask(railIndex));

    obj.boxData = Object.assign(
      { kind: 'box', rail: railIndex, state: 'falling', missPenalty: 0 }, data);

    // В полёте гравитации нет: скорость держится ровно такой, как в спеке,
    // и переназначается каждый кадр (иначе frictionAir погасит её на лету)
    obj.setIgnoreGravity(true);
    obj.setVelocity(0, this.currentFallSpeed() / 60);

    this.fallingBoxes.push(obj);
    return obj;
  }

  spawnBox() {
    const sizeName = this.pickSize();
    const spec = CONFIG.boxes[sizeName];

    // Сначала выбирается рельса, а цвет жёстко следует из неё:
    // синие падают только на заднюю, жёлтые только на переднюю
    const railIndex = this.randomRail();
    const rail = CONFIG.rails[railIndex];

    this.spawnFaller(`box-${sizeName}-${rail.color}`, spec.size, railIndex, {
      kind: 'box',
      sizeName,
      densityFactor: spec.densityFactor,
      color: rail.color,
      value: spec.value,
      penalty: spec.penalty,
      missPenalty: spec.missPenalty
    });
  }

  // Бомба летит на случайную рельсу наравне с коробками: уехать на другую рельсу —
  // законный способ увернуться, ради этого рельсы и разведены категориями Matter
  spawnBomb() {
    this.spawnFaller('bomb', CONFIG.bombs.size, this.randomRail(), { kind: 'bomb' });
  }

  /* Планировщик бустеров. Один тик на все четыре типа, а не четыре независимых
     таймера: оба правила против каши — «не больше maxInAir в воздухе» и «не меньше
     minGapMs между любыми двумя» — общие, и согласовывать их между независимыми
     таймерами пришлось бы теми же полями, только размазанными по четырём колбэкам. */
  trySpawnPickup() {
    if (this.over) return;

    const c = CONFIG.pickups;
    const now = this.run.elapsed;

    // Правило 1: в воздухе не больше maxInAir
    const inAir = this.fallingBoxes.filter(o => o.boxData.kind === 'pickup').length;
    if (inAir >= c.maxInAir) return;

    // Правило 2: пауза между любыми двумя бустерами
    if (now - this.lastBoosterAt < c.minGapMs) return;

    // Готовые типы: наступила их секунда и прошёл их период
    const ready = Object.entries(c.types).filter(([key, spec]) =>
      now >= spec.afterMs && now - this.lastTypeAt[key] >= spec.everyMs);
    if (ready.length === 0) return;

    // Из готовых берём тот, что ждёт дольше всех. Случайный выбор дал бы редким
    // типам проигрывать частым бесконечно: щит с периодом 40 с почти всегда
    // конкурировал бы с XP, у которого период 25 с
    const [key] = ready.reduce((best, item) =>
      this.lastTypeAt[item[0]] < this.lastTypeAt[best[0]] ? item : best);

    this.lastBoosterAt = now;
    this.lastTypeAt[key] = now;
    this.spawnPickup(key);
  }

  spawnPickup(key) {
    this.spawnFaller(`pickup-${key}`, CONFIG.pickups.size, this.randomRail(),
      { kind: 'pickup', pickup: key });
  }

  // Выбор размера по весам из CONFIG
  pickSize() {
    const entries = Object.entries(CONFIG.boxes);
    const total = entries.reduce((sum, [, spec]) => sum + spec.weight, 0);
    let roll = Math.random() * total;
    for (const [name, spec] of entries) {
      roll -= spec.weight;
      if (roll <= 0) return name;
    }
    return entries[0][0];
  }

  /* ---------- ловля ---------- */
  onCollisionStart(event) {
    event.pairs.forEach(pair => {
      const box = this.resolveFallingBox(pair.bodyA) || this.resolveFallingBox(pair.bodyB);
      if (!box) return;

      const other = this.resolveFallingBox(pair.bodyA) ? pair.bodyB : pair.bodyA;

      // Объект ловится и когда лёг на тележку, и когда лёг на уже накопленный
      // груз — иначе верхние коробки продавливали бы штабель
      if (this.isCartPart(other) || this.isCargoBody(other)) {
        this.catchFaller(box);
      }
    });
  }

  // Тело принадлежит тележке, если это она сама или одна из её частей
  isCartPart(body) {
    return body === this.cartBody || body.parent === this.cartBody;
  }

  isCargoBody(body) {
    const go = body.gameObject;
    return !!(go && go.boxData && go.boxData.state === 'cargo');
  }

  resolveFallingBox(body) {
    const go = body.gameObject;
    if (go && go.boxData && go.boxData.state === 'falling') return go;
    return null;
  }

  // Что делает пойманное, зависит от вида: коробка ложится в кузов, бомба рвёт
  // штабель, бустер возвращает XP
  catchFaller(obj) {
    if (obj.boxData.kind === 'bomb') return this.explodeBomb(obj);
    if (obj.boxData.kind === 'pickup') return this.collectPickup(obj);
    this.acceptBox(obj);
  }

  // Убрать пойманный объект из воздуха, не делая его грузом
  consumeFaller(obj, state) {
    obj.boxData.state = state;
    this.fallingBoxes = this.fallingBoxes.filter(item => item !== obj);
    obj.destroy();
  }

  // Бомба: −100 XP плюс разлетевшийся штабель. Основное наказание — второе,
  // поэтому импульс заметно сильнее, чем при смене рельсы (GAME_SPEC.md, 5.6)
  explodeBomb(bomb) {
    const b = CONFIG.bombs;
    const x = bomb.x;
    const y = bomb.y;

    this.consumeFaller(bomb, 'exploded');

    // Щит гасит бомбу ЦЕЛИКОМ — и штраф, и разлёт штабеля. Половинчатый вариант
    // (гасить только XP) почти ничего бы не стоил: прямой штраф бомбы это 20 %
    // расхода XP за забег, а выброшенный ею груз — куда больше
    if (this.hasEffect('shield')) {
      this.effects.shield = 0;
      playSfx(this, 'deliver', { detune: CONFIG.audio.shieldDetune });
      this.burstParticles(b.blastParticles, CONFIG.pickups.types.shield.color, x, y);
      this.showPickupPopup('Щит принял удар', CONFIG.pickups.types.shield.color);
      return;
    }

    this.blastCargo(x, y);

    // Взрыв — тот же error.ogg, но сильно ниже и оттого длиннее и глуше.
    // Отдельного сэмпла в assets/audio/ пока нет
    this.playErrorSound(CONFIG.audio.blastDetune);
    this.cameras.main.shake(b.shakeMs, 0.012);
    this.burstParticles(b.blastParticles, CONFIG.colors.danger, x, y);
    this.xpFlashUntil = this.time.now + CONFIG.hud.flashDuration;
    this.showPopup(`−${b.penalty} XP`, hex(CONFIG.colors.danger));
    this.spendXp(b.penalty);
  }

  // Подбор предмета. Что именно он делает, решает поле pickup; общее здесь —
  // объект съедается, играет звук и всплывает подпись в правом верхнем углу.
  // Дебафф звучит своим звуком: подобрать его — ошибка, и радостный «дилинь»
  // на ней сбивал бы с толку сильнее, чем отсутствие звука вовсе
  collectPickup(obj) {
    const key = obj.boxData.pickup;
    const spec = CONFIG.pickups.types[key];
    this.consumeFaller(obj, 'collected');

    if (spec.bad) this.playErrorSound();
    else playSfx(this, 'deliver', { detune: CONFIG.audio.boosterDetune });

    this.showPickupPopup(this.applyPickup(key, spec), spec.color);
  }

  // Возвращает подпись для всплывашки: у каждого предмета она своя, потому что
  // сказать надо разное — сколько XP добавилось, сколько секунд действует эффект
  applyPickup(key, spec) {
    if (key === 'xp') {
      const before = this.run.xp;
      this.run.xp = Math.min(this.run.maxXp, this.run.xp + spec.amount);
      const gained = this.run.xp - before;
      // На полном запасе бустер не даёт ничего, и «+0 XP» выглядело бы как баг
      return gained > 0 ? `+${gained} XP` : 'XP полон';
    }

    if (key === 'shield') {
      // Щит не копится: второй подобранный продлевает срок, а не даёт два заряда.
      // Иначе игрок накапливал бы их и переставал бояться бомб вовсе
      this.effects.shield = this.run.elapsed + spec.holdMs;
      return 'Щит';
    }

    this.effects[key] = this.run.elapsed + spec.durationMs;
    return `${spec.title} ${spec.durationMs / 1000} с`;
  }

  // Активен ли эффект прямо сейчас. Время игровое (run.elapsed), а не this.time.now:
  // на паузе забег стоит, и эффект не должен утекать, пока игрок смотрит меню
  hasEffect(key) {
    return this.run.elapsed < this.effects[key];
  }

  // Секций и «чужого цвета» больше нет: коробка своей рельсы всегда принимается
  // и остаётся в кузове физическим телом. Жёлтая просто ложится поверх синей.
  acceptBox(box) {
    box.boxData.state = 'cargo';
    box.setIgnoreGravity(false);
    this.applyFilter(box.body, CAT.cart[this.cart.rail], cartMask(this.cart.rail));

    // За забег скорость падения растёт втрое, а энергия удара по штабелю — в семь
    // раз, ровно к тому моменту, когда штабель высокий. Режем только позднюю
    // эскалацию: до 300 px/с коробка садится ровно так же, как раньше
    const cap = CONFIG.physics.catchMaxSpeed;
    if (box.body.velocity.y > cap) {
      this.matter.body.setVelocity(box.body, { x: box.body.velocity.x, y: cap });
    }

    this.fallingBoxes = this.fallingBoxes.filter(b => b !== box);
    this.cargo.push(box);

    // Пачка коробок, легшая одновременно, не должна давать пачку «туков»
    if (this.time.now - this.lastCatchSound >= CONFIG.audio.catchCooldown) {
      this.lastCatchSound = this.time.now;
      this.playCatchSound();
    }
  }

  // Тон «тука» растёт с каждой коробкой в кузове и сам сбрасывается после сдачи:
  // серия ловель звучит восходящей фразой, а не десятком одинаковых ударов подряд.
  // Сбрасывать вручную нечего — высота считается прямо из размера штабеля
  playCatchSound() {
    const a = CONFIG.audio;
    const step = Math.min(this.cargo.length - 1, a.catchSteps);

    playSfx(this, 'catch', {
      volume: a.catchVolume,
      detune: step * a.catchStep + Phaser.Math.Between(-a.catchJitter, a.catchJitter)
    });
  }

  // Радиальный разлёт от точки взрыва. Три множителя, у каждого свой смысл:
  // расстояние (дальняя коробка почти не сдвинется), масса (лёгкую сносит, тяжёлую
  // качает) и постоянная добавка вверх. Числа коробок здесь нет намеренно: сколько
  // улетит за борт, решает checkCargoOverboard в следующих кадрах
  blastCargo(bx, by) {
    const b = CONFIG.bombs;
    const ref = this.refMass();
    const radius = b.blastRadius * this.cart.scale;   // радиус — длина, масштаб обязателен

    this.cargo.forEach(box => {
      const dx = box.x - bx;
      const dy = box.y - by;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) return;                      // за радиусом коробка остаётся на месте

      // Затухание линейное с полом. Обратный квадрат не даёт границы вовсе, и
      // «сколько улетит» перестало бы зависеть от того, где поймана бомба
      const falloff = b.blastMin + (1 - b.blastMin) * (1 - dist / radius);

      // Коробка ровно в эпицентре направления не имеет — её просто подбрасывает
      let nx = dist > 1 ? dx / dist : Phaser.Math.FloatBetween(-0.5, 0.5);
      let ny = dist > 1 ? dy / dist : 0;

      ny = Math.min(ny - b.blastUp, -b.blastMinUp);   // вниз — никогда
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;

      const speed = b.blastImpulse * falloff * this.massFactor(box, ref) * this.impulseScale();

      this.matter.body.setVelocity(box.body, { x: nx * speed, y: ny * speed });
      this.matter.body.setAngularVelocity(box.body,
        Phaser.Math.FloatBetween(-b.blastSpin, b.blastSpin) * falloff);
    });
  }

  /* ---------- сдача груза ---------- */

  // Суммарная ценность груза. От неё считаются и очки, и монеты — по разным
  // формулам, но от одного числа, чтобы они не разошлись
  cargoSum() {
    return this.cargo.reduce((sum, box) => sum + box.boxData.value, 0);
  }

  // Цена сдачи в ОЧКАХ: сумма ценностей × количество (GAME_SPEC.md, 5.4).
  // Квадратичность намеренная: копить выгоднее, чем сдавать по одной
  cargoValue() {
    const count = this.cargo.length;
    if (count === 0) return 0;
    return this.cargoSum() * count;
  }

  // Цвет большинства коробок в кузове: им красятся и ярлык цены, и частицы сдачи —
  // сразу видно, что именно уехало
  cargoTint() {
    const blues = this.cargo.filter(b => b.boxData.color === 'blue').length;
    return blues * 2 > this.cargo.length ? CONFIG.colors.boxBlue : CONFIG.colors.boxYellow;
  }

  unloadCargo() {
    if (this.cargo.length === 0) return;   // пустой кузов не наказывается

    const gained = this.cargoValue();
    const count = this.cargo.length;
    const tint = this.cargoTint();

    this.run.score += gained;
    this.run.coins += Math.round(this.cargoSum() * CONFIG.coins.rate);
    this.cargo.forEach(box => box.destroy());
    this.cargo = [];

    playSfx(this, 'deliver');
    this.burstParticles(count, tint);
    this.showPopup(`+${gained}`, hex(tint));
  }

  // Одноразовый выброс частиц из кузова: эмиттер сам себя убирает,
  // иначе за забег их накопились бы сотни
  burstParticles(count, tint, x, y) {
    const p = CONFIG.particles;
    const amount = Math.min(p.max, count * p.perBox);

    // По умолчанию бьёт из кузова (сдача груза); взрыв бомбы задаёт свою точку
    const px = x === undefined ? this.cart.x : x;
    const py = y === undefined ? this.cart.y - 10 : y;

    const emitter = this.add.particles(px, py, 'particle', {
      speed: { min: p.speed * 0.35, max: p.speed },
      angle: { min: 200, max: 340 },
      lifespan: p.lifespan,
      gravityY: 420,
      scale: { start: this.cart.scale, end: 0 },
      tint,
      emitting: false
    });
    emitter.setDepth(this.rail().depthBox + 1);
    emitter.explode(amount);

    this.time.delayedCall(p.lifespan + 200, () => emitter.destroy());
  }

  /* ---------- XP и конец забега ---------- */

  // Две траты XP: груз за бортом и промах. Общая часть — снять и проверить ноль
  spendXp(amount) {
    this.run.xp = Math.max(0, this.run.xp - amount);
    if (this.run.xp === 0) this.endRun();
  }

  // Груз вывалился за борт — ошибка игрока, и она заявляет о себе громко
  penalizeDrop(amount) {
    this.flashError();
    this.playErrorSound();
    // Вспышка полосы — флагом времени, а не твином: отрисовка полосы читает флаг
    this.xpFlashUntil = this.time.now + CONFIG.hud.flashDuration;
    this.showPopup(`−${amount} XP`, hex(CONFIG.colors.danger));
    this.spendXp(amount);
  }

  // Промах — тихий штраф (ADR-0003). Промахов бывает 20+ в минуту на старте и до 85
  // на потолке разгона: тряска камеры и звук ошибки на каждом сделали бы игру
  // неиграбельной. Остаётся только мелкое число в точке падения
  penalizeMiss(amount, x, y) {
    this.showMissLabel(x, y, `−${amount}`);
    this.spendXp(amount);
  }

  endRun() {
    if (this.over) return;
    this.over = true;

    playSfx(this, 'gameover');
    this.spawnTimer.remove();
    this.pickupTimer.remove();
    this.matter.world.off('collisionstart', this.onCollisionStart, this);

    // Итог забега записывается здесь, а не на экране Game Over: на тот экран можно
    // вернуться из магазина, и его create() начислил бы валюту второй раз
    const save = SaveManager.load();
    const isRecord = this.run.score > save.bestScore;
    if (isRecord) save.bestScore = this.run.score;
    save.currency += this.run.coins;
    SaveManager.save(save);

    // Пауза перед экраном: игрок должен успеть увидеть, что именно его добило
    this.time.delayedCall(800, () => {
      this.scene.start('GameOverScene',
        { score: this.run.score, coins: this.run.coins, isRecord });
    });
  }

  /* ---------- обратная связь ---------- */

  // Звук ошибки ограничен по частоте так же, как звук ловли: взрыв бомбы
  // выбрасывает из кузова сразу несколько коробок, и каждая просила бы свой звук.
  // detune задаёт взрыв — он звучит тем же сэмплом, но сильно ниже
  playErrorSound(detune) {
    if (this.time.now - this.lastErrorSound < CONFIG.audio.errorCooldown) return;
    this.lastErrorSound = this.time.now;
    playSfx(this, 'error', { detune: detune || 0 });
  }

  flashError() {
    this.cameras.main.shake(120, 0.006);
  }

  // Бустер отчитывается в правом верхнем углу (GAME_SPEC.md, раздел 11):
  // над тележкой ему тесно, там уже стоит цена сдачи
  showPickupPopup(text, color) {
    const label = this.add.text(
      CONFIG.screen.width - 20, 20, text,
      textStyle(22, hex(color || CONFIG.colors.booster), true)).setOrigin(1, 0).setDepth(20);

    this.tweens.add({
      targets: label,
      y: label.y - 26,
      alpha: 0,
      duration: CONFIG.pickups.popupDuration,
      ease: 'Quad.easeOut',
      onComplete: () => label.destroy()
    });
  }

  // Мелкое приглушённое число в точке промаха: видно, что XP ушёл, но глаз не дёргается
  showMissLabel(x, y, text) {
    const label = this.add.text(x, y, text, textStyle(15, CONFIG.colors.textDim))
      .setOrigin(0.5).setAlpha(0.85).setDepth(19);

    this.tweens.add({
      targets: label,
      y: y - 22,
      alpha: 0,
      duration: 500,
      ease: 'Quad.easeOut',
      onComplete: () => label.destroy()
    });
  }

  // Всплывающее число над тележкой: сдача груза и потеря груза
  showPopup(text, color) {
    const y = this.cart.y - 60;

    const label = this.add.text(this.cart.x, y, text,
      textStyle(22, color, true)).setOrigin(0.5).setDepth(20);

    this.tweens.add({
      targets: label,
      y: label.y - 40,
      alpha: 0,
      duration: 700,
      ease: 'Quad.easeOut',
      onComplete: () => label.destroy()
    });
  }

  /* ---------- цикл ---------- */
  update(time, delta) {
    if (this.over) return;   // забег кончился, ждём экран Game Over

    this.run.elapsed += delta;

    this.driveCart(delta);
    this.rampDifficulty();
    this.holdFallSpeed();
    this.checkMissedBoxes();
    this.checkCargoOverboard();
    this.drawShadows();
    this.drawCart();
    this.updateHud();
  }

  // Плавный рост темпа без конца (GAME_SPEC.md, раздел 5.3)
  rampDifficulty() {
    if (this.run.elapsed - this.run.lastRamp < CONFIG.fall.rampEvery) return;
    this.run.lastRamp = this.run.elapsed;

    this.run.fallSpeed = Math.min(
      CONFIG.fall.speedMax, this.run.fallSpeed * CONFIG.fall.speedStep);
    this.run.spawnInterval = Math.max(
      CONFIG.fall.intervalMin, this.run.spawnInterval * CONFIG.fall.intervalStep);

    this.spawnTimer.reset({
      delay: this.run.spawnInterval,
      loop: true,
      callback: () => this.spawnNext()
    });
  }

  // Держит скорость падения ровно такой, как в CONFIG: сопротивление воздуха
  // иначе тормозит коробки в полёте
  holdFallSpeed() {
    const v = this.currentFallSpeed() / 60;
    this.fallingBoxes.forEach(box => box.setVelocity(0, v));
  }

  // Скорость падения с учётом замедления. run.fallSpeed трогать нельзя: он растёт
  // ступенями от времени забега, и умножение на месте сделало бы замедление
  // постоянным — эффект кончился бы, а темп остался бы срезанным
  currentFallSpeed() {
    const slow = CONFIG.pickups.types.slow;
    return this.run.fallSpeed * (this.hasEffect('slow') ? slow.factor : 1);
  }

  // Коробка, улетевшая ниже СВОЕЙ рельсы, — промах.
  // Порог у каждой рельсы свой, иначе задняя коробка падала бы до передней.
  // Промах стоит XP (ADR-0003), но штраф мелкий и тихий
  checkMissedBoxes() {
    for (let i = this.fallingBoxes.length - 1; i >= 0; i--) {
      const box = this.fallingBoxes[i];
      const limit = this.railLineY(box.boxData.rail) + CONFIG.bounds.missBelowRail;
      if (box.y > limit) {
        // Всё нужное читаем до destroy: после него у объекта нет ни координат, ни данных
        const penalty = box.boxData.missPenalty;
        const x = box.x;
        const y = box.y;

        box.boxData.state = 'missed';
        box.destroy();
        this.fallingBoxes.splice(i, 1);
        // Пропущенные бомба и бустер ничего не стоят: у них missPenalty = 0
        if (penalty > 0) this.penalizeMiss(penalty, x, y);
      }
    }
  }

  // Груз, вывалившийся за борт, — потеря
  checkCargoOverboard() {
    const s = this.cart.scale;
    const limitX = (CONFIG.cart.width / 2 + CONFIG.bounds.cargoDropX) * s;
    const limitY = CONFIG.bounds.cargoDropY * s;

    for (let i = this.cargo.length - 1; i >= 0; i--) {
      const box = this.cargo[i];
      const outX = Math.abs(box.x - this.cart.x) > limitX;
      const outY = box.y > this.cart.y + limitY;

      if (outX || outY) {
        const penalty = box.boxData.penalty;   // читаем до destroy
        box.boxData.state = 'missed';
        this.cargo.splice(i, 1);
        box.destroy();
        this.penalizeDrop(penalty);
      }
    }
  }

  /* ---------- HUD ---------- */
  createHud() {
    const { width } = CONFIG.screen;
    const h = CONFIG.hud;

    // Полоса XP — верх слева. Перерисовывается каждый кадр по позиции, как тележка
    this.xpBar = this.add.graphics().setDepth(20);
    this.xpText = this.add.text(24 + h.xpBarWidth, 14, '',
      textStyle(15, CONFIG.colors.textDim)).setDepth(20);

    // Счёт — главная цифра забега, крупно по центру. Коробки проходят за ним
    this.scoreText = this.add.text(width / 2, 10, '0',
      textStyle(36, CONFIG.colors.text, true)).setOrigin(0.5, 0).setDepth(20);
    this.add.text(width / 2, 54, `Рекорд: ${this.bestScore}`,
      textStyle(15, CONFIG.colors.textDim)).setOrigin(0.5, 0).setDepth(20);

    // Цена сдачи — под полосой XP. Этап 8.3 убрал её и над штабелем, и из HUD, но
    // плейтест 20.08.2026 показал, что решать «сдать или взять ещё» стало не по чему.
    // Возвращаем строкой в HUD, а не поверх груза: над штабелем цифра ездила вместе
    // с тележкой и перекрывала коробки, из-за чего её и убрали
    this.cargoText = this.add.text(16, 40, '',
      textStyle(15, CONFIG.colors.textDim)).setDepth(20);

    // Активные эффекты — правый верх, под всплывашкой подбора. Без обратного отсчёта
    // бустеры нечем оценивать: игрок не понимает, кончилось замедление или ещё нет.
    //
    // Плашка, а не просто цветной текст: HUD висит поверх поля, и надпись цветом
    // бустера ложилась на летящие коробки того же порядка яркости. Тёмный текст
    // на заливке своего цвета читается на любом фоне и заодно повторяет вид самого
    // бустера — связь «поймал вот это» → «работает вот это» видна без объяснений
    this.effectChips = {};
    ['shield', 'brake', 'slow', 'rush'].forEach((key, i) => {
      const spec = CONFIG.pickups.types[key];
      const y = 58 + i * 30;
      const box = this.add.rectangle(CONFIG.screen.width - 16, y,
        10, 24, spec.color).setOrigin(1, 0.5).setDepth(20).setVisible(false);
      // На тёмно-красной заливке дебаффа тёмный текст не читается — там белый
      const text = this.add.text(CONFIG.screen.width - 26, y, '',
        textStyle(16, spec.bad ? '#ffffff' : hex(CONFIG.colors.bg), true))
        .setOrigin(1, 0.5).setDepth(21);
      this.effectChips[key] = { box, text };
    });

    this.createHint();
  }

  // Подсказка клавиш висит первые 10 секунд и гаснет. Вернуть её можно клавишей H:
  // после того как она погасла, подсмотреть управление по ходу забега было негде
  createHint() {
    // Ставим на полосу пола под передней рельсой: в середине экрана подсказка
    // оказывалась ровно на пути падающих коробок и резала их пополам
    const text = '← → — ехать  ·  ↑ ↓ — рельса  ·  Пробел — сдать  ·  Esc — пауза  ·  M — звук  ·  H — эта строка';

    this.hint = this.add.text(CONFIG.screen.width / 2, CONFIG.screen.height - 24, text,
      textStyle(16, CONFIG.colors.textDim)).setOrigin(0.5).setDepth(20);

    this.showHint();
  }

  // Текст живёт весь забег и только меняет прозрачность: пересоздавать его на каждое
  // нажатие H значило бы плодить объекты и таймеры, которые никто не убирает
  showHint() {
    if (this.hintFade) this.hintFade.stop();
    if (this.hintTimer) this.hintTimer.remove();

    this.hint.setAlpha(1);
    this.hintTimer = this.time.delayedCall(CONFIG.hud.hintDuration, () => {
      this.hintFade = this.tweens.add({ targets: this.hint, alpha: 0, duration: 600 });
    });
  }

  xpRatio() {
    return this.run.maxXp === 0 ? 0 : this.run.xp / this.run.maxXp;
  }

  // Цвет полосы плавно едет от зелёного (полный XP) к красному (пустой).
  // Порога и пульсации больше нет: мигающая полоса раздражала на длинной дистанции,
  // а плавный цвет читается сам по себе, без твинов и без флага состояния
  xpBarColor() {
    const t = this.xpRatio();
    const from = CONFIG.colors.danger;
    const to = CONFIG.colors.booster;
    const channel = shift => Math.round(
      ((from >> shift) & 0xff) + (((to >> shift) & 0xff) - ((from >> shift) & 0xff)) * t);

    return (channel(16) << 16) | (channel(8) << 8) | channel(0);
  }

  drawXpBar() {
    const h = CONFIG.hud;
    const g = this.xpBar;

    g.clear();

    // Подложка
    g.fillStyle(CONFIG.colors.cartDark, 1);
    g.fillRect(16, 14, h.xpBarWidth, h.xpBarHeight);

    // Заливка по остатку XP; в момент потери груза полоса коротко вспыхивает белым
    const flashing = this.time.now < this.xpFlashUntil;
    g.fillStyle(flashing ? 0xffffff : this.xpBarColor(), 1);
    g.fillRect(16, 14, h.xpBarWidth * this.xpRatio(), h.xpBarHeight);

    // Обводка отделяет полосу от фона
    g.lineStyle(2, 0x000000, 0.35);
    g.strokeRect(16, 14, h.xpBarWidth, h.xpBarHeight);
  }

  updateHud() {
    this.drawXpBar();
    this.xpText.setText(`${this.run.xp} / ${this.run.maxXp} XP`);
    this.scoreText.setText(String(this.run.score));

    this.updateEffectHud();

    // Пустой кузов — пустая строка: висящее «Груз: 0 шт» только шумит.
    // Цена берётся из cargoValue(), той же функции, что начисляет очки в unloadCargo():
    // обещанная цифра не имеет права разойтись с выданной
    this.cargoText.setText(this.cargo.length === 0
      ? ''
      : `Груз: ${this.cargo.length} шт → сдать за ${this.cargoValue()}`);
  }

  // Плашка на эффект: «Щит», «Замедление 4 с». У щита обратного отсчёта нет — он
  // висит до бомбы или до конца holdMs, и таймер там сбивал бы с толку: важно не
  // сколько осталось, а есть он или нет
  updateEffectHud() {
    const left = key => Math.ceil((this.effects[key] - this.run.elapsed) / 1000);

    Object.entries(this.effectChips).forEach(([key, chip]) => {
      const active = this.hasEffect(key);
      chip.box.setVisible(active);
      if (!active) return chip.text.setText('');

      const spec = CONFIG.pickups.types[key];
      chip.text.setText(key === 'shield' ? spec.title : `${spec.title} ${left(key)} с`);
      // Ширина плашки идёт за текстом: «Замедление 6 с» и «Щит» отличаются вдвое,
      // а фиксированная ширина по длинному оставила бы у короткого пустой хвост
      chip.box.setSize(chip.text.width + 20, 24);
    });
  }

  pauseGame() {
    // Пауза во время задержки перед Game Over заморозила бы отложенный переход
    if (this.over) return;
    this.scene.pause();
    this.scene.launch('PauseScene');
  }
}
