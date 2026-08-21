import Phaser from 'phaser';
import { CONFIG } from '../config.js';
import { SaveManager } from '../save.js';
import { hex, textStyle, makeButton } from '../ui.js';
import { playSfx } from '../audio.js';

/* ============================================================================
   ShopScene — магазин улучшений (GAME_SPEC.md, 5.8)
   ========================================================================= */
export class ShopScene extends Phaser.Scene {
  constructor() { super('ShopScene'); }

  // Магазин открывается и из меню, и с экрана Game Over; НАЗАД возвращает туда же.
  // returnData нужен экрану Game Over: он показывает счёт забега, а тот живёт
  // только в параметрах сцены
  init(data) {
    this.from = (data && data.from) || 'MenuScene';
    this.returnData = (data && data.returnData) || {};
  }

  create() {
    const { width, height } = CONFIG.screen;
    this.cameras.main.setBackgroundColor(CONFIG.colors.bg);

    this.save = SaveManager.load();

    this.add.text(width / 2, 52, 'МАГАЗИН',
      textStyle(44, CONFIG.colors.text, true)).setOrigin(0.5);

    this.add.text(width - 24, 30, `Монет: ${this.save.currency}`,
      textStyle(22, hex(CONFIG.colors.boxYellow), true)).setOrigin(1, 0.5);

    // Три линейки улучшений одной и той же строкой
    CONFIG.shop.order.forEach((key, index) => this.drawRow(key, 140 + index * 112));

    makeButton(this, width / 2, 500, 'НАЗАД', () => this.goBack(),
      { width: 240, height: 54, size: 24 });

    // Сброс прогресса уехал в настройки (этап 8.6): он оказался здесь не по смыслу,
    // а потому что магазин был последней написанной сценой
    this.add.text(width / 2, height - 40, 'сброс прогресса — в настройках',
      textStyle(14, CONFIG.colors.textDim)).setOrigin(0.5);

    this.input.keyboard.on('keydown-ESC', () => this.goBack());
  }

  goBack() {
    this.scene.start(this.from, this.returnData);
  }

  // Строка улучшения: название и эффект слева, уровни и покупка справа
  drawRow(key, y) {
    const spec = CONFIG.shop[key];
    const level = this.save.upgrades[key];
    const maxLevel = spec.prices.length;
    const maxed = level >= maxLevel;
    const price = maxed ? 0 : spec.prices[level];
    const affordable = !maxed && this.save.currency >= price;

    // Подложка строки — иначе три блока сливаются в сплошной текст
    const g = this.add.graphics();
    g.fillStyle(CONFIG.colors.bed, 1);
    g.fillRoundedRect(40, y - 40, CONFIG.screen.width - 80, 88, 8);

    this.add.text(64, y - 22, spec.title, textStyle(22, CONFIG.colors.text, true));
    this.add.text(64, y + 8, spec.effect, textStyle(15, CONFIG.colors.textDim));

    this.drawLevelPips(64, y + 34, level, maxLevel);

    // Цена и кнопка. Не хватает монет — цена краснеет, кнопка гаснет
    const priceColor = affordable ? hex(CONFIG.colors.boxYellow) : hex(CONFIG.colors.danger);
    this.add.text(CONFIG.screen.width - 190, y + 2,
      maxed ? 'куплено полностью' : `${price} монет`,
      textStyle(17, maxed ? CONFIG.colors.textDim : priceColor, !maxed)).setOrigin(1, 0.5);

    makeButton(this, CONFIG.screen.width - 110, y + 2, maxed ? 'МАКС' : 'КУПИТЬ',
      () => this.buy(key), { width: 130, height: 44, size: 18, disabled: !affordable });
  }

  // Уровни кружками: закрашенный — купленный. Числом «2/3» это читается хуже
  drawLevelPips(x, y, level, maxLevel) {
    const g = this.add.graphics();
    for (let i = 0; i < maxLevel; i++) {
      const cx = x + 9 + i * 24;
      if (i < level) {
        g.fillStyle(CONFIG.colors.booster, 1);
        g.fillCircle(cx, y, 7);
      } else {
        g.lineStyle(2, CONFIG.colors.rail, 1);
        g.strokeCircle(cx, y, 7);
      }
    }
  }

  buy(key) {
    const spec = CONFIG.shop[key];
    const level = this.save.upgrades[key];
    if (level >= spec.prices.length) return;

    const price = spec.prices[level];
    if (this.save.currency < price) return;

    this.save.currency -= price;
    this.save.upgrades[key] = level + 1;
    SaveManager.save(this.save);

    playSfx(this, 'deliver');

    // Перерисовываем сцену целиком: это проще и надёжнее, чем точечно обновлять
    // цену, кружки и состояние кнопки в трёх строках
    this.scene.restart({ from: this.from, returnData: this.returnData });
  }

}
