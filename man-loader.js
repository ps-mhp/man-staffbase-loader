/*!
 * Copyright 2026, MHP Management und IT-Beratung GmbH and contributors.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * MAN-Loader — Einstieg und Engine.
 *
 * Läuft auf jeder Seite der Instanz und lädt die Skripte, die `loader.js` in
 * der Collection „Custom JS“ des Datei-Managers einträgt — jedes nur, wenn
 * seine Regeln zutreffen. Diese Datei ist die Engine und ändert sich selten;
 * was geladen wird, steht allein in `loader.js` und wird im Studio gepflegt.
 *
 * Kette: Die Branch-Einstellung `customJS` lädt diese Datei als gewöhnliches
 * `<script src>` — heute von jsDelivr als `man-ppt-export-dist/dist/ppt-export.js`,
 * künftig von GitHub Pages als `man-staffbase-loader/man-loader.js` (gleicher
 * Inhalt). Sie lädt `loader.js` und daraus die Skripte.
 *
 * Geladen wird über einen Blob statt per `<script src>`: Staffbase liefert
 * jede JS-Datei als `text/plain` mit `nosniff` aus, und das führt kein Browser
 * als Skript aus. Klassische Skripte laufen in einer eigenen Funktion — wie
 * früher unter `eval`, damit `const`/`let` zweier Skripte nicht im globalen
 * Bereich zusammenstoßen.
 *
 * Quelle mit Tests: man-staffbase-cms-extensions/src/loader/. Hier ändern,
 * testen und mit `node scripts/deploy-loader.mjs` ausrollen — nicht im Studio.
 */

