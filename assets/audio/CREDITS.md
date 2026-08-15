# Звуки — происхождение и лицензия

Все четыре файла взяты из пака **Kenney — Interface Sounds (версия 1.0, 11.02.2020)**.

- Источник: https://kenney.nl/assets/interface-sounds
- Архив: `kenney_interface-sounds.zip`
- Лицензия: **Creative Commons Zero (CC0)** —
  https://creativecommons.org/publicdomain/zero/1.0/
- Из лицензии пака: «This content is free to use in personal, educational and commercial
  projects. Support us by crediting Kenney or www.kenney.nl (this is not mandatory)».

Атрибуция по CC0 не обязательна, но указана намеренно: через год должно быть понятно, откуда
в репозитории бинарные файлы и можно ли их публиковать.

## Что во что переименовано

| Файл в проекте | Исходный файл | Длительность | Роль в игре |
|---|---|---|---|
| `catch.ogg` | `drop_001.ogg` | 0.11 с | коробка легла в кузов |
| `deliver.ogg` | `confirmation_002.ogg` | 0.54 с | сдача груза по пробелу |
| `error.ogg` | `error_006.ogg` | 0.50 с | груз вывалился за борт |
| `gameover.ogg` | `error_003.ogg` | 0.53 с | забег окончен |

Формат везде Ogg Vorbis, 44100 Гц. `catch.ogg` выбран самым коротким намеренно: он играет
чаще всех, и хвост превратил бы частые ловли в кашу. Дополнительно ограничен по частоте
в коде — не чаще раза в `CONFIG.audio.catchCooldown`.

Пак Impact Sounds не понадобился: `drop_001` дал нужный глухой тук.
