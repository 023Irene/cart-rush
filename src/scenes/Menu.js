import Phaser from 'phaser';
import { CONFIG } from '../config.js';
import { SaveManager } from '../save.js';
import { textStyle, makeButton, drawKeyHints } from '../ui.js';

/* ============================================================================
   MenuScene — главное меню
   ========================================================================= */
export class MenuScene extends Phaser.Scene {
  constructor() { super('MenuScene'); }

  create() {
    const { width } = CONFIG.screen;
    this.cameras.main.setBackgroundColor(CONFIG.colors.bg);

    this.add.text(width / 2, 96, 'CART RUSH',
      textStyle(72, CONFIG.colors.text, true)).setOrigin(0.5);

    this.add.text(width / 2, 164,
      'Синие коробки падают на заднюю рельсу, жёлтые — на переднюю',
      textStyle(20, CONFIG.colors.textDim)).setOrigin(0.5);

    const save = SaveManager.load();
    this.add.text(width / 2, 196, `Рекорд: ${save.bestScore}   ·   Монет: ${save.currency}`,
      textStyle(20, CONFIG.colors.textDim)).setOrigin(0.5);

    makeButton(this, width / 2, 248, 'ИГРАТЬ', () => this.scene.start('GameScene'));
    makeButton(this, width / 2, 316, 'МАГАЗИН',
      () => this.scene.start('ShopScene', { from: 'MenuScene' }),
      { width: 240, height: 54, size: 22 });
    makeButton(this, width / 2, 378, 'НАСТРОЙКИ',
      () => this.scene.start('SettingsScene', { from: 'MenuScene' }),
      { width: 240, height: 54, size: 22 });

    drawKeyHints(this, width / 2, 440);

    // Запуск игры с клавиатуры, чтобы не тянуться к мыши
    this.input.keyboard.once('keydown-SPACE', () => this.scene.start('GameScene'));
    this.input.keyboard.once('keydown-ENTER', () => this.scene.start('GameScene'));
  }
}
