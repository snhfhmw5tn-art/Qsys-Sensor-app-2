# Qsys · Gångkarta

Mobilanpassad rörelsekarta som ritar gång med telefonens accelerometer, gyroskop och orientering. Kartberäkningen sker lokalt i webbläsaren. Appen begär inte GPS och skickar inte mätningen till servern.

## Användning

Öppna appen via HTTPS på telefonen. Loggningen börjar automatiskt. På telefoner som kräver ett tryck för sensorbehörighet visas **Tillåt sensorer**. Gå med telefonen riktad framåt. **Ny karta** rensar mätningen och sätter en ny startpunkt medan sensorerna fortsätter logga. Sensorhistorik och kartbild kan exporteras under pågående mätning.

Steg bekräftas med återkommande accelerationsmönster; de första stegen ritas när gångmönstret är bekräftat. Sträckan uppskattas med 0,70 meter per steg. Telefonens relativa rotation ger spårets riktning. Separata telefonvridningar kan därför tolkas som svängar. Detta är en sensorprototyp, inte uppmätt markposition.

Autozoom visar hela spåret. Under **Felsökning** finns tidsmarkering av avvikelser, JSON-export med rå sensordata, beräknad historik och inbäddad kartbild, samt separat PNG-export. Mätningen ligger i minnet och försvinner vid omladdning; exportera innan sidan lämnas.

## Lokal utveckling

Node.js 22 eller senare. Kör `npm install`, `npm run build`, `npm start` och öppna http://localhost:3000. Telefonens sensorer kräver HTTPS (localhost är undantaget). Kör `node --test tests/*.test.js` för verifiering.

`client/walking.js` är den aktiva gångberäkningen. `client/app.js` sköter sensorstart, presentation och lokala exporter. `client/maps.js` ritar kartan. Gemensamma IMU-komponenter finns i `client/pipeline.js`.

Äldre servermotor, transportmodeller och tester finns kvar som tidigare implementation och används inte av gångkartans mätflöde. IIS-värden kan fortsätta servera statiska filer utan ändrade bindningar. `tools/publish-client-iis.ps1` publicerar klienten och stämplar senaste commitdatumet.
