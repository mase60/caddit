# Caddy UI

Kleine Weboberfläche für die Caddyfile (Unraid-tauglich, ~0 Abhängigkeiten).

* jeder Site-Block = eigene Karte (Adressen, Ziel, Direktiven als Chips, Kommentar)
* Anlegen (mit Vorlagen), Bearbeiten, Löschen, Suche, Rohtext-Editor
* vor jedem Speichern: `caddy fmt` + `caddy validate` – bei Fehlern wird nichts geschrieben
* automatisches Backup (30 Stück) in `/data/backups`, danach Reload über die Caddy-Admin-API

## Build & Start

    docker build -t caddy-ui .
    docker run -d --name caddy-ui -p 8080:8080 \
      -v /mnt/user/appdata/caddy/Caddyfile:/config/Caddyfile \
      -v /mnt/user/appdata/caddy-ui:/data \
      -e CADDY_ADMIN=http://192.168.1.10:2019 \
      caddy-ui

Unraid: `caddy-ui.xml` nach `/boot/config/plugins/dockerMan/templates-user/` kopieren, Image-Namen anpassen.

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
`UI_USER`/`UI_PASS` setzen.

## Grenzen

Beim Speichern über die Karten wird die Datei von `caddy fmt` normalisiert (Einrückung, Leerzeilen);
Kommentare direkt über einem Block bleiben erhalten, Kommentare *innerhalb* eines Blocks im Inhaltsfeld ebenfalls.
