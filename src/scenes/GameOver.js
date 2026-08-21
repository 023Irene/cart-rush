import Phaser from 'phaser';
import { CONFIG } from '../config.js';
import { SaveManager } from '../save.js';
import { hex, textStyle, makeButton } from '../ui.js';

/* ============================================================================
   GameOverScene — каркас, включится на этапе 2 вместе с XP
   ========================================================================= */
export class GameOverScene extends Phaser.Scene {
  constructor() { super('GameOverScene'); }

  // Экран только показывает итог: рекорд и валюта уже записаны в endRun(),
  // потому что сюда можно вернуться из магазина
  init(data) {
    this.finalScore = data.score || 0;
    this.earnedCoins = data.coins || 0;
    this.isRecord = !!data.isRecord;
  }

  create() {
    const { width } = CONFIG.screen;
    this.cameras.main.setBackgroundColor(CONFIG.colors.bg);

    const save = SaveManager.load();
    const isRecord = this.isRecord;

    this.add.text(width / 2, 130, 'ЗАБЕГ ОКОНЧЕН',
      textStyle(52, CONFIG.colors.text, true)).setOrigin(0.5);

    this.add.text(width / 2, 212, `Счёт: ${this.finalScore}`,
      textStyle(32, CONFIG.colors.text)).setOrigin(0.5);

    this.add.text(width / 2, 256, isRecord ? 'Новый рекорд!' : `Рекорд: ${save.bestScore}`,
      textStyle(22, isRecord ? hex(CONFIG.colors.booster) : CONFIG.colors.textDim)).setOrigin(0.5);

    this.add.text(width / 2, 318, `Заработано: +${this.earnedCoins} монет`,
      textStyle(24, hex(CONFIG.colors.boxYellow), true)).setOrigin(0.5);
    this.add.text(width / 2, 350, `Всего монет: ${save.currency}`,
      textStyle(18, CONFIG.colors.textDim)).setOrigin(0.5);

    const opts = { width: 240, height: 58, size: 24 };
    makeButton(this, width / 2 - 140, 424, 'ЕЩЁ РАЗ',
      () => this.scene.start('GameScene'), opts);
    makeButton(this, width / 2 + 140, 424, 'В МЕНЮ',
      () => this.scene.start('MenuScene'), opts);

    // Вход в магазин прямо отсюда: игрок только что получил валюту и готов её тратить
    makeButton(this, width / 2, 496, 'МАГАЗИН', () => this.scene.start('ShopScene', {
      from: 'GameOverScene',
      returnData: { score: this.finalScore, coins: this.earnedCoins, isRecord: this.isRecord }
    }), opts);
  }
}
