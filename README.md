# Qsys Motion · Sensor app 2

Mobilvänlig webbprototyp för rörelse, transport och relativ positionering. En separat Node-server äger position, sträcka, hastighet, trajectory, sessionshistorik och heatmap. Klienten behandlar IMU lokalt och skickar aggregerade observationer, inte en kontinuerlig råsensorström.

## Starta

Kräver Node.js 22 eller senare och pnpm 11.25.0 (eller npm).

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Öppna http://localhost:3000 och tryck **Prova demo** för en syntetisk promenad, stopp, 180° vändning och retur. Demo skickar samma observationsprotokoll till samma servermotor som live.

Med npm: `npm install`, `npm run build`, `npm start`. pnpm-lock.yaml är det versionslåsta referensbygget.

För en **riktig mobil** krävs HTTPS. Sätt en HTTPS reverse proxy framför port 3000, eller använd betrodda lokala certifikat:

```powershell
$env:TLS_KEY = 'C:\certificates\key.pem'
$env:TLS_CERT = 'C:\certificates\cert.pem'
$env:PORT = '3443'
node server/index.js
```

Servern lyssnar på LAN som standard. Mobilen måste kunna nå servern och lita på certifikatet. HTTP till en LAN-IP ger normalt inte sensoråtkomst. `HOST`, `PORT` och `DATA_DIR` kan sättas i miljön. Inga API-nycklar behövs för lokal karta eller GPS. Google Maps är en separat valfri bakgrund och kräver en egen domänbegränsad JavaScript API-nyckel, angiven i diagnostikpanelen. Nyckeln sparas inte av appen.

## Användning

För extern webbserver finns nu ett automatiskt [serverpaket och publiceringsguide](docs/Deployment.md). Installationen på en specifik server kopplas in när serveradress och driftmiljö har bestämts.

1. Öppna i mobilen, tryck Starta och tillåt rörelsesensorer; GPS är valfritt. Håll telefonen stilla cirka 0,6 sekunder. Starten ansluter till servern parallellt med sensorbehörigheterna och buffrar inkommande sensordata; de första stegen verifieras innan positionen uppdateras.
2. Gå en känd sträcka och kontrollera steg, sträcka, confidence och trajectory. Kartan zoomar automatiskt så hela färdvägen syns. Autozoom är på vid varje ny mätning. Beröring och sidscroll stänger inte av den. Manuell zoom med +/− avmarkerar Autozoom; kryssrutan eller ◎ återaktiverar den. Grön pil och orange telefonsymbol visar telefonens relativa riktning. Färdvägen ritas separat med skattad rörelseriktning. Initial färdriktning är uppåt.
3. För truck/sparkcykel: välj fordonstyp i diagnostik. Detta är en uttrycklig operatörsprior eftersom en generell IMU-regelmodell inte säkert kan identifiera undertypen. Återgå till Automatisk/gång vid avstigning. Bekräfta stillastående fordon endast när det verkligen står stilla.
4. Stoppa efter kalibreringssträckan, ange faktiskt antal meter och välj gång/löpning. Faktor sparas lokalt och appliceras i nästa session. Börja med en ren session och en enda känd sträcka per modell. Kalibrering ändrar inte redan ackumulerad historik.
5. Markera faktisk aktivitet, kända steg, kurs, sträcka och X/Y som ground truth. Markeringarna påverkar inte klassificeraren. Känd kurs anges i lokala grader från +Y, positivt medurs. Känd sträcka och stegantal avser sessionens kumulativa total.
6. Rådata spelas in lokalt om rutan är vald. Exportera innan du lämnar sidan; senast stoppade inspelning återställs i samma webbläsare. Efter oplanerad stängning kan senaste fulla inspelningen gå förlorad, medan den persistenta observationskön återförs automatiskt.
7. Läs inspelningen och tryck Replay. Exportera serverresultat för algoritm A och B och jämför i benchmarkpanelen. Saknad ground truth visas som **ej mätbar**. Falska steg räknas i märkta Standing/TurningInPlace-intervall; stegantalets fel visas separat.

Utan internet fungerar lokal karta och sensorer efter första app-laddningen. Servern kan ligga på lokalt LAN. Vid förlorad serverkontakt är **visad serverposition frusen** medan observationer buffras i IndexedDB och skickas igen med sekvensnummer och idempotens. En helt fristående mobil utan server får ingen ny authoritative position. Google Maps-fel ger automatisk återgång till lokal karta.

## Tester och reproduktion

```sh
pnpm build
pnpm test
dotnet test tests/Qsys.Motion.Tests/Qsys.Motion.Tests.csproj --configuration Release
node tools/replay.mjs --demo demo-result.json
node tools/replay.mjs recording.json result.json
```

