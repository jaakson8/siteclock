# SiteClocki kvaliteedivärav

Iga `main` haru muudatus ja pull request peab läbima GitHub Actionsi töövoo `SiteClock CI`.

## Kohustuslikud kontrollid

- API testid ajutise SQLite'i andmebaasiga
- PDF-generaatorite käivitamine testides
- SQLite hot-backup ja taastatavuse kontroll
- veebirakenduse lint ning tootmis-build
- mobiiliäpi TypeScript-kontroll
- Expo avaliku konfiguratsiooni ja EAS JSON-i valideerimine
- Docker Compose'i konfiguratsiooni valideerimine
- API, veebi ja varunduskonteineri ehitamine

## Harukaitse soovitus

GitHubis märgi `main` kaitstud haruks ja nõua enne ühendamist kõigi nelja CI-töö `success` olekut. Keela otse `main` harusse lükkamine ning nõua vähemalt üht ülevaatust.

## Lokaalne kontroll

Enne muudatuse saatmist käivita:

```bash
cd work/api && npm test
cd ../admin-web && npm run lint && npm run build
cd ../mobile-app && npx tsc --noEmit
```

Dockeriga masinas kontrolli lisaks:

```bash
cd work
cp .env.example .env
docker compose config --quiet
docker compose build api web backup
```

Ära lisa `.env` faili, varukoopiaid ega päris isikuandmetega SQLite'i faili GitHubi.
