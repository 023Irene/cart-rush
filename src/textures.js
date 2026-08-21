import { CONFIG } from './config.js';

/* ============================================================================
   Вспомогательное: рисование текстур примитивами.
   Спрайтов в проекте нет — всё генерируется кодом при загрузке.
   ========================================================================= */
export function makeBoxTexture(scene, key, sizePx, colorHex) {
  const g = scene.make.graphics({ add: false });

  // Тело коробки — плоская заливка, grey box без градиентов
  g.fillStyle(colorHex, 1);
  g.fillRect(0, 0, sizePx, sizePx);

  // Тёмная окантовка отделяет коробку от соседних в штабеле
  g.lineStyle(2, 0x000000, 0.35);
  g.strokeRect(1, 1, sizePx - 2, sizePx - 2);

  // Полоска-маркировка: по ней видно поворот тела
  g.fillStyle(0xffffff, 0.25);
  g.fillRect(sizePx * 0.18, sizePx * 0.42, sizePx * 0.64, sizePx * 0.16);

  g.generateTexture(key, sizePx, sizePx);
  g.destroy();
}

// Бомба: красный квадрат с чёрным крестом. Спрайтов в проекте нет,
// а «не лови это» должно читаться с одного взгляда
export function makeBombTexture(scene, key, sizePx) {
  const g = scene.make.graphics({ add: false });

  g.fillStyle(CONFIG.colors.danger, 1);
  g.fillRect(0, 0, sizePx, sizePx);

  g.lineStyle(2, 0x000000, 0.45);
  g.strokeRect(1, 1, sizePx - 2, sizePx - 2);

  const pad = sizePx * 0.26;
  g.lineStyle(Math.round(sizePx * 0.13), 0x000000, 0.55);
  g.lineBetween(pad, pad, sizePx - pad, sizePx - pad);
  g.lineBetween(sizePx - pad, pad, pad, sizePx - pad);

  g.generateTexture(key, sizePx, sizePx);
  g.destroy();
}

/* Бустер: цветной квадрат с белым знаком — «поймай, и станет лучше».
   Цвет говорит, какой именно, знак дублирует цвет: бирюзовый щит и синюю коробку
   в движении спутать легко, а щит и шеврон — нет. Синий и жёлтый в бустерах не
   используются вовсе: в этой игре они означают рельсу. */
export function makePickupTexture(scene, key, sizePx, spec) {
  const g = scene.make.graphics({ add: false });

  g.fillStyle(spec.color, 1);
  g.fillRect(0, 0, sizePx, sizePx);

  g.lineStyle(2, 0x000000, 0.35);
  g.strokeRect(1, 1, sizePx - 2, sizePx - 2);

  g.fillStyle(0xffffff, 0.9);
  g.lineStyle(Math.max(2, Math.round(sizePx * 0.09)), 0xffffff, 0.9);
  PICKUP_GLYPHS[key](g, sizePx);

  g.generateTexture(`pickup-${key}`, sizePx, sizePx);
  g.destroy();
}

/* Знаки бустеров. Вынесены из makePickupTexture(), чтобы она осталась одной
   функцией на четыре текстуры, а не выросла в лестницу из if. */
const PICKUP_GLYPHS = {
  // Плюс — восстановление XP. Знак с этапа 5, игрок его уже знает
  xp(g, size) {
    const arm = size * 0.52;
    const thick = size * 0.16;
    g.fillRect((size - arm) / 2, (size - thick) / 2, arm, thick);
    g.fillRect((size - thick) / 2, (size - arm) / 2, thick, arm);
  },

  // Щит — трапеция с остриём вниз
  shield(g, size) {
    const w = size * 0.46;
    const top = size * 0.24;
    const bottom = size * 0.78;
    const shoulder = size * 0.58;
    g.fillPoints([
      { x: (size - w) / 2, y: top },
      { x: (size + w) / 2, y: top },
      { x: (size + w) / 2, y: shoulder },
      { x: size / 2, y: bottom },
      { x: (size - w) / 2, y: shoulder }
    ], true);
  },

  // Песочные часы — замедление времени
  slow(g, size) {
    const w = size * 0.44;
    const top = size * 0.26;
    const bottom = size * 0.74;
    const left = (size - w) / 2;
    const right = (size + w) / 2;
    g.fillPoints([
      { x: left, y: top }, { x: right, y: top }, { x: size / 2, y: size / 2 }
    ], true);
    g.fillPoints([
      { x: left, y: bottom }, { x: right, y: bottom }, { x: size / 2, y: size / 2 }
    ], true);
  },

  // Двойной шеврон вправо — ускорение
  rush(g, size) {
    const top = size * 0.3;
    const mid = size * 0.5;
    const bottom = size * 0.7;
    [size * 0.26, size * 0.5].forEach(x => {
      g.beginPath();
      g.moveTo(x, top);
      g.lineTo(x + size * 0.2, mid);
      g.lineTo(x, bottom);
      g.strokePath();
    });
  },

  // Двойной шеврон ВЛЕВО — тормоз. Зеркало ускорения намеренно: связь «шеврон
  // вправо разгоняет, влево тормозит» читается без объяснений. Цвет при этом
  // красный, как у бомбы, — «не лови»; от бомбы отличает знак, у неё чёрный крест
  brake(g, size) {
    const top = size * 0.3;
    const mid = size * 0.5;
    const bottom = size * 0.7;
    [size * 0.54, size * 0.78].forEach(x => {
      g.beginPath();
      g.moveTo(x, top);
      g.lineTo(x - size * 0.2, mid);
      g.lineTo(x, bottom);
      g.strokePath();
    });
  }
};

// Квадратик для частиц при сдаче груза — той же природы, что и текстуры коробок
export function makeParticleTexture(scene, key, sizePx) {
  const g = scene.make.graphics({ add: false });
  g.fillStyle(0xffffff, 1);
  g.fillRect(0, 0, sizePx, sizePx);
  g.generateTexture(key, sizePx, sizePx);
  g.destroy();
}
