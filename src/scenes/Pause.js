import Phaser from 'phaser';
import { CONFIG } from '../config.js';
import { textStyle, makeButton, drawKeyHints } from '../ui.js';
import { toggleMuteSetting } from '../audio.js';

/* ============================================================================
   PauseScene — поверх игры, физика при этом стоит
   ========================================================================= */
export class PauseScene extends Phaser.Scene {
  constructor() { super('PauseScene'); }

  create() {
    const { width, height } = CONFIG.screen;

    this.add.rectangle(0, 0, width, height,
      0x000000, 0.65).setOrigin(0).setDepth(0);

    this.add.text(width / 2, 80, 'ПАУЗА', textStyle(54, '#ffffff', true))
      .setOrigin(0.5);

    // Список клавиш таблицей, а не строкой в 16 px: на паузе он читается не мельком,
    // и это единственное место, где управление можно спокойно разобрать
    drawKeyHints(this, width / 2, 165);

    makeButton(this, width / 2, 420, 'ПРОДОЛЖИТЬ', () => this.resumeGame(),
      { width: 260, height: 58, size: 24 });
    makeButton(this, width / 2, 492, 'В МЕНЮ', () => {
      this.scene.stop('GameScene');
      this.scene.stop();
      this.scene.start('MenuScene');
    }, { width: 260, height: 58, size: 24 });

    // Звук раньше выключался прямо отсюда одной кнопкой. Теперь у него свой экран,
    // и пауза ведёт туда: настройка одна, а мест, где её крутят, было два
    makeButton(this, width / 2, 560, 'НАСТРОЙКИ', () => this.openSettings(),
      { width: 200, height: 44, size: 18 });

    this.input.keyboard.on('keydown-ESC', () => this.resumeGame());
    this.input.keyboard.on('keydown-P', () => this.resumeGame());
    // Клавиша M работает и на паузе — она быстрее, чем идти в настройки
    this.input.keyboard.on('keydown-M', () => toggleMuteSetting(this));
  }

  // Настройки открываются НАЛОЖЕНИЕМ поверх остановленной паузы: забег под ней
  // уже стоит, и стартовать сцены заново значило бы потерять его состояние
  openSettings() {
    this.scene.pause();
    this.scene.launch('SettingsScene', { from: 'PauseScene' });
  }

  resumeGame() {
    this.scene.stop();
    this.scene.resume('GameScene');
  }
}
