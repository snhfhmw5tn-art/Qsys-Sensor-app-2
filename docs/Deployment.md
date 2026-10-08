# Publicering på extern webbserver

## Lokal IIS: sensor 2

Installerad adress: `https://prototyp.qsys.se`, IIS-namn `sensor 2`, pool `Sensor2AppPool`, filer `C:\inetpub\wwwroot\Sensor2`. HTTPS använder SNI på port 443 och samma certifikat som siten `Sensor`. Lokal hosts-post pekar namnet till 127.0.0.1. För mobilåtkomst måste nätverkets DNS peka namnet till datorns LAN-adress (vid installation 10.0.23.80), och nätverket måste tillåta HTTPS till datorn.

IIS kör .NET 10-värden under `hosting/Qsys.Motion.IisHost`. Den startar en medföljande Node-process på en dynamisk loopback-port, vidarebefordrar HTTP via YARP och startar om Node vid krasch. Windows Job Object avslutar Node när IIS-arbetaren avslutas. En enda poolprocess och avstängd överlappande återvinning skyddar JSONL-lagringen. Mätningar lagras separat i `C:\ProgramData\Qsys\Sensor2\data`.

För ny installation/publicering: installera .NET 10 Hosting Bundle och IIS, kör `pnpm install --frozen-lockfile`, sedan från PowerShell `./tools/deploy-local-iis.ps1 -NodePath 'C:\sökväg\node.exe'` med Node 22 eller senare. Skriptet bygger värden, paketerar appen och ber Windows om administratörsåtkomst för IIS-installationen. Det säkerhetskopierar IIS-konfigurationen, återanvänder Sensor-certifikatet och bevarar datamappen. Certifikatet måste täcka `prototyp.qsys.se`. Kontrollera `/api/health` och testa en mätning efter publicering. Skripten installerar på denna dator; GitHub push utlöser fortfarande enbart CI och paketering.

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
