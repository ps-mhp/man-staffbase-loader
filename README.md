# man-staffbase-loader

Einstieg des MAN-Loaders für Staffbase. Eine feste Datei mit echtem
JavaScript-Typ, die die Staffbase-Datei lädt, deren Adresse nach `?src=`
steht:

```
https://ps-mhp.github.io/man-staffbase-loader/entry.js?src=/api/media/secure/external/v2/raw/upload/<id>.js?accessorId=…&media_token=…
```

Die Adresse der Staffbase-Datei wird unverändert angehängt (sie darf ihr
eigenes `?` und `&` enthalten) oder URL-kodiert. Zugelassen sind nur Dateien
der eigenen Instanz unter `/api/media/`.

Staffbase liefert JavaScript-Dateien als `text/plain` mit `nosniff` aus;
`entry.js` holt die Datei deshalb per `fetch` und führt sie über einen Blob
aus.

**Nicht hier ändern.** Quelle mit Tests ist `src/loader/entry.js` in
`man-staffbase-cms-extensions`; ausgerollt wird mit
`node scripts/deploy-loader.mjs entry --apply`.
