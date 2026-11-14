# Serveur de connexion à la maison

Héberge le serveur de signalisation de Binôme sur une machine de la maison (Proxmox, NAS, Raspberry…) au lieu de Railway.

## Prérequis

- Docker et Docker Compose sur la machine.
- Un nom DNS, par exemple `binome.mondomaine.fr`, avec un enregistrement **A** vers l'adresse IP publique de la box.
- Sur la box : port **443** (TCP) redirigé vers la machine. Le port 80 est facultatif : Caddy sait obtenir le certificat par le 443 seul.

## Installation

```bash
mkdir -p /opt/binome && cd /opt/binome
git clone https://github.com/KobeStars/binome.git src
cp src/deploy/serveur-maison/compose.yaml src/deploy/serveur-maison/Caddyfile .
echo "BINOME_HOST=binome.mondomaine.fr" > .env
docker compose up -d --build
```

Vérification : `https://binome.mondomaine.fr/health` répond `{"ok":true,...}`.

Puis, sur le dépôt GitHub, variable Actions `SIGNALING_URL` = `wss://binome.mondomaine.fr`, et publier une version.

## Mise à jour

```bash
cd /opt/binome && git -C src pull && docker compose up -d --build
```
