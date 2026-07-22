# SiteClock mobiiliäpp — uus versioon

See on täielikult uuesti kirjutatud mobiiliäpp, mis on otse ühendatud
päris SiteClocki API-ga (`https://siteclock-api.onrender.com`).

## Mis on parandatud

Eelmine mobiiliäpi lähtekood läks kaduma (ei jõudnud kunagi GitHubi).
See versioon on kirjutatud nullist ja:

- **ei sisalda ühtegi kõvakodeeritud "demo" QR-vastust** — iga skannitud
  QR-koodi tegelik sisu (`event.data` kaamerast) saadetakse otse
  serverisse muutmata kujul (`src/api.ts` → `submitScan`);
- kasutab `expo-camera` uut `CameraView` API-t QR-koodi lugemiseks;
- küsib asukoha alles skaneerimise hetkel (`expo-location`), mitte
  taustal pidevalt;
- salvestab sessiooni turvaliselt seadme `expo-secure-store` abil, nii
  et kasutaja ei pea iga kord uuesti sisse logima;
- näitab serveri tagastatud tegelikku töömaa nime, sissepääsu nime ja
  IN/OUT olekut — mitte kunagi kõvakodeeritud teksti.

## Kuidas lisada see GitHubi hoidlasse

1. Loo repositooriumis (`jaakson8/siteclock`) uus kaust `mobile-app`.
2. Lisa sinna kõik selle paketi failid, säilitades struktuuri:

```
mobile-app/
  App.tsx
  app.json
  babel.config.js
  package.json
  src/
    api.ts
```

3. Commiti ja pushi muudatused `main` harusse.

## Kuidas kohapeal käivitada (testimiseks arvutis)

```bash
cd mobile-app
npm install
npx expo start
```

## Kuidas teha uus Androidi test-APK (EAS)

Kui sul on Expo konto (`jaakson8`) juba varasemast olemas:

```bash
cd mobile-app
npx eas-cli@latest login
npx eas-cli@latest init
npx eas-cli@latest build --platform android --profile preview
```

Kui `eas.json` faili veel pole, loo see samasse kausta:

```json
{
  "cli": { "version": ">= 5.0.0" },
  "build": {
    "preview": {
      "distribution": "internal",
      "android": { "buildType": "apk" }
    }
  }
}
```

Ehitamise lõppedes annab Expo lingi, kust saad APK-faili Android-telefoni
alla laadida ja paigaldada.

## API aadressi muutmine

Serveri aadress on määratud failis `app.json`, väljal
`expo.extra.apiUrl`. Kui pilootserver muutub, muuda seda väärtust ja
tee uus build.

## Testimine

1. Ava äpp, sisesta telefoninumber ja vali PIN (esmakordsel kasutamisel
   luuakse see automaatselt, kui number on veebirakenduses juba
   töötajana registreeritud).
2. Vajuta **"Skaneeri QR-kood"**.
3. Skanni **äsja veebirakendusest avatud/prinditud** IN- või OUT-koodi
   — mitte varasemat ekraanipilti ega vana salvestatud faili.
4. Kinnita, et ekraanile ilmuv töömaa ja sissepääsu nimi vastavad
   täpselt sellele, mida veebirakenduses valisid.
