# Qsys · Gångkarta

Mobilanpassad rörelsekarta som ritar gång med telefonens accelerometer, gyroskop och orientering. Kartberäkningen sker lokalt i webbläsaren. Appen begär inte GPS och skickar inte mätningen till servern.

## Användning

Öppna appen via HTTPS på telefonen. Loggningen börjar automatiskt. På telefoner som kräver ett tryck för sensorbehörighet visas **Tillåt sensorer**. Gå med telefonen riktad framåt. **Ny karta** rensar mätningen och sätter en ny startpunkt medan sensorerna fortsätter logga.

Steg räknas från tydliga accelerationstoppar med tillräcklig styrka, minst 60 ms uppbyggnad och minst 0,32 sekunder mellan steg. Signalen måste sjunka mellan topparna. Ingen bekräftelse av flera steg i följd krävs. Innan kartan börjar ritas anges en känd sträcka i meter. Tryck Börja kalibrering, gå sträckan och välj Klar – börja rita. Steglängden blir sträckan dividerad med antal registrerade steg. Kalibreringsstegen ritar inget spår; kartan nollställs när kalibreringen avslutas. Ny karta behåller steglängden under samma sidbesök. Telefonens relativa rotation ger spårets riktning. Separata telefonvridningar kan därför tolkas som svängar. Detta är en sensorprototyp, inte uppmätt markposition.

Kartan har fast orientering med startens riktning uppåt. Autozoom visar hela spåret. Under **Felsökning** visas sensorernas status. Kartan ligger i minnet och försvinner vid omladdning.

## Lokal utveckling

Node.js 22 eller senare. Kör `npm install`, `npm run build`, `npm start` och öppna http://localhost:3000. Telefonens sensorer kräver HTTPS (localhost är undantaget). Kör `node --test tests/*.test.js` för verifiering.

`client/walking.js` är den aktiva gångberäkningen. `client/app.js` sköter sensorstart, presentation. `client/maps.js` ritar kartan. Gemensamma IMU-komponenter finns i `client/pipeline.js`.

Äldre servermotor, transportmodeller och tester finns kvar som tidigare implementation och används inte av gångkartans mätflöde. IIS-värden kan fortsätta servera statiska filer utan ändrade bindningar. `tools/publish-client-iis.ps1` publicerar klienten och stämplar senaste commitdatumet.
