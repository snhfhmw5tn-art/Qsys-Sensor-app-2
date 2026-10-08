# Qsys · Gångkarta

Mobilanpassad rörelsekarta som ritar gång med telefonens accelerometer, gyroskop och orientering. Kartberäkningen sker lokalt i webbläsaren. Appen begär inte GPS och skickar inte mätningen till servern.

## Användning

Öppna appen via HTTPS på telefonen. Loggningen börjar automatiskt. På telefoner som kräver ett tryck för sensorbehörighet visas **Tillåt sensorer**. Gå med telefonen riktad framåt. **Ny karta** rensar mätningen och sätter en ny startpunkt medan sensorerna fortsätter logga.

Steg räknas från tydliga accelerationstoppar med tillräcklig styrka, minst 60 ms uppbyggnad och minst 0,32 sekunder mellan steg. Signalen måste sjunka mellan topparna. Dessutom krävs tre regelbundna steg, återkommande gångmönster och horisontell acceleration med tillgänglig orientering. De första stegen ritas i efterhand med sina ursprungliga riktningar. Enbart vertikal telefonrörelse räknas inte. Detta är en heuristik, inte ett bevis på faktisk förflyttning. Innan kartan börjar ritas anges en känd sträcka i meter. Tryck Börja kalibrering, gå sträckan och välj Klar – börja rita. Steglängden blir sträckan dividerad med antal registrerade steg. Kalibreringsstegen ritar inget spår; kartan nollställs när kalibreringen avslutas. Ny karta behåller steglängden under samma sidbesök. Orange spår och rektangel visar referensen baserad på telefonens rotation. Grönt spår och pil använder gångmönstrets horisontella huvudaxel i navigationsramen för att uppskatta färdriktningen. Vid svagt gångmönster behålls senast uppskattade färdriktning. Riktningen har en 180-graders tvetydighet och är inte en verifierad markriktning. Detta är en sensorprototyp, inte uppmätt markposition.

Kartan har fast orientering med startens riktning uppåt. Autozoom visar hela spåret. Under **Felsökning** visas sensorernas status. Kartan ligger i minnet och försvinner vid omladdning.

## Lokal utveckling

Node.js 22 eller senare. Kör `npm install`, `npm run build`, `npm start` och öppna http://localhost:3000. Telefonens sensorer kräver HTTPS (localhost är undantaget). Kör `node --test tests/*.test.js` för verifiering.

`client/walking.js` är den aktiva gångberäkningen. `client/app.js` sköter sensorstart, presentation. `client/maps.js` ritar kartan. Gemensamma IMU-komponenter finns i `client/pipeline.js`.

Äldre servermotor, transportmodeller och tester finns kvar som tidigare implementation och används inte av gångkartans mätflöde. IIS-värden kan fortsätta servera statiska filer utan ändrade bindningar. `tools/publish-client-iis.ps1` publicerar klienten och stämplar senaste commitdatumet.

## Sensorhistorik

Under Felsökning finns Exportera all sensorhistorik och Markera avvikelse. JSON-filen innehåller rådata, separata orienteringshändelser, beräknade riktningar och gångfunktioner, steg, kalibrering, båda spåren, sensorstatus, commitversion och aktuell kartbild. Ny karta tömmer sensorhistorik, tidigare segment och avvikelsemarkeringar. Därefter omfattar både lokal export och serversparande endast data från senaste Ny karta. Kalibrerad steglängd behålls. Exportera innan omladdning; historiken ligger i minnet. Ingen automatisk uppladdning sker.

Knappen Spara till fil på servern vid kartan sparar sensorhistoriken sedan senaste Ny karta och aktuell kartbild i DATA_DIR/sensor-history. Ange ett testnamn, t.ex. gangkarta-uppratt-telefon. Filens nedladdningsnamn får Stockholm-datum, klockslag och ett unikt suffix. En svårgissad nedladdningslänk returneras; ingen offentlig fillista finns. Max 25 MB per uppladdning. Vid större filer finns lokal export. Backendändringar publiceras med publish-client-iis.ps1 -IncludeServer, vilket återstartar app-poolen och bevarar IIS-bindningar.

## Active map

Only the orange phone-direction reference is calculated and displayed. The calculated green route, arrow, status and exported estimates have been removed from the active flow. The experimental estimator source and its tests remain available for reference but are not imported by the app. Orange animation, calibration, markers and raw sensor history remain available.

## Activity and experimental vehicle distance

A fourth measurement card shows standing, walking, running, cart/forklift or uncertainty and a heuristic percentage. Scores are normalized experimental rules, not calibrated probabilities or a trained activity model. Generic IMU data cannot reliably distinguish cart from forklift; Auto reports their combined category and separate scores are exported. An optional known transport selector supplies an explicit operator prior. A cart means the handset is on a cart pushed by a walking person.

Cart and forklift distance never uses step length. It integrates gravity-free navigation-frame acceleration to velocity and then integrates speed over time, drawing along the existing orange phone heading. Initial velocity is assumed zero when entering vehicle mode. Low-pass filtering, an acceleration deadband and explicit cart/truck speed caps reduce runaway spikes but cannot eliminate inertial drift. Quiet readings do not reset velocity: constant-speed travel can be quiet. Missing attitude or sensor gaps reset integration without inventing distance. Speed, quality flags, selected activity and heuristic scores are included in sensor history. Changing stride does not change vehicle distance. No GPS is requested.

For useful tests, start the vehicle stationary and keep the handset fixed on it. Sensor bias, bumps and unknown initial speed can cause substantial errors; vehicle distance is experimental. See Android's [motion sensor documentation](https://developer.android.com/develop/sensors-and-location/sensors/sensors_motion) for acceleration offset and calibration requirements.
