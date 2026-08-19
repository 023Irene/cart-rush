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
  if (seed !== null && seed !== undefined) {
    let state = seed >>> 0;
    Math.random = function () {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

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
      s.boosterTimer.paused = flag;
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
      const opt = Object.assign({ unloadAt: 8, dodge: 70, tickMs: 50 }, options || {});
      const s = this.scene();
      this.botStats = { unloads: 0, sizes: [], railSwitches: 0, dodges: 0, drops: 0, misses: 0 };
      this.botTarget = null;

      // Считаем, на чём именно утекает XP: потери груза за борт или промахи
      const stats = this.botStats;
      if (!s.__origDrop) {
        s.__origDrop = s.penalizeDrop;
        s.penalizeDrop = function (amount) { stats.drops++; return s.__origDrop.call(s, amount); };
        s.__origMiss = s.penalizeMiss;
        s.penalizeMiss = function (a, x, y) { stats.misses++; return s.__origMiss.call(s, a, x, y); };
      }

      const keys = s.keys;
      const press = dir => {
        keys.left.isDown = dir === -1;
        keys.right.isDown = dir === 1;
      };

      this.botTimer = setInterval(() => {
        if (!this.alive()) return;

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
      }, opt.tickMs);

      return true;
    },

    stopBot() {
      clearInterval(this.botTimer);
      const s = this.scene();
      if (s && s.keys) { s.keys.left.isDown = false; s.keys.right.isDown = false; }
      return this.botStats;
    },

    // Итог забега: счёт, длительность, что накопилось в сохранении
    runResult() {
      const s = this.scene();
      const save = JSON.parse(localStorage.getItem('cartRushSave') || '{}');
      return {
        score: s ? s.run.score : null,
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
  stopBot() { return this.qa('stopBot'); }
  runResult() { return this.qa('runResult'); }

  // Забег ботом до конца XP или до потолка по времени
  async playRun({ unloadAt = 8, timeoutMs = 300000 } = {}) {
    await this.startBot({ unloadAt });
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await this.wait(2000);
      const alive = await this.qa('alive');
      if (!alive) break;
    }
    const stats = await this.stopBot();
    const result = await this.runResult();
    return { ...result, ...stats, timedOut: Date.now() - started >= timeoutMs };
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
