# caddit: Hinweise für die Arbeit am Code

Kleine Weboberfläche für die Caddyfile (Unraid, ohne Abhängigkeiten, ohne Build-Schritt). Oberfläche und Meldungen sind auf Deutsch.

## Prüfen

```bash
node --test                 # alle Tests in test/
node tools/dev.js           # http://127.0.0.1:3998, Schein-Caddy, Kopie von test/Caddyfile im Temp-Ordner
```

Das Schein-Caddy nimmt alles an, außer die Konfiguration enthält `KAPUTT`. Echtes Caddy kommt in den Tests nicht vor: Was vom Verhalten des echten Caddy abhängt (`fmt`, `validate`, `/load`, Importe), immer als ungeprüft benennen.

## Aufbau

| Datei | Inhalt |
|---|---|
| `public/logic.js` | Reine Logik ohne DOM und Dateizugriff, läuft in Browser und Node: Lexer, Parser, Serializer, Inhalte auswerten. **Neue zustandsfreie Logik gehört hierher** |
| `public/app.js` | Oberfläche: Zustand, Darstellung, Dialoge |
| `public/index.html` | Markup und Styles, kein Skript (die CSP verbietet Inline-Skripte) |
| `server.js` | Speicherablauf, Caddy, Backups, Docker, HTTP |
| `test/helpers.js` | Startet den echten Server mit Schein-Admin-API. Je Testdatei einmal, weil `server.js` die Umgebung beim Laden liest |

Eine neue statische Datei muss in `STATIC_FILES` in `server.js` stehen.

## Regeln im Code

- Caddyfile-Text nur über `scanLines` lesen. Keine eigene Klammer- oder Kommentarerkennung: Sie kennt keine Heredocs und keine mehrzeiligen Texte.
- Speichern läuft immer über `save()`. Der Ablauf ist: Stand prüfen, formatieren, Backup, Caddy lädt per `/load`, erst dann die Datei schreiben. Lehnt Caddy ab, ändert sich nichts.
- Karten dürfen nur schreiben, wenn `isLossless` für die aktuelle Datei gilt. Sonst sind sie nur zum Lesen da, und der Server antwortet mit 409.
- Nutzerdaten im HTML nur über `esc()`.
- Der Stand des Servers (`S`) ändert sich nur über `setState`.
- Der Eintrags-Dialog bleibt offen, bis das Speichern geklappt hat. Fehler stehen im Dialog (`formError`), weil Toasts hinter einem modalen Dialog liegen.
- Der Rohtext-Entwurf merkt sich seinen Stand in `rawBase` und speichert gegen diesen. Sonst würde ein alter Entwurf neuere Änderungen still überschreiben.

## Git

Commit-Nachrichten auf Englisch, in einer Zeile. Pushes auf `main` bauen das Docker-Image `latest`, nachdem die Tests durchgelaufen sind.
