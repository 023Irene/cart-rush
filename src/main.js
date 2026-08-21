import Phaser from 'phaser';
import { CONFIG, fitScreenToWindow } from './config.js';
import { BootScene } from './scenes/Boot.js';
import { MenuScene } from './scenes/Menu.js';
import { GameScene } from './scenes/Game.js';
import { PauseScene } from './scenes/Pause.js';
import { GameOverScene } from './scenes/GameOver.js';
import { ShopScene } from './scenes/Shop.js';
import { SettingsScene } from './scenes/Settings.js';

/* ============================================================================
   Запуск
   ========================================================================= */
const gameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  width: CONFIG.screen.width,
  height: CONFIG.screen.height,
  backgroundColor: CONFIG.colors.bg,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  physics: {
    default: 'matter',
    matter: {
      gravity: { x: 0, y: CONFIG.physics.gravityY },
      positionIterations: CONFIG.physics.positionIterations,
      velocityIterations: CONFIG.physics.velocityIterations,
      debug: CONFIG.debug
    }
  },
  scene: [BootScene, MenuScene, GameScene, PauseScene, GameOverScene, ShopScene, SettingsScene]
};

const game = new Phaser.Game(gameConfig);

/* Две ручки наружу: точка входа QA-оснастки и отладка из консоли браузера (ADR-0011).
   До переезда на Vite оснастка доставала экземпляр перехватом window.Phaser, а CONFIG
   был виден сам собой — верхнеуровневый const обычного <script> попадает в глобальную
   лексическую область. У модуля своя область, поэтому обе ручки даём явно */
window.game = game;
window.CONFIG = CONFIG;

/* Изменение размера окна пересчитывает ширину поля под его пропорцию. Сцены при
   этом не перезапускаются: забег не должен теряться из-за того, что окно потянули.
   Сейчас обе границы пропорции стоят на 4:3, так что ширина по факту не меняется */
window.addEventListener('resize', () => {
  fitScreenToWindow();
  game.scale.resize(CONFIG.screen.width, CONFIG.screen.height);
});
