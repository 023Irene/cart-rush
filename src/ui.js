import { CONFIG } from './config.js';

// Цвета в CONFIG хранятся числами для Graphics; тексту Phaser нужна строка '#rrggbb'
export function hex(color) {
  return '#' + color.toString(16).padStart(6, '0');
}

// Общий стиль текста, чтобы не повторять его в каждой сцене
export function textStyle(size, color, bold) {
  return {
    fontFamily: 'Segoe UI, sans-serif',
    fontSize: size + 'px',
    color: color || CONFIG.colors.text,
    fontStyle: bold ? 'bold' : 'normal'
  };
}

/* Список управления. Один источник на меню и паузу: раньше это была строка в 16 px,
   продублированная в трёх местах, и на паузе она не читалась. */
const KEY_HINTS = [
  { keys: ['←', '→'], text: 'ехать вдоль рельсы' },
  { keys: ['↑', '↓'], text: 'сменить рельсу' },
  { keys: ['Пробел'], text: 'сдать груз и получить очки' },
  { keys: ['Esc'], text: 'пауза' },
  { keys: ['M'], text: 'звук вкл / выкл' },
  { keys: ['H'], text: 'показать подсказку в забеге' }
];

/* Кнопка из прямоугольника и текста — отдельных ассетов не нужно.
   Была скопирована в трёх сценах почти дословно; магазин стал бы четвёртой копией.
   opts: { width, height, size, disabled } */
export function makeButton(scene, x, y, label, onClick, opts) {
  const o = opts || {};
  const width = o.width || 240;
  const height = o.height || 60;
  const disabled = !!o.disabled;

  const box = scene.add.rectangle(x, y, width, height,
    disabled ? CONFIG.colors.cartDark : CONFIG.colors.boxBlue);
  const text = scene.add.text(x, y, label,
    textStyle(o.size || 26, disabled ? CONFIG.colors.textDim : '#ffffff', true)).setOrigin(0.5);

  // Выключенная кнопка не реагирует вообще: ни курсором, ни подсветкой, ни нажатием
  if (!disabled) {
    box.setInteractive({ useHandCursor: true });
    box.on('pointerover', () => box.setFillStyle(CONFIG.colors.boxYellow));
    box.on('pointerout', () => box.setFillStyle(CONFIG.colors.boxBlue));
    box.on('pointerdown', onClick);
  }

  return { box, text };
}

// Таблица «клавиша → действие»: слева плашки-кейкапы, справа описание.
// Плашки выкладываются справа налево от общей границы, поэтому колонка
// описаний стоит ровно при любом количестве клавиш в строке
export function drawKeyHints(scene, centerX, topY) {
  const rows = KEY_HINTS;
  const rowHeight = 34;
  const capHeight = 26;
  const gap = 6;
  const capsRight = centerX - 76;
  const textLeft = centerX - 56;
  const g = scene.add.graphics().setDepth(21);

  rows.forEach((row, index) => {
    const y = topY + index * rowHeight;
    let x = capsRight;

    row.keys.slice().reverse().forEach(key => {
      const label = scene.add.text(0, 0, key, textStyle(14, CONFIG.colors.text, true))
        .setOrigin(0.5).setDepth(22);
      const capWidth = Math.max(28, label.width + 16);

      g.fillStyle(CONFIG.colors.cart, 0.22);
      g.fillRoundedRect(x - capWidth, y - capHeight / 2, capWidth, capHeight, 5);
      g.lineStyle(1, CONFIG.colors.rail, 0.9);
      g.strokeRoundedRect(x - capWidth, y - capHeight / 2, capWidth, capHeight, 5);

      label.setPosition(x - capWidth / 2, y);
      x -= capWidth + gap;
    });

    scene.add.text(textLeft, y, row.text, textStyle(16, CONFIG.colors.textDim))
      .setOrigin(0, 0.5).setDepth(22);
  });
}
