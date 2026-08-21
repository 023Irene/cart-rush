/* ============================================================================
   SaveManager — работа с localStorage (рекорд, валюта, апгрейды, громкость)
   ========================================================================= */
export const SaveManager = {
  KEY: 'cartRushSave',
  defaults: {
    bestScore: 0,
    currency: 0,
    upgrades: { walls: 0, battery: 0, suspension: 0 },
    volume: 0.6,
    muted: false
  },

  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (!raw) return { ...this.defaults };
      return { ...this.defaults, ...JSON.parse(raw) };
    } catch (e) {
      // Повреждённое сохранение не должно ронять игру
      return { ...this.defaults };
    }
  },

  save(data) {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(data));
    } catch (e) {
      // Приватный режим браузера — просто играем без сохранений
    }
  }
};
