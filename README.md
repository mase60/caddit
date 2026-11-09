# caddit

Kleine Weboberfläche für die Caddyfile (Unraid-tauglich, ~0 Abhängigkeiten).

* jeder Site-Block = eigene Karte (Adressen, Ziel, Direktiven als Chips, Kommentar)
* Anlegen (mit Vorlagen), Bearbeiten, Löschen, Suche, Rohtext-Editor
* vor jedem Speichern: `caddy fmt`, dann lädt dein Caddy die Konfiguration über die Admin-API – lehnt es ab, wird nichts geschrieben
* ist die Admin-API nicht erreichbar oder nicht gesetzt, prüft `caddy validate` im Container (siehe „Grenzen“)
* automatisches Backup (30 Stück) in `/data/backups`, wiederherstellbar über „Backups …“ im Rohtext

## Build & Start

    docker build -t caddit .
    docker run -d --name caddit -p 8080:8080 \
      -v /mnt/user/appdata/caddy/Caddyfile:/config/Caddyfile \
      -v /mnt/user/appdata/caddy-ui:/data \
      -e CADDY_ADMIN=http://192.168.1.10:2019 \
      caddit

Unraid: `caddit.xml` nach `/boot/config/plugins/dockerMan/templates-user/` kopieren, Image-Namen anpassen.

## Auto-Reload

Im globalen Block der Caddyfile die Admin-API für das Netz erreichbar machen:

    {
        admin 0.0.0.0:2019
    }

und Port 2019 beim Caddy-Container veröffentlichen. Falls Caddy mit „host not allowed“ antwortet,
`CADDY_ADMIN_HOST=localhost:2019` setzen oder in der Caddyfile `admin 0.0.0.0:2019 { origins <host:2019> }`.
Port 2019 nie ins Internet freigeben.

## Sicherheit

Die UI kann die Konfiguration deines Reverse Proxys ändern. Nur im LAN betreiben und/oder
`UI_USER`/`UI_PASS` setzen (es braucht beide). Ohne Anmeldung zeigt die Oberfläche den Hinweis „ohne Anmeldung“.

Optional begrenzt `ALLOWED_HOSTS` (z. B. `caddit.lan,192.168.1.10:8080`), unter welchen Hostnamen die UI antwortet.
Das schützt vor DNS-Rebinding: Eine fremde Webseite kommt so nicht über den Browser an die UI im LAN.

## Grenzen

Beim Speichern über die Karten wird die Datei von `caddy fmt` normalisiert (Einrückung, Leerzeilen).
Kommentare direkt über einem Block bleiben erhalten, Kommentare *innerhalb* eines Blocks im Inhaltsfeld ebenfalls.
Kommentare an einer Klammer (`site { # Text`) wandern über den Block. Adressen über mehrere Zeilen werden zu einer Zeile.

Lässt sich eine Datei nicht verlustfrei über Karten schreiben (z. B. fehlende Klammer), sind die Karten nur zum Lesen da;
der Rohtext geht immer.

`caddy validate` im Container kennt nur Standard-Caddy: Plugins, Zertifikate, Umgebungsvariablen und `import`-Dateien deines
Caddy-Containers fehlen dort. Mit `CADDY_ADMIN` prüft dein echtes Caddy, das ist die bessere Wahl. Ist es dann nicht erreichbar,
greift die lokale Prüfung; schlägt sie nur wegen solcher Unterschiede fehl, lässt sich erst wieder speichern, wenn Caddy erreichbar ist.

Relative `import`-Pfade löst Caddy beim Laden über die Admin-API gegen sein Arbeitsverzeichnis auf. Im Zweifel absolute Pfade nutzen.

## Entwickeln

    node --test        # Tests, ohne Abhängigkeiten
    node tools/dev.js  # http://127.0.0.1:3998 mit Schein-Caddy

## Container-Icons (optional)

Mounte `/var/run/docker.sock` (read-only) in den caddit-Container. caddit liest dann Name, IP, Ports und das
Unraid-Icon (`net.unraid.docker.icon`) der laufenden Container und ordnet sie dem `reverse_proxy`-Ziel jedes
Eintrags zu:

* Ziel = Containername (`reverse_proxy immich:2283`, gleiches Docker-Netz)
* Ziel = Container-IP (`172.21.0.10:2283`)
* Ziel = `<Unraid-IP>:<veröffentlichter Port>` – dafür `HOST_IP` setzen (sonst nur, wenn der Port eindeutig ist)

Container im Host-Netzwerk lassen sich nur über ihren Namen zuordnen. Ohne Socket zeigen die Einträge Buchstaben-Icons.
Hinweis: Der Docker-Socket gibt Lesezugriff auf alle Container-Infos (auch `:ro` schützt nicht vor API-Aufrufen) –
nur in vertrauenswürdigen Netzen verwenden.