(function (factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    api.start();
  }
})(function () {
  const VERSION = "1.3.0";
  // Die veröffentlichte Adresse (`media_token`): sie gilt auch auf öffentlichen
  // Seiten ohne Sitzung und bleibt beim Ersetzen der Datei dieselbe.
  const REGISTRY_URL =
    "/api/media/secure/external/v2/raw/upload/81fd451d19ca3289dcc4db6a821713b2.js?accessorId=branch_6891d4e0aec53f55e3a819ac&media_token=lisEtCwZcnXmf%2BEEEdAqDpBAnDEeJJqowB7MYNoLOZU%3D";
  const PREFIX = "man-loader";
  const RULE_TIMEOUT_MS = 5000;

  // Ein Schalter aus localStorage: `man-loader:<key>`. Ein gesperrter Speicher
  // (Privatmodus, Richtlinie) darf das Laden nicht verhindern.
  function flag(storage, key) {
    try {
      return storage.getItem(`${PREFIX}:${key}`);
    } catch {
      return null;
    }
  }

  function withTimeout(value, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: keine Antwort nach ${ms} ms`)), ms);
    });
    return Promise.race([Promise.resolve(value), timeout]).finally(() => clearTimeout(timer));
  }

  // Der Kontext, den jede Regel bekommt. `user()` fragt `/api/users/me` erst,
  // wenn eine Regel es braucht, und dann nur einmal je Seitenaufruf.
  function createContext(deps, userCache) {
    const url = new URL(deps.location.href);
    const user = () => {
      if (!userCache.promise) {
        userCache.promise = deps
          .fetch("/api/users/me", { credentials: "same-origin", headers: { Accept: "application/json" } })
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null);
      }
      return userCache.promise;
    };
    return {
      url,
      path: url.pathname,
      query: url.searchParams,
      hash: url.hash,
      host: url.host,
      studio: url.pathname.startsWith("/studio"),
      language: deps.language || "",
      user,
      loggedIn: async () => (await user()) !== null,
    };
  }

  // Prüft die Einträge aus loader.js. Ein fehlerhafter Eintrag fällt heraus,
  // die übrigen laden trotzdem.
  function normalize(registry, log) {
    if (!Array.isArray(registry)) {
      log.error("loader.js muss eine Liste exportieren (export default [ … ])");
      return [];
    }
    const seen = new Set();
    const entries = [];
    registry.forEach((raw, index) => {
      const where = `Eintrag ${index + 1}`;
      if (!raw || typeof raw !== "object") return log.error(`${where}: kein Objekt`);
      const { name, src, when, rule, type = "classic", enabled = true } = raw;
      if (typeof name !== "string" || name.trim() === "") return log.error(`${where}: name fehlt`);
      if (seen.has(name)) return log.error(`${name}: name doppelt — übersprungen`);
      if (typeof src !== "string" && typeof src !== "function") return log.error(`${name}: src fehlt`);
      const shared = when === undefined ? [] : [].concat(when);
      if (shared.some((fn) => typeof fn !== "function")) return log.error(`${name}: when muss eine Funktion oder eine Liste von Funktionen sein`);
      if (rule !== undefined && typeof rule !== "function") return log.error(`${name}: rule muss eine Funktion sein`);
      if (type !== "classic" && type !== "module") return log.error(`${name}: type muss "classic" oder "module" sein`);
      seen.add(name);
      // `when` nimmt die wiederverwendbaren Regeln, `rule` die eigene des
      // Eintrags; geprüft werden beide gleich, unter ihrem Namen im Protokoll.
      const rules = [
        ...shared.map((fn, at) => ({ label: `Regel ${at + 1}`, fn })),
        ...(rule === undefined ? [] : [{ label: "rule", fn: rule }]),
      ];
      entries.push({ name, src, rules, type, enabled: enabled !== false });
    });
    return entries;
  }

  // Alle Regeln eines Eintrags müssen zutreffen — die aus `when` und die
  // eigene aus `rule`. Eine Regel, die wirft oder nicht antwortet, gilt als
  // „nein“.
  async function shouldLoad(entry, ctx, deps, log) {
    if (!entry.enabled) return { load: false, reason: "enabled: false" };
    if (flag(deps.storage, `off:${entry.name}`)) return { load: false, reason: `${PREFIX}:off:${entry.name}` };
    for (const { label, fn } of entry.rules) {
      try {
        const result = await withTimeout(fn(ctx), RULE_TIMEOUT_MS, `${entry.name}, ${label}`);
        if (!result) return { load: false, reason: `${label} trifft nicht zu` };
      } catch (error) {
        log.warn(`${entry.name}: ${label} ist fehlgeschlagen und gilt als „nein“`, error);
        return { load: false, reason: `${label} fehlgeschlagen` };
      }
    }
    return { load: true, reason: "" };
  }

  function resolveSrc(entry, ctx, deps) {
    const override = flag(deps.storage, `src:${entry.name}`);
    if (override) return override;
    return typeof entry.src === "function" ? entry.src(ctx) : entry.src;
  }

  // Klassischer Code bekommt eine eigene Funktion, `this` ist window; der
  // sourceURL-Kommentar gibt ihm in den DevTools seinen Namen.
  function wrapClassic(code, name) {
    return `(function () {\n${code}\n}).call(window);\n//# sourceURL=${name}.js`;
  }

  function createLoader(deps) {
    const log = {
      error: (message, error) => deps.console.error(`[man-loader] ${message}`, ...(error ? [error] : [])),
      warn: (message, error) => deps.console.warn(`[man-loader] ${message}`, ...(error ? [error] : [])),
      debug: (message) => {
        if (flag(deps.storage, "debug")) deps.console.info(`[man-loader] ${message}`);
      },
    };
    const state = new Map();
    const userCache = {};
    let entries = [];
    let pass = Promise.resolve();

    async function loadEntry(entry, ctx) {
      state.set(entry.name, { state: "loading" });
      try {
        const url = await resolveSrc(entry, ctx, deps);
        if (typeof url !== "string" || url === "") throw new Error("src ergab keine URL");
        const res = await deps.fetch(url, { credentials: "same-origin" });
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        const code = await res.text();
        await deps.execute(entry.type === "module" ? `${code}\n//# sourceURL=${entry.name}.js` : wrapClassic(code, entry.name), entry.type);
        state.set(entry.name, { state: "loaded", url });
        log.debug(`${entry.name}: geladen von ${url}`);
      } catch (error) {
        state.set(entry.name, { state: "failed", error: String(error && error.message ? error.message : error) });
        log.error(`${entry.name}: konnte nicht geladen werden`, error);
      }
    }

    // Ein Durchgang: Jeder noch nicht geladene Eintrag wird geprüft; was
    // zutrifft, lädt — parallel, jeder für sich. Geladenes bleibt geladen,
    // Gescheitertes wird nicht wiederholt.
    async function evaluate() {
      const ctx = createContext(deps, userCache);
      const pending = entries.filter((entry) => !state.has(entry.name) || state.get(entry.name).state === "skipped");
      await Promise.all(
        pending.map(async (entry) => {
          const decision = await shouldLoad(entry, ctx, deps, log);
          if (!decision.load) {
            state.set(entry.name, { state: "skipped", reason: decision.reason });
            log.debug(`${entry.name}: übersprungen (${decision.reason})`);
            return;
          }
          await loadEntry(entry, ctx);
        }),
      );
    }

    // Durchgänge laufen nacheinander, nie gleichzeitig — sonst lüde ein
    // schneller Seitenwechsel dasselbe Skript zweimal.
    function schedule() {
      pass = pass.then(evaluate, evaluate);
      return pass;
    }

    async function start() {
      if (flag(deps.storage, "off")) {
        log.warn(`abgeschaltet (${PREFIX}:off)`);
        return;
      }
      let registry;
      try {
        registry = await deps.loadRegistry();
      } catch (error) {
        log.error("loader.js konnte nicht geladen werden", error);
        return;
      }
      entries = normalize(registry, log);
      log.debug(`${entries.length} Einträge in loader.js`);
      await schedule();
      deps.onNavigate(() => schedule());
    }

    function status() {
      return entries.map((entry) => ({ name: entry.name, ...(state.get(entry.name) || { state: "pending" }) }));
    }

    return { start, status, evaluate: schedule };
  }

  // --- Browser -------------------------------------------------------------

  async function executeInBrowser(source, type) {
    const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
      if (type === "module") return await import(/* webpackIgnore: true */ blobUrl);
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = blobUrl;
        script.onload = resolve;
        script.onerror = () => reject(new Error("Skript konnte nicht ausgeführt werden"));
        document.head.appendChild(script);
      });
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  async function loadRegistryInBrowser() {
    const res = await window.fetch(REGISTRY_URL, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`${REGISTRY_URL}: HTTP ${res.status}`);
    const registry = await executeInBrowser(`${await res.text()}\n//# sourceURL=loader.js`, "module");
    return registry.default;
  }

  // Staffbase wechselt Seiten ohne Neuladen (pushState). Verlässlich in jedem
  // Browser ist nur der Blick auf die Adresse; er kostet je Sekunde einen
  // Stringvergleich. `popstate` und die Navigation API machen es nur schneller.
  function onNavigateInBrowser(callback) {
    let last = location.href;
    const check = () => {
      if (location.href === last) return;
      last = location.href;
      callback();
    };
    setInterval(check, 1000);
    window.addEventListener("popstate", check);
    if (window.navigation && typeof window.navigation.addEventListener === "function") {
      window.navigation.addEventListener("currententrychange", check);
    }
  }

  function start() {
    if (window.ManLoader) return;
    const loader = createLoader({
      fetch: (...args) => window.fetch(...args),
      location: window.location,
      storage: window.localStorage,
      console: window.console,
      language: document.documentElement.lang || navigator.language,
      execute: executeInBrowser,
      loadRegistry: loadRegistryInBrowser,
      onNavigate: onNavigateInBrowser,
    });
    window.ManLoader = { version: VERSION, status: loader.status, reevaluate: loader.evaluate };
    loader.start();
  }

  return { VERSION, REGISTRY_URL, createLoader, normalize, wrapClassic, start };
});
