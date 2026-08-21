import Phaser from 'phaser';
import { CONFIG } from '../config.js';
import { SaveManager } from '../save.js';
import { makeBoxTexture, makeBombTexture, makePickupTexture, makeParticleTexture } from '../textures.js';

/* ============================================================================
   BootScene — генерирует текстуры и уходит в меню
   ========================================================================= */
export class BootScene extends Phaser.Scene {
  constructor() { super('BootScene'); }

  // Звуки грузятся через fetch, поэтому игра работает только по http://
  // (Live Server), а не двойным кликом по файлу — CORS, см. ADR-0001.
  // По file:// игра теперь не падает, а идёт молча, но об этом надо сказать вслух:
  // молчащая игра без объяснения выглядит как поломка звука
  preload() {
    this.load.on('loaderror', file => console.warn(
      `[Cart Rush] Не загрузился ресурс «${file.key}». Если адрес начинается с file:// — ` +
      'открой index.html через Live Server: по file:// браузер блокирует загрузку звука ' +
      '(CORS). Игра пойдёт без звука.'));

    this.load.audio('catch', 'assets/audio/catch.ogg');
    this.load.audio('deliver', 'assets/audio/deliver.ogg');
    this.load.audio('error', 'assets/audio/error.ogg');
    this.load.audio('gameover', 'assets/audio/gameover.ogg');
  }

  create() {
    // Текстуры коробок: 3 размера × 2 цвета
    for (const [sizeName, spec] of Object.entries(CONFIG.boxes)) {
      makeBoxTexture(this, `box-${sizeName}-yellow`, spec.size, CONFIG.colors.boxYellow);
      makeBoxTexture(this, `box-${sizeName}-blue`, spec.size, CONFIG.colors.boxBlue);
    }
    makeBombTexture(this, 'bomb', CONFIG.bombs.size);
    for (const [key, spec] of Object.entries(CONFIG.pickups.types)) {
      makePickupTexture(this, key, CONFIG.pickups.size, spec);
    }
    makeParticleTexture(this, 'particle', 6);

    // Громкость и немой режим переживают перезагрузку. Громкость берётся из
    // сохранения, а не из CONFIG: с этапа 4 поле лежало в SaveManager и не читалось
    // никем — выбор был, а ручки к нему не было (ADR-0009)
    const save = SaveManager.load();
    this.sound.volume = save.volume;
    this.sound.mute = save.muted;

    this.scene.start('MenuScene');
  }
}
