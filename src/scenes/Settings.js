import Phaser from 'phaser';
import { CONFIG } from '../config.js';
import { SaveManager } from '../save.js';
import { hex, textStyle, makeButton } from '../ui.js';
import { playSfx, toggleMuteSetting } from '../audio.js';

/* ============================================================================
   SettingsScene — громкость, звук, сброс прогресса (этап 8.6, ADR-0009)

   Экран открыт ADR-0009. До него громкость лежала в сохранении с этапа 4 и не
   читалась никем, а сброс прогресса висел в магазине — не по смыслу, а потому
   что магазин был последней написанной сценой.
   ========================================================================= */
export class SettingsScene extends Phaser.Scene {
  constructor() { super('SettingsScene'); }

  init(data) {
    this.from = (data && data.from) || 'MenuScene';
    this.returnData = (data && data.returnData) || {};
    this.confirmReset = false;
  }

  create() {
    const { width, height } = CONFIG.screen;

    // Своя непрозрачная подложка, а не цвет камеры: с паузы экран открывается
    // поверх остановленного забега, и сквозь него не должно просвечивать поле
    this.add.rectangle(0, 0, width, height, CONFIG.colors.bg).setOrigin(0).setDepth(0);

    this.add.text(width / 2, 62, 'НАСТРОЙКИ',
      textStyle(44, CONFIG.colors.text, true)).setOrigin(0.5);

    this.save = SaveManager.load();

    this.add.text(width / 2, 170, 'Громкость', textStyle(24, CONFIG.colors.text))
      .setOrigin(0.5);

    this.volumeText = this.add.text(width / 2, 226, this.volumeLabel(),
      textStyle(30, CONFIG.colors.text, true)).setOrigin(0.5);

    makeButton(this, width / 2 - 130, 226, '−', () => this.changeVolume(-CONFIG.audio.volumeStep),
      { width: 64, height: 52, size: 28 });
    makeButton(this, width / 2 + 130, 226, '+', () => this.changeVolume(CONFIG.audio.volumeStep),
      { width: 64, height: 52, size: 28 });

    this.muteButton = makeButton(this, width / 2, 320, this.muteLabel(),
      () => this.toggleMute(), { width: 260, height: 54, size: 22 });

    makeButton(this, width / 2, 420, 'НАЗАД', () => this.goBack(),
      { width: 240, height: 54, size: 22 });

    this.createResetButton(width / 2, height - 60);

    this.input.keyboard.on('keydown-ESC', () => this.goBack());
    this.input.keyboard.on('keydown-M', () => this.toggleMute());
  }

  volumeLabel() {
    return `${Math.round(this.save.volume * 100)} %`;
  }

  muteLabel() {
    return this.save.muted ? 'ЗВУК ВЫКЛ' : 'ЗВУК ВКЛ';
  }

  // Громкость меняется шагами и сразу слышна: без звука-образца игрок крутит
  // число вслепую. Немой режим при этом снимается — иначе «плюс» ничего не даёт
  changeVolume(delta) {
    this.save.volume = Phaser.Math.Clamp(
      +(this.save.volume + delta).toFixed(2), 0, 1);
    if (this.save.volume > 0 && this.save.muted) {
      this.save.muted = false;
      this.muteButton.text.setText(this.muteLabel());
    }
    SaveManager.save(this.save);

    this.sound.volume = this.save.volume;
    this.sound.mute = this.save.muted;
    this.volumeText.setText(this.volumeLabel());
    playSfx(this, 'catch');
  }

  toggleMute() {
    this.save.muted = toggleMuteSetting(this);
    this.muteButton.text.setText(this.muteLabel());
    if (!this.save.muted) playSfx(this, 'catch');
  }

  /* Возврат туда, откуда пришли. С паузы экран открыт наложением поверх
     остановленной PauseScene, и её надо разбудить, а не стартовать заново:
     scene.start('PauseScene') поднял бы вторую копию поверх забега */
  goBack() {
    if (this.from === 'PauseScene') {
      this.scene.stop();
      this.scene.resume('PauseScene');
      return;
    }
    this.scene.start(this.from, this.returnData);
  }

  // Сброс прогресса. Первое нажатие только переспрашивает, через 3 секунды
  // вопрос снимается сам: случайно снести рекорд и все апгрейды нельзя
  createResetButton(x, y) {
    const label = this.add.text(x, y, 'сбросить прогресс',
      textStyle(14, CONFIG.colors.textDim)).setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    label.on('pointerdown', () => {
      if (!this.confirmReset) {
        this.confirmReset = true;
        label.setText('точно? нажмите ещё раз').setColor(hex(CONFIG.colors.danger));
        this.time.delayedCall(3000, () => {
          if (!this.scene.isActive() || !this.confirmReset) return;
          this.confirmReset = false;
          label.setText('сбросить прогресс').setColor(CONFIG.colors.textDim);
        });
        return;
      }

      // Звук — настройка, а не прогресс: громкость и немой режим сброс переживают
      SaveManager.save({
        ...SaveManager.defaults,
        muted: this.save.muted,
        volume: this.save.volume
      });
      this.scene.restart({ from: this.from, returnData: this.returnData });
    });
  }
}
