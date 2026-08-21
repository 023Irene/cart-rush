import { SaveManager } from './save.js';

/* Переключает звук и возвращает новое состояние. Источник истины — сохранение,
   а НЕ this.sound.mute: у Phaser сеттер пишет в Web Audio через setValueAtTime,
   а геттер читает gain.value, который в том же тике ещё старый — читая обратно,
   мы сохранили бы предыдущее состояние. Общий на забег и на экран паузы:
   с телефона клавишу M нажать негде */
export function toggleMuteSetting(scene) {
  const save = SaveManager.load();
  save.muted = !save.muted;
  SaveManager.save(save);
  scene.sound.mute = save.muted;
  return save.muted;
}

// Единая точка воспроизведения звука. Если сэмпла нет в кэше, Phaser бросает
// исключение прямо из обработчика столкновений — оно рвёт цикл
// requestAnimationFrame, и игра замирает целиком на первой же ловле. Так было
// при запуске по file://, где сэмплы не грузятся вовсе (CORS). Проверка кэша
// делает отсутствие звука безобидным: игра идёт молча
export function playSfx(scene, key, config) {
  if (!scene.cache.audio.exists(key)) return;
  scene.sound.play(key, config);
}
