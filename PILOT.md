# SiteClock - pilootkeskkonna käivitus

## Eeldused

- Linuxi testserver Docker Compose'iga
- HTTPS-i lõpetav pöördproksi (näiteks Caddy, Traefik või pilvepakkuja koormusjaotur)
- DNS-kirje testdomeenile

## Esmakäivitus

1. Kopeeri `.env.example` failiks `.env`.
2. Asenda kõik `MUUDA-...` väärtused. Peakasutaja ja meistri paroolid peavad olema vähemalt 12 märki, unikaalsed ning omavahel erinevad; `ADMIN_EMAIL` peab olema peakasutaja päris aadress.
3. Täida müüja, SMTP ja SMS-webhooki andmed. SMTP saadab personali kaheastmelise sisselogimise koodid; SMS-webhook saadab töötaja PIN-i taastamiskoodid. Tühja seadistusega töötab saatmine ainult arenduskeskkonna testjärjekorras ja tootmisserver ei käivitu.
4. Määra `CORS_ORIGIN` täpselt piloodi avalikuks HTTPS-aadressiks, näiteks `https://pilot.objektiaeg.ee`.
5. Käivita `docker compose up -d --build`.
6. Kontrolli `docker compose ps` ning ava `http://server:8080/health`.
7. API valmiduse kontroll: `http://server:8080/api/ready`.

API kirjutab stdout'i ühe JSON-logirea iga päringu kohta. Veateate `viide` vastab logi `requestId` väljale. Logi ei sisalda päringu keha, autoriseerimispäist ega URL-i päringuparameetreid. Piloodis säilita konteinerilogisid piiratud ligipääsuga vähemalt kogu testperioodi jooksul.

SQLite andmed asuvad Dockeri püsivas köites `objektiaeg_data` ja säilivad konteineri uuendamisel.

## Uuendamine

1. Tee andmeköitest varukoopia.
2. Laadi uus lähtekood serverisse.
3. Käivita `docker compose up -d --build`.
4. Kontrolli tervisekontrolle ja logisid: `docker compose logs --tail=100 api web`.

## Varundamine

Piloodi ajal tee vähemalt kord päevas kontrollitud SQLite'i hot-backup:

`docker compose --profile tools run --rm backup`

Käsk kirjutab ajatempliga faili serveri `work/backups/` kausta ja käivitab sellel kohe SQLite'i `integrity_check` kontrolli. Varundus ei nõua API peatamist. Kopeeri varukoopiad regulaarselt ka teise serverisse või objektisalvestusse ning krüpteeri need, sest fail sisaldab isikuandmeid ja parooliräsisid.

Enne piloodi algust testi taastamist eraldi keskkonnas. Ära kirjuta varukoopiat töötava andmebaasi peale: peata test-API, nimeta olemasolev fail kõrvale, kopeeri valitud varukoopia andmemahule ja käivita esmalt `/ready` ning sisselogimise kontrollid.

## Piloodi kontrollnimekiri

- 1 ettevõte, 1-2 töömaad ja 5-10 töötajat
- päris telefonidega IN/OUT ning GPS-test töömaa piiril
- katkestatud interneti ja hilisema sünkroonimise test
- üle 24 tunni vana offline-kande tagasilükkamise ja parandustaotluse test
- QR-lehtede print ning skaneerimine kõigi kasutatavate telefonidega
- parandustaotluse täielik töötaja-meister-töötaja ring
- CSV aruande võrdlus käsitsi peetud tunnilehega
- evakuatsiooni PDF-i prooviprint
- arve testkiri eraldi testsaajale
- andmebaasi varukoopia ja taastamise proov

## Enne avalikku tootmist

Piloodi Compose-seadistus ei asenda hallatud tootmisplatvormi. Avaliku teenuse jaoks tuleb lisada automaatsed krüpteeritud varukoopiad, keskne logihaldus, seire ja alarmid, saladuste haldus, turvatest, privaatsusdokumendid ning mobiilirakenduse allkirjastatud poepaketid.
