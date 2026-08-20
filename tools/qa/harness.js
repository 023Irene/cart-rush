/* ============================================================================
   QA-harness Cart Rush — запускает игру в настоящем Chrome и даёт к ней API.

   Зачем: физику штабеля и экономику нельзя оценить чтением кода, а живого
   тестировщика у проекта нет. Harness прогоняет игру и снимает числа.

   Граница (ADR-0004): harness НЕ меняет игру. Всё, что ему нужно, он берёт
   из уже существующих `game`, `CONFIG` и методов сцены. В index.html нет и
   не должно появиться ни одной строки ради тестов.
   ========================================================================= */

const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..', '..');

// Chrome берём системный — puppeteer-core свой браузер не качает
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')
].filter(Boolean);

function findChrome() {
  const hit = CHROME_CANDIDATES.find(p => fs.existsSync(p));
  if (!hit) {
    throw new Error('Chrome не найден. Укажи путь через переменную окружения CHROME_PATH.');
  }
  return hit;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

// Статический сервер на случайном свободном порту: по file:// звук не грузится
// (CORS), а игра без звука — это уже не та игра, которую мы измеряем
function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);

      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }

      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });

    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ---------- скрипт, который выполняется в странице ДО игры ---------- */

// Возвращается строкой-функцией: экземпляр игры лежит в `const game` модульной
// области, на window его нет. Перехватываем присваивание window.Phaser и
// подменяем конструктор Game — игру править не надо.
function initScript({ seed, save }) {
  // Детерминизм: Math.random в игре разыгрывает размер, рельсу, X, бомбу,
  // подкрутку и разлёт. С сидом два прогона одного сценария сравнимы попарно
  // Пересев доступен и позже: генератор сеется при загрузке страницы, а до старта
  // забега успевает сдвинуться на разное число выборок — сколько кадров провисело
  // меню, столько и сдвиг. Замер обязан начинать забег с известного состояния
  window.__setSeed = function (value) {
    let state = value >>> 0;
    Math.random = function () {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return value;
  };
  if (seed !== null && seed !== undefined) window.__setSeed(seed);

  // Прогресс задаётся до старта: апгрейды меняют физику, и замер обязан знать,
  // с какими бортами он сделан
  try {
    if (save) localStorage.setItem('cartRushSave', JSON.stringify(save));
    else localStorage.removeItem('cartRushSave');
  } catch (e) { /* приватный режим — играем без сохранений */ }

  let stored;
  Object.defineProperty(window, 'Phaser', {
    configurable: true,
    get: () => stored,
    set: value => {
      stored = value;
      const Original = value.Game;
      function Patched(config) {
        const instance = new Original(config);
        window.__game = instance;
        return instance;
      }
      Patched.prototype = Original.prototype;
      value.Game = Patched;
    }
  });

  // Всё, что дёргают сценарии. Живёт в странице, чтобы не гонять коробки
  // по одной через CDP: снимок штабеля — одна команда, а не двадцать
  window.__qa = {
    scene() { return window.__game.scene.getScene('GameScene'); },

    // Коробка сразу в кузов, в заданную точку относительно центра тележки.
    // Идём штатным путём spawnFaller → acceptBox: любой обходной путь измерял
    // бы физику, которой в игре нет
    place(sizeName, dx, dy) {
      const s = this.scene();
      const spec = CONFIG.boxes[sizeName];
      const rail = s.cart.rail;
      const color = CONFIG.rails[rail].color;

      const box = s.spawnFaller(`box-${sizeName}-${color}`, spec.size, rail, {
        kind: 'box', sizeName, color, value: spec.value,
        penalty: spec.penalty, missPenalty: spec.missPenalty,
        densityFactor: spec.densityFactor
      });

      s.matter.body.setPosition(box.body, { x: s.cart.x + dx, y: s.cart.y + dy });
      s.matter.body.setVelocity(box.body, { x: 0, y: 0 });
      s.matter.body.setAngularVelocity(box.body, 0);
      s.acceptBox(box);
      return true;
    },

    // Штабель строится слоями снизу вверх — так же, как его копит игрок
    stack(sizeName, count) {
      const spec = CONFIG.boxes[sizeName];
      const s = this.scene();
      const side = spec.size * s.cart.scale;
      const inner = (CONFIG.cart.width - 2 * CONFIG.cart.wallThickness) * s.cart.scale;
      const perRow = Math.max(1, Math.floor(inner / side));

      for (let i = 0; i < count; i++) {
        const col = i % perRow;
        const row = Math.floor(i / perRow);
        const dx = (col - (perRow - 1) / 2) * side;
        const dy = -side / 2 - row * side - 2;
        this.place(sizeName, dx, dy);
      }
      return this.scene().cargo.length;
    },

    // Взрыв в точке относительно центра тележки, без самой бомбы: так эпицентр
    // ставится точно, а не «куда прилетело»
    blastAt(dx, dy) {
      const s = this.scene();
      const before = s.cargo.length;
      if (s.blastCargo) s.blastCargo(s.cart.x + dx, s.cart.y + dy);
      return before;
    },

    snapshot() {
      const s = this.scene();
      if (!s || !s.matter || !s.matter.world) return { dead: true, cargo: [] };
      const engine = s.matter.world.engine;
      return {
        elapsed: Math.round(s.run.elapsed),
        score: s.run.score,
        coins: s.run.coins,
        xp: Math.round(s.run.xp),
        maxXp: s.run.maxXp,
        over: !!s.over,
        cartX: Math.round(s.cart.x),
        rail: s.cart.rail,
        falling: s.fallingBoxes.length,
        cargo: s.cargo.map(b => ({
          size: b.boxData.sizeName,
          dx: +(b.x - s.cart.x).toFixed(2),
          dy: +(b.y - s.cart.y).toFixed(2),
          angle: +b.rotation.toFixed(3),
          vx: +b.body.velocity.x.toFixed(3),
          vy: +b.body.velocity.y.toFixed(3),
          mass: +b.body.mass.toFixed(3),
          area: +b.body.area.toFixed(4),
          sleeping: !!b.body.isSleeping
        })),
        stepMs: +(engine.timing.lastElapsed || 0).toFixed(3),
        maxDepth: +engine.pairs.list.reduce(
          (max, p) => (p.isActive && p.collision ? Math.max(max, p.collision.depth) : max), 0
        ).toFixed(3)
      };
    },

    // Поток падающих объектов глушится, когда измеряется сам штабель:
    // случайная коробка сверху смазала бы замер
    pauseSpawn(flag) {
      const s = this.scene();
      s.spawnTimer.paused = flag;
      s.pickupTimer.paused = flag;
      return flag;
    },

    // Замер физики не должен обрываться по нулю XP: десять потерянных коробок
    // стоят 800 XP при запасе 700, и сценарий не доживал до конца. Трогаем
    // только бухгалтерию XP — на физику это не влияет никак
    freezeXp(flag) {
      const s = this.scene();
      if (flag && !s.__origSpendXp) {
        s.__origSpendXp = s.spendXp;
        s.spendXp = function () {};
      } else if (!flag && s.__origSpendXp) {
        s.spendXp = s.__origSpendXp;
        delete s.__origSpendXp;
      }
      return flag;
    },

    // Сцена жива? После endRun игра уходит на GameOverScene, и снимок падал
    alive() {
      const s = window.__game.scene.getScene('GameScene');
      return !!(s && s.scene.isActive() && s.matter && s.matter.world && !s.over);
    },

    restart() {
      window.__game.scene.start('GameScene');
      return true;
    },

    reseed(value) { return window.__setSeed(value); },

    // Цены и шаги магазина — чтобы сценарий не дублировал числа из CONFIG
    shopSpec() { return JSON.parse(JSON.stringify(CONFIG.shop)); },

    // Пересев ровно в момент рождения забега. Звать reseed() снаружи мало: между
    // командой «старт» и командой «пересей» проходит реальное время, за него
    // успевает нападать разное число коробок, и они уже разошлись. Здесь пересев
    // прибит к create() сцены, то есть к точке, одинаковой во всех прогонах
    armSeed(value) {
      const sc = window.__game.scene.getScene('GameScene');
      window.__armedSeed = value;
      if (!sc.__seedArmed) {
        sc.__seedArmed = true;
        const origCreate = sc.create.bind(sc);
        sc.create = function () {
          if (window.__armedSeed !== null) window.__setSeed(window.__armedSeed);
          return origCreate();
        };
      }
      return value;
    },

    botCapped() { return !!(this.botStats && this.botStats.capped); },

    // Детерминированный шаг. Сид подменяет Math.random, но кадровую дельту он не
    // трогает: Matter шагает на том, что дал браузер, штабель садится каждый раз
    // чуть иначе, и один и тот же сид давал разброс счёта до 16 %. Проверено —
    // три прогона сида 101 дали 4325 / 3800 / 4400 при одинаковых 1206 тиках бота.
    //
    // Здесь мы останавливаем RAF и гоним game.loop.step() сами, отмеряя время
    // синтетическими часами. smoothStep обязателен к выключению: он усредняет
    // дельту по истории кадров и вернул бы плавающее значение обратно.
    //
    // rate — как часто шагаем в РЕАЛЬНОМ времени. Меньше 16 мс означает, что
    // игровая секунда проходит быстрее реальной: замеры идут быстрее, а результат
    // от этого не зависит вовсе — в том и смысл фиксированного шага
    fixedStep(options) {
      if (this.__fixedTimer) return false;
      const o = Object.assign({ stepMs: 1000 / 60, rate: 4 }, options || {});
      const loop = window.__game.loop;

      loop.smoothStep = false;
      loop.stop();

      // Самопланирующийся таймаут, а НЕ setInterval. Шаг с решателем 12/8 и
      // подписчиками на кадр занимает больше нескольких миллисекунд, и setInterval
      // копил очередь: страница переставала отдавать управление, CDP не мог до неё
      // достучаться, и puppeteer падал с detached Frame. Здесь следующий шаг
      // планируется только после того, как отработал предыдущий
      let t = loop.time || 0;
      const pump = () => {
        if (!this.__fixedTimer) return;
        t += o.stepMs;
        loop.step(t);
        this.__fixedTimer = setTimeout(pump, o.rate);
      };
      this.__fixedTimer = setTimeout(pump, o.rate);
      return true;
    },

    fixedStepOff() {
      if (!this.__fixedTimer) return false;
      clearTimeout(this.__fixedTimer);
      this.__fixedTimer = null;
      return true;
    },

    // XP восстанавливается между замерами: серия потерь оборвала бы забег
    // на середине сценария, и мерить стало бы нечего
    refillXp() {
      const s = this.scene();
      s.run.xp = s.run.maxXp;
      return s.run.xp;
    },

    // Падающие объекты между постановкой штабеля и замером: изредка таймер
    // спавна успевал сработать до паузы, и в кузове оказывалась лишняя коробка
    clearFalling() {
      const s = this.scene();
      s.fallingBoxes.forEach(b => b.destroy());
      s.fallingBoxes = [];
      return true;
    },

    clearCargo() {
      const s = this.scene();
      s.cargo.forEach(b => b.destroy());
      s.cargo = [];
      s.fallingBoxes.forEach(b => b.destroy());
      s.fallingBoxes = [];
    },

    /* ---------- бот «среднего толкового игрока» ---------- */

    // Бот живёт в странице и правит те же keys.isDown, что ставит Phaser при
    // нажатии клавиши: гонять управление через CDP по кадрам слишком медленно,
    // а любой обходной путь измерял бы не ту игру.
    //
    // Стратегия простая и человеческая: едем к ближайшей достижимой коробке
    // своей рельсы, уворачиваемся от бомбы, сдаём груз на заданном размере
    startBot(options) {
      const opt = Object.assign({ unloadAt: 8, dodge: 70, tickMs: 50, startAt: 2000, stopAt: 0 }, options || {});
      const s = this.scene();
      this.botStats = { unloads: 0, sizes: [], railSwitches: 0, dodges: 0, drops: 0, misses: 0,
                        xpDrops: 0, xpMisses: 0, xpSpent: 0,
                        ticks: 0, startedGame: opt.startAt, startedWall: Date.now() };
      this.botTarget = null;

      // Считаем, на чём именно утекает XP. Не только сколько РАЗ — но и сколько XP:
      // промахов на порядок больше, чем потерь груза, но стоят они по −5..−18
      // против −30..−150, и без сумм непонятно, что на самом деле добивает забег.
      //
      // Обёртка читает this.botStats через замыкание на qa, а не через снимок:
      // иначе второй startBot в той же странице продолжил бы писать в статистику
      // предыдущего забега
      const qa = this;
      if (!s.__origDrop) {
        s.__origDrop = s.penalizeDrop;
        s.penalizeDrop = function (amount) {
          qa.botStats.drops++;
          qa.botStats.xpDrops += amount;
          return s.__origDrop.call(s, amount);
        };
        s.__origMiss = s.penalizeMiss;
        s.penalizeMiss = function (a, x, y) {
          qa.botStats.misses++;
          qa.botStats.xpMisses += a;
          return s.__origMiss.call(s, a, x, y);
        };
        // Бомба списывает XP напрямую через spendXp, минуя оба метода выше.
        // Общая сумма нужна, чтобы её долю можно было получить вычитанием
        s.__origSpend = s.spendXp;
        s.spendXp = function (amount) {
          qa.botStats.xpSpent += amount;
          return s.__origSpend.call(s, amount);
        };
      }

      const keys = s.keys;
      const press = dir => {
        keys.left.isDown = dir === -1;
        keys.right.isDown = dir === 1;
      };

      // Решения привязаны к ИГРОВЫМ часам, а не к моменту вызова startBot.
      // Раньше бот начинал играть тогда, когда до страницы доходила команда по CDP,
      // а это реальное время: замер показал старт на игровой мс 1900, 1983 и 1950 у
      // одного и того же сида. Восьмидесяти миллисекунд хватало, чтобы бот погнался
      // за другой коробкой, и дальше расхождение только росло — отсюда и брался
      // разброс счёта 15 % при одинаковом сиде.
      //
      // Теперь проверка идёт каждый кадр, а действие происходит на фиксированной
      // сетке игрового времени: startAt, startAt + tickMs, startAt + 2*tickMs, ...
      let nextTick = opt.startAt;

      const tick = () => {
        if (!this.alive()) return;
        if (s.run.elapsed < nextTick) return;
        while (nextTick <= s.run.elapsed) nextTick += opt.tickMs;

        // Потолок забега снимается ЗДЕСЬ, на кадре, а не опросом снаружи. Опрос
        // идёт раз в две секунды реального времени, а игра под фиксированным шагом
        // бежит быстрее — обрыв попадал на разную игровую миллисекунду, и два
        // прогона одного сида расходились именно на этом
        if (opt.stopAt && s.run.elapsed >= opt.stopAt && !this.botStats.capped) {
          this.botStats.capped = true;
          this.botStats.cappedScore = s.run.score;
          this.botStats.cappedCoins = s.run.coins;
          this.botStats.cappedElapsed = Math.round(s.run.elapsed);
          press(0);
        }
        if (this.botStats.capped) return;

        this.botStats.ticks++;

        const cart = s.cart;
        const mine = s.fallingBoxes.filter(b => b.boxData.rail === cart.rail);
        const bombs = mine.filter(b => b.boxData.kind === 'bomb');
        const goods = mine.filter(b => b.boxData.kind !== 'bomb');

        // Сдача: держать бесконечно нельзя — резкий манёвр рискует всем грузом
        if (s.cargo.length >= opt.unloadAt) {
          this.botStats.sizes.push(s.cargo.length);
          this.botStats.unloads++;
          s.unloadCargo();
        }

        // Бомба важнее коробки: она отнимает XP и разносит штабель
        const danger = bombs.find(b => Math.abs(b.x - cart.x) < opt.dodge && b.y > 0);
        if (danger) {
          this.botStats.dodges++;
          press(danger.x > cart.x ? -1 : 1);
          return;
        }

        // Цель держится, пока жива и достижима. Без этого бот перевыбирал цель
        // каждый тик, дёргался влево-вправо десятки раз за забег и разносил
        // собственный штабель — живой игрок так не играет
        let target = this.botTarget && goods.includes(this.botTarget) ? this.botTarget : null;
        if (!target) {
          target = goods.sort((a, b) => b.y - a.y)[0] || null;
          this.botTarget = target;
        }
        if (!target) {
          // На своей рельсе пусто, а на соседней есть — переезжаем
          const other = s.fallingBoxes.find(
            b => b.boxData.rail !== cart.rail && b.boxData.kind !== 'bomb' && b.y < 200);
          if (other && !s.switching) {
            this.botStats.railSwitches++;
            s.switchRail(other.boxData.rail - cart.rail);
          }
          press(0);
          return;
        }

        // Мёртвая зона широкая: коробка ловится кузовом шириной 200 px, гнаться
        // за точным совпадением центров незачем, а каждый доворот бьёт по грузу
        const delta = target.x - cart.x;
        press(Math.abs(delta) < 40 ? 0 : Math.sign(delta));
      };

      // Слушаем кадр, а не таймер. Таймер Phaser отсчитывает delay от момента
      // создания, то есть его фаза тоже зависела бы от того, когда пришла команда
      this.botTick = tick;
      s.events.on('update', tick);

      return true;
    },

    stopBot() {
      const s = this.scene();
      if (this.botTick && s) { s.events.off('update', this.botTick); }
      this.botTick = null;
      if (s && s.keys) { s.keys.left.isDown = false; s.keys.right.isDown = false; }

      // Часы бота против часов игры: ticksPerGameSec обязан равняться 1000 / tickMs.
      // Отклонение означает, что бот принял не то число решений на игровую секунду,
      // и сравнивать такой прогон с другим нельзя
      const st = this.botStats;
      const gameMs = (s ? s.run.elapsed : st.startedGame) - st.startedGame;
      const wallMs = Date.now() - st.startedWall;
      st.gameMs = Math.round(gameMs);
      st.wallMs = wallMs;
      st.timeRatio = wallMs ? +(gameMs / wallMs).toFixed(3) : null;
      st.ticksPerGameSec = gameMs ? +(st.ticks / (gameMs / 1000)).toFixed(2) : null;

      // Бомбы списывают XP мимо penalizeDrop и penalizeMiss — их доля получается
      // вычитанием. Отрицательной она стать не может: spendXp зовут только эти трое
      st.xpBombs = Math.max(0, st.xpSpent - st.xpDrops - st.xpMisses);
      return st;
    },

    // Итог забега: счёт, длительность, что накопилось в сохранении
    runResult() {
      const s = this.scene();
      const save = JSON.parse(localStorage.getItem('cartRushSave') || '{}');
      return {
        score: s ? s.run.score : null,
        coins: s ? s.run.coins : null,
        elapsed: s ? Math.round(s.run.elapsed) : null,
        over: s ? !!s.over : true,
        currency: save.currency || 0,
        bestScore: save.bestScore || 0
      };
    },

    // Проверка находки Н1: трение у ЧАСТЕЙ составного тела, а не у родителя
    cartFriction() {
      const parts = this.scene().cartBody.parts;
      return {
        parent: this.scene().cartBody.friction,
        parts: parts.slice(1).map(p => p.friction),
        partsStatic: parts.slice(1).map(p => p.frictionStatic),
        isStatic: this.scene().cartBody.isStatic
      };
    },

    // Что реально доехало до движка — конфиг легко написать и не заметить опечатку
    engineConfig() {
      const w = this.scene().matter.world;
      return {
        positionIterations: w.engine.positionIterations,
        velocityIterations: w.engine.velocityIterations,
        enableSleeping: w.engine.enableSleeping,
        gravityY: w.engine.gravity.y,
        boxFriction: CONFIG.physics.boxFriction
      };
    }
  };
}

/* ---------- сам harness ---------- */

class Harness {
  constructor(page, browser, server) {
    this.page = page;
    this.browser = browser;
    this.server = server;
    this.errors = [];
  }

  qa(method, ...args) {
    return this.page.evaluate(
      (m, a) => window.__qa[m].apply(window.__qa, a), method, args);
  }

  eval(fn, ...args) { return this.page.evaluate(fn, ...args); }

  async startRun() {
    await this.page.keyboard.press('Space');
    await this.wait(600);
    await this.page.waitForFunction(
      () => window.__game && window.__game.scene.getScene('GameScene').scene.isActive(),
      { timeout: 5000 });
  }

  // Удержание стрелки: игра опрашивает isDown в update(), поэтому нажатие
  // и отпускание разнесены по времени, а не имитируются одним press
  async drive(dir, ms) {
    const key = dir === 'left' ? 'ArrowLeft' : 'ArrowRight';
    await this.page.keyboard.down(key);
    await this.wait(ms);
    await this.page.keyboard.up(key);
  }

  async switchRail(dir) {
    await this.page.keyboard.press(dir === 'up' ? 'ArrowUp' : 'ArrowDown');
    await this.wait(CONFIG_SWITCH_MS);
  }

  async unload() { await this.page.keyboard.press('Space'); await this.wait(120); }

  place(sizeName, dx, dy) { return this.qa('place', sizeName, dx, dy); }
  stack(sizeName, count) { return this.qa('stack', sizeName, count); }
  blastAt(dx, dy) { return this.qa('blastAt', dx, dy); }
  state() { return this.qa('snapshot'); }
  pauseSpawn(flag) { return this.qa('pauseSpawn', flag); }
  clearCargo() { return this.qa('clearCargo'); }
  clearFalling() { return this.qa('clearFalling'); }
  refillXp() { return this.qa('refillXp'); }
  startBot(opts) { return this.qa('startBot', opts); }
  reseed(value) { return this.qa('reseed', value); }
  armSeed(value) { return this.qa('armSeed', value); }
  shopSpec() { return this.qa('shopSpec'); }
  fixedStep(opts) { return this.qa('fixedStep', opts); }
  fixedStepOff() { return this.qa('fixedStepOff'); }
  stopBot() { return this.qa('stopBot'); }
  runResult() { return this.qa('runResult'); }

  // Забег ботом до конца XP или до потолка по времени
  // Потолок забега считается в ИГРОВОМ времени, а не в реальном. Иначе два прогона
  // одной сборки обрывались на разной игровой секунде — под нагрузкой игра отстаёт
  // от часов, — и сравнивать их счёт было нельзя. Реальные часы остаются только
  // страховкой от зависшей страницы: втрое дольше игрового потолка
  // Потолок забега задаётся боту и снимается им НА КАДРЕ, в точной игровой
  // миллисекунде. Опрос отсюда идёт по реальным часам и годится только на то,
  // чтобы заметить, что всё кончилось; сам результат берётся из снимка, сделанного
  // в момент обрыва, — иначе счёт дочитывался бы в случайный игровой момент.
  // Реальные часы остаются страховкой от зависшей страницы
  async playRun({ unloadAt = 8, timeoutMs = 300000 } = {}) {
    await this.startBot({ unloadAt, stopAt: timeoutMs });
    const wallCap = Math.max(60000, timeoutMs * 3);
    const startedWall = Date.now();
    let hung = false;

    for (;;) {
      await this.wait(1000);
      if (!await this.qa('alive')) break;
      if ((await this.qa('botCapped'))) break;
      if (Date.now() - startedWall >= wallCap) { hung = true; break; }
    }

    const stats = await this.stopBot();
    const live = await this.runResult();
    const result = stats.capped
      ? { ...live, score: stats.cappedScore, coins: stats.cappedCoins, elapsed: stats.cappedElapsed }
      : live;
    return { ...result, ...stats, timedOut: !!stats.capped, hung };
  }
  freezeXp(flag) { return this.qa('freezeXp', flag); }

  // Забег мог кончиться между сценариями — поднимаем заново и восстанавливаем режим
  async ensureRun({ freezeXp = true } = {}) {
    if (await this.qa('alive')) return false;
    await this.qa('restart');
    await this.wait(900);
    await this.pauseSpawn(true);
    if (freezeXp) await this.freezeXp(true);
    return true;
  }

  wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  async shot(file) {
    const out = path.join(__dirname, 'reports', file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await this.page.screenshot({ path: out });
    return out;
  }

  async close() {
    await this.browser.close();
    await new Promise(r => this.server.close(r));
  }
}

const CONFIG_SWITCH_MS = 260;   // switchDuration 150 мс плюс запас на твин

async function launch(options = {}) {
  const { seed = null, save = null, headless = true, page: pageUrl = 'index.html' } = options;
  const { server, port } = await startServer();

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless,
    defaultViewport: { width: 1280, height: 800 },
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio']
  });

  const page = await browser.newPage();
  const harness = new Harness(page, browser, server);

  page.on('pageerror', e => harness.errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') harness.errors.push('console: ' + m.text()); });

  await page.evaluateOnNewDocument(initScript, { seed, save });
  await page.goto(`http://127.0.0.1:${port}/${pageUrl}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => !!window.__game, { timeout: 10000 });
  await harness.wait(1200);   // BootScene генерит текстуры и уходит в меню

  return harness;
}

// Сохранение отчёта: числа прогонов — доказательная база, они лежат в git
function saveReport(name, data) {
  const dir = path.join(__dirname, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

module.exports = { launch, saveReport, startServer, findChrome };