MSTest kräver .NET 10 SDK och använder 33 scenarier mot den faktiska JavaScript-implementationen via Node, ingen separat C#-kopia av algoritmen. Alla testnamn börjar med `TestThat_`. Node-sviten omfattar dessutom HTTP, autentisering, atomiska batcher och återställning efter serveromstart. CI kör build och båda sviterna.

CLI-replay går utan webbläsare eller aktiv server och är ett offlineverktyg för algoritmutvärdering. Byt algoritmversion i shared/config.js när algoritmen ändras. Dataset-SHA256 finns i resultatet så att samma inspelning kan verifieras. För rättvis jämförelse måste kalibrering, operatörspriorer och parametrar vara jämförbara.

## Metoder och praktiska gränser

Gång använder filtrerade, temporalt validerade steg och Weinberg-baserad steglängd. Löpning har separat empirisk amplitud/cadence-modell. Telefonens relativa vinkel integreras från gyroskopet, utan kompass-alpha. Vid gång följer färdriktningen normalt den lågpassfiltrerade enhetsriktningen plus en skattad hållvinkel. En tillförlitlig gångaxel i navigationsramen (PCA över senaste 1,2 sekunderna) uppdaterar hållvinkeln så handvridning och pendling inte automatiskt blir en sväng. Utan tillförlitlig gångaxel används enhetsriktningen med lägre confidence; handvridning kan då fortfarande förväxlas med en verklig sväng. Bekräftade steg använder riktningen vid stegets tidpunkt. Gångfönstret ger en viss fördröjning i svängar och en abrupt helomvändning kan inte säkert skiljas från PCA-axelns 180-graders tvetydighet utan extern referens. GPS godkänns först efter kvalitetskontroll och fusioneras med covariance-viktad, begränsad korrektion. Speed använder tidsberoende low-pass. [Forskningsunderlag med källor, parametrar och begränsningar](docs/MotionResearch.md).

Ingen verklig noggrannhet är verifierad. Telefonens rotation kan förväxlas med kroppens rotation; periodisk handskakning kan imitera gång. Fordonskonstantfart kan inte härledas ur acceleration. Utan GPS begränsas fordonsintegration till fem sekunder och kräver en tidigare gångbaserad navigationsriktning; annars fryses förflyttningen och confidence faller. GPS-hastighet och kurs kan stödja fordon när de godkänts. Detta undviker att projicera godtyckliga telefonaxlar som färdriktning. Fordon som startas utan gångreferens eller bra GPS får därför ingen påstått exakt sträcka.

Sensorer: accelerometer, rotationRate/gyro, DeviceOrientation, uppskattad gravity och Geolocation. Magnetometer exponeras inte direkt och visas som begränsad. Saknad gyro/orientering sänker riktningens tillförlitlighet. Faktisk browserfrekvens visas; 50–100 Hz kan inte garanteras. Låg sampling degraderar till Unknown. Sensoravbrott återställer featurefönster. Webbläsaren kan pausa allt vid låst skärm.

Kalibrera gång/löpning separat, gyro-bias, gait-trösklar, cadence, fönsterlängd, PCA-anisotropi, mode-hysteresis, GPS accuracy/innovation, fordonsbias/integrationstid och heatmap-cellstorlek mot riktiga lagerinspelningar. Config finns i `shared/config.js`. Confidence är en kvalitetsindikator, inte en validerad sannolikhet.

## Nätverk och persistens

Mätt på syntetisk 42,64 s replay: 198 observationer, 4,64/s i genomsnitt, cirka **3,26 kB/s observations-JSON** (utan HTTP/TLS och retries). Steg kan trigga extra paket; stillastående skickar normalt heartbeat var 2 s plus GPS. Exakta mätvärden visas i diagnostik och av CLI-replay.

Serversvaret innehåller senaste position, trajectory-fönster och heatmap. Det är större än observationsupplänken och växer med sessionen; gzip används om klienten stöder det. Ett slutstate i syntetisk demo är cirka 15,5 kB okomprimerat. Långvariga lagerpass behöver deltaöverföring och databas innan produktionsdrift. Aktiva svar begränsar trajectory till 5 000 punkter, full historik finns vid GET/export och i JSONL-journalen.

Sessioner och token-hashar ligger under ignorerad `data/`, inga råsensordata skickas automatiskt till servern. Exportfiler kan innehålla exakt GPS-position: hantera dem som interna forskningsdata och lägg dem inte i Git. Prototypen använder per-session bearer-token men saknar företagsinloggning, quotas per användare och automatisk retention. Radera en test-session med knappen i UI. Använd HTTPS och komplettera driftmiljön med företagets åtkomstkontroll.

[Arkitektur](docs/Architecture.md) · [Testresultat](docs/Validation.md) · [Originalspecifikation](docs/Specification.sv.md)
