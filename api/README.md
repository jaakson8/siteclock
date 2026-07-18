# SiteClocki kohalik testserver

Käivita:

```bash
PYTHON_BIN=/Users/jaakviik/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 npm start
```

`PYTHON_BIN` määrab ReportLabi sisaldava Pythoni, millega luuakse arve PDF.

Päris e-kirjade saatmiseks seadista `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASS`, `MAIL_FROM` ja vajadusel `SMTP_SECURE=true`. Ilma nendeta töötab
saatmisjärjekord testrežiimis. Igapäevane arveldus- ja piirangukontroll käivitub
kell 02:00 ning e-posti järjekorda töödeldakse kord minutis.

Server kuulab pordil `3000`. Testimiseks on eelsisestatud töötaja telefoniga
`+372 5555 1234` ja töömaa koordinaatidega `59.437, 24.7536`.

Püsivad andmed salvestatakse SQLite-faili `data/objektiaeg.sqlite`. Asukohta saab
muuta keskkonnamuutujaga `DATABASE_PATH`. Automaattestid kasutavad mälus olevat
eraldi andmebaasi.

Testkoodid:

- `demo-in`
- `demo-out`

Peakasutaja testkonto:

- e-post: `owner@example.com`
- parool: `demo1234`

Arveldustesti otspunktid:

- `POST /v1/admin/billing/generate`
- `POST /v1/admin/billing/reminders/run`
- `GET /v1/admin/invoices`
- `GET /v1/admin/email-outbox`

Mobiiliäpi `.env` failis peab füüsilise telefoni kasutamisel olema arvuti
kohaliku võrgu IP, näiteks:

```env
EXPO_PUBLIC_API_URL=http://192.168.1.20:3000
```
