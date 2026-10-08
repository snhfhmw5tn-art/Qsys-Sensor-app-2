# Publicering på extern webbserver

## Serverpaket från GitHub

Efter godkänd CI på main bygger workflow **Package web server release** två arkiv: ZIP och tar.gz. De innehåller klient, Node-server, konfiguration, GeographicLib och produktionsberoenden. Paketet kan även byggas manuellt via Actions → Package web server release → Run workflow.

Servern behöver Node.js 22 eller senare. .NET och pnpm behövs inte för att köra det färdiga paketet. Paketets enda runtime-beroende är ren JavaScript, utan plattformsspecifika native-moduler.

Packa upp i en versionsspecifik mapp och starta `node server/index.js`. Sätt `DATA_DIR` till en beständig mapp utanför versionsmappen så att historiken överlever publiceringar. Kör en enda serverinstans: JSONL-lagringen och sessionsstate stöder inte flera samtidiga processer mot samma datamapp.

Miljövariabler:

| Variabel | Användning |
|---|---|
| PORT | Intern port, normalt 3000 |
| HOST | Bind-adress; använd 127.0.0.1 om proxy finns på samma server |
| DATA_DIR | Beständig datamapp med skrivrättighet för tjänstens användare |
| TLS_KEY / TLS_CERT | PEM-filer om Node själv ska terminera HTTPS |

Kontrollera `GET /api/health` efter start. Publicera vid domänens rot eftersom klientens API- och assetadresser börjar med `/`.

## HTTPS och tjänst

Lägg serverprocessen bakom webbserverns HTTPS reverse proxy och kör processen som en tjänst som startar om vid krasch och omstart av servern. Certifikatet måste vara betrott av mobilen. Enbart uppladdning av HTML/CSS till ett statiskt webbhotell räcker inte: även Node-API:t och beständig lagring behövs.

På Windows/IIS används en IIS-webbplats med HTTPS-bindning som vidarebefordrar trafik till Node-processen. På Linux kan exempelvis Caddy eller Nginx stå framför Node eller befintlig Docker-image. Välj den befintliga servermiljön innan proxy, tjänst och automatiskt deploy-steg konfigureras.

## Automatisk överföring till servern

**Paketering är implementerad; automatisk installation på en extern server är ännu inte konfigurerad.** Den kräver servertyp, adress/domän, tjänstens namn, destinationsmapp och en godkänd åtkomstmetod. Lägg inte lösenord eller privata SSH-nycklar i chatten eller i Git. Använd GitHub Environment/Secrets eller en betrodd self-hosted runner på servern.

Vid installation: ta backup av DATA_DIR, överför till ny versionsmapp, stoppa tjänsten kort, växla versionsmapp, starta och kontrollera health över den publika HTTPS-adressen. Behåll föregående versionsmapp för rollback. Radera inte sessionsdata vid deploy.
