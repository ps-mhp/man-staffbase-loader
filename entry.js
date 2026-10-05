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
 * MAN-Loader — Einstieg.
 *
 * Eine feste Datei auf GitHub Pages (echter JS-Typ, als `<script src>`
 * ladbar), die in Staffbase registriert wird. Was sie lädt, steht allein in
 * ihrer Adresse — alles nach `?src=` ist die Adresse einer Staffbase-Datei:
 *
 *   …/entry.js?src=/api/media/secure/external/v2/raw/upload/<id>.js?accessorId=…&media_token=…
 *
 * Die Medien-URL darf unverändert angehängt werden, mit ihrem eigenen `?` und
 * `&`; URL-kodiert geht es auch. Zugelassen sind nur Dateien der eigenen
 * Instanz unter `/api/media/` — sonst wäre diese Datei ein Lader für
 * beliebigen fremden Code.
 *
 * Staffbase liefert JS-Dateien als `text/plain` mit `nosniff` aus; die Datei
 * wird deshalb per `fetch` geholt und über einen Blob ausgeführt, in einer
 * eigenen Funktion wie früher unter `eval`.
 *
 * `document.currentScript` gibt es nur, solange ein klassisches Skript
 * synchron läuft — deshalb wird es gleich zu Beginn gelesen.
 */

(function (factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    api.run(document.currentScript);
  }
})(function () {
  const MARK = "?src=";
  const ALLOWED_PATH = "/api/media/";

  /** Der Pfad der Staffbase-Datei aus der eigenen Adresse, oder null. */
  function mediaPath(scriptSrc, origin) {
    const at = scriptSrc.indexOf(MARK);
    if (at < 0) return null;
    let value = scriptSrc.slice(at + MARK.length);
    if (/^%2f/i.test(value)) value = decodeURIComponent(value);
    if (!value.startsWith("/") || value.startsWith("//")) return null;
    // Aufgelöst prüfen, damit `/api/media/../…` nicht hinausführt.
    const resolved = new URL(value, origin);
    if (resolved.origin !== origin || !resolved.pathname.startsWith(ALLOWED_PATH)) return null;
    return value;
  }

  async function executeInBrowser(source) {
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = url;
        script.onload = resolve;
        script.onerror = () => reject(new Error("Skript konnte nicht ausgeführt werden"));
        document.head.appendChild(script);
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const browser = {
    get origin() {
      return location.origin;
    },
    fetch: (...args) => window.fetch(...args),
    execute: executeInBrowser,
    log: console,
  };

  async function run(script, deps = browser) {
    if (!script || !script.src) {
      deps.log.error("[man-loader] Einstieg: kein document.currentScript — als klassisches <script src> laden");
      return;
    }
    const path = mediaPath(script.src, deps.origin);
    if (!path) {
      deps.log.error(`[man-loader] Einstieg: ?src= fehlt oder zeigt nicht auf ${ALLOWED_PATH} dieser Instanz: ${script.src}`);
      return;
    }
    try {
      const res = await deps.fetch(path, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      const code = await res.text();
      const name = path.split("?")[0].split("/").pop();
      await deps.execute(`(function () {\n${code}\n}).call(window);\n//# sourceURL=${name}`);
    } catch (error) {
      deps.log.error("[man-loader] Einstieg:", error);
    }
  }

  return { mediaPath, run };
});
